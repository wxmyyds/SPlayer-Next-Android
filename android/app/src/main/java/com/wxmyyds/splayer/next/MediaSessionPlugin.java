package com.wxmyyds.splayer.next;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.concurrent.Executors;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * 系统播放桥（Android 原生，对标桌面 SMTC/托盘播放状态）。
 *
 * WebView 内 HTMLAudio 的声音系统能播，但 framework 不知道“在播音乐”；
 * 这里用 framework MediaSession（零新依赖）+ 系统通知把播放态递出去：
 * - 通知栏/锁屏/蓝牙/车机显示曲名歌手封面与进度
 * - 播放/暂停/上下首/进度拖动经 session 回调 → notifyListeners("mediaKey") → JS 触发同名播放事件
 *
 * 权限：仅 POST_NOTIFICATIONS（target 35 必须运行时申请）；Manifest 不新增其他权限。
 */
@CapacitorPlugin(
    name = "MediaBridge",
    permissions = @Permission(strings = {Manifest.permission.POST_NOTIFICATIONS}, alias = "notifications"))
public class MediaSessionPlugin extends Plugin {

    static final String CHANNEL_ID = "splayer_playback";
    static final int NOTIFICATION_ID = 1;
    private static final String ACTION_MEDIA_KEY = "com.wxmyyds.splayer.next.MEDIA_KEY";

    private static MediaSession sSession;
    private static MediaSessionPlugin sInstance;

    private final java.util.concurrent.ExecutorService artLoader = Executors.newSingleThreadExecutor();
    private PluginCall pendingUpdate;
    private Bitmap lastArt;
    /** 上次渲染通知的签名：曲目/播放态/封面变化才重建通知（见 publishState） */
    private String lastNotifiedTitle = "";
    private boolean lastNotifiedPlaying = false;
    private Bitmap lastNotifiedArt;

    private final BroadcastReceiver noisyReceiver =
            new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (!pauseOnNoisy) return;
                    // 拔耳机/断蓝牙：暂停，重连后不自动续播
                    emitMediaKey("pause");
                }
            };
    private boolean noisyRegistered;
    /** 拔出设备是否暂停（settings.player.pauseOnDeviceSwitch 同步而来，默认开） */
    private boolean pauseOnNoisy = true;

    @Override
    public void load() {
        sInstance = this;
        if (sSession == null) {
            sSession = new MediaSession(getContext(), "SPlayer");
            sSession.setFlags(MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            sSession.setCallback(
                    new MediaSession.Callback() {
                        private void emit(String action, long position) {
                            if (sInstance == null) return;
                            JSObject data = new JSObject();
                            data.put("action", action);
                            data.put("position", position);
                            sInstance.notifyListeners("mediaKey", data);
                        }

                        @Override
                        public void onPlay() {
                            emit("play", -1);
                        }

                        @Override
                        public void onPause() {
                            emit("pause", -1);
                        }

                        @Override
                        public void onSkipToNext() {
                            emit("next", -1);
                        }

                        @Override
                        public void onSkipToPrevious() {
                            emit("prev", -1);
                        }

                        @Override
                        public void onSeekTo(long pos) {
                            emit("seekto", pos);
                        }
                    });
        }
    }

    /** 推送播放态到系统（曲目切换/播控/进度节流调用，200ms 级） */
    @PluginMethod
    public void updateState(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33
                && getActivity().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            // 权限弹窗期间的新推送会覆盖旧 pending 调用，先 resolve 旧的避免桥上悬挂
            if (pendingUpdate != null) pendingUpdate.resolve();
            pendingUpdate = call;
            requestPermissionForAlias("notifications", call, "onNotificationPermission");
            return;
        }
        doUpdate(call);
    }

    @PermissionCallback
    private void onNotificationPermission(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED && pendingUpdate != null) {
            PluginCall pending = pendingUpdate;
            pendingUpdate = null;
            doUpdate(pending);
        } else {
            pendingUpdate = null;
            call.reject("notification permission denied");
        }
    }

    private void doUpdate(PluginCall call) {
        boolean stopped = Boolean.TRUE.equals(call.getBoolean("stopped", false));
        getActivity()
                .runOnUiThread(
                        () -> {
                            if (stopped) {
                                unregisterNoisyReceiver();
                                sSession.setActive(false);
                                lastArt = null;
                                lastNotifiedTitle = "";
                                lastNotifiedPlaying = false;
                                lastNotifiedArt = null;
                                notificationManager().cancel(NOTIFICATION_ID);
                                PlaybackService.stop(getContext());
                                call.resolve();
                                return;
                            }
                            sSession.setActive(true);
                            ensureChannel();
                            String title = call.getString("title", "");
                            String artist = call.getString("artist", "");
                            String album = call.getString("album", "");
                            boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
                            long positionMs = readLong(call, "positionMs", 0);
                            long durationMs = readLong(call, "durationMs", 0);
                            String artworkUrl = call.getString("artworkUrl", null);

                            // 焦点礼让交由 WebView 内部媒体栈处理（原生再申请会与其互斥，元素被瞬时暂停）；
                            // 这里只管拔耳机监听生命周期：播放期注册，暂停/停止注销
                            if (playing) registerNoisyReceiver();
                            else unregisterNoisyReceiver();

                            // 进度节流调用只带播放态：不重建元数据，否则标题/封面被冲空
                            MediaMetadata current =
                                    sSession.getController() != null
                                            ? sSession.getController().getMetadata()
                                            : null;
                            String currentTitle =
                                    current != null
                                            ? current.getString(MediaMetadata.METADATA_KEY_TITLE)
                                            : null;
                            boolean metaProvided =
                                    !title.isEmpty()
                                            || !artist.isEmpty()
                                            || !album.isEmpty()
                                            || (artworkUrl != null && !artworkUrl.isEmpty());
                            if (!title.isEmpty() && !title.equals(currentTitle)) lastArt = null;
                            if (metaProvided) {
                                // 时长优先取本次推送，未带时用当前元数据旧值兜底
                                long duration =
                                        durationMs > 0
                                                ? durationMs
                                                : current != null
                                                        ? current.getLong(MediaMetadata.METADATA_KEY_DURATION)
                                                        : 0L;
                                MediaMetadata.Builder meta =
                                        new MediaMetadata.Builder()
                                                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                                                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                                                .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
                                                .putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
                                sSession.setMetadata(meta.build());
                            } else if (durationMs > 0
                                    && current != null
                                    && current.getLong(MediaMetadata.METADATA_KEY_DURATION) != durationMs) {
                                // 纯进度推送：把最新时长补进元数据，系统媒体卡片据此渲染进度条
                                sSession.setMetadata(
                                        new MediaMetadata.Builder(current)
                                                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
                                                .build());
                            }
                            publishState(playing, positionMs, durationMs, lastArt);
                            if (artworkUrl != null && !artworkUrl.isEmpty()) {
                                loadArtworkAsync(artworkUrl, title, artist, album, playing, positionMs, durationMs);
                            }
                            call.resolve();
                        });
    }

    private void publishState(
            boolean playing, long positionMs, long durationMs, Bitmap art) {
        int state =
                playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        long actions =
                PlaybackState.ACTION_PLAY
                        | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackState.ACTION_SEEK_TO;
        PlaybackState.Builder builder =
                new PlaybackState.Builder()
                        .setActions(actions)
                        .setState(state, Math.max(0, positionMs), 1.0f);
        sSession.setPlaybackState(builder.build());
        // 系统媒体卡片进度由 PlaybackState 实时推算，纯进度推送不重建通知；
        // 200ms 级 notify 会被系统节流，表现为通知栏控件“一会有一会没”
        MediaMetadata meta = sSession.getController().getMetadata();
        String title = meta != null ? meta.getString(MediaMetadata.METADATA_KEY_TITLE) : "";
        if (!title.equals(lastNotifiedTitle)
                || playing != lastNotifiedPlaying
                || art != lastNotifiedArt) {
            showNotification(playing, positionMs, durationMs, art);
            lastNotifiedTitle = title;
            lastNotifiedPlaying = playing;
            lastNotifiedArt = art;
        }
    }

    private void showNotification(boolean playing, long positionMs, long durationMs, Bitmap art) {
        if (Build.VERSION.SDK_INT < 26) return;
        MediaMetadata meta = sSession.getController().getMetadata();
        String title = meta != null ? meta.getString(MediaMetadata.METADATA_KEY_TITLE) : "";
        String artist = meta != null ? meta.getString(MediaMetadata.METADATA_KEY_ARTIST) : "";
        Context ctx = getContext();
        Notification.Builder builder =
                new Notification.Builder(ctx, CHANNEL_ID)
                        .setSmallIcon(ctx.getApplicationInfo().icon)
                        .setContentTitle(title)
                        .setContentText(artist)
                        .setOngoing(playing)
                        .setOnlyAlertOnce(true)
                        .setShowWhen(false)
                        .setStyle(
                                new Notification.MediaStyle()
                                        .setMediaSession(sSession.getSessionToken())
                                        .setShowActionsInCompactView(0, 1, 2));
        if (art != null) builder.setLargeIcon(art);
        builder.addAction(action(android.R.drawable.ic_media_previous, "上一首", "prev", positionMs));
        builder.addAction(
                action(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "暂停" : "播放",
                        playing ? "pause" : "play",
                        positionMs));
        builder.addAction(action(android.R.drawable.ic_media_next, "下一首", "next", positionMs));
        Notification notification = builder.build();
        notificationManager().notify(NOTIFICATION_ID, notification);
        // 同步拉起前台服务：进程保持前台优先级，后台不被冻结，WebView 自动切歌链路存活
        PlaybackService.startForegroundWith(getContext(), notification);
    }

    private Notification.Action action(int iconRes, String label, String key, long positionMs) {
        Intent intent = new Intent(getContext(), MediaActionReceiver.class);
        intent.setAction(ACTION_MEDIA_KEY);
        intent.putExtra("key", key);
        PendingIntent pi =
                PendingIntent.getBroadcast(
                        getContext(),
                        key.hashCode(),
                        intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(iconRes, label, pi).build();
    }

    private void loadArtworkAsync(
            String url, String title, String artist, String album, boolean playing, long positionMs, long durationMs) {
        artLoader.execute(
                () -> {
                    Bitmap art = fetchBitmap(url);
                    if (art == null) return;
                    getActivity()
                            .runOnUiThread(
                                    () -> {
                                        if (sSession == null) return;
                                        MediaMetadata old = sSession.getController().getMetadata();
                                        if (old == null) return;
                                        // 曲目没变才贴图，避免串台
                                        String cur = old.getString(MediaMetadata.METADATA_KEY_TITLE);
                                        if (cur == null || !cur.equals(title)) return;
                                        MediaMetadata.Builder meta =
                                                new MediaMetadata.Builder(old);
                                        meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
                                        meta.putBitmap(MediaMetadata.METADATA_KEY_ART, art);
                                        sSession.setMetadata(meta.build());
                                        lastArt = art;
                                        publishState(playing, positionMs, durationMs, art);
                                    });
                });
    }

    private Bitmap fetchBitmap(String url) {
        try {
            OkHttpClient client = new OkHttpClient();
            Request request = new Request.Builder().url(url).build();
            try (Response response = client.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) return null;
                byte[] bytes = response.body().bytes();
                if (bytes.length > 4 * 1024 * 1024) return null;
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = notificationManager();
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel =
                new NotificationChannel(CHANNEL_ID, "正在播放", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("显示当前播放的音乐与控制按钮");
        nm.createNotificationChannel(channel);
    }

    private NotificationManager notificationManager() {
        return (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
    }

    /** 经 mediaKey 通道通知 JS 执行播放/暂停（与通知栏按键同一路径） */
    private void emitMediaKey(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("position", -1);
        notifyListeners("mediaKey", data);
    }

    private void registerNoisyReceiver() {
        if (noisyRegistered) return;
        try {
            // 挂 applicationContext：播放中退出页面时避免 Activity 泄漏接收器
            Context appContext = getContext().getApplicationContext();
            IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            if (Build.VERSION.SDK_INT >= 33) {
                appContext.registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                appContext.registerReceiver(noisyReceiver, filter);
            }
            noisyRegistered = true;
        } catch (Exception ignored) {
            // 部分 ROM 对 NOT_EXPORTED 校验过严会抛异常；监听失败只影响拔耳机暂停，绝不波及播放
        }
    }

    private void unregisterNoisyReceiver() {
        if (!noisyRegistered) return;
        noisyRegistered = false;
        try {
            getContext().getApplicationContext().unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {
            // 已被系统注销
        }
    }

    /** 同步"拔出设备暂停"设置（settings.player.pauseOnDeviceSwitch） */
    @PluginMethod
    public void setPauseOnDeviceSwitch(PluginCall call) {
        pauseOnNoisy = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        call.resolve();
    }

    private static long readLong(PluginCall call, String key, long fallback) {
        Object value = call.getData().opt(key);
        if (value instanceof Number) return ((Number) value).longValue();
        return fallback;
    }

    /** 供 MediaActionReceiver 转发通知栏按键到 session 回调 */
    static MediaSession session() {
        return sSession;
    }
}
