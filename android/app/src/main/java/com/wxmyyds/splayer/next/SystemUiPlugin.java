package com.wxmyyds.splayer.next;

import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
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
        Window window = getActivity().getWindow();
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
    }
}
