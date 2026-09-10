/**
 * 收藏单曲到歌单 / 从歌单删除歌曲
 *
 * params:
 * - op     add 或 del
 * - pid    歌单 id
 * - tracks 歌曲 id，逗号分隔
 *
 * 接口偶尔返回 512（数量校验误判），按上游做法把 ids 复制一份重试
 */

import { createOption } from "../core/option";
import { NeteaseRequestError } from "../core/request";
import type { NeteaseModule } from "../core/types";

const playlistTracks: NeteaseModule = async (query, request) => {
  const tracks = String(query.tracks ?? "").split(",");
  const data = {
    op: query.op,
    pid: query.pid,
    trackIds: JSON.stringify(tracks),
    imme: "true",
  };
  try {
    return await request("/api/playlist/manipulate/tracks", data, createOption(query));
  } catch (error) {
    const code = error instanceof NeteaseRequestError ? error.response.body?.code : undefined;
    if (code === 512) {
      return request(
        "/api/playlist/manipulate/tracks",
        { ...data, trackIds: JSON.stringify([...tracks, ...tracks]) },
        createOption(query),
      );
    }
    throw error;
  }
};

export default playlistTracks;
