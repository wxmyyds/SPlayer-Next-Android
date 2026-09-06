import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import { defineConfig } from "vitest/config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO_URL__: JSON.stringify(pkg.repository.url),
    __APP_REPO_NAME__: JSON.stringify(pkg.productName),
    __APP_AUTHOR__: JSON.stringify(pkg.author.name),
    __APP_HOMEPAGE__: JSON.stringify(pkg.homepage),
    __APP_AUTHOR_URL__: JSON.stringify(pkg.author.url),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@root": fileURLToPath(new URL("./", import.meta.url)),
      "@main/utils/logger": fileURLToPath(
        new URL("./platform/android/vendor/shim/logger.ts", import.meta.url),
      ),
      "@main/utils/proxy": fileURLToPath(
        new URL("./platform/android/vendor/shim/proxy.ts", import.meta.url),
      ),
      "@main/database/sessions": fileURLToPath(
        new URL("./platform/android/vendor/shim/sessions.ts", import.meta.url),
      ),
      "@main/store": fileURLToPath(
        new URL("./platform/android/vendor/shim/store.ts", import.meta.url),
      ),
    },
  },
  plugins: [
    vue(),
    AutoImport({
      imports: ["vue", "pinia", "vue-router", "@vueuse/core", "vue-i18n"],
    }),
  ],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.spec.ts", "docs/**/*.spec.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
