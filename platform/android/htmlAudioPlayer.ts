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

/** FFT：渲染层要 128 双通道事件（桌面引擎推送同款形状），Web Audio 分析器补齐 */
const FFT_BINS = 128;
let fftWanted = false;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let fftTimer: ReturnType<typeof setInterval> | null = null;

/** 音源是否允许跨域分析：无 CORS 头时建图会静音，先 Range 预检 */
const probeCors = async (source: string): Promise<boolean> => {
  try {
    const res = await fetch(source, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(2500),
    });
    const allow = res.headers.get("access-control-allow-origin");
    return !!allow;
  } catch {
    return false;
  }
};

/** 音频链：source → fadeGain → destination，频谱需要时 analyser 挂 fadeGain（只建一次） */
const ensureAudioGraph = async (el: HTMLAudioElement): Promise<boolean> => {
  if (mediaSource && fadeGain) return true;
  if (!el.src) return false;
  try {
    audioCtx ??= new AudioContext();
    await audioCtx.resume().catch(() => {});
    mediaSource = audioCtx.createMediaElementSource(el);
    fadeGain = audioCtx.createGain();
    fadeGain.gain.value = 1;
    mediaSource.connect(fadeGain);
    fadeGain.connect(audioCtx.destination);
    el.volume = userVolume;
    return true;
  } catch {
    mediaSource = null;
    fadeGain = null;
    return false;
  }
};

/** 为当前音频建分析图（仅 CORS 安全时；否则保持直出，频谱持平但不断声） */
const ensureFftGraph = async (el: HTMLAudioElement): Promise<void> => {
  if (analyser || !fftWanted || !el.src) return;
  if (!(await probeCors(el.src))) return;
  try {
    el.crossOrigin = "anonymous";
    // crossOrigin 需在 src 赋值前生效，改完重载一次
    const url = el.src;
    const position = el.currentTime;
    const wasPlaying = !el.paused;
    if (!(await ensureAudioGraph(el))) return;
    analyser = audioCtx!.createAnalyser();
    analyser.fftSize = FFT_BINS * 4;
    analyser.smoothingTimeConstant = 0.75;
    fadeGain!.connect(analyser);
    el.src = url;
    el.load();
    const restore = (): void => {
      el.removeEventListener("loadedmetadata", restore);
      if (Number.isFinite(position) && position > 0) {
        try {
          el.currentTime = position;
        } catch {
          // 忽略
        }
      }
      if (wasPlaying) void el.play().catch(() => {});
    };
    el.addEventListener("loadedmetadata", restore);
  } catch {
    analyser = null;
  }
};

const pushFftFrame = (): void => {
  const el = audio;
  if (!el || !analyser || el.paused) return;
  try {
    const raw = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(raw);
    // 256 bins 两两平均 → 128，与桌面引擎维度一致
    const ldata = new Array<number>(FFT_BINS);
    for (let i = 0; i < FFT_BINS; i++) {
      const a = raw[i * 2] ?? 0;
      const b = raw[i * 2 + 1] ?? 0;
      ldata[i] = (a + b) / 512;
    }
    emit({ type: "fftData", data: { ldata, rdata: [...ldata] } });
  } catch {
    // 忽略单帧异常
  }
};

const startFftLoop = (): void => {
  if (fftTimer !== null) return;
  fftTimer = setInterval(pushFftFrame, 66);
};

const stopFftLoop = (): void => {
  if (fftTimer !== null) {
    clearInterval(fftTimer);
    fftTimer = null;
  }
};

/** 淡入淡出：Gain 节点优先（频谱图接管后 el.volume 失效），直出时回退 el.volume */
let fadeMs = 200;
let userVolume = 1;
let fadeRun = 0;
let mediaSource: MediaElementSourceNode | null = null;
let fadeGain: GainNode | null = null;

/** 当前淡入淡出电平 0..1 */
const getFadeLevel = (el: HTMLAudioElement): number =>
  fadeGain ? fadeGain.gain.value : userVolume > 0 ? el.volume / userVolume : 1;

/** 写淡入淡出电平 0..1 */
const setFadeLevel = (el: HTMLAudioElement, level: number): void => {
  if (fadeGain) {
    fadeGain.gain.value = Math.min(1, Math.max(0, level));
    el.volume = userVolume;
  } else {
    el.volume = Math.min(1, Math.max(0, level)) * userVolume;
  }
};

/** 线性 ramp 到目标电平，中途被新一轮取消则停 */
const rampVolume = (el: HTMLAudioElement, target: number, ms: number, run: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || run !== fadeRun) {
      if (run === fadeRun) setFadeLevel(el, target);
      resolve();
      return;
    }
    const from = getFadeLevel(el);
    const steps = Math.max(1, Math.round(ms / 25));
    let step = 0;
    const timer = setInterval(() => {
      if (run !== fadeRun) {
        clearInterval(timer);
        resolve();
        return;
      }
      step += 1;
      setFadeLevel(el, from + ((target - from) * step) / steps);
      if (step >= steps) {
        clearInterval(timer);
        resolve();
      }
    }, 25);
  });

/** 取消进行中的淡入淡出，电平回到满 */
const cancelFade = (el: HTMLAudioElement): number => {
  fadeRun += 1;
  setFadeLevel(el, 1);
  return fadeRun;
};

/** 从 0 淡入到满电平（起播用） */
const fadeIn = (el: HTMLAudioElement): void => {
  if (fadeMs <= 0 || userVolume <= 0) return;
  const run = fadeRun + 1;
  fadeRun = run;
  setFadeLevel(el, 0);
  void rampVolume(el, 1, fadeMs, run);
};

/** 淡出到 0 后暂停/停播（UI 立即响应，声音随后收尾） */
const fadeOutThen = (el: HTMLAudioElement, after: () => void, ms?: number): void => {
  if (fadeMs <= 0 || el.paused || userVolume <= 0) {
    cancelFade(el);
    after();
    return;
  }
  const run = fadeRun + 1;
  fadeRun = run;
  void rampVolume(el, 0, ms ?? fadeMs, run).then(() => {
    if (run !== fadeRun) return;
    after();
    setFadeLevel(el, 1);
  });
};

const getAudio = (): HTMLAudioElement => {
  if (!audio) {
    const el = new Audio();
    el.preload = "auto";
    el.addEventListener("play", () => {
      publishState("playing");
      if (audioCtx) void audioCtx.resume().catch(() => {});
      if (fftWanted) startFftLoop();
      emit({ type: "play" });
    });
    el.addEventListener("pause", () => {
      publishState("paused");
      stopFftLoop();
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
      if (saved !== null) userVolume = el.volume = Math.min(1, Math.max(0, Number(saved) || 0));
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
    const switchSrc = async (): Promise<Awaited<ReturnType<PlayerApi["load"]>>> => {
      publishMetadata(options?.meta as Parameters<typeof publishMetadata>[0]);
      el.src = source;
      // 频谱需要时异步挂分析图（直出先播，不阻塞起播）
      void ensureFftGraph(el);
      if (options?.autoPlay !== false) {
        try {
          await el.play();
          fadeIn(el);
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
    };
    // 切歌时旧曲快速淡出再换源，避免硬切爆音
    if (!el.paused && el.src && fadeMs > 0) {
      const run = fadeRun + 1;
      fadeRun = run;
      await rampVolume(el, 0, Math.min(fadeMs, 250), run);
      if (run !== fadeRun) return fail("interrupted");
      el.pause();
      setFadeLevel(el, 1);
    } else {
      cancelFade(el);
    }
    return switchSrc();
  },
  play: async () => {
    try {
      const el = getAudio();
      await el.play();
      fadeIn(el);
      return ok();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
  pause: async () => {
    const el = getAudio();
    fadeOutThen(el, () => el.pause());
    return ok();
  },
  stop: async () => {
    const el = getAudio();
    fadeOutThen(el, () => {
      el.pause();
      el.removeAttribute("src");
      el.load();
      publishMetadata(undefined);
      publishState("none");
    });
    return ok();
  },
  seek: async (positionMs: number) => {
    const el = getAudio();
    cancelFade(el);
    el.currentTime = Math.max(0, positionMs / 1000);
    return ok();
  },
  setVolume: async (volume: number) => {
    const v = Math.min(1, Math.max(0, volume));
    userVolume = v;
    const el = getAudio();
    fadeRun += 1;
    el.volume = v;
    if (fadeGain) fadeGain.gain.value = 1;
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
  setFftEnabled: async (enabled: boolean) => {
    fftWanted = enabled;
    if (enabled) {
      void ensureFftGraph(getAudio());
      const el = audio;
      if (el && !el.paused) startFftLoop();
    } else {
      stopFftLoop();
    }
    return ok();
  },
  getFftData: async () => {
    const el = audio;
    if (!el || !analyser || el.paused) return ok({ ldata: [], rdata: [] });
    try {
      const raw = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(raw);
      const ldata = new Array<number>(FFT_BINS);
      for (let i = 0; i < FFT_BINS; i++) {
        ldata[i] = ((raw[i * 2] ?? 0) + (raw[i * 2 + 1] ?? 0)) / 512;
      }
      return ok({ ldata, rdata: [...ldata] });
    } catch {
      return ok({ ldata: [], rdata: [] });
    }
  },
  setFadeDuration: async (ms: number) => {
    fadeMs = Math.max(0, ms || 0);
    return ok();
  },
  getFadeDuration: async () => ok(fadeMs),
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
