<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";
import { isAndroid } from "@/utils/platform";
import { useOrpheusProtocol } from "@/composables/useOrpheusProtocol";
import { useExternalFileHandler } from "@/composables/useExternalFileHandler";

const route = useRoute();
const status = useStatusStore();
const settings = useSettingsStore();

// 接入 orpheus 协议唤起与外部音频文件播放
useOrpheusProtocol();
useExternalFileHandler();

/** 有歌曲信息时显示播放栏 */
const showPlayerBar = computed(() => !!useMediaStore().track);
const { isPlayerExpanded } = storeToRefs(status);
const { appearance } = settings;

/** 路由切换动效 */
const routeTransitionName = computed(() => {
  const transition = appearance.routeTransition;
  return transition === "none" ? "" : `route-${transition}`;
});

/** 路由 key */
const routeKey = computed(() => {
  const hasParam = route.matched.some((m) => m.path.includes(":"));
  return hasParam ? route.path : (route.matched[1]?.path ?? route.path);
});

/** 需要受控缓存的页面组件白名单 */
const cachedViews = [
  "Home",
  "Library",
  "Liked",
  "History",
  "Download",
  "Daily",
  "Favorites",
  "Cloud",
  "LocalList",
  "Folders",
  "SearchPage",
  "Stats",
  "StreamingIndex",
];

const mainContainerRef = shallowRef<HTMLElement | null>(null);
const mainScrollMap = new Map<string, number>();

// 路由离开前记录滚动位置
watch(
  () => route.fullPath,
  (_newPath, oldPath) => {
    // Android 抽屉：路由切换后自动收起
    if (isAndroid) status.sidebarDrawerOpen = false;
    if (oldPath && mainContainerRef.value) {
      // 无界增长：含 query 的 fullPath 长期切换会吃掉内存，按 KeepAlive 上限量级截尾
      if (mainScrollMap.size >= 30) {
        const oldest = mainScrollMap.keys().next();
        if (!oldest.done) mainScrollMap.delete(oldest.value);
      }
      mainScrollMap.set(oldPath, mainContainerRef.value.scrollTop);
    }
  },
);

// 路由切换完成后恢复滚动位置
const handleAfterEnter = (): void => {
  if (!mainContainerRef.value) return;
  const saved = mainScrollMap.get(route.fullPath) ?? 0;
  mainContainerRef.value.scrollTop = saved;
};

/** 侧边栏样式 */
const sidebarClass = computed(() => {
  const classes: string[] = [];
  if (appearance.layoutMode === "floating") {
    classes.push("ml-3 mt-3 mb-3 rounded-xl border border-solid border-primary/10");
  } else {
    classes.push("border-r border-r-solid border-r-primary/10");
    if (showPlayerBar.value && appearance.layoutMode === "default") classes.push("mb-20");
  }
  return classes.join(" ");
});

/** 主界面底部边距（桌面端为播放栏预留；Android 内容延伸到悬浮岛下方，不预留） */
const mainMarginClass = computed(() => {
  if (!showPlayerBar.value || appearance.layoutMode === "floating") return "";
  return "mb-20";
});

/** 顶栏样式：Android 下避开状态栏安全区 */
const headerClass = computed(() =>
  isAndroid
    ? "h-[calc(4rem+env(safe-area-inset-top))] shrink-0 flex items-center px-3 pt-[env(safe-area-inset-top)]"
    : "h-16 shrink-0 flex items-center px-3",
);

/** 侧边栏样式：Android 下为覆盖式抽屉，桌面端为固定侧栏 */
const asideClass = computed(() => {
  if (isAndroid) {
    return [
      // 需盖过常驻 Tab 栏（z-50），又不能压过全屏播放器（z-200）与对话框（z-300）
      "fixed inset-y-0 left-0 z-[60] w-72 max-w-[85vw] bg-surface-panel overflow-y-auto pt-[env(safe-area-inset-top)]",
      "shadow-2xl transition-transform duration-300",
      status.sidebarDrawerOpen ? "translate-x-0" : "-translate-x-full",
    ].join(" ");
  }
  return [
    "shrink-0 bg-surface-panel overflow-y-auto z-10 transition-[width,margin] duration-300",
    appearance.sidebarCollapsed ? "w-16" : "w-60",
    sidebarClass.value,
  ].join(" ");
});

/** 外层播放条样式 */
const playerBarWrapperClass = computed(() => {
  const base = "fixed z-50 transition-[left] duration-300 pointer-events-none";
  // Android：播放栏为悬浮岛样式，底边让位给常驻 Tab 栏并留 8px 间隙
  if (isAndroid) {
    return `${base} bottom-[calc(3.625rem+env(safe-area-inset-bottom))] left-2.5 right-2.5`;
  }
  const collapsed = appearance.sidebarCollapsed;
  switch (appearance.layoutMode) {
    case "sidebar-full":
      return `${base} bottom-0 ${collapsed ? "left-16" : "left-60"} right-0`;
    case "floating":
      return `${base} bottom-0 ${collapsed ? "left-[76px]" : "left-[252px]"} right-0 px-4 pb-6`;
    default:
      return `${base} bottom-0 left-0 right-0`;
  }
});

/** 内层播放条样式 */
const playerBarInnerClass = computed(() => {
  // 禁用底部播放栏交互
  const base = isPlayerExpanded.value ? "pointer-events-none" : "pointer-events-auto";
  switch (appearance.layoutMode) {
    case "floating":
      return `${base} mx-auto max-w-4xl glass-panel rounded-full shadow-xl border border-solid border-primary/10`;
    default:
      // 底部安全区由 Android 的 Tab 栏承担，播放栏不再重复避让；Android 为悬浮岛圆角样式
      return `${base} ${
        isAndroid
          ? "h-16 bg-surface-panel rounded-[18px] shadow-[0_6px_20px_rgba(0,0,0,0.18),0_1px_3px_rgba(0,0,0,0.08)]"
          : "h-20 bg-surface-panel border-t border-t-solid border-t-primary/10"
      }`;
  }
});
</script>

<template>
  <!-- 主界面 -->
  <div
    class="h-screen flex overflow-hidden bg-app text-on-surface transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.7,0,0.3,1)] origin-center"
    :class="isPlayerExpanded ? 'scale-95 opacity-0 pointer-events-none' : ''"
  >
    <!-- 侧边栏 -->
    <aside :class="asideClass">
      <SideBar />
    </aside>
    <!-- Android 侧边抽屉遮罩 -->
    <div
      v-if="isAndroid && status.sidebarDrawerOpen"
      class="fixed inset-0 z-[55] bg-black/50"
      @click="status.sidebarDrawerOpen = false"
    />

    <!-- 右侧主区域 -->
    <div class="flex-1 flex flex-col min-w-0" :class="mainMarginClass">
      <!-- 顶部导航 -->
      <header :class="headerClass">
        <NavHeader />
      </header>

      <!-- 主内容区 -->
      <main ref="mainContainerRef" class="flex-1 overflow-y-auto overflow-x-hidden">
        <RouterView v-slot="{ Component }">
          <Transition :name="routeTransitionName" mode="out-in" @after-enter="handleAfterEnter">
            <KeepAlive :max="10" :include="cachedViews">
              <component :is="Component" :key="routeKey" />
            </KeepAlive>
          </Transition>
        </RouterView>
      </main>
    </div>
  </div>

  <!-- 底部播放栏 -->
  <Transition
    enter-active-class="transition-transform duration-300 ease-out"
    leave-active-class="transition-transform duration-300 ease-in"
    enter-from-class="translate-y-full"
    leave-to-class="translate-y-full"
  >
    <div v-if="showPlayerBar" :class="playerBarWrapperClass">
      <footer :class="playerBarInnerClass">
        <PlayerBar />
      </footer>
    </div>
  </Transition>

  <!-- Android 底部 Tab 栏 -->
  <BottomTabBar v-if="isAndroid" />

  <!-- Toast -->
  <SToast :max="1" />
  <!-- 性能监视器 -->
  <SPerformanceMonitor v-if="appearance.showPerformanceMonitor" />
  <!-- Dialog -->
  <SDialogProvider />
  <!-- 全屏播放器 -->
  <FullPlayer />
  <!-- 全局设置 -->
  <SettingsDialog />
  <!-- 更新弹窗 -->
  <UpdateDialog />
  <!-- 评论弹窗 -->
  <MusicCommentsDialog />
</template>
