/**
 * 引擎垫片统一安装入口
 */

import { installEncoding } from "./encoding";
import { installUrl } from "./url";
import { installDom } from "./dom";
import { installCrypto } from "./crypto";
import { installStorage } from "./storage";

/**
 * 安装全部垫片（幂等：重复安装覆盖同名全局）
 */
export const installAll = (): void => {
  installEncoding();
  installUrl();
  installDom();
  installCrypto();
  installStorage();
};
