/**
 * 本地曲库只读查询（Android 版）
 *
 * 上游 dev 的 electron/main/database/queries.ts 同语义异步版；
 * 当前 tracks 为空表（MediaStore 扫描落地前），函数先行供歌单 DAO 校验与解析。
 */

import type { Album, Artist, AudioQuality, Track } from "@shared/types/player";
import { dbQuery } from "./index";

/** 数据库行类型（与上游一致） */
interface TrackRow {
  id: string;
  path: string;
  cue_path: string | null;
  cue_audio_path: string | null;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  title: string;
  track?: number;
  artists: string;
  album: string | null;
  duration: number;
  cover: string | null;
  codec: string | null;
  sample_rate: number | null;
  bit_rate: number | null;
  channels: number | null;
  bits_per_sample: number | null;
  file_size: number;
  file_mtime: number | null;
  file_ctime: number | null;
  scanned_at: number;
}

/** 将数据库行解析为 Track（与上游一致） */
const rowToTrack = (row: TrackRow): Track => {
  const quality: AudioQuality | undefined =
    row.codec != null
      ? {
          codec: row.codec,
          sampleRate: row.sample_rate ?? 0,
          bitRate: row.bit_rate ?? 0,
          channels: row.channels ?? 0,
          bitsPerSample: row.bits_per_sample ?? 0,
        }
      : undefined;

  return {
    id: row.id,
    source: "local",
    path: row.path,
    cuePath: row.cue_path ?? undefined,
    cueAudioPath: row.cue_audio_path ?? undefined,
    cueStartMs: row.cue_start_ms ?? undefined,
    cueEndMs: row.cue_end_ms ?? undefined,
    title: row.title,
    track: row.track ?? undefined,
    artists: JSON.parse(row.artists) as Artist[],
    album: row.album ? (JSON.parse(row.album) as Album) : undefined,
    duration: row.duration,
    cover: row.cover ?? undefined,
    fileSize: row.file_size ?? undefined,
    mtime: row.file_mtime ?? undefined,
    ctime: row.file_ctime ?? undefined,
    quality,
  };
};

/**
 * 按 ID 批量获取曲目
 * @param ids 曲目 ID
 */
export const getTracksByIds = async (ids: string[]): Promise<Track[]> => {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = await dbQuery<TrackRow>(`SELECT * FROM tracks WHERE id IN (${placeholders})`, ids);
  return rows.map(rowToTrack);
};
