/**
 * 每日推荐歌单（需登录）
 *
 * 响应：`{ code, recommend: [{ id, name, picUrl, copywriter, ... }] }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const recommendResource: NeteaseModule = (query, request) =>
  request("/api/v1/discovery/recommend/resource", {}, createOption(query, "weapi"));

export default recommendResource;
