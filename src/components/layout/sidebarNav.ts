import type { Component } from "vue";
import IconLucideHome from "~icons/lucide/home";
import IconLucideMusic from "~icons/lucide/music";
import IconLucideUser from "~icons/lucide/user";
import IconLucideDisc3 from "~icons/lucide/disc-3";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideChartPie from "~icons/lucide/chart-pie";
import IconLucideLibrary from "~icons/lucide/library";
import IconMaterialSymbolsFavoriteOutline from "~icons/material-symbols/favorite-outline-rounded";
import IconLucideStar from "~icons/lucide/star";
import IconLucideHistory from "~icons/lucide/history";
import IconLucideDownload from "~icons/lucide/download";
import IconLucideCloud from "~icons/lucide/cloud";
import IconMaterialSymbolsHome from "~icons/material-symbols/home-rounded";
import IconMaterialSymbolsPieChart from "~icons/material-symbols/pie-chart-rounded";
import IconMaterialSymbolsHistory from "~icons/material-symbols/history-rounded";
import IconMaterialSymbolsStar from "~icons/material-symbols/star-rounded";

/** 侧边栏固定导航项元数据 */
export interface SidebarNavEntry {
  /** 路由路径，同时作为菜单 key */
  key: string;
  /** i18n key */
  labelKey: string;
  icon: Component;
  /** 是否允许隐藏 */
  hideable: boolean;
}

const SIDEBAR_NAV_ENTRIES: SidebarNavEntry[] = [
  { key: "/", labelKey: "nav.home", icon: IconLucideHome, hideable: false },
  { key: "/library", labelKey: "nav.library", icon: IconLucideMusic, hideable: true },
  { key: "/artists/local", labelKey: "artist.label", icon: IconLucideUser, hideable: true },
  { key: "/albums/local", labelKey: "album.label", icon: IconLucideDisc3, hideable: true },
  { key: "/folders", labelKey: "folder.label", icon: IconLucideFolder, hideable: true },
  { key: "/stats", labelKey: "stats.label", icon: IconLucideChartPie, hideable: true },
  {
    key: "/liked",
    labelKey: "nav.liked",
    icon: IconMaterialSymbolsFavoriteOutline,
    hideable: true,
  },
  { key: "/favorites", labelKey: "nav.favorites", icon: IconLucideStar, hideable: true },
  { key: "/cloud", labelKey: "nav.cloud", icon: IconLucideCloud, hideable: true },
  { key: "/download", labelKey: "nav.download", icon: IconLucideDownload, hideable: true },
  { key: "/streaming", labelKey: "nav.streaming", icon: IconLucideLibrary, hideable: true },
  { key: "/history", labelKey: "nav.history", icon: IconLucideHistory, hideable: true },
];

/** key → 导航项元数据 */
export const SIDEBAR_NAV_META: Record<string, SidebarNavEntry> = Object.fromEntries(
  SIDEBAR_NAV_ENTRIES.map((entry) => [entry.key, entry]),
);

/** Android 底部 Tab 栏项：由侧边栏迁入，填充式图标对齐参考设计，标签用 tab 专属短文案 */
export const BOTTOM_TAB_ENTRIES: SidebarNavEntry[] = [
  { key: "/", labelKey: "nav.home", icon: IconMaterialSymbolsHome, hideable: false },
  { key: "/stats", labelKey: "nav.stats", icon: IconMaterialSymbolsPieChart, hideable: false },
  {
    key: "/history",
    labelKey: "nav.tabHistory",
    icon: IconMaterialSymbolsHistory,
    hideable: false,
  },
  {
    key: "/favorites",
    labelKey: "nav.tabFavorites",
    icon: IconMaterialSymbolsStar,
    hideable: false,
  },
];

/** 底部 Tab 项 key 集合（Android 抽屉据此过滤） */
export const BOTTOM_TAB_KEYS = new Set(BOTTOM_TAB_ENTRIES.map((entry) => entry.key));

/**
 * 按存档顺序重排列表：存档中不存在的项排在最前
 * 其余项按存档顺序跟随；空存档返回原列表
 * @param items - 自然顺序列表
 * @param order - 存档的 key 顺序
 * @returns 重排后的列表
 */
export const applySavedOrder = <T extends { key: string }>(items: T[], order: string[]): T[] => {
  if (order.length === 0) return items;
  const map = new Map(items.map((item) => [item.key, item]));
  const ordered: T[] = [];
  for (const key of order) {
    const item = map.get(key);
    if (!item) continue;
    ordered.push(item);
    map.delete(key);
  }
  return [...map.values(), ...ordered];
};
