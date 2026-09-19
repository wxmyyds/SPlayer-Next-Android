/**
 * 引擎原生桥全局声明
 *
 * 由 Rust 壳（android/js-engine）注入的全局函数：JS 侧只依赖这些注入点，
 * 与 WebView 的 Capacitor 桥完全无关。
 */

/** 发 HTTP（OkHttp 由 Kotlin 静态方法承接，同步阻塞返回），入参/返回与 NativeHttpPlugin 同形 */
declare function __nativeHttp(reqJson: string): string;

/** 取消在途请求（requestId 与请求时的传入值对应） */
declare function __nativeHttpCancel(requestId: string): void;

/** crypto.subtle 原语（sha256/hmac/aes-cbc/aes-gcm/x25519），入参出参 JSON + base64，同步返回 */
declare function __nativeSubtle(reqJson: string): string;

/** 密码学安全随机字节（base64），n ≤ 65536 */
declare function __nativeRandom(n: number): string;

/** inflate 解压（deflate / deflate-raw / gzip），入参出参均 base64，同步返回 */
declare function __nativeInflate(dataB64: string, format: string): string;

/** localStorage 读（不存在返回 null） */
declare function __nativeStoreGet(key: string): string | null;

/** localStorage 写（value 为空串表示删除） */
declare function __nativeStoreSet(key: string, value: string): void;

/** localStorage 全量键集合（JSON 数组字符串） */
declare function __nativeStoreKeys(): string;

/** 写 logcat */
declare function __nativeLog(level: string, message: string): void;

/** 注册 Rust 定时器：ms 后 Rust 回调 __timerFire(id) */
declare function __nativeSetTimeout(id: number, ms: number): void;
