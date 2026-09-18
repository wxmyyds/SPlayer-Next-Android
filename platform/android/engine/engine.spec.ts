/**
 * 引擎垫片单测：URL / URLSearchParams / 编码原语 / 定时器与鸭子流
 *
 * 直接在 Node（happy-dom 已关）环境跑：垫片安装后与原生实现行为对齐。
 */

import { describe, expect, it } from "vitest";
import { installEncoding } from "./polyfills/encoding";
import { installUrl } from "./polyfills/url";
import { installDom } from "./polyfills/dom";

installEncoding();
installUrl();
installDom();

describe("URL", () => {
  it("绝对 URL 基本字段", () => {
    const u = new URL("https://interface.music.163.com/api/song?id=1&level=exhigh");
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe("interface.music.163.com");
    expect(u.pathname).toBe("/api/song");
    expect(u.origin).toBe("https://interface.music.163.com");
    expect(u.searchParams.get("id")).toBe("1");
    expect(u.searchParams.get("level")).toBe("exhigh");
  });

  it("相对解析（vendor 的 new URL(uri, base) 用法）", () => {
    const u = new URL("/api/song/enhance/player/url/v1", "https://interface.music.163.com");
    expect(u.href).toBe("https://interface.music.163.com/api/song/enhance/player/url/v1");
    const q = new URL("eapi/song?x=1", "https://a.com/base/");
    expect(q.href).toBe("https://a.com/base/eapi/song?x=1");
  });

  it("默认端口归一", () => {
    const u = new URL("http://a.com:80/x");
    expect(u.port).toBe("");
    expect(u.href).toBe("http://a.com/x");
  });

  it("点段消除", () => {
    const u = new URL("/a/b/../c/./d", "https://x.com");
    expect(u.pathname).toBe("/a/c/d");
  });

  it("hash 与 search 共存", () => {
    const u = new URL("https://a.com/p?x=1#top");
    expect(u.search).toBe("?x=1");
    expect(u.hash).toBe("#top");
  });
});

describe("URLSearchParams", () => {
  it("字符串解析与序列化", () => {
    const p = new URLSearchParams("a=1&b=%E4%B8%AD&c=x+y");
    expect(p.get("a")).toBe("1");
    expect(p.get("b")).toBe("中");
    expect(p.get("c")).toBe("x y");
    expect(p.toString()).toBe("a=1&b=%E4%B8%AD&c=x+y");
  });

  it("set 覆盖其余同名值", () => {
    const p = new URLSearchParams("a=1&a=2&a=3");
    p.set("a", "9");
    expect(p.getAll("a")).toEqual(["9"]);
  });

  it("对象构造", () => {
    const p = new URLSearchParams({ id: "42", level: "lossless" });
    expect(p.toString()).toBe("id=42&level=lossless");
  });

  it("URL.searchParams 变更写回 href", () => {
    const u = new URL("https://a.com/p?x=1");
    u.searchParams.set("x", "2");
    expect(u.href).toBe("https://a.com/p?x=2");
  });
});

describe("编码原语", () => {
  it("TextEncoder/Decoder roundtrip（含 emoji 代理对）", () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const src = "中文 a𝄞z";
    const bytes = enc.encode(src);
    expect(bytes instanceof Uint8Array).toBe(true);
    expect(dec.decode(bytes)).toBe(src);
  });

  it("非法 UTF-8 替换 U+FFFD", () => {
    const dec = new TextDecoder();
    expect(dec.decode(new Uint8Array([0x61, 0xff, 0x62]))).toBe("a\ufffdb");
    // 过长编码
    expect(dec.decode(new Uint8Array([0xc0, 0xaf]))).toBe("\ufffd\ufffd");
  });

  it("atob/btoa roundtrip", () => {
    expect(btoa("hello")).toBe("aGVsbG8=");
    expect(atob("aGVsbG8=")).toBe("hello");
    expect(atob(btoa("\u00ff\u0001"))).toBe("\u00ff\u0001");
  });

  it("atob 拒绝非法输入", () => {
    expect(() => atob("abc")).toThrow();
    expect(() => atob("ab$c")).toThrow();
  });
});

describe("解压鸭子类型（gzip 防御路径的形状）", () => {
  // 真实 inflate 在 Rust 侧；Node 测试环境注入拒绝型 mock 验证形状与错误传播
  (globalThis as Record<string, unknown>).__nativeInflate = () =>
    Promise.reject(new Error("mock inflate"));

  it("__nativeInflate mock 已注入", () => {
    expect(typeof (globalThis as Record<string, unknown>).__nativeInflate).toBe("function");
  });

  it("Blob.stream().pipeThrough() 返回可被 Response 消费的对象", async () => {
    // 真 inflate 由 Rust 承接，这里验证组合形状与错误传播
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const ds = new DecompressionStream("gzip");
    const piped = (
      blob.stream() as unknown as {
        pipeThrough: (d: typeof ds) => { __engineInflated: Promise<Uint8Array> };
      }
    ).pipeThrough(ds);
    expect(typeof piped.__engineInflated?.then).toBe("function");
    // 非法数据应 reject（native inflate 失败路径）
    await expect(new Response(piped as unknown as BodyInit).arrayBuffer()).rejects.toBeDefined();
  });
});
