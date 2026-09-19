package com.wxmyyds.splayer.next;

import android.content.Context;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.ByteString;

/**
 * 引擎原生桥：Rust 壳回调的静态入口（HTTP/存储/logcat）
 *
 * HTTP 用独立 OkHttp 客户端（与 NativeHttpPlugin 的 WebView 传输互不影响），
 * requestId → Call 映射支撑 vendor 取消语义；存储走 SharedPreferences
 * （空串 = 删除），与 WebView 的 localStorage 同键空间不同区，互不串扰。
 */
public class JsEngineBridge {
    private static final String TAG = "JsEngine";
    private static final String STORE_NAME = "splayer-engine-storage";
    /** 引擎响应体上限（对齐 NativeHttpPlugin 的 8MB 限长） */
    private static final long MAX_ENGINE_BODY = 8L * 1024 * 1024;

    private static volatile Context appContext;
    private static final ConcurrentHashMap<String, Call> calls = new ConcurrentHashMap<>();

    private static final OkHttpClient CLIENT =
        new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build();

    /** redirect=manual 专用：返回跳转响应本身（QQ 登录取 Location/p_skey） */
    private static final OkHttpClient NO_REDIRECT_CLIENT =
        CLIENT.newBuilder().followRedirects(false).followSslRedirects(false).build();

    /** 注入应用上下文（App 启动时调用一次） */
    public static void init(Context context) {
        appContext = context.getApplicationContext();
    }

    /**
     * 取应用上下文（引擎侧读取 assets / 存储用）
     * @return 应用上下文，未初始化返回 null
     */
    public static Context appContext() {
        return appContext;
    }

    /**
     * 发 HTTP（Rust 线程上阻塞执行）
     * @param reqJson - { url, method, headers, body?, redirect, requestId }，body 为 base64 或空
     * @return 响应 JSON：{ status, url, headers, setCookies, bodyBase64 }
     */
    public static String httpFromEngine(String reqJson) {
        try {
            JSObject req = JSObject.fromJSONObject(new org.json.JSONObject(reqJson));
            String requestId = req.getString("requestId", "");
            String url = req.getString("url");
            String method = req.getString("method", "GET").toUpperCase();
            org.json.JSONObject headers = req.has("headers")
                ? req.getJSONObject("headers")
                : new org.json.JSONObject();
            String bodyB64 = req.getString("body", "");
            String redirect = req.optString("redirect", "follow");

            Request.Builder builder = new Request.Builder().url(url);
            java.util.Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                builder.header(key, headers.getString(key));
            }
            // 与 NativeHttpPlugin 对齐：关闭透明解压，原始字节交 JS（假 gzip 风控）
            builder.header("Accept-Encoding", "identity");
            byte[] bodyBytes;
            if (bodyB64.isEmpty()) {
                bodyBytes = null;
            } else if (req.optBoolean("bodyIsBase64", false)) {
                bodyBytes = Base64.decode(bodyB64, Base64.NO_WRAP);
            } else {
                // vendor 的 form/JSON body 是原始字符串，不能当 base64 解
                bodyBytes = bodyB64.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            }
            RequestBody requestBody = null;
            if (!method.equals("GET") && !method.equals("HEAD")) {
                requestBody = (bodyBytes != null)
                    ? RequestBody.create(bodyBytes, MediaType.parse("application/octet-stream"))
                    : RequestBody.create(new byte[0], null);
            }
            OkHttpClient httpClient = "manual".equalsIgnoreCase(redirect) ? NO_REDIRECT_CLIENT : CLIENT;
            Call call = httpClient.newCall(builder.method(method, requestBody).build());
            if (!requestId.isEmpty()) calls.put(requestId, call);
            try {
                Response resp = call.execute();
                long bodyLen = resp.body() != null ? resp.body().contentLength() : 0;
                if (bodyLen > MAX_ENGINE_BODY) {
                    throw new IOException("response too large: " + bodyLen);
                }
                byte[] bytes = resp.body().bytes();
                JSObject headersOut = new JSObject();
                for (String name : resp.headers().names()) {
                    List<String> values = resp.headers().values(name);
                    headersOut.put(name, values.size() == 1 ? values.get(0) : values);
                }
                JSArray setCookies = new JSArray();
                for (String v : resp.headers().values("Set-Cookie")) setCookies.put(v);
                JSObject out = new JSObject();
                out.put("status", resp.code());
                out.put("url", resp.request().url().toString());
                out.put("headers", headersOut);
                out.put("setCookies", setCookies);
                out.put(
                    "bodyBase64",
                    Base64.encodeToString(bytes, Base64.NO_WRAP)
                );
                return out.toString();
            } finally {
                if (!requestId.isEmpty()) calls.remove(requestId);
            }
        } catch (Exception e) {
            Log.w(TAG, "http failed: " + e.getMessage());
            // e.getMessage() 可能含引号/反斜杠，手拼 JSON 会产出非法串放大为解析失败
            try {
                return new org.json.JSONObject()
                        .put("status", 0)
                        .put("url", "")
                        .put("headers", new org.json.JSONObject())
                        .put("setCookies", new org.json.JSONArray())
                        .put("bodyBase64", "")
                        .put("error", String.valueOf(e.getMessage()))
                        .toString();
            } catch (Exception ignored) {
                return "{\"status\":0,\"url\":\"\",\"headers\":{},\"setCookies\":[],\"bodyBase64\":\"\"}";
            }
        }
    }

    /**
     * 取消在途请求
     * @param reqJson - { requestId }
     * @return 空对象
     */
    public static String httpCancelFromEngine(String reqJson) {
        try {
            String requestId = new org.json.JSONObject(reqJson).optString("requestId", "");
            Call call = calls.remove(requestId);
            if (call != null) call.cancel();
        } catch (Exception ignored) {
            // 取消失败不影响业务
        }
        return "{}";
    }

    /**
     * 引擎存储读
     * @param key - 键
     * @return 值或空串
     */
    public static String storeGetFromEngine(String key) {
        Context ctx = appContext;
        if (ctx == null) return "";
        return ctx.getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE).getString(key, "");
    }

    /**
     * 引擎存储写（空串 = 删除）
     * @param key - 键
     * @param value - 值
     */
    public static void storeSetFromEngine(String key, String value) {
        Context ctx = appContext;
        if (ctx == null) return;
        android.content.SharedPreferences.Editor editor = ctx
            .getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE)
            .edit();
        if (value.isEmpty()) {
            editor.remove(key);
        } else {
            editor.putString(key, value);
        }
        editor.apply();
    }

    /**
     * 引擎存储全量键（JSON 数组字符串）
     * @return 键集合 JSON
     */
    public static String storeKeysFromEngine() {
        Context ctx = appContext;
        if (ctx == null) return "[]";
        java.util.Set<String> keys = ctx
            .getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE)
            .getAll()
            .keySet();
        JSArray arr = new JSArray();
        for (String k : keys) arr.put(k);
        return arr.toString();
    }

    /**
     * logcat 直写
     * @param level - 级别
     * @param message - 内容
     */
    public static void logFromEngine(String level, String message) {
        switch (level) {
            case "ERROR" -> Log.e(TAG, message);
            case "WARN" -> Log.w(TAG, message);
            case "DEBUG" -> Log.d(TAG, message);
            default -> Log.i(TAG, message);
        }
    }
}
