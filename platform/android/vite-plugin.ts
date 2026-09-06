import type { Plugin } from "vite";

/**
 * 在主入口前注入 Android bridge，确保 Vue 初始化时 `window.api` 已存在。
 * @returns Android bridge HTML 注入插件
 */
export const androidBridgePlugin = (): Plugin => ({
  name: "splayer-android-bridge",
  transformIndexHtml(html) {
    return {
      html,
      tags: [
        {
          tag: "script",
          attrs: {
            type: "module",
            src: "/platform/android/window-api-shim.ts",
          },
          injectTo: "head-prepend",
        },
      ],
    };
  },
});
