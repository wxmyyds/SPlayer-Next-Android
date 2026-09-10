import type { Track } from "@shared/types/player";
import type { ShuffleMode } from "@/stores/status";
import { shouldSkipDjTrack } from "@/utils/preset/djMode";

/** 候选歌曲计算上下文 */
export interface CandidateContext {
  playIndex: number;
  queue: readonly Track[];
  fmMode: boolean;
  fuckDjMode: boolean;
  shuffleMode: ShuffleMode;
}

/** 候选查找结果 */
export interface CandidateResult {
  track: Track;
  index: number;
}

/**
 * 计算接下来 count 首预载候选（SFA 滑动窗口：一次性推整个窗口给原生）
 * @param ctx - 计算上下文
 * @param count - 需要的候选数
 * @returns 候选列表（可能少于 count）
 */
export const getNextTrackCandidates = (ctx: CandidateContext, count: number): CandidateResult[] => {
  if (ctx.fmMode) return [];
  const len = ctx.queue.length;
  if (len <= 1) return [];
  // 随机模式到达队尾时不缓存（不回绕）
  if (ctx.shuffleMode === "on" && ctx.playIndex >= len - 1) return [];
  const results: CandidateResult[] = [];
  let candidateIndex = (ctx.playIndex + 1) % len;
  let scanned = 0;
  while (scanned < len && results.length < count) {
    // 随机模式跨过队尾不缓存
    if (ctx.shuffleMode === "on" && candidateIndex >= len) break;
    const track = ctx.queue[candidateIndex];
    if (track && (!ctx.fuckDjMode || !shouldSkipDjTrack(track))) {
      results.push({ track, index: candidateIndex });
    }
    candidateIndex = ctx.shuffleMode === "on" ? candidateIndex + 1 : (candidateIndex + 1) % len;
    scanned++;
  }
  return results;
};

/**
 * 计算下一首预载候选 Track
 * @param ctx - 计算上下文
 * @returns 候选 Track 及位置，不存在则返回 null
 */
export const getNextTrackCandidate = (ctx: CandidateContext): CandidateResult | null =>
  getNextTrackCandidates(ctx, 1)[0] ?? null;
