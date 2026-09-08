/** Android WebView 插件运行时：按插件记录 handler、事件回调和在途请求。 */

import type {
  ActionIO,
  HostApi,
  HostRequestOptions,
  HostRequestResult,
  PlaybackEventData,
  PlaybackEventKind,
  PluginAction,
  PluginErrorPayload,
  PluginGrant,
  PluginManifest,
  PluginSettingItem,
  PluginStatus,
  RegisterArgs,
  SourceCapability,
} from "@shared/types/plugin";
import { PluginErrorCodes } from "@shared/defaults/plugin-api";
import { getCurrentTime } from "@/services/playback";
import * as player from "@/core/player";
import { useSettingsStore } from "@/stores/settings";
import { APP_VERSION } from "@/utils/config";
import { fetchWithProxy } from "../vendor/shim/proxy";
import { randomBytes, md5Hex, hexEncode } from "../vendor/shim/webcrypto";
import { Buffer, PluginBuffer } from "./buffer";
import {
  aesDecryptNode,
  aesEncryptNode,
  hmacBytes,
  rsaEncryptPkcs1,
  sha1Bytes,
  sha256Bytes,
  toBytes,
} from "./crypto";
import { hostRequest } from "./net";
import { dataGet, dataKeys, dataRemove, dataSet } from "./storage";
import { installLxShim } from "./lx-shim";
import pako from "pako";

export interface PluginLoadSpec {
  pluginId: string;
  manifest: PluginManifest;
  source: string;
  locale: string;
  appVersion: string;
  userSettings: Record<string, unknown>;
}

export interface RuntimeCallbacks {
  onReady: (sources: Record<string, SourceCapability>) => void;
  onRegistered: (registration: {
    events: PlaybackEventKind[];
    controls: boolean;
    settings: PluginSettingItem[];
    menus: import("@shared/types/plugin").PluginMenuItem[];
  }) => void;
  onSourcesUpdate: (sources: Record<string, SourceCapability>) => void;
  onUpdateAvailable: (info: import("@shared/types/plugin").PluginUpdateInfo) => void;
  onFatal: (error: PluginErrorPayload) => void;
  onLog: (level: "debug" | "info" | "warn" | "error", args: unknown[]) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

export interface RuntimeRecord {
  pluginId: string;
  grants: PluginGrant[];
  handlers: Map<PluginAction, (request: unknown) => Promise<unknown>>;
  playerEventHandlers: Map<PlaybackEventKind, ((data: unknown) => void)[]>;
  settingChangeHandlers: Map<string, ((value: unknown) => void)[]>;
  registeredSources: Record<string, SourceCapability>;
  userSettingsCache: Record<string, unknown>;
  pending: Map<string, PendingCall>;
  timers: Set<ReturnType<typeof setTimeout>>;
  disposed: boolean;
}

const records = new Map<string, RuntimeRecord>();
let requestSequence = 0;

const errorWithCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

const toByteArray = (value: unknown): Uint8Array => {
  if (typeof value === "string") return toBytes(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value, (item) => Number(item) & 0xff);
  return new Uint8Array();
};

const buildUtils = (): Record<string, unknown> => ({
  crypto: {
    md5: (data: string | Uint8Array) => md5Hex(toByteArray(data)),
    sha1: (data: string | Uint8Array) => hexEncode(sha1Bytes(toByteArray(data))),
    sha256: (data: string | Uint8Array) => hexEncode(sha256Bytes(toByteArray(data))),
    hmac: (algorithm: string, key: string | Uint8Array, data: string | Uint8Array) =>
      hexEncode(hmacBytes(algorithm.toLowerCase() as "md5" | "sha1" | "sha256", key, data)),
    randomBytes: (size: number) => Buffer.from(randomBytes(size)),
    aesEncrypt: (data: string | Uint8Array, key: Uint8Array, mode: string, iv?: Uint8Array) =>
      Buffer.from(aesEncryptNode(data, key, mode, iv)),
    aesDecrypt: (data: Uint8Array, key: Uint8Array, mode: string, iv?: Uint8Array) =>
      Buffer.from(aesDecryptNode(data, key, mode, iv)),
    rsaEncrypt: (data: Uint8Array, publicKey: string) =>
      Buffer.from(rsaEncryptPkcs1(data, publicKey)),
  },
  buffer: {
    from: (data: unknown, encoding?: string) =>
      Buffer.from(typeof data === "string" ? data : toByteArray(data), encoding as never),
    bufToString: (data: unknown, encoding = "utf8") =>
      Buffer.from(toByteArray(data)).toString(encoding as never),
    concat: (list: Uint8Array[]) => Buffer.concat(list.map((item) => Buffer.from(item))),
  },
  base64: {
    encode: (data: string | Uint8Array) => Buffer.from(toByteArray(data)).toString("base64"),
    decode: (data: string) => Buffer.from(data, "base64").toString("utf8"),
  },
  zlib: {
    inflate: (data: Uint8Array) => pako.inflate(data),
    deflate: (data: Uint8Array) => pako.deflate(data),
    gunzip: (data: Uint8Array) => pako.ungzip(data),
    gzip: (data: Uint8Array) => pako.gzip(data),
  },
});

const makeTimers = (record: RuntimeRecord) => ({
  setTimeout: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = setTimeout(() => {
      record.timers.delete(handle);
      if (!record.disposed) callback(...args);
    }, ms);
    record.timers.add(handle);
    return handle;
  },
  setInterval: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = setInterval(() => {
      if (!record.disposed) callback(...args);
    }, ms);
    record.timers.add(handle as unknown as ReturnType<typeof setTimeout>);
    return handle;
  },
  clearTimeout: (handle?: ReturnType<typeof setTimeout>) => {
    if (handle) record.timers.delete(handle);
    clearTimeout(handle);
  },
  clearInterval: (handle?: ReturnType<typeof setInterval>) => {
    if (handle) record.timers.delete(handle as unknown as ReturnType<typeof setTimeout>);
    clearInterval(handle);
  },
  setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    const handle = setTimeout(() => {
      record.timers.delete(handle);
      if (!record.disposed) callback(...args);
    }, 0);
    record.timers.add(handle);
    return handle;
  },
  clearImmediate: (handle?: ReturnType<typeof setTimeout>) => {
    if (handle) record.timers.delete(handle);
    clearTimeout(handle);
  },
});

const buildSplayer = (
  record: RuntimeRecord,
  spec: PluginLoadSpec,
  callbacks: RuntimeCallbacks,
): HostApi & { utils?: Record<string, unknown> } => {
  const requireGrant = (grant: PluginGrant): void => {
    if (!record.grants.includes(grant)) {
      throw errorWithCode(`plugin lacks "${grant}" grant`, PluginErrorCodes.PERMISSION_DENIED);
    }
  };
  const register = (args: RegisterArgs): void => {
    if (args.sources) {
      record.registeredSources = { ...record.registeredSources, ...args.sources };
      callbacks.onSourcesUpdate(record.registeredSources);
    }
    if (args.events || args.controls !== undefined || args.settings || args.menus) {
      const settings = Array.isArray(args.settings) ? args.settings : [];
      for (const item of settings) {
        if (!(item.key in record.userSettingsCache))
          record.userSettingsCache[item.key] = item.default;
      }
      callbacks.onRegistered({
        events: Array.isArray(args.events) ? args.events : [],
        controls: Boolean(args.controls),
        settings,
        menus: Array.isArray(args.menus) ? args.menus : [],
      });
    }
  };
  const splayer = {
    pluginId: spec.pluginId,
    apiLevel: spec.manifest.apiLevel,
    locale: spec.locale,
    appVersion: spec.appVersion,
    request: async (url: string, options?: HostRequestOptions): Promise<HostRequestResult> => {
      requireGrant("network");
      return hostRequest(url, options);
    },
    register,
    on: <A extends PluginAction>(
      action: A,
      handler: (request: ActionIO[A]["req"]) => Promise<ActionIO[A]["res"]>,
    ): void => {
      record.handlers.set(action, handler as (request: unknown) => Promise<unknown>);
    },
    log: {
      debug: (...args: unknown[]) => callbacks.onLog("debug", args),
      info: (...args: unknown[]) => callbacks.onLog("info", args),
      warn: (...args: unknown[]) => callbacks.onLog("warn", args),
      error: (...args: unknown[]) => callbacks.onLog("error", args),
    },
    storage: {
      get: <T = unknown>(key: string) => dataGet<T>(spec.pluginId, key),
      set: (key: string, value: unknown) => dataSet(spec.pluginId, key, value),
      remove: (key: string) => dataRemove(spec.pluginId, key),
      keys: () => dataKeys(spec.pluginId),
    },
    getSetting: <T = unknown>(key: string): T | undefined =>
      record.userSettingsCache[key] as T | undefined,
    player: {
      on: <K extends PlaybackEventKind>(kind: K, handler: (data: PlaybackEventData[K]) => void) => {
        requireGrant("control");
        const list = record.playerEventHandlers.get(kind) ?? [];
        list.push(handler as (data: unknown) => void);
        record.playerEventHandlers.set(kind, list);
      },
      play: () => {
        requireGrant("control");
        void player.play().catch(() => {});
      },
      pause: () => {
        requireGrant("control");
        void player.pause().catch(() => {});
      },
      next: () => {
        requireGrant("control");
        void player.nextTrack().catch(() => {});
      },
      prev: () => {
        requireGrant("control");
        void player.prevTrack().catch(() => {});
      },
      seek: (positionMs: number) => {
        requireGrant("control");
        void player.seek(positionMs).catch(() => {});
      },
      setVolume: (volume: number) => {
        requireGrant("control");
        void player.setVolume(volume).catch(() => {});
      },
      getPosition: async () => {
        requireGrant("control");
        return getCurrentTime();
      },
    },
    onSettingChange: (key: string, handler: (value: unknown) => void) => {
      requireGrant("control");
      const list = record.settingChangeHandlers.get(key) ?? [];
      list.push(handler);
      record.settingChangeHandlers.set(key, list);
    },
  } as HostApi & { utils?: Record<string, unknown> };
  splayer.utils = buildUtils();
  return splayer;
};

const emitFatal = (callbacks: RuntimeCallbacks, error: unknown): void => {
  callbacks.onFatal({
    code: (error as { code?: string })?.code ?? PluginErrorCodes.SCRIPT_ERROR,
    message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  });
};

export const loadPlugin = (spec: PluginLoadSpec, callbacks: RuntimeCallbacks): RuntimeRecord => {
  unloadPlugin(spec.pluginId);
  const record: RuntimeRecord = {
    pluginId: spec.pluginId,
    grants: spec.manifest.grant,
    handlers: new Map(),
    playerEventHandlers: new Map(),
    settingChangeHandlers: new Map(),
    registeredSources: {},
    userSettingsCache: { ...spec.userSettings },
    pending: new Map(),
    timers: new Set(),
    disposed: false,
  };
  records.set(spec.pluginId, record);
  const global: Record<string, unknown> = {};
  const splayer = buildSplayer(record, spec, callbacks);
  const timers = makeTimers(record);
  installLxShim(
    global,
    splayer,
    record.handlers,
    callbacks.onSourcesUpdate,
    callbacks.onUpdateAvailable,
    {
      name: spec.manifest.name,
      description: spec.manifest.description ?? "",
      version: spec.manifest.version,
      author: spec.manifest.author ?? "",
      homepage: spec.manifest.homepage ?? "",
      rawScript: spec.source,
    },
  );
  global.splayer = splayer;
  global.Buffer = PluginBuffer;
  Object.assign(global, timers, {
    queueMicrotask,
    Promise,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    btoa: (value: string) => btoa(value),
    atob: (value: string) => atob(value),
    console: {
      log: (...args: unknown[]) => callbacks.onLog("info", args),
      info: (...args: unknown[]) => callbacks.onLog("info", args),
      debug: (...args: unknown[]) => callbacks.onLog("debug", args),
      warn: (...args: unknown[]) => callbacks.onLog("warn", args),
      error: (...args: unknown[]) => callbacks.onLog("error", args),
    },
  });
  global.globalThis = global;
  global.window = { lx: global.lx };
  try {
    const names = [
      "splayer",
      "Buffer",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "queueMicrotask",
      "URL",
      "URLSearchParams",
      "TextEncoder",
      "TextDecoder",
      "btoa",
      "atob",
      "console",
      "globalThis",
      "window",
    ];
    const values = names.map((name) => global[name]);
    const source = `"use strict";\n${spec.source}`;
    const fn = new Function(...names, source) as (...args: unknown[]) => void;
    fn.call(global, ...values);
  } catch (error) {
    if (record.registeredSources && Object.keys(record.registeredSources).length > 0) {
      callbacks.onLog("warn", ["插件顶层执行异常，但音源已注册", error]);
    } else {
      record.disposed = true;
      records.delete(spec.pluginId);
      emitFatal(callbacks, error);
      return record;
    }
  }
  queueMicrotask(() => {
    if (!record.disposed) callbacks.onReady(record.registeredSources);
  });
  return record;
};

export const unloadPlugin = (pluginId: string): void => {
  const record = records.get(pluginId);
  if (!record) return;
  record.disposed = true;
  for (const timer of record.timers) clearTimeout(timer);
  record.timers.clear();
  for (const pending of record.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(errorWithCode("plugin stopped", PluginErrorCodes.NOT_READY));
  }
  record.pending.clear();
  record.handlers.clear();
  record.playerEventHandlers.clear();
  record.settingChangeHandlers.clear();
  records.delete(pluginId);
};

export const getRuntime = (pluginId: string): RuntimeRecord | undefined => records.get(pluginId);

export const callAction = <T>(
  pluginId: string,
  action: PluginAction,
  params: unknown,
  timeoutMs: number,
): Promise<T> => {
  const record = records.get(pluginId);
  if (!record || record.disposed)
    return Promise.reject(errorWithCode("plugin not ready", PluginErrorCodes.NOT_READY));
  const handler = record.handlers.get(action);
  if (!handler)
    return Promise.reject(
      errorWithCode(`action "${action}" not registered`, PluginErrorCodes.ACTION_UNSUPPORTED),
    );
  const requestId = `r${Date.now().toString(36)}-${++requestSequence}`;
  return new Promise<T>((resolve, reject) => {
    const pending: PendingCall = {
      resolve: (value) => resolve(value as T),
      reject,
      cancelled: false,
      timer: setTimeout(() => {
        record.pending.delete(requestId);
        pending.cancelled = true;
        reject(errorWithCode("plugin request timeout", PluginErrorCodes.REQUEST_TIMEOUT));
      }, timeoutMs),
    };
    record.pending.set(requestId, pending);
    void handler(params).then(
      (value) => {
        const current = record.pending.get(requestId);
        if (!current) return;
        record.pending.delete(requestId);
        clearTimeout(current.timer);
        if (current.cancelled)
          current.reject(errorWithCode("cancelled", PluginErrorCodes.CANCELLED));
        else current.resolve(value);
      },
      (error: unknown) => {
        const current = record.pending.get(requestId);
        if (!current) return;
        record.pending.delete(requestId);
        clearTimeout(current.timer);
        current.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

export const cancelAction = (pluginId: string, requestId: string): void => {
  const pending = records.get(pluginId)?.pending.get(requestId);
  if (pending) pending.cancelled = true;
};

export const deliverPlaybackEvent = (
  pluginId: string,
  event: PlaybackEventKind,
  data: PlaybackEventData[typeof event],
): void => {
  const handlers = records.get(pluginId)?.playerEventHandlers.get(event);
  for (const handler of handlers ?? []) {
    try {
      handler(data);
    } catch {
      // 单个插件回调异常不影响播放器
    }
  }
};

export const deliverSettingsUpdate = (
  pluginId: string,
  settings: Record<string, unknown>,
): void => {
  const record = records.get(pluginId);
  if (!record) return;
  for (const [key, value] of Object.entries(settings)) {
    record.userSettingsCache[key] = value;
    for (const handler of record.settingChangeHandlers.get(key) ?? []) {
      try {
        handler(value);
      } catch {
        // 单个插件回调异常不影响设置更新
      }
    }
  }
};

export const listRuntimes = (): RuntimeRecord[] => Array.from(records.values());
