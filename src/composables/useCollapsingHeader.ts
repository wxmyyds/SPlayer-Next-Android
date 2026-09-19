/**
 * 悬浮页头随列表滚动跟手收起（纯 transform，无布局挤压）。
 * 行程取头高：头部按自身高度百分比位移、列表按 px 滚动，两者速度只在
 * 行程==头高时一致，头部底边与首行保持恒定间距（歌单/专辑/每日推荐共用几何）。
 */
export const useCollapsingHeader = () => {
  const headerRef = ref<HTMLElement | null>(null);
  const { height: headerHeight } = useElementSize(headerRef);
  const listScrollTop = ref(0);
  const collapseProgress = computed(() =>
    Math.min(1, Math.max(0, listScrollTop.value / Math.max(1, headerHeight.value))),
  );
  const headerStyle = computed(() => ({
    transform: `translateY(${collapseProgress.value * -100}%)`,
    opacity: `${1 - collapseProgress.value}`,
    pointerEvents: collapseProgress.value >= 1 ? ("none" as const) : ("auto" as const),
  }));
  /** 列表内容顶部让位 = 头部高度 + 呼吸间距 */
  const headerPad = computed(() => Math.ceil(headerHeight.value) + 8);
  /** 列表滚动 → 头部收起进度；绑定到 SongList 的 @scroll */
  const handleListScroll = (event: Event) => {
    listScrollTop.value = (event.target as HTMLElement).scrollTop;
  };
  /** 复位收起进度：切换数据源/重载后列表重挂（:key 变更），滚动归零但不再发 scroll 事件 */
  const reset = () => {
    listScrollTop.value = 0;
  };
  return { headerRef, headerStyle, headerPad, handleListScroll, reset };
};
