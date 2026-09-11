/**
 * 日志垫片（Android 版）
 *
 * 上游 dev 的 main 进程用 electron-log 的分 scope 打日志；
 * Android 跑在 WebView 里，直接转接到 console（atype 日志经 logcat）。
 */

const makeLogger = (
  scope: string,
): {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
} => ({
  debug: (...args: unknown[]) => console.debug(`[${scope}]`, ...args),
  info: (...args: unknown[]) => console.info(`[${scope}]`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${scope}]`, ...args),
  error: (...args: unknown[]) => console.error(`[${scope}]`, ...args),
});

/** 网易云 API 日志 */
export const neteaseLog = makeLogger("netease");
/** 通用核心日志 */
export const coreLog = makeLogger("core");
/** 播放器日志 */
export const playerLog = makeLogger("player");
/** 媒体库日志 */
export const mediaLog = makeLogger("media");
/** 流媒体日志 */
export const streamingLog = makeLogger("streaming");
