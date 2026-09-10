/**
 * 私人 FM（需登录）
 *
 * 响应：`{ code, data: NeteaseSong[] }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const personalFm: NeteaseModule = (query, request) =>
  request("/api/v1/radio/get", {}, createOption(query, "weapi"));

export default personalFm;
