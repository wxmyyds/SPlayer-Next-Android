/**
 * 更新歌单名
 *
 * params:
 * - id   歌单 id
 * - name 新名称
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playlistNameUpdate: NeteaseModule = (query, request) =>
  request("/api/playlist/update/name", { id: query.id, name: query.name }, createOption(query));

export default playlistNameUpdate;
