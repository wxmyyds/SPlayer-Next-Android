/**
 * Netease API 加解密层（Android 版）
 *
 * 加密方式与上游 dev 完全一致：
 * weapi（双层 AES-CBC + 裸 RSA）/ linuxapi（AES-ECB）/
 * eapi（MD5 签名 + AES-ECB）/ xeapi（AES-ECB + X25519/GCM 反爬）。
 * 只是把 node:crypto / node:zlib 换成 shim/webcrypto 的 Web 原语。
 */

import {
  aesCbcEncrypt,
  aesEcbDecryptRaw,
  aesEcbEncryptRaw,
  aesGcmEncrypt,
  b64Decode,
  b64Encode,
  hexDecode,
  hexEncode,
  hmacSha256Bytes,
  inflateAuto,
  md5Hex,
  randomBytes,
  rawRsaEncrypt,
  utf8,
  utf8Decode,
  utf8ToB64,
  x25519Shared,
} from "../../shim/webcrypto";
import { BASE62, EAPI_KEY, IV, LINUX_API_KEY, PRESET_KEY, PUBLIC_KEY } from "./config";

/**
 * AES 加密
 * @param text 明文
 * @param mode 加密模式
 * @param key 密钥
 * @param iv 初始化向量
 * @param format 输出格式
 * @returns 加密后的文本
 */
export const aesEncrypt = async (
  text: string | Uint8Array,
  mode: "cbc" | "ecb",
  key: string,
  iv: string,
  format: "base64" | "hex" = "base64",
): Promise<string> => {
  const plain = typeof text === "string" ? utf8(text) : text;
  const encrypted =
    mode === "cbc"
      ? await aesCbcEncrypt(utf8(key), utf8(iv), plain)
      : aesEcbEncryptRaw(utf8(key), plain);
  return format === "base64" ? b64Encode(encrypted) : hexEncode(encrypted, true);
};

/**
 * AES 解密（ECB）
 * @param ciphertext 密文
 * @param key 密钥
 * @param format 输入格式
 * @returns 解密后的字节
 */
export const aesDecrypt = (ciphertext: string, key: string, format: "base64" | "hex" = "base64"): Uint8Array => {
  const input = format === "base64" ? b64Decode(ciphertext) : hexDecode(ciphertext);
  return aesEcbDecryptRaw(utf8(key), input);
};

/**
 * RSA 加密（裸 RSA：明文左补 0 到模长后模幂，输出 hex）
 * @param str 明文
 * @param publicKey 公钥
 */
export const rsaEncrypt = (str: string, publicKey: string = PUBLIC_KEY): string =>
  rawRsaEncrypt(utf8(str), publicKey, true);

/**
 * weapi 加密
 * 1) 生成 16 字节随机 base62 secretKey
 * 2) 明文经 AES-CBC(PRESET_KEY) 加密一次，再用 secretKey 再加密一次
 * 3) secretKey 倒序后用 RSA 加密为 encSecKey
 * @param object 业务参数
 * @returns 加密后的参数
 */
export const weapi = async (object: unknown): Promise<{ params: string; encSecKey: string }> => {
  const text = JSON.stringify(object);
  const rand = randomBytes(16);
  let secretKey = "";
  for (let i = 0; i < 16; i++) secretKey += BASE62.charAt(rand[i] % 62);
  const first = await aesEncrypt(text, "cbc", PRESET_KEY, IV);
  const params = await aesEncrypt(first, "cbc", secretKey, IV);
  const encSecKey = rsaEncrypt(secretKey.split("").reverse().join(""));
  return { params, encSecKey };
};

/**
 * linuxapi 加密
 * @param object 业务参数
 * @returns 加密后的参数
 */
export const linuxapi = (object: unknown): { eparams: string } => {
  const text = JSON.stringify(object);
  return { eparams: hexEncode(aesEcbEncryptRaw(utf8(LINUX_API_KEY), utf8(text)), true) };
};

/**
 * eapi 加密
 * 1) 用 url + 明文 + 固定盐拼接后 MD5 作为签名 digest
 * 2) 整串 `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}` 经 AES-ECB(hex) 加密
 * @param url 接口路径
 * @param object 业务参数
 * @returns 加密后的参数
 */
export const eapi = (url: string, object: unknown): { params: string } => {
  const text = typeof object === "object" ? JSON.stringify(object) : String(object);
  const message = `nobody${url}use${text}md5forencrypt`;
  const digest = md5Hex(message);
  const data = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  return { params: hexEncode(aesEcbEncryptRaw(utf8(EAPI_KEY), utf8(data)), true) };
};

/**
 * eapi 响应解密
 * @param encryptedHex 加密后的文本
 * @param aeapi 是否是 gzip 压缩的
 * @returns 解密后的文本
 */
export const eapiResDecrypt = async (encryptedHex: string, aeapi = false): Promise<unknown> => {
  try {
    const decrypted = aesDecrypt(encryptedHex, EAPI_KEY, "hex");
    if (aeapi) {
      const decompressed = await inflateAuto(decrypted);
      return JSON.parse(utf8Decode(decompressed));
    }
    return JSON.parse(utf8Decode(decrypted));
  } catch {
    return null;
  }
};

/**
 * eapi 请求体解密
 * @param encryptedHex 加密后的文本
 * @returns 解密后的文本
 */
export const eapiReqDecrypt = (encryptedHex: string): { url: string; data: unknown } | null => {
  const text = utf8Decode(aesDecrypt(encryptedHex, EAPI_KEY, "hex"));
  const match = text.match(/(.*?)-36cd479b6b5-(.*?)-36cd479b6b5-(.*)/);
  if (!match) return null;
  return { url: match[1], data: JSON.parse(match[2]) };
};

// ---- xeapi（反爬加密）----

/** xeapi 固定对称密钥（AES-256-ECB） */
const XEAPI_STATIC_KEY = hexDecode(
  "ab1d5a430f6bb04a3f01e81ddd72bd916d5ce591248ac128714806d7f8fb1b84",
);
/** xeapi 签名密钥（HMAC-SHA256，按字符串原样作为 key，不解码） */
const XEAPI_SIGN_KEY =
  "mUHCwVNWJbunMqAHf5MImuirT6plvs6VSFW62MGHstFQxhBGdEoIhLItH3djc4+FB/OKty3+lL2rGeoFBpVe5g==";

/** xeapi 服务端公钥状态（反爬接口返回并缓存） */
export interface XeapiPublicKey {
  version: string;
  publicKey: string;
  sk?: string;
  [key: string]: unknown;
}

/** xeapi 加密可选参数 */
export interface XeapiOptions {
  publicKeyState: XeapiPublicKey;
  sessionId?: string;
  sessionKey?: string;
  os?: string;
  method?: string;
  contentType?: string;
}

/** 由 ECDH 共享密钥 + 临时公钥派生 16 字节 AES 密钥（HKDF 风格） */
const deriveX25519AesKey = async (
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): Promise<Uint8Array> => {
  const zero32 = new Uint8Array(32);
  const prk = await hmacSha256Bytes(zero32, sharedSecret.length ? sharedSecret : zero32);
  const msg = new Uint8Array(ephemeralPublicKey.length + 1);
  msg.set(ephemeralPublicKey, 0);
  msg[ephemeralPublicKey.length] = 1;
  return (await hmacSha256Bytes(prk, msg)).subarray(0, 16);
};

/** xeapi 反爬签名：HMAC-SHA256(signKey, timestamp+nonce) → base64 */
export const xeapiSign = async (timestamp: string | number, nonce: string): Promise<string> =>
  b64Encode(await hmacSha256Bytes(XEAPI_SIGN_KEY, String(timestamp) + nonce));

/** 中间层变换：随机 XOR → base64 → 随机旋转 */
const xeapiMidTransform = (ciphertext: Uint8Array): Uint8Array => {
  const random = randomBytes(16);
  const xored = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) xored[i] = ciphertext[i] ^ random[i & 0x0f];
  const b64 = utf8(b64Encode(xored));
  const rot = b64.length ? (random[0] & 0x0f) % b64.length : 0;
  const out = new Uint8Array(random.length + b64.length);
  out.set(random, 0);
  out.set(b64.subarray(rot), random.length);
  out.set(b64.subarray(0, rot), random.length + b64.length - rot);
  return out;
};

/** 用 X25519 ECDH + AES-GCM 封装动态密钥（S 字段） */
const xeapiEncryptS = async (
  dynamicKey: Uint8Array,
  publicKeyState: XeapiPublicKey,
  os: string,
): Promise<Uint8Array> => {
  const peerRaw = b64Decode(publicKeyState.publicKey);
  const { shared, ephemeralRaw } = await x25519Shared(peerRaw);
  const aesKey = await deriveX25519AesKey(shared, ephemeralRaw);
  const iv = randomBytes(12);
  const plaintext = utf8(
    `${b64Encode(dynamicKey)}|${os}|${publicKeyState.sk ? String(publicKeyState.sk) : ""}`,
  );
  const { ciphertext, tag } = await aesGcmEncrypt(aesKey, iv, plaintext);
  const out = new Uint8Array(ephemeralRaw.length + iv.length + ciphertext.length + tag.length);
  out.set(ephemeralRaw, 0);
  out.set(iv, ephemeralRaw.length);
  out.set(ciphertext, ephemeralRaw.length + iv.length);
  out.set(tag, ephemeralRaw.length + iv.length + ciphertext.length);
  return out;
};

/** 构造 xeapi 明文（JSON：body/queryString/...） */
const buildXeapiPlaintext = (
  uri: string,
  data: Record<string, unknown>,
  options: XeapiOptions,
): string => {
  const fields: Record<string, string> = {};
  const contentType = options.contentType || "application/x-www-form-urlencoded;charset=utf-8";
  if (contentType.split(";", 1)[0].toLowerCase() !== "application/x-www-form-urlencoded") {
    fields.contentType = contentType;
  }
  const method = (options.method || "POST").toUpperCase();
  if (method !== "POST") fields.method = method;
  const url = new URL(uri, "https://interface.music.163.com");
  if (url.search) fields.queryString = url.search.slice(1);
  if (data !== undefined && data !== null) {
    const bodyData = { ...data };
    delete bodyData.e_r;
    const body = new URLSearchParams(bodyData as Record<string, string>).toString();
    fields.body = utf8ToB64(body);
  }
  fields.queryString = fields.queryString ? `${fields.queryString}&e_r=true` : "e_r=true";
  return JSON.stringify(fields);
};

/** xeapi 加密：返回 B / S / R 三段 base64 */
export const xeapi = async (
  uri: string,
  data: Record<string, unknown>,
  options: XeapiOptions,
): Promise<{ B: string; S: string; R: string }> => {
  const { publicKeyState } = options;
  const activeSessionKey = options.sessionKey ? utf8(String(options.sessionKey)) : null;
  const activeSessionId = options.sessionId || "";
  const dynamicKey = activeSessionKey || randomBytes(16);
  const plaintext = utf8(buildXeapiPlaintext(uri, data, options));
  const inner = aesEcbEncryptRaw(XEAPI_STATIC_KEY, plaintext);
  const b = aesEcbEncryptRaw(dynamicKey, xeapiMidTransform(inner));
  const s = await xeapiEncryptS(dynamicKey, publicKeyState, options.os || "android");
  const r = aesEcbEncryptRaw(
    XEAPI_STATIC_KEY,
    utf8(`${String(publicKeyState.version)}|${activeSessionKey ? activeSessionId : ""}`),
  );
  return { B: b64Encode(b), S: b64Encode(s), R: b64Encode(r) };
};

/** xeapi 响应解密：AES-ECB(eapiKey) + 可选 gunzip + JSON */
export const xeapiResDecrypt = async (body: Uint8Array): Promise<unknown> => {
  const decrypted = aesEcbDecryptRaw(utf8(EAPI_KEY), body);
  const plaintext =
    decrypted[0] === 0x1f && decrypted[1] === 0x8b ? await inflateAuto(decrypted) : decrypted;
  return JSON.parse(utf8Decode(plaintext));
};

/** 解密反爬接口返回的公钥包 */
export const xeapiDecryptPublicKey = (encryptedData: string): XeapiPublicKey =>
  JSON.parse(utf8Decode(aesEcbDecryptRaw(XEAPI_STATIC_KEY, b64Decode(encryptedData))));
