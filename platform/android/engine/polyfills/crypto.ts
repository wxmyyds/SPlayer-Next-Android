/**
 * crypto.getRandomValues + crypto.subtle 垫片
 *
 * subtle 只对齐 vendor（webcrypto.ts）实际用到的面：
 * digest("SHA-256") / importKey+sign(HMAC-SHA256) / AES-CBC / AES-GCM / X25519。
 * 原语由 Rust（__nativeSubtle）承接；CryptoKey 以纯对象承载密钥字节。
 */

/** b64 辅助（依赖 encoding 垫片先装） */
const bytesToB64 = (b: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** CryptoKey 纯对象（引擎内不透明，仅 subtle 内部消费） */
interface EngineCryptoKey {
  name: string;
  hash?: string;
  raw: string;
  type: "secret" | "private" | "public";
}

const isKey = (v: unknown): v is EngineCryptoKey =>
  typeof v === "object" && v !== null && typeof (v as EngineCryptoKey).raw === "string";

/** native 调用（同步阻塞，vendor 以 await 消费） */
const subtleCall = async (req: Record<string, unknown>): Promise<Uint8Array> => {
  const raw = await __nativeSubtle(JSON.stringify(req));
  const parsed = JSON.parse(raw) as { out: string };
  return b64ToBytes(parsed.out);
};

/** 安装 crypto 全局 */
export const installCrypto = (): void => {
  const subtle = {
    /**
     * 摘要（仅 SHA-256）
     * @param algorithm - "SHA-256" 或 { name }
     * @param data - 源字节
     * @returns 摘要字节
     */
    async digest(algorithm: string | { name: string }, data: Uint8Array): Promise<ArrayBuffer> {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name !== "SHA-256") throw new Error(`unsupported digest: ${name}`);
      const out = await subtleCall({ op: "sha256", data: bytesToB64(data) });
      return out.slice().buffer as ArrayBuffer;
    },
    /**
     * 导入密钥（仅 "raw"）
     * @param format - "raw"
     * @param keyData - 裸密钥字节
     * @param algorithm - { name, hash? }
     * @param _extractable - 规范参数（引擎不裁剪）
     * @param usages - 用途（X25519 区分公私钥）
     */
    async importKey(
      format: string,
      keyData: Uint8Array,
      algorithm: { name: string; hash?: string },
      _extractable: boolean,
      usages: string[],
    ): Promise<EngineCryptoKey> {
      if (format !== "raw") throw new Error(`unsupported key format: ${format}`);
      const name = algorithm.name;
      let type: EngineCryptoKey["type"] = "secret";
      if (name === "HMAC" || name.startsWith("AES")) type = "secret";
      else if (name === "X25519") {
        type = usages.includes("deriveBits") || usages.includes("deriveKey") ? "private" : "public";
      } else {
        throw new Error(`unsupported key algorithm: ${name}`);
      }
      return { name, hash: algorithm.hash, raw: bytesToB64(keyData), type };
    },
    /**
     * HMAC 签名（仅 HMAC + SHA-256）
     * @param algorithm - "HMAC" 或 { name }
     * @param key - importKey 返回的密钥
     * @param data - 源字节
     * @returns 签名字节
     */
    async sign(
      algorithm: string | { name: string },
      key: EngineCryptoKey,
      data: Uint8Array,
    ): Promise<ArrayBuffer> {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      if (name !== "HMAC" || !isKey(key) || key.hash !== "SHA-256") {
        throw new Error("unsupported sign: only HMAC/SHA-256");
      }
      const out = await subtleCall({
        op: "hmac-sha256",
        key: key.raw,
        data: bytesToB64(data),
      });
      return out.slice().buffer as ArrayBuffer;
    },
    /**
     * AES-CBC / AES-GCM 加密
     * @param algorithm - { name, iv, additionalData?, tagLength? }
     * @param key - importKey 返回的密钥
     * @param data - 明文
     * @returns 密文（GCM：密文尾部带 16 字节 tag，与 WebCrypto 一致）
     */
    async encrypt(
      algorithm: { name: string; iv: Uint8Array; additionalData?: Uint8Array; tagLength?: number },
      key: EngineCryptoKey,
      data: Uint8Array,
    ): Promise<ArrayBuffer> {
      if (!isKey(key)) throw new Error("bad key");
      if (algorithm.name !== "AES-CBC" && algorithm.name !== "AES-GCM") {
        throw new Error(`unsupported encrypt: ${algorithm.name}`);
      }
      const out = await subtleCall({
        op: algorithm.name === "AES-CBC" ? "aes-cbc-encrypt" : "aes-gcm-encrypt",
        key: key.raw,
        iv: bytesToB64(algorithm.iv),
        data: bytesToB64(data),
        ...(algorithm.additionalData ? { aad: bytesToB64(algorithm.additionalData) } : {}),
      });
      return out.slice().buffer as ArrayBuffer;
    },
    /**
     * AES-CBC / AES-GCM 解密
     * @param algorithm - { name, iv, additionalData?, tagLength? }
     * @param key - importKey 返回的密钥
     * @param data - 密文（GCM：尾部 16 字节 tag）
     * @returns 明文
     */
    async decrypt(
      algorithm: { name: string; iv: Uint8Array; additionalData?: Uint8Array; tagLength?: number },
      key: EngineCryptoKey,
      data: Uint8Array,
    ): Promise<ArrayBuffer> {
      if (!isKey(key)) throw new Error("bad key");
      if (algorithm.name !== "AES-CBC" && algorithm.name !== "AES-GCM") {
        throw new Error(`unsupported decrypt: ${algorithm.name}`);
      }
      const out = await subtleCall({
        op: algorithm.name === "AES-CBC" ? "aes-cbc-decrypt" : "aes-gcm-decrypt",
        key: key.raw,
        iv: bytesToB64(algorithm.iv),
        data: bytesToB64(data),
        ...(algorithm.additionalData ? { aad: bytesToB64(algorithm.additionalData) } : {}),
      });
      return out.slice().buffer as ArrayBuffer;
    },
    /**
     * 生成密钥对（仅 X25519）
     * @param algorithm - { name: "X25519" }
     * @returns { publicKey, privateKey }
     */
    async generateKey(algorithm: {
      name: string;
    }): Promise<{ publicKey: EngineCryptoKey; privateKey: EngineCryptoKey }> {
      if (algorithm.name !== "X25519") {
        throw new Error(`unsupported generateKey: ${algorithm.name}`);
      }
      const raw = await __nativeSubtle(JSON.stringify({ op: "x25519-keypair" }));
      const parsed = JSON.parse(raw) as { private: string; public: string };
      return {
        publicKey: { name: "X25519", raw: parsed.public, type: "public" },
        privateKey: { name: "X25519", raw: parsed.private, type: "private" },
      };
    },
    /**
     * 导出密钥（仅 "raw"）
     * @param format - "raw"
     * @param key - CryptoKey
     * @returns 裸字节
     */
    async exportKey(format: string, key: EngineCryptoKey): Promise<ArrayBuffer> {
      if (format !== "raw" || !isKey(key)) throw new Error("unsupported exportKey");
      return b64ToBytes(key.raw).slice().buffer as ArrayBuffer;
    },
    /**
     * 派生比特（仅 X25519）
     * @param algorithm - { name: "X25519", public: 对端密钥 }
     * @param key - 本端私钥
     * @param length - 比特数（256 = 全量 32 字节）
     */
    async deriveBits(
      algorithm: { name: string; public: EngineCryptoKey },
      key: EngineCryptoKey,
      length: number,
    ): Promise<ArrayBuffer> {
      if (algorithm.name !== "X25519" || !isKey(key) || !isKey(algorithm.public)) {
        throw new Error("unsupported deriveBits: only X25519");
      }
      const out = await subtleCall({
        op: "x25519-derive",
        private: key.raw,
        peer: algorithm.public.raw,
      });
      const bytes = length >= 256 ? out : out.subarray(0, Math.ceil(length / 8));
      return bytes.slice().buffer as ArrayBuffer;
    },
  };

  const cryptoGlobal = {
    getRandomValues,
    randomUUID(): string {
      const bytes = new Uint8Array(16);
      getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    subtle,
  };
  Object.defineProperty(globalThis, "crypto", { value: cryptoGlobal, writable: true });

  /**
   * 填充密码学安全随机字节（原语由 Rust getrandom 提供）
   * @param array - 目标视图
   * @returns 目标视图（与规范一致）
   * @throws QuotaExceededError 超过 65536 字节
   */
  function getRandomValues(
    array: Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array,
  ) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    if (bytes.length > 65536) {
      throw new DOMException("getRandomValues quota exceeded", "QuotaExceededError");
    }
    const b64 = __nativeRandom(bytes.length);
    const raw = atob(b64);
    for (let i = 0; i < bytes.length; i++) bytes[i] = raw.charCodeAt(i);
    return array;
  }
};
