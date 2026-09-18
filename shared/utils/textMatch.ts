/**
 * 文本匹配共享原语：歌词候选匹配与元数据候选排序共用同一归一化规则
 */

/** 字符串归一化：小写 + 去分隔符/空白/标点 */
export const normalizeText = (text: string | undefined | null): string => {
  if (!text) return "";
  return text.toLowerCase().replace(/[、&;，,/|()·・\s\-_'"`~!?？！.。]+/g, "");
};

/** 双向 includes 命中 */
export const bothContains = (left: string, right: string): boolean =>
  left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left));
