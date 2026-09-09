/**
 * SQLite 驱动（Android 版）
 *
 * 上游 dev 用 better-sqlite3 同步 API；Android 用原生 DbPlugin（内置 SQLite，WAL），
 * 这里做一层 async DAO 适配：业务代码只调本文件的 query/run/exec，不直接碰插件。
 * 表结构与上游 electron/main/database/index.ts 一致（建表 SQL 原样拷贝）。
 */

import { registerPlugin, WebPlugin } from "@capacitor/core";

/** 原生库桥接口 */
interface SPlayerDbPlugin {
  exec: (options: { sql: string }) => Promise<void>;
  run: (options: {
    sql: string;
    values?: unknown[];
  }) => Promise<{ lastInsertRowId: number; changes: number }>;
  query: (options: { sql: string; values?: unknown[] }) => Promise<{
    values: Record<string, unknown>[];
  }>;
}

/** 非原生环境回退：直接抛错（VITE_PLATFORM=android 只跑真机/CI 构建） */
class SPlayerDbWeb extends WebPlugin implements SPlayerDbPlugin {
  async exec(): Promise<void> {
    throw new Error("SPlayerDb is native only");
  }
  async run(): Promise<{ lastInsertRowId: number; changes: number }> {
    throw new Error("SPlayerDb is native only");
  }
  async query(): Promise<{ values: Record<string, unknown>[] }> {
    throw new Error("SPlayerDb is native only");
  }
}

const SPlayerDb = registerPlugin<SPlayerDbPlugin>("SPlayerDb", {
  web: () => new SPlayerDbWeb(),
});

/** 与上游一致的建表语句（tracks 空表占位供校验；playlists / history 先行，其余随功能补） */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  cue_path TEXT,
  cue_audio_path TEXT,
  cue_start_ms INTEGER,
  cue_end_ms INTEGER,
  title TEXT NOT NULL,
  track INTEGER,
  artists TEXT NOT NULL DEFAULT '[]',
  album TEXT,
  duration INTEGER NOT NULL,
  cover TEXT,
  codec TEXT,
  sample_rate INTEGER,
  bit_rate INTEGER,
  channels INTEGER,
  bits_per_sample INTEGER,
  file_size INTEGER NOT NULL,
  file_mtime INTEGER,
  file_ctime INTEGER,
  scanned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  listened_ms INTEGER NOT NULL,
  track_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_play_history_started ON play_history(started_at);
CREATE INDEX IF NOT EXISTS idx_play_history_track ON play_history(source, track_id);
CREATE TABLE IF NOT EXISTS favorite_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  at INTEGER NOT NULL,
  track_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favorite_history_at ON favorite_history(at);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type = 'local'),
  title TEXT NOT NULL,
  description TEXT,
  cover TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playlists_type ON playlists(type, updated_at DESC);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_position ON playlist_tracks(playlist_id, position);
`;

let schemaReady: Promise<void> | null = null;

/** 确保建表（进程内一次；首次失败不缓存，每次重试重新建表） */
const ensureSchema = (): Promise<void> => {
  if (!schemaReady) {
    const p = SPlayerDb.exec({ sql: SCHEMA }).catch((e) => {
      schemaReady = null;
      throw e;
    });
    schemaReady = p;
  }
  return schemaReady;
};

/**
 * 查询（SELECT）
 * @param sql SQL（? 占位）
 * @param values 绑定值
 * @returns 行数组
 */
export const dbQuery = async <T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> => {
  await ensureSchema();
  const res = await SPlayerDb.query({ sql, values });
  return (res.values ?? []) as T[];
};

/**
 * 写入（INSERT/UPDATE/DELETE）
 * @param sql SQL（? 占位）
 * @param values 绑定值
 * @returns 变更行数
 */
export const dbRun = async (sql: string, values: unknown[] = []): Promise<number> => {
  await ensureSchema();
  const res = await SPlayerDb.run({ sql, values });
  return res.changes ?? 0;
};
