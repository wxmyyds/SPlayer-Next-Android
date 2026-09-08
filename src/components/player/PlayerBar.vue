<script setup lang="ts">
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import { useMediaStore } from "@/stores/media";
import { useFavorite } from "@/composables/useFavorite";
import { usePlaylistPicker } from "@/composables/usePlaylistPicker";
import { useTrackMenu } from "@/composables/useTrackMenu";
import { useDownload } from "@/composables/useDownload";
import { useProgressLyric } from "@/composables/useProgressLyric";
import * as player from "@/core/player";
import { isAndroid } from "@/utils/platform";
import IconFavorite from "~icons/material-symbols/favorite-rounded";
import IconFavoriteOutline from "~icons/material-symbols/favorite-outline-rounded";
import IconLucideMoreHorizontal from "~icons/lucide/more-horizontal";

const status = useStatusStore();
const settings = useSettingsStore();
const media = useMediaStore();
const fav = useFavorite();
const { position, duration, isPlaying, isLoading } = storeToRefs(status);
const { formatTooltip, snapToNearestLyric } = useProgressLyric();

/** 是否是浮动模式 */
const isFloating = computed(() => settings.appearance.layoutMode === "floating");
/** 是否显示进度条提示 */
const showTooltip = computed(() => settings.player.showProgressTooltip);

const onSeekDragEnd = (value: number): void => {
  const snappedValue = snapToNearestLyric(value);
  player.seek(snappedValue);
};

/** 播放岛手势：左滑下一首、右滑上一首（进度条与播控按钮不参与） */
const swipeRef = ref<HTMLElement | null>(null);
useSwipe(swipeRef, {
  threshold: 50,
  onSwipeEnd: (e, direction) => {
    if ((e.target as HTMLElement).closest("[data-no-swipe]")) return;
    if (direction === "left") player.nextTrack();
    else if (direction === "right") player.prevTrack();
  },
});

/** 添加到歌单 */
const {
  open: pickerOpen,
  tracks: pickerTracks,
  mode: pickerMode,
  openPicker,
} = usePlaylistPicker();

/** 歌曲菜单 */
const { enqueue: enqueueDownload } = useDownload();
const { items: menuItems, handleSelect: onMenuSelect } = useTrackMenu(toRef(media, "track"), {
  hidePlayActions: true,
  onAddToPlaylist: (track) => openPicker([track]),
  onDownload: (track, quality) => void enqueueDownload(track, { quality }),
});
</script>

<template>
  <!-- 浮动模式 -->
  <div v-if="isFloating" class="relative flex items-center px-4 gap-4 min-w-0">
    <PlayerControls compact />
    <div class="flex flex-col flex-1 min-w-0 gap-1 pt-2 pb-1">
      <div class="flex items-center gap-2 min-w-0">
        <TrackInfo compact class="flex-1">
          <template #title-trailing>
            <div class="flex items-center shrink-0">
              <SButton
                class="-my-1"
                type="primary"
                variant="text"
                circle
                :size="28"
                :icon-size="16"
                @click="fav.toggle(media.track)"
              >
                <template #icon>
                  <SIconSwap :active="fav.isLiked(media.track)">
                    <template #on><IconFavorite /></template>
                    <template #off><IconFavoriteOutline /></template>
                  </SIconSwap>
                </template>
              </SButton>
              <SDropdownMenu
                v-if="media.track"
                :items="menuItems"
                side="top"
                align="start"
                @select="onMenuSelect"
              >
                <template #trigger>
                  <SButton
                    class="-my-1"
                    type="primary"
                    variant="text"
                    circle
                    :size="28"
                    :icon-size="16"
                  >
                    <template #icon><IconLucideMoreHorizontal /></template>
                  </SButton>
                </template>
              </SDropdownMenu>
            </div>
          </template>
        </TrackInfo>
        <PlayerTimeInfo compact />
      </div>
      <SSlider
        :model-value="position"
        :min="0"
        :max="duration"
        :step="100"
        :track-height="3"
        :thumb-size="10"
        :always-show-thumb="false"
        :show-popover="showTooltip"
        @drag-end="onSeekDragEnd"
      >
        <template #popover="{ value }">{{ formatTooltip(value) }}</template>
      </SSlider>
    </div>
    <div class="shrink-0">
      <Toolbar :hide-volume="isAndroid" />
    </div>
  </div>
  <!-- 默认模式 -->
  <div v-else class="relative h-full">
    <div
      class="absolute top-0 -translate-y-1/2 z-10"
      :class="isAndroid ? 'left-4 right-4' : 'left-0 right-0'"
      data-no-swipe
    >
      <SSlider
        :model-value="position"
        :min="0"
        :max="duration"
        :step="100"
        :track-height="3"
        :thumb-size="12"
        :always-show-thumb="false"
        :show-popover="showTooltip"
        @drag-end="onSeekDragEnd"
      >
        <template #popover="{ value }">{{ formatTooltip(value) }}</template>
      </SSlider>
    </div>
    <!-- Android：悬浮岛单行布局（参考 splayer-for-android 手机播放栏，上下首交由通知栏/全屏页；左滑下一首右滑上一首） -->
    <div v-if="isAndroid" ref="swipeRef" class="flex items-center h-full gap-2 px-3">
      <TrackInfo compact class="flex-1 min-w-0">
        <template #title-trailing>
          <SButton
            class="-my-1"
            type="primary"
            variant="text"
            circle
            :size="28"
            :icon-size="16"
            @click="fav.toggle(media.track)"
          >
            <template #icon>
              <SIconSwap :active="fav.isLiked(media.track)">
                <template #on><IconFavorite /></template>
                <template #off><IconFavoriteOutline /></template>
              </SIconSwap>
            </template>
          </SButton>
        </template>
      </TrackInfo>
      <PlayerTimeInfo compact class="shrink-0" />
      <SButton
        type="primary"
        variant="secondary"
        circle
        :size="40"
        :loading="isLoading"
        :disabled="!media.track && !isLoading"
        data-no-swipe
        @click="player.togglePlay()"
      >
        <template #icon>
          <SIconSwap :active="isPlaying">
            <template #on><IconLucidePause /></template>
            <template #off><IconLucidePlay /></template>
          </SIconSwap>
        </template>
      </SButton>
    </div>
    <div v-else class="grid grid-cols-[1fr_auto_1fr] items-center h-full px-3 gap-3">
      <TrackInfo>
        <template #title-trailing>
          <div class="flex items-center shrink-0">
            <SButton
              class="-my-1"
              type="primary"
              variant="text"
              circle
              :size="28"
              :icon-size="18"
              @click="fav.toggle(media.track)"
            >
              <template #icon>
                <SIconSwap :active="fav.isLiked(media.track)">
                  <template #on><IconFavorite /></template>
                  <template #off><IconFavoriteOutline /></template>
                </SIconSwap>
              </template>
            </SButton>
            <SDropdownMenu
              v-if="media.track"
              :items="menuItems"
              side="top"
              align="start"
              @select="onMenuSelect"
            >
              <template #trigger>
                <SButton
                  class="-my-1"
                  type="primary"
                  variant="text"
                  circle
                  :size="28"
                  :icon-size="18"
                >
                  <template #icon><IconLucideMoreHorizontal /></template>
                </SButton>
              </template>
            </SDropdownMenu>
          </div>
        </template>
      </TrackInfo>
      <PlayerControls class="mx-15" />
      <div class="flex items-center justify-end gap-2 min-w-0">
        <PlayerTimeInfo />
        <Toolbar :hide-volume="isAndroid" />
      </div>
    </div>
  </div>
  <PlaylistPickerDialog v-model:open="pickerOpen" :mode="pickerMode" :tracks="pickerTracks" />
</template>
