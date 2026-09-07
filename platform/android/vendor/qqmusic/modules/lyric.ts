/**
 * 歌词（含 QRC 逐字 / 翻译 / 罗马音）
 * module: music.musichallSong.PlayLyricInfo / GetPlayLyricInfo
 *
 * 流程：请求 crypt=1 → 返回 hex 密文 → Triple DES + zlib 解压 → 原始 QRC/LRC 文本
 *
 * params:
 * - id        歌曲数字 ID（必填）
 * - name      歌曲名（用于服务端匹配，Base64 编码后发送）
 * - artist    歌手名
 * - album     专辑名
 * - duration  时长（秒）
 *
 * 上游 dev 位于 electron/main/apis/qqmusic/modules/lyric.ts，
 * Android vendor 把 Buffer.from(...).toString("base64") 换成 shim 的 utf8ToB64，
 * decryptQrc 改异步（DecompressionStream）。
 */

import { utf8ToB64 } from "@android/vendor/shim/webcrypto";
import { qmRequest } from "../core/request";
import { decryptQrc } from "../core/qrc";
import type { QMModule } from "../core/types";

interface LyricResponse {
  code: number;
  lrc?: string;
  qrc?: string;
  trans?: string;
  roma?: string;
  message?: string;
}

interface LyricResp {
  lyric?: string;
  qrc_t?: number;
  trans?: string;
  roma?: string;
}

const tryDecrypt = async (hex: string | undefined): Promise<string | undefined> => {
  if (!hex) return undefined;
  try {
    return await decryptQrc(hex);
  } catch {
    return undefined;
  }
};

const lyric: QMModule = async (params) => {
  const {
    id,
    name = "",
    artist = "",
    album = "",
    duration = 0,
  } = params as {
    id?: unknown;
    name?: unknown;
    artist?: unknown;
    album?: unknown;
    duration?: unknown;
  };

  const baseParam = {
    albumName: utf8ToB64(String(album ?? "")),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: duration,
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: utf8ToB64(String(artist ?? "")),
    songID: Number(id),
    songName: utf8ToB64(String(name ?? "")),
    trans: 1,
    trans_t: 0,
    type: 0,
  };

  try {
    const resp = await qmRequest<LyricResp>(
      "music.musichallSong.PlayLyricInfo",
      "GetPlayLyricInfo",
      baseParam,
    );

    const result: LyricResponse = { code: 200 };

    // 主歌词：按 qrc_t 判断服务端返回的是 QRC 还是 LRC
    const mainDecrypted = await tryDecrypt(resp.lyric);
    if (mainDecrypted) {
      if (resp.qrc_t === 0) {
        // 未开启 QRC，lyric 字段是 LRC
        result.lrc = mainDecrypted;
      } else {
        result.qrc = mainDecrypted;
      }
    }

    // 若只拿到 QRC，再单独请求一次 LRC 格式
    if (result.qrc && !result.lrc) {
      try {
        const lrcResp = await qmRequest<LyricResp>(
          "music.musichallSong.PlayLyricInfo",
          "GetPlayLyricInfo",
          { ...baseParam, qrc: 0, qrc_t: 0 },
        );
        const lrcText = await tryDecrypt(lrcResp.lyric);
        if (lrcText) result.lrc = lrcText;
      } catch {
        // 次级失败不影响主结果
      }
    }

    result.trans = await tryDecrypt(resp.trans);
    result.roma = await tryDecrypt(resp.roma);
    return result;
  } catch (err) {
    return {
      code: 500,
      message: err instanceof Error ? err.message : String(err),
    };
  }
};

export default lyric;
