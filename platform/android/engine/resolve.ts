/**
 * 引擎解析面：vendor 调用 + 请求/响应协议
 *
 * Rust 壳经 globalThis.__engineResolve(reqJson) 调用，返回 JSON 字符串。
 * 走与 WebView 完全同源的 vendor 分发（netease / kugou / qqmusic）；
 * kugou / qq 登录态由 JS 队列推送种子（引擎存储与 WebView 隔离）。
 */

import { callNetease } from "../vendor/netease";
import { callKugou, mergeKugouSession } from "../vendor/kugou";
import { callQQMusic, mergeQQMusicCookies } from "../vendor/qqmusic";

/** 引擎解析请求 */
export interface ResolveRequest {
  /** 音源平台 */
  platform: "netease" | "kugou" | "qqmusic";
  /** 歌曲 id：netease songId / kugou hash / qq mid */
  songId: string;
  /** 音质 level（已由 JS 侧映射到平台语义） */
  level: string;
  /** netease 登录 cookie（header 形式字符串，可空） */
  cookie?: string;
  /** kugou 音频 id */
  extId?: string;
  /** kugou 专辑 id */
  albumId?: string;
  /** qq 歌曲 mediaMid */
  mediaId?: string;
  /** kugou / qq 登录态种子（引擎存储与 WebView 隔离，每次解析前覆写） */
  sessions?: {
    kugou?: Record<string, string>;
    qqmusic?: Record<string, string>;
  };
}

/** 引擎解析响应 */
export interface ResolveResponse {
  ok: boolean;
  url?: string;
  /** 试听片段标记 */
  trial?: boolean;
  error?: string;
}

/** netease 解析（eapi/xeapi 走 vendor 原路径） */
const resolveNetease = async (req: ResolveRequest): Promise<ResolveResponse> => {
  const params: Record<string, unknown> = { id: req.songId, level: req.level };
  if (req.cookie) params.cookie = req.cookie;
  const res = await callNetease("song_url", params);
  const body = res.body as
    { code?: number; data?: Array<{ url: string | null; freeTrialInfo?: unknown }> } | undefined;
  const first = body?.data?.[0];
  if (body?.code !== 200 || !first?.url) {
    return { ok: false, error: `no url (code=${body?.code ?? "unknown"})` };
  }
  return { ok: true, url: first.url, trial: first.freeTrialInfo != null };
};

/** kugou 解析（hash + audioId + albumId） */
const resolveKugou = async (req: ResolveRequest): Promise<ResolveResponse> => {
  if (req.sessions?.kugou) mergeKugouSession(req.sessions.kugou);
  const result = (await callKugou("song_url", {
    hash: req.songId,
    audioId: req.extId,
    albumId: req.albumId,
    level: req.level,
  })) as { code?: number; data?: { url?: string } } | undefined;
  if (result?.code !== 200 || !result.data?.url) {
    return { ok: false, error: `no url (code=${result?.code ?? "unknown"})` };
  }
  return { ok: true, url: result.data.url };
};

/** qqmusic 解析（mid + mediaMid） */
const resolveQQMusic = async (req: ResolveRequest): Promise<ResolveResponse> => {
  if (req.sessions?.qqmusic) mergeQQMusicCookies(req.sessions.qqmusic);
  const body = (await callQQMusic("song_url", {
    mid: req.songId,
    mediaMid: req.mediaId,
    level: req.level,
  })) as { data?: Array<{ url?: string }> } | undefined;
  const first = body?.data?.[0];
  if (!first?.url) {
    return { ok: false, error: "no url" };
  }
  return { ok: true, url: first.url };
};

/**
 * 引擎解析入口（按平台分发，与 WebView 内解析同一份 vendor 代码）
 * @param reqJson - ResolveRequest JSON
 * @returns ResolveResponse JSON
 */
export const engineResolve = async (reqJson: string): Promise<string> => {
  let req: ResolveRequest;
  try {
    req = JSON.parse(reqJson) as ResolveRequest;
  } catch {
    return JSON.stringify({ ok: false, error: "bad request json" } satisfies ResolveResponse);
  }
  try {
    let res: ResolveResponse;
    if (req.platform === "kugou") res = await resolveKugou(req);
    else if (req.platform === "qqmusic") res = await resolveQQMusic(req);
    else res = await resolveNetease(req);
    return JSON.stringify(res);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ResolveResponse);
  }
};
