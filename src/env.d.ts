/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/vue" />

import type { AndroidApi } from "@android/bridge";

declare global {
  const __APP_VERSION__: string;
  const __APP_REPO_URL__: string;
  const __APP_REPO_NAME__: string;
  const __APP_AUTHOR__: string;
  const __APP_HOMEPAGE__: string;
  const __APP_AUTHOR_URL__: string;
  const __COMMIT_HASH__: string;
  const __COMMIT_DATE__: string;

  interface Window {
    __splashStart?: number;
    api: AndroidApi;
  }
}

export {};
