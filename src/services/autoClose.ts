/**
 * 定时关闭服务
 *
 * 用户设定 N 分钟后停止播放。两种模式：
 * - 立即停：到点直接 pause()
 * - 等本曲结束：到点把 waitSongEnd 标记置位，下次 ended 事件触发时再 pause()
 */

import { useStatusStore } from "@/stores/status";
import * as player from "@/core/player";

/** 倒计时 setInterval 句柄 */
let tickHandle: ReturnType<typeof setInterval> | null = null;
/** "等本曲结束"模式下，时间到了但还没 pause —— 等 ended 事件触发 */
let pendingPauseOnEnd = false;
/** 到点时原生单曲循环已被临时拆掉（否则永不 ENDED），停播后按此恢复 */
let repeatOneDisarmed = false;

const stopTick = (): void => {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
};

/** 倒计时 tick：每秒刷新 remainTime；归零后按模式触发 pause */
const tick = (): void => {
  const status = useStatusStore();
  const { autoClose } = status;
  if (!autoClose.enable) {
    stopTick();
    return;
  }
  const remainMs = autoClose.endTime - Date.now();
  autoClose.remainTime = Math.max(0, Math.ceil(remainMs / 1000));
  if (remainMs <= 0) {
    stopTick();
    if (autoClose.waitSongEnd) {
      // 等本曲播完再停；标记一下，由 onTrackEnded 钩子处理
      pendingPauseOnEnd = true;
      // 单曲循环由 ExoPlayer REPEAT_MODE_ONE 原生接管，永不触发 ENDED，
      // 到点须临时拆掉才能走到停播；停播后在 onTrackEnded/cancel 里恢复
      if (status.repeatMode === "one") {
        repeatOneDisarmed = true;
        void window.api.player.setRepeatMode?.({ mode: "none" }).catch(() => {});
      }
      // Android 原生自治链在 ENDED 时自解下一首并只发 autoAdvanced（不经过 JS ended），
      // 到点即拆掉原生队列/窗口，否则本曲终了后会被原生续播越过停播语义
      void window.api.player.clearNextResource?.().catch(() => {});
    } else {
      player.pause().catch(() => {});
      cancel();
    }
  }
};

/**
 * 启动定时关闭
 * @param durationMin 时长（分钟），>= 1
 * @param waitSongEnd true = 到点等本曲结束再停
 */
export const start = (durationMin: number, waitSongEnd: boolean): void => {
  const status = useStatusStore();
  const safe = Math.max(1, Math.round(durationMin));
  // 上一轮到点后遗留的原生循环拆除非终态，先恢复再开新一轮
  restoreRepeatMode();
  status.autoClose.enable = true;
  status.autoClose.duration = safe;
  status.autoClose.endTime = Date.now() + safe * 60 * 1000;
  status.autoClose.waitSongEnd = waitSongEnd;
  status.autoClose.remainTime = safe * 60;
  pendingPauseOnEnd = false;
  stopTick();
  tickHandle = setInterval(tick, 1000);
};

/** 取消定时关闭，重置状态 */
export const cancel = (): void => {
  const status = useStatusStore();
  restoreRepeatMode();
  status.autoClose.enable = false;
  status.autoClose.endTime = 0;
  status.autoClose.remainTime = 0;
  pendingPauseOnEnd = false;
  stopTick();
};

/**
 * 在 ended 事件钩子里调用：如果开启了"等本曲结束"且时间到了，
 * 此刻把播放停掉并清状态。
 *
 * 返回 true 表示已处理 pause（调用方应跳过自动跳下一首）。
 */
export const onTrackEnded = (): boolean => {
  if (!pendingPauseOnEnd) return false;
  pendingPauseOnEnd = false;
  player.pause().catch(() => {});
  cancel();
  return true;
};

/** 停播收尾后恢复被临时拆掉的原生单曲循环 */
const restoreRepeatMode = (): void => {
  if (!repeatOneDisarmed) return;
  repeatOneDisarmed = false;
  void window.api.player.setRepeatMode?.({ mode: useStatusStore().repeatMode }).catch(() => {});
};

/** 是否已到点且设置为“等本曲结束”停播（原生自治切歌前须排除） */
export const shouldStopAfterCurrentTrack = (): boolean => pendingPauseOnEnd;
