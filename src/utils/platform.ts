/**
 * 是否为 Android 构建（运行在 Capacitor Android 壳内）。
 * 由 platform/android/vite.config.ts 在构建时注入 VITE_PLATFORM，桌面端构建不会定义该值。
 */
export const isAndroid = import.meta.env.VITE_PLATFORM === "android";
