/**
 * 原生音频引擎 JS 包装层（Android 版）
 *
 * 用 Media3 ExoPlayer 替代 HTMLAudio：
 * - 后台播放可靠（原生音频不走 WebView，不受 freezer 影响）
 * - 均衡器/低音/虚拟器/响度增强（framework AudioEffect）
 * - 变速变调（ExoPlayer PlaybackParameters）
 * - 实时频谱（Visualizer，无 CORS 限制）
 * - 音频焦点冲突处理（自动避让/恢复）
 *
 * 接口形状与桌面 Rust audio-engine 一致，渲染层零改动。
 */

import type { PluginListenerHandle } from "@capacitor/core";
import type {
  AudioDevice,
  IpcResponse,
  LoadOptions,
  PlayerApi,
  PlayerEvent,
  PlayerStatus,
} from "@shared/types/player";
import { registerPlugin, WebPlugin } from "@capacitor/core";

/** 系统播放桥（MediaSessionPlugin）：元数据/状态下发 + 通知栏反控事件 */
interface MediaBridgePlugin {
  updateState: (options: {
    title?: string;
    artist?: string;
    album?: string;
    artworkUrl?: string;
    playing?: boolean;
    positionMs?: number;
    durationMs?: number;
    /** 播放速率：锁屏媒体卡片按它外推进度（缺省按 1x） */
    speed?: number;
    stopped?: boolean;
  }) => Promise<void>;
}

/** 系统栏沉浸插件（SystemUiPlugin）：隐藏状态栏/导航小白条 + 系统深浅色读取 */
interface SystemUiBridgePlugin {
  setImmersive: (options: { enabled: boolean }) => Promise<void>;
  setLightBars: (options: { light: boolean }) => Promise<void>;
  openUrl: (options: { url: string }) => Promise<void>;
  getSystemTheme: () => Promise<{ dark: boolean }>;
  addListener(
    eventName: "systemThemeChanged",
    listenerFunc: (data: { dark: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

class SystemUiWeb extends WebPlugin implements SystemUiBridgePlugin {
  async setImmersive(): Promise<void> {}
  async setLightBars(): Promise<void> {}
  async openUrl(): Promise<void> {}
  async getSystemTheme(): Promise<{ dark: boolean }> {
    return { dark: window.matchMedia("(prefers-color-scheme: dark)").matches };
  }
}

/** 供 bridge.ts 的 system.setImmersive 消费 */
export const SystemUi = registerPlugin<SystemUiBridgePlugin>("SystemUi", {
  web: () => new SystemUiWeb(),
});

/** 非原生环境回退：空实现（开发/测试用） */
class MediaBridgeWeb extends WebPlugin implements MediaBridgePlugin {
  async updateState(): Promise<void> {}
}

const MediaBridge = registerPlugin<MediaBridgePlugin>("MediaBridge", {
  web: () => new MediaBridgeWeb(),
});

/** 原生音频引擎插件接口 */
interface AudioEnginePlugin {
  load(options: {
    source: string;
    autoPlay?: boolean;
    trackId?: string;
    title?: string;
    artist?: string;
    album?: string;
    artwork?: string;
  }): Promise<{ duration: number }>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  setSpeed(options: { speed: number }): Promise<void>;
  setPitch(options: { semitones: number }): Promise<void>;
  setPitchSync(options: { enabled: boolean }): Promise<void>;
  setFadeDuration(options: { duration: number }): Promise<void>;
  setEqualizerEnabled(options: { enabled: boolean }): Promise<void>;
  setEqualizerBands(options: { bands: number[] }): Promise<void>;
  setPreampGain(options: { gainDb: number }): Promise<void>;
  setFftEnabled(options: { enabled: boolean }): Promise<void>;
  getOutputDevices(): Promise<{ devices: AudioDevice[] }>;
  setOutputDevice(options: { deviceId: string }): Promise<void>;
  getStatus(): Promise<PlayerStatus>;
  setPauseOnDeviceSwitch(options: { enabled: boolean }): Promise<void>;
  extendSwitchWindow(): Promise<void>;
  setRepeatMode(options: { mode: string }): Promise<void>;
  setNextResources(options: {
    items: {
      trackId: string;
      playIndex: number;
      source: string;
      title: string;
      artist: string;
      album: string;
      artwork: string;
      durationMs: number;
    }[];
  }): Promise<void>;
  setNextQueue(options: {
    items: {
      trackId: string;
      songId: string;
      playIndex: number;
      level: string;
      title: string;
      artist: string;
      album: string;
      artwork: string;
      durationMs: number;
    }[];
    resolve: {
      cookie: string;
    };
  }): Promise<void>;
  clearNextResource(): Promise<void>;
  addListener(
    event: "event" | "mediaKey",
    callback: (payload: unknown) => void,
  ): Promise<{ remove: () => void }>;
}

const AudioEngine = registerPlugin<AudioEnginePlugin>("AudioEngine");

const ok = <T>(data?: T): IpcResponse<T> => ({
  success: true,
  ...(data === undefined ? {} : { data }),
});
const fail = (error: string): IpcResponse<never> => ({ success: false, error });

type Listener = (event: PlayerEvent) => void;

const listeners = new Set<Listener>();
const emit = (event: PlayerEvent): void => {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // 单个监听器异常不影响其他
    }
  }
};

/** 最近一次原生推送的位置/时长/播放态，作为系统媒体卡片的状态源 */
let lastPositionMs = 0;
let lastDurationMs = 0;
let enginePlaying = false;

/** 缓冲停滞看门狗：VIP/第三方源偶发只连接不出数据，ExoPlayer 持续 BUFFERING
 * 既无 position 推进也无 sourceError，UI 会冻在“播放中”。超时按源失效恢复（重载一次→跳曲）。 */
let lastAdvanceAt = 0;
let stallTimer: ReturnType<typeof setInterval> | null = null;
/** 判停滞时长（毫秒）：第三方源首包慢，留足余量 */
const STALL_TIMEOUT_MS = 15000;
const STALL_CHECK_MS = 5000;

/** 记录一次有效推进（load/开播/位置前进），刷新停滞起点 */
const noteStallProgress = (): void => {
  lastAdvanceAt = Date.now();
};

const stopStallWatchdog = (): void => {
  if (stallTimer) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
};

const ensureStallWatchdog = (): void => {
  noteStallProgress();
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    // 武装条件（播放中或 BUFFERING 重缓）由调用方保证；这里只看是否有推进
    if (Date.now() - lastAdvanceAt < STALL_TIMEOUT_MS) return;
    stopStallWatchdog();
    enginePlaying = false;
    emit({ type: "sourceError" });
  }, STALL_CHECK_MS);
};

/** 推送曲目元数据到系统（标题/歌手/专辑/封面） */
const publishMetadata = (meta?: LoadOptions["meta"]): void => {
  try {
    // .catch：桥异步 reject（如通知权限被拒）不会被 try/catch 捕获，未处理的 rejection 无人接
    void MediaBridge.updateState({
      title: meta?.title ?? "",
      artist: (meta?.artists ?? [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(" / "),
      album: meta?.album?.name ?? "",
      artworkUrl: meta?.coverOriginal ?? meta?.cover,
    }).catch(() => {});
  } catch {
    // 忽略
  }
};

/** 同步播放状态与进度到系统（MediaSession 据此渲染通知栏/锁屏卡片） */
const publishState = (
  state: "playing" | "paused" | "none",
  positionMs?: number,
  durationMs?: number,
  speed?: number,
): void => {
  try {
    void MediaBridge.updateState({
      playing: state === "playing",
      positionMs,
      durationMs,
      speed,
      stopped: state === "none" || undefined,
    }).catch(() => {});
  } catch {
    // 忽略
  }
};

/** 将原生事件映射为桌面 PlayerEvent */
const mapNativeEvent = (payload: { type: string; data?: any }): PlayerEvent | null => {
  switch (payload.type) {
    case "ended":
      return { type: "ended" };
    case "autoAdvanced":
      // 原生自治切歌（锁屏 WebView 冻结时）：JS 侧同步队列指针与界面，不重新 load
      return {
        type: "nativeAdvance",
        data: {
          trackId: String(payload.data?.trackId ?? ""),
          playIndex: Number(payload.data?.playIndex ?? -1),
          playing: payload.data?.playing !== false,
        },
      };
    case "requestNextUrl":
      // 原生补窗请求（对齐 SFA requestUrls）：AUTO 过渡后/窗口耗尽时提醒 JS 预载并重挂下一首
      return { type: "requestNextUrl" };
    case "sourceError":
      return { type: "sourceError" };
    case "position":
      return {
        type: "position",
        data: { position: payload.data.position, duration: payload.data.duration },
      };
    case "playingChanged": {
      // 引擎播放态快照：走 status 事件只同步 UI，不回射 play/pause 指令，
      // 否则 BUFFERING 瞬态会与原生互相拨动形成暂停/续播振荡环
      const playing = !!payload.data?.playing;
      enginePlaying = playing;
      return {
        type: "status",
        data: {
          state: playing ? "playing" : "paused",
          position: lastPositionMs,
          duration: lastDurationMs,
          volume: payload.data?.volume,
          speed: payload.data?.speed,
          isFinished: false,
        },
      };
    }
    case "ready":
    case "buffering":
      return null;
    case "fftData":
      return {
        type: "fftData",
        data: { ldata: payload.data?.ldata ?? [], rdata: payload.data?.rdata ?? [] },
      };
    default:
      return null;
  }
};

/** 原生事件接线 */
let engineWired = false;
const wireEngine = (): void => {
  if (engineWired) return;
  engineWired = true;
  void AudioEngine.addListener("event", (payload) => {
    const data = payload as { type: string; data?: any };
    switch (data.type) {
      case "ended":
        enginePlaying = false;
        stopStallWatchdog();
        publishState("paused", 0, lastDurationMs);
        // 锁屏下 CPU 休眠会把 JS 切歌决策链掐死在下一步网络请求上，先续借唤醒窗口
        void AudioEngine.extendSwitchWindow().catch(() => {});
        break;
      case "position":
        if (data.data.position > lastPositionMs) noteStallProgress();
        lastPositionMs = data.data.position;
        lastDurationMs = data.data.duration;
        publishState(enginePlaying ? "playing" : "paused", lastPositionMs, lastDurationMs);
        break;
      case "sourceError":
        enginePlaying = false;
        stopStallWatchdog();
        publishState("paused", lastPositionMs, lastDurationMs);
        break;
      case "playingChanged": {
        // 引擎播放态快照：同步媒体卡片，不回射指令（振荡环防护见 mapNativeEvent）。
        // BUFFERING 时 isPlaying=false 但 playWhenReady=true，看门狗须保持武装，
        // 否则重缓期间停表后无人重启，恰好在其要检测的卡流场景失效
        enginePlaying = !!data.data?.playing;
        if (enginePlaying || data.data?.playWhenReady) ensureStallWatchdog();
        else stopStallWatchdog();
        publishState(
          enginePlaying ? "playing" : "paused",
          lastPositionMs,
          lastDurationMs,
          typeof data.data?.speed === "number" ? data.data.speed : undefined,
        );
        break;
      }
    }
    const event = mapNativeEvent(data);
    if (event) emit(event);
  });
  void AudioEngine.addListener("mediaKey", (payload) => {
    const data = payload as { action: string; position: number };
    const action = data.action;
    if (action === "play") emit({ type: "play" });
    else if (action === "pause") emit({ type: "pause" });
    else if (action === "next") emit({ type: "next" });
    else if (action === "prev") emit({ type: "prev" });
    else if (action === "seekto" && typeof data.position === "number") {
      // 锁屏/通知栏拖动：只 markSeek 不调原生 seek 会让 seeking 永久悬挂、进度冻结
      emit({ type: "seek", data: { position: data.position } });
      void AudioEngine.seek({ position: data.position }).catch(() => {});
    }
  });
};

/** 纯转发：原生调用成功返回 ok，异常统一转 IpcResponse 失败（无本地状态时用） */
const forward = async (call: () => Promise<unknown>): Promise<IpcResponse<void>> => {
  try {
    await call();
    return ok();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
};

/** 原生音频引擎：实现 PlayerApi */
export const nativeAudioPlayer: PlayerApi = {
  load: async (source: string, options?: LoadOptions) => {
    try {
      wireEngine();
      publishMetadata(options?.meta);
      enginePlaying = !!options?.autoPlay;
      // 暂停加载无 position 推进，武装后必误报；播放开始时由 playingChanged 重新武装
      if (options?.autoPlay) ensureStallWatchdog();
      else stopStallWatchdog();
      lastPositionMs = 0;
      const result = await AudioEngine.load({
        source,
        autoPlay: options?.autoPlay,
        trackId: options?.meta?.id ?? "",
        title: options?.meta?.title,
        artist: options?.meta?.artists
          ?.map((a) => a.name)
          .filter(Boolean)
          .join(" / "),
        album: options?.meta?.album?.name,
        artwork: options?.meta?.coverOriginal ?? options?.meta?.cover,
      });
      lastDurationMs = result.duration > 0 ? result.duration : (options?.meta?.duration ?? 0);
      publishState(options?.autoPlay ? "playing" : "paused", 0, lastDurationMs);
      return ok({
        detail: {
          quality: { sampleRate: 0, channels: 0, bitsPerSample: 0, bitRate: 0, codec: "" },
          externalLyrics: [],
        },
        // 原生 prepare 异步，load 返回时 getDuration 恒 0；回退 Track 元数据时长，
        // 首个 position 事件（200ms 后）带真实 duration 再覆盖
        mediaInfo: { duration: lastDurationMs },
      });
    } catch (err) {
      enginePlaying = false;
      stopStallWatchdog();
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  play: () => forward(() => AudioEngine.play()),
  pause: async () => {
    try {
      await AudioEngine.pause();
      enginePlaying = false;
      // BUFFERING 中暂停不触发原生 playingChanged（isPlaying 本就 false），本地解除武装
      stopStallWatchdog();
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  stop: async () => {
    try {
      await AudioEngine.stop();
      enginePlaying = false;
      stopStallWatchdog();
      lastPositionMs = 0;
      lastDurationMs = 0;
      publishState("none");
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  seek: async (positionMs: number) => {
    try {
      await AudioEngine.seek({ position: positionMs });
      // 切到未缓冲区间会重新 BUFFERING，刷新停滞起点避免误判
      noteStallProgress();
      // 同步位置快照：原生仅在播放中推 position 事件，暂停时 seek 后必须本地更新
      // 否则媒体卡片/状态快照停留在旧位置
      lastPositionMs = positionMs;
      publishState(enginePlaying ? "playing" : "paused", lastPositionMs, lastDurationMs);
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setVolume: (volume: number) => forward(() => AudioEngine.setVolume({ volume })),
  setPauseOnDeviceSwitch: (enabled: boolean) =>
    forward(() => AudioEngine.setPauseOnDeviceSwitch({ enabled })),
  setNextResources: (options) => forward(() => AudioEngine.setNextResources(options)),
  setNextQueue: (options) => forward(() => AudioEngine.setNextQueue(options)),
  clearNextResource: () => forward(() => AudioEngine.clearNextResource()),
  setRepeatMode: (options) => forward(() => AudioEngine.setRepeatMode(options)),
  getVolume: async () => {
    try {
      const status = await AudioEngine.getStatus();
      return ok(status.volume);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  getStatus: async () => {
    try {
      const status = await AudioEngine.getStatus();
      return ok(status);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setFftEnabled: (enabled: boolean) => forward(() => AudioEngine.setFftEnabled({ enabled })),
  setFadeDuration: (ms: number) => forward(() => AudioEngine.setFadeDuration({ duration: ms })),
  getFadeDuration: async () => ok(200),
  getCoverRaw: async () => ok(null),
  readLyricFile: async () => fail("unsupported"),
  reinit: async () => ok(),
  // 响度归一化无独立实现（均衡器统一处理）
  setNormalizationEnabled: async () => ok(),
  setEqualizerEnabled: (enabled: boolean) =>
    forward(() => AudioEngine.setEqualizerEnabled({ enabled })),
  setEqualizerBands: (gainsDb: number[]) =>
    forward(() => AudioEngine.setEqualizerBands({ bands: gainsDb })),
  setPreampGain: (preampDb: number) =>
    forward(() => AudioEngine.setPreampGain({ gainDb: preampDb })),
  setSpeed: (speed: number) => forward(() => AudioEngine.setSpeed({ speed })),
  setPitch: (semitones: number) => forward(() => AudioEngine.setPitch({ semitones })),
  setPitchSync: (sync: boolean) => forward(() => AudioEngine.setPitchSync({ enabled: sync })),
  getOutputDevices: async () => {
    try {
      const result = await AudioEngine.getOutputDevices();
      return ok(result.devices);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  getDefaultDeviceName: async () => ok("Android 默认输出"),
  setOutputDevice: async () => ok(),
  getSelectedDeviceName: async () => ok("Android 默认输出"),
  syncPlayMode: () => {},
  syncLikeState: () => {},
  dispatch: () => {},
  onEvent: (callback: (event: PlayerEvent) => void) => {
    wireEngine();
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
