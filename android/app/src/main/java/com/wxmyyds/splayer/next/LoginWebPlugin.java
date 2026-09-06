package com.wxmyyds.splayer.next;

import android.app.Dialog;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 官方网页登录插件（Android 版，对标上游 dev 的 BrowserWindow 登录窗口）。
 *
 * 打开应用内 WebView 加载平台官方登录页，每秒轮询 CookieManager；
 * 出现被观察 cookie（网易 MUSIC_U）即视为登录成功，回传关键 cookie 并关闭。
 * 用户主动关闭返回 canceled（渲染层据此决定是否弹失败提示）。
 */
@CapacitorPlugin(name = "LoginWeb")
public class LoginWebPlugin extends Plugin {

    /** 伪装桌面 Chrome（与上游 FAKE_UA 一致，避免被判不受支持环境） */
    private static final String FAKE_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    /** 网易关心的关键 cookie（与上游 NETEASE_COOKIE_KEYS 一致） */
    private static final String[] NETEASE_KEYS = {"MUSIC_U", "__csrf", "NMTID", "MUSIC_A"};

    private Dialog dialog;
    private Handler handler;
    private Runnable poll;
    private PluginCall pending;

    @PluginMethod
    public void open(PluginCall call) {
        if (pending != null || dialog != null) {
            call.reject("busy");
            return;
        }
        String url = call.getString("url", "https://music.163.com/#/login");
        String watchCookie = call.getString("watchCookie", "MUSIC_U");
        pending = call;
        getActivity().runOnUiThread(() -> showLoginDialog(url, watchCookie));
    }

    private void showLoginDialog(String url, String watchCookie) {
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);

        LinearLayout root = new LinearLayout(getActivity());
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(getActivity());
        bar.setOrientation(LinearLayout.HORIZONTAL);
        TextView title = new TextView(getActivity());
        title.setText("登录网易云音乐");
        title.setPadding(32, 32, 0, 32);
        LinearLayout.LayoutParams titleLp =
                new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(title, titleLp);
        Button close = new Button(getActivity());
        close.setText("关闭");
        close.setOnClickListener(v -> {
            if (dialog != null) dialog.dismiss();
        });
        bar.addView(close);
        root.addView(bar);

        WebView web = new WebView(getActivity());
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUserAgentString(FAKE_UA);
        web.setWebViewClient(new WebViewClient());
        web.loadUrl(url);
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        dialog = new Dialog(getActivity(), android.R.style.Theme_NoTitleBar_Fullscreen);
        dialog.setContentView(root);
        dialog.setOnDismissListener(d -> {
            web.destroy();
            finish(null);
        });
        dialog.show();

        handler = new Handler(Looper.getMainLooper());
        poll = new Runnable() {
            @Override
            public void run() {
                JSObject hit = collectCookies(cm, watchCookie);
                if (hit != null) {
                    if (dialog != null) dialog.dismiss();
                    else finish(hit);
                    return;
                }
                if (dialog != null) handler.postDelayed(this, 1000);
            }
        };
        handler.postDelayed(poll, 1000);
    }

    /** 按 URL 取本站 cookie；未出现被观察 cookie 返回 null */
    private JSObject collectCookies(CookieManager cm, String watchCookie) {
        String raw = cm.getCookie("https://music.163.com");
        if (raw == null || raw.isEmpty()) return null;
        java.util.Map<String, String> map = new java.util.HashMap<>();
        for (String part : raw.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String key = part.substring(0, eq).trim();
            String val = part.substring(eq + 1).trim();
            if (!key.isEmpty() && !map.containsKey(key)) map.put(key, val);
        }
        if (!map.containsKey(watchCookie)) return null;
        JSObject out = new JSObject();
        for (String key : NETEASE_KEYS) {
            if (map.containsKey(key)) out.put(key, map.get(key));
        }
        return out;
    }

    /** 成功回传 cookies；null 表示用户取消 */
    private void finish(JSObject cookies) {
        if (handler != null && poll != null) handler.removeCallbacks(poll);
        handler = null;
        poll = null;
        dialog = null;
        if (pending == null) return;
        PluginCall call = pending;
        pending = null;
        if (cookies != null) {
            JSObject ret = new JSObject();
            ret.put("cookies", cookies);
            call.resolve(ret);
        } else {
            call.reject("canceled");
        }
    }
}
