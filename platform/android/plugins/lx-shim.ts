/** LX Music user_api 兼容层，适配 Android WebView 插件运行时。 */

import type {
  HostApi,
  MusicUrlReq,
  MusicUrlRes,
  PluginAction,
  PluginQuality,
  PluginUpdateInfo,
  SourceCapability,
} from "@shared/types/plugin";
import { randomBytes } from "../vendor/shim/webcrypto";
import { aesEncryptNode, md5Bytes, rsaEncryptNoPadding, toBytes } from "./crypto";
import { Buffer, PluginBuffer } from "./buffer";
import * as pako from "pako";

const LX_TO_HOST: Record<string, PluginQuality> = {
  "128k": "lq",
  "128": "lq",
  standard: "lq",
  "192k": "sq",
  "192": "sq",
  "320k": "hq",
  "320": "hq",
  high: "hq",
  hq: "hq",
  flac: "lossless",
  ape: "lossless",
  wav: "lossless",
  lossless: "lossless",
  flac24bit: "hi-res",
  hires: "hi-res",
  "hi-res": "hi-res",
};
const HOST_TO_LX: Record<PluginQuality, string> = {
  lq: "128k",
  sq: "192k",
  hq: "320k",
  lossless: "flac",
  "hi-res": "flac24bit",
};
const mapQuality = (value: string): PluginQuality | null => LX_TO_HOST[value.toLowerCase()] ?? null;

interface LxRequestResponse {
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string>;
  bytes?: number;
  raw?: PluginBuffer;
  body?: unknown;
}
type LxRequestCallback = (
  error: Error | null,
  response?: LxRequestResponse,
  body?: unknown,
) => void;

const bytes = (value: unknown): PluginBuffer => {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  return Buffer.alloc(0);
};

const normalizeInfo = (raw: MusicUrlReq["musicInfo"], source: string): Record<string, unknown> => {
  const info = raw ?? { songmid: "" };
  const id = String(info.id ?? info.songmid ?? info.songId ?? "");
  const meta =
    typeof info.meta === "object" && info.meta !== null
      ? (info.meta as Record<string, unknown>)
      : {};
  return {
    ...info,
    id,
    songmid: id,
    songId: id,
    name: String(info.name ?? info.title ?? ""),
    singer: String(info.singer ?? info.artist ?? ""),
    source,
    albumId: String(info.albumId ?? meta.albumId ?? ""),
    albumName: String(info.albumName ?? meta.albumName ?? ""),
    interval: info.interval ?? null,
    img: info.img ?? info.pic ?? meta.picUrl ?? null,
    types: Array.isArray(info.types) ? info.types : [],
    _types: info._types ?? {},
    typeUrl: info.typeUrl ?? {},
    hash: info.hash ?? meta.hash ?? "",
    strMediaMid: info.strMediaMid ?? id,
    copyrightId: info.copyrightId ?? "",
    meta: { ...meta, songId: id },
  };
};

/** 将 LX 的请求回调协议桥接到 HostApi.request。 */
export const installLxShim = (
  global: Record<string, unknown>,
  splayer: HostApi,
  handlers: Map<PluginAction, (request: unknown) => Promise<unknown>>,
  onSources: (sources: Record<string, SourceCapability>) => void,
  onUpdate: (info: PluginUpdateInfo) => void,
  scriptInfo: {
    name: string;
    description: string;
    version: string;
    author: string;
    homepage: string;
    rawScript: string;
  },
): void => {
  let requestHandler:
    | ((request: {
        source: string;
        action: string;
        info: Record<string, unknown>;
      }) => unknown | Promise<unknown>)
    | null = null;
  let inited = false;
  const EVENT_NAMES = { request: "request", inited: "inited", updateAlert: "updateAlert" } as const;
  const lxUtils = {
    crypto: {
      aesEncrypt: (data: unknown, mode: string, key: unknown, iv?: unknown) =>
        Buffer.from(aesEncryptNode(bytes(data), bytes(key), mode, iv ? bytes(iv) : undefined)),
      rsaEncrypt: (data: unknown, key: string) =>
        Buffer.from(rsaEncryptNoPadding(bytes(data), key)),
      randomBytes: (size: number) => Buffer.from(randomBytes(size)),
      md5: (data: unknown) => {
        const hash = md5Bytes(bytes(data));
        return Array.from(hash, (item) => item.toString(16).padStart(2, "0")).join("");
      },
    },
    buffer: {
      from: (data: unknown, encoding?: string) =>
        Buffer.from(typeof data === "string" ? data : bytes(data), encoding as never),
      bufToString: (data: unknown, encoding = "utf8") => bytes(data).toString(encoding as never),
    },
    zlib: {
      inflate: async (data: unknown) => Buffer.from(pako.inflate(bytes(data))),
      deflate: async (data: unknown) => Buffer.from(pako.deflate(bytes(data))),
    },
  };
  const lxApi = {
    EVENT_NAMES,
    version: "2.0.0",
    env: "android",
    request(
      url: string,
      options: Record<string, unknown> | undefined,
      callback: LxRequestCallback,
    ): () => void {
      const opts = options ?? {};
      const headers: Record<string, string> = {};
      const rawHeaders = (opts.headers ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawHeaders)) headers[key] = String(value);
      let body: string | Uint8Array | undefined;
      if (typeof opts.body === "string" || opts.body instanceof Uint8Array) body = opts.body;
      else if (opts.body != null) body = JSON.stringify(opts.body);
      else if (opts.form || opts.formData) {
        const form = (opts.form ?? opts.formData) as Record<string, unknown>;
        body = new URLSearchParams(
          Object.entries(form).map(([key, value]) => [key, String(value)]),
        ).toString();
        headers["content-type"] ??= "application/x-www-form-urlencoded";
      }
      let cancelled = false;
      void splayer
        .request(url, {
          method: ((opts.method as string) ?? "GET").toUpperCase() as "GET" | "POST",
          headers,
          body,
          timeout: typeof opts.timeout === "number" ? opts.timeout : undefined,
          responseType: "text",
        })
        .then((response) => {
          if (cancelled) return;
          const text =
            typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? "");
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* 保持文本 */
          }
          callback(
            null,
            {
              statusCode: response.status,
              statusMessage: response.status === 200 ? "OK" : "",
              headers: response.headers,
              bytes: text.length,
              raw: Buffer.from(text),
              body: parsed,
            },
            parsed,
          );
        })
        .catch((error: unknown) => {
          if (!cancelled)
            callback(error instanceof Error ? error : new Error(String(error)), undefined, null);
        });
      return () => {
        cancelled = true;
      };
    },
    on(eventName: string, handler: unknown): Promise<void> {
      if (eventName !== EVENT_NAMES.request)
        return Promise.reject(new Error(`unsupported event: ${eventName}`));
      requestHandler = handler as typeof requestHandler;
      return Promise.resolve();
    },
    send(eventName: string, data: Record<string, unknown>): Promise<void> {
      if (eventName === EVENT_NAMES.inited) {
        if (inited) return Promise.reject(new Error("Script is inited"));
        inited = true;
        const sourceData = (data.sources ?? {}) as Record<string, Record<string, unknown>>;
        const sources: Record<string, SourceCapability> = {};
        for (const [key, value] of Object.entries(sourceData)) {
          const actions = Array.isArray(value.actions)
            ? value.actions.filter((action): action is PluginAction => action === "musicUrl")
            : (["musicUrl"] as PluginAction[]);
          if (!actions.length) continue;
          const qualities = (value.qualitys ?? value.qualities ?? []) as string[];
          sources[key] = {
            name: String(value.name ?? key),
            actions,
            qualities: qualities
              .map(mapQuality)
              .filter((value): value is PluginQuality => value !== null),
          };
        }
        onSources(sources);
        return Promise.resolve();
      }
      if (eventName === EVENT_NAMES.updateAlert) {
        onUpdate({
          version: typeof data.version === "string" ? data.version : undefined,
          log: typeof data.log === "string" ? data.log : undefined,
          updateUrl: typeof data.updateUrl === "string" ? data.updateUrl : undefined,
          updatedAt: Date.now(),
        });
        return Promise.resolve();
      }
      return Promise.reject(new Error(`unsupported event: ${eventName}`));
    },
    utils: lxUtils,
    currentScriptInfo: scriptInfo,
  };
  global.lx = lxApi;
  global.window = { lx: lxApi };
  handlers.set("musicUrl", async (request: unknown) => {
    if (!requestHandler)
      throw Object.assign(new Error("LX request handler is not registered"), {
        code: "PLUGIN_NOT_READY",
      });
    const req = request as MusicUrlReq;
    const raw = await requestHandler({
      source: req.source,
      action: "musicUrl",
      info: {
        type: HOST_TO_LX[req.quality ?? "hq"],
        musicInfo: normalizeInfo(req.musicInfo, req.source),
      },
    });
    if (typeof raw === "string") return { url: raw } satisfies MusicUrlRes;
    const url = raw && typeof raw === "object" ? (raw as Record<string, unknown>).url : undefined;
    if (typeof url !== "string" || !url) throw new Error("LX plugin returned invalid URL");
    return { url } satisfies MusicUrlRes;
  });
};
