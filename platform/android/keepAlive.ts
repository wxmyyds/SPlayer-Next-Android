import { isAndroid } from "@/utils/platform";

/**
 * 锁屏 JS 保活（Chromium audible 豁免）：
 * 音频由原生 ExoPlayer 输出，WebView 锁屏后变为无声页面，Chromium 会对不可见 +
 * 无声页面升级节流直至冻结 renderer，JS 停摆后切歌链路（补窗请求/ended 链）即断。
 * Chromium 对 audible（正在播放音频的）页面豁免冻结与 intensive throttling，
 * 常驻一个极低音量的静音音频流即可让页面保持 audible 标记。
 */
let keepAliveAudio: HTMLAudioElement | null = null;

/** 0.25s 8kHz 16bit 单声道近静音 WAV（振幅 1 LSB，不可闻但保持音频流活跃） */
const SILENT_WAV_DATA_URI =
  "UklGRsQPAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAPAAABAAEAAQABAP//////////AQABAAEAAQD/////////" +
  "/wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//" +
  "////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQAB" +
  "AAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////" +
  "AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////" +
  "//////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEA" +
  "AQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8B" +
  "AAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/////" +
  "/////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQAB" +
  "AP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEA" +
  "AQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////" +
  "////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA" +
  "//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQAB" +
  "AAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////////" +
  "//8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/" +
  "/////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEA" +
  "AQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/////////" +
  "/wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//" +
  "////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQAB" +
  "AAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////" +
  "AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////" +
  "//////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEA" +
  "AQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8B" +
  "AAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/////" +
  "/////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQAB" +
  "AP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEA" +
  "AQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////" +
  "////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA" +
  "//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQAB" +
  "AAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////////" +
  "//8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/" +
  "/////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEA" +
  "AQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/////////" +
  "/wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//" +
  "////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQAB" +
  "AAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////" +
  "AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////" +
  "//////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEA" +
  "AQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8B" +
  "AAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/////" +
  "/////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQAB" +
  "AP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEA" +
  "AQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////" +
  "////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA" +
  "//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQAB" +
  "AAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////////" +
  "//8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/" +
  "/////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEA" +
  "AQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD/////////" +
  "/wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//" +
  "////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQAB" +
  "AAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////" +
  "AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA////" +
  "//////8BAAEAAQABAP//////////AQABAAEAAQD//////////wEAAQABAAEA//////////8BAAEAAQABAP//////////";

/**
 * 启动静音保活音频（仅 Android；已启动时为空操作）
 */
export const startSilentKeepAlive = (): void => {
  if (!isAndroid || keepAliveAudio) return;
  try {
    const audio = new Audio(SILENT_WAV_DATA_URI);
    audio.loop = true;
    audio.volume = 0.01;
    audio.play().catch(() => {
      // 自动播放被拒（理论上 Capacitor 已关手势要求）时静默放弃，不影响主链路
    });
    keepAliveAudio = audio;
  } catch {
    // 忽略创建失败
  }
};

/**
 * 停止并释放保活音频
 */
export const stopSilentKeepAlive = (): void => {
  if (!keepAliveAudio) return;
  keepAliveAudio.pause();
  keepAliveAudio.src = "";
  keepAliveAudio = null;
};
