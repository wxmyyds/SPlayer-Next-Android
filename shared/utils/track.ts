import type { Artist } from "../types/player";

/**
 * 获取有效的歌手记录
 * @param artists - 歌手数组
 * @returns 过滤掉 name 为空的歌手记录
 */
export const getValidArtists = (artists?: Artist[]): Artist[] =>
  (artists ?? []).filter((artist) => artist.name.trim().length > 0);
