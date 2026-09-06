import type { ElectronAPI } from "@electron-toolkit/preload";
import { defaultHotkeyConfig } from "@shared/defaults/hotkeys";
import { defaultSystemConfig } from "@shared/defaults/settings";
import type { IpcResponse, PlayerApi, PlayerEvent, PlayerStatus } from "@shared/types/player";
import type { ConfigApi, SystemConfig } from "@shared/types/settings";
import type { LibraryApi } from "@shared/types/library";
import type { NowPlayingApi } from "@shared/types/nowPlaying";
import type { PluginsApi } from "@shared/types/plugin";
import type { ApisApi } from "@shared/types/apis";
import type { LyricsApi } from "@shared/types/lyrics";
import type { DownloadApi } from "@shared/types/download";
import type {
  WindowApi,
  DesktopLyricApi,
  DynamicIslandApi,
  TaskbarLyricApi,
} from "@shared/types/window";
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
import type { OpenccApi } from "@shared/types/opencc";

const unsupported = "Android bridge capability is not implemented";
const noopUnsubscribe = (): (() => void) => () => {};
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

const player: PlayerApi = {
  load: unsupportedAsync,
  play: unsupportedAsync,
  pause: unsupportedAsync,
  stop: async () => ok(),
  seek: unsupportedAsync,
  setVolume: async () => ok(),
  setPauseOnDeviceSwitch: async () => ok(),
  getVolume: async () => ok(defaultStatus.volume),
  getStatus: async () => ok({ ...defaultStatus }),
  setFftEnabled: async () => ok(),
  getFftData: async () => ok({ ldata: [], rdata: [] }),
  setFadeDuration: async () => ok(),
  getFadeDuration: async () => ok(0),
  getCoverRaw: async () => ok(null),
  readLyricFile: unsupportedAsync,
  reinit: async () => ok(),
  setNormalizationEnabled: async () => ok(),
  setEqualizerEnabled: async () => ok(),
  setEqualizerBands: async () => ok(),
  setPreampGain: async () => ok(),
  setSpeed: async () => ok(),
  setPitch: async () => ok(),
  setPitchSync: async () => ok(),
  getOutputDevices: async () =>
    ok([{ id: "android-default", name: "Android 默认输出", isDefault: true }]),
  getDefaultDeviceName: async () => ok("Android 默认输出"),
  setOutputDevice: async () => ok(),
  getSelectedDeviceName: async () => ok("Android 默认输出"),
  syncPlayMode: () => {},
  syncLikeState: () => {},
  dispatch: () => {},
  onEvent: (_callback: (event: PlayerEvent) => void) => noopUnsubscribe(),
};

const system = {
  installType: "portable" as const,
  platform: "android" as NodeJS.Platform,
  osInfo: { type: "Android", arch: "unknown", release: "unknown" },
  toggleDevTools: async () => {},
  showInExplorer: async () => {},
  openLogsDir: async () => "",
  setLocale: () => {},
  focusMainWindow: async () => {},
  openSettings: async () => {},
  onOpenSettings: noopUnsubscribe,
  listFonts: async () => [],
  fetchRemoteBytes: async () => fail<Buffer | null>(),
  saveFile: async () => ({ success: false, error: unsupported }),
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

const emptyStreaming = {
  songs: [],
  albums: [],
  artists: [],
  playlists: [],
};

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

const windowApi: WindowApi = {
  toggleDesktopLyric: async () => false,
  closeDesktopLyric: async () => {},
  isDesktopLyricOpen: async () => false,
  onDesktopLyricVisibilityChange: noopUnsubscribe,
  toggleDynamicIsland: async () => false,
  closeDynamicIsland: async () => {},
  isDynamicIslandOpen: async () => false,
  onDynamicIslandVisibilityChange: noopUnsubscribe,
  toggleTaskbarLyric: async () => false,
  closeTaskbarLyric: async () => {},
  isTaskbarLyricOpen: async () => false,
  onTaskbarLyricVisibilityChange: noopUnsubscribe,
  minimize: () => {},
  toggleMaximize: () => {},
  isMaximized: async () => false,
  onMaximizeChange: noopUnsubscribe,
  toggleFullscreen: () => {},
  isFullscreen: async () => false,
  onFullscreenChange: noopUnsubscribe,
  hide: () => {},
  quit: () => {},
};

const desktopLyric: DesktopLyricApi = {
  onConfigChange: noopUnsubscribe,
  setHeight: async () => {},
  setUnlockButtonBounds: () => {},
  move: () => {},
  saveState: () => {},
  onCursorInside: noopUnsubscribe,
};

const dynamicIsland: DynamicIslandApi = {
  onConfigChange: noopUnsubscribe,
  move: () => {},
  saveState: () => {},
  resize: () => {},
  setShape: () => {},
  setHeight: () => {},
  getMode: async () => "floating",
  onModeChange: noopUnsubscribe,
  onCursorInside: noopUnsubscribe,
};

const taskbarLyric: TaskbarLyricApi = {
  onLayout: noopUnsubscribe,
  onConfigChange: noopUnsubscribe,
  setContentWidth: () => {},
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

const apis: ApisApi = {
  call: async () => ({ ok: false, error: unsupported }),
  clearSession: async () => {},
  openLoginWeb: async () => ({ ok: false, error: unsupported }),
  setCookie: async () => ({ ok: false, error: unsupported }),
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

const api = {
  config,
  player,
  system,
  library,
  playlist: emptyApi<PlaylistApi>(),
  window: windowApi,
  desktopLyric,
  dynamicIsland,
  taskbarLyric,
  nowPlaying,
  plugins,
  apis,
  cloud: emptyApi<CloudUploadApi>(),
  lyrics,
  opencc: {
    convert: async (text: string) => text,
    convertBatch: async (texts: string[]) => texts,
  } satisfies OpenccApi,
  comments: emptyApi<CommentsApi>(),
  download: emptyApi<DownloadApi>(),
  theme: { pickBackgroundImage: async () => null, clearBackgroundImages: async () => {} },
  cache: emptyApi({
    getStats: async () => [],
    clear: async () => {},
    clearAllByKind: async () => {},
    getDir: async () => "",
    pickDir: async () => ({ ok: false, dir: "", reason: "canceled" as const }),
    resetDir: async () => "",
    song: { lookup: async () => null, fetch: async () => null, cancel: async () => {} },
  }),
  stats,
  hotkey,
  streaming,
  recognition: emptyApi<RecognitionApi>(),
  lastfm: emptyApi<LastfmApi>(),
  externalApi: {
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
  },
  mcp: {
    restart: async () => ({ listening: false, port: null, error: null }),
    getStatus: async () => ({ listening: false, port: null, error: null }),
    getClientConfigParams: async () => ({ port: 0, accessKey: "" }),
    detectAgents: async () => [],
    injectAgentConfig: async () => false,
    onStatus: noopUnsubscribe,
  },
  aiModel: emptyApi<AiModelApi>(),
  update: {
    check: async () => {},
    download: async () => {},
    install: async () => {},
    openDownloadPage: async () => {},
    onEvent: noopUnsubscribe,
  } satisfies UpdateApi,
};

if (!window.api) {
  window.api = api;
}

if (!window.electron) {
  window.electron = {
    process: {
      platform: "android",
      versions: { electron: "0.0.0", chrome: "0.0.0", node: "0.0.0" },
    },
  } as unknown as ElectronAPI;
}
