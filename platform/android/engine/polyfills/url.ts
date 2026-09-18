/**
 * URL / URLSearchParams 最小 WHATWG 实现
 *
 * vendor 用途：`new URL(uri, base)`、origin/pathname/search/href/searchParams，
 * 按规范实现绝对/相对解析、点段消除、默认端口归一与 query 编解码。
 */

/** form-urlencoded 值编码（! ' ( ) * 额外转义，与规范一致） */
const encodeQueryValue = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** form-urlencoded 解码（+ → 空格） */
const decodeQueryValue = (s: string): string => decodeURIComponent(s.replace(/\+/g, " "));

/** URL 状态 */
interface UrlParts {
  scheme: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  path: string;
  query: string | null;
  fragment: string | null;
}

/** 默认端口表 */
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ws: "80", wss: "443" };

/** 特殊 scheme（有默认端口） */
const isSpecial = (scheme: string): boolean => scheme in DEFAULT_PORTS;

/** 消除路径点段（规范 4.4） */
const normalizePath = (path: string): string => {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const keepSlash = /\/$|\/\.$|\/\.\.$/.test(path);
  return "/" + out.join("/") + (keepSlash && out.length > 0 ? "/" : "");
};

/**
 * 解析 URL 字符串为部件（相对输入按 base 合并）
 * @param input - URL 字符串
 * @param base - 已解析的基础部件
 * @returns 部件集合
 * @throws TypeError 非法 URL
 */
const parseUrl = (input: string, base?: UrlParts | null): UrlParts => {
  let rest = input.trim();
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rest);
  let scheme: string;
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  } else {
    if (!base) throw new TypeError(`invalid URL: ${input}`);
    scheme = base.scheme;
  }

  // fragment / query 先切掉
  let fragment: string | null = null;
  let query: string | null = null;
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }
  const queryIdx = rest.indexOf("?");
  if (queryIdx >= 0) {
    query = rest.slice(queryIdx + 1);
    rest = rest.slice(0, queryIdx);
  }

  let username = "";
  let password = "";
  let hostname = "";
  let port = "";
  let path: string;

  if (schemeMatch || rest.startsWith("//")) {
    if (rest.startsWith("//")) rest = rest.slice(2);
    const authorityEnd = rest.indexOf("/");
    const authority = authorityEnd >= 0 ? rest.slice(0, authorityEnd) : rest;
    path = authorityEnd >= 0 ? normalizePath(rest.slice(authorityEnd)) : "/";
    const atIdx = authority.lastIndexOf("@");
    let hostPart = authority;
    if (atIdx >= 0) {
      const userinfo = authority.slice(0, atIdx);
      const colon = userinfo.indexOf(":");
      username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
      password = colon >= 0 ? userinfo.slice(colon + 1) : "";
      hostPart = authority.slice(atIdx + 1);
    }
    const ipv6 = hostPart.startsWith("[");
    if (ipv6) {
      const end = hostPart.indexOf("]");
      if (end < 0) throw new TypeError(`invalid IPv6: ${input}`);
      hostname = hostPart.slice(0, end + 1);
      const colon = hostPart.indexOf(":", end);
      if (colon >= 0) {
        port = hostPart.slice(colon + 1);
        if (!/^\d*$/.test(port)) throw new TypeError(`invalid port: ${input}`);
      }
    } else {
      const colon = hostPart.lastIndexOf(":");
      if (colon >= 0) {
        hostname = hostPart.slice(0, colon);
        port = hostPart.slice(colon + 1);
        if (!/^\d*$/.test(port)) throw new TypeError(`invalid port: ${input}`);
      } else {
        hostname = hostPart;
      }
    }
    if (port === DEFAULT_PORTS[scheme]) port = "";
    if (!hostname && isSpecial(scheme)) throw new TypeError(`invalid URL: ${input}`);
  } else {
    if (!base) throw new TypeError(`invalid URL: ${input}`);
    username = base.username;
    password = base.password;
    hostname = base.hostname;
    port = base.port;
    if (rest === "") path = base.path;
    else if (rest.startsWith("/")) path = normalizePath(rest);
    else path = normalizePath(base.path.slice(0, base.path.lastIndexOf("/") + 1) + rest);
  }

  return { scheme, username, password, hostname, port, path, query, fragment };
};

/** 部件转 href */
const partsToHref = (p: UrlParts): string => {
  let out = `${p.scheme}:`;
  if (p.hostname || isSpecial(p.scheme)) out += "//";
  if (p.username || p.password) {
    out += p.username;
    if (p.password) out += `:${p.password}`;
    out += "@";
  }
  out += p.hostname;
  if (p.port) out += `:${p.port}`;
  out += p.path || (isSpecial(p.scheme) ? "/" : "");
  if (p.query !== null) out += `?${p.query}`;
  if (p.fragment !== null) out += `#${p.fragment}`;
  return out;
};

/** URLSearchParams 实现 */
class URLSearchParamsImpl {
  private entries: [string, string][] = [];
  private onChange: (() => void) | null = null;

  /**
   * @param init - 查询串或键值对
   */
  constructor(init?: string | Record<string, string> | [string, string][]) {
    if (typeof init === "string") {
      const q = init.replace(/^\?/, "");
      if (q) {
        for (const pair of q.split("&")) {
          if (pair === "") continue;
          const eq = pair.indexOf("=");
          const name = eq >= 0 ? pair.slice(0, eq) : pair;
          this.entries.push([
            decodeQueryValue(name),
            eq >= 0 ? decodeQueryValue(pair.slice(eq + 1)) : "",
          ]);
        }
      }
    } else if (Array.isArray(init)) {
      this.entries = init.map(([k, v]) => [String(k), String(v)]);
    } else if (init) {
      for (const [k, v] of Object.entries(init)) this.entries.push([k, String(v)]);
    }
  }

  /** 变更回调（URL 绑定写回 query） */
  setListener(onChange: () => void): void {
    this.onChange = onChange;
  }

  private touch(): void {
    this.onChange?.();
  }

  /**
   * 追加键值
   * @param name - 键
   * @param value - 值
   */
  append(name: string, value: string): void {
    this.entries.push([String(name), String(value)]);
    this.touch();
  }

  /**
   * 删除键的全部值
   * @param name - 键
   */
  delete(name: string): void {
    this.entries = this.entries.filter(([k]) => k !== String(name));
    this.touch();
  }

  /**
   * 取首个值
   * @param name - 键
   * @returns 值，不存在返回 null
   */
  get(name: string): string | null {
    const hit = this.entries.find(([k]) => k === String(name));
    return hit ? hit[1] : null;
  }

  /**
   * 取全部值
   * @param name - 键
   * @returns 值数组
   */
  getAll(name: string): string[] {
    return this.entries.filter(([k]) => k === String(name)).map(([, v]) => v);
  }

  /**
   * 是否存在键
   * @param name - 键
   * @returns 存在性
   */
  has(name: string): boolean {
    return this.entries.some(([k]) => k === String(name));
  }

  /**
   * 覆盖设置键值
   * @param name - 键
   * @param value - 值
   */
  set(name: string, value: string): void {
    const key = String(name);
    const val = String(value);
    let replaced = false;
    this.entries = this.entries.filter(([k]) => {
      if (k !== key) return true;
      if (replaced) return false;
      replaced = true;
      return true;
    });
    if (replaced) {
      const idx = this.entries.findIndex(([k]) => k === key);
      this.entries[idx] = [key, val];
    } else {
      this.entries.push([key, val]);
    }
    this.touch();
  }

  /** 按键名排序 */
  sort(): void {
    this.entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    this.touch();
  }

  /**
   * 序列化（form-urlencoded）
   * @returns 查询串
   */
  toString(): string {
    return this.entries
      .map(([k, v]) => `${encodeQueryValue(k)}=${encodeQueryValue(v)}`.replaceAll("%20", "+"))
      .join("&");
  }

  /**
   * 遍历键值
   * @param fn - 回调
   */
  forEach(fn: (value: string, name: string) => void): void {
    for (const [k, v] of this.entries) fn(v, k);
  }

  /**
   * 键迭代
   * @returns 键数组（引擎内以数组代替 iterator，够用）
   */
  keys(): string[] {
    return this.entries.map(([k]) => k);
  }

  /**
   * 值迭代
   * @returns 值数组
   */
  values(): string[] {
    return this.entries.map(([, v]) => v);
  }

  /**
   * 键值对迭代
   * @returns 键值对数组
   */
  entriesArray(): [string, string][] {
    return [...this.entries];
  }
}

/** URL 实现 */
class URLImpl {
  private parts: UrlParts;
  private params: URLSearchParamsImpl | null = null;

  /**
   * @param url - URL 字符串
   * @param base - 基础 URL
   */
  constructor(url: string | URLImpl, base?: string | URLImpl) {
    const baseParts = base ? (base instanceof URLImpl ? base.parts : parseUrl(String(base))) : null;
    this.parts = parseUrl(String(url), baseParts);
  }

  /** 变更写回：params 修改时同步 parts.query */
  private bindParams(p: URLSearchParamsImpl): void {
    p.setListener(() => {
      this.parts.query = p.toString() || null;
    });
  }

  get href(): string {
    return partsToHref(this.parts);
  }

  set href(value: string) {
    this.parts = parseUrl(value, null);
    this.params = null;
  }

  get protocol(): string {
    return `${this.parts.scheme}:`;
  }

  get username(): string {
    return this.parts.username;
  }

  get password(): string {
    return this.parts.password;
  }

  get host(): string {
    return this.parts.port ? `${this.parts.hostname}:${this.parts.port}` : this.parts.hostname;
  }

  get hostname(): string {
    return this.parts.hostname;
  }

  get port(): string {
    return this.parts.port;
  }

  set port(value: string) {
    this.parts.port = value === "" || DEFAULT_PORTS[this.parts.scheme] === value ? "" : value;
  }

  get pathname(): string {
    return this.parts.path || "/";
  }

  set pathname(value: string) {
    this.parts.path = normalizePath(value.startsWith("/") ? value : `/${value}`);
  }

  get search(): string {
    return this.parts.query !== null ? `?${this.parts.query}` : "";
  }

  set search(value: string) {
    this.parts.query = value === "" ? null : value.replace(/^\?/, "");
    this.params = null;
  }

  get hash(): string {
    return this.parts.fragment !== null ? `#${this.parts.fragment}` : "";
  }

  set hash(value: string) {
    this.parts.fragment = value === "" ? null : value.replace(/^#/, "");
  }

  get origin(): string {
    if (!isSpecial(this.parts.scheme)) return "null";
    return `${this.parts.scheme}://${this.parts.hostname}${this.parts.port ? `:${this.parts.port}` : ""}`;
  }

  get searchParams(): URLSearchParamsImpl {
    if (!this.params) {
      this.params = new URLSearchParamsImpl(this.parts.query ?? "");
      this.bindParams(this.params);
    }
    return this.params;
  }

  /**
   * 序列化（params 变更已实时写回）
   * @returns href
   */
  toString(): string {
    return partsToHref(this.parts);
  }

  /**
   * JSON 序列化（规范行为：返回 href）
   * @returns href
   */
  toJSON(): string {
    return this.toString();
  }
}

/**
 * 安装 URL 全局
 */
export const installUrl = (): void => {
  Object.defineProperty(globalThis, "URL", { value: URLImpl, writable: true });
  Object.defineProperty(globalThis, "URLSearchParams", {
    value: URLSearchParamsImpl,
    writable: true,
  });
};

export { URLImpl, URLSearchParamsImpl };
