/** Android 插件注册表：管理清单、脚本生命周期、设置和状态通知。 */

import type {
  PluginInfo,
  PluginManifest,
  PluginMenuItem,
  PluginSettingItem,
  PluginStatus,
  PluginUpdateInfo,
  PlaybackEventKind,
  SourceCapability,
} from "@shared/types/plugin";
import { HOST_API_LEVEL, PluginErrorCodes } from "@shared/defaults/plugin-api";
import { watch, toRaw } from "vue";
import { APP_VERSION } from "@/utils/config";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import {
  dataDrop,
  readEnabled,
  readManifests,
  readScript,
  readSettings,
  removeScript,
  writeEnabled,
  writeManifests,
  writeScript,
  writeSettings,
} from "./storage";
import { fetchScript } from "./net";
import {
  getRuntime,
  loadPlugin,
  unloadPlugin,
  deliverPlaybackEvent,
  deliverSettingsUpdate,
  type PluginLoadSpec,
  type RuntimeCallbacks,
} from "./runtime";

interface RuntimeState {
  manifest: PluginManifest;
  source: string;
  enabled: boolean;
  status: PluginStatus;
  events: PlaybackEventKind[];
  controls: boolean;
  settings: PluginSettingItem[];
  menus: PluginMenuItem[];
  updateInfo: PluginUpdateInfo | null;
  loading: boolean;
  userSettingsCache: Record<string, unknown>;
}

type StatusListener = (info: PluginInfo) => void;

const runtimes = new Map<string, RuntimeState>();
const statusListeners = new Set<StatusListener>();
const controlListeners = new Set<(active: boolean) => void>();
const readyListeners = new Set<(id: string) => void>();
let initialized = false;
let initPromise: Promise<void> | null = null;

const infoOf = (runtime: RuntimeState): PluginInfo => ({
  manifest: runtime.manifest,
  enabled: runtime.enabled,
  status: runtime.status,
  updateInfo: runtime.updateInfo,
  // 双源合并：userSettingsCache 始终打底（含插件注册前从存储读入的值），
  // 已注册设置项逐条覆盖（缺省值兜底），避免注册前 settingsValues 为空
  settingsValues: {
    ...runtime.userSettingsCache,
    ...runtime.settings.reduce<Record<string, unknown>>((result, item) => {
      result[item.key] = runtime.userSettingsCache[item.key] ?? item.default;
      return result;
    }, {}),
  },
});

const emitStatus = (runtime: RuntimeState): void => {
  const info = infoOf(runtime);
  for (const listener of statusListeners) listener(info);
  const active = hasEnabledControlPlugin();
  for (const listener of controlListeners) listener(active);
};

const setStatus = (runtime: RuntimeState, status: PluginStatus): void => {
  runtime.status = status;
  emitStatus(runtime);
};

const sanitizeSetting = (item: PluginSettingItem, value: unknown): unknown => {
  if (item.type === "switch") return Boolean(value);
  if (item.type === "number") {
    const number = Number(value);
    const fallback = Number(item.default);
    const result = Number.isFinite(number) ? number : fallback;
    return Math.min(item.max ?? result, Math.max(item.min ?? result, result));
  }
  if (item.type === "select") {
    return item.options?.some((option) => option.value === value) ? value : item.default;
  }
  return String(value ?? "");
};

const isNewerVersion = (remote: string, local: string): boolean => {
  const parse = (version: string): number[] =>
    version
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .map((item) => Number.parseInt(item, 10) || 0);
  const left = parse(remote);
  const right = parse(local);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return false;
};

const callbacksFor = (runtime: RuntimeState): RuntimeCallbacks => ({
  onReady: (sources) => {
    runtime.loading = false;
    runtime.status = {
      state: "ready",
      sources,
      events: runtime.events,
      controls: runtime.controls,
      settings: runtime.settings,
      menus: runtime.menus,
    };
    emitStatus(runtime);
    if (runtime.controls) for (const listener of readyListeners) listener(runtime.manifest.id);
  },
  onRegistered: ({ events, controls, settings, menus }) => {
    runtime.events = events;
    runtime.controls = controls;
    runtime.settings = settings;
    runtime.menus = runtime.manifest.grant.includes("ui") ? menus : [];
    if (runtime.status.state === "ready") {
      setStatus(runtime, {
        ...runtime.status,
        events,
        controls,
        settings,
        menus: runtime.menus,
      });
    }
  },
  onSourcesUpdate: (sources: Record<string, SourceCapability>) => {
    if (runtime.status.state === "ready") {
      setStatus(runtime, { ...runtime.status, sources: { ...runtime.status.sources, ...sources } });
    }
  },
  onUpdateAvailable: (info) => {
    runtime.updateInfo = info;
    emitStatus(runtime);
  },
  onFatal: (error) => {
    runtime.loading = false;
    setStatus(runtime, { state: "error", error });
  },
  onLog: (_level, _args) => {
    // 插件日志留在 WebView console，避免 Android 发布包写文件
  },
});

const start = async (runtime: RuntimeState): Promise<void> => {
  if (!runtime.enabled || runtime.loading || runtime.status.state === "ready") return;
  runtime.loading = true;
  setStatus(runtime, { state: "loading" });
  const values = await readSettings(runtime.manifest.id);
  const spec: PluginLoadSpec = {
    pluginId: runtime.manifest.id,
    manifest: runtime.manifest,
    source: runtime.source,
    locale: useSettingsStore().locale,
    appVersion: APP_VERSION,
    userSettings: { ...values },
  };
  try {
    loadPlugin(spec, callbacksFor(runtime));
  } catch (error) {
    runtime.loading = false;
    setStatus(runtime, {
      state: "error",
      error: {
        code: (error as { code?: string })?.code ?? PluginErrorCodes.SCRIPT_ERROR,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

export const ensureInitialized = async (): Promise<void> => {
  if (initialized) return;
  initPromise ??= (async () => {
    const [manifests, enabled] = await Promise.all([readManifests(), readEnabled()]);
    for (const [id, manifest] of Object.entries(manifests)) {
      const source = await readScript(id);
      if (!source) continue;
      const settings = await readSettings(id);
      const runtime: RuntimeState = {
        manifest,
        source,
        enabled: enabled[id] ?? true,
        status: enabled[id] === false ? { state: "disabled" } : { state: "unloaded" },
        events: [],
        controls: false,
        settings: [],
        menus: [],
        updateInfo: null,
        loading: false,
        userSettingsCache: { ...settings },
      };
      runtimes.set(id, runtime);
    }
    initialized = true;
    await Promise.all(
      Array.from(runtimes.values())
        .filter((item) => item.enabled)
        .map(start),
    );
    void Promise.all(Array.from(runtimes.values()).map((item) => checkUpdate(item.manifest.id)));
    ensureEventBridge();
  })();
  await initPromise;
};

export const listInfo = async (): Promise<PluginInfo[]> => {
  await ensureInitialized();
  return Array.from(runtimes.values()).map(infoOf);
};

export const onStatus = (listener: StatusListener): (() => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};

export const onControlActivity = (listener: (active: boolean) => void): (() => void) => {
  controlListeners.add(listener);
  return () => controlListeners.delete(listener);
};

export const onControlReady = (listener: (id: string) => void): (() => void) => {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
};

export const getRuntimeState = async (id: string): Promise<RuntimeState | undefined> => {
  await ensureInitialized();
  return runtimes.get(id);
};

export const installFromSource = async (source: string): Promise<PluginInfo> => {
  const { parseScript } = await import("./metadata");
  const manifest = parseScript(source);
  if (manifest.apiLevel > HOST_API_LEVEL) throw new Error("plugin API level is too new");
  const existing = runtimes.get(manifest.id);
  manifest.fileName = `${manifest.id}.js`;
  if (existing) manifest.installedAt = existing.manifest.installedAt;
  await writeScript(manifest.id, source);
  const manifests = await readManifests();
  manifests[manifest.id] = manifest;
  await writeManifests(manifests);
  const enabled = await readEnabled();
  enabled[manifest.id] = true;
  await writeEnabled(enabled);
  if (existing) unloadPlugin(existing.manifest.id);
  const settings = await readSettings(manifest.id);
  const runtime: RuntimeState = {
    manifest,
    source,
    enabled: true,
    status: { state: "unloaded" },
    events: [],
    controls: false,
    settings: [],
    menus: [],
    updateInfo: null,
    loading: false,
    userSettingsCache: { ...settings },
  };
  runtimes.set(manifest.id, runtime);
  await start(runtime);
  return infoOf(runtime);
};

export const uninstall = async (id: string): Promise<void> => {
  await ensureInitialized();
  const runtime = runtimes.get(id);
  if (!runtime) return;
  unloadPlugin(id);
  runtimes.delete(id);
  const manifests = await readManifests();
  delete manifests[id];
  await writeManifests(manifests);
  await removeScript(id);
  const enabled = await readEnabled();
  delete enabled[id];
  await writeEnabled(enabled);
  await dataDrop(id);
};

export const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
  await ensureInitialized();
  const runtime = runtimes.get(id);
  if (!runtime) return;
  runtime.enabled = enabled;
  const enabledMap = await readEnabled();
  enabledMap[id] = enabled;
  await writeEnabled(enabledMap);
  if (enabled) await start(runtime);
  else {
    unloadPlugin(id);
    runtime.loading = false;
    setStatus(runtime, { state: "disabled" });
  }
};

export const setSetting = async (id: string, key: string, value: unknown): Promise<void> => {
  const runtime = await getRuntimeState(id);
  if (!runtime) return;
  const item = runtime.settings.find((setting) => setting.key === key);
  if (!item) return;
  const values = await readSettings(id);
  values[key] = sanitizeSetting(item, value);
  runtime.userSettingsCache = { ...values };
  await writeSettings(id, values);
  deliverSettingsUpdate(id, { [key]: values[key] });
  emitStatus(runtime);
};

export const pickForAction = async (
  action: keyof import("@shared/types/plugin").ActionIO,
  source?: string,
): Promise<RuntimeState | undefined> => {
  await ensureInitialized();
  for (const runtime of runtimes.values()) {
    if (!runtime.enabled || runtime.status.state !== "ready") continue;
    const sources = runtime.status.sources;
    for (const [key, capability] of Object.entries(sources)) {
      if ((!source || key === source) && capability.actions.includes(action)) return runtime;
    }
  }
  return undefined;
};

export const hasEnabledControlPlugin = (): boolean =>
  Array.from(runtimes.values()).some(
    (runtime) => runtime.enabled && runtime.controls && runtime.status.state === "ready",
  );

export const broadcastPlaybackEvent = <K extends PlaybackEventKind>(
  event: K,
  data: import("@shared/types/plugin").PlaybackEventData[K],
): void => {
  for (const runtime of runtimes.values()) {
    if (runtime.enabled && runtime.controls && runtime.events.includes(event)) {
      deliverPlaybackEvent(runtime.manifest.id, event, data);
    }
  }
};

export const sendPlaybackEventTo = <K extends PlaybackEventKind>(
  id: string,
  event: K,
  data: import("@shared/types/plugin").PlaybackEventData[K],
): void => deliverPlaybackEvent(id, event, data);

export const checkUpdate = async (
  id: string,
): Promise<{ ok: boolean; hasUpdate: boolean; plugin?: PluginInfo; error?: string }> => {
  const runtime = await getRuntimeState(id);
  if (!runtime?.manifest.updateUrl)
    return { ok: false, hasUpdate: false, plugin: runtime && infoOf(runtime) };
  try {
    const source = await fetchScript(runtime.manifest.updateUrl);
    const { parseScript } = await import("./metadata");
    const remote = parseScript(source);
    if (remote.id !== id || !isNewerVersion(remote.version, runtime.manifest.version)) {
      runtime.updateInfo = null;
      return { ok: true, hasUpdate: false, plugin: infoOf(runtime) };
    }
    runtime.updateInfo = {
      version: remote.version,
      log: remote.changelog,
      updateUrl: runtime.manifest.updateUrl,
      updatedAt: Date.now(),
    };
    emitStatus(runtime);
    return { ok: true, hasUpdate: true, plugin: infoOf(runtime) };
  } catch (error) {
    return {
      ok: false,
      hasUpdate: false,
      plugin: infoOf(runtime),
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const applyUpdate = async (
  id: string,
): Promise<{ ok: boolean; plugin?: PluginInfo; error?: string; fallbackUrl?: string }> => {
  const runtime = await getRuntimeState(id);
  if (!runtime?.manifest.updateUrl) return { ok: false, error: "update URL missing" };
  try {
    const source = await fetchScript(runtime.manifest.updateUrl);
    const plugin = await installFromSource(source);
    runtime.updateInfo = null;
    return { ok: true, plugin };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fallbackUrl: runtime.manifest.updateUrl,
    };
  }
};

/** 控制类插件播放事件桥：上游走 nowPlaying 服务，Android 直连 store watch */
const attachEventBridge = (): void => {
  let attached = false;
  let lyricLines: import("@shared/types/lyrics").LyricLine[] = [];
  let lyricIndex = -1;
  let stops: Array<() => void> = [];
  const prime = (pluginId?: string): void => {
    const media = useMediaStore();
    const status = useStatusStore();
    const position = status.position;
    const send = pluginId
      ? (event: PlaybackEventKind, data: unknown) =>
          sendPlaybackEventTo(pluginId, event, data as never)
      : broadcastPlaybackEvent;
    send("trackChange", { track: toRaw(media.track) ?? null });
    send("lyricChange", { lines: media.parsedLyric });
    send("playStateChange", { state: status.isPlaying ? "playing" : "paused", position });
    const index = lyricLines.length
      ? lyricLines.filter((line) => line.startTime <= position + status.lyricOffsetMs).length - 1
      : -1;
    if (index >= 0) send("lineChange", { index, position });
  };
  const attach = (): void => {
    if (attached) return;
    attached = true;
    const media = useMediaStore();
    const status = useStatusStore();
    stops = [
      watch(
        () => media.track?.id,
        () => {
          lyricLines = media.parsedLyric;
          lyricIndex = -1;
          prime();
        },
      ),
      watch(
        () => media.parsedLyric,
        (lines) => {
          lyricLines = lines;
          lyricIndex = -1;
          broadcastPlaybackEvent("lyricChange", { lines });
        },
      ),
      watch(
        () => status.isPlaying,
        () => {
          broadcastPlaybackEvent("playStateChange", {
            state: status.isPlaying ? "playing" : "paused",
            position: status.position,
          });
        },
      ),
      watch(
        () => status.position,
        (position) => {
          if (!lyricLines.length) return;
          const next =
            lyricLines.filter((line) => line.startTime <= position + status.lyricOffsetMs).length -
            1;
          if (next === lyricIndex) return;
          lyricIndex = next;
          broadcastPlaybackEvent("lineChange", { index: next, position });
        },
      ),
    ];
  };
  const detach = (): void => {
    for (const stop of stops) stop();
    stops = [];
    attached = false;
    lyricLines = [];
    lyricIndex = -1;
  };
  onControlActivity((active) => (active ? attach() : detach()));
  onControlReady((id) => {
    if (attached) prime(id);
  });
  if (hasEnabledControlPlugin()) attach();
};

let eventBridgeDone = false;
/** 确保事件桥只挂一次（渲染层无需感知，播放时自动带上） */
export const ensureEventBridge = (): void => {
  if (eventBridgeDone) return;
  eventBridgeDone = true;
  attachEventBridge();
};
