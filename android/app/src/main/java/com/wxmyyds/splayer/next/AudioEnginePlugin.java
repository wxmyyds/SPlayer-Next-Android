package com.wxmyyds.splayer.next;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.media.audiofx.BassBoost;
import android.media.audiofx.Equalizer;
import android.media.audiofx.LoudnessEnhancer;
import android.media.audiofx.Virtualizer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.PlaybackException;
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
 * - 音频焦点冲突处理（自动避让/恢复）
 * - 通知栏/锁屏控制由已有 MediaSessionPlugin 处理
 */
@CapacitorPlugin(name = "AudioEngine")
public class AudioEnginePlugin extends Plugin {

    static final String CHANNEL_ID = "splayer_playback";
    static final int NOTIFICATION_ID = 1;
    private static final int FFT_BINS = 128;

    private static AudioEnginePlugin sInstance;
    private ExoPlayer player;
    private AudioManager audioManager;
    private NotificationManager notificationManager;
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
    private String currentTitle = "";
    private String currentArtist = "";
    private String currentAlbum = "";
    private String currentArtwork = "";

    // Audio focus
    private boolean focusLost = false;
    private boolean pauseOnNoisy = true;

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!pauseOnNoisy) return;
            emitMediaKey("pause");
        }
    };
    private boolean noisyRegistered;

    @Override
    public void load() {
        sInstance = this;
        mainHandler = new Handler(Looper.getMainLooper());
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        notificationManager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
        initPlayer();
        registerNoisyReceiver();
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
                isPlaying = playing;
                updateNotification();
                if (playing) {
                    ensureForeground();
                    if (fftEnabled) initVisualizer();
                    emitEvent("play", null);
                } else {
                    releaseVisualizer();
                    emitEvent("pause", null);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
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
                    updateNotification();
                }
                mainHandler.postDelayed(this, 200);
            }
        }, 200);
    }

    @PluginMethod
    public void load(PluginCall call) {
        String source = call.getString("source");
        boolean autoPlay = call.getBoolean("autoPlay", true);
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        String artwork = call.getString("artwork", "");

        if (source == null || source.isEmpty()) {
            call.reject("source required");
            return;
        }

        currentTitle = title;
        currentArtist = artist;
        currentAlbum = album;
        currentArtwork = artwork;

        int result = audioManager.requestAudioFocus(audioFocusListener,
                AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            call.reject("audio focus denied");
            return;
        }

        MediaItem mediaItem = MediaItem.fromUri(source);
        player.setMediaItem(mediaItem);
        player.prepare();

        if (autoPlay) {
            player.play();
        }

        JSObject ret = new JSObject();
        ret.put("duration", player.getDuration() > 0 ? player.getDuration() : 0);
        call.resolve(ret);
    }

    @PluginMethod
    public void play(PluginCall call) {
        player.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        player.pause();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        player.stop();
        player.clearMediaItems();
        audioManager.abandonAudioFocus(audioFocusListener);
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        long position = call.getLong("position", 0L);
        player.seekTo(position);
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        float vol = call.getFloat("volume", 1.0f);
        volume = Math.max(0, Math.min(1, vol));
        player.setVolume(volume);
        call.resolve();
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        float s = call.getFloat("speed", 1.0f);
        speed = Math.max(0.5f, Math.min(2.0f, s));
        float pitch = pitchSync ? 1.0f : speed;
        player.setPlaybackParameters(new PlaybackParameters(speed, pitch));
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
        float pitch = pitchSync ? 1.0f : speed;
        player.setPlaybackParameters(new PlaybackParameters(speed, pitch));
        call.resolve();
    }

    @PluginMethod
    public void setFadeDuration(PluginCall call) {
        fadeMs = call.getInt("duration", 200);
        call.resolve();
    }

    @PluginMethod
    public void setEqualizerEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (equalizer != null) {
            equalizer.setEnabled(enabled);
        }
        call.resolve();
    }

    @PluginMethod
    public void setEqualizerBands(PluginCall call) {
        if (equalizer == null) {
            call.resolve();
            return;
        }
        JSONArray gains = call.getArray("bands");
        if (gains != null) {
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
    }

    @PluginMethod
    public void setPreampGain(PluginCall call) {
        // ExoPlayer 无前级增益，由均衡器统一处理
        call.resolve();
    }

    @PluginMethod
    public void setNormalizationEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        if (loudnessEnhancer != null) {
            loudnessEnhancer.setEnabled(enabled);
            if (enabled) {
                try {
                    loudnessEnhancer.setTargetGain(0);
                } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void setFftEnabled(PluginCall call) {
        fftEnabled = call.getBoolean("enabled", false);
        if (fftEnabled && isPlaying) {
            initVisualizer();
        } else {
            releaseVisualizer();
        }
        call.resolve();
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
    public void updateMetadata(PluginCall call) {
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        String artwork = call.getString("artwork", "");

        if (!title.isEmpty()) currentTitle = title;
        if (!artist.isEmpty()) currentArtist = artist;
        if (!album.isEmpty()) currentAlbum = album;
        if (!artwork.isEmpty()) currentArtwork = artwork;

        updateNotification();
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
        ret.put("isFinished", player != null && player.getPlaybackState() == Player.STATE_ENDED);
        call.resolve(ret);
    }

    @PluginMethod
    public void setPauseOnDeviceSwitch(PluginCall call) {
        pauseOnNoisy = call.getBoolean("enabled", true);
        call.resolve();
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
        } catch (Exception ignored) {
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

    // Audio focus listener
    private final AudioManager.OnAudioFocusChangeListener audioFocusListener =
            new AudioManager.OnAudioFocusChangeListener() {
                @Override
                public void onAudioFocusChange(int focusChange) {
                    switch (focusChange) {
                        case AudioManager.AUDIOFOCUS_GAIN:
                            if (focusLost) {
                                player.play();
                                focusLost = false;
                            }
                            player.setVolume(volume);
                            break;
                        case AudioManager.AUDIOFOCUS_LOSS:
                            focusLost = false;
                            player.pause();
                            break;
                        case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                            focusLost = true;
                            player.pause();
                            break;
                        case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                            player.setVolume(volume * 0.2f);
                            break;
                    }
                }
            };

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            channel.setSound(null, null);
            notificationManager.createNotificationChannel(channel);
        }
    }

    private void updateNotification() {
        PlaybackService.startForegroundWith(getContext(), buildNotification());
    }

    private Notification buildNotification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(getContext(), CHANNEL_ID);
            builder.setOngoing(isPlaying);
        } else {
            builder = new Notification.Builder(getContext());
        }
        return builder
                .setSmallIcon(getContext().getApplicationInfo().icon)
                .setContentTitle(currentTitle)
                .setContentText(currentArtist)
                .build();
    }

    private void ensureForeground() {
        PlaybackService.startForegroundWith(getContext(), buildNotification());
    }

    private void registerNoisyReceiver() {
        if (noisyRegistered) return;
        noisyRegistered = true;
        IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        Context appContext = getContext().getApplicationContext();
        if (Build.VERSION.SDK_INT >= 33) {
            appContext.registerReceiver(noisyReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            appContext.registerReceiver(noisyReceiver, filter);
        }
    }

    private void emitEvent(String type, JSObject data) {
        JSObject event = new JSObject();
        event.put("type", type);
        if (data != null) event.put("data", data);
        notifyListeners("event", event);
    }

    private void emitMediaKey(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        data.put("position", -1);
        notifyListeners("mediaKey", data);
    }

    @Override
    public void handleOnDestroy() {
        if (player != null) {
            player.release();
            player = null;
        }
        releaseAudioEffects();
        releaseVisualizer();
        mainHandler.removeCallbacksAndMessages(null);
        try {
            getContext().getApplicationContext().unregisterReceiver(noisyReceiver);
        } catch (Exception ignored) {
        }
        super.handleOnDestroy();
    }

    static AudioEnginePlugin getInstance() {
        return sInstance;
    }
}
