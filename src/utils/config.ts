/** 是否为开发环境 */
export const isDev = import.meta.env.MODE === "development" || import.meta.env.DEV;

/** 应用版本号 */
export const APP_VERSION = __APP_VERSION__;

/** 仓库地址 */
export const REPO_URL = __APP_REPO_URL__;
/** 项目名称 */
export const REPO_NAME = __APP_REPO_NAME__;
/** 版权署名 */
export const COPYRIGHT_HOLDER = __APP_AUTHOR__;
/** 官网地址 */
export const HOMEPAGE_URL = __APP_HOMEPAGE__;
/** 作者主页 */
export const AUTHOR_URL = __APP_AUTHOR_URL__;
/** Git 提交哈希 */
export const COMMIT_HASH = __COMMIT_HASH__;
/** Git 提交日期 */
export const COMMIT_DATE = __COMMIT_DATE__;
