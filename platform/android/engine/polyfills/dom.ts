/**
 * DOM 面最小实现：DOMException / AbortController / 定时器 / console / 解压鸭子类型
 *
 * vendor 只用到其中极小的面：
 * - AbortSignal：aborted / addEventListener / removeEventListener（proxy.ts 取消语义）
 * - DecompressionStream + Blob.stream + Response：仅 `new Blob([b]).stream().pipeThrough(ds)`
 *   这一种组合（防御性 gzip），鸭子类型实现，不做通用 web streams
 */

/** 最小 DOMException */
class DOMExceptionImpl extends Error {
  /**
   * @param message - 描述
   * @param name - 异常名（AbortError 等）
   */
  constructor(message = "", name = "Error") {
    super(message);
    this.name = name;
  }
}

/** AbortSignal 实现 */
class AbortSignalImpl {
  private listeners = new Set<() => void>();

  /** 是否已中止 */
  aborted = false;

  /** 中止原因 */
  reason: unknown = undefined;

  /**
   * 监听中止事件
   * @param _type - 事件类型（仅 "abort"）
   * @param fn - 回调
   */
  addEventListener(_type: string, fn: () => void): void {
    if (this.aborted) {
      fn();
      return;
    }
    this.listeners.add(fn);
  }

  /**
   * 移除监听
   * @param _type - 事件类型
   * @param fn - 回调
   */
  removeEventListener(_type: string, fn: () => void): void {
    this.listeners.delete(fn);
  }

  /**
   * 触发中止
   * @param reason - 中止原因
   */
  private fire(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason ?? new DOMExceptionImpl("signal is aborted without reason", "AbortError");
    for (const fn of [...this.listeners]) fn();
    this.listeners.clear();
  }

  /** 供 AbortController 调用 */
  static fire(signal: AbortSignalImpl, reason?: unknown): void {
    signal.fire(reason);
  }

  /**
   * 定时中止信号（vendor 请求层超时统一用 AbortSignal.timeout）
   * @param ms - 毫秒
   * @returns 已调度超时的信号
   */
  static timeout(ms: number): AbortSignalImpl {
    const signal = new AbortSignalImpl();
    setTimeoutImpl(
      () => AbortSignalImpl.fire(signal, new DOMExceptionImpl("signal timed out", "TimeoutError")),
      ms,
    );
    return signal;
  }
}

/** AbortController 实现 */
class AbortControllerImpl {
  readonly signal = new AbortSignalImpl();

  /**
   * 中止
   * @param reason - 中止原因
   */
  abort(reason?: unknown): void {
    AbortSignalImpl.fire(this.signal, reason);
  }
}

/** 定时器表 */
const timers = new Map<number, () => void>();
let timerSeq = 0;

/**
 * setTimeout：由 Rust 定时器驱动 `__timerFire(id)` 回调
 * @param fn - 回调
 * @param _ms - 毫秒（Rust 侧计时）
 * @param args - 透传参数
 * @returns 定时器 id
 */
const setTimeoutImpl = (fn: (...args: unknown[]) => void, _ms = 0, ...args: unknown[]): number => {
  const id = ++timerSeq;
  timers.set(id, () => fn(...args));
  __nativeSetTimeout(id, _ms);
  return id;
};

/**
 * clearTimeout
 * @param id - 定时器 id
 */
const clearTimeoutImpl = (id: number): void => {
  timers.delete(id);
};

/** Rust 定时器到期的回调入口（引擎内部使用） */
const timerFire = (id: number): void => {
  const fn = timers.get(id);
  if (!fn) return;
  timers.delete(id);
  fn();
};

/**
 * console 转接 logcat
 */
const installConsole = (): void => {
  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a) ?? String(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  const make =
    (level: string) =>
    (...args: unknown[]): void => {
      try {
        __nativeLog(level, fmt(args));
      } catch {
        // logcat 失败不影响业务
      }
    };
  const impl = {
    debug: make("DEBUG"),
    log: make("INFO"),
    info: make("INFO"),
    warn: make("WARN"),
    error: make("ERROR"),
  };
  Object.defineProperty(globalThis, "console", { value: impl, writable: true });
};

/**
 * 解压鸭子类型：只服务 `new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt))`
 * 之后 `new Response(piped).arrayBuffer()` 这一种组合。
 */
class BlobImpl {
  private bytes: Uint8Array;

  /**
   * @param parts - 字节部件（仅支持 Uint8Array/ArrayBuffer 单元素）
   */
  constructor(parts: (Uint8Array | ArrayBuffer)[]) {
    const first = parts[0];
    this.bytes =
      first instanceof Uint8Array ? first : first ? new Uint8Array(first) : new Uint8Array(0);
  }

  /**
   * 返回携带字节的管道源（pipeThrough 由源流承接，与 ReadableStream 语义一致）
   * @returns 管道源对象
   */
  stream(): {
    __engineBytes: Uint8Array;
    pipeThrough: (ds: DecompressionStreamImpl) => { __engineInflated: Promise<Uint8Array> };
  } {
    return {
      __engineBytes: this.bytes,
      pipeThrough: (ds: DecompressionStreamImpl) => ds.pipeBytes(this.bytes),
    };
  }
}

/** DecompressionStream 鸭子类型 */
class DecompressionStreamImpl {
  /** 压缩格式 */
  readonly format: string;

  /**
   * @param format - gzip / deflate / deflate-raw
   */
  constructor(format: string) {
    if (!["gzip", "deflate", "deflate-raw"].includes(format)) {
      throw new TypeError(`unsupported compression format: ${format}`);
    }
    this.format = format;
  }

  /**
   * 管道字节并解压（由 Blob.stream().pipeThrough 转发）
   * @param bytes - 源字节
   * @returns 携带解压字节 Promise 的对象
   */
  pipeBytes(bytes: Uint8Array): { __engineInflated: Promise<Uint8Array> } {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const inflated = __nativeInflate(btoa(bin), this.format).then((b64) => {
      const raw = atob(b64);
      const out = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    });
    return { __engineInflated: inflated };
  }
}

/** Response 鸭子类型（仅 arrayBuffer 消费管道结果） */
class ResponseImpl {
  private source: { __engineInflated?: Promise<Uint8Array>; __engineBytes?: Uint8Array };

  /**
   * @param source - pipeThrough 的返回或 Blob.stream() 的返回
   */
  constructor(source: { __engineInflated?: Promise<Uint8Array>; __engineBytes?: Uint8Array }) {
    this.source = source;
  }

  /**
   * 全量字节
   * @returns ArrayBuffer
   */
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = this.source.__engineInflated
      ? await this.source.__engineInflated
      : (this.source.__engineBytes ?? new Uint8Array(0));
    return bytes.slice().buffer as ArrayBuffer;
  }
}

/**
 * 安装 DOM 面
 */
export const installDom = (): void => {
  Object.defineProperty(globalThis, "DOMException", { value: DOMExceptionImpl, writable: true });
  Object.defineProperty(globalThis, "AbortController", {
    value: AbortControllerImpl,
    writable: true,
  });
  Object.defineProperty(globalThis, "AbortSignal", { value: AbortSignalImpl, writable: true });
  Object.defineProperty(globalThis, "setTimeout", { value: setTimeoutImpl, writable: true });
  Object.defineProperty(globalThis, "clearTimeout", { value: clearTimeoutImpl, writable: true });
  Object.defineProperty(globalThis, "__timerFire", { value: timerFire, writable: true });
  Object.defineProperty(globalThis, "Blob", { value: BlobImpl, writable: true });
  Object.defineProperty(globalThis, "DecompressionStream", {
    value: DecompressionStreamImpl,
    writable: true,
  });
  Object.defineProperty(globalThis, "Response", { value: ResponseImpl, writable: true });
  installConsole();
};
