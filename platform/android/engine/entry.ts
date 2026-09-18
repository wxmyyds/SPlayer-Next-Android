/**
 * 引擎入口：Rust 壳加载本 bundle 后经 globalThis.__engineResolve 调用
 *
 * 直接使用 vendor 的 callNetease（与 WebView 内解析完全同一段代码），
 * Phase 2 再扩到 callVendorApi（kugou / qq）与插件源。
 */

import { installAll } from "./polyfills/install";
import { engineResolve } from "./resolve";

installAll();

/**
 * 引擎调用入口（Rust nativeCall fire）：异步结果写哨兵全局变量，
 * Rust 泵轮询读取 —— 避开 rquickjs Promise API 依赖
 */
Object.defineProperty(globalThis, "__engineCall", {
  value: (reqJson: string): void => {
    engineResolve(reqJson).then(
      (r) => {
        (globalThis as Record<string, unknown>).__engineResult = `R${r}`;
      },
      (e) => {
        const message = e instanceof Error ? e.message : String(e);
        (globalThis as Record<string, unknown>).__engineResult = `E${message}`;
      },
    );
  },
  writable: false,
});

Object.defineProperty(globalThis, "__engineResolve", {
  value: engineResolve,
  writable: false,
});
