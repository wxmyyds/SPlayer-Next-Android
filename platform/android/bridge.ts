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
import type { PluginsApi } from "@shared/types/plugin";
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
import type { CommentsApi } from "@shared/types/comment";
import type { AiModelApi } from "@shared/types/ai";
import type { PlaylistApi } from "@shared/types/playlist";
import type { CjkTransformMode, OpenccApi } from "@shared/types/opencc";
import { htmlAudioPlayer } from "./htmlAudioPlayer";
import {
  callVendorApi,
  clearVendorSession,
  openVendorLoginWeb,
  setVendorCookie,
} from "./vendor/dispatch";
import { fetchWithProxy } from "./vendor/shim/proxy";

const unsupported = "Android bridge capability is not implemented";
const noopUnsubscribe = (..._args: unknown[]): (() => void) => () => {};
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

const config: ConfigApi = {
  async get(keyPath) {
    const value = localStorage.getItem(`splayer.android.config.${keyPath}`);
    return value === null ? undefined : JSON.parse(value);
  },
  async set(keyPath, value) {
    localStorage.setItem(`splayer.android.config.${keyPath}`, JSON.stringify(value));
  },
  async getAll() {
    return emptyConfig();
  },
  async reset() {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("splayer.android.config.")) localStorage.removeItem(key);
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

/** 播放器：过渡期用 HTMLAudio 实现可听闭环，后续替换为 Rust 引擎 */
const player: PlayerApi = htmlAudioPlayer;

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

const emptyStreaming = { songs: [], albums: [], artists: [], playlists: [] };

const streaming: StreamingApi = {
  loadServers: async () => ({ servers: [], activeServerId: null }),
  addServer: async () => {
    throw new Error(unsupported);
  },
  updateServer: async () => {
    throw new Error(unsupported);
  },
  removeServer: async () => {},
  setActiveServer: async () => {},
  testConnection: async () => ({ ok: false, error: unsupported, code: "unknown" }),
  connect: async () => ({ ok: false, error: unsupported, code: "unknown" }),
  disconnect: async () => {},
  getSnapshot: async () => emptyStreaming,
  sync: async () => false,
  onLibraryUpdated: noopUnsubscribe,
  search: async () => ({ songs: [], albums: [], artists: [] }),
  getAlbumSongs: async () => [],
  getPlaylistSongs: async () => [],
  getArtistAlbums: async () => [],
  getArtistSongs: async () => [],
  getStreamUrl: async () => {
    throw new Error(unsupported);
  },
  getLyrics: async () => null,
};

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

const plugins: PluginsApi = {
  list: async () => [],
  install: async () => ({ ok: false, error: unsupported }),
  pickAndInstall: async () => ({ ok: false, error: unsupported }),
  installFromUrl: async () => ({ ok: false, error: unsupported }),
  uninstall: async () => ({ ok: false, error: unsupported }),
  setEnabled: async () => {},
  setSetting: async () => {},
  checkUpdate: async () => ({ ok: false, hasUpdate: false, error: unsupported }),
  applyUpdate: async () => ({ ok: false, error: unsupported }),
  resolveUrl: async () => ({ url: "" }),
  invokeMenu: async () => ({ ok: false, error: unsupported }),
  matchLyric: async () => ({ ok: false, error: unsupported }),
  matchCover: async () => ({ ok: false, error: unsupported }),
  market: async () => ({ ok: false, plugins: [], error: unsupported }),
  onStatus: noopUnsubscribe,
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
  matchById: async () => ({ ok: false, error: unsupported }),
  matchByQuery: async () => ({ ok: false, error: unsupported }),
  fetchTTMLOverlay: async () => ({ ok: false, error: unsupported }),
  matchLocalTTML: async () => ({ ok: false, error: unsupported }),
  pickLyricRepoDir: async () => null,
};

const stats: StatsApi = {
  recordPlay: () => {},
  recordFavorite: () => {},
  getStatsSummary: async () => ({
    todayListenedMs: 0,
    weekListenedMs: 0,
    lastWeekListenedMs: 0,
    totalListenedMs: 0,
    weekPlayCount: 0,
    totalPlayCount: 0,
    weekFavoriteAdds: 0,
    streakDays: 0,
  }),
  getTopTracks: async () => [],
  getLibraryStats: async () => ({
    trackCount: 0,
    albumCount: 0,
    artistCount: 0,
    totalDurationMs: 0,
    totalFileSize: 0,
    codecs: [],
  }),
  getPlayHistoryDaily: async () => [],
  getPlayHistoryHourly: async () => [],
  getTopAlbums: async () => [],
  getTopArtists: async () => [],
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
    fetch: (
      cacheKey: string,
      source: TrackSource,
      streamUrl: string,
    ) => Promise<string | null>;
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

const api = {
  config,
  player,
  system,
  library,
  playlist: emptyApi<PlaylistApi>(),
  nowPlaying,
  plugins,
  apis,
  cloud: emptyApi<CloudUploadApi>(),
  lyrics,
  opencc: {
    convert: async (text: string) => text,
    convertBatch: async (texts: string[], _mode: CjkTransformMode) => texts,
  } satisfies OpenccApi,
  comments: emptyApi<CommentsApi>(),
  download: emptyApi<DownloadApi>(),
  theme: { pickBackgroundImage: async () => null, clearBackgroundImages: async () => {} },
  cache,
  stats,
  hotkey,
  streaming,
  recognition: emptyApi<RecognitionApi>(),
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
