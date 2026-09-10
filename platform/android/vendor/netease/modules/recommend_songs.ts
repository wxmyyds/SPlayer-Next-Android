/**
 * 每日推荐歌曲（需登录）
 *
 * 响应：`{ code, data: { dailySongs: NeteaseSong[] } }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const recommendSongs: NeteaseModule = (query, request) =>
  request(
    "/api/v3/discovery/recommend/songs",
    { afresh: query.afresh },
    createOption(query, "weapi"),
  );

export default recommendSongs;
