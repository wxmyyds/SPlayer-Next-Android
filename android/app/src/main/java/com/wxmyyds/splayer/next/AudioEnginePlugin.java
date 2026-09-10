package com.wxmyyds.splayer.next;

import android.content.Context;
import android.media.audiofx.BassBoost;
import android.media.audiofx.Equalizer;
import android.media.audiofx.LoudnessEnhancer;
import android.media.audiofx.Virtualizer;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 原生音频引擎（Android 对标桌面 Rust audio-engine）。
 *
 * 用 Media3 ExoPlayer 替代 HTMLAudio：
 * - 后台播放可靠（原生音频不走 WebView，不受 freezer 影响）
 * - 均衡器/低音/虚拟器/响度增强（framework AudioEffect）
 * - 变速变调（ExoPlayer PlaybackParameters）
 * - 实时频谱（Visualizer，无 CORS 限制）
 * - 音频焦点与拔出设备暂停交给 ExoPlayer 内建处理（setAudioAttributes 第二参 +
 *   handleAudioBecomingNoisy），不在外层重复申请焦点，避免路由切换时双重避让互卡
 * - 通知栏/锁屏/MediaSession 由 MediaSessionPlugin 独占（含前台服务）
 */
@CapacitorPlugin(name = "AudioEngine")
public class AudioEnginePlugin extends Plugin {

    private static final String TAG = "AudioEngine";
    private static final int FFT_BINS = 128;

    /**
     * 读取数值参数：Capacitor 类型化取值器（getLong/getFloat）是盲目强转，
     * 桥接过来的 JS 数字落在 Integer/Double 上会抛 CCE 并静默返回默认值（seek 变 0 的根因）
     */
    private static long optLong(PluginCall call, String key, long def) {
        Object v = call.getData().opt(key);
        return v instanceof Number ? ((Number) v).longValue() : def;
    }

    private static float optFloat(PluginCall call, String key, float def) {
        Object v = call.getData().opt(key);
        return v instanceof Number ? ((Number) v).floatValue() : def;
    }

    private static AudioEnginePlugin sInstance;
    private ExoPlayer player;
    private Handler mainHandler;

    // Audio effects
    private Equalizer equalizer;
    private BassBoost bassBoost;
    private Virtualizer virtualizer;
    private LoudnessEnhancer loudnessEnhancer;
    private boolean effectsAttached = false;
    private boolean equalizerEnabled = false;
    private float[] equalizerBands = null;
    private boolean normalizationEnabled = false;

    // Visualizer
    private android.media.audiofx.Visualizer visualizer;
    private boolean fftEnabled = false;

    // State
    private boolean isPlaying = false;
    private long currentPosition = 0;
    private long currentDuration = 0;

    /** 曲目结束后保护切歌决策链的短时锁（ENDED 后 WAKE_MODE_LOCAL 已释放， */
    // JS 决策 + load 新曲的间隙 CPU 掉睡会卡住切歌；新曲开播即交还，30s 兜底超时）
    private android.os.PowerManager.WakeLock switchWakeLock;
    /**
     * 队列化自治切歌（参照 SFA PlaybackQueue）：JS 预解析的下一首以播放列表待播项挂入 ExoPlayer，
     * 当前曲播放时 ExoPlayer 自动预缓冲下一首字节，ENDED 瞬间零网络零 WebView 依赖直接过渡。
     * AUTO 过渡后用媒体 ID 反查元数据刷新通知栏并回传 JS 同步。
     */
    private final Map<String, JSObject> pendingMeta = new HashMap<>();
    /** requestNextUrl 补窗节拍计数（200ms/拍，每 75 拍 ≈ 15s 提醒 JS 补挂） */
    private long nudgeTick = 0;
    private float volume = 1.0f;
    private float speed = 1.0f;
    private boolean pitchSync = true;
    private int fadeMs = 200;

    @Override
    public void load() {
        sInstance = this;
        mainHandler = new Handler(Looper.getMainLooper());
        initPlayer();
    }

    private void initPlayer() {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();
        player = new ExoPlayer.Builder(getContext())
                .setAudioAttributes(attrs, true)
                .setHandleAudioBecomingNoisy(true)
                // WAKE_MODE_NETWORK 同时锁 CPU + WiFi（参照 SFA PlaybackManager）：
                // Doze 会断网，LOCAL 只锁 CPU 时 ENDED 后 prepare 拉不到流，锁屏切歌死链
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                Log.i(TAG, "state=" + state);
                switch (state) {
                    case Player.STATE_READY:
                        currentDuration = player.getDuration();
                        initAudioEffects();
                        emitEvent("ready", null);
                        break;
                    case Player.STATE_ENDED:
                        // 播放列表尾部真结束（无待播项）：回落 JS 链
                        acquireSwitchWakeLock();
                        Log.i(TAG, "ended (playlist end)");
                        emitEvent("ended", null);
                        break;
                    case Player.STATE_BUFFERING:
                        emitEvent("buffering", null);
                        break;
                    case Player.STATE_IDLE:
                        releaseAudioEffects();
                        break;
                }
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                Log.i(TAG, "playing=" + playing);
                isPlaying = playing;
                if (playing) {
                    releaseSwitchWakeLock();
                    if (fftEnabled) initVisualizer();
                } else {
                    releaseVisualizer();
                }
                // 引擎播放态以状态快照推送（对齐官方 SPlayer-for-Android）：
                // BUFFERING 等瞬态不产生 play/pause 指令事件，避免 JS 回射形成暂停/续播振荡环
                JSObject data = new JSObject();
                data.put("playing", playing);
                data.put("volume", volume);
                data.put("speed", speed);
                emitEvent("playingChanged", data);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(TAG, "playerError", error);
                JSObject data = new JSObject();
                data.put("message", error.getMessage());
                emitEvent("sourceError", data);
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
                currentPosition = newPosition.positionMs;
            }

            @Override
            public void onMediaItemTransition(androidx.media3.common.MediaItem mediaItem, int reason) {
                if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || mediaItem == null) return;
                // 播放列表自动过渡（对齐 SFA 原生自治切歌）：下一首早已预缓冲，
                // 锁屏/WebView 冻结均不影响；元数据反查后刷新通知并回传 JS 同步
                Log.i(TAG, "autoTransition mediaId=" + mediaItem.mediaId);
                JSObject meta = pendingMeta.get(mediaItem.mediaId);
                if (meta != null) {
                    MediaSessionPlugin.applyNativeUpdate(
                            meta.getString("title", ""),
                            meta.getString("artist", ""),
                            meta.getString("album", ""),
                            meta.getString("artwork", ""),
                            true,
                            0L,
                            readLongFrom(meta, "durationMs"));
                    emitEvent("autoAdvanced", meta);
                }
                // 立刻请求 JS 补挂新的下一首（WebView 冻结时事件排队，解锁后即补）
                emitEvent("requestNextUrl", null);
            }
        });
        startPositionUpdates();
    }

    private void startPositionUpdates() {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                nudgeTick++;
                if (player != null && isPlaying) {
                    currentPosition = player.getCurrentPosition();
                    currentDuration = player.getDuration();
                    JSObject data = new JSObject();
                    data.put("position", currentPosition);
                    data.put("duration", currentDuration > 0 ? currentDuration : 0);
                    emitEvent("position", data);
                }
                // 窗口耗尽预警（对齐 SFA requestUrls）：待播播放中且无待播项，定期提醒 JS 补窗。
                // 用 playWhenReady 而非 isPlaying：锁屏 BUFFERING 间隙同样需要补窗
                if (player != null
                        && player.getPlayWhenReady()
                        && nudgeTick % 75 == 0
                        && player.getCurrentMediaItemIndex() >= player.getMediaItemCount() - 1) {
                    emitEvent("requestNextUrl", null);
                }
                mainHandler.postDelayed(this, 200);
            }
        }, 200);
    }

    @PluginMethod
    public void load(PluginCall call) {
        String source = call.getString("source");
        boolean autoPlay = call.getBoolean("autoPlay", true);

        if (source == null || source.isEmpty()) {
            call.reject("source required");
            return;
        }

        Log.i(TAG, "load autoPlay=" + autoPlay);
        String trackId = call.getString("trackId", "");
        // mediaId 必须是 trackId（而非 URI）：AUTO 过渡后按它反查元数据，
        // 也让预载挂载能识别“当前曲即待挂曲目”的竞态
        MediaItem mediaItem = trackId.isEmpty()
                ? MediaItem.fromUri(source)
                : new MediaItem.Builder().setMediaId(trackId).setUri(source).build();
        mainHandler.post(() -> {
            // JS 主动 load 新曲：待播项已过时，清空（预载成功后会重新登记）
            pendingMeta.clear();
            player.setMediaItem(mediaItem);
            player.prepare();
            if (autoPlay) player.play();
            JSObject ret = new JSObject();
            ret.put("duration", player.getDuration() > 0 ? player.getDuration() : 0);
            call.resolve(ret);
        });
    }

    /**
     * 登记 JS 预解析好的下一首窗口（SFA PlaybackQueue 滑窗）：整窗替换当前曲之后的待播项，
     * ExoPlayer 对窗口内曲目逐个预缓冲，锁屏连续 AUTO 过渡零 WebView 依赖
     * @param call - { items: [{ trackId, playIndex, source, title, artist, album, artwork, durationMs }] }
     */
    @PluginMethod
    public void setNextResources(PluginCall call) {
        org.json.JSONArray items = call.getData().optJSONArray("items");
        if (items == null || items.length() == 0) {
            call.reject("items required");
            return;
        }
        mainHandler.post(() -> {
            if (player == null) {
                call.resolve();
                return;
            }
            androidx.media3.common.MediaItem cur = player.getCurrentMediaItem();
            if (cur == null) {
                call.resolve();
                return;
            }
            // 幂等整窗替换：先清掉当前之后的待播项再登记，预载重推不产生重复
            int current = player.getCurrentMediaItemIndex();
            if (current >= 0 && player.getMediaItemCount() > current + 1) {
                player.removeMediaItems(current + 1, player.getMediaItemCount());
            }
            pendingMeta.keySet().retainAll(Collections.singletonList(cur.mediaId));
            int appended = 0;
            String firstAppendedId = null;
            for (int i = 0; i < items.length(); i++) {
                JSONObject raw = items.optJSONObject(i);
                if (raw == null) continue;
                String trackId = raw.optString("trackId", "");
                String source = raw.optString("source", "");
                if (trackId.isEmpty() || source.isEmpty()) continue;
                // 预载与 ended 链竞态：该曲已被 JS 链自行 load 为当前曲，再挂会切到“自己”
                if (trackId.equals(cur.mediaId)) continue;
                JSObject meta = new JSObject();
                meta.put("trackId", trackId);
                meta.put("playIndex", raw.optInt("playIndex", -1));
                meta.put("source", source);
                meta.put("title", raw.optString("title", ""));
                meta.put("artist", raw.optString("artist", ""));
                meta.put("album", raw.optString("album", ""));
                meta.put("artwork", raw.optString("artwork", ""));
                meta.put("durationMs", raw.optDouble("durationMs", 0));
                pendingMeta.put(trackId, meta);
                player.addMediaItem(new MediaItem.Builder().setMediaId(trackId).setUri(source).build());
                if (firstAppendedId == null) firstAppendedId = trackId;
                appended++;
            }
            Log.i(TAG, "setNextWindow appended=" + appended + " first=" + firstAppendedId);
            // ENDED 后迟到补窗：直接切到窗口首项开播（对齐 SFA pendingResumeAfterRefill）
            if (appended > 0 && player.getPlaybackState() == Player.STATE_ENDED) {
                player.seekTo(current + 1, 0);
                player.play();
                Log.i(TAG, "lateRefill -> play " + firstAppendedId);
            }
            call.resolve();
        });
    }

    /** 清除登记的下一首（队列变化/预载作废时由 JS 调用） */
    @PluginMethod
    public void clearNextResource(PluginCall call) {
        mainHandler.post(() -> {
            if (player != null) {
                int current = player.getCurrentMediaItemIndex();
                if (current >= 0 && player.getMediaItemCount() > current + 1) {
                    player.removeMediaItems(current + 1, player.getMediaItemCount());
                }
                androidx.media3.common.MediaItem cur = player.getCurrentMediaItem();
                if (cur != null) {
                    pendingMeta.keySet().retainAll(Collections.singletonList(cur.mediaId));
                } else {
                    pendingMeta.clear();
                }
            }
            Log.i(TAG, "clearNext");
            call.resolve();
        });
    }

    private static long readLongFrom(JSObject obj, String key) {
        Object value = obj.opt(key);
        return value instanceof Number ? ((Number) value).longValue() : 0L;
    }

    /** 循环模式：仅单曲循环由 ExoPlayer 原生接管（锁屏下也能无缝重放）；ALL 的回绕由 JS 链处理 */
    @PluginMethod
    public void setRepeatMode(PluginCall call) {
        String mode = call.getString("mode", "none");
        mainHandler.post(() -> {
            if (player != null) {
                player.setRepeatMode("one".equals(mode) ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        mainHandler.post(() -> {
            player.play();
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        mainHandler.post(() -> {
            player.pause();
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        mainHandler.post(() -> {
            player.stop();
            player.clearMediaItems();
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        long position = optLong(call, "position", 0L);
        mainHandler.post(() -> {
            // 歌曲播完停在末尾后拖动：ExoPlayer 不会自动恢复播放，主动续播
            boolean wasEnded = player.getPlaybackState() == Player.STATE_ENDED;
            player.seekTo(position);
            if (wasEnded) player.play();
            Log.i(TAG, "seekTo=" + position + (wasEnded ? " (ended->resume)" : ""));
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        float vol = optFloat(call, "volume", 1.0f);
        volume = Math.max(0, Math.min(1, vol));
        mainHandler.post(() -> {
            player.setVolume(volume);
            call.resolve();
        });
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        float s = optFloat(call, "speed", 1.0f);
        speed = Math.max(0.5f, Math.min(2.0f, s));
        applyPlaybackParameters();
        call.resolve();
    }

    @PluginMethod
    public void setPitch(PluginCall call) {
        // ExoPlayer 不支持独立于速度的音高偏移，由 setSpeed 统一处理
        call.resolve();
    }

    @PluginMethod
    public void setPitchSync(PluginCall call) {
        pitchSync = call.getBoolean("enabled", true);
        applyPlaybackParameters();
        call.resolve();
    }

    private void applyPlaybackParameters() {
        float pitch = pitchSync ? 1.0f : speed;
        mainHandler.post(() -> {
            player.setPlaybackParameters(new PlaybackParameters(speed, pitch));
        });
    }

    @PluginMethod
    public void setFadeDuration(PluginCall call) {
        fadeMs = (int) optLong(call, "duration", 200L);
        call.resolve();
    }

    @PluginMethod
    public void setEqualizerEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        // 回写字段：IDLE 释放后 initAudioEffects 重建时回灌，否则开关静默丢失
        equalizerEnabled = enabled;
        mainHandler.post(() -> {
            if (equalizer != null) {
                equalizer.setEnabled(enabled);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setEqualizerBands(PluginCall call) {
        JSONArray gains = call.getArray("bands");
        mainHandler.post(() -> {
            // 缓存档位（IDLE 时 equalizer == null，等 initAudioEffects 重建后回灌）
            if (gains != null) {
                equalizerBands = new float[gains.length()];
                for (int i = 0; i < gains.length(); i++) {
                    try { equalizerBands[i] = (float) gains.getDouble(i); } catch (Exception ignored) {}
                }
            }
            applyEqualizerBands();
            call.resolve();
        });
    }

    /** 将缓存的均衡器档位应用到已创建的 Equalizer */
    private void applyEqualizerBands() {
        if (equalizer == null || equalizerBands == null) return;
        short[] range = equalizer.getBandLevelRange();
        short min = range[0];
        short max = range[1];
        int numBands = Math.min(equalizer.getNumberOfBands(), equalizerBands.length);
        for (int i = 0; i < numBands; i++) {
            int minVal = min;
            int maxVal = max;
            short level = (short) Math.max(minVal, Math.min(maxVal, (int) (equalizerBands[i] * 100)));
            equalizer.setBandLevel((short) i, level);
        }
    }

    @PluginMethod
    public void setPreampGain(PluginCall call) {
        // ExoPlayer 无前级增益，由均衡器统一处理
        call.resolve();
    }

    @PluginMethod
    public void setNormalizationEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        mainHandler.post(() -> {
            normalizationEnabled = enabled;
            if (loudnessEnhancer != null) {
                loudnessEnhancer.setEnabled(enabled);
                if (enabled) {
                    try {
                        loudnessEnhancer.setTargetGain(0);
                    } catch (Exception ignored) {}
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setFftEnabled(PluginCall call) {
        fftEnabled = call.getBoolean("enabled", false);
        mainHandler.post(() -> {
            if (fftEnabled && isPlaying) {
                initVisualizer();
            } else {
                releaseVisualizer();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void getFftData(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ldata", new JSONArray());
        ret.put("rdata", new JSONArray());
        call.resolve(ret);
    }

    @PluginMethod
    public void getOutputDevices(PluginCall call) {
        JSObject ret = new JSObject();
        JSONArray devices = new JSONArray();
        JSObject defaultDevice = new JSObject();
        defaultDevice.put("id", "android-default");
        defaultDevice.put("name", "Android 默认输出");
        defaultDevice.put("isDefault", true);
        devices.put(defaultDevice);
        ret.put("devices", devices);
        call.resolve(ret);
    }

    @PluginMethod
    public void setOutputDevice(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("state", isPlaying ? "playing" : "paused");
        ret.put("position", currentPosition);
        ret.put("duration", currentDuration > 0 ? currentDuration : 0);
        ret.put("volume", volume);
        ret.put("speed", speed);
        mainHandler.post(() -> {
            ret.put("isFinished", player != null && player.getPlaybackState() == Player.STATE_ENDED);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void setPauseOnDeviceSwitch(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", true);
        // 拔出设备暂停由 ExoPlayer handleAudioBecomingNoisy 承担
        mainHandler.post(() -> {
            player.setHandleAudioBecomingNoisy(enabled);
            call.resolve();
        });
    }

    // Audio effects init/release
    private void initAudioEffects() {
        if (effectsAttached) return;
        effectsAttached = true;
        int audioSessionId = player.getAudioSessionId();
        if (audioSessionId == 0) return;
        try {
            equalizer = new Equalizer(0, audioSessionId);
        } catch (Exception ignored) {}
        try {
            bassBoost = new BassBoost(0, audioSessionId);
            bassBoost.setEnabled(false);
        } catch (Exception ignored) {}
        try {
            virtualizer = new Virtualizer(0, audioSessionId);
            virtualizer.setEnabled(false);
        } catch (Exception ignored) {}
        try {
            loudnessEnhancer = new LoudnessEnhancer(audioSessionId);
        } catch (Exception ignored) {}
        // 回灌启动时缓存的均衡器/响度归一化状态（启动时 equalizer 还是 null，JS 下发被静默丢弃）
        if (equalizer != null) {
            applyEqualizerBands();
            equalizer.setEnabled(equalizerEnabled);
        }
        if (loudnessEnhancer != null) {
            loudnessEnhancer.setEnabled(normalizationEnabled);
            if (normalizationEnabled) {
                try { loudnessEnhancer.setTargetGain(0); } catch (Exception ignored) {}
            }
        }
    }

    private void releaseAudioEffects() {
        if (!effectsAttached) return;
        effectsAttached = false;
        if (equalizer != null) { equalizer.release(); equalizer = null; }
        if (bassBoost != null) { bassBoost.release(); bassBoost = null; }
        if (virtualizer != null) { virtualizer.release(); virtualizer = null; }
        if (loudnessEnhancer != null) { loudnessEnhancer.release(); loudnessEnhancer = null; }
        releaseVisualizer();
    }

    // Visualizer
    private void initVisualizer() {
        if (visualizer != null || !fftEnabled) return;
        int audioSessionId = player.getAudioSessionId();
        if (audioSessionId == 0) return;
        try {
            visualizer = new android.media.audiofx.Visualizer(audioSessionId);
            visualizer.setCaptureSize(android.media.audiofx.Visualizer.getCaptureSizeRange()[1]);
            visualizer.setDataCaptureListener(
                    new android.media.audiofx.Visualizer.OnDataCaptureListener() {
                        @Override
                        public void onWaveFormDataCapture(android.media.audiofx.Visualizer v, byte[] waveform, int samplingRate) {}
                        @Override
                        public void onFftDataCapture(android.media.audiofx.Visualizer v, byte[] fft, int samplingRate) {
                            if (!fftEnabled) return;
                            JSObject data = new JSObject();
                            int bins = Math.min(FFT_BINS, fft.length / 2);
                            JSONArray ldata = new JSONArray();
                            try {
                                for (int i = 0; i < bins; i++) {
                                    int re = fft[2 * i] & 0xFF;
                                    int im = fft[2 * i + 1] & 0xFF;
                                    ldata.put((re + im) / 512.0);
                                }
                            } catch (org.json.JSONException ignored) {
                                return;
                            }
                            data.put("ldata", ldata);
                            data.put("rdata", ldata);
                            emitEvent("fftData", data);
                        }
                    },
                    android.media.audiofx.Visualizer.getMaxCaptureRate() / 2,
                    false,
                    true);
            visualizer.setEnabled(true);
        } catch (Exception e) {
            Log.w(TAG, "visualizer init failed", e);
            if (visualizer != null) { visualizer.release(); visualizer = null; }
        }
    }

    private void releaseVisualizer() {
        if (visualizer != null) {
            visualizer.setEnabled(false);
            visualizer.release();
            visualizer = null;
        }
    }

    private void emitEvent(String type, JSObject data) {
        JSObject event = new JSObject();
        event.put("type", type);
        if (data != null) event.put("data", data);
        notifyListeners("event", event);
    }

    @Override
    public void handleOnDestroy() {
        // 生命周期回调在主线程执行，直接释放满足 ExoPlayer 线程约束
        if (player != null) {
            player.release();
            player = null;
        }
        releaseAudioEffects();
        releaseVisualizer();
        releaseSwitchWakeLock();
        mainHandler.removeCallbacksAndMessages(null);
        super.handleOnDestroy();
    }

    /** 曲目结束后短期持锁，保护 JS 切歌决策链不被 CPU 休眠打断 */
    private void acquireSwitchWakeLock() {
        try {
            if (switchWakeLock == null) {
                android.os.PowerManager pm =
                        (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                switchWakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "SPlayer::TrackSwitch");
                switchWakeLock.setReferenceCounted(false);
            }
            if (!switchWakeLock.isHeld()) switchWakeLock.acquire(30_000L);
        } catch (Exception e) {
            Log.w(TAG, "switch wake lock acquire failed", e);
        }
    }

    /** 新曲开播后交还给 WAKE_MODE_LOCAL */
    private void releaseSwitchWakeLock() {
        if (switchWakeLock != null && switchWakeLock.isHeld()) switchWakeLock.release();
    }

    /** JS 切歌决策中续借唤醒窗口（锁屏下下一首解析走网络，30 秒可能不够） */
    @PluginMethod
    public void extendSwitchWindow(PluginCall call) {
        acquireSwitchWakeLock();
        call.resolve();
    }

    static AudioEnginePlugin getInstance() {
        return sInstance;
    }
}
