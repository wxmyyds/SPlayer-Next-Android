/**
 * Netease 模块注册表（Android 版）
 *
 * 上游 dev 有百余模块；Android 按需从上游同名文件原样补齐（core 层已完整）。
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
import comment_hot from "./comment_hot";
import comment_music from "./comment_music";
import album from "./album";
import album_new from "./album_new";
import artists from "./artists";
import artist_album from "./artist_album";
import artist_songs from "./artist_songs";
import playlist_detail from "./playlist_detail";
import user_playlist from "./user_playlist";
import user_subcount from "./user_subcount";
import user_account from "./user_account";
import user_level from "./user_level";
import likelist from "./likelist";
import like from "./like";
import like_v1 from "./like_v1";
import album_sublist from "./album_sublist";
import artist_sublist from "./artist_sublist";
import personalized from "./personalized";
import top_artists from "./top_artists";
import recommend_resource from "./recommend_resource";
import recommend_songs from "./recommend_songs";
import personal_fm from "./personal_fm";
import fm_trash from "./fm_trash";
import playmode_intelligence from "./playmode_intelligence";
import playlist_create from "./playlist_create";
import playlist_delete from "./playlist_delete";
import playlist_desc_update from "./playlist_desc_update";
import playlist_name_update from "./playlist_name_update";
import playlist_order_update from "./playlist_order_update";
import playlist_subscribe from "./playlist_subscribe";
import playlist_tracks from "./playlist_tracks";
import album_sub from "./album_sub";
import artist_sub from "./artist_sub";
import song_download_url from "./song_download_url";
import user_cloud from "./user_cloud";
import user_cloud_del from "./user_cloud_del";

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
  comment_hot,
  comment_music,
  album,
  album_new,
  artists,
  artist_album,
  artist_songs,
  playlist_detail,
  user_playlist,
  user_subcount,
  user_account,
  user_level,
  likelist,
  like,
  like_v1,
  album_sublist,
  artist_sublist,
  personalized,
  top_artists,
  recommend_resource,
  recommend_songs,
  personal_fm,
  fm_trash,
  playmode_intelligence,
  playlist_create,
  playlist_delete,
  playlist_desc_update,
  playlist_name_update,
  playlist_order_update,
  playlist_subscribe,
  playlist_tracks,
  album_sub,
  artist_sub,
  song_download_url,
  user_cloud,
  user_cloud_del,
};
