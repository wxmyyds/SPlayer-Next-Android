package com.wxmyyds.splayer.next;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台播放保活服务。
 *
 * WebView 内 HTMLAudio 退后台后声音仍能出，但进程降为 cached 级会被系统冻结
 * （cached-app freezer），WebView 的 JS 停摆，ended → 自动切歌链路即断。
 * 播放期间以 mediaPlayback 类型进入前台态抬升进程优先级，保证 WebView/JS 与
 * 切歌所需网络请求不被冻结；通知内容由 MediaSessionPlugin 构建后经 Intent 传入
 * （MediaStyle 已绑定 session token，此处只负责 startForeground）。
 */
public class PlaybackService extends Service {

    private static final String EXTRA_NOTIFICATION = "notification";

    /** 服务是否已在前台态；运行中时通知更新走 NotificationManager，不再重复 startIntent */
    private static boolean sRunning;

    /**
     * 以给定通知进入前台态（已运行时为空操作）
     * @param context 来源上下文
     * @param notification 通知（含 MediaSession token 与播控按钮）
     */
    static void startForegroundWith(Context context, Notification notification) {
        if (sRunning) return;
        Intent intent =
                new Intent(context, PlaybackService.class).putExtra(EXTRA_NOTIFICATION, notification);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception ignored) {
            // 12+ 后台启动受限时退化为纯通知；首启总发生在前台交互时，不受影响
        }
    }

    /** 退出前台态并结束服务（未运行时为无害空操作） */
    static void stop(Context context) {
        context.stopService(new Intent(context, PlaybackService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        sRunning = true;
        Notification notification = null;
        if (intent != null) {
            if (Build.VERSION.SDK_INT >= 33) {
                notification = intent.getParcelableExtra(EXTRA_NOTIFICATION, Notification.class);
            } else {
                @SuppressWarnings("deprecation")
                Notification legacy = intent.getParcelableExtra(EXTRA_NOTIFICATION);
                notification = legacy;
            }
        }
        if (notification == null) {
            // 理论不可达（唯一调用方必带通知）；FGS 启动后必须立刻 startForeground 否则系统判 ANR
            Notification.Builder fallback =
                    Build.VERSION.SDK_INT >= 26
                            ? new Notification.Builder(this, MediaSessionPlugin.CHANNEL_ID)
                            : new Notification.Builder(this);
            notification = fallback.setSmallIcon(getApplicationInfo().icon).build();
        }
        startForeground(MediaSessionPlugin.NOTIFICATION_ID, notification);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        sRunning = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
