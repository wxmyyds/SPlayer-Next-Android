/**
 * 删除歌单
 *
 * params:
 * - id 歌单 id
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playlistDelete: NeteaseModule = (query, request) =>
  request("/api/playlist/remove", { ids: `[${query.id}]` }, createOption(query, "weapi"));

export default playlistDelete;
