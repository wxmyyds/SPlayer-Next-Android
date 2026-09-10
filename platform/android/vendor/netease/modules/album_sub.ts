/**
 * 收藏 / 取消收藏专辑
 *
 * params:
 * - id 专辑 id
 * - t  1 收藏，其他取消
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const albumSub: NeteaseModule = (query, request) => {
  const path = query.t == 1 ? "sub" : "unsub";
  return request(`/api/album/${path}`, { id: query.id }, createOption(query, "weapi"));
};

export default albumSub;
