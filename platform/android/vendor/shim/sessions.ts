/**
 * 会话 Cookie 存储垫片（Android 版）
 *
 * 上游 dev 存在 SQLite sessions 表；Android 的 vendor 先用 localStorage
 * 做同构存储（key 与桌面一致，会话跨启动保留），后续再迁到 Preferences/SQLite。
 */

const storageKey = (platform: string): string => `splayer.android.session.${platform}`;

const readAll = (): Record<string, Record<string, string>> => {
  try {
    return JSON.parse(localStorage.getItem("splayer.android.sessions") ?? "{}") as Record<
      string,
      Record<string, string>
    >;
  } catch {
    return {};
  }
};

const writeAll = (all: Record<string, Record<string, string>>): void => {
  try {
    localStorage.setItem("splayer.android.sessions", JSON.stringify(all));
  } catch {
    // 存储配额不足时忽略，会话仅保活本次启动
  }
};

/**
 * 读某平台会话 Cookie
 * @param platform 平台名（netease / qqmusic / kugou）
 * @returns Cookie 键值对
 */
export const getSessionCookies = (platform: string): Record<string, string> => {
  void storageKey(platform);
  return readAll()[platform] ?? {};
};

/**
 * 写某平台会话 Cookie（全量覆盖）
 * @param platform 平台名
 * @param cookies Cookie 键值对
 */
export const saveSessionCookies = (platform: string, cookies: Record<string, string>): void => {
  const all = readAll();
  all[platform] = cookies;
  writeAll(all);
};

/**
 * 清某平台会话 Cookie
 * @param platform 平台名
 */
export const clearSessionCookies = (platform: string): void => {
  const all = readAll();
  delete all[platform];
  writeAll(all);
};
