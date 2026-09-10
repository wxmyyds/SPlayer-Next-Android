/**
 * 云盘歌曲删除
 *
 * params:
 * - id 歌曲 id
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const userCloudDel: NeteaseModule = (query, request) =>
  request("/api/cloud/del", { songIds: [query.id] }, createOption(query, "weapi"));

export default userCloudDel;
