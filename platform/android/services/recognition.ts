/**
 * Android 听歌识曲（麦克风一路）：
 * 复用渲染进程麦克风采集（microphoneCapture）+ AFP WASM 指纹 + 网易 audio/match 匹配，
 * 是上游 electron/main/services/recognition 会话状态机的渲染层移植。
 * 系统内录一路按 DEVELOPMENT.md §3.1 裁剪，start(source:"system") 直接报不支持。
 */

import type {
  RecognitionCandidate,
  RecognitionConfig,
  RecognitionEvent,
  RecognitionErrorCode,
} from "@shared/types/recognition";
import { fetchWithProxy } from "@android/vendor/shim/proxy";
import {
  captureMicrophone,
  waitCapture,
  type MicrophoneCaptureHandle,
} from "@/services/recognition/microphoneCapture";

/** 静音判定阈值（8 kHz 单声道 RMS） */
const SILENCE_RMS_THRESHOLD = 0.005;
/** 匹配窗口：3 秒窗口、1 秒步长滑动，8 秒样本最多 6 个窗口 */
const WINDOW_SAMPLES = 3 * 8000;
const STEP_SAMPLES = 1 * 8000;
/** 音量归一化目标 RMS 与增益上限（同上游 session.ts） */
const TARGET_RMS = 0.1;
const MAX_GAIN = 50;

/** AFP ESM 模块形状（public/afp/afp.mjs，GenerateFP 输入 8kHz 单声道 Float32Array） */
interface AfpModule {
  GenerateFP?: (pcm: Float32Array) => Promise<string>;
}

const AFP_MODULE_URL = "/afp/afp.mjs";

let afpPromise: Promise<AfpModule | null> | null = null;
let sessionToken = 0;
let captureHandle: MicrophoneCaptureHandle | null = null;
let abort: AbortController | null = null;
/** 采集前是否暂停了播放，结束后恢复 */
let shouldResume = false;
const listeners = new Set<(event: RecognitionEvent) => void>();

/** AFP 指纹库惰性加载（资产在 public/afp，随构建进 WebView 根路径） */
const loadAfp = (): Promise<AfpModule | null> => {
  if (afpPromise) return afpPromise;
  afpPromise = import(/* @vite-ignore */ AFP_MODULE_URL)
    .then((mod: AfpModule) => (typeof mod.GenerateFP === "function" ? mod : null))
    .catch(() => null);
  return afpPromise;
};

/** 8 kHz 单声道样本 RMS */
const rms = (pcm: Float32Array): number => {
  let energy = 0;
  for (let i = 0; i < pcm.length; i++) {
    energy += pcm[i] * pcm[i];
  }
  return Math.sqrt(energy / Math.max(1, pcm.length));
};

/** 音量归一化：信号偏弱时放大到目标 RMS（上限防噪声放大），过强保持原样 */
const normalizeLevel = (pcm: Float32Array): Float32Array => {
  const current = rms(pcm);
  if (current <= 0) return pcm;
  const gain = Math.min(MAX_GAIN, TARGET_RMS / current);
  if (gain <= 1) return pcm;
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i] * gain;
  }
  return out;
};

const emit = (event: RecognitionEvent): void => {
  for (const listener of listeners) listener(event);
};

const emitError = (code: RecognitionErrorCode, message: string): void => {
  emit({ phase: "error", error: { code, message } });
  resumePlayback();
};

/** 结束后恢复识别前的播放（原生路径下播放暂停由本服务负责） */
const resumePlayback = (): void => {
  if (!shouldResume) return;
  shouldResume = false;
  void import("@/core/player").then((player) => player.play()).catch(() => {});
};

const pausePlayback = async (): Promise<void> => {
  const { useStatusStore } = await import("@/stores/status");
  if (!useStatusStore().isPlaying) return;
  shouldResume = true;
  const player = await import("@/core/player");
  void player.pause();
};

/** 麦克风采集异常 → 识别错误码 */
const mapMicError = (error: unknown): RecognitionErrorCode => {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "permission-denied";
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return "no-device";
    }
    if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      return "capture-failed";
    }
  }
  return "capture-failed";
};

/** 指纹计算 */
const fingerprintPcm = async (
  pcm: Float32Array,
): Promise<{ ok: true; fingerprint: string } | { ok: false; error: string }> => {
  const mod = await loadAfp();
  if (!mod?.GenerateFP) return { ok: false, error: "afp-unavailable" };
  try {
    return { ok: true, fingerprint: await mod.GenerateFP(pcm) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

interface MatchedSong {
  id: number;
  name: string;
  artists?: { name: string }[];
  album?: { name?: string; picUrl?: string };
}

/**
 * 音频指纹交给网易 audio/match 匹配（无加密无登录态的公开端点，同上游 apis/netease audio_match）
 * @param fingerprint - AFP 生成的指纹（base64）
 * @param durationSec - 音频片段时长（秒）
 */
const matchAudio = async (
  fingerprint: string,
  durationSec: number,
): Promise<
  { ok: true; songs: { song: MatchedSong; startTime?: number }[] } | { ok: false; code: "network" }
> => {
  try {
    const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const params = new URLSearchParams({
      sessionId,
      algorithmCode: "shazam_v2",
      duration: String(durationSec),
      rawdata: fingerprint,
      times: "1",
      decrypt: "1",
    });
    const response = await fetchWithProxy(
      `https://interface.music.163.com/api/music/audio/match?${params}`,
      {
        headers: {
          Accept: "application/json",
          Referer: "https://music.163.com/",
          "User-Agent": "Mozilla/5.0",
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return { ok: false, code: "network" };
    const body = (await response.json()) as {
      code?: number;
      data?: { result?: { startTime?: number; song?: MatchedSong }[] };
    };
    if (body.code !== 200) return { ok: false, code: "network" };
    return {
      ok: true,
      songs: (body.data?.result ?? [])
        .filter((item): item is { startTime?: number; song: MatchedSong } => !!item.song)
        .slice(0, 3)
        .map((item) => ({ song: item.song, startTime: item.startTime })),
    };
  } catch {
    return { ok: false, code: "network" };
  }
};

/**
 * 识别一段 8 kHz 单声道 PCM：3 秒窗口 / 1 秒步长滑动，首个有候选的窗口即停
 * @param pcm - 8 kHz 单声道样本
 */
const recognizePcm = async (pcm: Float32Array): Promise<void> => {
  const token = sessionToken;
  const normalized = normalizeLevel(pcm);
  if (rms(normalized) < SILENCE_RMS_THRESHOLD) {
    emitError("silent-input", "没有采集到声音，请对准音源再试");
    return;
  }
  emit({ phase: "fingerprinting" });
  const windows: Array<{ start: number; pcm: Float32Array }> = [];
  for (let start = 0; start + WINDOW_SAMPLES <= normalized.length; start += STEP_SAMPLES) {
    windows.push({ start, pcm: normalized.subarray(start, start + WINDOW_SAMPLES) });
  }
  if (windows.length === 0) windows.push({ start: 0, pcm: normalized });

  let candidates: RecognitionCandidate[] = [];
  for (const win of windows) {
    if (token !== sessionToken) return;
    const fingerprint = await fingerprintPcm(win.pcm);
    if (token !== sessionToken) return;
    if (!fingerprint.ok) {
      emitError(
        fingerprint.error === "afp-unavailable" ? "afp-unavailable" : "unknown",
        fingerprint.error,
      );
      return;
    }
    emit({ phase: "matching" });
    const match = await matchAudio(fingerprint.fingerprint, WINDOW_SAMPLES / 8000);
    if (token !== sessionToken) return;
    if (!match.ok) {
      emitError("network", "音频匹配服务不可用");
      return;
    }
    if (match.songs.length === 0) continue;
    candidates = match.songs.map((item) => ({
      songId: String(item.song.id),
      title: item.song.name,
      artists: (item.song.artists ?? []).map((artist) => artist.name),
      album: item.song.album?.name,
      cover: item.song.album?.picUrl,
      startTime: (item.startTime ?? 0) + win.start / 8000,
    }));
    break;
  }
  emit({ phase: "done", candidates });
  resumePlayback();
};

/** 开始一次识别（Android 仅支持麦克风来源） */
const start = async (config: RecognitionConfig): Promise<void> => {
  cancel();
  if (config.source === "system") {
    emitError("unsupported", "Android 暂不支持采集系统声音");
    return;
  }
  sessionToken++;
  const token = sessionToken;
  emit({ phase: "capturing" });
  await pausePlayback();
  abort = new AbortController();
  const signal = abort.signal;
  try {
    const handle = await captureMicrophone((lvl) => {
      if (token === sessionToken) emit({ phase: "capturing", level: lvl });
    }, signal);
    if (token !== sessionToken) {
      handle.close();
      return;
    }
    captureHandle = handle;
    await waitCapture(config.durationMs, signal);
    const pcm = await handle.stop();
    handle.close();
    captureHandle = null;
    if (signal.aborted || token !== sessionToken) {
      resumePlayback();
      return;
    }
    await recognizePcm(pcm);
  } catch (err) {
    captureHandle = null;
    if (signal.aborted || token !== sessionToken) {
      resumePlayback();
      return;
    }
    emitError(mapMicError(err), err instanceof Error ? err.message : String(err));
  }
};

/** 取消当前识别 */
const cancel = (): void => {
  sessionToken++;
  abort?.abort();
  abort = null;
  if (captureHandle) {
    void captureHandle.stop();
    captureHandle.close();
    captureHandle = null;
  }
  resumePlayback();
};

/** 渲染进程已采集的 PCM 直接提交识别（对齐上游 recognition:submitPcm） */
const submitPcm = async (pcm: Float32Array): Promise<void> => {
  if (!(pcm instanceof Float32Array) || pcm.length === 0) {
    emitError("capture-failed", "提交了无效的 PCM");
    return;
  }
  sessionToken++;
  emit({ phase: "capturing" });
  await recognizePcm(pcm);
};

/** 创建 Android 识别 API（bridge.ts 接线用） */
export const createRecognitionApi = () => ({
  isSupported: async (): Promise<boolean> =>
    typeof navigator.mediaDevices?.getUserMedia === "function",
  start,
  cancel: async (): Promise<void> => cancel(),
  submitPcm,
  onEvent: (callback: (event: RecognitionEvent) => void): (() => void) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
});
