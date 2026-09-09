package com.wxmyyds.splayer.next;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.EventListener;
import okhttp3.Handshake;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * 原生 HTTP 插件：WebView 内的音源 API 经 OkHttp 发出。
 *
 * - 15s 连接超时 / 30s 读取超时；响应体上限 8MB（二维码图片/歌词足够，音频流不走这里）。
 * - redirect=manual 时返回跳转响应本身（QQ 登录读 Location/p_skey 用），默认自动跟随。
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private static final long MAX_BODY = 8L * 1024 * 1024;

    private OkHttpClient client;
    private OkHttpClient noRedirectClient;
    /** 慢阶段阈值：超过该阈值的 DNS/连接/TLS 阶段记日志定位网络侧 stall */
    private static final long SLOW_PHASE_MS = 3000;

    /** 记录 DNS/连接/TLS 各阶段耗时，慢阶段 warn 日志 */
    private static class PhaseLogger extends EventListener {
        long dnsStart, connectStart, secureStart;
        String url;
        PhaseLogger(String url) { this.url = url; }
        @Override public void dnsStart(Call call, String domainName) { dnsStart = now(); }
        @Override public void dnsEnd(Call call, String domainName, java.util.List<java.net.InetAddress> inetAddressList) {
            slow("dns", now() - dnsStart);
        }
        @Override public void connectStart(Call call, java.net.InetSocketAddress inetSocketAddress, java.net.Proxy proxy) {
            connectStart = now();
        }
        @Override public void secureConnectStart(Call call) { secureStart = now(); }
        @Override public void secureConnectEnd(Call call, Handshake handshake) {
            slow("tls", now() - secureStart);
        }
        @Override public void connectEnd(Call call, java.net.InetSocketAddress inetSocketAddress, java.net.Proxy proxy, okhttp3.Protocol protocol) {
            slow("connect", now() - connectStart);
        }
        private void slow(String phase, long ms) {
            if (ms > SLOW_PHASE_MS) {
                try {
                    android.util.Log.w("NativeHttp", phase + " stall " + ms + "ms " + new java.net.URL(url).getHost());
                } catch (Exception ignored) {}
            }
        }
        private static long now() { return android.os.SystemClock.elapsedRealtime(); }
    }

    @Override
    public void load() {
        // 首连 stall 环境（透明代理/劫持 DNS）下 15s 超时意味着每次冷启动白等；
        // 8s 足够正常网络建连，超时后 OkHttp 自动重试走已预热路径
        client = new OkHttpClient.Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();
        // 登录流程需要读取 302 的 Location/Set-Cookie，不能自动跟随
        noRedirectClient = client.newBuilder()
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
    }

    /** 调用方 headers 是否已声明某请求头 */
    private static boolean hasHeader(JSObject headersObj, String name) {
        java.util.Iterator<String> names = headersObj.keys();
        while (names.hasNext()) {
            if (name.equalsIgnoreCase(names.next())) return true;
        }
        return false;
    }

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url", "");
        if (url.isEmpty()) {
            call.reject("missing url");
            return;
        }
        String method = call.getString("method", "GET").toUpperCase();
        JSObject headersObj = call.getObject("headers", new JSObject());
        String bodyStr = call.getString("body", null);

        Request.Builder builder = new Request.Builder().url(url);
        java.util.Iterator<String> headerNames = headersObj.keys();
        String contentType = null;
        while (headerNames.hasNext()) {
            String name = headerNames.next();
            String value = headersObj.getString(name, "");
            if ("Content-Type".equalsIgnoreCase(name)) contentType = value;
            builder.header(name, value);
        }
        // 网易/QQ 等服务器会返回 Content-Encoding: gzip 但 body 并非真 gzip；
        // OkHttp 透明解压遇到假 gzip 会抛异常。强制 identity 关闭透明解压，原始字节交 JS 处理。
        builder.header("Accept-Encoding", "identity");
        if ("GET".equals(method) || "HEAD".equals(method)) {
            builder.method(method, null);
        } else {
            // 请求体 MediaType 必须与调用方声明的 Content-Type 一致（网易 form、QQ json），
            // 否则服务端无法解析 body。未声明时才回落 octet-stream。
            MediaType mediaType = contentType != null ? MediaType.parse(contentType) : null;
            if (mediaType == null) mediaType = MediaType.parse("application/octet-stream");
            RequestBody body = bodyStr != null
                    ? RequestBody.create(bodyStr, mediaType)
                    : RequestBody.create(new byte[0], null);
            builder.method(method, body);
        }

        // 调用方未声明 UA 时给浏览器 UA：部分透明代理/网关对默认 okhttp UA 首连限速
        if (!hasHeader(headersObj, "User-Agent")) {
            builder.header("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36");
        }
        // redirect=manual 时返回跳转响应本身（QQ 登录取 Location/p_skey 用）
        boolean manual = "manual".equalsIgnoreCase(call.getString("redirect", "follow"));
        OkHttpClient base = manual ? noRedirectClient : client;
        // 慢阶段监控：按调用挂 EventListener，连接池共享不受影响
        OkHttpClient scoped = base.newBuilder()
                .eventListener(new PhaseLogger(url))
                .build();
        scoped.newCall(builder.build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                call.reject(e.getMessage(), e);
            }

            @Override
            public void onResponse(Call c, Response response) {
                try (Response r = response) {
                    JSObject ret = new JSObject();
                    ret.put("status", r.code());
                    ret.put("url", r.request().url().toString());
                    JSObject headers = new JSObject();
                    JSArray setCookies = new JSArray();
                    for (Map.Entry<String, List<String>> e : r.headers().toMultimap().entrySet()) {
                        String name = e.getKey();
                        List<String> values = e.getValue();
                        if (name == null || values == null) continue;
                        if ("Set-Cookie".equalsIgnoreCase(name) || "Set-Cookie2".equalsIgnoreCase(name)) {
                            for (String v : values) setCookies.put(v);
                        } else if (values.size() == 1) {
                            headers.put(name, values.get(0));
                        } else {
                            JSArray arr = new JSArray();
                            for (String v : values) arr.put(v);
                            headers.put(name, arr);
                        }
                    }
                    ret.put("headers", headers);
                    ret.put("setCookies", setCookies);
                    ResponseBody rb = r.body();
                    byte[] bytes;
                    if (rb == null) {
                        bytes = new byte[0];
                    } else {
                        // 边读边限长：超大响应先拦截，避免整读进内存再判 OOM
                        Buffer sink = new Buffer();
                        try (BufferedSource source = rb.source()) {
                            while (source.read(sink, 65536) != -1) {
                                if (sink.size() > MAX_BODY) {
                                    call.reject("response too large");
                                    return;
                                }
                            }
                        }
                        bytes = sink.readByteArray();
                    }
                    ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject(e.getMessage(), e);
                }
            }
        });
    }
}
