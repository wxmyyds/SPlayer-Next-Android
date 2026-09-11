/**
 * Android 下载任务管理器：
 * 队列顺序 + 缺 URL 时发 onResolve（渲染层 resolver 补全）+ 调原生 DownloadSaver
 * 流式落盘（MediaStore Music/SPlayer）+ 任务状态持久化（localStorage）。
 * 对齐上游 download: IPC 契约（shared/types/download.ts DownloadApi）。
 * 内嵌标签暂不支持（无原生 tag 写入器），文件元信息经 MediaStore 列写入。
 */

import type {
  DownloadApi,
  DownloadProgress,
  DownloadRequest,
  DownloadResolution,
  DownloadResolvePayload,
  DownloadTask,
} from "@shared/types/download";
import { registerPlugin } from "@capacitor/core";

/** 原生落盘插件接口 */
interface DownloadSaverPlugin {
  saveAudio(options: {
    taskId: string;
    url: string;
    displayName: string;
    ext: string;
    title?: string;
    artist?: string;
    album?: string;
    declaredSize?: number;
  }): Promise<void>;
  saveText(options: { name: string; content: string }): Promise<void>;
  cancel(options: { taskId: string }): Promise<void>;
  getDir(): Promise<{ path: string }>;
  addListener(
    event: "event",
    callback: (payload: unknown) => void,
  ): Promise<{ remove: () => void }>;
}

const DownloadSaver = registerPlugin<DownloadSaverPlugin>("DownloadSaver");

/** 任务持久化键 */
const STORAGE_KEY = "splayer.android.download.tasks";

/** 设置未暴露时的目录兜底展示值 */
const DIR_LABEL = "Music/SPlayer";

/** 运行期扩展字段（DownloadRequest 中主进程持有的部分） */
type AndroidDownloadTask = DownloadTask &
  Pick<
    DownloadRequest,
    | "url"
    | "declaredFormat"
    | "declaredSize"
    | "lyricText"
    | "ttmlText"
    | "tagOptions"
    | "coverUrl"
    | "usePlaybackForDownload"
    | "lyricFileFormat"
  >;

let tasks: AndroidDownloadTask[] = [];
let activeTaskId: string | null = null;
const progressListeners = new Set<(data: DownloadProgress) => void>();
const stateListeners = new Set<(task: DownloadTask) => void>();
const resolveListeners = new Set<(payload: DownloadResolvePayload) => void>();
let wired = false;

/** 活跃态判定 */
const isActive = (status: DownloadTask["status"]): boolean =>
  status === "queued" || status === "downloading";

/** 持久化任务表 */
const persist = (): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (error) {
    console.error("[download] 任务持久化失败:", error);
  }
};

/** 广播单任务状态 */
const emitState = (task: DownloadTask): void => {
  persist();
  for (const listener of stateListeners) listener({ ...task });
};

/** 广播进度 */
const emitProgress = (data: DownloadProgress): void => {
  for (const listener of progressListeners) listener(data);
};

/** 音频扩展名（declaredFormat 优先，回退 URL 推断，再回退 mp3） */
const pickExt = (task: AndroidDownloadTask): string => {
  const declared = task.declaredFormat?.toLowerCase();
  if (declared && /^[a-z0-9]{1,5}$/.test(declared)) return declared;
  const fromUrl = task.url?.split("?")[0]?.split(".").pop()?.toLowerCase();
  if (fromUrl && /^[a-z0-9]{1,5}$/.test(fromUrl)) return fromUrl;
  return "mp3";
};

/** 音频文件展示名：歌手 - 标题.ext */
const displayName = (task: AndroidDownloadTask): string => {
  const artist =
    task.track.artists
      ?.map((item) => item.name)
      .filter(Boolean)
      .join(", ") ?? "";
  const raw = artist ? `${artist} - ${task.track.title}` : task.track.title;
  return raw.replaceAll(/[\\/:*?"<>|]/g, "_").trim() || task.taskId;
};

/** 启动当前队首任务的传输（FIFO） */
const pump = (): void => {
  if (activeTaskId) return;
  const head = tasks
    .filter((task) => task.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!head) return;
  if (!head.url) {
    // 轮到下载但缺少 URL：广播解析请求（渲染层 resolver 异步回传 submitResolution）
    const payload: DownloadResolvePayload = {
      taskId: head.taskId,
      track: head.track,
      qualityLevel: head.qualityLevel,
      tagOptions: head.tagOptions,
      coverUrl: head.coverUrl,
      usePlaybackForDownload: head.usePlaybackForDownload,
      lyricFileFormat: head.lyricFileFormat,
    };
    for (const listener of resolveListeners) listener(payload);
    return;
  }
  activeTaskId = head.taskId;
  head.status = "downloading";
  head.received = 0;
  head.total = head.declaredSize ?? 0;
  emitState(head);
  void DownloadSaver.saveAudio({
    taskId: head.taskId,
    url: head.url,
    displayName: displayName(head),
    ext: pickExt(head),
    title: head.track.title,
    artist: head.track.artists?.map((item) => item.name).join(", "),
    album: head.track.album?.name,
    declaredSize: head.declaredSize,
  }).catch((error) => {
    // saveAudio reject 已先发 state(failed)；此处兜底防队列悬挂
    if (activeTaskId === head.taskId) {
      activeTaskId = null;
      head.status = "failed";
      head.errorCode = error instanceof Error ? error.message : String(error);
      head.finishedAt = Date.now();
      emitState(head);
      pump();
    }
  });
};

/** 原生事件接线（进程内一次） */
const wire = (): void => {
  if (wired) return;
  wired = true;
  // 启动恢复：在途任务标记中断（可重试）
  tasks = tasks.map((task) =>
    isActive(task.status) ? { ...task, status: "interrupted" as const } : task,
  );
  persist();
  void DownloadSaver.addListener("event", (payload) => {
    const data = payload as { type: string; data?: Record<string, unknown> };
    const raw = data.data ?? {};
    const taskId = String(raw.taskId ?? "");
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) return;
    if (data.type === "progress") {
      task.received = Number(raw.received ?? 0);
      if (Number(raw.total ?? 0) > 0) task.total = Number(raw.total);
      emitProgress({ taskId, received: task.received, total: task.total });
      return;
    }
    if (data.type !== "state") return;
    if (raw.filePath) {
      task.status = "done";
      task.filePath = String(raw.filePath);
      if (task.total > 0) task.received = task.total;
      task.finishedAt = Date.now();
      activeTaskId = null;
      // 歌词伴生文件（.lrc / .ttml）
      const base = displayName(task);
      if (task.lyricText && task.tagOptions.writeLrc) {
        void DownloadSaver.saveText({ name: `${base}.lrc`, content: task.lyricText }).catch(
          () => {},
        );
      }
      if (task.ttmlText && task.tagOptions.saveTtml) {
        void DownloadSaver.saveText({ name: `${base}.ttml`, content: task.ttmlText }).catch(
          () => {},
        );
      }
      emitState(task);
      pump();
      return;
    }
    // 取消后迟到的失败事件：本地已是终态则忽略
    if (task.status === "canceled") return;
    task.status = "failed";
    task.errorCode = String(raw.errorCode ?? "unknown");
    task.finishedAt = Date.now();
    activeTaskId = null;
    emitState(task);
    pump();
  });
};

/** 同曲同音质去重键 */
const dedupeKey = (task: Pick<DownloadRequest, "track" | "qualityLevel">): string =>
  `${task.track.id}:${task.qualityLevel}`;

/** 入队（含去重）；返回任务与结果 */
const enqueue = (
  req: DownloadRequest,
): { result: { ok: boolean; reason?: "queued" | "downloaded" } } => {
  const key = dedupeKey(req);
  if (tasks.some((task) => dedupeKey(task) === key && isActive(task.status))) {
    return { result: { ok: false, reason: "queued" } };
  }
  if (tasks.some((task) => dedupeKey(task) === key && task.status === "done")) {
    return { result: { ok: false, reason: "downloaded" } };
  }
  const task: AndroidDownloadTask = {
    taskId: req.taskId,
    status: "queued",
    track: req.track,
    qualityLevel: req.qualityLevel,
    received: 0,
    total: req.declaredSize ?? 0,
    createdAt: Date.now(),
    url: req.url,
    coverUrl: req.coverUrl,
    declaredFormat: req.declaredFormat,
    declaredSize: req.declaredSize,
    lyricText: req.lyricText,
    ttmlText: req.ttmlText,
    tagOptions: req.tagOptions,
    usePlaybackForDownload: req.usePlaybackForDownload,
    lyricFileFormat: req.lyricFileFormat,
  };
  tasks.push(task);
  return { result: { ok: true } };
};

/** 创建下载 API（bridge.ts 接线用） */
export const createDownloadApi = (): DownloadApi => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as AndroidDownloadTask[];
    if (Array.isArray(saved)) tasks = saved;
  } catch {
    tasks = [];
  }
  wire();

  return {
    start: async (req) => {
      const { result } = enqueue(req);
      persist();
      pump();
      return result;
    },
    startMany: async (reqs) => {
      const results = reqs.map((req) => enqueue(req).result);
      persist();
      pump();
      return results;
    },
    cancel: async (taskId) => {
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task || !isActive(task.status)) return;
      task.status = "canceled";
      task.finishedAt = Date.now();
      if (activeTaskId === taskId) {
        activeTaskId = null;
        void DownloadSaver.cancel({ taskId }).catch(() => {});
      }
      emitState(task);
      pump();
    },
    retry: async (req) => {
      tasks = tasks.filter((task) => task.taskId !== req.taskId);
      const { result } = enqueue(req);
      persist();
      pump();
      return result;
    },
    remove: async (taskId) => {
      const task = tasks.find((item) => item.taskId === taskId);
      if (task && isActive(task.status)) {
        if (activeTaskId === taskId) {
          activeTaskId = null;
          void DownloadSaver.cancel({ taskId }).catch(() => {});
        }
        task.status = "canceled";
        pump();
      }
      tasks = tasks.filter((item) => item.taskId !== taskId);
      persist();
    },
    clearFinished: async () => {
      tasks = tasks.filter((task) => isActive(task.status));
      persist();
    },
    list: async () => tasks.map((task) => ({ ...task })),
    pickDir: async () => ({ ok: false, dir: DIR_LABEL, reason: "canceled" as const }),
    getDir: async () => {
      try {
        return (await DownloadSaver.getDir()).path;
      } catch {
        return DIR_LABEL;
      }
    },
    resetDir: async () => {
      try {
        return (await DownloadSaver.getDir()).path;
      } catch {
        return DIR_LABEL;
      }
    },
    submitResolution: async (taskId, res: DownloadResolution) => {
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task || task.status !== "queued") return;
      task.url = res.url;
      task.declaredFormat = res.declaredFormat;
      task.declaredSize = res.declaredSize;
      task.lyricText = res.lyricText;
      task.ttmlText = res.ttmlText;
      persist();
      pump();
    },
    failResolution: async (taskId) => {
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task || task.status !== "queued") return;
      task.status = "failed";
      task.errorCode = "resolve";
      task.finishedAt = Date.now();
      emitState(task);
      pump();
    },
    onProgress: (callback) => {
      progressListeners.add(callback);
      return () => progressListeners.delete(callback);
    },
    onState: (callback) => {
      stateListeners.add(callback);
      return () => stateListeners.delete(callback);
    },
    onResolve: (callback) => {
      resolveListeners.add(callback);
      return () => resolveListeners.delete(callback);
    },
  };
};
