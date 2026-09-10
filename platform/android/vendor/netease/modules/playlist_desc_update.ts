/**
 * 更新歌单描述
 *
 * params:
 * - id   歌单 id
 * - desc 新描述
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playlistDescUpdate: NeteaseModule = (query, request) =>
  request("/api/playlist/desc/update", { id: query.id, desc: query.desc }, createOption(query));

export default playlistDescUpdate;
