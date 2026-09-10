/**
 * 编辑歌单顺序
 *
 * params:
 * - ids 歌单 id 列表（字符串形式）
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playlistOrderUpdate: NeteaseModule = (query, request) =>
  request("/api/playlist/order/update", { ids: query.ids }, createOption(query, "weapi"));

export default playlistOrderUpdate;
