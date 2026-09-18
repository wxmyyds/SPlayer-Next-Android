/**
 * 编码原语：TextEncoder / TextDecoder（仅 UTF-8）/ atob / btoa
 *
 * 与规范对齐的最小实现：decoder 对非法字节按 WHATWG 规则替换 U+FFFD，
 * 不支持的 label 抛 RangeError（vendor 只用 utf-8）。
 */

/** UTF-8 编码 */
class TextEncoderImpl {
  /**
   * 编码为 UTF-8 字节
   * @param input - 源字符串
   * @returns UTF-8 字节
   */
  encode(input = ""): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const cp = input.codePointAt(i) as number;
      if (cp > 0xffff) i++; // 代理对占两个 code unit
      if (cp <= 0x7f) out.push(cp);
      else if (cp <= 0x7ff) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      else if (cp <= 0xffff)
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      else
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
    }
    return Uint8Array.from(out);
  }

  /**
   * 编码到目标缓冲
   * @param source - 源字符串
   * @param destination - 目标缓冲
   * @returns 写入的字节数
   */
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
    const bytes = this.encode(source);
    const written = Math.min(bytes.length, destination.length);
    destination.set(bytes.subarray(0, written));
    return { read: source.length, written };
  }

  readonly encoding = "utf-8";
}

/** 解码标签归一化表（仅 UTF-8 家族） */
const UTF8_LABELS = new Set(["utf-8", "utf8", "unicode-1-1-utf-8"]);

/** UTF-8 解码：非法序列按规范替换为 U+FFFD */
class TextDecoderImpl {
  private label: string;

  /**
   * @param label - 编码标签，仅支持 UTF-8 家族
   */
  constructor(label = "utf-8") {
    const normalized = String(label).trim().toLowerCase();
    if (!UTF8_LABELS.has(normalized)) {
      throw new RangeError(`unsupported decoding label: ${label}`);
    }
    this.label = "utf-8";
  }

  readonly encoding = "utf-8";

  /**
   * 解码 UTF-8 字节，非法字节替换 U+FFFD
   * @param input - 源字节
   * @returns 解码字符串
   */
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return "";
    const bytes =
      input instanceof Uint8Array ? input : new Uint8Array((input as ArrayBuffer).slice(0));
    let out = "";
    let i = 0;
    while (i < bytes.length) {
      const b0 = bytes[i];
      let cp = -1;
      let need = 0;
      if (b0 < 0x80) {
        cp = b0;
      } else if (b0 >= 0xc2 && b0 <= 0xdf) {
        cp = b0 & 0x1f;
        need = 1;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        cp = b0 & 0x0f;
        need = 2;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        cp = b0 & 0x07;
        need = 3;
      }
      if (need === 0) {
        if (b0 >= 0x80) out += "\ufffd";
        else out += String.fromCharCode(b0);
        i++;
        continue;
      }
      let ok = i + need < bytes.length;
      for (let j = 1; j <= need && ok; j++) {
        const bj = bytes[i + j];
        if ((bj & 0xc0) !== 0x80) ok = false;
        else cp = (cp << 6) | (bj & 0x3f);
      }
      // 过长编码 / 代理区 / 越界均按规范拒绝
      if (
        ok &&
        !(
          (need === 2 && cp < 0x800) ||
          (need === 3 && cp < 0x10000) ||
          (cp >= 0xd800 && cp <= 0xdfff) ||
          cp > 0x10ffff
        )
      ) {
        out += String.fromCodePoint(cp);
        i += need + 1;
      } else {
        out += "\ufffd";
        i++;
      }
    }
    return out;
  }
}

/** base64 表 */
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 字节串转 base64（latin1 语义，超 0xff 抛错，与 atob/btoa 对齐）
 * @param s - 每字符码点 ≤ 0xff 的字符串
 * @returns base64 串
 */
const btoaImpl = (s: string): string => {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const b0 = s.charCodeAt(i);
    const b1 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < s.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < s.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
};

/**
 * base64 转字节串（忽略空白，非法字符抛错）
 * @param s - base64 串
 * @returns latin1 字符串
 */
const atobImpl = (s: string): string => {
  const clean = s.replace(/[\t\n\f\r ]/g, "");
  const cleanLen = clean.length;
  if (cleanLen % 4 !== 0) throw new Error("invalid base64 length");
  let out = "";
  let bits = 0;
  let acc = 0;
  let padded = false;
  for (let i = 0; i < cleanLen; i++) {
    const ch = clean[i];
    if (ch === "=") {
      if (i < cleanLen - 2) throw new Error("invalid base64 padding");
      padded = true;
      bits -= 2;
      continue;
    }
    if (padded) throw new Error("invalid base64 padding");
    const idx = B64_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base64 char: ${ch}`);
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
};

/**
 * 安装编码原语到全局
 */
export const installEncoding = (): void => {
  Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoderImpl, writable: true });
  Object.defineProperty(globalThis, "TextDecoder", { value: TextDecoderImpl, writable: true });
  Object.defineProperty(globalThis, "atob", { value: atobImpl, writable: true });
  Object.defineProperty(globalThis, "btoa", { value: btoaImpl, writable: true });
};
