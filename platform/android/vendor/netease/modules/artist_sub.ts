/**
 * 收藏 / 取消收藏歌手
 *
 * params:
 * - id 歌手 id
 * - t  1 收藏，其他取消
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const artistSub: NeteaseModule = (query, request) => {
  const path = query.t == 1 ? "sub" : "unsub";
  return request(
    `/api/artist/${path}`,
    { artistId: query.id, artistIds: `[${query.id}]` },
    createOption(query, "weapi"),
  );
};

export default artistSub;
