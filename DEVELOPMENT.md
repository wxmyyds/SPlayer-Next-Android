# SPlayer-Next-Android 开发文档

> 上游：`https://github.com/SPlayer-Dev/SPlayer-Next`（`v1.2.0-alpha.1`，`AGPL-3.0`）
> 目标：以最小改动把 SPlayer-Next 移植到 Android，功能尽量完整，长期可同步上游。

---

## 1. 上游架构速览（只看结论）

| 层 | 位置 | 说明 |
|---|---|---|
| 前端 UI + 播放调度 | `src/`（约 368 文件，`Vue3 + Vite + Pinia + UnoCSS + Pixi`） | 页面 165 个 SFC，`src/core/player/index.ts` 只是调度器，不直接碰硬件 |
| 真后端 | `electron/main/`（约 275 文件） | 网易/酷狗/QQ 逆向 API、下载/扫描/缓存、`better-sqlite3`、`hono + ws` 本地服务、`BrowserWindow` 多窗口 |
| 原生性能层 | `native/`（6 个 Rust napi crate） | `audio-engine`（FFmpeg 解码 + cpal 输出 + 变速/变调/10段EQ/响度归一/rustfft 频谱/封面提取）、`media-ctrl`（Win SMTC / MPRIS / NowPlaying + Discord）、`audio-capture`、`taskbar-lyric`、`taskbar-thumbnail`（纯 Win）、`opencc`（纯算法） |
| 契约层 | `electron/preload/index.d.ts` + `shared/types/*` + `native/audio-engine/index.d.ts` | 前端只认 `window.api`，不直接认 Electron；JS 只认 `AudioPlayer` 签名，不认 Rust 内部 |

---

## 2. 总体路线（定死，不摇摆）

1. **套壳，不重写**：`Capacitor 7` 吃现有 `electron-vite build` 产出的 `dist/`，不做 Flutter/RN/Kotlin 全量重写。
2. **冻结两个 ABI**：
   - `window.api`（`preload/index.d.ts` 形状）—— `src/` 零改动，Android 端用 Kotlin + Capacitor 实现一套签名完全相同的 `window.api`。
   - `AudioPlayer`（`native/audio-engine/index.d.ts`：`load/play/pause/seek/setVolume/getFftData/...`）—— Rust 只换后端，不换签名。
3. **只加法，不改法**：上游文件不直接改，全靠补丁去掉不要的功能（见 §5）。所有 Android 代码只放在新增目录：
   ```
   /android/
   /platform/android/
   /capacitor.config.ts
   /patches/
   ```
   检查标准：`git diff upstream/dev -- src electron shared` 为空，裁剪只体现在 `patches/`（工作区打补丁，不提交）。
4. **Electron 主进程拆两半**：
   - 纯 TS 可跑（`apis/netease|kugou|qqmusic`、歌词解析、封面、插件逻辑）：直接打进 WebView 跑。插件不要沙箱，直跑，只装可信源。
   - 碰 Node 的（`fs / sqlite / 原生 / 窗口`）：下沉到 Capacitor Plugin（Kotlin）实现。

---

## 3. 功能取舍（“尽量”，不是“必须”）

### 3.1 用补丁去掉（代码不动，构建时打补丁，见 §5）

| 功能 | 原因 |
|---|---|
| 灵动岛 `dynamicIsland` | 安卓重做悬浮动画+手势成本高，价值低 | `disable-dynamic-island.patch` |
| MCP `services/mcp/* + ipc/mcp.ts + @modelcontextprotocol/sdk` | 桌面 AI 玩具，后台常驻耗电 + 商店审核风险 | `disable-mcp.patch` |
| 桌面壳：托盘/缩略图/任务栏歌词/全局快捷键/多窗口创建/`showInExplorer`等 `system.*`/`updater`/`orpheus`冷启动 | 无对应安卓概念，只能用通知/MediaSession/DeepLink 重做 | `disable-desktop-chrome.patch` |
| 系统内录（`audio-capture` 内录一路） | 安卓取不到任意系统声，只留麦克风识曲 | `disable-loopback-capture.patch` |
| 本地曲库扫描（暂缓） | 分区存储 + 后台被杀，第一版先用在线/流媒体跑通，以后单独适配 | `disable-local-scan.patch`（恢复=删此补丁） |

### 3.2 必须保留（砍了会被骂）

`audio-engine` 满血（EQ/变速/FFT/无缝）、桌面歌词→通知栏歌词+简单悬浮、MediaSession/耳机线控、网易/QQ/酷狗、流媒体（Subsonic/Navidrome/Jellyfin/Emby）、下载、逐字歌词、sqlite 歌单/历史、插件系统（无沙箱直跑，只装可信源）。

### 3.3 桌面→安卓映射

| 桌面 | 安卓 |
|---|---|
| `BrowserWindow` 桌面歌词/主窗口 | 同一 `.vue` 路由，悬浮窗（`SYSTEM_ALERT_WINDOW`）装 `WebView` / 主 `Activity` |
| 托盘/缩略图按钮 | 前台 `Service + MediaSession + 通知栏封面/按钮` |
| 全局快捷键 | 耳机线控/蓝牙/`MediaSession` 回调进同一套 `hotkey registry` |
| `better-sqlite3` | `@capacitor-community/sqlite`，`schema` + `queries.ts` 原样用，只换 driver |
| 下载/文件关联 | `MediaStore + SAF`，路径转换收敛到 `platform/android/paths.ts` |
| `Hono + ws` 本地服务 | 前台 `Service` 里跑，代码不动 |

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

## 5. 补丁清单

> 原则：上游文件一个都不删。裁剪全放在 `patches/` 里，构建前 `git apply` 打上即可。合上游时工作区永远是干净的，冲突只会落在补丁刷新那一步（见 §6）。

### 5.1 灵动岛（`patches/disable-dynamic-island.patch`）

补丁覆盖的文件（工作区删除/短路，git 不提交）：

```
electron/main/window/dynamicIsland.ts
windows/dynamic-island/   # App.vue + composables/useDragWindow.ts 整个目录
```

同一补丁内顺带改的行：

- `electron/main/window/index.ts`：删 `createDynamicIslandWindow` 整段 `export{...}` + `restoreLyricWindows` 里 `if (dynamicIsland.visible)` 一行
- `electron/main/core/index.ts`：删 `getDynamicIslandWindow` import + `namedWindows` 里 `["dynamic-island", ...]` 一行
- `electron/main/ipc/window.ts`：删 `dynamicIsland` 相关 `handle`
- `electron/preload/index.ts` + `index.d.ts`：删 `DynamicIslandApi / dynamicIsland:`
- `shared/types/window.ts`：删 `DynamicIslandApi` 定义
- `electron.vite.config.ts`：删 `"dynamic-island": resolve(...index.html)` 一行
- 零碎分支（`tray.ts / ipc/config.ts / utils/i18n.ts / shared/defaults/hotkeys.ts / shared/defaults/settings.ts / shared/types/hotkey.ts / shared/types/settings.ts / src/stores/settings.ts / src/core/hotkey/registry.ts / src/settings/categories/externalLyric.ts / src/settings/virtualBindings.ts / src/components/settings/custom/FontConfig.vue`）：删 `dynamicIsland` 分支

### 5.2 MCP（`patches/disable-mcp.patch`）

补丁覆盖的文件（工作区删除/短路，git 不提交）：

```
electron/main/services/mcp/   # cache.ts endpoint.ts http.ts injector.ts onlineSearch.ts server.ts
electron/main/ipc/mcp.ts
src/components/settings/custom/McpConfigDialog.vue
src/components/settings/custom/McpStatusCard.vue
```

同一补丁内顺带改的行：

- `electron/main/core/index.ts`：短路 `startMcpServer / stopMcpServer` 调用 + import
- `electron/main/ipc/index.ts`：短路 `registerMcpIpc`
- `electron/preload/index.ts` + `index.d.ts`：删 `mcp`
- `shared/types/settings.ts` + `shared/defaults/settings.ts`：短路 `mcp` 字段
- `src/settings/categories/aiIntegration.ts`：短路 `mcp` 段落
- `docs/.vitepress/config.ts`：短路 `mcp` 文档入口
- `package.json`：短路 `"@modelcontextprotocol/sdk"` 依赖（工作区改动，不提交 lockfile）

### 5.3 桌面壳（`patches/disable-desktop-chrome.patch`）

短路（工作区改动，git 不提交）：托盘、缩略图、任务栏歌词窗口创建、全局快捷键注册、`system:*` 中的展示文件/打开日志/重启/开发者工具、自更新、协议冷启动与外部文件拖拽。对应设置入口一并藏掉。

### 5.4 本地扫描暂缓（`patches/disable-local-scan.patch`）

短路扫描入口 + `library` 扫描 IPC + 扫描按钮/目录设置。数据库表结构不动，以后适配 MediaStore/SAF 时删掉本补丁即恢复。

### 5.5 系统内录（`patches/disable-loopback-capture.patch`）

只短路内录一路，保留麦克风识曲：`recognition/session.ts` 中走内录会话的分支短路，`recognition:submitPcm`（麦克风 PCM）保留。

### 5.6 补丁维护

构建前先检查再打上：`git apply --check patches/*.patch`，通过后 `git apply patches/*.patch`。改补丁内容时先 `git apply -R` 撤下，改完再导出。上游改了被补丁覆盖的行时 `apply` 会报失败，在 `merge-upstream-xxx` 分支上修好后重新导出补丁即可。

## 6. Git 工作流（含合并分支）

分支定死 3 类：

```
upstream/dev           ← 只读，git fetch 更新
merge-upstream-xxx    ← 炮灰分支，专门解决冲突
android               ← 平时开发分支，只合验证过的 merge 分支
```

补丁文件（`patches/*.patch`）单独提交，和功能代码混在一起也没关系，合上游时工作区先 `git stash` 或保持干净即可。

每次同步（建议 2 周一次，alpha 阶段别天天追）：

```bash
git fetch upstream
git checkout -b merge-upstream-0906 android
git merge upstream/dev
# 工作区是干净的，一般直接合上；有冲突也只在业务代码处，手动合
# 合完验证补丁还能打上：
git apply --check patches/*.patch && git apply patches/*.patch
pnpm typecheck && pnpm build
# 验证完把补丁打上的工作区改动还原（补丁只在构建时打，不提交）：
git restore . && git clean -fd
git checkout android
git merge merge-upstream-0906
git branch -d merge-upstream-0906
```

建议：`git config rerere.enabled true`，同类冲突解一次自动记住。`merge-xxx` 炸了直接删了重开，不影响 `android`。

### Fork 侧一次性改动：关掉桌面构建工作流（非补丁）

补丁管不了 CI（runner 读的是仓库里的 workflow 文件，`git apply` 之前就定了），所以这一步在 fork 上直接提交，一次到位：

- 删 `.github/workflows/dev.yml`、`release.yml`（win/mac/linux 矩阵构建，最烧分钟数）
- `docs.yml` 可留可删（只和文档站有关）
- 保留 `ci.yml`（lint/typecheck）+ `test.yml`（单测），安卓照样用得上
- 以后合上游时这两个文件报冲突，一律保持删除
- 懒得提交也行：在 fork 的 Settings → Actions 里把对应 workflow Disable 掉，效果一样且合并不受影响

---

## 7. 构建与验证

```bash
# Web 产物（复用上游）
pnpm build              # electron-vite build → dist/（Android 只取 renderer 产物，主进程/.node 不用编）
# Android
# Android 构建见 android/ 目录
# capacitor sync + cargo-ndk
pnpm typecheck           # node + web 双通道必须过
```

分两阶段：

- P1 跑通（先做，不做任何性能优化，默认参数出声就行）：空壳 + `window.api` shim 能进首页 → 调网易 API 播 128k mp3 → 接 SQLite + 登录态 → Rust 引擎出声（EQ/变速/FFT 默认值）。
- P2 优化（跑通后再做）：位置推送可调间隔、FFT 降频+截断、背景模糊重写/降级、低端机档位。具体方案见讨论记录，动手前再细化。

---

## 8. 约定

1. 除 §5 补丁清单外，不直接改 `src/ electron/ shared/`，要改就提上游 PR（如 `getAppCacheDir()/getPlatform()` 抽象）。
2. 新增代码只进 `android/ platform/android/`。
3. 许可证 `AGPL-3.0`：发包必须开源对应分支。
4. 上游伪装的是 `Android15` UA（见 `kugou/core/device.ts`），协议层优先复用，不重造轮子。
5. `AGENTS.md` / `CLAUDE.md` / 本文档为 fork 所有，合上游时一律保留我方版本。
