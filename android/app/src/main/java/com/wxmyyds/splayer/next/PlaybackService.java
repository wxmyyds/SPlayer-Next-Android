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
 * 切歌所需网络请求不被冻结；通知内容由 MediaSessionPlugin 构建后经静态字段传入
 * （MediaStyle 已绑定 session token，此处只负责 startForeground）。
 */
public class PlaybackService extends Service {

    /** startForegroundWith 与 onStartCommand 之间的同进程通知交接 */
    private static Notification pendingNotification;

    /**
     * 以给定通知进入前台态
     * @param context 来源上下文
     * @param notification 通知（含 MediaSession token 与播控按钮）
     */
    static void startForegroundWith(Context context, Notification notification) {
        // 不能以“已运行”短路：stop→play 相邻时（JS 的 publishState("none") 与下首
        // playing 是毫秒级相邻的桥调用）onDestroy 异步派发，此时 startForegroundService
        // 会被跳过 → 服务随后销毁、前台态静默丢失。onStartCommand 的 startForeground
        // 幂等，重复启动无害
        // 通知整包含封面 Bitmap（≈1MB），putExtra 走 binder 会超单事务上限触发
        // TransactionTooLargeException 且被吞 → 前台态静默失效；改静态字段同进程交接
        pendingNotification = notification;
        try {
            Intent intent = new Intent(context, PlaybackService.class);
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
        // startForegroundService 的回调由 binder 握手保证 happens-after 静态写入
        Notification notification = pendingNotification;
        pendingNotification = null;
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
    public IBinder onBind(Intent intent) {
        return null;
    }
}
