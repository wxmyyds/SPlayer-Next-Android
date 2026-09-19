/**
 * localStorage 垫片（引擎内独立于 WebView 的存储区）
 */

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
      // Java 侧缺失键返回空串（"" 同时是 storeSet 的删除哨兵，不会是合法值），视为不存在
      if (v !== null && v !== "") storeMap.set(k, v);
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
