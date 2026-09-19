/**
 * 获取客户端歌曲下载链接
 *
 * params:
 * - id 歌曲 id
 * - level 音质（NETEASE_LEVEL 词表：standard/higher/exhigh/lossless/hires），映射为码率
 * - br 码率（直传时优先），默认 999000
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const LEVEL_BR: Record<string, number> = {
  standard: 128000,
  higher: 192000,
  exhigh: 320000,
  lossless: 999000,
  hires: 999000,
};

const songDownloadUrl: NeteaseModule = (query, request) => {
  // 调用方传 level 而非 br：不映射则永远按最高码率请求，用户选 LQ 也拿全尺寸无损
  const br = query.br != null ? Number(query.br) : (LEVEL_BR[String(query.level)] ?? 999000);
  return request("/api/song/enhance/download/url", { id: query.id, br }, createOption(query));
};

export default songDownloadUrl;
