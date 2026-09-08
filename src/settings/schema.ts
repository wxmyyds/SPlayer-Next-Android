import type { SettingCategory, SettingItem } from "@/types/settings-schema";
import { isAndroid } from "@/utils/platform";
import generalCategory from "./categories/general";
import appearanceCategory from "./categories/appearance";
import playerCategory from "./categories/player";
import lyricCategory from "./categories/lyric";
import hotkeysCategory from "./categories/hotkeys";
import servicesCategory from "./categories/services";
import aiIntegrationCategory from "./categories/aiIntegration";
import mediaSourceCategory from "./categories/streaming";
import downloadCategory from "./categories/download";
import localCacheCategory from "./categories/localCache";
import pluginsCategory from "./categories/plugins";
import otherCategory from "./categories/other";
import AboutSettings from "@/components/settings/custom/AboutSettings.vue";
import IconLucideInfo from "~icons/lucide/info";

/** Android 上整类未实现的分类：桥接未接，整页空转开关会误导用户 */
const ANDROID_HIDDEN_CATEGORIES = new Set([
  "hotkeys",
  "aiIntegration",
  "mediaSource",
  "download",
  "localCache",
]);

/**
 * Android 上无效的设置项：桌面 main 消费或桥接 no-op，连同 children 一并隐藏。
 * 补齐对应能力后从清单移除即可。
 */
const ANDROID_HIDDEN_ITEMS = new Set([
  // 播放：响度归一/输出设备待原生引擎（autoPlay/rememberLastTrack 由 restoreLastTrack 消费，可用）
  "loudnessNormalization",
  "outputDevice",
  // 外观：背景图依赖桌面文件选择；布局与侧栏折叠仅作用于桌面分支
  "backgroundImage",
  "layoutMode",
  "sidebarCollapsed",
  // 常规：协议唤起与自更新为桌面能力
  "orpheusProtocol",
  "updateChannel",
  "autoCheckUpdate",
  "checkUpdate",
  // 歌词：TTML 本地/在线覆盖未接
  "enableLocalTTMLOverride",
  // 服务：代理/Discord/Last.fm/外部 API 未实现
  "networkProxyProtocol",
  "systemMediaControls",
  "discordEnabled",
  "lastfmEnabled",
  "externalApiStatusCard",
  "externalApiEnabled",
]);

const filterAndroidItems = (items: SettingItem[]): SettingItem[] =>
  items
    .filter((item) => !ANDROID_HIDDEN_ITEMS.has(item.key))
    .map((item) =>
      item.children ? { ...item, children: filterAndroidItems(item.children) } : item,
    )
    .filter((item) => !item.children || item.children.length > 0);

const applyAndroidSchema = (categories: SettingCategory[]): SettingCategory[] =>
  isAndroid
    ? categories
        .filter((category) => !ANDROID_HIDDEN_CATEGORIES.has(category.id))
        .map((category) => ({
          ...category,
          sections: (category.sections ?? [])
            .map((section) => ({ ...section, items: filterAndroidItems(section.items) }))
            .filter((section) => section.items.length > 0),
        }))
        .filter(
          (category) => category.component !== undefined || (category.sections?.length ?? 0) > 0,
        )
    : categories;

export const settingsSchema: SettingCategory[] = applyAndroidSchema([
  generalCategory,
  appearanceCategory,
  playerCategory,
  lyricCategory,
  hotkeysCategory,
  servicesCategory,
  aiIntegrationCategory,
  mediaSourceCategory,
  downloadCategory,
  localCacheCategory,
  pluginsCategory,
  otherCategory,
  { id: "about", icon: IconLucideInfo, component: AboutSettings },
]);
