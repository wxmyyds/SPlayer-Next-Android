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

import type {
  AudioDevice,
  FftData,
  IpcResponse,
  LoadOptions,
  LoadResult,
  PlayerApi,
  PlayerEvent,
  PlayerStatus,
} from "@shared/types/player";
import { registerPlugin } from "@capacitor/core";

/** 原生音频引擎插件接口 */
interface AudioEnginePlugin {
  load(options: {
    source: string;
    autoPlay?: boolean;
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
  getFftData(): Promise<FftData>;
  getOutputDevices(): Promise<{ devices: AudioDevice[] }>;
  setOutputDevice(options: { deviceId: string }): Promise<void>;
  updateMetadata(options: {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: string;
  }): Promise<void>;
  getStatus(): Promise<PlayerStatus>;
  setPauseOnDeviceSwitch(options: { enabled: boolean }): Promise<void>;
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

/** 将原生事件映射为桌面 PlayerEvent */
const mapNativeEvent = (payload: { type: string; data?: any }): PlayerEvent | null => {
  switch (payload.type) {
    case "play":
      return { type: "play" };
    case "pause":
      return { type: "pause" };
    case "ended":
      return { type: "ended" };
    case "sourceError":
      return { type: "sourceError" };
    case "position":
      return {
        type: "position",
        data: { position: payload.data.position, duration: payload.data.duration },
      };
    case "ready":
    case "buffering":
      return null;
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
    const event = mapNativeEvent(payload as { type: string; data?: any });
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
      emit({ type: "seek", data: { position: data.position } });
    }
  });
};

/** 原生音频引擎：实现 PlayerApi */
export const nativeAudioPlayer: PlayerApi = {
  load: async (source: string, options?: LoadOptions) => {
    try {
      wireEngine();
      const result = await AudioEngine.load({
        source,
        autoPlay: options?.autoPlay,
        title: options?.meta?.title,
        artist: options?.meta?.artists?.map((a) => a.name).filter(Boolean).join(" / "),
        album: options?.meta?.album?.name,
        artwork: options?.meta?.coverOriginal ?? options?.meta?.cover,
      });
      return ok({
        detail: {
          quality: { sampleRate: 0, channels: 0, bitsPerSample: 0, bitRate: 0, codec: "" },
          externalLyrics: [],
        },
        mediaInfo: { duration: result.duration },
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  play: async () => {
    try {
      await AudioEngine.play();
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  pause: async () => {
    try {
      await AudioEngine.pause();
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  stop: async () => {
    try {
      await AudioEngine.stop();
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  seek: async (positionMs: number) => {
    try {
      await AudioEngine.seek({ position: positionMs });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setVolume: async (volume: number) => {
    try {
      await AudioEngine.setVolume({ volume });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setPauseOnDeviceSwitch: async (enabled: boolean) => {
    try {
      await AudioEngine.setPauseOnDeviceSwitch({ enabled });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
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
  setFftEnabled: async (enabled: boolean) => {
    try {
      await AudioEngine.setFftEnabled({ enabled });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  getFftData: async () => {
    try {
      const data = await AudioEngine.getFftData();
      return ok(data);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setFadeDuration: async (ms: number) => {
    try {
      await AudioEngine.setFadeDuration({ duration: ms });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  getFadeDuration: async () => ok(200),
  getCoverRaw: async () => ok(null),
  readLyricFile: async () => fail("unsupported"),
  reinit: async () => ok(),
  setNormalizationEnabled: async (enabled: boolean) => {
    try {
      // LoudnessEnhancer 由原生插件管理
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setEqualizerEnabled: async (enabled: boolean) => {
    try {
      await AudioEngine.setEqualizerEnabled({ enabled });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setEqualizerBands: async (gainsDb: number[]) => {
    try {
      await AudioEngine.setEqualizerBands({ bands: gainsDb });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setPreampGain: async (preampDb: number) => {
    try {
      await AudioEngine.setPreampGain({ gainDb: preampDb });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setSpeed: async (speed: number) => {
    try {
      await AudioEngine.setSpeed({ speed });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setPitch: async (semitones: number) => {
    try {
      await AudioEngine.setPitch({ semitones });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  setPitchSync: async (sync: boolean) => {
    try {
      await AudioEngine.setPitchSync({ enabled: sync });
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
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
