/**
 * 下一首歌曲预载服务
 */

import type { Track } from "@shared/types/player";
import type { ResolvedTrackSource } from "@/services/audioSource";
import { resolveTrackSource } from "@/services/audioSource";
import { getNextTrackCandidates } from "@/core/player/candidate";
import { invalidatePreloadedLyric, preloadLyricForTrack } from "@/services/lyric/preload";
import { pushNativeQueue } from "@/services/nextTrackQueue";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import { useStreamingStore } from "@/stores/streaming";
import { usePluginsStore } from "@/stores/plugins";
import { useMediaStore } from "@/stores/media";
import { isAndroid } from "@/utils/platform";
import * as autoClose from "@/services/autoClose";
import * as queue from "@/stores/queue";

/** 预载结果 */
export interface NextTrackPreloadResult {
  trackId: string;
  source: ResolvedTrackSource | null;
  contextKey: string;
}

/** 窗口条目：预载结果 + 候选轨道信息 */
interface WindowEntry {
  result: NextTrackPreloadResult;
  track: Track;
  index: number;
}

/**
 * 登记原生下一首窗口（SFA PlaybackQueue 滑窗，幂等整窗替换）：
 * 锁屏下连续 AUTO 过渡由 ExoPlayer 预缓冲直接开播，不等 WebView。
 * 单曲循环/定时关闭“等本曲结束”时不登记，否则原生会越过这两种语义。
 */
const pushNativeWindow = (entries: (WindowEntry | null | undefined)[]): void => {
  if (!isAndroid) return;
  const items = entries
    .filter((entry): entry is WindowEntry => !!entry && !!entry.result.source?.source)
    .map((entry) => ({
      trackId: entry.track.id,
      playIndex: entry.index,
      source: entry.result.source!.source,
      title: entry.track.title,
      artist: entry.track.artists?.map((a) => a.name).join(" / ") ?? "",
      album: entry.track.album?.name ?? "",
      artwork: entry.track.coverOriginal ?? entry.track.cover ?? "",
      durationMs: entry.track.duration ?? 0,
    }));
  if (!items.length) return;
  const status = useStatusStore();
  if (status.repeatMode === "one" || autoClose.shouldStopAfterCurrentTrack()) return;
  console.log("[nextPreload] native window armed:", items.map((item) => item.trackId).join(","));
  window.api.player
    .setNextResources?.({ items })
    .catch((err) => console.error("[nextPreload] setNextResources failed:", err));
};

let currentToken = 0;
let cachedResult: NextTrackPreloadResult | null = null;
let cachedEntry: WindowEntry | null = null;
let tailEntries: WindowEntry[] = [];
let currentContextKey: string | null = null;
let pendingCover: HTMLImageElement | null = null;
let stopContextWatch: (() => void) | null = null;

/**
 * 拼装上下文指纹，用于去重与作废
 */
const buildContextKey = (track: Track): string => {
  const settings = useSettingsStore();
  const streaming = useStreamingStore();
  const plugins = usePluginsStore();

  const parts = [
    track.id,
    track.source,
    track.serverId ?? "",
    track.originalId ?? "",
    track.path ?? "",
    track.cueAudioPath ?? "",
    settings.player.songLevel,
    settings.player.allowTrialPlay,
    settings.preset.fuckDjMode,
    streaming.activeServerId ?? "",
    plugins.list
      .map((plugin) =>
        JSON.stringify([
          plugin.manifest.id,
          plugin.enabled,
          plugin.status.state,
          plugin.status.state === "ready" ? plugin.status.sources : null,
        ]),
      )
      .join(";"),
  ];

  return parts.join("::");
};

/**
 * 提前解码封面图片，仅利用 Chromium 渲染引擎缓存
 */
const preloadCover = async (url: string): Promise<void> => {
  if (!url) return;
  if (pendingCover) pendingCover.src = "";
  const image = new Image();
  pendingCover = image;
  try {
    image.decoding = "async";
    image.src = url;
    await image.decode();
  } catch {
    // ignore
  } finally {
    if (pendingCover === image) pendingCover = null;
  }
};

/**
 * 作废当前的预载缓存
 */
export const invalidateNextTrackPreload = (): void => {
  currentToken++;
  cachedResult = null;
  currentContextKey = null;
  if (pendingCover) {
    pendingCover.src = "";
    pendingCover = null;
  }
  invalidatePreloadedLyric();
  // 原生登记的下一首窗口一并作废，避免 ENDED 后原生切到已被换掉的曲目
  cachedEntry = null;
  tailEntries = [];
  if (isAndroid) void window.api.player.clearNextResource?.().catch(() => {});
};

/**
 * 消费预载结果
 * @param track - 正在切入播放的目标歌曲
 * @returns 匹配的预载结果，未命中或已作废则返回 null
 */
export const consumePreloadedTrack = (track: Track): NextTrackPreloadResult | null => {
  if (!useSettingsStore().player.preloadNextTrack && !isAndroid) {
    invalidateNextTrackPreload();
    return null;
  }
  const currentKey = buildContextKey(track);
  // 滑窗晋升：次候选正是正在切入的曲目时直接提升为首候选（SFA 式零延迟续窗）
  if (!cachedResult && tailEntries.length) {
    const hitIndex = tailEntries.findIndex(
      (entry) => entry.result.trackId === track.id && entry.result.contextKey === currentKey,
    );
    if (hitIndex >= 0) {
      cachedResult = tailEntries[hitIndex].result;
      cachedEntry = tailEntries[hitIndex];
      tailEntries.splice(hitIndex, 1);
    }
  }
  if (!cachedResult) {
    if (currentContextKey === currentKey) {
      // 音源尚未解析完成，阻止迟到结果写回；同曲歌词和封面仍可继续使用
      currentToken++;
      currentContextKey = null;
    } else if (currentContextKey) {
      invalidateNextTrackPreload();
    }
    return null;
  }
  if (cachedResult.trackId !== track.id) {
    invalidateNextTrackPreload();
    return null;
  }
  if (cachedResult.contextKey !== currentKey) {
    // 上下文已改变（如切换了音质），当前缓存作废
    invalidateNextTrackPreload();
    return null;
  }
  const result = cachedResult;
  currentToken++;
  cachedResult = null;
  cachedEntry = null;
  currentContextKey = null;
  return result;
};

/** 解析失败重试间隔（用户网络存在 weapi 首包 stall，一次失败不能放弃整首歌的槽位） */
const RESOLVE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/** 预载调度候选数：前几名预解析 URL 即时缓冲，全部推入原生自治队列兜底 */
const QUEUE_CANDIDATE_COUNT = 30;

/** 参与 URL 预解析的候选数（含首候选）：ExoPlayer 只需紧邻几首预缓冲 */
const PRELOAD_URL_COUNT = 5;

/**
 * 带退避重试的音源预解析
 * @param track - 候选曲目
 * @param contextKey - 首候选的调度指纹（次候选传 null，仅由 token 守卫）
 * @param token - 调度令牌，作废后不再重试
 * @returns 解析结果，重试耗尽或已作废时返回 null
 */
const attemptResolve = async (
  track: Track,
  contextKey: string | null,
  token: number,
  retryDelays: readonly number[] = RESOLVE_RETRY_DELAYS_MS,
): Promise<ResolvedTrackSource | null> => {
  const stale = (): boolean =>
    token !== currentToken || (contextKey !== null && currentContextKey !== contextKey);
  for (let attempt = 0; ; attempt++) {
    try {
      return await resolveTrackSource(track, {
        silent: true,
        streamingPlaySessionId: crypto.randomUUID(),
      });
    } catch (err) {
      if (attempt >= retryDelays.length || stale()) {
        if (!stale()) {
          console.warn("[nextPreload] resolve failed after retries:", err);
          // 清理调度指纹，让下一次 requestNextUrl 补窗重新发起解析
          if (contextKey !== null && currentContextKey === contextKey) currentContextKey = null;
        }
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      if (stale()) return null;
    }
  }
};

/**
 * 调度下一首预载任务
 */
export const scheduleNextTrackPreload = (): void => {
  const settings = useSettingsStore();
  // Android 锁屏下 ENDED 时现解析必走网络，常因 CPU 休眠/首包 stall 卡死不切歌；
  // 必须在播放中（CPU 醒着）预解析好下一首，ENDED 时直接消费缓存
  if (!settings.player.preloadNextTrack && !isAndroid) {
    invalidateNextTrackPreload();
    return;
  }

  const status = useStatusStore();
  const currentTrack = status.currentTrack;
  if (!currentTrack || useMediaStore().track?.id !== currentTrack.id) {
    invalidateNextTrackPreload();
    return;
  }
  const candidates = getNextTrackCandidates(
    {
      playIndex: status.playIndex,
      queue: queue.queue.value,
      fmMode: status.fmMode,
      fuckDjMode: settings.preset.fuckDjMode,
      shuffleMode: status.shuffleMode,
    },
    QUEUE_CANDIDATE_COUNT,
  );

  if (!candidates.length) {
    invalidateNextTrackPreload();
    return;
  }

  // 原生自治队列整队重推（纯元数据零网络成本；队列耗尽原生才回落 JS 链）
  pushNativeQueue(candidates);

  const [candidateResult] = candidates;
  const candidateTrack = candidateResult.track;
  const contextKey = buildContextKey(candidateTrack);
  // 歌词使用独立上下文去重，歌词偏好变化不需要重新解析音源
  preloadLyricForTrack(candidateTrack);

  // 上下文指纹一致且已有缓存：只重推窗口（可能被 invalidate 清空）
  if (cachedResult && cachedResult.contextKey === contextKey) {
    if (cachedResult.trackId === candidateTrack.id) {
      pushNativeWindow([cachedEntry, ...tailEntries]);
    }
    return;
  }

  // 避免在异步生成过程中重复调度同一 contextKey
  if (currentContextKey === contextKey && !cachedResult) {
    return;
  }

  const token = ++currentToken;
  currentContextKey = contextKey;
  cachedResult = null;
  cachedEntry = null;
  tailEntries = [];

  void (async () => {
    try {
      if (candidateTrack.cover) {
        void preloadCover(candidateTrack.cover);
      }
      const source = await attemptResolve(candidateTrack, contextKey, token);
      if (token !== currentToken || !source) return;
      const result: NextTrackPreloadResult = {
        trackId: candidateTrack.id,
        source,
        contextKey,
      };
      cachedResult = result;
      cachedEntry = { result, track: candidateTrack, index: candidateResult.index };
      pushNativeWindow([cachedEntry, ...tailEntries]);
    } catch (err) {
      console.warn("[nextPreload] Preload task failed silently:", err);
      if (token === currentToken) {
        invalidateNextTrackPreload();
      }
    }
  })();

  // URL 预解析限前 PRELOAD_URL_COUNT 首（即时缓冲）；其余候选仅推队列，由原生按需自解
  for (const tail of candidates.slice(1, PRELOAD_URL_COUNT)) {
    void (async () => {
      const tailKey = buildContextKey(tail.track);
      const source = await attemptResolve(tail.track, null, token, []);
      if (token !== currentToken || !source) return;
      tailEntries.push({
        result: { trackId: tail.track.id, source, contextKey: tailKey },
        track: tail.track,
        index: tail.index,
      });
      pushNativeWindow([cachedEntry, ...tailEntries]);
    })();
  }
};

/** 安装预载上下文监听 */
export const installNextTrackPreloadWatchers = (): void => {
  if (stopContextWatch) return;
  const settings = useSettingsStore();
  const status = useStatusStore();
  const streaming = useStreamingStore();
  const plugins = usePluginsStore();
  stopContextWatch = watch(
    () => [
      settings.player.preloadNextTrack,
      settings.player.songLevel,
      settings.player.allowTrialPlay,
      settings.preset.fuckDjMode,
      status.playIndex,
      status.fmMode,
      status.shuffleMode,
      queue.queue.value,
      streaming.activeServerId,
      settings.lyric.lyricSourcePreference,
      settings.lyric.lyricSourceOrder.join(","),
      settings.lyric.lyricFormatOrder.join(","),
      settings.lyric.smartPreferOnline,
      settings.lyric.preferPluginLyric,
      settings.system.lyric.enableOnlineTTMLLyric,
      settings.system.localLyric.enableLocalTTMLOverride,
      settings.system.localLyric.repoDir,
      plugins.list
        .map((plugin) =>
          JSON.stringify([
            plugin.manifest.id,
            plugin.enabled,
            plugin.status.state,
            plugin.status.state === "ready" ? plugin.status.sources : null,
          ]),
        )
        .join(";"),
    ],
    scheduleNextTrackPreload,
    { flush: "post" },
  );
};

/** 清理预载上下文监听 */
export const disposeNextTrackPreload = (): void => {
  stopContextWatch?.();
  stopContextWatch = null;
  invalidateNextTrackPreload();
};
