/**
 * 音源 API 统一分发（Android 版）
 *
 * 逻辑与上游 dev 的 electron/main/ipc/apis.ts 逐条对应，
 * 只是把主进程 IPC 句柄换成 renderer 内直接调用 vendor 实现。
 */

import { callNetease, clearNeteaseCookies, mergeNeteaseCookies } from "./netease";
import { NeteaseRequestError } from "./netease/core/request";
import { cookieToJson } from "./netease/core/cookie";
import { callQQMusic, clearQQMusicCookies, mergeQQMusicCookies } from "./qqmusic";
import { callKugou, clearKugouSession, mergeKugouSession } from "./kugou";
import { coreLog } from "@main/utils/logger";
import type { ApiCallResponse, ApiPlatform } from "@shared/types/apis";

/**
 * 调用对应平台的任意接口
 * @param platform 音源平台
 * @param name 接口名
 * @param params 接口参数
 * @returns 成功 `{ ok: true, ... }`；失败 `{ ok: false, error }`
 */
export const callVendorApi = async (
  platform: ApiPlatform,
  name: string,
  params: Record<string, unknown> = {},
): Promise<ApiCallResponse> => {
  try {
    switch (platform) {
      case "netease": {
        const res = await callNetease(name, params);
        return { ok: true, status: res.status, body: res.body };
      }
      case "qqmusic": {
        const data = await callQQMusic(name, params);
        return { ok: true, data };
      }
      case "kugou": {
        const data = await callKugou(name, params);
        return { ok: true, data };
      }
      default:
        throw new Error(`unknown platform: ${platform}`);
    }
  } catch (err) {
    coreLog.warn(`[apis] ${platform}.${name} failed:`, err);
    if (platform === "netease" && err instanceof NeteaseRequestError) {
      return {
        ok: false,
        error: err.message,
        status: err.response.status,
        body: err.response.body,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * 清空某平台登录态
 * @param platform 音源平台
 */
export const clearVendorSession = (platform: ApiPlatform): void => {
  if (platform === "netease") clearNeteaseCookies();
  if (platform === "qqmusic") clearQQMusicCookies();
  if (platform === "kugou") clearKugouSession();
};

/**
 * 打开官方网页登录（Android 暂不支持，各平台均走二维码/手动 Cookie 登录）
 * @param platform 音源平台
 * @returns 固定返回失败
 */
export const openVendorLoginWeb = (
  platform: ApiPlatform,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  void platform;
  return Promise.resolve({ ok: false, error: "unsupported" });
};

/**
 * 手动写入 cookie 登录
 * @param platform 音源平台
 * @param raw 形如 `MUSIC_U=xxx` 的 cookie 字符串
 * @returns 成功 `{ ok: true }`；缺关键字段 `{ ok: false, error }`
 */
export const setVendorCookie = (
  platform: ApiPlatform,
  raw: string,
): { ok: true } | { ok: false; error: string } => {
  const parsed = cookieToJson(raw);
  if (platform === "netease") {
    if (!parsed.MUSIC_U) return { ok: false, error: "missing MUSIC_U" };
    mergeNeteaseCookies(parsed);
    return { ok: true };
  }
  if (platform === "qqmusic") {
    if (!parsed.uin && !parsed.wxuin && !parsed.p_uin && !parsed.qm_keyst && !parsed.qqmusic_key) {
      return { ok: false, error: "missing uin or key" };
    }
    mergeQQMusicCookies(parsed);
    return { ok: true };
  }
  if (platform === "kugou") {
    if (!parsed.token || !parsed.userid) {
      return { ok: false, error: "missing token or userid" };
    }
    mergeKugouSession(parsed);
    return { ok: true };
  }
  return { ok: false, error: "unsupported platform" };
};
