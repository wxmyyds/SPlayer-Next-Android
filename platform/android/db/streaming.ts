/**
 * 流媒体媒体库 SQLite DAO（Android 版）
 *
 * 上游 electron/main/database/streaming/* 用 better-sqlite3 同步 API；
 * 这里按 db/index.ts 的 async DAO 约定移植，表结构与上游一致。
 * 批量写入用多值元组分块，减少 IPC 往返。
 */

import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import { dbQuery, dbRun } from "./index";

/** 每条 INSERT 语句的行数上限（remote_tracks 7 列 × 40 行 = 280 参数，远低于 SQLITE_MAX_VARIABLE_NUMBER） */
const INSERT_CHUNK = 40;

interface DataRow {
  data: string;
}

/** 组装多值 INSERT ... ON CONFLICT DO UPDATE（列数因表而异） */
const chunkedUpsert = async (
  table: string,
  columns: string[],
  conflictKeys: string[],
  rows: unknown[][],
): Promise<void> => {
  const width = columns.length;
  const placeholder = `(${columns.map(() => "?").join(", ")})`;
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const chunk = rows.slice(start, start + INSERT_CHUNK);
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk
      .map(() => placeholder)
      .join(", ")}
      ON CONFLICT(${conflictKeys.join(", ")}) DO UPDATE SET
      ${columns
        .filter((column) => !conflictKeys.includes(column))
        .map((column) => `${column} = excluded.${column}`)
        .join(", ")}`;
    await dbRun(sql, chunk.flat());
  }
};

interface TrackRecord {
  serverId: string;
  remoteId: string;
  track: Track;
  generation: number;
}

const trackSearchText = (track: Track): string =>
  [track.title, track.album?.name, ...track.artists.map((artist) => artist.name)]
    .filter(Boolean)
    .join("\n");

/**
 * 批量写入流媒体歌曲
 * @param records - 流媒体歌曲记录
 */
export const upsertTracks = async (records: TrackRecord[]): Promise<void> => {
  if (records.length === 0) return;
  const now = Date.now();
  await chunkedUpsert(
    "remote_tracks",
    ["server_id", "remote_id", "data", "title", "search_text", "generation", "updated_at"],
    ["server_id", "remote_id"],
    records.map((record) => [
      record.serverId,
      record.remoteId,
      JSON.stringify(record.track),
      record.track.title,
      trackSearchText(record.track),
      record.generation,
      now,
    ]),
  );
};

/**
 * 获取指定服务器的完整歌曲列表
 * @param serverId - 服务器 ID
 * @returns 完整歌曲列表
 */
export const getTracks = async (serverId: string): Promise<Track[]> => {
  const rows = await dbQuery<DataRow>(
    "SELECT data FROM remote_tracks WHERE server_id = ? ORDER BY title COLLATE NOCASE, remote_id",
    [serverId],
  );
  return rows.map((row) => JSON.parse(row.data) as Track);
};

/**
 * 搜索指定服务器的歌曲
 * @param serverId - 服务器 ID
 * @param query - 搜索词
 * @returns 匹配的歌曲列表
 */
export const searchTracks = async (serverId: string, query: string): Promise<Track[]> => {
  const escaped = query
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  if (!escaped) return [];
  const rows = await dbQuery<DataRow>(
    `SELECT data FROM remote_tracks
     WHERE server_id = ? AND search_text LIKE ? ESCAPE '\\'
     ORDER BY title COLLATE NOCASE, remote_id`,
    [serverId, `%${escaped}%`],
  );
  return rows.map((row) => JSON.parse(row.data) as Track);
};

/**
 * 删除指定服务器的旧同步数据
 * @param serverId - 服务器 ID
 * @param generation - 当前同步代次
 */
export const deleteStaleTracks = async (serverId: string, generation: number): Promise<void> => {
  await dbRun("DELETE FROM remote_tracks WHERE server_id = ? AND generation <> ?", [
    serverId,
    generation,
  ]);
};

/**
 * 删除指定服务器的全部歌曲
 * @param serverId - 服务器 ID
 */
export const deleteTracksByServer = async (serverId: string): Promise<void> => {
  await dbRun("DELETE FROM remote_tracks WHERE server_id = ?", [serverId]);
};

/** 专辑/歌手/歌单共用的简单记录（无搜索列） */
type NamedRecord = {
  serverId: string;
  remoteId: string;
  data: Album | Artist | Playlist;
  generation: number;
};

const upsertNamed = async (table: string, records: NamedRecord[]): Promise<void> => {
  if (records.length === 0) return;
  const now = Date.now();
  await chunkedUpsert(
    table,
    ["server_id", "remote_id", "data", "name", "generation", "updated_at"],
    ["server_id", "remote_id"],
    records.map((record) => [
      record.serverId,
      record.remoteId,
      JSON.stringify(record.data),
      record.data.name,
      record.generation,
      now,
    ]),
  );
};

const getNamed = async <T extends { name: string }>(
  table: string,
  serverId: string,
): Promise<T[]> => {
  const rows = await dbQuery<DataRow>(
    `SELECT data FROM ${table} WHERE server_id = ? ORDER BY name COLLATE NOCASE, remote_id`,
    [serverId],
  );
  return rows.map((row) => JSON.parse(row.data) as T);
};

const deleteStaleNamed = async (
  table: string,
  serverId: string,
  generation: number,
): Promise<void> => {
  await dbRun(`DELETE FROM ${table} WHERE server_id = ? AND generation <> ?`, [
    serverId,
    generation,
  ]);
};

const deleteNamedByServer = async (table: string, serverId: string): Promise<void> => {
  await dbRun(`DELETE FROM ${table} WHERE server_id = ?`, [serverId]);
};

/**
 * 批量写入流媒体专辑
 * @param records - 流媒体专辑记录
 */
export const upsertAlbums = (
  records: { serverId: string; remoteId: string; album: Album; generation: number }[],
): Promise<void> =>
  upsertNamed(
    "remote_albums",
    records.map((record) => ({ ...record, data: record.album })),
  );

/**
 * 批量写入流媒体歌手
 * @param records - 流媒体歌手记录
 */
export const upsertArtists = (
  records: { serverId: string; remoteId: string; artist: Artist; generation: number }[],
): Promise<void> =>
  upsertNamed(
    "remote_artists",
    records.map((record) => ({ ...record, data: record.artist })),
  );

/**
 * 批量写入流媒体歌单
 * @param records - 流媒体歌单记录
 */
export const upsertPlaylists = (
  records: { serverId: string; remoteId: string; playlist: Playlist; generation: number }[],
): Promise<void> =>
  upsertNamed(
    "remote_playlists",
    records.map((record) => ({ ...record, data: record.playlist })),
  );

/**
 * 获取指定服务器的专辑列表
 * @param serverId - 服务器 ID
 * @returns 专辑列表
 */
export const getAlbums = (serverId: string): Promise<Album[]> =>
  getNamed<Album>("remote_albums", serverId);

/**
 * 获取指定服务器的歌手列表
 * @param serverId - 服务器 ID
 * @returns 歌手列表
 */
export const getArtists = (serverId: string): Promise<Artist[]> =>
  getNamed<Artist>("remote_artists", serverId);

/**
 * 获取指定服务器的歌单列表
 * @param serverId - 服务器 ID
 * @returns 歌单列表
 */
export const getPlaylists = (serverId: string): Promise<Playlist[]> =>
  getNamed<Playlist>("remote_playlists", serverId);

/**
 * 删除指定服务器的旧同步专辑
 * @param serverId - 服务器 ID
 * @param generation - 当前同步代次
 */
export const deleteStaleAlbums = (serverId: string, generation: number): Promise<void> =>
  deleteStaleNamed("remote_albums", serverId, generation);

/**
 * 删除指定服务器的旧同步歌手
 * @param serverId - 服务器 ID
 * @param generation - 当前同步代次
 */
export const deleteStaleArtists = (serverId: string, generation: number): Promise<void> =>
  deleteStaleNamed("remote_artists", serverId, generation);

/**
 * 删除指定服务器的旧同步歌单
 * @param serverId - 服务器 ID
 * @param generation - 当前同步代次
 */
export const deleteStalePlaylists = (serverId: string, generation: number): Promise<void> =>
  deleteStaleNamed("remote_playlists", serverId, generation);

/**
 * 删除指定服务器的全部专辑
 * @param serverId - 服务器 ID
 */
export const deleteAlbumsByServer = (serverId: string): Promise<void> =>
  deleteNamedByServer("remote_albums", serverId);

/**
 * 删除指定服务器的全部歌手
 * @param serverId - 服务器 ID
 */
export const deleteArtistsByServer = (serverId: string): Promise<void> =>
  deleteNamedByServer("remote_artists", serverId);

/**
 * 删除指定服务器的全部歌单
 * @param serverId - 服务器 ID
 */
export const deletePlaylistsByServer = (serverId: string): Promise<void> =>
  deleteNamedByServer("remote_playlists", serverId);
