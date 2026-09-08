/** 插件持久化：使用独立 IndexedDB store 保存脚本、清单、设置和插件数据。 */

import localforage from "localforage";
import type { PluginManifest } from "@shared/types/plugin";

const db = localforage.createInstance({ name: "splayer", storeName: "plugins" });

type JsonMap = Record<string, unknown>;

const readMap = async <T extends JsonMap>(key: string): Promise<T> =>
  (await db.getItem<T>(key)) ?? ({} as T);

export const readManifests = (): Promise<Record<string, PluginManifest>> =>
  readMap<Record<string, PluginManifest>>("manifests");

export const writeManifests = (value: Record<string, PluginManifest>): Promise<void> =>
  db.setItem("manifests", value).then(() => undefined);

export const readScript = async (id: string): Promise<string | null> =>
  (await db.getItem<string>(`script:${id}`)) ?? null;

export const writeScript = (id: string, source: string): Promise<void> =>
  db.setItem(`script:${id}`, source).then(() => undefined);

export const removeScript = (id: string): Promise<void> => db.removeItem(`script:${id}`);

export const readEnabled = (): Promise<Record<string, boolean>> =>
  readMap<Record<string, boolean>>("enabled");

export const writeEnabled = (value: Record<string, boolean>): Promise<void> =>
  db.setItem("enabled", value).then(() => undefined);

export const readSettings = (id: string): Promise<Record<string, unknown>> =>
  readMap<Record<string, unknown>>(`settings:${id}`);

export const writeSettings = (id: string, value: Record<string, unknown>): Promise<void> =>
  db.setItem(`settings:${id}`, value).then(() => undefined);

const readData = (id: string): Promise<JsonMap> => readMap<JsonMap>(`data:${id}`);

export const dataGet = async <T = unknown>(id: string, key: string): Promise<T | null> => {
  const data = await readData(id);
  return (key in data ? data[key] : null) as T | null;
};

export const dataSet = async (id: string, key: string, value: unknown): Promise<void> => {
  const data = await readData(id);
  data[key] = value;
  await db.setItem(`data:${id}`, data);
};

export const dataRemove = async (id: string, key: string): Promise<void> => {
  const data = await readData(id);
  delete data[key];
  await db.setItem(`data:${id}`, data);
};

export const dataKeys = async (id: string): Promise<string[]> => Object.keys(await readData(id));

export const dataDrop = async (id: string): Promise<void> => {
  await db.removeItem(`data:${id}`);
  await db.removeItem(`settings:${id}`);
};
