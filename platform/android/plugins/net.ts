/** 插件宿主网络层：经 Android NativeHttp/OkHttp 发出请求。 */

import type { HostRequestOptions, HostRequestResult, MarketPlugin } from "@shared/types/plugin";
import {
  INSTALL_URL_MAX_SIZE,
  INSTALL_URL_TIMEOUT,
  PLUGIN_REGISTRY_URL,
  PluginErrorCodes,
  REQUEST_DEFAULT_TIMEOUT,
  REQUEST_MAX_TIMEOUT,
} from "@shared/defaults/plugin-api";
import { fetchWithProxy } from "../vendor/shim/proxy";

const withTimeout = async <T>(task: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error("request timeout"), { code: PluginErrorCodes.REQUEST_TIMEOUT }),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const allowedUrl = (url: string, allowHttpLoopback = false): URL => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error(`invalid url: ${url}`), {
      code: PluginErrorCodes.URL_NOT_ALLOWED,
    });
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(allowHttpLoopback && loopback)) {
    throw Object.assign(new Error(`protocol not allowed: ${parsed.protocol}`), {
      code: PluginErrorCodes.URL_NOT_ALLOWED,
    });
  }
  return parsed;
};

const readText = async (url: string, timeoutMs: number): Promise<string> => {
  allowedUrl(url, true);
  const response = await withTimeout(
    fetchWithProxy(url, { method: "GET", redirect: "follow" }),
    timeoutMs,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > INSTALL_URL_MAX_SIZE) {
    throw Object.assign(new Error("PLUGIN_INSTALL_URL_TOO_LARGE"), {
      code: "PLUGIN_INSTALL_URL_TOO_LARGE",
    });
  }
  return new TextDecoder().decode(bytes);
};

export const fetchScript = (url: string): Promise<string> => readText(url, INSTALL_URL_TIMEOUT);

export const fetchMarket = async (): Promise<MarketPlugin[]> => {
  const data = JSON.parse(await readText(PLUGIN_REGISTRY_URL, INSTALL_URL_TIMEOUT)) as {
    plugins?: MarketPlugin[];
  };
  return Array.isArray(data.plugins)
    ? data.plugins.filter((item) => item?.id && item?.updateUrl)
    : [];
};

export const hostRequest = async (
  url: string,
  options: HostRequestOptions = {},
): Promise<HostRequestResult> => {
  allowedUrl(url);
  const timeoutMs = Math.min(
    Math.max(options.timeout ?? REQUEST_DEFAULT_TIMEOUT, 1_000),
    REQUEST_MAX_TIMEOUT,
  );
  const body =
    typeof options.body === "string"
      ? options.body
      : options.body instanceof Uint8Array
        ? options.body
        : options.body instanceof ArrayBuffer
          ? new Uint8Array(options.body)
          : undefined;
  const controller = new AbortController();
  const response = await withTimeout(
    fetchWithProxy(url, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body,
      signal: controller.signal,
      redirect: "follow",
    }),
    timeoutMs,
  ).catch((error: unknown) => {
    controller.abort();
    throw error;
  });
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) headers[key] = value;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let result: unknown = text;
  if (options.responseType === "arraybuffer") result = bytes;
  else if (options.responseType === "json") {
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
  }
  return { status: response.status, headers, body: result };
};
