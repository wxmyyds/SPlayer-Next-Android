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
import { registerPlugin, WebPlugin } from "@capacitor/core";

/** 原生系统播放桥（MediaSessionPlugin）：元数据/状态下发 + 通知栏反控事件 */
interface MediaBridgePlugin {
  updateState: (options: {
    title?: string;
    artist?: string;
    album?: string;
    artworkUrl?: string;
    playing?: boolean;
    positionMs?: number;
    durationMs?: number;
    stopped?: boolean;
  }) => Promise<void>;
  addListener: (
    event: "mediaKey",
    callback: (payload: { action: string; position: number }) => void,
  ) => Promise<{ remove: () => void }>;
}

/** 非原生环境回退：空实现（开发/测试用） */
class MediaBridgeWeb extends WebPlugin implements MediaBridgePlugin {
  async updateState(): Promise<void> {}
}

const MediaBridge = registerPlugin<MediaBridgePlugin>("MediaBridge", {
  web: () => new MediaBridgeWeb(),
});

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
let mediaBridgeWired = false;

/** 系统播放桥接线：通知栏/锁屏反控 → 触发同名播放事件（渲染层零改动） */
const wireMediaBridge = (): void => {
  if (mediaBridgeWired) return;
  mediaBridgeWired = true;
  try {
    const addListener = (MediaBridge as Partial<MediaBridgePlugin>).addListener;
    void addListener?.call(MediaBridge, "mediaKey", (payload) => {
      const action = payload.action;
      if (action === "play") emit({ type: "play" });
      else if (action === "pause") emit({ type: "pause" });
      else if (action === "next") emit({ type: "next" });
      else if (action === "prev") emit({ type: "prev" });
      else if (action === "seekto" && typeof payload.position === "number" && audio) {
        audio.currentTime = Math.max(0, payload.position / 1000);
      }
    });
  } catch {
    // 不支持则静默跳过，播放本身不受影响
  }
};

/** 推送曲目元数据到系统（标题/歌手/专辑/封面） */
const publishMetadata = (meta?: { title?: string; artists?: Array<{ name?: string }>; album?: { name?: string }; cover?: string; coverOriginal?: string }): void => {
  wireMediaBridge();
  try {
    void MediaBridge.updateState({
      title: meta?.title ?? "",
      artist: (meta?.artists ?? []).map((a) => a.name).filter(Boolean).join(" / "),
      album: meta?.album?.name ?? "",
      artworkUrl: meta?.coverOriginal ?? meta?.cover,
    });
  } catch {
    // 忽略
  }
};

/** 同步播放状态与进度到系统 */
const publishState = (state: "playing" | "paused" | "none", positionMs?: number, durationMs?: number): void => {
  try {
    void MediaBridge.updateState({
      playing: state === "playing",
      positionMs,
      durationMs,
      stopped: state === "none" || undefined,
    });
  } catch {
    // 忽略
  }
};

const getAudio = (): HTMLAudioElement => {
  if (!audio) {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("play", () => {
      publishState("playing");
      emit({ type: "play" });
    });
    el.addEventListener("pause", () => {
      publishState("paused");
      emit({ type: "pause" });
    });
    el.addEventListener("ended", () => {
      publishState("none");
      emit({ type: "ended" });
    });
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
      const position = Math.round(el.currentTime * 1000);
      publishState(el.paused ? "paused" : "playing", position, duration);
      emit({
        type: "position",
        data: { position, duration },
      });
    });
    wireMediaBridge();
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
    publishMetadata(options?.meta as Parameters<typeof publishMetadata>[0]);
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
    publishMetadata(undefined);
    publishState("none");
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
