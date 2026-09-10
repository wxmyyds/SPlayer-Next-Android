import { isAndroid } from "@/utils/platform";
import { getNeteaseCookies } from "@android/vendor/netease";
import { UA_MAP } from "@android/vendor/netease/core/config";
import { cookieObjToString } from "@android/vendor/netease/core/cookie";
import { NETEASE_LEVEL } from "@/apis/song/netease";
import { useSettingsStore } from "@/stores/settings";
import type { CandidateResult } from "@/core/player/candidate";

/** 原生自治队列上限：30 首元数据 ≈ 2 小时锁屏播放，纯元数据推送零网络成本 */
const QUEUE_SIZE = 30;

/**
 * 向原生推送自治切歌队列（SFA PlaybackQueue 等价）：
 * 只推元数据 + eapi 解析上下文（cookie/设备指纹由 JS 组装，易变知识不下沉原生），
 * ENDED/预填时原生逐条自解 URL，锁屏连续切歌完全不等 WebView。
 * 仅 netease 源可被原生解析，其余源交给预解析窗口（setNextResources）覆盖。
 * @param candidates - 预载调度算出的候选列表（含首候选在内的接下来至多 QUEUE_SIZE 首）
 */
export const pushNativeQueue = (candidates: CandidateResult[]): void => {
  if (!isAndroid || !candidates.length) return;
  const level = NETEASE_LEVEL[useSettingsStore().player.songLevel];
  const items = candidates
    .filter(({ track }) => track.source === "netease")
    .slice(0, QUEUE_SIZE)
    .map(({ track, index }) => ({
      trackId: track.id,
      songId: track.id,
      playIndex: index,
      level,
      title: track.title,
      artist: track.artists?.map((a) => a.name).join(" / ") ?? "",
      album: track.album?.name ?? "",
      artwork: track.coverOriginal ?? track.cover ?? "",
      durationMs: track.duration ?? 0,
    }));
  if (!items.length) return;

  const cookies = getNeteaseCookies();
  const header = {
    osver: cookies.osver ?? "",
    deviceId: cookies.deviceId ?? "",
    os: cookies.os ?? "android",
    appver: cookies.appver ?? "9.1.65",
    versioncode: cookies.versioncode ?? "140",
    mobilename: cookies.mobilename ?? "",
    buildver: cookies.buildver ?? Math.floor(Date.now() / 1000).toString(),
    resolution: cookies.resolution ?? "1920x1080",
    __csrf: cookies.__csrf ?? "",
    channel: cookies.channel ?? "",
    requestId: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    MUSIC_U: cookies.MUSIC_U ?? "",
    MUSIC_A: cookies.MUSIC_A ?? "",
  };
  window.api.player
    .setNextQueue?.({
      items,
      resolve: {
        path: "/api/song/enhance/player/url/v1",
        header,
        cookie: cookieObjToString(header),
        userAgent: UA_MAP.api.iphone,
      },
    })
    .catch((err) => console.error("[nextQueue] setNextQueue failed:", err));
};
