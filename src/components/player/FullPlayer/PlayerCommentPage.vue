<script setup lang="ts">
/**
 * 评论页（全屏播放器封面右滑，UI 对照 SFA PlayerComment/CommentList 移动端）
 * 热门评论 + 全部评论两段式卡片流，加载更多追加；数据走 window.api.comments。
 */
import type { CommentSource, MusicCommentItem, MusicCommentPage } from "@shared/types/comment";
import { useStatusStore } from "@/stores/status";
import { formatDate } from "@/utils/time";

const props = defineProps<{
  /** 页面是否处于激活态（非激活不发起请求） */
  active?: boolean;
}>();

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

const loading = computed(() => loadingHot.value || loadingNew.value);
/** 请求代令牌：切歌后旧响应作废，不允许覆盖新列表 */
let loadGeneration = 0;

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
  if (!current || !props.active) return;
  const key = `${current.source}:${current.id}`;
  if (loadedFor.value === key) return;
  loadedFor.value = key;
  const gen = ++loadGeneration;
  reset();
  loadingHot.value = true;
  try {
    if (!sources.value.length) sources.value = await window.api.comments.sources();
    sourceId.value = resolveSourceId(sources.value, current.source);
    if (!sourceId.value) {
      // 失败不留.loadedFor标记：恢复后同一首歌可重试
      loadedFor.value = "";
      return;
    }
    const hot = await window.api.comments.get({
      sourceId: sourceId.value,
      track: toRaw(current),
      type: "hot",
      page: 1,
      limit: 20,
    });
    if (gen !== loadGeneration) return;
    if (hot.ok) hotList.value = hot.data.list;
    const fresh = await window.api.comments.get({
      sourceId: sourceId.value,
      track: toRaw(current),
      type: "new",
      page: 1,
      limit: 20,
    });
    if (gen !== loadGeneration) return;
    if (fresh.ok) {
      const data: MusicCommentPage = fresh.data;
      newList.value = data.list;
      total.value = data.total;
      nextCursor.value = data.nextCursor;
      page.value = 1;
      hasMore.value = data.list.length > 0 && !!data.nextCursor;
    }
  } catch {
    // 失败保持空态并清除标记，下次激活可重试
    if (gen === loadGeneration) loadedFor.value = "";
  } finally {
    if (gen === loadGeneration) {
      loadingHot.value = false;
      loadingNew.value = false;
    }
  }
};

const loadMore = async (): Promise<void> => {
  const current = track.value;
  if (!current || !sourceId.value || !hasMore.value || loadingNew.value) return;
  const gen = loadGeneration;
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
    if (gen !== loadGeneration) return;
    if (next.ok) {
      newList.value = [...newList.value, ...next.data.list];
      nextCursor.value = next.data.nextCursor;
      page.value += 1;
      hasMore.value = next.data.list.length > 0 && !!next.data.nextCursor;
    }
  } catch {
    // 静默
  } finally {
    if (gen === loadGeneration) loadingNew.value = false;
  }
};

watch(
  () => [props.active, track.value?.id, track.value?.source],
  () => {
    if (props.active) void load();
  },
  { immediate: true },
);

/** 空态可见：加载完成且两段都为空 */
const showEmpty = computed(
  () => !loading.value && loadedFor.value && !hotList.value.length && !newList.value.length,
);
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 歌曲信息卡（对照 SFA 移动端 song-data：80px 卡片，圆角封面 + 标题/歌手） -->
    <div
      v-if="track"
      class="mx-4 mb-3 flex h-20 shrink-0 items-center gap-3 rounded-xl bg-cover/[0.08] px-3.5"
    >
      <img
        v-if="track.cover"
        :src="track.cover"
        :alt="track.title"
        decoding="async"
        class="size-14 shrink-0 rounded-[10px] object-cover"
      />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-[17px] leading-snug font-bold text-cover">
          {{ track.title }}
        </span>
        <span class="truncate text-xs text-cover/80">
          {{ track.artists?.map((artist) => artist.name).join(" / ") }}
        </span>
      </div>
    </div>

    <!-- 评论滚动区（上下渐隐遮罩，对照 SFA comment-scroll） -->
    <div
      class="min-h-0 flex-1 overflow-y-auto px-4 pb-6 [mask-image:linear-gradient(180deg,transparent,rgba(0,0,0,0.6)_2%,#000_5%,#000_90%,rgba(0,0,0,0.6)_95%,transparent)]"
    >
      <!-- 热门评论 -->
      <template v-if="hotList.length > 0">
        <div class="flex h-14 items-end pb-2.5">
          <div class="flex items-center gap-1 text-lg font-bold text-cover">
            <IconLucideFlame class="size-5" />
            <span>{{ t("comments.hot") }}</span>
          </div>
        </div>
        <div class="mb-5 flex flex-col gap-5">
          <div
            v-for="item in hotList"
            :key="`hot-${item.id}`"
            class="flex min-h-32 flex-col rounded-xl bg-cover/[0.08] p-4"
          >
            <div class="text-base leading-snug text-cover">
              <span class="font-bold">{{ item.userName }}：</span>
              <span class="whitespace-pre-wrap">{{ item.text }}</span>
            </div>
            <div
              v-for="reply in item.reply ?? []"
              :key="`hot-r-${reply.id}`"
              class="mt-1.5 rounded-lg bg-cover/[0.12] px-2 py-1 text-[13px] leading-snug text-cover"
            >
              <span class="font-bold text-cover/70">@ {{ reply.userName }}：</span>
              <span class="whitespace-pre-wrap">{{ reply.text }}</span>
            </div>
            <div class="mt-auto flex items-center gap-3 pt-3 text-xs text-cover/60">
              <span v-if="item.time" class="flex items-center gap-1">
                <IconLucideClock class="size-4" />
                {{ formatDate(item.time) }}
              </span>
              <span v-if="item.location" class="flex items-center gap-1">
                <IconLucideMapPin class="size-4" />
                {{ item.location }}
              </span>
              <span v-if="item.likedCount != null" class="ml-auto flex items-center gap-1">
                <IconLucideThumbsUp class="size-4" />
                {{ item.likedCount }}
              </span>
            </div>
          </div>
        </div>
      </template>

      <!-- 全部评论 -->
      <div class="flex h-14 items-end pb-2.5">
        <div class="flex items-center gap-1 text-lg font-bold text-cover">
          <IconLucideMessageCircle class="size-5" />
          <span>{{ t("comments.new") }}</span>
          <span v-if="total > 0" class="ml-1 text-sm font-normal text-cover/60">{{ total }}</span>
        </div>
      </div>

      <!-- 骨架屏（首载） -->
      <div v-if="loading && !newList.length" class="flex flex-col gap-5">
        <div
          v-for="index in 4"
          :key="`sk-${index}`"
          class="h-32 animate-pulse rounded-xl bg-cover/[0.08]"
        />
      </div>

      <div v-else class="flex flex-col gap-5">
        <div
          v-for="item in newList"
          :key="item.id"
          class="flex min-h-32 flex-col rounded-xl bg-cover/[0.08] p-4"
        >
          <div class="text-base leading-snug text-cover">
            <span class="font-bold">{{ item.userName }}：</span>
            <span class="whitespace-pre-wrap">{{ item.text }}</span>
          </div>
          <div
            v-for="reply in item.reply ?? []"
            :key="`r-${reply.id}`"
            class="mt-1.5 rounded-lg bg-cover/[0.12] px-2 py-1 text-[13px] leading-snug text-cover"
          >
            <span class="font-bold text-cover/70">@ {{ reply.userName }}：</span>
            <span class="whitespace-pre-wrap">{{ reply.text }}</span>
          </div>
          <div class="mt-auto flex items-center gap-3 pt-3 text-xs text-cover/60">
            <span v-if="item.time" class="flex items-center gap-1">
              <IconLucideClock class="size-4" />
              {{ formatDate(item.time) }}
            </span>
            <span v-if="item.location" class="flex items-center gap-1">
              <IconLucideMapPin class="size-4" />
              {{ item.location }}
            </span>
            <span v-if="item.likedCount != null" class="ml-auto flex items-center gap-1">
              <IconLucideThumbsUp class="size-4" />
              {{ item.likedCount }}
            </span>
          </div>
        </div>
      </div>

      <!-- 加载更多 -->
      <div v-if="hasMore" class="flex justify-center py-5">
        <button
          class="rounded-full bg-cover/[0.12] px-6 py-2 text-sm text-cover transition-colors active:bg-cover/[0.2]"
          :disabled="loadingNew"
          @click.stop="loadMore"
        >
          {{ loadingNew ? "..." : t("common.loadMore") }}
        </button>
      </div>

      <!-- 空态 -->
      <div v-if="showEmpty" class="py-16 text-center text-sm text-cover/60">
        {{ t("comments.empty") }}
      </div>
    </div>
  </div>
</template>
