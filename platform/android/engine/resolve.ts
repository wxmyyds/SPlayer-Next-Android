/**
 * 引擎解析面：vendor 调用 + 请求/响应协议
 *
 * Rust 壳经 globalThis.__engineResolve(reqJson) 调用，返回 JSON 字符串。
 * cookie 由调用方（nextTrackQueue 组装的 header）透传，与 WebView 内
 * eapi 自解同源。
 */

import { callNetease } from "../vendor/netease";

/** 引擎解析请求 */
export interface ResolveRequest {
  /** 歌曲 id（netease songId） */
  songId: string;
  /** 音质 level（已由 JS 侧 NETEASE_LEVEL 映射） */
  level: string;
  /** 登录 cookie（header 形式字符串，可空） */
  cookie?: string;
}

/** 引擎解析响应 */
export interface ResolveResponse {
  ok: boolean;
  url?: string;
  /** 试听片段标记 */
  trial?: boolean;
  error?: string;
}

/**
 * 解析网易云播放地址（与 WebView 内 callNetease 同一份 vendor 代码）
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
    const params: Record<string, unknown> = { id: req.songId, level: req.level };
    if (req.cookie) params.cookie = req.cookie;
    const res = await callNetease("song_url", params);
    const body = res.body as
      { code?: number; data?: Array<{ url: string | null; freeTrialInfo?: unknown }> } | undefined;
    const first = body?.data?.[0];
    if (body?.code !== 200 || !first?.url) {
      return JSON.stringify({
        ok: false,
        error: `no url (code=${body?.code ?? "unknown"})`,
      } satisfies ResolveResponse);
    }
    return JSON.stringify({
      ok: true,
      url: first.url,
      trial: first.freeTrialInfo != null,
    } satisfies ResolveResponse);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ResolveResponse);
  }
};
