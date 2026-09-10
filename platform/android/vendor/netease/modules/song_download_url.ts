/**
 * 获取客户端歌曲下载链接
 *
 * params:
 * - id 歌曲 id
 * - br 码率，默认 999000
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const songDownloadUrl: NeteaseModule = (query, request) =>
  request(
    "/api/song/enhance/download/url",
    { id: query.id, br: Number(query.br ?? 999000) },
    createOption(query),
  );

export default songDownloadUrl;
