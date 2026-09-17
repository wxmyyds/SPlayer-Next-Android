import { isAndroid } from "@/utils/platform";

/**
 * 判断是否为真实外链（http/https）
 * @param url 链接地址
 * @returns 是否为真实外链
 */
export const isExternalUrl = (url?: string | null): url is string =>
  !!url && /^https?:\/\//i.test(url);

/**
 * 打开外链
 * @param url 链接地址
 */
export const openExternal = async (url?: string | null): Promise<void> => {
  if (!isExternalUrl(url)) return;
  // Android WebView 未实现 onCreateWindow，window.open(_blank) 带 noopener 时
  // 部分版本静默失败，外链统一走原生 ACTION_VIEW 唤起系统浏览器
  if (isAndroid) {
    await window.api.system.openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};
