package com.wxmyyds.splayer.next;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.session.MediaController;
import android.media.session.MediaSession;

/**
 * 通知栏按键转发：把点击经 MediaController 送回 MediaSession 回调，
 * 再由插件 notifyListeners("mediaKey") 交给 Web 层触发播放事件。
 */
public class MediaActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        MediaSession session = MediaSessionPlugin.session();
        if (session == null || !session.isActive()) return;
        String key = intent.getStringExtra("key");
        if (key == null) return;
        MediaController controller = new MediaController(context, session.getSessionToken());
        switch (key) {
            case "play":
                controller.getTransportControls().play();
                break;
            case "pause":
                controller.getTransportControls().pause();
                break;
            case "next":
                controller.getTransportControls().skipToNext();
                break;
            case "prev":
                controller.getTransportControls().skipToPrevious();
                break;
            default:
                break;
        }
    }
}
