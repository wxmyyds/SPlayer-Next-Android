/**
 * 评论服务（Android 版，复刻上游 electron/main/services/comments）
 *
 * 内置源：网易/QQ/酷狗（走 platform/android/vendor 各自的 call* 入口）；
 * 插件源：声明 musicSearch + musicComment 动作的音源自动出现。
 */

import type {
  CommentSource,
  CommentTab,
  MusicCommentItem,
  MusicCommentPage,
  MusicCommentQuery,
} from "@shared/types/comment";
import type { PluginInfo } from "@shared/types/plugin";
import type { Track } from "@shared/types/player";
import { PLATFORM_SHORT_NAME } from "@shared/types/platform";
import { callNetease } from "../vendor/netease";
import { callQQMusic } from "../vendor/qqmusic";
import { callKugou } from "../vendor/kugou";
import { pickBestCandidate, type LyricCandidate } from "../vendor/lyric/utils";
import { callAction } from "../plugins/runtime";
import { ACTION_TIMEOUTS } from "@shared/defaults/plugin-api";
import { findMatch } from "../plugins/metadata";

const NETEASE_SOURCE_ID = "builtin:netease";
const QQMUSIC_SOURCE_ID = "builtin:qqmusic";
const KUGOU_SOURCE_ID = "builtin:kugou";

const PLATFORM_TO_PLUGIN_SOURCE: Record<string, string> = {
  netease: "wy",
  qqmusic: "tx",
  kugou: "kg",
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface ParsedPluginSource {
  pluginId: string;
  source: string;
}

const parsePluginSource = (sourceId: string): ParsedPluginSource | null => {
  if (!sourceId.startsWith("plugin:")) return null;
  const rest = sourceId.slice("plugin:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return { pluginId: rest.slice(0, sep), source: rest.slice(sep + 1) };
};

const toKeyword = (track: Track): string =>
  `${track.title} ${track.artists?.map((artist) => artist.name).join(" ") ?? ""}`.trim();

/* ========== 响应体形状 ========== */

interface NeteaseComment {
  commentId?: string | number;
  beRepliedCommentId?: string | number;
  content?: string;
  time?: number;
  likedCount?: number;
  ipLocation?: { location?: string };
  user?: { userId?: string | number; nickname?: string; avatarUrl?: string };
  beReplied?: NeteaseComment[];
  replyCount?: number;
}

interface NeteaseCommentBody {
  total?: number;
  hotComments?: NeteaseComment[];
  comments?: NeteaseComment[];
  data?: { totalCount?: number; comments?: NeteaseComment[] };
}

interface QQMusicComment {
  Avatar?: string;
  CmId?: string;
  Content?: string;
  EncryptUin?: string;
  Location?: string;
  Nick?: string;
  Pic?: string;
  PraiseNum?: number;
  PubTime?: number;
  ReplyCnt?: number;
  RepliedComments?: QQMusicComment[];
  SubComments?: QQMusicComment[];
}

interface QQMusicCommentBody {
  comments?: QQMusicComment[];
  total?: number;
  hasMore?: boolean;
  nextCursor?: string;
}

interface KugouComment {
  id?: string | number;
  content?: string;
  addtime?: string;
  user_id?: string | number;
  user_name?: string;
  user_pic?: string;
  location?: string;
  reply_num?: number;
  like?: { count?: number };
  images?: Array<{ url?: string }>;
}

interface KugouCommentBody {
  count?: number;
  current_page?: number;
  list?: KugouComment[];
  data?: { count?: number; current_page?: number; list?: KugouComment[] };
}

const toStringId = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
};

const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text || undefined;
};

/* ========== 归一化 ========== */

const normalizeNeteaseComment = (raw: NeteaseComment): MusicCommentItem | null => {
  const id = toStringId(raw.commentId ?? raw.beRepliedCommentId);
  const text = optionalString(raw.content);
  if (!id || !text) return null;
  const userId = toStringId(raw.user?.userId);
  const reply = (raw.beReplied ?? [])
    .map((item) => normalizeNeteaseComment(item))
    .filter((item): item is MusicCommentItem => item !== null);
  const item: MusicCommentItem = { id, userName: optionalString(raw.user?.nickname) ?? "", text };
  if (userId) item.userId = userId;
  const avatar = optionalString(raw.user?.avatarUrl);
  if (avatar) item.avatar = avatar;
  if (typeof raw.time === "number") item.time = raw.time;
  const location = optionalString(raw.ipLocation?.location);
  if (location) item.location = location;
  if (typeof raw.likedCount === "number") item.likedCount = raw.likedCount;
  if (typeof raw.replyCount === "number") item.replyTotal = raw.replyCount;
  if (reply.length) item.reply = reply;
  return item;
};

const normalizeNeteaseCommentPage = (
  body: NeteaseCommentBody,
  type: CommentTab,
  page: number,
  limit: number,
): MusicCommentPage => {
  const rawList =
    type === "hot" ? (body.hotComments ?? body.data?.comments ?? []) : (body.comments ?? body.data?.comments ?? []);
  const list = rawList
    .map((item) => normalizeNeteaseComment(item))
    .filter((item): item is MusicCommentItem => item !== null);
  return {
    list,
    total: body.total ?? body.data?.totalCount ?? list.length,
    page,
    limit,
  };
};

const normalizeQQMusicComment = (raw: QQMusicComment): MusicCommentItem | null => {
  const id = optionalString(raw.CmId);
  const text = optionalString(raw.Content);
  if (!id || !text) return null;
  const rawReplies = raw.RepliedComments?.length ? raw.RepliedComments : raw.SubComments;
  const reply = (rawReplies ?? [])
    .map((item) => normalizeQQMusicComment(item))
    .filter((item): item is MusicCommentItem => item !== null);
  const item: MusicCommentItem = { id, userName: optionalString(raw.Nick) ?? "", text };
  const userId = optionalString(raw.EncryptUin);
  if (userId) item.userId = userId;
  const avatar = optionalString(raw.Avatar)?.replace(/^http:/, "https:");
  if (avatar) item.avatar = avatar;
  if (typeof raw.PubTime === "number") item.time = raw.PubTime * 1000;
  const location = optionalString(raw.Location);
  if (location) item.location = location;
  if (typeof raw.PraiseNum === "number") item.likedCount = raw.PraiseNum;
  if (typeof raw.ReplyCnt === "number") item.replyTotal = raw.ReplyCnt;
  const image = optionalString(raw.Pic)?.replace(/^http:/, "https:");
  if (image) item.images = [image];
  if (reply.length) item.reply = reply;
  return item;
};

const normalizeQQMusicCommentPage = (
  body: QQMusicCommentBody,
  page: number,
  limit: number,
): MusicCommentPage => {
  const list = (body.comments ?? [])
    .map((item) => normalizeQQMusicComment(item))
    .filter((item): item is MusicCommentItem => item !== null);
  return {
    list,
    total: body.total ?? list.length,
    page,
    limit,
    ...(body.hasMore && body.nextCursor ? { nextCursor: body.nextCursor } : {}),
  };
};

const normalizeKugouComment = (raw: KugouComment): MusicCommentItem | null => {
  const id = toStringId(raw.id);
  const text = optionalString(raw.content);
  if (!id || !text) return null;
  const item: MusicCommentItem = { id, userName: optionalString(raw.user_name) ?? "", text };
  const userId = toStringId(raw.user_id);
  if (userId) item.userId = userId;
  const avatar = optionalString(raw.user_pic);
  if (avatar) item.avatar = avatar;
  const time = optionalString(raw.addtime);
  if (time) {
    const timestamp = new Date(time.replace(" ", "T")).getTime();
    if (Number.isFinite(timestamp)) item.time = timestamp;
  }
  const location = optionalString(raw.location);
  if (location) item.location = location;
  if (typeof raw.like?.count === "number") item.likedCount = raw.like.count;
  if (typeof raw.reply_num === "number") item.replyTotal = raw.reply_num;
  const images = (raw.images ?? [])
    .map((image) => optionalString(image.url))
    .filter((image): image is string => Boolean(image));
  if (images.length) item.images = images;
  return item;
};

const normalizeKugouCommentPage = (
  body: KugouCommentBody,
  page: number,
  limit: number,
): MusicCommentPage => {
  const data = body.data ?? body;
  const list = (data.list ?? [])
    .map((item) => normalizeKugouComment(item))
    .filter((item): item is MusicCommentItem => item !== null);
  return {
    list,
    total: data.count ?? list.length,
    page: data.current_page ?? page,
    limit,
  };
};

/* ========== 内置源 ========== */

const findNeteaseId = async (track: Track): Promise<string | null> => {
  if (track.source === "netease" && track.id) return track.id;
  const keyword = toKeyword(track);
  if (!keyword) return null;
  const { status, body } = await callNetease("search", { keywords: keyword, type: 1, limit: 20 });
  if (status !== 200) return null;
  const songs =
    (
      body as {
        result?: {
          songs?: Array<{
            id: number;
            name?: string;
            artists?: Array<{ name: string }>;
            album?: { name?: string };
            duration?: number;
          }>;
        };
      }
    ).result?.songs ?? [];
  const candidates: LyricCandidate<{ id: string }>[] = songs.map((song) => ({
    name: song.name ?? "",
    artist: (song.artists ?? []).map((artist) => artist.name).join(" / "),
    album: song.album?.name,
    duration: song.duration,
    extra: { id: String(song.id) },
  }));
  return pickBestCandidate(candidates, track)?.extra.id ?? null;
};

const getNeteaseComments = async (args: MusicCommentQuery): Promise<MusicCommentPage> => {
  const id = await findNeteaseId(args.track);
  if (!id) return { list: [], total: 0, page: args.page, limit: args.limit };
  const apiName = args.type === "hot" ? "comment_hot" : "comment_music";
  const { body } = await callNetease(apiName, {
    id,
    limit: args.limit,
    offset: (args.page - 1) * args.limit,
  });
  return normalizeNeteaseCommentPage(
    body as NeteaseCommentBody,
    args.type,
    args.page,
    args.limit,
  );
};

const findQQMusicId = async (track: Track): Promise<string | null> => {
  if (track.source === "qqmusic") {
    return track.extId || (/^\d+$/.test(track.id) ? track.id : null);
  }
  const keyword = toKeyword(track);
  if (!keyword) return null;
  const body = (await callQQMusic("search", { keywords: keyword, type: 0, page: 1, limit: 20 })) as {
    songs?: Array<{
      id?: string;
      name?: string;
      artist?: string;
      album?: string;
      duration?: number;
    }>;
  };
  const candidates: LyricCandidate<{ id: string }>[] = (body.songs ?? []).map((song) => ({
    name: song.name ?? "",
    artist: song.artist ?? "",
    album: song.album,
    duration: song.duration,
    extra: { id: song.id ?? "" },
  }));
  return pickBestCandidate(candidates, track)?.extra.id || null;
};

const getQQMusicComments = async (args: MusicCommentQuery): Promise<MusicCommentPage> => {
  const id = await findQQMusicId(args.track);
  if (!id) return { list: [], total: 0, page: args.page, limit: args.limit };
  const body = (await callQQMusic("comment", {
    id,
    type: args.type,
    page: args.page,
    limit: args.limit,
    cursor: args.cursor,
  })) as QQMusicCommentBody;
  return normalizeQQMusicCommentPage(body, args.page, args.limit);
};

const findKugouId = async (track: Track): Promise<string | null> => {
  if (track.source === "kugou" && track.extId) return track.extId;
  const keyword = toKeyword(track);
  if (!keyword) return null;
  const body = await callKugou<{ songs?: Array<{ albumAudioId?: number; name: string; artist: string; album: string; duration: number }> }>(
    "search",
    { keywords: keyword, type: 0, page: 1, limit: 20 },
  );
  const candidates: LyricCandidate<{ id: string }>[] = (body.songs ?? [])
    .filter((song) => song.albumAudioId)
    .map((song) => ({
      name: song.name,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      extra: { id: String(song.albumAudioId) },
    }));
  return pickBestCandidate(candidates, track)?.extra.id || null;
};

const getKugouComments = async (args: MusicCommentQuery): Promise<MusicCommentPage> => {
  if (args.type !== "hot") return { list: [], total: 0, page: args.page, limit: args.limit };
  const id = await findKugouId(args.track);
  if (!id) return { list: [], total: 0, page: args.page, limit: args.limit };
  const body = await callKugou<KugouCommentBody>("comment", {
    id,
    page: args.page,
    limit: args.limit,
  });
  return normalizeKugouCommentPage(body, args.page, args.limit);
};

/* ========== 插件源 ========== */

const getPluginComments = async (
  parsed: ParsedPluginSource,
  args: MusicCommentQuery,
): Promise<MusicCommentPage> => {
  const musicInfo = await findMatch(parsed.pluginId, parsed.source, args.track);
  if (!musicInfo) return { list: [], total: 0, page: args.page, limit: args.limit };
  return await callAction<MusicCommentPage>(
    parsed.pluginId,
    "musicComment",
    {
      source: parsed.source,
      musicInfo,
      type: args.type,
      page: args.page,
      limit: args.limit,
    },
    ACTION_TIMEOUTS.musicComment,
  );
};

/* ========== 对外入口 ========== */

const normalizeQuery = (args: MusicCommentQuery): MusicCommentQuery => ({
  ...args,
  page: Math.max(1, Math.floor(Number(args.page) || 1)),
  limit: Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit) || DEFAULT_LIMIT))),
});

/** 构建可用评论源：内置 3 个 + 已就绪插件的 musicSearch+musicComment 音源 */
const getCommentSources = async (): Promise<CommentSource[]> => {
  const sources: CommentSource[] = [
    { id: NETEASE_SOURCE_ID, name: PLATFORM_SHORT_NAME.netease, kind: "builtin", platform: "netease" },
    { id: QQMUSIC_SOURCE_ID, name: PLATFORM_SHORT_NAME.qqmusic, kind: "builtin", platform: "qqmusic" },
    {
      id: KUGOU_SOURCE_ID,
      name: PLATFORM_SHORT_NAME.kugou,
      kind: "builtin",
      platform: "kugou",
      tabs: ["hot"],
    },
  ];
  const { listInfo } = await import("../plugins/registry");
  for (const info of await listInfo()) {
    if (!info.enabled || info.status.state !== "ready") continue;
    for (const [source, cap] of Object.entries(info.status.sources)) {
      if (!cap.actions.includes("musicSearch") || !cap.actions.includes("musicComment")) continue;
      sources.push({
        id: `plugin:${info.manifest.id}:${source}`,
        name: cap.name,
        kind: "plugin",
        pluginId: info.manifest.id,
        pluginSource: source,
      });
    }
  }
  return sources;
};

/** 获取歌曲评论（按 sourceId 分发） */
export const getMusicComments = async (args: MusicCommentQuery): Promise<MusicCommentPage> => {
  const query = normalizeQuery(args);
  if (query.sourceId === NETEASE_SOURCE_ID) return getNeteaseComments(query);
  if (query.sourceId === QQMUSIC_SOURCE_ID) return getQQMusicComments(query);
  if (query.sourceId === KUGOU_SOURCE_ID) return getKugouComments(query);
  const parsed = parsePluginSource(query.sourceId);
  if (parsed) return getPluginComments(parsed, query);
  throw new Error(`unknown comment source: ${query.sourceId}`);
};

export { getCommentSources };
