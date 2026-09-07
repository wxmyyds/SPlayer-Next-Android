/**
 * 歌词分发（Android 版）
 *
 * 对标上游 dev 的 electron/main/ipc/lyrics.ts：同 key 并发去重，
 * 网易/QQ/酷狗三源均已接 vendor 实现（渲染层失败即换下一来源）。
 */

import { coreLog } from "@main/utils/logger";
import type { LyricMatchResponse, LyricTTMLResponse } from "@shared/types/lyrics";
import type { Platform } from "@shared/types/platform";
import type { Track } from "@shared/types/player";
import * as netease from "./netease";
import * as qqmusic from "./qqmusic";
import * as kugou from "./kugou";

/** 进行中请求映射 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * 并发去重
 * @param key 唯一键
 * @param run 实际执行函数
 */
const dedup = <T>(key: string, run: () => Promise<T>): Promise<T> => {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
};

/**
 * 按 (platform, id) 直取
 * @param platform 平台
 * @param id 平台 id
 */
export const matchLyricById = (platform: Platform, id: string): Promise<LyricMatchResponse> =>
  dedup(`id:${platform}:${id}`, async () => {
    try {
      if (platform === "netease") {
        return { ok: true, data: await netease.getByPlatformId(id) };
      }
      if (platform === "qqmusic") {
        return { ok: true, data: await qqmusic.getByPlatformId(id) };
      }
      if (platform === "kugou") {
        return { ok: true, data: await kugou.getByPlatformId(id) };
      }
      return { ok: false, error: `unsupported platform: ${platform}` };
    } catch (err) {
      coreLog.warn(`[lyrics] matchById(${platform}, ${id}) failed:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

/**
 * 按 Track 元数据模糊搜索
 * @param platform 平台
 * @param track 歌曲信息
 */
export const matchLyricByQuery = (platform: Platform, track: Track): Promise<LyricMatchResponse> =>
  dedup(`query:${platform}:${track.source}:${track.id}`, async () => {
    try {
      if (platform === "netease") {
        return { ok: true, data: await netease.getByQuery(track) };
      }
      if (platform === "qqmusic") {
        return { ok: true, data: await qqmusic.getByQuery(track) };
      }
      if (platform === "kugou") {
        return { ok: true, data: await kugou.getByQuery(track) };
      }
      return { ok: false, error: `unsupported platform: ${platform}` };
    } catch (err) {
      coreLog.warn(`[lyrics] matchByQuery(${platform}, ${track.title}) failed:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

/**
 * TTML 覆盖歌词：暂不支持
 */
export const fetchLyricTTMLOverlay = async (
  _track: Track,
  _platform: "netease" | "qqmusic",
): Promise<LyricTTMLResponse> => ({ ok: false, error: "unsupported" });
