import { resolve } from "node:path";
import { defineConfig } from "vite";
import UnoCSS from "unocss/vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Icons from "unplugin-icons/vite";
import IconsResolver from "unplugin-icons/resolver";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import RekaResolver from "reka-ui/resolver";
import Components from "unplugin-vue-components/vite";
import pkg from "../../package.json" with { type: "json" };

const root = resolve(__dirname, "../..");

export default defineConfig({
  root,
  publicDir: resolve(root, "public"),
  define: {
    "import.meta.env.VITE_PLATFORM": JSON.stringify("android"),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO_URL__: JSON.stringify(pkg.repository.url),
    __APP_REPO_NAME__: JSON.stringify(pkg.productName),
    __APP_HOMEPAGE__: JSON.stringify(pkg.homepage),
    __APP_AUTHOR__: JSON.stringify(pkg.author.name),
    __APP_AUTHOR_URL__: JSON.stringify(pkg.author.url),
    __COMMIT_HASH__: JSON.stringify("android"),
    __COMMIT_DATE__: JSON.stringify("unknown"),
  },
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      "@shared": resolve(root, "shared"),
      "@root": root,
      "@android": resolve(root, "platform/android"),
    },
  },
  build: {
    outDir: resolve(root, "out/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, "index.html"),
    },
  },
  plugins: [
    vue(),
    UnoCSS(),
    AutoImport({
      imports: ["vue", "pinia", "vue-router", "@vueuse/core", "vue-i18n"],
      eslintrc: { enabled: false },
    }),
    Icons({
      compiler: "vue3",
      scale: 1,
      customCollections: { sp: FileSystemIconLoader(resolve(root, "src/assets/icons")) },
    }),
    Components({
      dirs: [resolve(root, "src/components")],
      resolvers: [RekaResolver(), IconsResolver({ prefix: "icon", customCollections: ["sp"] })],
    }),
  ],
});
