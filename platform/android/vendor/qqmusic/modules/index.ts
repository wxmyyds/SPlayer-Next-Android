/**
 * QM 模块注册表（Android 版）
 *
 * 上游 dev 有十余模块；Android 首批只接登录与播放必需的 4 个，
 * 后续按需从上游同名文件原样补齐（core 层已完整）。
 */

import type { QMModule } from "../core/types";

import user_detail from "./user_detail";
import song_url from "./song_url";
import search from "./search";
import lyric from "./lyric";
import { login_qr_key, login_qr_check } from "./login_qr";

export const modules: Record<string, QMModule> = {
  user_detail,
  song_url,
  search,
  lyric,
  login_qr_key,
  login_qr_check,
};
