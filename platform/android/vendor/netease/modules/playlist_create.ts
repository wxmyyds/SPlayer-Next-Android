/**
 * 创建歌单
 *
 * params:
 * - name    歌单名
 * - privacy 0 普通歌单，10 隐私歌单
 * - type    NORMAL / VIDEO / SHARED
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playlistCreate: NeteaseModule = (query, request) =>
  request(
    "/api/playlist/create",
    {
      name: query.name,
      privacy: query.privacy ?? "0",
      type: query.type ?? "NORMAL",
    },
    createOption(query, "weapi"),
  );

export default playlistCreate;
