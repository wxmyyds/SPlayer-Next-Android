/**
 * 播放统计采集（Android 版）
 *
 * 上游 dev 的 electron/main/database/playStats.ts 同语义异步版。
 * 日期/JSON1 函数直接跑在系统 SQLite 上；老设备缺 JSON1 时按上游同样兜底返回空。
 */

import { mediaLog } from "@main/utils/logger";
import type { Artist, Track } from "@shared/types/player";
import type {
  DailyPlayStats,
  FavoriteEventInput,
  HourlyPlayStats,
  LibraryStats,
  PlayEventInput,
  PlayStatsSummary,
  TopAlbum,
  TopArtist,
  TopTrack,
} from "@shared/types/stats";
import { dbQuery, dbRun } from "./index";

/** 写入一条播放记录 */
export const insertPlayEvent = async (event: PlayEventInput): Promise<void> => {
  try {
    await dbRun(
      `INSERT INTO play_history (track_id, source, started_at, listened_ms, track_json)
       VALUES (?, ?, ?, ?, ?)`,
      [event.track.id, event.track.source, event.startedAt, event.listenedMs, JSON.stringify(event.track)],
    );
  } catch (error) {
    mediaLog.error("写入播放记录失败:", error);
  }
};

/** 写入一条收藏变更记录 */
export const insertFavoriteEvent = async (event: FavoriteEventInput): Promise<void> => {
  try {
    await dbRun(
      `INSERT INTO favorite_history (track_id, source, action, at, track_json)
       VALUES (?, ?, ?, ?, ?)`,
      [event.track.id, event.track.source, event.action, Date.now(), JSON.stringify(event.track)],
    );
  } catch (error) {
    mediaLog.error("写入收藏记录失败:", error);
  }
};

/** 今日 00:00 的 unix ms（本地时区） */
const dayStartMs = (now: number): number => {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

/** 本周一 00:00 的 unix ms（本地时区） */
const weekStartMs = (now: number): number => {
  const date = new Date(now);
  const daysFromMonday = (date.getDay() + 6) % 7;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysFromMonday);
  return monday.getTime();
};

/** 本地日期 key：YYYY-MM-DD */
const dayKey = (date: Date): string => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 从倒序的有播放日期列表算连续天数 */
const computeStreak = (descDays: string[]): number => {
  if (descDays.length === 0) return 0;
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (descDays[0] !== dayKey(today) && descDays[0] !== dayKey(yesterday)) return 0;
  const present = new Set(descDays);
  const cursor = new Date(today);
  if (descDays[0] !== dayKey(today)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (present.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
};

/** 读盘失败时的兜底空统计 */
const EMPTY_SUMMARY: PlayStatsSummary = {
  todayListenedMs: 0,
  weekListenedMs: 0,
  lastWeekListenedMs: 0,
  totalListenedMs: 0,
  weekPlayCount: 0,
  totalPlayCount: 0,
  weekFavoriteAdds: 0,
  streakDays: 0,
};

/** 取播放统计汇总，读盘失败返回全 0 */
export const getStatsSummary = async (): Promise<PlayStatsSummary> => {
  try {
    const now = Date.now();
    const dayStart = dayStartMs(now);
    const weekStart = weekStartMs(now);
    const lastWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000;

    const scalar = async (sql: string, ...params: number[]): Promise<number> => {
      const rows = await dbQuery<{ value: number }>(sql, params);
      return rows[0]?.value ?? 0;
    };

    const listenedSince =
      "SELECT COALESCE(SUM(listened_ms), 0) AS value FROM play_history WHERE started_at >= ?";
    const playCountSince = "SELECT COUNT(*) AS value FROM play_history WHERE started_at >= ?";

    const dayRows = await dbQuery<{ day: string }>(
      "SELECT DISTINCT date(started_at / 1000, 'unixepoch', 'localtime') AS day FROM play_history ORDER BY day DESC",
    );

    return {
      todayListenedMs: await scalar(listenedSince, dayStart),
      weekListenedMs: await scalar(listenedSince, weekStart),
      lastWeekListenedMs: await scalar(
        "SELECT COALESCE(SUM(listened_ms), 0) AS value FROM play_history WHERE started_at >= ? AND started_at < ?",
        lastWeekStart,
        weekStart,
      ),
      totalListenedMs: await scalar(listenedSince, 0),
      weekPlayCount: await scalar(playCountSince, weekStart),
      totalPlayCount: await scalar(playCountSince, 0),
      weekFavoriteAdds: await scalar(
        "SELECT COUNT(*) AS value FROM favorite_history WHERE action = 'add' AND at >= ?",
        weekStart,
      ),
      streakDays: computeStreak(dayRows.map((row) => row.day)),
    };
  } catch (error) {
    mediaLog.error("读取播放统计失败:", error);
    return EMPTY_SUMMARY;
  }
};

/** 取最常播放的曲目，读盘失败返回空 */
export const getTopTracks = async (limit: number): Promise<TopTrack[]> => {
  try {
    const rows = await dbQuery<{ track_json: string; plays: number }>(
      `SELECT track_json, COUNT(*) AS plays
       FROM play_history
       WHERE source != 'streaming'
       GROUP BY source, track_id
       ORDER BY plays DESC, MAX(started_at) DESC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      track: JSON.parse(row.track_json) as Track,
      playCount: row.plays,
    }));
  } catch (error) {
    mediaLog.error("读取最常播放失败:", error);
    return [];
  }
};

/**
 * 取最近 N 天（含今天）的每日播放统计
 * @param days 最近 N 天
 */
export const getPlayHistoryDaily = async (days: number): Promise<DailyPlayStats[]> => {
  try {
    const startMs = dayStartMs(Date.now()) - (days - 1) * 24 * 60 * 60 * 1000;
    const rows = await dbQuery<{ day: string; playCount: number }>(
      `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS playCount
       FROM play_history
       WHERE started_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
      [startMs],
    );
    return rows.map((row) => ({ day: row.day, playCount: row.playCount }));
  } catch (error) {
    mediaLog.error("读取每日播放统计失败:", error);
    return [];
  }
};

/** 取本地时区各小时的累计播放统计（0-23 点） */
export const getPlayHistoryHourly = async (): Promise<HourlyPlayStats[]> => {
  try {
    const rows = await dbQuery<{ hour: number; playCount: number }>(
      `SELECT CAST(strftime('%H', started_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
              COUNT(*) AS playCount
       FROM play_history
       GROUP BY hour
       ORDER BY hour ASC`,
    );
    const countByHour = new Map(rows.map((row) => [row.hour, row.playCount]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      playCount: countByHour.get(hour) ?? 0,
    }));
  } catch (error) {
    mediaLog.error("读取分时播放统计失败:", error);
    return [];
  }
};

/**
 * 取本地与在线来源中最常播放的专辑
 * @param limit 取前 N 条
 */
export const getTopAlbums = async (limit: number): Promise<TopAlbum[]> => {
  try {
    const rows = await dbQuery<{ plays: number; track_json: string }>(
      `SELECT track_json, COUNT(*) AS plays
       FROM play_history
       WHERE source != 'streaming'
         AND TRIM(COALESCE(json_extract(track_json, '$.album.name'), '')) != ''
       GROUP BY source,
                COALESCE(
                  json_extract(track_json, '$.album.id'),
                  json_extract(track_json, '$.album.name')
                )
       ORDER BY plays DESC, MAX(started_at) DESC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      track: JSON.parse(row.track_json) as Track,
      playCount: row.plays,
    }));
  } catch (error) {
    mediaLog.error("读取最常播放专辑失败:", error);
    return [];
  }
};

/**
 * 取本地与在线来源中最常播放的歌手
 * @param limit 取前 N 条
 */
export const getTopArtists = async (limit: number): Promise<TopArtist[]> => {
  try {
    const rows = await dbQuery<{ plays: number; track_json: string; artist_json: string }>(
      `SELECT track_json, artist.value AS artist_json, COUNT(*) AS plays
       FROM play_history, json_each(play_history.track_json, '$.artists') artist
       WHERE play_history.source != 'streaming'
         AND TRIM(COALESCE(json_extract(artist.value, '$.name'), '')) != ''
       GROUP BY play_history.source,
                COALESCE(
                  json_extract(artist.value, '$.id'),
                  LOWER(json_extract(artist.value, '$.name'))
                )
       ORDER BY plays DESC, MAX(started_at) DESC
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      artist: JSON.parse(row.artist_json) as Artist,
      track: JSON.parse(row.track_json) as Track,
      playCount: row.plays,
    }));
  } catch (error) {
    mediaLog.error("读取最常播放歌手失败:", error);
    return [];
  }
};

/** 音乐库统计概览（tracks 空表阶段返回全 0，扫描落地后自动有数） */
export const getLibraryStats = async (): Promise<LibraryStats> => {
  const excludeCueContainer = (col = "path"): string =>
    `${col} NOT IN (SELECT cue_audio_path FROM tracks WHERE cue_audio_path IS NOT NULL)`;
  try {
    const aggregate = await dbQuery<{
      trackCount: number;
      totalDurationMs: number;
      totalFileSize: number;
    }>(
      `SELECT COUNT(*) AS trackCount,
              COALESCE(SUM(duration), 0) AS totalDurationMs,
              COALESCE(SUM(file_size), 0) AS totalFileSize
       FROM tracks
       WHERE ${excludeCueContainer()}`,
    );
    const albumRows = await dbQuery<{ count: number }>(
      `SELECT COUNT(DISTINCT json_extract(album, '$.name')) AS count
       FROM tracks
       WHERE album IS NOT NULL AND json_extract(album, '$.name') IS NOT NULL
         AND ${excludeCueContainer()}`,
    );
    const artistRows = await dbQuery<{ count: number }>(
      `SELECT COUNT(DISTINCT json_extract(a.value, '$.name')) AS count
       FROM tracks t, json_each(t.artists) a
       WHERE json_extract(a.value, '$.name') IS NOT NULL
         AND TRIM(json_extract(a.value, '$.name')) != ''
         AND ${excludeCueContainer("t.path")}`,
    );
    const codecs = await dbQuery<{ codec: string; count: number }>(
      `SELECT COALESCE(codec, '') AS codec, COUNT(*) AS count
       FROM tracks
       WHERE ${excludeCueContainer()}
       GROUP BY codec
       ORDER BY count DESC, codec`,
    );
    return {
      trackCount: aggregate[0]?.trackCount ?? 0,
      albumCount: albumRows[0]?.count ?? 0,
      artistCount: artistRows[0]?.count ?? 0,
      totalDurationMs: aggregate[0]?.totalDurationMs ?? 0,
      totalFileSize: aggregate[0]?.totalFileSize ?? 0,
      codecs: codecs.map((row) => ({ codec: row.codec, count: row.count })),
    };
  } catch (error) {
    mediaLog.error("读取曲库统计失败:", error);
    return {
      trackCount: 0,
      albumCount: 0,
      artistCount: 0,
      totalDurationMs: 0,
      totalFileSize: 0,
      codecs: [],
    };
  }
};
