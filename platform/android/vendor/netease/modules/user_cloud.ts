/**
 * 云盘数据
 *
 * params:
 * - limit / offset 分页
 *
 * 响应：`{ code, count, data: [...], hasMore }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const userCloud: NeteaseModule = (query, request) =>
  request(
    "/api/v1/cloud/get",
    { limit: query.limit ?? 30, offset: query.offset ?? 0 },
    createOption(query, "weapi"),
  );

export default userCloud;
