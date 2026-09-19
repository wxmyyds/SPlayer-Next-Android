package com.wxmyyds.splayer.next;

import android.content.Context;
import android.util.Log;
import com.getcapacitor.JSObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * 引擎 JS 解析器：rquickjs 跑 vendor 的 callNetease（与 WebView 内解析同一段代码）
 *
 * 引擎懒加载（首次解析时创建运行时并 eval bundle），单线程串行（FGS 内
 * ENDED 自解一次一首）；失败返回 null，由调用方走 resolveFails 重试语义。
 */
public final class JsEngineResolver {
    private static final String TAG = "JsEngine";
    /** nativeCall 的整体超时（Rust 侧 24s 泵截止，这里兜底线程等待） */
    private static final long CALL_TIMEOUT_MS = 25_000;

    private static final Object LOCK = new Object();
    private static long enginePtr;
    /** 初始化失败后置 true：本次会话不再尝试引擎（队列耗尽自然停止） */
    private static volatile boolean initFailed;

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "js-engine");
        t.setDaemon(true);
        return t;
    });

    private JsEngineResolver() {}

    /**
     * 注入应用上下文（App 启动时调用一次）
     * @param context - 应用上下文
     */
    public static void init(Context context) {
        JsEngineBridge.init(context);
    }

    /** 懒初始化：加载 assets 引擎 bundle 并 eval */
    private static boolean ensureEngine() {
        if (enginePtr != 0) return true;
        if (initFailed) return false;
        synchronized (LOCK) {
            if (enginePtr != 0) return true;
            if (initFailed) return false;
            try {
                long ptr = JsEngine.nativeCreate();
                if (ptr == 0) {
                    initFailed = true;
                    Log.w(TAG, "engine create failed");
                    return false;
                }
                String bundle = readBundle();
                if (bundle == null) {
                    initFailed = true;
                    JsEngine.nativeDestroy(ptr);
                    Log.w(TAG, "engine bundle missing");
                    return false;
                }
                String err = JsEngine.nativeEval(ptr, bundle);
                if (err != null && !err.isEmpty()) {
                    initFailed = true;
                    JsEngine.nativeDestroy(ptr);
                    Log.w(TAG, "engine bundle eval failed: " + err);
                    return false;
                }
                enginePtr = ptr;
                Log.i(TAG, "engine ready");
                return true;
            } catch (Throwable t) {
                initFailed = true;
                Log.w(TAG, "engine init failed", t);
                return false;
            }
        }
    }

    /** 读 assets 里的引擎 bundle */
    private static String readBundle() {
        Context ctx = JsEngineBridge.appContext();
        if (ctx == null) return null;
        try (java.io.InputStream in = ctx.getAssets().open("engine/bundle.js")) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 引擎解析（按平台分发的请求 JSON）
     * @param requestJson - 引擎请求 JSON（platform/songId/level 及平台参数）
     * @return { ok, url, trial } JSON 或 null（引擎不可用/解析失败，调用方走重试语义）
     */
    public static String resolve(String requestJson) {
        if (!ensureEngine()) return null;
        Future<String> future = EXECUTOR.submit(() -> JsEngine.nativeCall(enginePtr, requestJson));
        try {
            String result = future.get(CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (result == null) return null;
            // 原样透传（含 ok:false）：错误原文由 resolveViaEngine 拼进 IOException，此处只记日志
            org.json.JSONObject parsed = new org.json.JSONObject(result);
            if (!parsed.optBoolean("ok", false) || parsed.optString("url", "").isEmpty()) {
                Log.w(TAG, "engine resolve failed: " + parsed.optString("error", ""));
            }
            return result;
        } catch (TimeoutException e) {
            future.cancel(true);
            Log.w(TAG, "engine resolve timeout");
            return null;
        } catch (Throwable t) {
            Log.w(TAG, "engine resolve error", t);
            return null;
        }
    }
}
