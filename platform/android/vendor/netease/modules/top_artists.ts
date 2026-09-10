/**
 * 热门歌手
 *
 * params:
 * - limit / offset 分页
 *
 * 响应：`{ code, artists: NeteaseArtist[] }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const topArtists: NeteaseModule = (query, request) =>
  request(
    "/api/artist/top",
    { limit: query.limit ?? 50, offset: query.offset ?? 0, total: true },
    createOption(query, "weapi"),
  );

export default topArtists;
