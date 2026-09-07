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
</script>

<template>
  <nav
    class="fixed inset-x-0 bottom-0 z-50 bg-surface-panel border-t border-t-solid border-t-primary/10 pb-[env(safe-area-inset-bottom)]"
  >
    <div class="flex items-stretch h-14">
      <button
        v-for="tab in BOTTOM_TAB_ENTRIES"
        :key="tab.key"
        type="button"
        class="flex-1 flex flex-col items-center justify-center gap-0.5 select-none active:bg-primary/8 transition-colors duration-200"
        :class="activeKey === tab.key ? 'text-primary' : 'text-on-surface-variant'"
        @click="onSelect(tab.key)"
      >
        <component :is="tab.icon" class="size-6" />
        <span class="text-xs leading-none">{{ t(tab.labelKey) }}</span>
      </button>
    </div>
  </nav>
</template>
