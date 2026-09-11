import { isAndroid } from "@/utils/platform";
import { getNeteaseCookies } from "@android/vendor/netease";
import { UA_MAP } from "@android/vendor/netease/core/config";
import { cookieObjToString } from "@android/vendor/netease/core/cookie";
import { processCookieObject } from "@android/vendor/netease/core/request";
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
  if (!isAndroid) return;
  const level = NETEASE_LEVEL[useSettingsStore().player.songLevel];
  // 原生只能直接解析网易云；遇到其他音源就在此断开，不能过滤后把后面的网易云曲目提前
  const firstUnsupported = candidates.findIndex(({ track }) => track.source !== "netease");
  const items = candidates
    .slice(0, firstUnsupported < 0 ? QUEUE_SIZE : firstUnsupported)
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
  if (!items.length) {
    void window.api.player.clearNextResource?.().catch(() => {});
    return;
  }

  // 与 request.ts eapi 分支同源：补全设备指纹默认值（deviceId/osver/channel/appver），
  // 保证原生自解与 JS 侧请求的 cookie 指纹一致；空串用 || 回退默认值
  const cookies = processCookieObject(getNeteaseCookies(), "/api/song/enhance/player/url/v1");
  const header = {
    osver: cookies.osver || "",
    deviceId: cookies.deviceId || "",
    os: cookies.os || "android",
    appver: cookies.appver || "9.1.65",
    versioncode: cookies.versioncode || "140",
    mobilename: cookies.mobilename || "",
    buildver: cookies.buildver || Math.floor(Date.now() / 1000).toString(),
    resolution: cookies.resolution || "1920x1080",
    __csrf: cookies.__csrf || "",
    channel: cookies.channel || "",
    requestId: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
    MUSIC_U: cookies.MUSIC_U || "",
    MUSIC_A: cookies.MUSIC_A || "",
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
