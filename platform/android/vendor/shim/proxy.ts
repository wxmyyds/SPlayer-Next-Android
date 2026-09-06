/**
 * 联网垫片（Android 版）
 *
 * 上游 dev 的 main 进程经代理工具发请求；Android 跑在 WebView，
 * 所有请求经 Capacitor 原生插件（OkHttp）发出：
 * - 证书/超时/重定向由原生侧统一处理
 * - `redirect: "manual"` 时返回跳转响应本身（QQ 登录取 Location/p_skey 用）
 * - 桌面端 `AbortSignal` 暂不透传（OkHttp 自带 15s 连接 / 30s 读取超时）
 */

import { registerPlugin, WebPlugin } from "@capacitor/core";

/** 原生 HTTP 插件接口 */
interface NativeHttpPlugin {
  request: (options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "follow" | "manual";
  }) => Promise<{
    status: number;
    url: string;
    headers: Record<string, string | string[]>;
    setCookies: string[];
    bodyBase64: string;
  }>;
}

/** 非原生环境回退：直接用 Web fetch（仅开发/测试用） */
class NativeHttpWeb extends WebPlugin implements NativeHttpPlugin {
  async request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "follow" | "manual";
  }): Promise<{
    status: number;
    url: string;
    headers: Record<string, string | string[]>;
    setCookies: string[];
    bodyBase64: string;
  }> {
    const res = await fetch(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: options.redirect === "manual" ? "manual" : "follow",
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: res.status,
      url: res.url,
      headers,
      setCookies: [],
      bodyBase64: bytesToB64(bytes),
    };
  }
}

const NativeHttp = registerPlugin<NativeHttpPlugin>("NativeHttp", {
  web: () => new NativeHttpWeb(),
});

/** base64 解字节 */
const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

/** 原生响应头多值 Map */
export interface NativeFetchHeaders {
  get: (name: string) => string | null;
  getSetCookie: () => string[];
  entries: () => IterableIterator<[string, string]>;
}

const makeHeaders = (
  headers: Record<string, string | string[]>,
  setCookies: string[],
): NativeFetchHeaders => {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : v);
  }
  return {
    get: (name: string) => lower.get(name.toLowerCase()) ?? null,
    getSetCookie: () => setCookies,
    entries: function* () {
      for (const [k, v] of lower) yield [k, v] as [string, string];
    },
  };
};

/** 够用的 Response 子集（vendor 只用这些方法） */
export interface NativeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: NativeFetchHeaders;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

/**
 * 经原生插件发 HTTP 请求
 * @param url 请求地址
 * @param init 方法/头/body/重定向策略
 * @returns 够用版 Response
 */
export const fetchWithProxy = async (
  url: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    signal?: AbortSignal;
    redirect?: "follow" | "manual";
  },
): Promise<NativeFetchResponse> => {
  const href = typeof url === "string" ? url : url.href;
  let body: string | undefined;
  if (typeof init?.body === "string") body = init.body;
  else if (init?.body instanceof Uint8Array) body = bytesToB64(init.body);
  // 原生侧 OkHttp 自带连接/读取超时；AbortSignal 暂不透传
  const res = await NativeHttp.request({
    url: href,
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body,
    redirect: init?.redirect ?? "follow",
  });
  const bytes = b64ToBytes(res.bodyBase64);
  const textCache = new TextDecoder().decode(bytes.slice().buffer as ArrayBuffer);
  const owned = Uint8Array.from(bytes);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    url: res.url,
    headers: makeHeaders(res.headers, res.setCookies),
    arrayBuffer: async () => owned.buffer as ArrayBuffer,
    text: async () => textCache,
    json: async () => JSON.parse(textCache) as unknown,
  };
};
