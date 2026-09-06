/**
 * Netease 模块注册表（Android 版）
 *
 * 上游 dev 有百余模块；Android 首批只接登录与播放必需的 8 个，
 * 后续按需从上游同名文件原样补齐（core 层已完整）。
 */

import type { NeteaseModule } from "../core/types";

import login_qr_key from "./login_qr_key";
import login_qr_check from "./login_qr_check";
import login_refresh from "./login_refresh";
import login_status from "./login_status";
import logout from "./logout";
import register_anonimous from "./register_anonimous";
import song_url from "./song_url";
import song_detail from "./song_detail";
import search from "./search";
import cloudsearch from "./cloudsearch";
import search_suggest from "./search_suggest";
import search_hot_detail from "./search_hot_detail";
import lyric from "./lyric";
import lyric_new from "./lyric_new";
import album from "./album";
import album_new from "./album_new";
import artists from "./artists";
import artist_album from "./artist_album";
import artist_songs from "./artist_songs";
import playlist_detail from "./playlist_detail";

export const modules: Record<string, NeteaseModule> = {
  login_qr_key,
  login_qr_check,
  login_refresh,
  login_status,
  logout,
  register_anonimous,
  song_url,
  song_detail,
  search,
  cloudsearch,
  search_suggest,
  search_hot_detail,
  lyric,
  lyric_new,
  album,
  album_new,
  artists,
  artist_album,
  artist_songs,
  playlist_detail,
};
