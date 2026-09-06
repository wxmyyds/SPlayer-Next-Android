/**
 * 配置存储垫片（Android 版）
 *
 * 上游 dev 的 main 进程用 electron-store；Android vendor 只读少量开关，
 * localStorage 同构一份（`splayer.android.config.*`），缺省返回 undefined
 * 由各调用方按桌面默认行为处理。
 */

const configKey = (key: string): string => `splayer.android.config.${key}`;

/**
 * 读配置
 * @param key 配置键
 * @returns 配置值，不存在返回 undefined
 */
export const storeGet = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(configKey(key));
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
};

/**
 * 写配置
 * @param key 配置键
 * @param value 配置值
 */
export const storeSet = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(configKey(key), JSON.stringify(value));
  } catch {
    // 忽略配额异常
  }
};

/** 与上游 `@main/store` 同形的最小 store（get 返回 any，与桌面一致） */
export const store: { get: (key: string) => any; set: (key: string, value: unknown) => void } = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get: (key: string): any => storeGet(key),
  set: (key: string, value: unknown): void => storeSet(key, value),
};
