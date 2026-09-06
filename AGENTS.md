# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

> 本仓库是 SPlayer-Next 的 **Android 移植 fork**（上游：`SPlayer-Dev/SPlayer-Next`，分支 `dev`）。
> 上游是桌面端（Electron + Windows/macOS/Linux），本 fork 目标是安卓端。本文件与 `CLAUDE.md`
> 为 fork 所有，合上游时一律保留我方版本（见文末同步规则）。

## Project Overview

Android music player. Vue 3 renderer (`src/`) 复用上游；外壳换成 **Capacitor 7 + Kotlin**，
音频保留 Rust `audio-engine`（经 `cargo-ndk` 编 `so` + JNI + Oboe 后端输出）。

## Commands

```bash
pnpm install              # Install deps
pnpm build                # 复用上游：electron-vite build → dist/（Android 只取 renderer 产物）
pnpm typecheck            # tsc + vue-tsc (node + web targets)，提交前必须过
pnpm lint / format        # ESLint / Prettier
```

Android（`android/` 目录落地后以其 README 为准，大致）：

```bash
npx cap sync android                                   # Web 产物同步到原生壳
cargo ndk -t arm64-v8a -o android/app/src/main/jniLibs build -p audio-engine
./gradlew -p android assembleDebug
```

`SKIP_NATIVE_BUILD=true` 跳过 Rust（只调 UI 时用）。

`audio-engine` 静态链接 FFmpeg（`ffmpeg_audio` crate），无系统依赖；安卓输出后端为 Oboe/AAudio，
解码/EQ/FFT/响度归一逻辑与桌面共用同一套 Rust 代码。

## Shell

开发环境为 Termux/Linux，bash 语法，Unix 路径（正斜杠）。不要写 PowerShell 或 Windows 路径。

## Architecture

### 分层

- **Renderer** (`src/`) — 以 Vue 3 SPA 为主体；Android 适配优先在源代码中通过 `import.meta.env.VITE_PLATFORM` 或平台分支实现，保持桌面默认行为不变。
- **Bridge** (`platform/android/` + `android/` Kotlin) — 用 Capacitor Plugin 实现与现有 `window.api` 契约兼容的接口；平台判断和初始化入口可直接落在 `src/`，不得依赖构建时注入 shim。
- **Service** — 前台 Service + MediaSession（替代托盘/缩略图/SMTC），通知栏封面与按钮。
- **Storage** — `@capacitor-community/sqlite`，表结构与上游一致；`better-sqlite3` 是同步 API，
  桥接层做一层 async DAO 适配（`platform/android/db.ts`），不要在业务代码里到处追加异步兼容分支。
- **Lyric** — 桌面歌词 `.vue` 路由复用，载体换成悬浮窗（`SYSTEM_ALERT_WINDOW`）/通知栏。

### Native Modules (Rust)

`native/` 中与平台无关的部分（decode/equalizer/fft/tempo/loudness/scanner）**别碰**。
安卓差异收敛在：`audio_output.rs` 后端抽象（Oboe）、`device_watcher/android.rs` 空实现、
构建成员按 Android target 直接在 workspace 配置中排除 `taskbar-lyric`/`taskbar-thumbnail`；平台差异使用源代码中的 `cfg` 或显式 Android 分支实现。

- `audio-engine` — 唯一满血保留的原生模块，JS 签名（`native/audio-engine/index.d.ts`）不变。
- `media-ctrl` — Discord RPC 用 `cfg(not(target_os = "android"))` 关掉；播放控制走 MediaSession。
- `audio-capture` — 只保留麦克风一路（`recognition:submitPcm`），系统内录一路在 Android 源代码分支中短路。
- `opencc` — 纯算法，零改。

### 上游同步规则（最高优先级）

- `origin` = 本 fork，`upstream` = 上游 `dev` 分支。同步使用一次性 `merge-upstream-xxx` 分支，
  解决冲突并验证后再合并回 `android`；不得把未验证的合并结果直接推送到 `android`。
- Android 平台差异允许直接修改 `src/`、`electron/`、`shared/` 和 `native/` 中的必要源文件，必须使用明确的
  Android 平台分支、`cfg` 或可复用抽象，保持桌面平台默认路径不变。
- 不再使用 `patches/` 作为日常构建依赖；功能裁剪和平台能力差异直接提交到对应源文件，避免工作区状态依赖和补丁漂移。
- 合并上游时优先保留上游新增通用逻辑，再重新应用 Android 平台分支；冲突解决后必须运行 `pnpm typecheck`、
  `pnpm build:android:web` 和 Android Gradle 构建。
- `.github/workflows/android.yml` 是当前唯一工作流，负责 Android 类型检查、Web 构建、Capacitor 同步和 Debug APK 构建。
- 本文件与 `CLAUDE.md`、`DEVELOPMENT.md` 为 fork 所有，合并时保留我方版本。

### 插件无沙箱

插件直跑（WebView 内执行，无 worker 隔离），只装可信源。不要给插件加沙箱/权限门控。

### Playback Data Flow

```
User action → status store → window.api (Capacitor bridge)
  → Service → audio-engine (.so via JNI)
  → Rust events (stateChanged/position/ended/outputStalled)
  → bridge → renderer + MediaSession
  → status store 更新响应式状态
  → playback.ts 更新非响应式时间源
```

位置推送 200ms（前台）是歌词插值的锚点，不要改；P2 优化才做后台降频（见 DEVELOPMENT.md §7）。

### State Management

沿用上游双层设计：

- `src/stores/status.ts` — Pinia 响应式，进度条/时间显示/播放按钮。
- `src/services/playback.ts` — 非响应式插值，RAF 循环给歌词/频谱用，不走 Vue 响应式。
- `src/stores/media.ts` — `Track` 轻量 + `TrackDetail` 按需加载；不持久化大 lyric 字符串。

### Data Storage (Android)

```
<app-files>/                # Context.getFilesDir()，经 platform/android/paths.ts 统一
├── config/settings.json    # 主配置（沿用上游 store 结构与默认值）
├── database/library.db     # 曲库（sqlite 插件，WAL）
├── cache/covers/           # 300px 封面缩略图（cover:// 协议由桥接层实现）
└── plugins/                # scripts/ data/（无沙箱，只读可信源）
```

Renderer IndexedDB（localforage）键名沿用上游（`splayer/library`、`splayer/queue`）。

### Cover Image

沿用上游纪律：小图（列表/模糊背景/取色）一律用 300px 缩略图；原图只给可见大封面。
大 `<img>` 加 `decoding="async"`，淡入前 `img.decode()`。

### Config

`shared/defaults/settings.ts` 的桌面默认值不改。安卓低端机降级（关 `lyric.enableBlur` /
`imageBackground.blur`）在 Android 源代码分支中通过首次启动配置写入，不修改桌面默认路径。

### i18n

沿用 `src/i18n/locales/{zh-CN,en-US}.json`；Android 不新增独立翻译表，平台分支直接复用现有 locale。

### Path Aliases

沿用上游（`@/` `@shared/` `@main/` `@windows/` `@splayer/*`），新增：

```
@android/              → platform/android/      (bridge、db 适配、perf 档位)
```

## Conventions

### Comments — Chinese, with JSDoc

All comments in Chinese. Methods use standard JSDoc with `@param name - description` and
`@returns` when meaningful:

```ts
/**
 * <Chinese method description>
 * @param trackId - <Chinese parameter description>
 * @returns <Chinese return description>
 */
```

Forbidden: `// ───` separator lines (including ones with section titles), prose-style multi-paragraph comments, restating-the-obvious comments, numbered enumerations (`1. 2. 3.`) inside comments. Write comments only when the **why** is non-obvious.

### Code Organization

Split logic into files rather than separator comments. Don't extract a helper for one-place callers (3+ uses justify it). No "just in case" defensive code or fallbacks for impossible scenarios. No configurable knobs (timeouts / retries / buffer sizes) unless required — write constants. Don't break errors into per-case enums; `anyhow` or plain `Error` is usually enough.

### Memory Discipline（手机上比桌面更严）

- **Images by display size** — 同上游；长列表再加一条：只用缩略图，禁止原图进列表（OOM）。
- **Compositing layers are budgeted** — 同上游；全屏 blur/backdrop-filter 在低端机默认关（走配置，不改代码）。
- **Hidden = silent** — 高频推送（`position` / `fftData`）前台 200ms/50ms 不变；切后台后由 Android 平台分支降频。低频状态事件常开。RAF/ canvas 随 surface 隐藏停止。
- **In-memory caches must be bounded** — 同上游；封面取色结果按 URL 缓存，避免重复计算。
- **Release 包不写文件日志**（P2），只保留内存环形日志，崩溃才落盘。

### Units

Frontend time is **milliseconds** everywhere. Rust engine uses seconds internally; `toMs()` in `electron/main/ipc/player.ts` converts. 新增桥接代码同样遵守：过桥一律毫秒。

### Types & Persistence

Never hand-write native module types — import from `@splayer/*`. Use `shallowRef` for `Track` arrays/collections (avoid deep proxy). Vue proxied objects can't be cloned by IDB (`DataCloneError`); use `toRaw` before persisting.

### Auto-imports

In Vue components, `vue / pinia / vue-router / @vueuse/core / vue-i18n` are auto-imported, and UI components in `src/components/` are auto-registered.
Icon components used only in Vue templates are auto-imported. Do not manually import them in
`<script setup>`; import an icon explicitly only when it is referenced by script code.

### Logging

Use scoped loggers from `@main/utils/logger` (`coreLog / playerLog / mediaLog`, etc.). Don't import `electron-log` directly. 安卓侧日志经桥接打到 logcat，tag 沿用 scope 名。

### Bridge Listeners

Capacitor 监听必须在组件 `onBeforeUnmount` 取消订阅（等价于上游 IPC 的 unsubscribe 纪律）。Preload 的 `removeAllListeners` 规则只适用于桌面 HMR，本 fork 不适用。

### Prettier

Double quotes, semicolons, 100-char width, trailing commas.

Before committing, run Prettier on every file included in the commit and verify the formatted
working tree before creating the commit. Do not leave formatting-only changes from the current task
outside the commit.

### Shared Types

Put cross-process types (`LocaleCode / SystemConfig / StreamingServerType`, etc.) in `shared/types/`. 新增桥接类型先看能否复用已有 `window.api` 形状，能复用就不新增。

### Commit Messages

Use Conventional Commits with a Chinese summary: `<type>: <summary>`. Keep the title on one line;
do not add a body or bullets unless explicitly requested. Use the type that matches the change,
such as `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `style`, or `chore`.
