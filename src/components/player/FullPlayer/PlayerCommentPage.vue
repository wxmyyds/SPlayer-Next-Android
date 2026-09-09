<script setup lang="ts">
/**
 * 评论页（全屏播放器左滑第 3 页，UI 对照 SFA PlayerComment/CommentList）
 * 热门评论 + 全部评论两段式，加载更多追加；数据走 window.api.comments。
 */
import type { CommentSource, MusicCommentItem, MusicCommentPage } from "@shared/types/comment";
import { useStatusStore } from "@/stores/status";
import { formatDate } from "@/utils/time";

const props = defineProps<{
  /** 页面是否处于激活态（非激活不发起请求） */
  active?: boolean;
}>();

const emit = defineEmits<{ (e: "back"): void }>();

const status = useStatusStore();
const { t } = useI18n();

/** 播放器当前曲目（与全屏播放器一致） */
const track = computed(() => status.currentTrack);

const sources = shallowRef<CommentSource[]>([]);
const sourceId = ref("");
const hotList = ref<MusicCommentItem[]>([]);
const newList = ref<MusicCommentItem[]>([]);
const total = ref(0);
const nextCursor = ref<string | undefined>(undefined);
const page = ref(1);
const hasMore = ref(false);
const loadingHot = ref(false);
const loadingNew = ref(false);
const loadedFor = ref("");
const listRef = ref<HTMLElement | null>(null);

const loading = computed(() => loadingHot.value || loadingNew.value);

/** 评论源与曲目平台匹配，无匹配用第一个源 */
const resolveSourceId = (items: CommentSource[], source: string): string =>
  items.find((item) => item.platform === source)?.id ?? items[0]?.id ?? "";

const reset = (): void => {
  hotList.value = [];
  newList.value = [];
  total.value = 0;
  nextCursor.value = undefined;
  page.value = 1;
  hasMore.value = false;
};

const load = async (): Promise<void> => {
  const current = track.value;
  if (!current || !sourceId.value || !props.active) return;
  const key = `${current.source}:${current.id}`;
  if (loadedFor.value === key) return;
  loadedFor.value = key;
  reset();
  loadingHot.value = true;
  try {
    if (!sources.value.length) sources.value = await window.api.comments.sources();
    sourceId.value = resolveSourceId(sources.value, current.source);
    if (!sourceId.value) return;
    const hot = await window.api.comments.get({
      sourceId: sourceId.value,
      track: toRaw(current),
      type: "hot",
      page: 1,
      limit: 20,
    });
    if (hot.ok) hotList.value = hot.data.list;
    const fresh = await window.api.comments.get({
      sourceId: sourceId.value,
      track: toRaw(current),
      type: "new",
      page: 1,
      limit: 20,
    });
    if (fresh.ok) {
      const data: MusicCommentPage = fresh.data;
      newList.value = data.list;
      total.value = data.total;
      nextCursor.value = data.nextCursor;
      page.value = 1;
      hasMore.value = data.list.length > 0 && !!data.nextCursor;
    }
  } catch {
    // 失败保持空态
  } finally {
    loadingHot.value = false;
    loadingNew.value = false;
  }
};

const loadMore = async (): Promise<void> => {
  const current = track.value;
  if (!current || !sourceId.value || !hasMore.value || loadingNew.value) return;
  loadingNew.value = true;
  try {
    const next = await window.api.comments.get({
      sourceId: sourceId.value,
      track: toRaw(current),
      type: "new",
      page: page.value + 1,
      limit: 20,
      cursor: nextCursor.value,
    });
    if (next.ok) {
      newList.value = [...newList.value, ...next.data.list];
      nextCursor.value = next.data.nextCursor;
      page.value += 1;
      hasMore.value = next.data.list.length > 0 && !!next.data.nextCursor;
    }
  } catch {
    // 静默
  } finally {
    loadingNew.value = false;
  }
};

watch(
  () => [props.active, track.value?.id, track.value?.source],
  () => {
    if (props.active) void load();
  },
  { immediate: true },
);

const goBack = (): void => {
  emit("back");
};
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 歌曲信息头（对照 SFA song-data） -->
    <div class="flex shrink-0 items-center gap-3 px-5 pt-1 pb-3">
      <img
        v-if="track?.cover"
        :src="track.cover"
        :alt="track.title"
        decoding="async"
        class="h-11 w-11 rounded-lg object-cover"
      />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-cover">{{ track?.title }}</div>
        <div class="truncate text-xs text-cover/50">
          {{ track?.artists?.map((artist) => artist.name).join(" / ") }}
        </div>
      </div>
      <button
        class="shrink-0 rounded-full p-2 text-cover/70 transition-colors active:bg-cover/10"
        :aria-label="t('common.back')"
        @click.stop="goBack"
      >
        <IconLucideChevronRight class="size-5" />
      </button>
    </div>

    <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto px-5 pb-24">
      <!-- 热门评论 -->
      <template v-if="hotList.length > 0">
        <div class="flex items-center gap-1.5 pb-2 text-sm font-semibold text-cover">
          <IconLucideFlame class="size-4 text-orange-400" />
          <span>{{ t("comments.hot") }}</span>
        </div>
        <div
          v-for="item in hotList"
          :key="`hot-${item.id}`"
          class="flex flex-col gap-1 border-b border-solid border-cover/5 py-3"
        >
          <div class="text-sm leading-snug text-cover">
            <span class="font-medium">{{ item.userName }}：</span>
            <span class="text-cover/90">{{ item.text }}</span>
          </div>
          <div v-for="reply in item.reply ?? []" :key="`hot-r-${reply.id}`" class="text-xs text-cover/60">
            @ {{ reply.userName }}：{{ reply.text }}
          </div>
          <div class="flex items-center gap-3 text-xs text-cover/40">
            <span v-if="item.time">{{ formatDate(item.time) }}</span>
            <span v-if="item.location">{{ item.location }}</span>
            <span v-if="item.likedCount != null" class="ml-auto flex items-center gap-1">
              <IconLucideThumbsUp class="size-3.5" />
              {{ item.likedCount }}
            </span>
          </div>
        </div>
      </template>

      <!-- 全部评论 -->
      <div class="flex items-center gap-1.5 pt-4 pb-2 text-sm font-semibold text-cover">
        <IconLucideMessageCircle class="size-4" />
        <span>{{ t("comments.new") }}</span>
        <span v-if="total > 0" class="text-xs font-normal text-cover/40">{{ total }}</span>
      </div>
      <div
        v-for="item in newList"
        :key="item.id"
        class="flex flex-col gap-1 border-b border-solid border-cover/5 py-3"
      >
        <div class="text-sm leading-snug text-cover">
          <span class="font-medium">{{ item.userName }}：</span>
          <span class="text-cover/90">{{ item.text }}</span>
        </div>
        <div v-for="reply in item.reply ?? []" :key="`r-${reply.id}`" class="text-xs text-cover/60">
          @ {{ reply.userName }}：{{ reply.text }}
        </div>
        <div v-if="item.images?.length" class="flex flex-wrap gap-2">
          <img
            v-for="(image, index) in item.images"
            :key="index"
            :src="image"
            decoding="async"
            loading="lazy"
            class="max-h-28 rounded-lg object-cover"
          />
        </div>
        <div class="flex items-center gap-3 text-xs text-cover/40">
          <span v-if="item.time">{{ formatDate(item.time) }}</span>
          <span v-if="item.location">{{ item.location }}</span>
          <span v-if="item.likedCount != null" class="ml-auto flex items-center gap-1">
            <IconLucideThumbsUp class="size-3.5" />
            {{ item.likedCount }}
          </span>
        </div>
      </div>

      <!-- 加载更多 -->
      <div v-if="hasMore" class="flex justify-center py-4">
        <button
          class="rounded-full border border-solid border-cover/20 px-5 py-1.5 text-xs text-cover/70 transition-colors active:bg-cover/10"
          :disabled="loadingNew"
          @click.stop="loadMore"
        >
          {{ loadingNew ? "..." : t("common.loadMore") }}
        </button>
      </div>

      <!-- 空态 -->
      <div
        v-if="!loading && !loadingHot && newList.length === 0 && hotList.length === 0 && loadedFor"
        class="py-16 text-center text-sm text-cover/40"
      >
        {{ t("comments.empty") }}
      </div>
    </div>
  </div>
</template>
