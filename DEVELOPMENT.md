# SPlayer-Next-Android 开发文档

> 上游：`https://github.com/SPlayer-Dev/SPlayer-Next`（`v1.2.0-alpha.1`，`AGPL-3.0`）
> 目标：以最小改动把 SPlayer-Next 移植到 Android，功能尽量完整，长期可同步上游。

---

## 1. 上游架构速览（只看结论）

| 层                 | 位置                                                                                | 说明                                                                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前端 UI + 播放调度 | `src/`（约 368 文件，`Vue3 + Vite + Pinia + UnoCSS + Pixi`）                        | 页面 165 个 SFC，`src/core/player/index.ts` 只是调度器，不直接碰硬件                                                                                                                                                                      |
| 真后端             | `electron/main/`（约 275 文件）                                                     | 网易/酷狗/QQ 逆向 API、下载/扫描/缓存、`better-sqlite3`、`hono + ws` 本地服务、`BrowserWindow` 多窗口                                                                                                                                     |
| 原生性能层         | `native/`（6 个 Rust napi crate）                                                   | `audio-engine`（FFmpeg 解码 + cpal 输出 + 变速/变调/10段EQ/响度归一/rustfft 频谱/封面提取）、`media-ctrl`（Win SMTC / MPRIS / NowPlaying + Discord）、`audio-capture`、`taskbar-lyric`、`taskbar-thumbnail`（纯 Win）、`opencc`（纯算法） |
| 契约层             | `electron/preload/index.d.ts` + `shared/types/*` + `native/audio-engine/index.d.ts` | 前端只认 `window.api`，不直接认 Electron；JS 只认 `AudioPlayer` 签名，不认 Rust 内部                                                                                                                                                      |

---

## 2. 总体路线（定死，不摇摆）

1. **套壳，不重写**：`Capacitor 7` 使用 Android 专用 renderer 构建，桌面端继续使用现有 `electron-vite` 构建；不做 Flutter/RN/Kotlin 全量重写。
2. **冻结两个 ABI**：
   - `window.api`（以现有 preload 契约为基准）—— Android 初始化、平台分支和必要调用方适配直接提交到源代码，保持桌面平台默认路径不变。
   - `AudioPlayer`（`native/audio-engine/index.d.ts`：`load/play/pause/seek/setVolume/getFftData/...`）—— Rust 允许按 target 切换输出后端，不改变 JS 契约。
3. **源代码直接适配**：Android 平台差异直接修改对应的 `src/`、`electron/`、`shared/`、`native/` 或新增 `platform/android/`、`android/` 文件；通过 `import.meta.env.VITE_PLATFORM`、`cfg(target_os = "android")`、平台抽象和 Capacitor Plugin 隔离桌面行为。禁止把日常构建建立在未提交的 patch 或工作区状态上。
4. **保留可合并性**：Android 分支的改动必须小范围、可定位、优先添加平台分支；通用逻辑先抽象再复用。同步上游时使用 `merge-upstream-xxx` 临时分支，解决并验证冲突后再合回 `android`。
5. **Electron 主进程拆两半**：
   - 纯 TS 可跑（`apis/netease|kugou|qqmusic`、歌词解析、封面、插件逻辑）：直接打进 WebView 跑。插件不要沙箱，直跑，只装可信源。
   - 碰 Node 的（`fs / sqlite / 原生 / 窗口`）：下沉到 Capacitor Plugin（Kotlin）实现。

---

## 3. 功能取舍（“尽量”，不是“必须”）

### 3.1 Android 源代码分支裁剪

| 功能                                                          | 原因                                                                         | 实现位置                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| 灵动岛 `dynamicIsland`                                        | Android 暂不复用桌面悬浮动画，保留 API 兼容并在 Android 源代码分支中关闭入口 | `src/` / `platform/android/`     |
| MCP `services/mcp/* + ipc/mcp.ts`                             | Android 首批不启用桌面 AI 常驻服务                                           | `electron/` / `src/`             |
| 桌面壳：托盘/缩略图/任务栏歌词/多窗口创建/`showInExplorer` 等 | 由 Android Activity、通知、MediaSession 和系统分享能力替代                   | `src/` / `android/`              |
| 系统内录（`audio-capture` 内录一路）                          | Android 首批只保留麦克风识曲                                                 | `native/` / `android/`           |
| 本地曲库扫描（暂缓）                                          | 首版先用在线/流媒体跑通，后续接入 MediaStore/SAF                             | `platform/android/` 与源代码分支 |

### 3.2 必须保留（砍了会被骂）

`audio-engine` 满血（EQ/变速/FFT/无缝）、桌面歌词→通知栏歌词+简单悬浮、MediaSession/耳机线控、网易/QQ/酷狗、流媒体（Subsonic/Navidrome/Jellyfin/Emby）、下载、逐字歌词、sqlite 歌单/历史、插件系统（无沙箱直跑，只装可信源）。

### 3.3 桌面→安卓映射

| 桌面                            | 安卓                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `BrowserWindow` 桌面歌词/主窗口 | 同一 `.vue` 路由，悬浮窗（`SYSTEM_ALERT_WINDOW`）装 `WebView` / 主 `Activity` |
| 托盘/缩略图按钮                 | 前台 `Service + MediaSession + 通知栏封面/按钮`                               |
| 全局快捷键                      | 耳机线控/蓝牙/`MediaSession` 回调进同一套 `hotkey registry`                   |
| `better-sqlite3`                | `@capacitor-community/sqlite`，`schema` + `queries.ts` 原样用，只换 driver    |
| 下载/文件关联                   | `MediaStore + SAF`，路径转换收敛到 `platform/android/paths.ts`                |
| `Hono + ws` 本地服务            | 前台 `Service` 里跑，代码不动                                                 |

---

## 4. Rust 最小改

- `decoder.rs / equalizer.rs / fft.rs / tempo.rs / loudness.rs / scanner.rs`：平台无关，**别碰**。
- 只抽象 `audio_output.rs`：
  ```rust
  trait AudioBackend { /* open / write / ... */ }
  // cfg(target_os = "android") → Oboe / AAudio
  // 其他 → 现有 cpal
  ```
- `device_watcher/` 新增 `android.rs` 空实现。
- `cargo-ndk` 出 `.so`，包一层 JNI，但暴露给 JS 的函数名/参数与 `bindings/player.rs` 完全一致。
- `opencc` 纯算法，零改直接编过。
- Android 构建 `members` 里去掉 `taskbar-lyric`、`taskbar-thumbnail`。

---

## 5. Android 源代码适配清单

> 原则：平台差异直接提交在对应源文件中，不依赖未提交的补丁。每项 Android 裁剪都必须保留桌面默认分支，并通过显式平台判断或 target 条件隔离。

### 5.1 平台入口与窗口能力

Android 平台入口直接位于 `src/main.ts`，调用 `platform/android/bridge.ts` 安装兼容 API；不通过 HTML 注入脚本，也不依赖构建前删除文件。桌面窗口相关能力在 `src/`、`electron/` 中使用平台判断保留桌面分支，Android 分支改为 Activity、通知、MediaSession 或 no-op。

### 5.2 MCP

MCP 服务在 Android 平台不启动，相关设置入口和 API 保持类型兼容。实现时直接在 `electron/main/`、`src/` 的服务注册入口加入平台分支，桌面平台继续执行原逻辑；不删除 MCP 源文件和依赖。

### 5.3 桌面壳 Android 分支

Android 源代码分支直接短路或替换：托盘、缩略图、任务栏歌词窗口创建、桌面多窗口、`system:*` 中的展示文件/打开日志/重启/开发者工具、自更新、协议冷启动与外部文件拖拽；对应 Android 能力由 Activity、通知、MediaSession 和系统分享入口提供。

### 5.4 本地扫描 Android 分支

Android 源代码分支短路扫描入口、`library` 扫描 IPC 和桌面目录选择器；数据库表结构保留，后续通过 MediaStore/SAF 实现扫描。

### 5.5 系统内录 Android 分支

Android 源代码分支只短路内录一路，保留麦克风识曲：`recognition/session.ts` 中走内录会话的分支按平台跳过，`recognition:submitPcm`（麦克风 PCM）保留。

### 5.6 源代码维护

平台分支必须使用小范围、可复用的条件判断或抽象，禁止通过构建脚本删除源文件或依赖未提交的工作区状态。上游改动涉及同一文件时，在 `merge-upstream-xxx` 分支中先合并通用逻辑，再恢复 Android 分支；合并后运行完整 Android 验证链路。

## 6. Git 工作流（含合并分支）

分支定死 3 类：

```
upstream/dev           ← 只读，git fetch 更新
merge-upstream-xxx    ← 炮灰分支，专门解决冲突
android               ← 平时开发分支，只合验证过的 merge 分支
```

Android 平台源代码改动与功能代码一起提交；合并上游时要求工作区干净，避免把生成产物或临时兼容代码带入合并。

每次同步（建议 2 周一次，alpha 阶段别天天追）：

```bash
git fetch upstream
git checkout -b merge-upstream-0906 android
git merge upstream/dev
# 工作区是干净的，一般直接合上；有冲突也只在业务代码处，手动合
# 合并后验证 Android 平台分支：
pnpm typecheck
pnpm build:android:web
pnpm exec cap sync android
./gradlew -p android assembleDebug
git checkout android
git merge merge-upstream-0906
git branch -d merge-upstream-0906
```

建议：`git config rerere.enabled true`，同类冲突解一次自动记住。`merge-xxx` 炸了直接删了重开，不影响 `android`。

### Fork 侧 Android 工作流

当前只保留 `.github/workflows/android.yml`，直接执行 Android 类型检查、Web 构建、Capacitor 同步和 Debug APK 构建。上游合并发生 workflow 冲突时，保留 Android 工作流，不恢复桌面端矩阵构建。

---

## 7. 构建与验证

```bash
# Android Web 产物
pnpm build:android:web
# Android 原生工程
pnpm exec cap sync android
./gradlew -p android assembleDebug
# 全量类型检查
pnpm typecheck           # node + web 双通道必须过
```

分两阶段：

- P1 跑通（先做，不做任何性能优化，默认参数出声就行）：Android 源代码平台分支能进首页 → 调网易 API 播 128k mp3 → 接 SQLite + 登录态 → Rust 引擎出声（EQ/变速/FFT 默认值）。
- P2 优化（跑通后再做）：位置推送可调间隔、FFT 降频+截断、背景模糊重写/降级、低端机档位。具体方案见讨论记录，动手前再细化。

---

## 8. 约定

1. Android 平台适配允许直接修改必要的 `src/ electron/ shared/ native/` 源文件；必须使用显式 Android 分支或可复用抽象，桌面默认行为保持不变。
2. 新增 Android 专属代码进入 `android/ platform/android/`；通用抽象优先放入上游可复用位置，避免重复实现。
3. 许可证 `AGPL-3.0`：发包必须开源对应分支。
4. 上游伪装的是 `Android15` UA（见 `kugou/core/device.ts`），协议层优先复用，不重造轮子。
5. `AGENTS.md` / `CLAUDE.md` / 本文档为 fork 所有，合上游时一律保留我方版本。
