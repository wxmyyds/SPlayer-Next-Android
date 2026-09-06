/**
 * KG 模块注册表（Android 版）
 *
 * 上游 dev 有 9 个模块；Android 首批只接登录与播放必需的 4 个，
 * 后续按需从上游同名文件原样补齐（core 层已完整）。
 */

import type { KGModule } from "../core/types";

import userDetail from "./user_detail";
import { loginQrCheck, loginQrKey } from "./login_qr";
import songUrl from "./song_url";

export const modules: Record<string, KGModule> = {
  user_detail: userDetail,
  login_qr_key: loginQrKey,
  login_qr_check: loginQrCheck,
  song_url: songUrl,
};
