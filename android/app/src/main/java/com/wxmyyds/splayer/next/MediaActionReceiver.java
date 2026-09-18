package com.wxmyyds.splayer.next;

import android.content.BroadcastReceiver;
import android.content.Intent;

/**
 * 通知栏按键转发：直连插件 emitMediaKey（notifyListeners("mediaKey")）交给 Web 层。
 * 不经 MediaController 中转：android.media.session.MediaController 无 release()，
 * 每次按键新建会累积持有 binder 代理的实例。
 */
public class MediaActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String key = intent.getStringExtra("key");
        if (key == null) return;
        switch (key) {
            case "play":
            case "pause":
            case "next":
            case "prev":
                MediaSessionPlugin.emitMediaKey(key, -1L);
                break;
            default:
                break;
        }
    }
}
