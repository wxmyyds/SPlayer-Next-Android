package com.wxmyyds.splayer.next;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 系统栏沉浸插件：全屏播放页隐藏状态栏/导航小白条，滑出临时恢复。
 */
@CapacitorPlugin(name = "SystemUi")
public class SystemUiPlugin extends Plugin {

    @PluginMethod
    public void setImmersive(PluginCall call) {
        // 布尔桥接值经 Boolean.TRUE.equals 兜底
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("activity unavailable");
            return;
        }
        // insets 控制只允许主线程：插件方法跑在桥线程，必须切主线程操作
        final Window window = activity.getWindow();
        activity.runOnUiThread(
                () -> {
                    View decor = window.getDecorView();
                    WindowInsetsControllerCompat controller =
                            new WindowInsetsControllerCompat(window, decor);
                    if (enabled) {
                        controller.hide(WindowInsetsCompat.Type.systemBars());
                        controller.setSystemBarsBehavior(
                                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    } else {
                        controller.show(WindowInsetsCompat.Type.systemBars());
                    }
                    call.resolve(new JSObject());
                });
    }

    /**
     * 用系统浏览器打开外链：WebView 未实现 onCreateWindow，window.open(_blank) 带
     * noopener 时在部分版本上静默失败，外链统一走 ACTION_VIEW
     * @param url 要打开的 http/https 链接
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            call.reject("invalid url");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("activity unavailable");
            return;
        }
        activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        call.resolve(new JSObject());
    }

    /**
     * 读取系统深浅色：WebView 的 prefers-color-scheme 在部分 ROM 上与系统设置不一致，
     * 主题跟随一律以 Configuration.uiMode 为准
     */
    @PluginMethod
    public void getSystemTheme(PluginCall call) {
        int mask = getContext().getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        JSObject result = new JSObject();
        result.put("dark", mask == Configuration.UI_MODE_NIGHT_YES);
        call.resolve(result);
    }

    /** 系统深浅色切换：manifest 已声明 uiMode configChanges，Activity 不重建，走此钩子推送 */
    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        int mask = newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        JSObject payload = new JSObject();
        payload.put("dark", mask == Configuration.UI_MODE_NIGHT_YES);
        notifyListeners("systemThemeChanged", payload);
    }

    /**
     * 状态栏/导航栏图标明暗适配：浅色背景时给深色图标，避免白色图标看不见
     * @param light 为 true 时系统栏图标用深色（浅色背景），false 用浅色（暗色背景）
     */
    @PluginMethod
    public void setLightBars(PluginCall call) {
        // light = 图标深色（浅色背景用）；与 setAppearanceLightStatusBars 语义对齐
        boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("activity unavailable");
            return;
        }
        final Window window = activity.getWindow();
        activity.runOnUiThread(
                () -> {
                    WindowInsetsControllerCompat controller =
                            new WindowInsetsControllerCompat(window, window.getDecorView());
                    controller.setAppearanceLightStatusBars(light);
                    controller.setAppearanceLightNavigationBars(light);
                    call.resolve(new JSObject());
                });
    }
}
