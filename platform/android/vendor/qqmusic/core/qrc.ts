/**
 * QRC 解密 + 解压（Android 版）
 *
 * 上游 dev 用 zlib 的 inflate/inflateRaw/unzip + 自研 Triple DES；
 * Android vendor 用 Web 原语 DecompressionStream 三格式兜底，
 * Triple DES 在 tripledes.ts 纯 JS 移植（无 node 依赖）。
 */

import { hexDecode, inflateAuto } from "@android/vendor/shim/webcrypto";
import { qrcDecrypt } from "./tripledes";

/** QRC 解密密钥 - 24 字节（来源：LDDC 项目） */
const QRC_KEY = new TextEncoder().encode("!@#)(*$%123ZXC!@!@#)(NHL");

/**
 * 解密 QRC 歌词（云端版本）
 * @param encryptedQrc - 十六进制编码的加密歌词字符串
 * @returns 解密后的歌词文本
 */
export const decryptQrc = async (encryptedQrc: string): Promise<string> => {
  if (!encryptedQrc || encryptedQrc.trim() === "") {
    throw new Error("没有可解密的数据");
  }

  const encryptedData = hexDecode(encryptedQrc);

  // Triple DES 解密
  const decrypted = qrcDecrypt(encryptedData, QRC_KEY);

  // Zlib 解压：依次尝试 deflate / raw / gzip（DecompressionStream）
  try {
    const out = await inflateAuto(decrypted);
    return new TextDecoder("utf-8").decode(out);
  } catch {
    // 也可能本身就不是压缩数据
    const str = new TextDecoder("utf-8").decode(decrypted);
    if (str.includes("[") || str.includes("<")) return str;
    throw new Error("无法解压数据");
  }
};
