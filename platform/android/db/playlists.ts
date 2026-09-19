/**
 * 本地歌单 DAO（Android 版）
 *
 * 上游 dev 的 electron/main/database/playlists.ts 同语义异步版；
 * 多语句写操作走 dbTransaction（DbPlugin 侧 begin/commit，崩溃一致性），
 * 大批量参数按上限分块（API<30 的 SQLite 变量上限 999）
 */

import type {
  LegacyPlaylistRecord,
  PlaylistCreateInput,
  PlaylistDetail,
  PlaylistType,
  PlaylistSummary,
  PlaylistUpdateInput,
} from "@shared/types/playlist";
import { chunkByParams, dbQuery, dbRun, dbTransaction } from "./index";
import { getTracksByIds } from "./library";

interface PlaylistRow {
  id: string;
  type: PlaylistType;
  title: string;
  description: string | null;
  cover: string | null;
  track_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * 转换数据库歌单记录
 * @param row 数据库查询结果
 */
const toSummary = (row: PlaylistRow): PlaylistSummary => ({
  id: row.id,
  type: row.type,
  title: row.title,
  description: row.description ?? undefined,
  cover: row.cover ?? undefined,
  trackCount: row.track_count,
  createTime: row.created_at,
  updateTime: row.updated_at,
});

const SELECT_PLAYLIST = `
  SELECT
    p.id,
    p.type,
    p.title,
    p.description,
    p.cover,
    p.created_at,
    p.updated_at,
    COUNT(pt.track_id) AS track_count
  FROM playlists p
  LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
`;

/** 获取全部歌单列表 */
export const getPlaylists = async (): Promise<PlaylistSummary[]> => {
  const rows = await dbQuery<PlaylistRow>(
    `${SELECT_PLAYLIST} WHERE p.type = 'local' GROUP BY p.id ORDER BY p.created_at DESC, p.id`,
  );
  return rows.map(toSummary);
};

/**
 * 获取歌单详情
 * @param id 歌单 ID
 */
export const getPlaylist = async (id: string): Promise<PlaylistDetail | null> => {
  const rows = await dbQuery<PlaylistRow>(
    `${SELECT_PLAYLIST} WHERE p.id = ? AND p.type = 'local' GROUP BY p.id`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const trackRows = await dbQuery<{ track_id: string }>(
    `SELECT pt.track_id
     FROM playlist_tracks pt
     WHERE pt.playlist_id = ?
     ORDER BY pt.position, pt.added_at, pt.track_id`,
    [id],
  );
  const fetched = await getTracksByIds(trackRows.map((item) => item.track_id));
  const byId = new Map(fetched.map((track) => [track.id, track]));
  return {
    ...toSummary(row),
    tracks: trackRows.flatMap((item) => {
      const track = byId.get(item.track_id);
      return track ? [track] : [];
    }),
  };
};

/**
 * 创建歌单
 * @param input 歌单信息
 */
export const createPlaylist = async (input: PlaylistCreateInput): Promise<PlaylistSummary> => {
  const title = input.title.trim();
  if (!title) throw new Error("歌单名称不能为空");
  if (input.type !== "local") throw new Error("歌单类型无效");
  const now = Date.now();
  const id = `pl_${crypto.randomUUID()}`;
  await dbRun(
    `INSERT INTO playlists
      (id, type, title, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.type, title, input.description?.trim() || null, now, now],
  );
  const created = (await getPlaylists()).find((playlist) => playlist.id === id);
  if (!created) throw new Error("歌单创建失败");
  return created;
};

/**
 * 更新歌单信息
 * @param id 歌单 ID
 * @param input 更新内容
 */
export const updatePlaylist = async (
  id: string,
  input: PlaylistUpdateInput,
): Promise<PlaylistSummary | null> => {
  const current = (await getPlaylists()).find((playlist) => playlist.id === id);
  if (!current) return null;
  const title = input.title?.trim() ?? current.title;
  if (!title) throw new Error("歌单名称不能为空");
  await dbRun(
    `UPDATE playlists
     SET title = ?, description = ?, cover = ?, updated_at = ?
     WHERE id = ?`,
    [
      title,
      input.description === undefined ? (current.description ?? null) : input.description || null,
      input.cover === undefined ? (current.cover ?? null) : input.cover || null,
      Date.now(),
      id,
    ],
  );
  return (await getPlaylists()).find((playlist) => playlist.id === id) ?? null;
};

/**
 * 删除歌单
 * @param id 歌单 ID
 */
export const deletePlaylist = async (id: string): Promise<void> => {
  await dbTransaction([
    { sql: "DELETE FROM playlist_tracks WHERE playlist_id = ?", values: [id] },
    { sql: "DELETE FROM playlists WHERE id = ?", values: [id] },
  ]);
};

/**
 * 添加歌曲到歌单
 * @param id 歌单 ID
 * @param trackIds 歌曲 ID
 * @returns 实际新增数量
 */
export const addPlaylistTracks = async (id: string, trackIds: string[]): Promise<number> =>
  withPlaylistLock(id, async () => {
    const playlist = (await getPlaylists()).find((item) => item.id === id);
    if (!playlist || playlist.type !== "local") return 0;
    const uniqueIds = [...new Set(trackIds)];
    if (uniqueIds.length === 0) return 0;
    const existing = await dbQuery<{ track_id: string }>(
      "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?",
      [id],
    );
    const existingIds = new Set(existing.map((item) => item.track_id));
    // 直接过滤已存在项，不校验 tracks 表（Android 无 MediaStore 扫描，tracks 表始终为空）
    const validIds = uniqueIds.filter((trackId) => !existingIds.has(trackId));
    if (validIds.length === 0) return 0;
    const now = Date.now();
    // 追加尾部（对齐上游“添加到歌单”语义）；分块插入避免超 SQLite 变量上限
    const base = existing.length;
    const rows = validIds.map((trackId, position) => [id, trackId, base + position, now]);
    const statements: { sql: string; values?: unknown[] }[] = chunkByParams(rows, 4).map(
      (chunk) => ({
        sql: `INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
          VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}`,
        values: chunk.flat(),
      }),
    );
    // 封面取第一首有封面的曲目（IN 查询同样分块）
    let cover: string | null = null;
    for (const chunk of chunkByParams(validIds, 1)) {
      const coverRows = await dbQuery<{ cover: string | null }>(
        `SELECT cover FROM tracks WHERE id IN (${chunk.map(() => "?").join(",")}) AND cover IS NOT NULL LIMIT 1`,
        chunk,
      );
      if (coverRows[0]?.cover) {
        cover = coverRows[0].cover;
        break;
      }
    }
    statements.push({
      sql: "UPDATE playlists SET cover = COALESCE(?, cover), updated_at = ? WHERE id = ?",
      values: [cover, now, id],
    });
    await dbTransaction(statements);
    return validIds.length;
  });

/**
 * 从本地歌单移除歌曲
 * @param id 歌单 ID
 * @param trackIds 歌曲 ID
 */
export const removePlaylistTracks = async (id: string, trackIds: string[]): Promise<number> =>
  withPlaylistLock(id, async () => {
    const playlist = (await getPlaylists()).find((item) => item.id === id);
    if (!playlist || playlist.type !== "local") return 0;
    const ids = [...new Set(trackIds)];
    if (ids.length === 0) return 0;
    const removed = (
      await Promise.all(
        chunkByParams(ids, 1).map((chunk) =>
          dbRun(
            `DELETE FROM playlist_tracks
             WHERE playlist_id = ? AND track_id IN (${chunk.map(() => "?").join(",")})`,
            [id, ...chunk],
          ),
        ),
      )
    ).reduce((sum, count) => sum + count, 0);
    if (removed === 0) return 0;
    const remaining = await dbQuery<{ track_id: string }>(
      "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position",
      [id],
    );
    // CASE 重排 position，按参数上限分块（每行 2 参数）；各块作用于不相交的 track_id 子集
    // CASE 重排 position，按参数上限分块（每行 2 参数）；块内下标须加全局偏移，
    // 否则第二块起 position 重新从 0 计数、重排后顺序错乱
    let base = 0;
    const statements = chunkByParams(remaining, 2).map((chunk) => {
      const values = chunk.flatMap((item, i) => [item.track_id, base + i]);
      base += chunk.length;
      return {
        sql: `UPDATE playlist_tracks SET position = CASE track_id ${chunk
          .map(() => "WHEN ? THEN ?")
          .join(" ")} END WHERE playlist_id = ?`,
        values: [...values, id],
      };
    });
    statements.push({
      sql: "UPDATE playlists SET cover = CASE WHEN ? = 0 THEN NULL ELSE cover END, updated_at = ? WHERE id = ?",
      values: [remaining.length, Date.now(), id],
    });
    await dbTransaction(statements);
    return removed;
  });

/** 按歌单串行的写锁：async 交错会让两次添加读到同一 existing、position 重叠 */
const playlistWriteLocks = new Map<string, Promise<void>>();
const withPlaylistLock = <T>(id: string, task: () => Promise<T>): Promise<T> => {
  const prev = playlistWriteLocks.get(id) ?? Promise.resolve();
  const current = prev.then(task);
  const settled: Promise<void> = current.then(
    () => undefined,
    () => undefined,
  );
  playlistWriteLocks.set(id, settled);
  void settled.finally(() => {
    if (playlistWriteLocks.get(id) === settled) playlistWriteLocks.delete(id);
  });
  return current;
};

/**
 * 导入旧版 renderer 本地歌单
 * @param records IndexedDB 歌单记录
 */
export const importLegacyPlaylists = async (records: LegacyPlaylistRecord[]): Promise<void> => {
  if (records.length === 0) return;
  const now = Date.now();
  for (const record of records) {
    const createdAt = record.createTime ?? now;
    const updatedAt = record.updateTime ?? createdAt;
    // 逐歌单整体事务：中途失败不留下半份歌单
    const statements = [
      {
        sql: `INSERT OR IGNORE INTO playlists
              (id, type, title, description, cover, created_at, updated_at)
             VALUES (?, 'local', ?, ?, ?, ?, ?)`,
        values: [
          record.id,
          record.title,
          record.description ?? null,
          record.cover ?? null,
          createdAt,
          updatedAt,
        ],
      },
      ...chunkByParams(
        record.trackIds.map((trackId, position) => ({ trackId, position })),
        4,
      ).map((chunk) => ({
        sql: `INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
              VALUES ${chunk.map(() => "(?,?,?,?)").join(",")}`,
        values: chunk.flatMap(({ trackId, position }) => [record.id, trackId, position, updatedAt]),
      })),
    ];
    await dbTransaction(statements);
  }
};

/** 清空全部歌单及歌曲关系 */
export const clearPlaylists = async (): Promise<void> => {
  await dbTransaction([{ sql: "DELETE FROM playlist_tracks" }, { sql: "DELETE FROM playlists" }]);
};
