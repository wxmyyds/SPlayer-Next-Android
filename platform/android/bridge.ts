import { defaultHotkeyConfig } from "@shared/defaults/hotkeys";
import { defaultSystemConfig } from "@shared/defaults/settings";
import type {
  IpcResponse,
  PlayerApi,
  PlayerEvent,
  PlayerStatus,
  TrackSource,
} from "@shared/types/player";
import type {
  ConfigApi,
  ExternalApiStatus,
  LocaleCode,
  McpAgentApp,
  McpClientConfigParams,
  McpStatus,
  SystemConfig,
} from "@shared/types/settings";
import type { LibraryApi } from "@shared/types/library";
import type { NowPlayingApi } from "@shared/types/nowPlaying";
import type { MusicUrlRes, PluginsApi } from "@shared/types/plugin";
import type { ApisApi } from "@shared/types/apis";
import type { LyricsApi } from "@shared/types/lyrics";
import type { DownloadApi } from "@shared/types/download";
import type { HotkeyApi } from "@shared/types/hotkey";
import type { StreamingApi } from "@shared/types/streaming";
import type { RecognitionApi } from "@shared/types/recognition";
import type { LastfmApi } from "@shared/types/lastfm";
import type { StatsApi } from "@shared/types/stats";
import type { UpdateApi } from "@shared/types/update";
import type { CloudUploadApi } from "@shared/types/cloudUpload";
import type { CommentsApi, MusicCommentQuery, MusicCommentResponse } from "@shared/types/comment";
import type { AiModelApi } from "@shared/types/ai";
import type { PlaylistApi } from "@shared/types/playlist";
import type { CjkTransformMode, OpenccApi } from "@shared/types/opencc";
import { nativeAudioPlayer, SystemUi } from "./nativeAudioPlayer";
import {
  callVendorApi,
  clearVendorSession,
  openVendorLoginWeb,
  setVendorCookie,
} from "./vendor/dispatch";
import { fetchLyricTTMLOverlay, matchLyricById, matchLyricByQuery } from "./vendor/lyric/index";
import {
  addPlaylistTracks,
  clearPlaylists,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylists,
  importLegacyPlaylists,
  removePlaylistTracks,
  updatePlaylist,
} from "./db/playlists";
import {
  getLibraryStats,
  getPlayHistoryDaily,
  getPlayHistoryHourly,
  getStatsSummary,
  getTopAlbums,
  getTopArtists,
  getTopTracks,
  insertFavoriteEvent,
  insertPlayEvent,
} from "./db/playStats";
import { fetchWithProxy } from "./vendor/shim/proxy";
import { createRecognitionApi } from "./services/recognition";
import { createStreamingApi } from "./services/streaming";
import { createDownloadApi } from "./services/download";
import { callAction } from "./plugins/runtime";
import { matchCover, matchLyric } from "./plugins/metadata";
import {
  applyUpdate,
  checkUpdate,
  ensureInitialized,
  installFromSource,
  listInfo,
  onStatus,
  setEnabled,
  setSetting,
  uninstall,
} from "./plugins/registry";
import { fetchMarket, fetchScript } from "./plugins/net";
import { getCommentSources, getMusicComments } from "./services/comments";
import { Converter } from "opencc-js";
import type { ConverterFunction } from "opencc-js";

/** 简繁转换映射；OpenCC 缓存按模式复用 */
const openccConverters = new Map<string, ConverterFunction>();
const openccConvert = (text: string, mode: CjkTransformMode): string => {
  if (!mode || mode === "none") return text;
  let converter = openccConverters.get(mode);
  if (!converter) {
    const localeMap: Record<string, { from: string; to: string }> = {
      s2t: { from: "cn", to: "t" },
      t2s: { from: "t", to: "cn" },
      s2tw: { from: "cn", to: "tw" },
      tw2s: { from: "tw", to: "cn" },
      s2hk: { from: "cn", to: "hk" },
      hk2s: { from: "hk", to: "cn" },
      s2twp: { from: "cn", to: "twp" },
      tw2sp: { from: "twp", to: "cn" },
      t2tw: { from: "t", to: "tw" },
      tw2t: { from: "tw", to: "t" },
      t2hk: { from: "t", to: "hk" },
      hk2t: { from: "hk", to: "t" },
      jp2t: { from: "jp", to: "t" },
      t2jp: { from: "t", to: "jp" },
    };
    const locale = localeMap[mode];
    if (!locale) return text;
    converter = Converter(locale);
    openccConverters.set(mode, converter);
  }
  return converter(text);
};

const unsupported = "Android bridge capability is not implemented";
const noopUnsubscribe =
  (..._args: unknown[]): (() => void) =>
  () => {};
const ok = <T = void>(data?: T): IpcResponse<T> => ({
  success: true,
  ...(data === undefined ? {} : { data }),
});
const fail = <T = never>(): IpcResponse<T> => ({ success: false, error: unsupported });
const unsupportedAsync = async <T = never>(): Promise<IpcResponse<T>> => fail<T>();

const defaultStatus: PlayerStatus = {
  state: "idle",
  position: 0,
  duration: 0,
  volume: 1,
  speed: 1,
  isFinished: false,
};

const emptyConfig = (): SystemConfig => structuredClone(defaultSystemConfig);

const CONFIG_PREFIX = "splayer.android.config.";

/** 按点路径写入嵌套对象（getAll 重建用） */
const setConfigPath = (root: Record<string, unknown>, keyPath: string, value: unknown): void => {
  const parts = keyPath.split(".");
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = node[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
};

const config: ConfigApi = {
  async get(keyPath) {
    const value = localStorage.getItem(`${CONFIG_PREFIX}${keyPath}`);
    return value === null ? undefined : JSON.parse(value);
  },
  async set(keyPath, value) {
    localStorage.setItem(`${CONFIG_PREFIX}${keyPath}`, JSON.stringify(value));
  },
  async getAll() {
    // 默认值打底，已存键逐条覆盖，否则重启后 system.* 全部回滚
    const merged = emptyConfig() as unknown as Record<string, unknown>;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(CONFIG_PREFIX)) continue;
      try {
        setConfigPath(
          merged,
          key.slice(CONFIG_PREFIX.length),
          JSON.parse(localStorage.getItem(key) ?? "null"),
        );
      } catch {
        // 单键损坏跳过
      }
    }
    return merged as unknown as SystemConfig;
  },
  async reset() {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(CONFIG_PREFIX)) localStorage.removeItem(key);
    }
  },
  async replaceAll() {},
  async exportToFile() {
    return { ok: false, reason: "canceled" as const };
  },
  async importFromFile() {
    return { ok: false, reason: "canceled" as const };
  },
};

/** 播放器：Media3 ExoPlayer 原生引擎（后台播放/均衡器/变速/频谱） */
const player: PlayerApi = nativeAudioPlayer;

/** Android 系统桥接 API：与旧桌面 preload 的 system 形状兼容，均为无操作或空实现 */
interface AndroidSystemApi {
  installType: "portable";
  platform: "android";
  osInfo: { type: string; arch: string; release: string };
  toggleDevTools: () => Promise<void>;
  showInExplorer: (filePath: string) => Promise<void>;
  openLogsDir: () => Promise<string>;
  setLocale: (locale: LocaleCode) => void;
  focusMainWindow: () => Promise<void>;
  openSettings: (category?: string, highlight?: string) => Promise<void>;
  onOpenSettings: (
    callback: (payload: { category?: string; highlight?: string }) => void,
  ) => () => void;
  listFonts: () => Promise<string[]>;
  fetchRemoteBytes: (url: string) => Promise<IpcResponse<Uint8Array | null>>;
  saveFile: (
    data: ArrayBuffer,
    fileName: string,
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  relaunch: () => Promise<void>;
  testNetworkProxy: () => Promise<boolean>;
  onProtocolUrl: (callback: (url: string) => void) => () => void;
  consumePendingProtocolUrl: () => Promise<string | null>;
  onOpenFiles: (callback: (files: string[]) => void) => () => void;
  consumePendingAudioFiles: () => Promise<string[]>;
  getPathForFile: (file: File) => string;
  /** Android：全屏沉浸（隐藏状态栏/导航小白条，滑动临时呼出） */
  setImmersive: (enabled: boolean) => Promise<void>;
  /** Android：系统栏图标明暗（true = 深色图标，浅色背景用） */
  setLightBars: (light: boolean) => Promise<void>;
}

const system: AndroidSystemApi = {
  installType: "portable",
  platform: "android",
  osInfo: { type: "Android", arch: "unknown", release: "unknown" },
  toggleDevTools: async () => {},
  showInExplorer: async (_filePath: string) => {},
  openLogsDir: async () => "",
  setLocale: (_locale: LocaleCode) => {},
  focusMainWindow: async () => {},
  openSettings: async (_category?: string, _highlight?: string) => {},
  onOpenSettings: noopUnsubscribe,
  listFonts: async () => [],
  fetchRemoteBytes: async (url: string) => {
    // 封面取色/模糊背景等要原始字节：走原生 HTTP（桌面主进程同款语义）
    try {
      const res = await fetchWithProxy(url);
      if (!res.ok) return { success: false as const, error: `HTTP ${res.status}` };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) return { success: false as const, error: "empty body" };
      return ok<Uint8Array | null>(bytes);
    } catch (err) {
      return { success: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
  saveFile: async (_data: ArrayBuffer, _fileName: string) => ({
    success: false,
    error: unsupported,
  }),
  relaunch: async () => {},
  testNetworkProxy: async () => false,
  onProtocolUrl: noopUnsubscribe,
  consumePendingProtocolUrl: async () => null,
  onOpenFiles: noopUnsubscribe,
  consumePendingAudioFiles: async () => [],
  getPathForFile: (file: File) => file.name,
  setImmersive: (enabled: boolean) => SystemUi.setImmersive({ enabled }),
  setLightBars: (light: boolean) => SystemUi.setLightBars({ light }),
};

const library: LibraryApi = {
  scan: unsupportedAsync,
  cancelScan: async () => ok(),
  getTracks: async () => ok([]),
  getAlbums: async () => ok([]),
  getArtists: async () => ok([]),
  getAlbumTracks: async () => ok([]),
  getArtistTracks: async () => ok([]),
  getTracksByIds: async () => ok([]),
  searchTracks: async () => ok([]),
  getTrackCount: async () => ok(0),
  getRandomTrack: async () => ok(null),
  getRandomTracks: async () => ok([]),
  isScanning: async () => ok(false),
  addScanDir: async () => fail<string>(),
  removeScanDir: async () => ok(),
  getScanDirs: async () => ok([]),
  deleteTracks: async () => fail<{ deleted: number; failed: number }>(),
  readTags: unsupportedAsync,
  writeTags: unsupportedAsync,
  pickCoverImage: unsupportedAsync,
  fetchArtistAvatar: async () => ok(null),
  prefetchArtistAvatars: async () => ok({}),
  onScanProgress: noopUnsubscribe,
};

const streaming = createStreamingApi() satisfies StreamingApi;

const nowPlaying: NowPlayingApi = {
  update: () => {},
  requestSnapshot: async () => ({
    track: null,
    lyric: [],
    source: null,
    position: 0,
    playing: false,
    state: "idle",
    speed: 1,
    lyricOffsetMs: 0,
    sendTimestamp: Date.now(),
  }),
  setLyricOffset: () => {},
  onTrackChange: noopUnsubscribe,
  onLyricChange: noopUnsubscribe,
  onPositionSync: noopUnsubscribe,
  onLyricOffsetChange: noopUnsubscribe,
};

/** 插件：与共享类型一致的全量实现（WebView 直跑运行时） */
const plugins: PluginsApi = {
  list: async () => {
    const items = await listInfo();
    return items;
  },
  install: async () => ({ ok: false, error: "当前平台不支持按路径导入" }),
  pickAndInstall: async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".js";
      const file = await new Promise<File | null>((resolve) => {
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
      });
      if (!file) return { ok: false, cancelled: true };
      const source = await file.text();
      const info = await installFromSource(source);
      return { ok: true, id: info.manifest.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  installFromUrl: async (url: string) => {
    try {
      const source = await fetchScript(url);
      const info = await installFromSource(source);
      return { ok: true, id: info.manifest.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  uninstall: async (id: string) => {
    try {
      await uninstall(id);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  setEnabled: async (id: string, enabled: boolean) => {
    await setEnabled(id, enabled);
  },
  setSetting: async (id: string, key: string, value: unknown) => {
    await setSetting(id, key, value);
  },
  checkUpdate: async (id: string) => {
    await ensureInitialized();
    return checkUpdate(id);
  },
  applyUpdate: async (id: string) => {
    await ensureInitialized();
    return applyUpdate(id);
  },
  resolveUrl: async (args) => {
    await ensureInitialized();
    const { ACTION_TIMEOUTS } = await import("@shared/defaults/plugin-api");
    const result = await callAction<MusicUrlRes>(
      args.pluginId,
      "musicUrl",
      {
        source: args.source,
        quality: args.quality ?? "hq",
        musicInfo: args.musicInfo,
      },
      ACTION_TIMEOUTS.musicUrl,
    );
    if (!result || typeof result.url !== "string" || !result.url) {
      throw new Error("plugin returned invalid URL");
    }
    return result;
  },
  invokeMenu: async (args) => {
    try {
      await ensureInitialized();
      const { ACTION_TIMEOUTS } = await import("@shared/defaults/plugin-api");
      const result = await callAction<{
        toast?: string;
        openUrl?: string;
        copyText?: string;
      }>(
        args.pluginId,
        "menuClick",
        { menuId: args.menuId, track: args.track },
        ACTION_TIMEOUTS.menuClick,
      );
      return {
        ok: true,
        toast: result?.toast,
        openUrl: result?.openUrl,
        copyText: result?.copyText,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  matchLyric: async (args) => {
    await ensureInitialized();
    const data = await matchLyric(args);
    return data ? { ok: true, data } : { ok: false };
  },
  matchCover: async (args) => {
    await ensureInitialized();
    const data = await matchCover(args);
    return data ? { ok: true, data } : { ok: false };
  },
  market: async () => {
    try {
      const list = await fetchMarket();
      return { ok: true, plugins: list };
    } catch (error) {
      return {
        ok: false,
        plugins: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  onStatus: (callback) => onStatus(callback),
};

/** 音源 API：直调上游 dev 同款 vendor 实现（platform/android/vendor） */
const apis: ApisApi = {
  call: (platform, name, params) => callVendorApi(platform, name, params ?? {}),
  clearSession: async (platform) => {
    clearVendorSession(platform);
  },
  openLoginWeb: (platform) => openVendorLoginWeb(platform),
  setCookie: async (platform, cookie) => setVendorCookie(platform, cookie),
};

const lyrics: LyricsApi = {
  matchById: (platform, id) => matchLyricById(platform, id),
  matchByQuery: (platform, track) => matchLyricByQuery(platform, track),
  fetchTTMLOverlay: (track, platform) => fetchLyricTTMLOverlay(track, platform),
  matchLocalTTML: async () => ({ ok: false, error: unsupported }),
  pickLyricRepoDir: async () => null,
};

const stats: StatsApi = {
  recordPlay: (event) => {
    void insertPlayEvent(event);
  },
  recordFavorite: (event) => {
    void insertFavoriteEvent(event);
  },
  getStatsSummary: () => getStatsSummary(),
  getTopTracks: (limit) => getTopTracks(limit),
  getLibraryStats: () => getLibraryStats(),
  getPlayHistoryDaily: (days) => getPlayHistoryDaily(days),
  getPlayHistoryHourly: () => getPlayHistoryHourly(),
  getTopAlbums: (limit) => getTopAlbums(limit),
  getTopArtists: (limit) => getTopArtists(limit),
};

const hotkey: HotkeyApi = {
  getAll: async () => structuredClone(defaultHotkeyConfig),
  set: async () => structuredClone(defaultHotkeyConfig),
  reset: async () => structuredClone(defaultHotkeyConfig),
  setGlobalEnabled: async () => structuredClone(defaultHotkeyConfig),
  probe: async () => false,
  getConflicts: async () => [],
  onTrigger: noopUnsubscribe,
  onConflicts: noopUnsubscribe,
};

const emptyApi = <T extends object>(extra: Partial<T> = {}): T =>
  new Proxy(extra, {
    get(target, property) {
      if (property in target) return target[property as keyof T];
      return (..._args: unknown[]) => Promise.resolve(undefined);
    },
  }) as T;

/** Android 缓存桥接 API：与旧桌面 preload 的 cache 形状兼容，均为无操作或空实现 */
interface AndroidCacheApi {
  getStats: () => Promise<{ id: string; kind: "file" | "db"; path: string; size: number }[]>;
  clear: (id: string) => Promise<void>;
  clearAllByKind: (kind: "file" | "db") => Promise<void>;
  getDir: () => Promise<string>;
  pickDir: () => Promise<{ ok: boolean; dir: string; reason?: "canceled" | "notEmpty" }>;
  resetDir: () => Promise<string>;
  song: {
    lookup: (cacheKey: string) => Promise<string | null>;
    fetch: (cacheKey: string, source: TrackSource, streamUrl: string) => Promise<string | null>;
    cancel: (cacheKey: string) => Promise<void>;
  };
}

const cache: AndroidCacheApi = {
  getStats: async () => [],
  clear: async (_id: string) => {},
  clearAllByKind: async (_kind: "file" | "db") => {},
  getDir: async () => "",
  pickDir: async () => ({ ok: false, dir: "", reason: "canceled" as const }),
  resetDir: async () => "",
  song: {
    lookup: async (_cacheKey: string) => null,
    fetch: async (_cacheKey: string, _source: TrackSource, _streamUrl: string) => null,
    cancel: async (_cacheKey: string) => {},
  },
};

/** 外部 API 服务桥接：形状与共享类型一致，Android 暂不启动服务 */
const externalApi: {
  restart: () => Promise<ExternalApiStatus>;
  getStatus: () => Promise<ExternalApiStatus>;
  onStatus: (callback: (status: ExternalApiStatus) => void) => () => void;
} = {
  restart: async () => ({
    listening: false,
    allowLan: false,
    host: null,
    port: null,
    error: null,
  }),
  getStatus: async () => ({
    listening: false,
    allowLan: false,
    host: null,
    port: null,
    error: null,
  }),
  onStatus: noopUnsubscribe,
};

/** MCP 服务桥接：形状与共享类型一致，Android 暂不启动服务 */
const mcpApi: {
  restart: () => Promise<McpStatus>;
  getStatus: () => Promise<McpStatus>;
  getClientConfigParams: () => Promise<McpClientConfigParams>;
  detectAgents: () => Promise<McpAgentApp[]>;
  injectAgentConfig: (agentId: string, params: McpClientConfigParams) => Promise<boolean>;
  onStatus: (callback: (status: McpStatus) => void) => () => void;
} = {
  restart: async () => ({ listening: false, port: null, error: null }),
  getStatus: async () => ({ listening: false, port: null, error: null }),
  getClientConfigParams: async () => ({ port: 0, accessKey: "" }),
  detectAgents: async () => [],
  injectAgentConfig: async (_agentId: string, _params: McpClientConfigParams) => false,
  onStatus: noopUnsubscribe,
};

/** 本地歌单：SQLite 持久化（db/playlists） */
const playlist: PlaylistApi = {
  list: () => getPlaylists(),
  get: (id) => getPlaylist(id),
  create: (input) => createPlaylist(input),
  update: (id, input) => updatePlaylist(id, input),
  remove: (id) => deletePlaylist(id),
  addTracks: (id, trackIds) => addPlaylistTracks(id, trackIds),
  removeTracks: (id, trackIds) => removePlaylistTracks(id, trackIds),
  importLegacy: (records) => importLegacyPlaylists(records),
  clear: () => clearPlaylists(),
};

const api = {
  config,
  player,
  system,
  library,
  playlist,
  nowPlaying,
  plugins,
  apis,
  cloud: emptyApi<CloudUploadApi>(),
  lyrics,
  opencc: {
    convert: async (text: string, mode: CjkTransformMode) => openccConvert(text, mode),
    convertBatch: async (texts: string[], mode: CjkTransformMode) =>
      Promise.all(texts.map((text) => openccConvert(text, mode))),
  } satisfies OpenccApi,
  comments: {
    sources: () => getCommentSources(),
    get: async (args: MusicCommentQuery): Promise<MusicCommentResponse> => {
      try {
        return { ok: true, data: await getMusicComments(args) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  } satisfies CommentsApi,
  download: createDownloadApi() satisfies DownloadApi,
  theme: { pickBackgroundImage: async () => null, clearBackgroundImages: async () => {} },
  cache,
  stats,
  hotkey,
  streaming,
  recognition: createRecognitionApi() satisfies RecognitionApi,
  lastfm: emptyApi<LastfmApi>(),
  externalApi: externalApi,
  mcp: mcpApi,
  aiModel: emptyApi<AiModelApi>(),
  update: {
    check: async (_manual: boolean) => {},
    download: async () => {},
    install: async () => {},
    openDownloadPage: async () => {},
    onEvent: noopUnsubscribe,
  } satisfies UpdateApi,
};

export type AndroidApi = typeof api;

/**
 * 在 Android 平台安装应用 API。
 * @returns 安装完成后的 API
 */
export const installAndroidBridge = (): AndroidApi => {
  const appWindow = globalThis as typeof globalThis & { api?: typeof api };
  if (!appWindow.api) appWindow.api = api;
  return appWindow.api;
};
