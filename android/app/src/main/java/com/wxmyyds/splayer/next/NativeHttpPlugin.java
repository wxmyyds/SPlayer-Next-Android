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
        while (headerNames.hasNext()) {
            String name = headerNames.next();
            try {
                builder.header(name, headersObj.getString(name, ""));
            } catch (JSONException e) {
                // 跳过非法头
            }
        }
        if ("GET".equals(method) || "HEAD".equals(method)) {
            builder.method(method, null);
        } else {
            RequestBody body = bodyStr != null
                    ? RequestBody.create(bodyStr, MediaType.parse("application/octet-stream"))
                    : RequestBody.create(new byte[0], null);
            builder.method(method, body);
        }

        // redirect=manual 时返回跳转响应本身（QQ 登录取 Location/p_skey 用）
        boolean manual = "manual".equalsIgnoreCase(call.getString("redirect", "follow"));
        (manual ? noRedirectClient : client).newCall(builder.build()).enqueue(new Callback() {
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
                    byte[] bytes = rb != null ? rb.bytes() : new byte[0];
                    if (bytes.length > MAX_BODY) {
                        call.reject("response too large");
                        return;
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
