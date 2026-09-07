package com.wxmyyds.splayer.next;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.webkit.WebSettings;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(LoginWebPlugin.class);
        registerPlugin(MediaSessionPlugin.class);
        super.onCreate(savedInstanceState);
        // 播放地址多为 http（网易 126.net）；主页面跑在 https scheme 下，
        // 默认混合内容策略会拦 http 音频，需与 usesCleartextTraffic 配合放行。
        this.getBridge().getWebView().getSettings()
                .setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    }
}
