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
    /** requestId → 在途 Call，供 JS 中止（AbortSignal）时取消 */
    private final Map<String, Call> inflight = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    public void load() {
        client = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();
        // 登录流程需要读取 302 的 Location/Set-Cookie，不能自动跟随
        noRedirectClient = client.newBuilder()
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
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

        // redirect=manual 时返回跳转响应本身（QQ 登录取 Location/p_skey 用）
        boolean manual = "manual".equalsIgnoreCase(call.getString("redirect", "follow"));
        final String requestId = call.getString("requestId", "");
        Call httpCall = (manual ? noRedirectClient : client).newCall(builder.build());
        if (!requestId.isEmpty()) inflight.put(requestId, httpCall);
        httpCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                if (!requestId.isEmpty()) inflight.remove(requestId, c);
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
                                    inflight.remove(requestId, c);
                                    call.reject("response too large");
                                    return;
                                }
                            }
                        }
                        bytes = sink.readByteArray();
                    }
                    ret.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    // 响应体读完才出在途表：读取阶段 abort 仍可生效（connection 拒绝读取即中断）
                    if (!requestId.isEmpty()) inflight.remove(requestId, c);
                    call.resolve(ret);
                } catch (Exception e) {
                    inflight.remove(requestId, c);
                    call.reject(e.getMessage(), e);
                }
            }
        });
    }

    /**
     * 中止指定 requestId 的在途请求（对齐 fetch 的 AbortSignal 语义）
     * @param call - { requestId }
     */
    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("requestId", "");
        Call c = inflight.remove(id);
        if (c != null) c.cancel();
        call.resolve();
    }
}
