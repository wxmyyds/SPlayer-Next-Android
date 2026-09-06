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

export const modules: Record<string, NeteaseModule> = {
  login_qr_key,
  login_qr_check,
  login_refresh,
  login_status,
  logout,
  register_anonimous,
  song_url,
  song_detail,
};
