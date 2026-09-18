/**
 * crypto.getRandomValues / localStorage 垫片
 */

/** 安装 crypto.getRandomValues（随机源由 Rust getrandom 提供） */
export const installCrypto = (): void => {
  const impl = {
    /**
     * 填充密码学安全随机字节
     * @param array - 目标视图
     * @returns 目标视图（与规范一致）
     * @throws QuotaExceededError 超过 65536 字节
     */
    getRandomValues(
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
    },
  };
  const cryptoGlobal = { getRandomValues: impl.getRandomValues, subtle: undefined };
  Object.defineProperty(globalThis, "crypto", { value: cryptoGlobal, writable: true });
};

/** localStorage 内存镜像（懒加载，写穿透到原生 SharedPreferences） */
const storeMap = new Map<string, string>();
let storeLoaded = false;

/** 首次访问时从原生侧全量拉取 */
const ensureLoaded = (): void => {
  if (storeLoaded) return;
  storeLoaded = true;
  // 键集合由原生侧提供：JSON 数组
  try {
    const keysJson = __nativeStoreKeys();
    const keys = JSON.parse(keysJson) as string[];
    for (const k of keys) {
      const v = __nativeStoreGet(k);
      if (v !== null) storeMap.set(k, v);
    }
  } catch {
    // 原生存储不可用时退化为内存态
  }
};

/** 全量键集合（JSON 数组） */
declare function __nativeStoreKeys(): string;

/**
 * 安装 localStorage（vendor 的 store.ts / sessions.ts 依赖其同步语义）
 */
export const installStorage = (): void => {
  const impl = {
    /**
     * 读值
     * @param key - 键
     * @returns 值，不存在返回 null
     */
    getItem(key: string): string | null {
      ensureLoaded();
      return storeMap.get(String(key)) ?? null;
    },
    /**
     * 写值
     * @param key - 键
     * @param value - 值
     */
    setItem(key: string, value: string): void {
      ensureLoaded();
      const k = String(key);
      const v = String(value);
      storeMap.set(k, v);
      __nativeStoreSet(k, v);
    },
    /**
     * 删除键
     * @param key - 键
     */
    removeItem(key: string): void {
      ensureLoaded();
      const k = String(key);
      storeMap.delete(k);
      __nativeStoreSet(k, "");
    },
    /**
     * 清空（引擎内未用，规范补全）
     */
    clear(): void {
      ensureLoaded();
      for (const k of storeMap.keys()) __nativeStoreSet(k, "");
      storeMap.clear();
    },
    /**
     * 键名（按下标）
     * @param index - 下标
     * @returns 键名或 null
     */
    key(index: number): string | null {
      ensureLoaded();
      return [...storeMap.keys()][index] ?? null;
    },
    /** 键数量 */
    get length(): number {
      ensureLoaded();
      return storeMap.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: impl, writable: true });
};
