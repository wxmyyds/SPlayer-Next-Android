import { isAndroid } from "@/utils/platform";
import { useStatusStore } from "@/stores/status";
import { useSettingsDialog } from "@/settings/useSettingsDialog";
import router from "@/router";

/** 返回键浮层栈（LIFO）：SDialog 等通用弹窗打开时注册关闭函数，返回键优先弹栈顶 */
const overlayStack: Array<() => void> = [];

/**
 * 注册浮层（打开时调用）
 * @param close 关闭该浮层的函数
 */
export const registerBackOverlay = (close: () => void): void => {
  overlayStack.push(close);
};

/**
 * 注销浮层（关闭/卸载时调用）
 * @param close 注册时传入的同一函数引用
 */
export const unregisterBackOverlay = (close: () => void): void => {
  const index = overlayStack.lastIndexOf(close);
  if (index >= 0) overlayStack.splice(index, 1);
};

/** 弹出并关闭栈顶浮层 @returns 是否有浮层被关闭 */
const popBackOverlay = (): boolean => {
  const close = overlayStack.pop();
  if (!close) return false;
  close();
  return true;
};

/**
 * 安装 Android 返回键处理：覆盖层依次关闭 → 路由回退 → 最小化应用。
 * Capacitor 默认行为是无监听时 WebView 无历史即 finish Activity（直接回桌面），
 * 这里接管为标准 Android 返回语义。
 */
export const installAndroidBackButton = async (): Promise<void> => {
  if (!isAndroid) return;
  const { App } = await import("@capacitor/app");
  await App.addListener("backButton", ({ canGoBack }) => {
    const status = useStatusStore();
    const settingsDialog = useSettingsDialog();
    // 通用弹窗（SDialog 基座，z 层高于播放器/队列）最优先关闭
    if (popBackOverlay()) return;
    // 播放器内队列面板、评论页均属播放器内层，先于播放器本体关闭
    if (status.fullQueueOpen) {
      status.fullQueueOpen = false;
      return;
    }
    if (status.commentsOpen) {
      status.commentsOpen = false;
      return;
    }
    if (status.isPlayerExpanded) {
      status.isPlayerExpanded = false;
      return;
    }
    if (status.searchOpen) {
      status.searchOpen = false;
      return;
    }
    if (settingsDialog.open.value) {
      settingsDialog.hide();
      return;
    }
    if (status.sidebarDrawerOpen) {
      status.sidebarDrawerOpen = false;
      return;
    }
    if (status.outerQueueOpen) {
      status.outerQueueOpen = false;
      return;
    }
    if (canGoBack) {
      router.back();
      return;
    }
    // 已在首页：最小化而非退出（保留后台播放）
    void App.minimizeApp();
  });
};
