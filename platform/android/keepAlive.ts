import { isAndroid } from "@/utils/platform";

/**
 * 锁屏 JS 保活（Chromium audible 豁免）：
 * 音频由原生 ExoPlayer 输出，WebView 锁屏后变为无声页面，Chromium 会对不可见 +
 * 无声页面升级节流直至冻结 renderer，JS 停摆后切歌链路（补窗请求/ended 链）即断。
 * Chromium 对 audible（正在播放音频的）页面豁免冻结与 intensive throttling，
 * 常驻一个极低音量的音频流即可让页面保持 audible 标记。
 * 注意：内容振幅必须高于 Chromium 静音检测阈值（约 -60 dBFS），否则整条流被判为
 * 静音、audible 豁免失效；实际不可闻靠 audio.volume 压制而非内容静音。
 */
let keepAliveAudio: HTMLAudioElement | null = null;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** 0.25s 8kHz 16bit 单声道 220Hz 正弦 WAV（峰值 -12 dBFS，远超静音检测阈值） */
const KEEPALIVE_WAV_DATA_URI =
  "data:audio/wav;base64," +
  "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";

/**
 * 启动保活音频（仅 Android；已启动时为空操作）
 */
export const startSilentKeepAlive = (): void => {
  if (!isAndroid || keepAliveAudio) return;
  try {
    const audio = new Audio(KEEPALIVE_WAV_DATA_URI);
    audio.loop = true;
    audio.volume = 0.01;
    audio
      .play()
      .then(() => {
        console.info("[keepAlive] audible stream started");
        // 心跳：锁屏抓取 logcat 时以此判定 JS 死活（有 tick 即未冻结）
        keepAliveTimer = setInterval(() => console.info("[keepAlive] alive"), 30_000);
      })
      .catch((err) => {
        console.warn("[keepAlive] play rejected:", err);
      });
    keepAliveAudio = audio;
  } catch (err) {
    console.warn("[keepAlive] create failed:", err);
  }
};

/**
 * 停止并释放保活音频
 */
export const stopSilentKeepAlive = (): void => {
  if (!keepAliveAudio) return;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  keepAliveAudio.pause();
  keepAliveAudio.src = "";
  keepAliveAudio = null;
};
