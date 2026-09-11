import type { StreamingLibrarySnapshot, StreamingSearchResult } from "@shared/types/streaming";
import { deleteTracksByServer, getTracks, searchTracks } from "@android/db/streaming";
import { deleteAlbumsByServer, getAlbums } from "@android/db/streaming";
import { deleteArtistsByServer, getArtists } from "@android/db/streaming";
import { deletePlaylistsByServer, getPlaylists } from "@android/db/streaming";

/**
 * 删除指定服务器的全部流媒体数据
 * @param serverId - 服务器 ID
 */
export const deleteLibraryByServer = async (serverId: string): Promise<void> => {
  await deletePlaylistsByServer(serverId);
  await deleteTracksByServer(serverId);
  await deleteAlbumsByServer(serverId);
  await deleteArtistsByServer(serverId);
};

/**
 * 读取一个服务器当前已经写入 SQLite 的完整媒体快照
 * @param serverId - 服务器 ID
 * @returns 完整媒体库快照
 */
export const getLibrarySnapshot = async (serverId: string): Promise<StreamingLibrarySnapshot> => ({
  songs: await getTracks(serverId),
  albums: await getAlbums(serverId),
  artists: await getArtists(serverId),
  playlists: await getPlaylists(serverId),
});

/**
 * 在 SQLite 快照中搜索歌曲、专辑和歌手
 * @param serverId - 服务器 ID
 * @param query - 搜索词
 * @returns 聚合搜索结果
 */
export const searchLibrary = async (
  serverId: string,
  query: string,
): Promise<StreamingSearchResult> => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return { songs: [], albums: [], artists: [] };
  const [albums, artists] = await Promise.all([getAlbums(serverId), getArtists(serverId)]);
  return {
    songs: await searchTracks(serverId, query),
    albums: albums.filter(
      (album) =>
        album.name.toLocaleLowerCase().includes(needle) ||
        album.artist?.toLocaleLowerCase().includes(needle),
    ),
    artists: artists.filter((artist) => artist.name.toLocaleLowerCase().includes(needle)),
  };
};
