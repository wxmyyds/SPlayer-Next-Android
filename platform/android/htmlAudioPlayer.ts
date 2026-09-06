/**
 * HTMLAudio 过渡播放器（Android 版）
 *
 * 上游 dev 用 Rust audio-engine 播 URL；Android 的 Rust .so + 前台 Service +
 * MediaSession 落地前，先用 Web Audio 元素实现可听的播放闭环：
 * song_url 解析出的 http(s) 地址 → load → play，事件形状与桌面一致，
 * 后续替换为原生引擎时渲染层零改动。
 */

import type {
  IpcResponse,
  LoadOptions,
  PlayerApi,
  PlayerEvent,
  PlayerStatus,
} from "@shared/types/player";

const ok = <T,>(data?: T): IpcResponse<T> => ({
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

let audio: HTMLAudioElement | null = null;
let lastPositionPush = 0;

const getAudio = (): HTMLAudioElement => {
  if (!audio) {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("play", () => emit({ type: "play" }));
    el.addEventListener("pause", () => emit({ type: "pause" }));
    el.addEventListener("ended", () => emit({ type: "ended" }));
    el.addEventListener("error", () => {
      // 错误码进 logcat（adb 抓 console），定位断点用；事件形状保持与桌面一致
      console.warn(
        `[player] audio error code=${el.error?.code ?? -1} src=${el.src}`,
      );
      emit({ type: "sourceError" });
    });
    el.addEventListener("seeked", () =>
      emit({ type: "seek", data: { position: Math.round(el.currentTime * 1000) } }),
    );
    el.addEventListener("timeupdate", () => {
      const now = Date.now();
      if (now - lastPositionPush < 200) return;
      lastPositionPush = now;
      const duration = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
      emit({
        type: "position",
        data: { position: Math.round(el.currentTime * 1000), duration },
      });
    });
    try {
      const saved = localStorage.getItem("splayer.android.player.volume");
      if (saved !== null) el.volume = Math.min(1, Math.max(0, Number(saved) || 0));
    } catch {
      // 忽略存储异常
    }
    audio = el;
  }
  return audio;
};

const snapshot = (): PlayerStatus => {
  const el = audio;
  return {
    state: !el || el.ended ? "idle" : el.paused ? (el.currentTime > 0 ? "paused" : "idle") : "playing",
    position: el ? Math.round(el.currentTime * 1000) : 0,
    duration: el && Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0,
    volume: el ? el.volume : 1,
    speed: 1,
    isFinished: el ? el.ended : false,
  };
};

/** HTMLAudio 播放器：实现 PlayerApi，引擎专属能力暂为无操作 */
export const htmlAudioPlayer: PlayerApi = {
  load: async (source: string, options?: LoadOptions) => {
    if (!/^https?:\/\//i.test(source)) return fail("unsupported source");
    const el = getAudio();
    el.src = source;
    if (options?.autoPlay !== false) {
      try {
        await el.play();
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    const duration = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0;
    return ok({
      detail: {
        quality: { sampleRate: 0, channels: 0, bitsPerSample: 0, bitRate: 0, codec: "" },
        externalLyrics: [],
      },
      mediaInfo: { duration },
    });
  },
  play: async () => {
    try {
      await getAudio().play();
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  pause: async () => {
    getAudio().pause();
    return ok();
  },
  stop: async () => {
    const el = getAudio();
    el.pause();
    el.removeAttribute("src");
    el.load();
    return ok();
  },
  seek: async (positionMs: number) => {
    getAudio().currentTime = Math.max(0, positionMs / 1000);
    return ok();
  },
  setVolume: async (volume: number) => {
    const v = Math.min(1, Math.max(0, volume));
    getAudio().volume = v;
    try {
      localStorage.setItem("splayer.android.player.volume", String(v));
    } catch {
      // 忽略存储异常
    }
    return ok();
  },
  setPauseOnDeviceSwitch: async () => ok(),
  getVolume: async () => ok(getAudio().volume),
  getStatus: async () => ok(snapshot()),
  setFftEnabled: async () => ok(),
  getFftData: async () => ok({ ldata: [], rdata: [] }),
  setFadeDuration: async () => ok(),
  getFadeDuration: async () => ok(0),
  getCoverRaw: async () => ok(null),
  readLyricFile: async () => fail("unsupported"),
  reinit: async () => ok(),
  setNormalizationEnabled: async () => ok(),
  setEqualizerEnabled: async () => ok(),
  setEqualizerBands: async () => ok(),
  setPreampGain: async () => ok(),
  setSpeed: async () => ok(),
  setPitch: async () => ok(),
  setPitchSync: async () => ok(),
  getOutputDevices: async () =>
    ok([{ id: "android-default", name: "Android 默认输出", isDefault: true }]),
  getDefaultDeviceName: async () => ok("Android 默认输出"),
  setOutputDevice: async () => ok(),
  getSelectedDeviceName: async () => ok("Android 默认输出"),
  syncPlayMode: () => {},
  syncLikeState: () => {},
  dispatch: () => {},
  onEvent: (callback: (event: PlayerEvent) => void) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  },
};
