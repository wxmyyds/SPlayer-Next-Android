/**
 * 私人 FM 垃圾桶（不再推荐该曲）
 *
 * params:
 * - id   歌曲 id
 * - time 秒数，默认 25
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const fmTrash: NeteaseModule = (query, request) =>
  request(
    "/api/radio/trash/add",
    { songId: query.id, alg: "RT", time: query.time ?? 25 },
    createOption(query, "weapi"),
  );

export default fmTrash;
