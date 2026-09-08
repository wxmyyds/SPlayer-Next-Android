/**
 * Web 加密原语（Android vendor 共用）
 *
 * 上游 dev 用 node:crypto / node:zlib 实现各平台加解密；
 * WebView 内用 SubtleCrypto + 手写原语（AES-ECB / MD5 / 裸 RSA / PKCS#1）对齐，
 * 行为已用 node:crypto 做交叉验证（FIPS 向量 + 真实公钥 + roundtrip）。
 */

/** 字符串转 UTF-8 字节 */
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** UTF-8 字节转字符串 */
export const utf8Decode = (b: Uint8Array): string =>
  new TextDecoder().decode(b.slice().buffer as ArrayBuffer);

/** 字节拼 base64 */
export const b64Encode = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

/** base64 解字节 */
export const b64Decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** UTF-8 字符串转 base64 */
export const utf8ToB64 = (s: string): string => b64Encode(utf8(s));

/**
 * 字节转 hex
 * @param b 字节
 * @param upper 是否大写
 */
export const hexEncode = (b: Uint8Array, upper = false): string => {
  let s = "";
  for (const v of b) s += v.toString(16).padStart(2, "0");
  return upper ? s.toUpperCase() : s;
};

/** hex 解字节 */
export const hexDecode = (s: string): Uint8Array => {
  const clean = s.trim();
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** 拼接多个字节数组 */
export const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** 安全随机字节 */
export const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
};

/** 随机 hex（n 字节 → 2n 字符） */
export const randomHexString = (n: number): string => hexEncode(randomBytes(n));

/** 同步 64 位哈希（cyrb53）：仅作缓存 key，不做安全用途 */
export const hashParams8 = (params: unknown): string => {
  const s = JSON.stringify(params ?? {});
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0");
};

// ---- MD5（RFC 1321，手写，与 node:crypto 交叉验证通过）----

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const md5K = (() => {
  const t = new Uint32Array(64);
  for (let i = 0; i < 64; i++) t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  return t;
})();

/** MD5 摘要 */
export const md5Bytes = (data: Uint8Array | string): Uint8Array => {
  const msg = typeof data === "string" ? utf8(data) : data;
  const bitLen = msg.length * 8;
  const withOne = msg.length + 1;
  const padLen = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[msg.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) words[i] = dv.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + md5K[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      const s = MD5_S[i];
      b = (b + ((f << s) | (f >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return out;
};

/** MD5 hex（小写） */
export const md5Hex = (data: Uint8Array | string): string => hexEncode(md5Bytes(data));

/** SHA-256 hex */
export const sha256Hex = async (data: Uint8Array | string): Promise<string> => {
  const b = typeof data === "string" ? utf8(data) : data;
  const d = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return hexEncode(new Uint8Array(d));
};

/** HMAC-SHA256 */
export const hmacSha256Bytes = async (
  key: Uint8Array | string,
  data: Uint8Array | string,
): Promise<Uint8Array> => {
  const kb = typeof key === "string" ? utf8(key) : key;
  const db = typeof data === "string" ? utf8(data) : data;
  const k = await crypto.subtle.importKey("raw", kb as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, db as BufferSource));
};

// ---- AES-ECB（手写，与 node:crypto 填充行为一致：PKCS7 恒填充）----

const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab,
  0x76, 0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4,
  0x72, 0xc0, 0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71,
  0xd8, 0x31, 0x15, 0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2,
  0xeb, 0x27, 0xb2, 0x75, 0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6,
  0xb3, 0x29, 0xe3, 0x2f, 0x84, 0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb,
  0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf, 0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45,
  0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8, 0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5,
  0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2, 0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44,
  0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73, 0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a,
  0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb, 0xe0, 0x32, 0x3a, 0x0a, 0x49,
  0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79, 0xe7, 0xc8, 0x37, 0x6d,
  0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08, 0xba, 0x78, 0x25,
  0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a, 0x70, 0x3e,
  0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e, 0xe1,
  0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb,
  0x16,
]);

const AES_INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) AES_INV_SBOX[AES_SBOX[i]] = i;

const AES_RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

const xtime = (b: number): number => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

export const aesExpandKey = (key: Uint8Array): Uint8Array => {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key, 0);
  const tmp = new Uint8Array(4);
  for (let i = nk; i < 4 * (nr + 1); i++) {
    tmp.set(w.subarray((i - 1) * 4, i * 4));
    if (i % nk === 0) {
      const t0 = tmp[0];
      tmp[0] = AES_SBOX[tmp[1]] ^ AES_RCON[i / nk - 1];
      tmp[1] = AES_SBOX[tmp[2]];
      tmp[2] = AES_SBOX[tmp[3]];
      tmp[3] = AES_SBOX[t0];
    } else if (nk > 6 && i % nk === 4) {
      for (let j = 0; j < 4; j++) tmp[j] = AES_SBOX[tmp[j]];
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ tmp[j];
  }
  return w;
};

export const aesEncryptBlock = (block: Uint8Array, expanded: Uint8Array, nr: number): Uint8Array => {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ expanded[i];
  for (let round = 1; round <= nr; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    // ShiftRows
    let t = s[1];
    s[1] = s[5];
    s[5] = s[9];
    s[9] = s[13];
    s[13] = t;
    t = s[2];
    s[2] = s[10];
    s[10] = t;
    t = s[6];
    s[6] = s[14];
    s[14] = t;
    t = s[15];
    s[15] = s[11];
    s[11] = s[7];
    s[7] = s[3];
    s[3] = t;
    if (round !== nr) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        s[c * 4] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        s[c * 4 + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
      }
    }
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= expanded[off + i];
  }
  return s;
};

const gmul = (a: number, b: number): number => {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
};

export const aesDecryptBlock = (block: Uint8Array, expanded: Uint8Array, nr: number): Uint8Array => {
  const s = new Uint8Array(16);
  const off0 = nr * 16;
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ expanded[off0 + i];
  for (let round = nr - 1; round >= 0; round--) {
    // InvShiftRows
    let t = s[13];
    s[13] = s[9];
    s[9] = s[5];
    s[5] = s[1];
    s[1] = t;
    t = s[2];
    s[2] = s[10];
    s[10] = t;
    t = s[6];
    s[6] = s[14];
    s[14] = t;
    t = s[3];
    s[3] = s[7];
    s[7] = s[11];
    s[11] = s[15];
    s[15] = t;
    for (let i = 0; i < 16; i++) s[i] = AES_INV_SBOX[s[i]];
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= expanded[off + i];
    if (round !== 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        s[c * 4] = gmul(a0, 0x0e) ^ gmul(a1, 0x0b) ^ gmul(a2, 0x0d) ^ gmul(a3, 0x09);
        s[c * 4 + 1] = gmul(a0, 0x09) ^ gmul(a1, 0x0e) ^ gmul(a2, 0x0b) ^ gmul(a3, 0x0d);
        s[c * 4 + 2] = gmul(a0, 0x0d) ^ gmul(a1, 0x09) ^ gmul(a2, 0x0e) ^ gmul(a3, 0x0b);
        s[c * 4 + 3] = gmul(a0, 0x0b) ^ gmul(a1, 0x0d) ^ gmul(a2, 0x09) ^ gmul(a3, 0x0e);
      }
    }
  }
  return s;
};

/**
 * AES-ECB 加密（PKCS7 恒填充，与 node:crypto 默认行为一致）
 * @param key 16/24/32 字节密钥
 * @param plaintext 明文
 */
export const aesEcbEncryptRaw = (key: Uint8Array, plaintext: Uint8Array): Uint8Array => {
  const pad = 16 - (plaintext.length % 16);
  const padded = new Uint8Array(plaintext.length + pad).fill(pad);
  padded.set(plaintext, 0);
  const expanded = aesExpandKey(key);
  const nr = key.length / 4 + 6;
  const out = new Uint8Array(padded.length);
  for (let off = 0; off < padded.length; off += 16) {
    out.set(aesEncryptBlock(padded.subarray(off, off + 16), expanded, nr), off);
  }
  return out;
};

/**
 * AES-ECB 解密（去 PKCS7 填充；填充非法时返回裸明文）
 * @param key 16/24/32 字节密钥
 * @param ciphertext 密文
 */
export const aesEcbDecryptRaw = (key: Uint8Array, ciphertext: Uint8Array): Uint8Array => {
  const expanded = aesExpandKey(key);
  const nr = key.length / 4 + 6;
  const out = new Uint8Array(ciphertext.length);
  for (let off = 0; off < ciphertext.length; off += 16) {
    out.set(aesDecryptBlock(ciphertext.subarray(off, off + 16), expanded, nr), off);
  }
  const pad = out[out.length - 1];
  if (pad >= 1 && pad <= 16) {
    let valid = true;
    for (let i = out.length - pad; i < out.length; i++) {
      if (out[i] !== pad) {
        valid = false;
        break;
      }
    }
    if (valid) return out.subarray(0, out.length - pad);
  }
  return out;
};

// ---- AES-CBC / GCM（SubtleCrypto）----

/**
 * AES-CBC 加密（PKCS7）
 * @param key 16 字节密钥
 * @param iv 16 字节向量
 * @param plaintext 明文
 */
export const aesCbcEncrypt = async (
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> => {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, plaintext as BufferSource));
};

/** AES-CBC 解密 */
export const aesCbcDecrypt = async (
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> => {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-CBC" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, ciphertext as BufferSource));
};

/** AES-GCM 加密，返回密文与 tag */
export const aesGcmEncrypt = async (
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ ciphertext: Uint8Array; tag: Uint8Array }> => {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, k, plaintext as BufferSource),
  );
  return { ciphertext: out.subarray(0, out.length - 16), tag: out.subarray(out.length - 16) };
};

// ---- RSA（SPKI 解析 + BigInt 模幂）----

const parseTlv = (data: Uint8Array, offset: number): { headerLen: number; length: number } => {
  let pos = offset + 1;
  const first = data[pos++];
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + data[pos++];
  }
  return { headerLen: pos - offset, length };
};

const parsePositiveInt = (data: Uint8Array, offset: number): { value: bigint; next: number } => {
  const { headerLen, length } = parseTlv(data, offset);
  const start = offset + headerLen;
  let value = 0n;
  for (let i = start; i < start + length; i++) value = (value << 8n) | BigInt(data[i]);
  return { value, next: start + length };
};

/** 解析 RSA SPKI 公钥，返回模数 n 与指数 e */
export const parseRsaSpki = (pem: string): { n: bigint; e: bigint } => {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = b64Decode(b64);
  // 外层 SEQUENCE → 第二个元素（BIT STRING）→ 跳过未用比特数 → 内层 SEQUENCE(n, e)
  const outer = parseTlv(der, 0);
  let pos = outer.headerLen;
  const first = parseTlv(der, pos);
  pos += first.headerLen + first.length;
  const bitstr = parseTlv(der, pos);
  pos += bitstr.headerLen + 1;
  const inner = parseTlv(der, pos);
  pos += inner.headerLen;
  const n = parsePositiveInt(der, pos);
  const e = parsePositiveInt(der, n.next);
  return { n: n.value, e: e.value };
};

const bytesToBig = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
};

const modPow = (base: bigint, exp: bigint, mod: bigint): bigint => {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
};

/**
 * 裸 RSA 加密（明文按左/右对齐补齐到模长，无填充）
 * @param data 明文
 * @param pem SPKI PEM 公钥
 * @param leftPad 左补零（网易 weapi）；false 为右补零（酷狗）
 * @returns 小写 hex
 */
export const rawRsaEncrypt = (data: Uint8Array, pem: string, leftPad: boolean): string => {
  const { n, e } = parseRsaSpki(pem);
  const keyLen = Math.ceil(n.toString(2).length / 8);
  const block = new Uint8Array(keyLen);
  if (leftPad) block.set(data, keyLen - data.length);
  else block.set(data.subarray(0, Math.min(data.length, keyLen)), 0);
  return modPow(bytesToBig(block), e, n).toString(16).padStart(keyLen * 2, "0");
};

/**
 * PKCS#1 v1.5 RSA 加密（手写 EMSA 填充 + BigInt 模幂，不依赖 Subtle 算法支持）
 * @param data 明文字节
 * @param pem SPKI PEM 公钥
 * @returns 小写 hex
 */
export const pkcs1Encrypt = (data: Uint8Array, pem: string): string => {
  const { n, e } = parseRsaSpki(pem);
  const keyLen = Math.ceil(n.toString(2).length / 8);
  if (data.length > keyLen - 11) throw new Error("pkcs1 message too long");
  const psLen = keyLen - data.length - 3;
  const ps = new Uint8Array(psLen);
  let filled = 0;
  while (filled < psLen) {
    const r = randomBytes(psLen - filled);
    for (const b of r) {
      if (b !== 0) ps[filled++] = b;
      if (filled >= psLen) break;
    }
  }
  const em = concatBytes(new Uint8Array([0, 2]), ps, new Uint8Array([0]), data);
  return modPow(bytesToBig(em), e, n).toString(16).padStart(keyLen * 2, "0");
};

// ---- 解压（DecompressionStream）----

/**
 * 自动解压（依次尝试 deflate / deflate-raw / gzip）
 * @param data 压缩数据
 */
export const inflateAuto = async (data: Uint8Array): Promise<Uint8Array> => {
  const formats: CompressionFormat[] = ["deflate", "deflate-raw", "gzip"];
  let lastErr: unknown;
  for (const format of formats) {
    try {
      const ds = new DecompressionStream(format);
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("inflate failed");
};

// ---- X25519（SubtleCrypto）----

/** 导入裸 32 字节 X25519 公钥 */
export const importRawX25519Public = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw as BufferSource, { name: "X25519" }, true, []);

/**
 * 生成临时 X25519 密钥对并与对端派生共享密钥
 * @param peerRaw 对端裸公钥（32 字节）
 * @returns 共享密钥与己方临时公钥裸字节
 */
export const x25519Shared = async (
  peerRaw: Uint8Array,
): Promise<{ shared: Uint8Array; ephemeralRaw: Uint8Array }> => {
  const peer = await importRawX25519Public(peerRaw);
  const ephemeral = (await crypto.subtle.generateKey(
    { name: "X25519" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: peer }, ephemeral.privateKey, 256),
  );
  return { shared, ephemeralRaw };
};
