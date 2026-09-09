<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import { useSettingsStore } from "@/stores/settings";
import { usePlaybackTime } from "@/composables/usePlaybackTime";
import { getCurrentTime } from "@/services/playback";
import type { QualityLevel } from "@/utils/quality";
import { useFavorite } from "@/composables/useFavorite";
import { useDownload, buildDownloadQualityItems } from "@/composables/useDownload";
import { usePlaylistPicker } from "@/composables/usePlaylistPicker";
import { useImmersiveMode } from "@/composables/useImmersiveMode";
import { useTimeFormat } from "@/composables/useTimeFormat";
import { useProgressLyric } from "@/composables/useProgressLyric";
import Lyrics from "@/components/player/Lyrics/index.vue";
import AMLLLyrics from "@/components/player/Lyrics/AMLLLyrics.vue";
import PlaylistPickerDialog from "@/components/modals/PlaylistPickerDialog.vue";
import * as player from "@/core/player";
import { openExternal } from "@/utils/url";
import { isAndroid } from "@/utils/platform";
import IconFavorite from "~icons/material-symbols/favorite-rounded";
import IconFavoriteOutline from "~icons/material-symbols/favorite-outline-rounded";
import IconLucideListPlus from "~icons/lucide/list-plus";
import IconLucideDownload from "~icons/lucide/download";

const status = useStatusStore();
const media = useMediaStore();
const settings = useSettingsStore();
const fav = useFavorite();
const { enqueue: enqueueDownload } = useDownload();
const { t } = useI18n();
const {
  isPlaying,
  isLoading,
  position,
  duration,
  isPlayerExpanded,
  repeatMode,
  shuffleMode,
  heartMode,
  fmMode,
  showLyric,
} = storeToRefs(status);

const { timeDisplay, toggleTimeFormat } = useTimeFormat();
const { snapToNearestLyric } = useProgressLyric();

// Android：全屏播放页沉浸（隐藏状态栏/导航小白条，滑动临时呼出）
watch(isPlayerExpanded, (open) => {
  if (isAndroid) void window.api.system.setImmersive(open);
});
onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", syncFullscreenState);
  if (isAndroid) void window.api.system.setImmersive(false);
});

const lyricRef = ref<InstanceType<typeof Lyrics> | InstanceType<typeof AMLLLyrics>>();
const lyricMounted = ref(false);
const initialLyricTimeMs = ref(0);

/** 加载中的歌曲使用队列当前项兜底，避免全屏播放器出现空白。 */
const displayTrack = computed(() => media.track ?? status.currentTrack);
const hasLyric = computed(() => media.parsedLyric.length > 0 || media.lyricLoading);
const hasTrack = computed(() => !!displayTrack.value);

/** 精确播放时间（毫秒） */
const { start: startTick, stop: stopTick } = usePlaybackTime((currentMs) => {
  if (!status.trackLoading && !media.lyricLoading) {
    lyricRef.value?.setCurrentTime(currentMs + status.lyricOffsetMs, player.isSeeking());
  }
});

/** 展开后 */
const onAfterEnter = () => {
  initialLyricTimeMs.value = getCurrentTime() + status.lyricOffsetMs;
  lyricMounted.value = true;
  nextTick(() => {
    lyricRef.value?.resume();
    startTick();
  });
};

/** 收起前 */
const onBeforeLeave = () => {
  lyricRef.value?.freeze();
  stopTick();
};

/** 收起后 */
const onAfterLeave = () => {
  lyricMounted.value = false;
};

// 重新挂载时，刷新初始时间
watch(hasLyric, (value) => {
  if (value && lyricMounted.value) {
    initialLyricTimeMs.value = getCurrentTime() + status.lyricOffsetMs;
  }
});

// 歌词变化时先推送精确时间
watch(
  () => media.parsedLyric,
  () => lyricRef.value?.setCurrentTime(getCurrentTime() + status.lyricOffsetMs),
);

// 切换歌词引擎时，重新计算初始并推送时间
watch(
  () => settings.lyric.engine,
  () => {
    initialLyricTimeMs.value = getCurrentTime() + status.lyricOffsetMs;
    nextTick(() => {
      lyricRef.value?.setCurrentTime(getCurrentTime() + status.lyricOffsetMs);
      if (isPlaying.value) lyricRef.value?.resume();
    });
  },
);

const fullscreenCover = computed(() => settings.player.coverLayout === "fullscreen");
const coverWidth = computed(() => `${settings.player.coverLyricRatio * 100}%`);

const coverCentered = computed(() => {
  if (fullscreenCover.value || status.fullQueueOpen) return false;
  return !showLyric.value || (settings.player.autoCenterCover && !hasLyric.value);
});

/** 竖屏堆叠布局：仅 Android 竖屏，封面上歌词中控制下，桌面左右分栏不变 */
const isPortrait = useMediaQuery("(orientation: portrait)");
const stackedLayout = computed(() => isAndroid && isPortrait.value);
/** Android 横屏精简布局：只保留封面+歌手/歌单/专辑+歌词（无顶/底栏、无播控） */
const landscapeLayout = computed(() => isAndroid && !isPortrait.value);

/** 堆叠双页（参照 SPlayer-for-Android）：0 封面控制页，1 歌词频谱页，轨道滑动跟手 */
const stackPage = ref(0);
const page1Ref = useTemplateRef("page1Ref");
const lyricPaneRef = useTemplateRef("lyricPaneRef");
const commentPaneRef = useTemplateRef("commentPaneRef");
/** 在线曲目才有评论页（本地无评论源） */
const hasCommentPage = computed(
  () => stackedLayout.value && hasTrack.value && displayTrack.value?.source !== "local",
);
/** 堆叠页数：封面恒在，歌词/评论按需；页序 [评论 | 封面 | 歌词]（对照 SFA，封面右滑进评论） */
const stackTotal = computed(() => 2 + (hasCommentPage.value ? 1 : 0));
const commentIdx = computed(() => (hasCommentPage.value ? 0 : -1));
const coverIdx = computed(() => (hasCommentPage.value ? 1 : 0));
const lyricIdx = computed(() => coverIdx.value + 1);
const goStackPage = (page: number): void => {
  // 无歌词时歌词页为空：禁止滑入，否则空白页无内容可滑回
  if (page === lyricIdx.value && !hasLyric.value && !media.lyricLoading) return;
  stackPage.value = Math.max(0, Math.min(stackTotal.value - 1, page));
};
/** 如果拖拽起点在按钮/滑杆/输入框上，记录该目标（翻页时不跟手 + 不翻页） */
const swipeIgnoredTarget = ref<HTMLElement | null>(null);
const isIgnoredSwipeTarget = (e: TouchEvent): boolean =>
  !!(e.target as HTMLElement | null)?.closest?.("button, input, a, [role='slider']");

/** 各页统一翻页：左滑进下一页，右滑回上一页（按钮/滑杆/输入框上起始的手势留给控件） */
const onPaneSwipeEnd = (e: TouchEvent, direction: string): void => {
  if (!stackedLayout.value) return;
  if (direction !== "left" && direction !== "right") return;
  if (swipeIgnoredTarget.value) return;
  goStackPage(stackPage.value + (direction === "left" ? 1 : -1));
};

/** 第一页整页左滑 */
const page1Swipe = useSwipe(page1Ref, {
  threshold: 40,
  onSwipeStart: (e) => {
    swipeIgnoredTarget.value = isIgnoredSwipeTarget(e) ? (e.target as HTMLElement) : null;
  },
  onSwipeEnd: (e, direction) => {
    onPaneSwipeEnd(e, direction);
  },
});
const lyricSwipe = useSwipe(lyricPaneRef, {
  threshold: 40,
  onSwipeStart: (e) => {
    swipeIgnoredTarget.value = isIgnoredSwipeTarget(e) ? (e.target as HTMLElement) : null;
  },
  onSwipeEnd: (e, direction) => {
    onPaneSwipeEnd(e, direction);
  },
});
const commentSwipe = useSwipe(commentPaneRef, {
  threshold: 40,
  onSwipeStart: (e) => {
    swipeIgnoredTarget.value = isIgnoredSwipeTarget(e) ? (e.target as HTMLElement) : null;
  },
  onSwipeEnd: (e, direction) => {
    onPaneSwipeEnd(e, direction);
  },
});
const isStackSwiping = computed(
  () =>
    (page1Swipe.isSwiping.value || lyricSwipe.isSwiping.value || commentSwipe.isSwiping.value) &&
    swipeIgnoredTarget.value == null,
);
/** 手指跟随偏移（px，左滑为负），竖滑不跟；控件上起始的手势不跟手 */
const stackDragPx = computed(() => {
  if (swipeIgnoredTarget.value) return 0;
  // 无歌词且无评论页时不跟手（歌词页是空占位）
  if (!hasLyric.value && !media.lyricLoading && !hasCommentPage.value) return 0;
  const active = page1Swipe.isSwiping.value
    ? page1Swipe
    : lyricSwipe.isSwiping.value
      ? lyricSwipe
      : commentSwipe.isSwiping.value
        ? commentSwipe
        : null;
  if (!active) return 0;
  const len = active.lengthX.value;
  if (active.lengthY.value >= len) return 0;
  const dir = active.direction.value;
  const px = dir === "left" ? -len : dir === "right" ? len : 0;
  // 首末页边界阻尼：越界方向钳位
  if (stackPage.value === 0) return Math.min(0, px);
  if (stackPage.value === stackTotal.value - 1) return Math.max(0, px);
  return px;
});
const stackTrackTransform = computed(
  () =>
    `translateX(calc(${(-stackPage.value * 100) / stackTotal.value}% + ${stackDragPx.value}px))`,
);
const stackTrackTransition = computed(() =>
  isStackSwiping.value ? "none" : "transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)",
);
// 页数/页序变化（切歌到本地、旋转屏）时落回封面页，避免停在错位或空页
watch(stackTotal, (value) => {
  if (stackPage.value > value - 1) {
    stackPage.value = !hasLyric.value && !media.lyricLoading ? coverIdx.value : value - 1;
  }
});
watch(hasCommentPage, () => {
  stackPage.value = coverIdx.value;
});

const handleLyricSeek = async (timeMs: number): Promise<void> => {
  await player.seek(timeMs);
  if (!isPlaying.value) await player.play();
};

const springConfig = computed(() => ({
  mass: settings.lyric.springMass,
  damping: settings.lyric.springDamping,
  stiffness: settings.lyric.springStiffness,
}));

const lyricFontSize = computed(() => {
  // 横屏高度只有竖屏一半：竖屏基准的字号在横屏会显得过小，按高度比例放大
  if (isAndroid && landscapeLayout.value) {
    const factor = settings.lyric.adaptiveFontSize ? 2 : 1.4;
    return `calc(${settings.lyric.fontSize * factor} / 1080 * 100vh)`;
  }
  return settings.lyric.adaptiveFontSize
    ? `calc(${settings.lyric.fontSize} / 1080 * 100vh)`
    : `${settings.lyric.fontSize}px`;
});

const { immersive, onPlayerMouseEnter, onPlayerMouseLeave, onMainMove, onBarEnter, onBarLeave } =
  useImmersiveMode(isPlayerExpanded);

const isFullscreen = ref(false);
const toggleFullscreen = (): void => {
  isFullscreen.value = !isFullscreen.value;
  if (isFullscreen.value) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.().catch(() => {});
};
// Esc/手势等外部退出全屏时同步图标状态
const syncFullscreenState = (): void => {
  isFullscreen.value = document.fullscreenElement != null;
};
onMounted(() => document.addEventListener("fullscreenchange", syncFullscreenState));

const canDownload = computed(
  () =>
    !!displayTrack.value &&
    displayTrack.value.source !== "local" &&
    settings.system.download.enabled,
);

const downloadQualityItems = computed(() =>
  buildDownloadQualityItems(t("download.qualityDefault")),
);

const onDownloadSelect = (key: string): void => {
  if (!displayTrack.value) return;
  void enqueueDownload(displayTrack.value, key ? { quality: key as QualityLevel } : {});
};

const collapse = (): void => {
  isPlayerExpanded.value = false;
};

const onSeekDragEnd = (value: number): void => {
  player.seek(snapToNearestLyric(value));
};

const {
  open: pickerOpen,
  tracks: pickerTracks,
  mode: pickerMode,
  openPicker,
} = usePlaylistPicker();

const lyricToggleDisabled = computed(() => !hasLyric.value || fullscreenCover.value);
const lyricToggleActive = computed(
  () => showLyric.value && hasLyric.value && !status.fullQueueOpen && !fullscreenCover.value,
);

const toggleLyric = (): void => {
  if (status.fullQueueOpen) {
    status.fullQueueOpen = false;
    showLyric.value = true;
  } else {
    showLyric.value = !showLyric.value;
  }
};
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-transform duration-500 ease-[cubic-bezier(0.7,0,0.3,1)]"
      leave-active-class="transition-transform duration-500 ease-[cubic-bezier(0.7,0,0.3,1)]"
      enter-from-class="translate-y-full"
      leave-to-class="translate-y-full"
      @after-enter="onAfterEnter"
      @before-leave="onBeforeLeave"
      @after-leave="onAfterLeave"
    >
      <div
        v-show="isPlayerExpanded"
        class="fixed inset-0 z-200 overflow-hidden text-cover"
        :class="immersive ? 'cursor-none [&_*]:!cursor-none' : ''"
        style="--lp-color: rgb(var(--s-cover))"
        @mouseenter="onPlayerMouseEnter"
        @mouseleave="onPlayerMouseLeave"
      >
        <!-- 背景 -->
        <PlayerBackground />
        <!-- 全屏封面（横屏精简布局忽略全屏封面设置，避免与右列歌词重叠） -->
        <div v-if="fullscreenCover && !landscapeLayout" class="absolute inset-y-0 left-0 w-[60%]">
          <PlayerCover fullscreen />
        </div>
        <!-- 底部频谱：堆叠时只在歌词页展示，横屏精简布局不展示 -->
        <BottomSpectrum
          v-if="isPlayerExpanded && settings.player.enableSpectrum"
          :show="
            isPlaying && immersive && !landscapeLayout && (!stackedLayout || stackPage === coverIdx)
          "
        />
        <!-- 顶/底栏渐变遮罩（全屏封面模式） -->
        <div
          v-if="fullscreenCover && !landscapeLayout"
          class="cover-mask-top absolute top-0 inset-x-0 h-20 z-5 pointer-events-none transition-opacity duration-400"
          :class="immersive ? 'opacity-0' : 'opacity-100'"
        />
        <div
          v-if="fullscreenCover && !landscapeLayout"
          class="cover-mask-bottom absolute bottom-0 inset-x-0 h-48 z-5 pointer-events-none transition-opacity duration-400"
          :class="immersive ? 'opacity-0' : 'opacity-100'"
        />
        <!-- 顶栏：Android 避开状态栏；横屏精简布局不渲染 -->
        <div
          v-if="!landscapeLayout"
          class="absolute inset-x-0 z-10 app-drag-region transition-opacity duration-400 flex items-center justify-between px-3"
          :class="[
            immersive ? 'opacity-0 pointer-events-none' : 'opacity-100',
            isAndroid
              ? 'h-[calc(3.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)]'
              : 'h-14',
          ]"
          @mouseenter="onBarEnter"
          @mouseleave="onBarLeave"
        >
          <div class="app-no-drag flex items-center gap-2">
            <SButton
              type="cover"
              variant="ghost"
              circle
              :size="40"
              :disabled="lyricToggleDisabled"
              :class="lyricToggleActive ? 'opacity-100' : 'opacity-40'"
              @click="toggleLyric"
            >
              <template #icon><IconLucideTextQuote /></template>
            </SButton>
          </div>
          <div class="app-no-drag flex items-center gap-3">
            <SButton
              v-if="isAndroid"
              type="cover"
              variant="ghost"
              circle
              :size="40"
              @click="collapse"
            >
              <template #icon><IconLucideChevronDown /></template>
            </SButton>
            <SButton
              v-if="!isAndroid"
              type="cover"
              variant="ghost"
              circle
              :size="40"
              @click="toggleFullscreen"
            >
              <template #icon>
                <IconLucideMinimize v-if="isFullscreen" />
                <IconLucideMaximize v-else />
              </template>
            </SButton>
          </div>
        </div>
        <!-- 横屏精简布局唯一收起锚点（顶/底栏均不渲染，否则无退出途径） -->
        <SButton
          v-if="landscapeLayout"
          type="cover"
          variant="ghost"
          circle
          :size="36"
          class="absolute top-2.5 right-2.5 z-10"
          @click="collapse"
        >
          <template #icon><IconLucideChevronDown /></template>
        </SButton>
        <!-- 主区域：堆叠时文档流（封面区+歌词区上下排），横屏精简为左右分栏，桌面左右绝对分栏 -->
        <div
          class="absolute inset-x-0"
          :class="
            landscapeLayout
              ? 'top-0 bottom-0'
              : stackedLayout
                ? isAndroid
                  ? 'top-[calc(3.5rem+env(safe-area-inset-top))] bottom-0 flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]'
                  : 'top-14 bottom-0 flex flex-col overflow-hidden'
                : isAndroid
                  ? 'top-[calc(3.5rem+env(safe-area-inset-top))] bottom-20'
                  : 'top-14 bottom-20'
          "
          @mousemove="onMainMove"
        >
          <!-- 堆叠滑动轨道（桌面 display:contents 穿透，不影响绝对分栏） -->
          <div
            :class="stackedLayout ? 'flex flex-row flex-1 min-h-0 shrink-0' : 'contents'"
            :style="
              stackedLayout
                ? {
                    width: `${stackTotal * 100}%`,
                    transform: stackTrackTransform,
                    transition: stackTrackTransition,
                  }
                : undefined
            "
          >
            <!-- 评论页（堆叠最左页，封面右滑进入；UI 对照 SFA PlayerComment） -->
            <div
              v-if="stackedLayout && hasCommentPage"
              ref="commentPaneRef"
              class="h-full shrink-0 flex flex-col min-h-0"
              :style="{ width: `${100 / stackTotal}%` }"
            >
              <PlayerCommentPage :active="stackPage === commentIdx" @back="goStackPage(coverIdx)" />
            </div>
            <div
              ref="page1Ref"
              :class="
                stackedLayout ? 'h-full shrink-0 flex flex-col overflow-y-auto pb-10' : 'contents'
              "
              :style="stackedLayout ? { width: `${100 / stackTotal}%` } : undefined"
            >
              <!-- 左侧（堆叠时为顶部封面区，参照 SPlayer-for-Android：72vw 大图+信息组在下） -->
              <div
                v-if="!fullscreenCover || landscapeLayout"
                class="flex transition-transform duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
                :class="
                  landscapeLayout
                    ? 'absolute inset-y-0 left-0 w-[38%] flex-col items-center justify-center gap-5 px-4'
                    : stackedLayout
                      ? 'w-full flex-col items-center px-5 pt-8 shrink-0'
                      : 'absolute inset-y-0 left-0 items-center justify-center px-12'
                "
                :style="
                  stackedLayout || landscapeLayout
                    ? undefined
                    : {
                        width: coverWidth,
                        transform: coverCentered ? 'translateX(calc(50vw - 50%))' : undefined,
                      }
                "
              >
                <div
                  class="relative"
                  :class="
                    landscapeLayout
                      ? 'w-[70%] max-w-[220px]'
                      : stackedLayout
                        ? 'w-[min(100%,clamp(240px,72vw,380px))]'
                        : 'w-[clamp(200px,85%,50vh)] -translate-y-[11vh]'
                  "
                >
                  <Transition name="scale-switch" mode="out-in">
                    <div :key="displayTrack?.id">
                      <PlayerCover />
                      <div
                        v-if="!stackedLayout && !landscapeLayout"
                        class="absolute top-full left-0 w-full pt-6"
                      >
                        <PlayerData align="left" />
                      </div>
                    </div>
                  </Transition>
                </div>
                <!-- 横屏精简信息：歌手/歌单/专辑 -->
                <PlayerData v-if="landscapeLayout" align="center" meta-only class="shrink-0" />
              </div>
              <!-- 堆叠页内行（参照 SPlayer-for-Android：信息+动作/进度/控制，第一页） -->
              <template v-if="stackedLayout">
                <div class="w-full flex flex-col gap-1 px-5 pt-3 shrink-0">
                  <div class="w-full min-w-0">
                    <PlayerData align="left" simple />
                  </div>
                  <div class="flex items-center gap-1">
                    <SButton
                      type="cover"
                      variant="ghost"
                      circle
                      :size="36"
                      :disabled="!hasTrack"
                      @click="fav.toggle(displayTrack)"
                    >
                      <template #icon>
                        <SIconSwap :active="fav.isLiked(displayTrack)">
                          <template #on><IconFavorite /></template>
                          <template #off><IconFavoriteOutline /></template>
                        </SIconSwap>
                      </template>
                    </SButton>
                    <SButton
                      v-if="displayTrack?.source === 'local' || displayTrack?.source === 'netease'"
                      type="cover"
                      variant="ghost"
                      circle
                      :size="36"
                      @click="displayTrack && openPicker([displayTrack])"
                    >
                      <template #icon><IconLucideListPlus /></template>
                    </SButton>
                    <Toolbar cover hide-volume />
                  </div>
                </div>
                <div class="w-full flex items-center gap-2 px-5 pt-2 shrink-0">
                  <span
                    class="text-xs text-cover/50 tabular-nums min-w-9 text-center"
                    @click="toggleTimeFormat"
                  >
                    {{ timeDisplay[0] }}
                  </span>
                  <SSlider
                    :model-value="position"
                    :min="0"
                    :max="duration"
                    :step="100"
                    :always-show-thumb="false"
                    cover
                    class="flex-1"
                    @drag-end="onSeekDragEnd"
                  />
                  <span
                    class="text-xs text-cover/50 tabular-nums min-w-9 text-center"
                    @click="toggleTimeFormat"
                  >
                    {{ timeDisplay[1] }}
                  </span>
                </div>
                <div
                  class="w-full flex items-center justify-between px-8 pt-3 shrink-0 mx-auto"
                  style="max-width: 420px"
                >
                  <SButton
                    type="cover"
                    variant="ghost"
                    circle
                    :size="40"
                    @click="
                      fmMode
                        ? player.dislikeFmTrack()
                        : heartMode
                          ? player.exitHeartMode()
                          : player.toggleShuffleMode()
                    "
                  >
                    <template #icon>
                      <IconLucideHeartOff v-if="fmMode" />
                      <IconSpHeartMode v-else-if="heartMode" />
                      <IconLucideShuffle v-else-if="shuffleMode === 'on'" />
                      <IconSpPlayOrder v-else />
                    </template>
                  </SButton>
                  <SButton
                    type="cover"
                    variant="ghost"
                    circle
                    :size="50"
                    :disabled="!hasTrack || fmMode"
                    @click="player.prevTrack()"
                  >
                    <template #icon><IconLucideSkipBack /></template>
                  </SButton>
                  <SButton
                    type="cover"
                    variant="secondary"
                    circle
                    :size="60"
                    :loading="isLoading"
                    :disabled="!hasTrack && !isLoading"
                    @click="player.togglePlay()"
                  >
                    <template #icon>
                      <SIconSwap :active="isPlaying">
                        <template #on><IconLucidePause /></template>
                        <template #off><IconLucidePlay /></template>
                      </SIconSwap>
                    </template>
                  </SButton>
                  <SButton
                    type="cover"
                    variant="ghost"
                    circle
                    :size="50"
                    :disabled="!hasTrack"
                    @click="player.nextTrack()"
                  >
                    <template #icon><IconLucideSkipForward /></template>
                  </SButton>
                  <SButton
                    type="cover"
                    variant="ghost"
                    circle
                    :size="40"
                    :disabled="fmMode"
                    :class="fmMode ? 'opacity-40' : 'opacity-100'"
                    @click="player.cycleRepeatMode()"
                  >
                    <template #icon>
                      <IconLucideInfinity v-if="fmMode" />
                      <IconLucideRepeat1 v-else-if="repeatMode === 'one'" />
                      <IconLucideRepeat v-else />
                    </template>
                  </SButton>
                </div>
              </template>
            </div>
            <div
              :class="stackedLayout ? 'h-full shrink-0 flex flex-col min-h-0' : 'contents'"
              :style="stackedLayout ? { width: `${100 / stackTotal}%` } : undefined"
            >
              <!-- 右侧（堆叠时为歌词频谱页，文档流占满剩余高度） -->
              <div
                ref="lyricPaneRef"
                class="group flex flex-col transition-opacity duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
                :class="[
                  (coverCentered && !landscapeLayout) || status.fullQueueOpen
                    ? 'opacity-0 pointer-events-none'
                    : 'opacity-100',
                  landscapeLayout
                    ? 'absolute inset-y-0 right-0 w-1/2 pr-4'
                    : stackedLayout
                      ? 'relative flex-1 min-h-0 w-full px-4 pt-2'
                      : 'absolute inset-y-0 right-0 pr-20',
                ]"
                :style="
                  stackedLayout
                    ? { width: '100%' }
                    : landscapeLayout
                      ? undefined
                      : { width: fullscreenCover ? '50%' : `calc(100% - ${coverWidth})` }
                "
              >
                <!-- 全屏封面 -->
                <div
                  v-if="fullscreenCover && !landscapeLayout"
                  class="shrink-0 pt-2 pb-6 pl-[calc(1em-0.5rem)]"
                  :style="{ fontSize: lyricFontSize }"
                >
                  <PlayerData align="left" simple />
                </div>
                <!-- 歌词容器 -->
                <div
                  class="lyric-area relative flex-1 min-h-0"
                  :style="{
                    fontSize: lyricFontSize,
                    fontWeight: String(settings.lyric.fontWeight),
                    fontFamily: settings.lyric.fontFamily || undefined,
                    '--lyric-font-zh': settings.lyric.fontFamilyChinese || undefined,
                    '--lyric-font-ja': settings.lyric.fontFamilyJapanese || undefined,
                    '--lyric-font-ko': settings.lyric.fontFamilyKorean || undefined,
                    '--lyric-font-latin': settings.lyric.fontFamilyLatin || undefined,
                    mixBlendMode: settings.lyric.lyricBlendMode,
                  }"
                >
                  <AMLLLyrics
                    v-if="lyricMounted && hasLyric && settings.lyric.engine === 'amll'"
                    ref="lyricRef"
                    :lyric-lines="media.parsedLyric"
                    :initial-time="initialLyricTimeMs"
                    :playing="isPlaying"
                    :align-position="settings.lyric.alignPosition"
                    :word-fade-width="settings.lyric.wordFadeWidth"
                    :hide-passed-lines="settings.lyric.hidePassedLines"
                    :enable-blur="settings.lyric.enableBlur"
                    :show-translation="settings.lyric.showTranslation"
                    :show-line-romanization="settings.lyric.amllShowLineRomanization"
                    :show-word-romanization="settings.lyric.amllShowWordRomanization"
                    @seek="handleLyricSeek"
                  >
                    <template #bottom>
                      <div v-if="media.lyricAuthors.length > 0" class="lyric-credit-line">
                        <span class="lyric-credit-prefix">{{ $t("player.lyricCredit") }}</span>
                        <template v-for="(author, idx) in media.lyricAuthors" :key="author">
                          <span v-if="idx > 0" class="mx-1">,</span>
                          <span
                            class="lp-content lyric-credit"
                            @click.stop="openExternal(`https://github.com/${author}`)"
                          >
                            {{ "@" + author }}
                          </span>
                        </template>
                      </div>
                    </template>
                  </AMLLLyrics>
                  <Lyrics
                    v-else-if="lyricMounted && hasLyric"
                    ref="lyricRef"
                    :lyric-lines="media.parsedLyric"
                    :initial-time="initialLyricTimeMs"
                    :playing="isPlaying"
                    :align-position="settings.lyric.alignPosition"
                    :word-fade-width="settings.lyric.wordFadeWidth"
                    :spring-config="springConfig"
                    :inactive-alpha="settings.lyric.inactiveAlpha"
                    :hide-passed-lines="settings.lyric.hidePassedLines"
                    :enable-blur="settings.lyric.enableBlur"
                    :enable-word-highlight="settings.lyric.enableWordHighlight"
                    :enable-float-animation="settings.lyric.enableFloatAnimation"
                    :enable-emphasize-effect="settings.lyric.enableEmphasizeEffect"
                    :show-translation="settings.lyric.showTranslation"
                    :show-romanization="settings.lyric.showRomanization"
                    @seek="handleLyricSeek"
                  >
                    <template #bottom>
                      <div v-if="media.lyricAuthors.length > 0" class="lyric-credit-line">
                        <span class="lyric-credit-prefix">{{ $t("player.lyricCredit") }}</span>
                        <template v-for="(author, idx) in media.lyricAuthors" :key="author">
                          <span v-if="idx > 0" class="mx-1">,</span>
                          <span
                            class="lp-content lyric-credit"
                            @click.stop="openExternal(`https://github.com/${author}`)"
                          >
                            {{ "@" + author }}
                          </span>
                        </template>
                      </div>
                    </template>
                  </Lyrics>
                  <div
                    v-else-if="lyricMounted"
                    class="w-full h-full flex items-center justify-center text-cover/30"
                  >
                    暂无歌词
                  </div>
                </div>
                <!-- 歌词侧边工具栏：横屏精简布局不渲染 -->
                <LyricActions v-if="!landscapeLayout" :immersive="immersive" />
              </div>
            </div>
          </div>
          <!-- 堆叠分页点（逐像素对照参照：白 20% 圆点 / 主色 16px 胶囊，内联样式锁定） -->
          <div
            v-if="stackedLayout"
            :style="{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 'calc(16px + env(safe-area-inset-bottom))',
              display: 'flex',
              justifyContent: 'center',
              gap: '8px',
              zIndex: 10,
              pointerEvents: 'none',
            }"
          >
            <button
              v-for="i in stackTotal"
              :key="i"
              :aria-label="`page ${i}`"
              :style="
                stackPage === i - 1
                  ? {
                      width: '16px',
                      height: '6px',
                      borderRadius: '4px',
                      backgroundColor: 'rgb(var(--s-cover))',
                      opacity: 0.8,
                      border: 'none',
                      padding: 0,
                      pointerEvents: 'auto',
                      transition: 'all 0.3s',
                    }
                  : {
                      width: '6px',
                      height: '6px',
                      borderRadius: '50%',
                      backgroundColor: 'rgba(255, 255, 255, 0.2)',
                      border: 'none',
                      padding: 0,
                      pointerEvents: 'auto',
                      transition: 'all 0.3s',
                    }
              "
              @click="goStackPage(i - 1)"
            />
          </div>
          <!-- 播放队列 -->
          <div
            class="absolute flex items-center"
            :class="[
              status.fullQueueOpen
                ? stackedLayout
                  ? 'inset-0 z-20 p-4 pt-[calc(4rem+env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-black/60 backdrop-blur-xl'
                  : 'inset-y-0 right-0 pl-4 py-6'
                : 'inset-y-0 right-0 pl-4 py-6 pointer-events-none',
            ]"
            :style="
              stackedLayout || landscapeLayout
                ? { width: '100%' }
                : { width: fullscreenCover ? '50%' : `calc(100% - ${coverWidth})` }
            "
          >
            <Transition
              enter-active-class="transition-opacity duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
              enter-from-class="opacity-0"
              leave-active-class="transition-opacity duration-600 ease-[cubic-bezier(0.4,0,0.2,1)]"
              leave-to-class="opacity-0"
            >
              <div v-if="status.fullQueueOpen" class="w-full h-full">
                <QueuePanel @close="status.fullQueueOpen = false" />
              </div>
            </Transition>
          </div>
        </div>
        <!-- 底栏（桌面与 Android 横屏精简布局不渲染） -->
        <div
          v-if="!stackedLayout && !landscapeLayout"
          class="absolute bottom-0 inset-x-0 z-10 flex items-center transition-opacity duration-400 h-20 gap-4 px-4"
          :class="immersive ? 'opacity-0 pointer-events-none' : 'opacity-100'"
          @mouseenter="onBarEnter"
          @mouseleave="onBarLeave"
        >
          <div class="flex-1 min-w-0 flex items-center justify-start gap-2">
            <SButton type="cover" variant="ghost" size="large" circle @click="collapse">
              <template #icon><IconLucideChevronDown /></template>
            </SButton>
            <SButton
              type="cover"
              variant="ghost"
              size="large"
              circle
              :disabled="!hasTrack"
              @click="fav.toggle(displayTrack)"
            >
              <template #icon>
                <SIconSwap :active="fav.isLiked(displayTrack)">
                  <template #on><IconFavorite /></template>
                  <template #off><IconFavoriteOutline /></template>
                </SIconSwap>
              </template>
            </SButton>
            <SButton
              v-if="displayTrack?.source === 'local' || displayTrack?.source === 'netease'"
              type="cover"
              variant="ghost"
              size="large"
              circle
              @click="displayTrack && openPicker([displayTrack])"
            >
              <template #icon><IconLucideListPlus /></template>
            </SButton>
            <SDropdownMenu
              v-if="canDownload"
              :items="downloadQualityItems"
              cover
              side="top"
              align="start"
              @select="onDownloadSelect"
            >
              <template #trigger>
                <SButton type="cover" variant="ghost" size="large" circle>
                  <template #icon><IconLucideDownload /></template>
                </SButton>
              </template>
            </SDropdownMenu>
          </div>
          <div
            class="shrink-0 flex flex-col items-center gap-1"
            :class="'w-[clamp(360px,35%,480px)]'"
          >
            <div class="flex items-center gap-3">
              <SButton
                type="cover"
                variant="ghost"
                circle
                @click="
                  fmMode
                    ? player.dislikeFmTrack()
                    : heartMode
                      ? player.exitHeartMode()
                      : player.toggleShuffleMode()
                "
              >
                <template #icon>
                  <IconLucideHeartOff v-if="fmMode" />
                  <IconSpHeartMode v-else-if="heartMode" />
                  <IconLucideShuffle v-else-if="shuffleMode === 'on'" />
                  <IconSpPlayOrder v-else />
                </template>
              </SButton>
              <SButton
                type="cover"
                variant="ghost"
                circle
                :disabled="!hasTrack || fmMode"
                @click="player.prevTrack()"
              >
                <template #icon><IconLucideSkipBack /></template>
              </SButton>
              <SButton
                type="cover"
                variant="secondary"
                size="large"
                circle
                :loading="isLoading"
                :disabled="!hasTrack && !isLoading"
                @click="player.togglePlay()"
              >
                <template #icon>
                  <SIconSwap :active="isPlaying">
                    <template #on><IconLucidePause /></template>
                    <template #off><IconLucidePlay /></template>
                  </SIconSwap>
                </template>
              </SButton>
              <SButton
                type="cover"
                variant="ghost"
                circle
                :disabled="!hasTrack"
                @click="player.nextTrack()"
              >
                <template #icon><IconLucideSkipForward /></template>
              </SButton>
              <SButton
                type="cover"
                variant="ghost"
                circle
                :disabled="fmMode"
                :class="fmMode ? 'opacity-40' : 'opacity-100'"
                @click="player.cycleRepeatMode()"
              >
                <template #icon>
                  <IconLucideInfinity v-if="fmMode" />
                  <IconLucideRepeat1 v-else-if="repeatMode === 'one'" />
                  <IconLucideRepeat v-else />
                </template>
              </SButton>
            </div>
            <div class="flex items-center gap-2 w-full">
              <span
                class="text-xs text-cover/50 tabular-nums min-w-9 text-center cursor-pointer px-1.5 py-0.5 rounded-md transition-colors hover:bg-cover/10"
                @click="toggleTimeFormat"
              >
                {{ timeDisplay[0] }}
              </span>
              <SSlider
                :model-value="position"
                :min="0"
                :max="duration"
                :step="100"
                :always-show-thumb="false"
                cover
                class="flex-1"
                @drag-end="onSeekDragEnd"
              />
              <span
                class="text-xs text-cover/50 tabular-nums min-w-9 text-center cursor-pointer px-1.5 py-0.5 rounded-md transition-colors hover:bg-cover/10"
                @click="toggleTimeFormat"
              >
                {{ timeDisplay[1] }}
              </span>
            </div>
          </div>
          <div class="flex-1 min-w-0 flex items-center justify-end">
            <Toolbar cover hide-volume />
          </div>
        </div>
      </div>
    </Transition>
    <PlaylistPickerDialog v-model:open="pickerOpen" :mode="pickerMode" :tracks="pickerTracks" />
  </Teleport>
</template>

<style scoped>
.lyric-area {
  filter: drop-shadow(0px 4px 6px rgba(0, 0, 0, 0.2));
  mask: linear-gradient(
    180deg,
    hsla(0, 0%, 100%, 0) 0,
    hsla(0, 0%, 100%, 0.6) 5%,
    #fff 10%,
    #fff 75%,
    hsla(0, 0%, 100%, 0.6) 85%,
    hsla(0, 0%, 100%, 0)
  );
}

/* 顶部/底部遮罩：多段非线性 alpha，避免暗色渐变出色阶 */
.cover-mask-top {
  background-image: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.5) 0%,
    rgba(0, 0, 0, 0.44) 12%,
    rgba(0, 0, 0, 0.36) 25%,
    rgba(0, 0, 0, 0.27) 40%,
    rgba(0, 0, 0, 0.18) 55%,
    rgba(0, 0, 0, 0.1) 70%,
    rgba(0, 0, 0, 0.04) 85%,
    rgba(0, 0, 0, 0) 100%
  );
}

.cover-mask-bottom {
  background-image: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.5) 0%,
    rgba(0, 0, 0, 0.44) 12%,
    rgba(0, 0, 0, 0.36) 25%,
    rgba(0, 0, 0, 0.27) 40%,
    rgba(0, 0, 0, 0.18) 55%,
    rgba(0, 0, 0, 0.1) 70%,
    rgba(0, 0, 0, 0.04) 85%,
    rgba(0, 0, 0, 0) 100%
  );
}

.lyric-credit-line {
  font-size: max(0.5em, 10px);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-start;
  text-align: left;
  width: 100%;
}

.lyric-credit {
  margin-left: 0.5em;
}
</style>
