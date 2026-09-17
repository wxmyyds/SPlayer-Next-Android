/**
 * FFT 频谱推送的引用计数
 *
 * 频谱可视化与流体背景都依赖后端 FFT 推送，但 player:setFftEnabled 是单一布尔开关。
 * 用引用计数协调多个消费者：首个申请时开启推送，最后一个释放时才关闭，
 * 避免一个组件卸载时误关掉另一个仍在使用的推送。
 */

import { isAndroid } from "@/utils/platform";

/** 当前持有 FFT 推送的消费者数量 */
let refCount = 0;

/** 页面隐藏时关闭推送：WebView 冻结时原生仍在主线程构建 128 元素 JSON 推送并排队，
 * 解锁后风暴回放；恢复可见时重开（原生侧 isPlaying 才真正初始化 Visualizer） */
const onVisibilityChange = (): void => {
  if (refCount === 0) return;
  void window.api.player.setFftEnabled(document.visibilityState !== "hidden").catch(() => {});
};

/** 申请 FFT 推送；首个消费者负责开启后端推送 */
export const acquireFft = (): void => {
  refCount++;
  if (refCount === 1) {
    window.api.player.setFftEnabled(true);
    if (isAndroid) document.addEventListener("visibilitychange", onVisibilityChange);
  }
};

/** 释放 FFT 推送；最后一个消费者关闭后端推送 */
export const releaseFft = (): void => {
  if (refCount === 0) return;
  refCount--;
  if (refCount === 0) {
    window.api.player.setFftEnabled(false);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
};
