<script setup lang="ts">
import { BOTTOM_TAB_ENTRIES } from "@/components/layout/sidebarNav";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

/** 当前激活项（含子路由归属） */
const activeKey = computed(() => {
  const match = BOTTOM_TAB_ENTRIES.find(
    (tab) => route.path === tab.key || route.path.startsWith(tab.key + "/"),
  );
  return match?.key ?? "";
});

/** 切换 tab */
const onSelect = (key: string): void => {
  if (route.path !== key) router.push(key);
};

/** 底栏滑动指示器：跟随激活项平滑到位（对齐 splayer-for-android 底栏设计） */
const itemRefs = ref<HTMLElement[]>([]);
const indicatorStyle = ref<Record<string, string>>({ opacity: "0" });

const setItemRef = (el: unknown, idx: number): void => {
  if (el instanceof HTMLElement) itemRefs.value[idx] = el;
};

const updateIndicator = (): void => {
  const idx = BOTTOM_TAB_ENTRIES.findIndex((tab) => tab.key === activeKey.value);
  const el = itemRefs.value[idx];
  if (!el) return;
  indicatorStyle.value = {
    transform: `translate3d(${el.offsetLeft}px, ${el.offsetTop}px, 0)`,
    width: `${el.offsetWidth}px`,
    height: `${el.offsetHeight}px`,
    opacity: "1",
  };
};

watch(activeKey, () => nextTick(updateIndicator));
onMounted(() => nextTick(updateIndicator));
useEventListener(window, "resize", updateIndicator);
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-50 grid grid-cols-4 gap-1 px-2 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] bg-surface-panel shadow-[0_-1px_8px_rgba(0,0,0,0.06)]"
  >
    <div
      class="absolute top-0 left-0 z-0 rounded-[10px] bg-primary/12 pointer-events-none will-change-transform transition-[transform,width,height,opacity] duration-300"
      :style="indicatorStyle"
    />
    <button
      v-for="(tab, idx) in BOTTOM_TAB_ENTRIES"
      :key="tab.key"
      :ref="(el) => setItemRef(el, idx)"
      type="button"
      class="relative z-10 flex flex-col items-center justify-center gap-0.5 min-h-[38px] rounded-[10px] bg-transparent transition-[color,transform] duration-300 active:scale-95"
      :class="activeKey === tab.key ? 'text-primary' : 'text-on-surface-variant'"
      @click="onSelect(tab.key)"
    >
      <component :is="tab.icon" class="size-[17px] max-[360px]:size-4" />
      <span class="text-[10px] leading-none break-keep max-[360px]:text-[9px]">
        {{ t(tab.labelKey) }}
      </span>
    </button>
  </nav>
</template>
