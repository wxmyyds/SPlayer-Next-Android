package com.wxmyyds.splayer.next;

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
import org.json.JSONArray;

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

    // Visualizer
    private android.media.audiofx.Visualizer visualizer;
    private boolean fftEnabled = false;

    // State
    private boolean isPlaying = false;
    private long currentPosition = 0;
    private long currentDuration = 0;
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
                    if (fftEnabled) initVisualizer();
                    emitEvent("play", null);
                } else {
                    releaseVisualizer();
                    emitEvent("pause", null);
                }
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
        });
        startPositionUpdates();
    }

    private void startPositionUpdates() {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (player != null && isPlaying) {
                    currentPosition = player.getCurrentPosition();
                    currentDuration = player.getDuration();
                    JSObject data = new JSObject();
                    data.put("position", currentPosition);
                    data.put("duration", currentDuration > 0 ? currentDuration : 0);
                    emitEvent("position", data);
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
        MediaItem mediaItem = MediaItem.fromUri(source);
        mainHandler.post(() -> {
            player.setMediaItem(mediaItem);
            player.prepare();
            if (autoPlay) player.play();
            JSObject ret = new JSObject();
            ret.put("duration", player.getDuration() > 0 ? player.getDuration() : 0);
            call.resolve(ret);
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
            if (equalizer != null && gains != null) {
                int numBands = equalizer.getNumberOfBands();
                short[] range = equalizer.getBandLevelRange();
                short min = range[0];
                short max = range[1];
                for (int i = 0; i < numBands; i++) {
                    try {
                        double gain = gains.getDouble(i);
                        int minVal = min;
                        int maxVal = max;
                        short level = (short) Math.max(minVal, Math.min(maxVal, (int) (gain * 100)));
                        equalizer.setBandLevel((short) i, level);
                    } catch (Exception ignored) {}
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setPreampGain(PluginCall call) {
        // ExoPlayer 无前级增益，由均衡器统一处理
        call.resolve();
    }

    @PluginMethod
    public void setNormalizationEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        mainHandler.post(() -> {
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
            equalizer.setEnabled(false);
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
            loudnessEnhancer.setEnabled(false);
        } catch (Exception ignored) {}
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
        mainHandler.removeCallbacksAndMessages(null);
        super.handleOnDestroy();
    }

    static AudioEnginePlugin getInstance() {
        return sInstance;
    }
}
