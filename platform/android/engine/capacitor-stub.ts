/**
 * @capacitor/core 引擎替身
 *
 * vendor 的 shim 层（proxy.ts 等）经 registerPlugin 取原生传输；WebView 里
 * 由 Capacitor 桥承接，引擎里直接路由到 Rust 注入的 __nativeHttp。
 * 返回对象与插件代理同形（方法调用即 Promise），vendor 零改动。
 */

type PluginResult = unknown;

interface PluginImplement {
  [method: string]: (...args: never[]) => Promise<PluginResult>;
}

/** 原生方法名 → Rust 注入函数的映射（同步阻塞返回，调用侧经 resolved promise 承接） */
const nativeMethods: Record<string, (argsJson: string) => string> = {
  request: (argsJson) => __nativeHttp(argsJson),
  cancel: (argsJson) => {
    __nativeHttpCancel(argsJson);
    return "{}";
  },
};

/**
 * 注册插件（引擎版）：忽略 web 实现工厂，直接给出原生桥实现
 * @param _name - 插件名
 * @param _impl - Capacitor 选项（含 web 工厂，引擎不使用）
 * @returns 以原生桥为后端的插件对象
 */
export function registerPlugin<T extends PluginImplement>(
  _name: string,
  _impl?: { web?: () => unknown },
): T {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => {
        const transport = nativeMethods[method];
        if (transport) {
          return (options: unknown): Promise<PluginResult> =>
            // native 注入的 transport 是同步函数（返回裸字符串或同步 throw），
            // 必须经 resolved promise 承接，否则 .then 直接 TypeError
            Promise.resolve()
              .then(() => transport(JSON.stringify(options) ?? "{}"))
              .then((raw) => {
                const parsed = JSON.parse(raw) as PluginResult & { error?: string };
                // 原生传输失败（status:0 + error）：转 reject，vendor 的 AbortError
                // 归一化与重试层依赖 promise 拒绝语义，resolve 会让重试失效
                if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
                  throw new Error(parsed.error);
                }
                return parsed as PluginResult;
              });
        }
        // 未知方法：与 Capacitor 行为一致地拒绝
        return (): Promise<PluginResult> =>
          Promise.reject(new Error(`engine plugin method not bridged: ${String(method)}`));
      },
    },
  ) as T;
}

/** 引擎内无 WebView 生命周期事件，空实现即可 */
export class WebPlugin {
  /**
   * 移除监听（引擎无事件源，空操作）
   */
  async removeAllListeners(): Promise<void> {}
}
