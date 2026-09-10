/**
 * 推荐歌单（未登录通用推荐）
 *
 * params:
 * - limit 返回数量，默认 30
 *
 * 响应：`{ code, result: [{ id, name, picUrl, copywriter, trackCount, ... }] }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const personalized: NeteaseModule = (query, request) =>
  request(
    "/api/personalized/playlist",
    { limit: query.limit ?? 30, total: true, n: 1000 },
    createOption(query, "weapi"),
  );

export default personalized;
