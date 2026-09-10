/**
 * 心动模式 / 智能播放
 *
 * params:
 * - id  起始歌曲 id
 * - pid 歌单 id
 * - sid 可选的起始歌曲 id（缺省同 id）
 * - count 返回数量，默认 1
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const playmodeIntelligence: NeteaseModule = (query, request) =>
  request(
    "/api/playmode/intelligence/list",
    {
      songId: query.id,
      type: "fromPlayOne",
      playlistId: query.pid,
      startMusicId: query.sid ?? query.id,
      count: query.count ?? 1,
    },
    createOption(query),
  );

export default playmodeIntelligence;
