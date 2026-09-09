package com.wxmyyds.splayer.next;

import android.app.Activity;
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
}
