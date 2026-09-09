import { isAndroid } from "@/utils/platform";
import { useStatusStore } from "@/stores/status";
import { useSettingsDialog } from "@/settings/useSettingsDialog";
import router from "@/router";

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
    // 播放器内队列面板先于播放器本体关闭
    if (status.fullQueueOpen) {
      status.fullQueueOpen = false;
      return;
    }
    if (status.isPlayerExpanded) {
      status.isPlayerExpanded = false;
      return;
    }
    if (status.commentsOpen) {
      status.commentsOpen = false;
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
