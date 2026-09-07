/**
 * 歌词内存缓存（Android 版）
 *
 * 上游 dev 用 SQLite 持久化 lyricCache / lyricMatchCache；Android 过渡期用内存 Map：
 * 同一播放会话内不重复请求，进程重启后重新匹配（歌词本就随播即取）。
 */

import type { LyricMatchResult } from "@shared/types/lyrics";
import type { Track } from "@shared/types/player";
import { normalize, normalizeTrackArtists } from "./utils";

/** 时长按 5s 桶归一（与上游一致） */
const DURATION_BUCKET_MS = 5000;
const FINGERPRINT_VERSION = "v2";

/** 用 title + 全部艺术家 + 时长桶算 track 指纹（与上游一致） */
export const buildFingerprint = (track: Track): string => {
  const title = normalize(track.title);
  const artist = normalizeTrackArtists(track).join("");
  const bucket = track.duration ? Math.round(track.duration / DURATION_BUCKET_MS) : 0;
  return `${FINGERPRINT_VERSION}|${title}|${artist}|${bucket}`;
};

const lyricCache = new Map<string, LyricMatchResult>();
const matchCache = new Map<string, string>();

export const getCachedLyric = (platform: string, id: string): LyricMatchResult | null =>
  lyricCache.get(`${platform}:${id}`) ?? null;

export const setCachedLyric = (
  platform: string,
  id: string,
  result: LyricMatchResult,
): void => {
  if (lyricCache.size > 500) lyricCache.clear();
  lyricCache.set(`${platform}:${id}`, result);
};

export const getMatchedId = (fingerprint: string, platform: string): string | null =>
  matchCache.get(`${fingerprint}:${platform}`) ?? null;

export const setMatchedId = (
  fingerprint: string,
  platform: string,
  platformId: string,
): void => {
  if (matchCache.size > 500) matchCache.clear();
  matchCache.set(`${fingerprint}:${platform}`, platformId);
};
