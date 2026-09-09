import { useSettingsStore } from "@/stores/settings";
import { useMediaStore } from "@/stores/media";
import { isAndroid } from "@/utils/platform";

/** 悬浮播放栏底部留白 */
const PLAYER_BAR_GAP = 112;

/**
 * 悬浮播放栏状态
 */
export const useFloatingPlayerBar = () => {
  const settings = useSettingsStore();
  const media = useMediaStore();

  /** 是否处于悬浮播放栏（Android 播放岛也走此分支——遮挡内容需要底部留白） */
  const isFloatingBar = computed(
    () => !!media.track && (isAndroid || settings.appearance.layoutMode === "floating"),
  );

  return { isFloatingBar, PLAYER_BAR_GAP };
};
