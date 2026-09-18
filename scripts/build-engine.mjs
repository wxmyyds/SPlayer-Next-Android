#!/usr/bin/env node
/**
 * 引擎 bundle 构建：esbuild 打包 entry.ts 为 IIFE 全局脚本
 *
 * 产物 android/app/src/main/assets/engine/bundle.js 由 Rust 壳在引擎内
 * 直接 eval；alias 与 vite.config.ts 的 WebView 别名保持同源。
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = resolve(root, "platform/android");

mkdirSync(resolve(root, "android/app/src/main/assets/engine"), { recursive: true });

await build({
  entryPoints: [resolve(platform, "engine/entry.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "neutral",
  minify: true,
  outfile: resolve(root, "android/app/src/main/assets/engine/bundle.js"),
  alias: {
    "@capacitor/core": resolve(platform, "engine/capacitor-stub.ts"),
    "@android": platform,
    "@shared": resolve(root, "shared"),
    "@main/utils/logger": resolve(platform, "vendor/shim/logger.ts"),
    "@main/utils/proxy": resolve(platform, "vendor/shim/proxy.ts"),
    "@main/database/sessions": resolve(platform, "vendor/shim/sessions.ts"),
    "@main/store": resolve(platform, "vendor/shim/store.ts"),
  },
  logLevel: "info",
});
