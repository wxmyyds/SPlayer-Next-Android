/**
 * 插件沙箱 Buffer 垫片
 *
 * WebView 无 node:Buffer；此处提供 LX/音源插件常用的 from/alloc/concat/isBuffer 与
 * toString/from 的编码子集（utf8/hex/base64/latin1/binary/ascii/utf-16le），语义对齐 node:Buffer。
 * 由于为 TS 严格继承约束考虑，实例容器与静态方法分离：PluginBuffer 继承 Uint8Array，Buffer 门面承担静态 API。
 */

import { b64Decode, b64Encode, hexDecode, hexEncode } from "../vendor/shim/webcrypto";

export type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "hex"
  | "base64"
  | "base64url"
  | "latin1"
  | "binary"
  | "ascii"
  | "ucs2"
  | "ucs-2"
  | "utf-16le";

const bytesToString = (bytes: Uint8Array, enc: BufferEncoding): string => {
  switch (enc) {
    case "hex":
      return hexEncode(bytes);
    case "base64":
      return b64Encode(bytes);
    case "base64url":
      return b64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    case "latin1":
    case "binary":
    case "ascii": {
      let out = "";
      for (const b of bytes) out += String.fromCharCode(b);
      return out;
    }
    case "ucs2":
    case "ucs-2":
    case "utf-16le": {
      const pairs = new Uint8Array(bytes.length + (bytes.length % 2));
      pairs.set(bytes);
      return new TextDecoder("utf-16le").decode(pairs);
    }
    default:
      return new TextDecoder("utf-8").decode(bytes);
  }
};

const stringToBytes = (text: string, enc: BufferEncoding): Uint8Array => {
  switch (enc) {
    case "hex":
      return hexDecode(text);
    case "base64":
    case "base64url":
      return b64Decode(text.replace(/-/g, "+").replace(/_/g, "/"));
    case "latin1":
    case "binary":
    case "ascii": {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
    case "ucs2":
    case "ucs-2":
    case "utf-16le": {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        out[i * 2] = code & 0xff;
        out[i * 2 + 1] = code >> 8;
      }
      return out;
    }
    default:
      return new TextEncoder().encode(text);
  }
};

const ENCODINGS: readonly string[] = [
  "utf8",
  "utf-8",
  "hex",
  "base64",
  "base64url",
  "latin1",
  "binary",
  "ascii",
  "ucs2",
  "ucs-2",
  "utf-16le",
];

export class PluginBuffer extends Uint8Array {
  constructor(
    input?: number | string | readonly number[] | ArrayBuffer | Uint8Array,
    encoding?: BufferEncoding,
  ) {
    if (typeof input === "string") super(stringToBytes(input, encoding ?? "utf8"));
    else if (typeof input === "number") super(input);
    else if (input === undefined) super(0);
    else super(input as Uint8Array);
  }

  /** 按 encoding 导出字节为字符串 */
  override toString(encoding: BufferEncoding = "utf8"): string {
    return bytesToString(this, encoding);
  }

  toJSON(): { type: "Buffer"; data: number[] } {
    return { type: "Buffer", data: Array.from(this) };
  }

  /** node 兼容：读出 hex/ascii 用的整串（索引访问由 Uint8Array 提供） */
  get raw(): string {
    return this.toString("binary");
  }
}

/** node 风格 Buffer 立面；避免 class 静态成员与 Uint8Array.from 的类型冲突 */
export const Buffer = {
  from: (
    data: string | ArrayBuffer | SharedArrayBuffer | Uint8Array | number[] | Iterable<number>,
    encodingOrOffset?: BufferEncoding | number,
    length?: number,
  ): PluginBuffer => {
    if (typeof data === "string") {
      return new PluginBuffer(data, (encodingOrOffset as BufferEncoding) ?? "utf8");
    }
    if (data instanceof Uint8Array) {
      const start = typeof encodingOrOffset === "number" ? encodingOrOffset : 0;
      const end = typeof length === "number" ? start + length : data.byteLength;
      return new PluginBuffer(data.subarray(start, end));
    }
    if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
      const offset = typeof encodingOrOffset === "number" ? encodingOrOffset : 0;
      const end = length !== undefined ? offset + length : data.byteLength - offset;
      return new PluginBuffer(new Uint8Array(data.slice(offset, end)));
    }
    return new PluginBuffer(Uint8Array.from(data as Iterable<number>, (v) => v & 0xff));
  },
  alloc: (
    size: number,
    fill?: number | string | Uint8Array,
    encoding?: BufferEncoding,
  ): PluginBuffer => {
    const out = new PluginBuffer(Math.max(0, Math.floor(size)));
    if (fill === undefined) return out;
    const chars =
      typeof fill === "number"
        ? new PluginBuffer([fill & 0xff])
        : typeof fill === "string"
          ? new PluginBuffer(fill, encoding ?? "utf8")
          : new PluginBuffer(fill);
    if (chars.length > 0) {
      for (let off = 0; off < out.length; off += chars.length) {
        out.set(chars.subarray(0, Math.min(chars.length, out.length - off)), off);
      }
    }
    return out;
  },
  allocUnsafe: (size: number): PluginBuffer => new PluginBuffer(Math.max(0, Math.floor(size))),
  isBuffer: (value: unknown): value is PluginBuffer => value instanceof PluginBuffer,
  isEncoding: (encoding?: string): encoding is BufferEncoding =>
    typeof encoding === "string" && ENCODINGS.includes(encoding.toLowerCase()),
  concat: (list: Uint8Array[], totalLength?: number): PluginBuffer => {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
    const out = new PluginBuffer(total);
    let off = 0;
    for (const item of list) {
      out.set(item.subarray(0, Math.min(item.length, total - off)), off);
      off += item.length;
      if (off >= total) break;
    }
    return out;
  },
  byteLength: (data: string | Uint8Array, encoding?: BufferEncoding): number =>
    typeof data === "string" ? stringToBytes(data, encoding ?? "utf8").length : data.byteLength,
};
