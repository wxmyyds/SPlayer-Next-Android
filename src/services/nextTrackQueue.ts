import { isAndroid } from "@/utils/platform";
import { useStatusStore } from "@/stores/status";
import * as autoClose from "@/services/autoClose";
import { getNeteaseCookies } from "@android/vendor/netease";
import { cookieObjToString } from "@android/vendor/netease/core/cookie";
import { getSessionCookies } from "@android/vendor/shim/sessions";
import { processCookieObject } from "@android/vendor/netease/core/request";
import { NETEASE_LEVEL } from "@/apis/song/netease";
import { getQualityLevel } from "@/utils/quality";
import { useSettingsStore } from "@/stores/settings";
import type { CandidateResult } from "@/core/player/candidate";

/** 原生自治队列上限：30 首元数据 ≈ 2 小时锁屏播放，纯元数据推送零网络成本 */
const QUEUE_SIZE = 30;

/**
 * 向原生推送自治切歌队列（SFA PlaybackQueue 等价）：
 * 只推元数据 + 登录态（cookie/会话种子由 JS 组装，易变知识不下沉原生），
 * ENDED/预填时引擎逐条自解 URL，锁屏连续切歌完全不等 WebView。
 * netease / kugou / qqmusic 可被引擎解析，其余源交给预解析窗口（setNextResources）覆盖。
 * @param candidates - 预载调度算出的候选列表（含首候选在内的接下来至多 QUEUE_SIZE 首）
 */
export const pushNativeQueue = (candidates: CandidateResult[]): void => {
  if (!isAndroid) return;
  const status = useStatusStore();
  // 单曲循环由 ExoPlayer 原生接管（REPEAT_MODE_ONE，永不 ENDED）、定时关闭“等本曲结束”
  // 须停在当前曲：两种语义下原生队列必须保持为空，否则 ENDED 会被队列自解续播越过
  if (status.repeatMode === "one" || autoClose.shouldStopAfterCurrentTrack()) {
    void window.api.player.clearNextResource?.().catch(() => {});
    return;
  }
  const songLevel = useSettingsStore().player.songLevel;
  // netease 用自身档位词表；kugou/qq 沿用原始 QualityLevel（引擎侧 kugou 按曲目裁剪）
  // ?? 兑跨版本遗留非法值兜底（JSON 序列化丢键会静默落到 optString 默认档）；
  // 兜底值必须是网易 level 词表内的值，"hq" 是项目档位词，服务端不认
  const level = NETEASE_LEVEL[songLevel] ?? "exhigh";
  // 引擎可解析的音源；遇到不支持的音源在此断开（其后的曲目已不可达，预解析窗口兜底）
  const firstUnsupported = candidates.findIndex(
    ({ track }) =>
      track.source !== "netease" && track.source !== "kugou" && track.source !== "qqmusic",
  );
  const items = candidates
    .slice(0, firstUnsupported < 0 ? QUEUE_SIZE : firstUnsupported)
    .map(({ track, index }) => ({
      platform: track.source as "netease" | "kugou" | "qqmusic",
      trackId: track.id,
      songId: track.id,
      playIndex: index,
      level: track.source === "netease" ? level : songLevel,
      quality: getQualityLevel(track.quality),
      extId: track.extId ?? "",
      albumId: (track.album?.id as string | undefined) ?? "",
      mediaId: track.mediaId ?? "",
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

  // 登录态经 cookie/会话种子透传给引擎（引擎存储与 WebView 隔离）。
  // netease 与 request.ts eapi 分支同源：补全设备指纹默认值，第二参传 "eapi" 参与 NMTID 缓存复用
  const cookies = processCookieObject(getNeteaseCookies(), "eapi");
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
  const settings = useSettingsStore();
  window.api.player
    .setNextQueue?.({
      items,
      resolve: {
        cookie: cookieObjToString(header),
        allowTrialPlay: settings.player.allowTrialPlay,
        // 引擎存储与 WebView 隔离：kugou 概念版/网易 realIP 等 store 键随队列下发
        configs: {
          "system.kugouLoginVersion": settings.system.system.kugouLoginVersion,
          // 直传布尔：String(false) 经引擎 store 的 JSON 往返后是 truthy，会把关闭 realIP 的用户错误注入
          "system.neteaseRealIp": settings.system.system.neteaseRealIp,
        },
        sessions: {
          kugou: getSessionCookies("kugou"),
          qqmusic: getSessionCookies("qqmusic"),
        },
      },
    })
    .catch((err) => console.error("[nextQueue] setNextQueue failed:", err));
};
