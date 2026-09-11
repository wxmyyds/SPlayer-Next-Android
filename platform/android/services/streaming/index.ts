/**
 * Android 流媒体 API（bridge 接线入口）：
 * 服务器 CRUD / 连接 / 后台同步 / 媒体库快照与检索 / 播放地址 / 歌词，
 * 对齐上游 streaming: IPC 契约（shared/types/streaming.ts StreamingApi）。
 */

import type {
  StreamingConnectResult,
  StreamingLibrarySnapshot,
  StreamingPingResult,
  StreamingSearchResult,
  StreamingServerConfig,
  StreamingServerInput,
} from "@shared/types/streaming";
import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import {
  addStreamingServer,
  getStreamingConfig,
  getStreamingServer,
  removeStreamingServer,
  setActiveStreamingServer,
  updateStreamingServer,
} from "./config";
import {
  connectStreamingServer,
  testStreamingConnection,
  withStreamingAdapter,
} from "./connection";
import { deleteLibraryByServer, getLibrarySnapshot, searchLibrary } from "./library";
import { cancelStreamingSync, onStreamingLibraryUpdated, queueStreamingSync } from "./sync";
import { invalidateStreamingSession } from "./adapters/resolve";

/** 创建 Android 流媒体 API（供 bridge.ts 组装 window.api.streaming） */
export const createStreamingApi = () => ({
  loadServers: async (): Promise<{
    servers: StreamingServerConfig[];
    activeServerId: string | null;
  }> => getStreamingConfig(),
  addServer: async (input: StreamingServerInput): Promise<StreamingServerConfig> =>
    addStreamingServer(input),
  updateServer: async (
    serverId: string,
    input: StreamingServerInput,
  ): Promise<StreamingServerConfig> => {
    invalidateStreamingSession(serverId);
    cancelStreamingSync(serverId);
    return updateStreamingServer(serverId, input);
  },
  removeServer: async (serverId: string): Promise<void> => {
    invalidateStreamingSession(serverId);
    cancelStreamingSync(serverId);
    removeStreamingServer(serverId);
    await deleteLibraryByServer(serverId);
  },
  setActiveServer: async (serverId: string | null): Promise<void> =>
    setActiveStreamingServer(serverId),
  testConnection: (input: StreamingServerInput, serverId?: string): Promise<StreamingPingResult> =>
    testStreamingConnection(input, serverId),
  connect: (serverId: string): Promise<StreamingConnectResult> => connectStreamingServer(serverId),
  disconnect: async (serverId: string): Promise<void> => invalidateStreamingSession(serverId),
  getSnapshot: (serverId: string): Promise<StreamingLibrarySnapshot> =>
    getLibrarySnapshot(serverId),
  sync: (serverId: string, force = false): Promise<boolean> => {
    try {
      return Promise.resolve(queueStreamingSync(getStreamingServer(serverId), force));
    } catch (error) {
      console.warn("[streaming] sync failed:", error);
      return Promise.resolve(false);
    }
  },
  onLibraryUpdated: (callback: (serverId: string) => void): (() => void) =>
    onStreamingLibraryUpdated(callback),
  search: (serverId: string, query: string): Promise<StreamingSearchResult> =>
    searchLibrary(serverId, query.slice(0, 200)),
  getAlbumSongs: (serverId: string, albumId: string): Promise<Track[]> =>
    withStreamingAdapter(serverId, (config, adapter) => adapter.getAlbumSongs(config, albumId)),
  getPlaylistSongs: (serverId: string, playlistId: string): Promise<Track[]> =>
    withStreamingAdapter(serverId, (config, adapter) =>
      adapter.getPlaylistSongs(config, playlistId),
    ),
  getArtistAlbums: (serverId: string, artistId: string): Promise<Album[]> =>
    withStreamingAdapter(serverId, (config, adapter) => adapter.getArtistAlbums(config, artistId)),
  getArtistSongs: (serverId: string, artistId: string): Promise<Track[]> =>
    withStreamingAdapter(serverId, (config, adapter) => adapter.getArtistSongs(config, artistId)),
  getStreamUrl: (serverId: string, trackId: string, playSessionId?: string): Promise<string> =>
    withStreamingAdapter(serverId, (config, adapter) =>
      adapter.getStreamUrl(config, trackId, playSessionId),
    ),
  getLyrics: (
    serverId: string,
    trackId: string,
    hint?: { artist?: string; title?: string },
  ): Promise<string | null> =>
    withStreamingAdapter(serverId, (config, adapter) => adapter.getLyrics(config, trackId, hint)),
});

export type StreamingApiImpl = ReturnType<typeof createStreamingApi>;
