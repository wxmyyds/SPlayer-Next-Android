/** 插件运行时同步加密垫片，兼容上游 node:crypto 常用接口。 */

import {
  aesDecryptBlock,
  aesEcbDecryptRaw,
  aesEcbEncryptRaw,
  aesEncryptBlock,
  aesExpandKey,
  concatBytes,
  hexDecode,
  hexEncode,
  md5Bytes,
  md5Hex,
  pkcs1Encrypt,
  randomBytes,
  rawRsaEncrypt,
  utf8,
} from "../vendor/shim/webcrypto";

const toBytes = (value: string | Uint8Array | ArrayBuffer | number[]): Uint8Array => {
  if (typeof value === "string") return utf8(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value, (item) => item & 0xff);
};

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

const sha1Bytes = (data: Uint8Array): Uint8Array => {
  const total = ((data.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = data.length * 8;
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(total - 4, bitLength >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const mixed = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (mixed << 1) | (mixed >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const output = new Uint8Array(20);
  const result = new DataView(output.buffer);
  result.setUint32(0, h0);
  result.setUint32(4, h1);
  result.setUint32(8, h2);
  result.setUint32(12, h3);
  result.setUint32(16, h4);
  return output;
};

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const sha256Bytes = (data: Uint8Array): Uint8Array => {
  const total = ((data.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = data.length * 8;
  view.setUint32(total - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(total - 4, bitLength >>> 0);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(words[i - 15], 7) ^ rotr(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotr(words[i - 2], 17) ^ rotr(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + SHA256_K[i] + words[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  const output = new Uint8Array(32);
  const result = new DataView(output.buffer);
  state.forEach((value, index) => result.setUint32(index * 4, value));
  return output;
};

const hashBytes = (algorithm: "md5" | "sha1" | "sha256", data: Uint8Array): Uint8Array => {
  if (algorithm === "md5") return md5Bytes(data);
  if (algorithm === "sha1") return sha1Bytes(data);
  return sha256Bytes(data);
};

export const hmacBytes = (
  algorithm: "md5" | "sha1" | "sha256",
  key: string | Uint8Array,
  data: string | Uint8Array,
): Uint8Array => {
  const blockSize = 64;
  let normalized = toBytes(key);
  if (normalized.length > blockSize) normalized = hashBytes(algorithm, normalized);
  const padded = new Uint8Array(blockSize);
  padded.set(normalized);
  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i] ^ 0x36;
    outer[i] = padded[i] ^ 0x5c;
  }
  return hashBytes(
    algorithm,
    concatBytes(outer, hashBytes(algorithm, concatBytes(inner, toBytes(data)))),
  );
};

const pad16 = (data: Uint8Array): Uint8Array => {
  const amount = 16 - (data.length % 16);
  const output = new Uint8Array(data.length + amount).fill(amount);
  output.set(data);
  return output;
};

const strip16 = (data: Uint8Array): Uint8Array => {
  if (data.length === 0) return data;
  const amount = data[data.length - 1];
  if (amount < 1 || amount > 16 || amount > data.length) return data;
  for (let i = data.length - amount; i < data.length; i++) {
    if (data[i] !== amount) return data;
  }
  return data.subarray(0, data.length - amount);
};

const xorBlock = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const output = new Uint8Array(16);
  for (let i = 0; i < 16; i++) output[i] = left[i] ^ right[i];
  return output;
};

const rounds = (key: Uint8Array): number => key.length / 4 + 6;

const aesCbcEncryptSync = (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array => {
  const expanded = aesExpandKey(key);
  const output = new Uint8Array(pad16(data).length);
  let previous: Uint8Array = iv.slice(0, 16);
  const padded = pad16(data);
  for (let offset = 0; offset < padded.length; offset += 16) {
    const encrypted = aesEncryptBlock(
      xorBlock(padded.subarray(offset, offset + 16), previous),
      expanded,
      rounds(key),
    );
    output.set(encrypted, offset);
    previous = encrypted;
  }
  return output;
};

const aesCbcDecryptSync = (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array => {
  if (data.length % 16 !== 0) throw new Error("invalid CBC data length");
  const expanded = aesExpandKey(key);
  const output = new Uint8Array(data.length);
  let previous: Uint8Array = iv.slice(0, 16);
  for (let offset = 0; offset < data.length; offset += 16) {
    const block = data.subarray(offset, offset + 16);
    output.set(xorBlock(aesDecryptBlock(block, expanded, rounds(key)), previous), offset);
    previous = block;
  }
  return strip16(output);
};

const aesCtrTransformSync = (key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array => {
  const expanded = aesExpandKey(key);
  const counter = new Uint8Array(16);
  counter.set(iv.subarray(0, 16));
  const output = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 16) {
    const stream = aesEncryptBlock(counter, expanded, rounds(key));
    const length = Math.min(16, data.length - offset);
    for (let i = 0; i < length; i++) output[offset + i] = data[offset + i] ^ stream[i];
    for (let i = 15; i >= 0; i--) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  }
  return output;
};

const cipherMode = (mode: string): "ecb" | "cbc" | "ctr" => {
  const match = /^aes-(?:128|192|256)-(ecb|cbc|ctr)$/i.exec(mode);
  if (!match)
    throw Object.assign(new Error(`unsupported cipher mode: ${mode}`), {
      code: "PLUGIN_CIPHER_MODE",
    });
  return match[1].toLowerCase() as "ecb" | "cbc" | "ctr";
};

export const aesEncryptNode = (
  data: string | Uint8Array,
  key: Uint8Array,
  mode: string,
  iv?: Uint8Array,
): Uint8Array => {
  const kind = cipherMode(mode);
  if (![16, 24, 32].includes(key.length)) throw new Error("invalid AES key length");
  if (kind === "ecb") return aesEcbEncryptRaw(key, toBytes(data));
  if (!iv || iv.length < 16) throw new Error("invalid AES IV");
  if (kind === "cbc") return aesCbcEncryptSync(key, iv, toBytes(data));
  return aesCtrTransformSync(key, iv, toBytes(data));
};

export const aesDecryptNode = (
  data: Uint8Array,
  key: Uint8Array,
  mode: string,
  iv?: Uint8Array,
): Uint8Array => {
  const kind = cipherMode(mode);
  if (![16, 24, 32].includes(key.length)) throw new Error("invalid AES key length");
  if (kind === "ecb") return aesEcbDecryptRaw(key, data);
  if (!iv || iv.length < 16) throw new Error("invalid AES IV");
  if (kind === "cbc") return aesCbcDecryptSync(key, iv, data);
  return aesCtrTransformSync(key, iv, data);
};

export const rsaEncryptPkcs1 = (data: Uint8Array, publicKey: string): Uint8Array =>
  hexDecode(pkcs1Encrypt(data, publicKey));

export const rsaEncryptNoPadding = (data: Uint8Array, publicKey: string): Uint8Array =>
  hexDecode(rawRsaEncrypt(data, publicKey, true));

export const pluginCrypto = {
  md5: (data: string | Uint8Array) => md5Hex(toBytes(data)),
  sha1: (data: string | Uint8Array) => hexEncode(sha1Bytes(toBytes(data))),
  sha256: (data: string | Uint8Array) => hexEncode(sha256Bytes(toBytes(data))),
  hmac: (algorithm: string, key: string | Uint8Array, data: string | Uint8Array) =>
    hexEncode(hmacBytes(algorithm.toLowerCase() as "md5" | "sha1" | "sha256", key, data)),
  randomBytes,
  aesEncrypt: aesEncryptNode,
  aesDecrypt: aesDecryptNode,
  rsaEncrypt: rsaEncryptPkcs1,
};

export { hexDecode, hexEncode, md5Bytes, randomBytes, toBytes, sha1Bytes, sha256Bytes };
