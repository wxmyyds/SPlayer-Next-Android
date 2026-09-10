/**
 * 收藏 / 取消收藏歌单
 *
 * params:
 * - id 歌单 id
 * - t  1 收藏，其他取消
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playlistSubscribe: NeteaseModule = (query, request) => {
  const path = query.t == 1 ? "subscribe" : "unsubscribe";
  return request(`/api/playlist/${path}`, { id: query.id }, createOption(query, "eapi"));
};

export default playlistSubscribe;
