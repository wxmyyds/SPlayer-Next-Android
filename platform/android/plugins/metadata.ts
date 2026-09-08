/** 插件脚本元数据解析与插件歌词/封面回退匹配。 */

import * as pako from "pako";
import type { Track } from "@shared/types/player";
import type {
  MusicLyricRes,
  MusicPicRes,
  MusicSearchCandidate,
  PluginGrant,
  PluginManifest,
  PluginMatchCoverArgs,
  PluginMatchLyricArgs,
  PluginType,
} from "@shared/types/plugin";
import { PLUGIN_GRANTS, PLUGIN_TYPES } from "@shared/types/plugin";
import { ACTION_TIMEOUTS, HOST_API_LEVEL, PluginErrorCodes } from "@shared/defaults/plugin-api";
import { callAction, getRuntime } from "./runtime";
import { getRuntimeState } from "./registry";
import { b64Decode } from "../vendor/shim/webcrypto";
import { sha1Bytes } from "./crypto";

const FIELD_LIMITS: Record<string, number> = {
  name: 64,
  description: 512,
  author: 64,
  homepage: 1024,
  version: 36,
  changelog: 1000,
};

const HEADER_RE = /^\s*\*?\s*@(\w+)\s+(.+)$/;
const BLOCK_COMMENT_RE = /^\s*\/\*[\s\S]*?\*\//;

const hexSha1 = (source: string): string => {
  const bytes = sha1Bytes(new TextEncoder().encode(source));
  return Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("");
};

const gzipDecode = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("gz_")) return raw;
  const bytes = b64Decode(trimmed.slice(3));
  return new TextDecoder().decode(pako.inflate(bytes));
};

/** 解析脚本 JSDoc 头并生成清单；与上游 manifest 语义一致。 */
export const parseScript = (raw: string): PluginManifest => {
  const source = gzipDecode(raw);
  const blockMatch = BLOCK_COMMENT_RE.exec(source);
  const block = blockMatch ? blockMatch[0].slice(2, -2) : source.slice(0, 3000);
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = HEADER_RE.exec(line);
    if (!match) continue;
    const key = match[1];
    const limit = FIELD_LIMITS[key];
    const value =
      limit && match[2].length > limit ? `${match[2].slice(0, limit)}...` : match[2].trim();
    fields[key] = value;
  }
  const declaredId = fields.id
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
  const hash = hexSha1(source);
  const name = fields.name || `user_api_${hash.slice(0, 6)}`;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || hash.slice(0, 8);
  const id = declaredId || slug;
  const type = (PLUGIN_TYPES as readonly string[]).includes(fields.type ?? "")
    ? (fields.type as PluginType)
    : "source";
  const apiLevel = Number.parseInt(fields.apiLevel ?? "1", 10) || 1;
  if (apiLevel > HOST_API_LEVEL) {
    throw Object.assign(new Error("plugin API level not supported"), {
      code: PluginErrorCodes.API_LEVEL_MISMATCH,
    });
  }
  if (type === "control" && apiLevel < 2) {
    throw Object.assign(new Error("control plugin requires apiLevel >= 2"), {
      code: PluginErrorCodes.API_LEVEL_MISMATCH,
    });
  }
  const grant =
    type === "control"
      ? ((fields.grant ?? "")
          .split(/[,\s]+/)
          .map((item) => item.trim().toLowerCase())
          .filter((item): item is PluginGrant =>
            (PLUGIN_GRANTS as readonly string[]).includes(item),
          ) satisfies PluginGrant[])
      : (["network"] satisfies PluginGrant[]);
  return {
    id,
    name,
    version: fields.version ?? "0.0.0",
    description: fields.description,
    author: fields.author,
    homepage: fields.homepage,
    grant,
    type,
    apiLevel,
    hash,
    updateUrl: fields.updateUrl ?? fields.updateURL,
    changelog: fields.changelog?.replace(/\\n/g, "\n"),
    installedAt: Date.now(),
    fileName: `${id}.js`,
  };
};

const PLATFORM_SOURCE: Record<string, string> = { netease: "wy", qqmusic: "tx", kugou: "kg" };

const normalize = (text?: string | null): string =>
  (text ?? "").toLowerCase().replace(/[、&;，,/|()·・\s\-_'"`~!?？！.。]+/g, "");

const bothContains = (left: string, right: string): boolean =>
  left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left));

const durationClose = (left?: number, right?: number, tolerance = 5000): boolean => {
  if (!left || !right) return false;
  return Math.abs(left - right) <= tolerance;
};

const durationFar = (left?: number, right?: number, tolerance = 20000): boolean => {
  if (!left || !right) return false;
  return Math.abs(left - right) > tolerance;
};

const artistMatches = (
  candidate: string,
  artists: string[],
): { exact: boolean; contains: boolean } => {
  const candidateName = normalize(candidate);
  const parts = candidateName
    .split(/[\/，、]/)
    .map(normalize)
    .filter(Boolean);
  if (artists.includes(candidateName)) return { exact: true, contains: false };
  const contains = artists.some(
    (artist) =>
      artist.length >= 2 &&
      (bothContains(candidateName, artist) || parts.some((part) => bothContains(part, artist))),
  );
  return { exact: false, contains };
};

const pickBestCandidate = <E>(
  candidates: { name: string; artist: string; album?: string; duration?: number; extra: E }[],
  track: Track,
): E | null => {
  const trackName = normalize(track.title);
  const trackArtists = (track.artists ?? []).map((artist) => normalize(artist.name));
  const trackAlbum = normalize(track.album?.name);
  const trackDuration = track.duration;
  let best: { score: number; extra: E } | null = null;
  for (const candidate of candidates) {
    const candidateName = normalize(candidate.name);
    const candidateAlbum = normalize(candidate.album);
    const exact = candidateName !== "" && candidateName === trackName;
    if (!exact) {
      if (!bothContains(candidateName, trackName)) continue;
      const longer = Math.max(candidateName.length, trackName.length);
      const shorter = Math.min(candidateName.length, trackName.length);
      if (longer === 0 || shorter / longer < 0.34) continue;
    }
    if (durationFar(candidate.duration, trackDuration)) continue;
    const artist = artistMatches(candidate.artist, trackArtists);
    if (trackArtists.length > 0 && !artist.exact && !artist.contains) continue;
    if (
      !exact &&
      !artist.exact &&
      !artist.contains &&
      !durationClose(candidate.duration, trackDuration)
    )
      continue;
    let score = exact ? 10 : 4;
    if (artist.exact) score += 5;
    else if (artist.contains) score += 2;
    if (trackAlbum && candidateAlbum === trackAlbum) score += 2;
    if (durationClose(candidate.duration, trackDuration)) score += 3;
    if (!best || score > best.score) best = { score, extra: candidate.extra };
  }
  return best?.extra ?? null;
};

const findMatch = async (
  pluginId: string,
  source: string,
  track: Track,
): Promise<MusicSearchCandidate | null> => {
  if (PLATFORM_SOURCE[track.source] === source && track.id) {
    return {
      id: track.id,
      name: track.title,
      singer: track.artists?.map((artist) => artist.name).join("/") ?? "",
      album: track.album?.name,
      durationMs: track.duration,
    };
  }
  const keyword =
    `${track.title} ${track.artists?.map((artist) => artist.name).join(" ") ?? ""}`.trim();
  if (!keyword) return null;
  const result = await callAction<{ list?: MusicSearchCandidate[] }>(
    pluginId,
    "musicSearch",
    { source, keyword },
    ACTION_TIMEOUTS.musicSearch,
  );
  const list = result.list ?? [];
  if (!list.length) return null;
  return pickBestCandidate(
    list.map((item) => ({
      name: item.name,
      artist: item.singer ?? "",
      album: item.album,
      duration: item.durationMs,
      extra: item,
    })),
    track,
  );
};

export const matchLyric = async (args: PluginMatchLyricArgs): Promise<MusicLyricRes | null> => {
  const state = await getRuntimeState(args.pluginId);
  if (!state || state.status.state !== "ready") return null;
  try {
    const musicInfo = await findMatch(args.pluginId, args.source, args.track);
    if (!musicInfo) return null;
    const lyric = await callAction<MusicLyricRes>(
      args.pluginId,
      "musicLyric",
      { source: args.source, musicInfo },
      ACTION_TIMEOUTS.musicLyric,
    );
    return lyric?.lyric ? lyric : null;
  } catch {
    return null;
  }
};

export const matchCover = async (args: PluginMatchCoverArgs): Promise<MusicPicRes | null> => {
  const state = await getRuntimeState(args.pluginId);
  if (!state || state.status.state !== "ready") return null;
  try {
    const musicInfo = await findMatch(args.pluginId, args.source, args.track);
    if (!musicInfo) return null;
    const pic = await callAction<MusicPicRes>(
      args.pluginId,
      "musicPic",
      { source: args.source, musicInfo },
      ACTION_TIMEOUTS.musicPic,
    );
    return pic?.url ? pic : null;
  } catch {
    return null;
  }
};
