/**
 * 歌曲播放地址（weapi 兜底版）
 *
 * 主 song_url 走 xeapi（interface3），该 host 偶发首包 stall 十几二十秒；
 * 超时后降级到本接口（music.163.com/weapi，常走预热连接）快速拿地址。
 * weapi 最高 320k，兜底够用；响应形状与 xeapi 一致（data 数组首元素）。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

/** 项目音质档位 → weapi br（码率） */
const BR_FALLBACK: Record<string, number> = {
  standard: 128000,
  higher: 192000,
  exhigh: 320000,
  lossless: 320000,
  hires: 320000,
};

const song_url_weapi: NeteaseModule = (query, request) => {
  const ids = String(query.id ?? query.ids ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const level = String(query.level ?? query.br ?? "exhigh");
  const br = Number(query.br ?? BR_FALLBACK[level] ?? 320000);
  const data = { ids, br };
  return request("/api/song/enhance/player/url", data, createOption(query, "weapi"));
};

export default song_url_weapi;
