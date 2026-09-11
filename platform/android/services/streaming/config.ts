/**
 * 流媒体服务器配置存储（Android 版）
 *
 * 上游 electron/main/services/streaming/config.ts 用 fs + safeStorage 加密存储；
 * Android 无 safeStorage，密码明文存 localStorage（与 vendor 会话 cookie 同信任域，
 * 渲染层即本桥，不存在凭据隔离边界）。函数签名与上游保持一致，connection.ts 无感。
 */

import type {
  StreamingServerConfig,
  StreamingServerInput,
  StreamingRuntimeConfig,
} from "@shared/types/streaming";

const STORAGE_KEY = "splayer.android.streaming";

interface PersistedServer {
  id: string;
  name: string;
  type: StreamingServerConfig["type"];
  url: string;
  username: string;
  password: string;
  lastConnected?: number;
}

interface PersistedState {
  servers: PersistedServer[];
  activeServerId: string | null;
}

let state: PersistedState | undefined;

/**
 * 读取流媒体配置
 * @returns 内存中的完整配置
 */
const getState = (): PersistedState => {
  if (state) return state;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "") as PersistedState;
    state = Array.isArray(parsed?.servers)
      ? { servers: parsed.servers, activeServerId: parsed.activeServerId ?? null }
      : { servers: [], activeServerId: null };
  } catch {
    state = { servers: [], activeServerId: null };
  }
  return state;
};

/** 保存当前流媒体配置 */
const save = (): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(getState()));
  } catch (error) {
    console.error("[streaming] 配置保存失败:", error);
  }
};

/**
 * 转换为 UI 可见配置
 * @param server - 持久化配置
 * @returns 不含凭据的配置
 */
const toServerConfig = (server: PersistedServer): StreamingServerConfig => ({
  id: server.id,
  name: server.name,
  type: server.type,
  url: server.url,
  username: server.username,
  hasPassword: Boolean(server.password),
  lastConnected: server.lastConnected,
});

/**
 * 转换为运行时配置
 * @param server - 持久化配置
 * @returns 包含凭据的配置
 */
const toRuntimeConfig = (server: PersistedServer): StreamingRuntimeConfig => ({
  ...toServerConfig(server),
  password: server.password,
});

/**
 * 获取服务器列表和当前服务器
 * @returns UI 可见配置状态
 */
export const getStreamingConfig = (): {
  servers: StreamingServerConfig[];
  activeServerId: string | null;
} => ({
  servers: getState().servers.map(toServerConfig),
  activeServerId: getState().activeServerId,
});

/**
 * 获取指定服务器的运行时配置
 * @param serverId - 服务器 ID
 * @returns 包含凭据的配置
 */
export const getStreamingServer = (serverId: string): StreamingRuntimeConfig => {
  const server = getState().servers.find((item) => item.id === serverId);
  if (!server) throw new Error("找不到流媒体服务器");
  return toRuntimeConfig(server);
};

/**
 * 新增服务器
 * @param input - 服务器表单
 * @returns 新服务器配置
 */
export const addStreamingServer = (input: StreamingServerInput): StreamingServerConfig => {
  const server: PersistedServer = {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    type: input.type,
    url: input.url.trim().replace(/\/+$/, ""),
    username: input.username,
    password: input.password,
  };
  getState().servers.push(server);
  save();
  return toServerConfig(server);
};

/**
 * 更新服务器
 * @param serverId - 服务器 ID
 * @param input - 服务器表单
 * @returns 更新后的服务器配置
 */
export const updateStreamingServer = (
  serverId: string,
  input: StreamingServerInput,
): StreamingServerConfig => {
  const server = getState().servers.find((item) => item.id === serverId);
  if (!server) throw new Error("找不到流媒体服务器");
  server.name = input.name.trim();
  server.type = input.type;
  server.url = input.url.trim().replace(/\/+$/, "");
  server.username = input.username;
  if (input.password) server.password = input.password;
  server.lastConnected = undefined;
  save();
  return toServerConfig(server);
};

/**
 * 删除服务器
 * @param serverId - 服务器 ID
 */
export const removeStreamingServer = (serverId: string): void => {
  const current = getState();
  current.servers = current.servers.filter((server) => server.id !== serverId);
  if (current.activeServerId === serverId) current.activeServerId = null;
  save();
};

/**
 * 设置当前服务器
 * @param serverId - 服务器 ID
 */
export const setActiveStreamingServer = (serverId: string | null): void => {
  const current = getState();
  if (serverId && !current.servers.some((server) => server.id === serverId)) {
    throw new Error("找不到流媒体服务器");
  }
  current.activeServerId = serverId;
  save();
};

/**
 * 记录服务器连接成功
 * @param serverId - 服务器 ID
 * @returns 更新后的服务器配置
 */
export const markStreamingServerConnected = (serverId: string): StreamingServerConfig => {
  const server = getState().servers.find((item) => item.id === serverId);
  if (!server) throw new Error("找不到流媒体服务器");
  server.lastConnected = Date.now();
  save();
  return toServerConfig(server);
};

/**
 * 创建连接测试使用的临时配置
 * @param input - 服务器表单
 * @param serverId - 编辑中的服务器 ID
 * @returns 临时运行时配置
 */
export const createTestStreamingServer = (
  input: StreamingServerInput,
  serverId?: string,
): StreamingRuntimeConfig => {
  const saved = serverId ? getState().servers.find((server) => server.id === serverId) : undefined;
  const password = input.password || (saved ? saved.password : "");

  const base = {
    id: `__test__:${crypto.randomUUID()}`,
    name: input.name.trim(),
    url: input.url.trim().replace(/\/+$/, ""),
    username: input.username,
    password,
    hasPassword: Boolean(password),
  };

  return {
    ...base,
    type: input.type,
  };
};
