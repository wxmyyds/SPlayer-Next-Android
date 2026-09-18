package com.wxmyyds.splayer.next;

import android.content.ContentValues;
import android.database.Cursor;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okio.BufferedSource;

/**
 * 下载落盘插件（MediaStore + OkHttp 流式）：
 * 音频写入公共 Music/SPlayer（API 29+ MediaStore，低版本回退应用专属外部目录），
 * 歌词等文本写公共 Download/SPlayer。进度/状态经 "event" 监听推给桥接层，
 * 顺序下载由 JS 队列驱动，这里只负责单条传输。
 */
@CapacitorPlugin(name = "DownloadSaver")
public class DownloadPlugin extends Plugin {

    private static final String MUSIC_DIR = "SPlayer";
    /** 进度推送步长：每 512KB 或完成时各推一次 */
    private static final long PROGRESS_STEP_BYTES = 512 * 1024;

    private static final OkHttpClient CLIENT =
            new OkHttpClient.Builder()
                    .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                    .build();

    /** 单条音频传输执行器：同一时刻一条（顺序下载由 JS 队列保证） */
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final Map<String, okhttp3.Call> activeCalls = new ConcurrentHashMap<>();

    /** 音频扩展名 → MIME（落库分组用） */
    private static String audioMime(String ext) {
        switch (ext) {
            case "flac": return "audio/flac";
            case "m4a": return "audio/mp4";
            case "ogg": return "audio/ogg";
            case "opus": return "audio/ogg";
            case "wav": return "audio/wav";
            case "aac": return "audio/aac";
            case "ape": return "audio/x-ape";
            default: return "audio/mpeg";
        }
    }

    /** 清洗文件名非法字符 */
    private static String sanitize(String name) {
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    /** API 29- 用应用专属音乐目录 */
    private File legacyMusicDir() {
        File dir = new File(
                getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC), MUSIC_DIR);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** legacy 路径同名冲突时追加序号（对齐 MediaStore 的 "xxx (1)" 行为），不静默覆盖既有文件 */
    private File legacyConflictFreeTarget(String name) {
        File dir = legacyMusicDir();
        File target = new File(dir, name);
        if (!target.exists()) return target;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; target.exists(); i++) {
            target = new File(dir, base + " (" + i + ")" + ext);
        }
        return target;
    }

    /**
     * 下载音频到公共媒体库
     * @param call - { taskId, url, displayName, ext, title, artist, album, declaredSize }
     */
    /**
     * 删除已完成的下载文件（兑现"删除记录并删除本地文件"语义）
     * @param path saveAudio 返回的 filePath，只允许下载目录内的文件
     */
    @PluginMethod
    public void deleteAudio(PluginCall call) {
        String path = call.getString("path", "");
        if (path.isEmpty()) {
            call.reject("path required");
            return;
        }
        Context ctx = getContext();
        pool.execute(() -> {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    String base = Environment.getExternalStorageDirectory().getAbsolutePath()
                            + "/" + Environment.DIRECTORY_MUSIC + "/" + MUSIC_DIR + "/";
                    if (!path.startsWith(base)) {
                        call.reject("path outside download dir");
                        return;
                    }
                    String displayName = new File(path).getName();
                    int deleted = ctx.getContentResolver().delete(
                            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                            MediaStore.Audio.Media.DISPLAY_NAME + "=? AND "
                                    + MediaStore.Audio.Media.RELATIVE_PATH + "=?",
                            new String[] {
                                displayName,
                                Environment.DIRECTORY_MUSIC + "/" + MUSIC_DIR
                            });
                    if (deleted == 0) {
                        // MediaStore 行已不在（被系统/用户清理）时直接删残留文件
                        new File(path).delete();
                    }
                } else {
                    File dir = legacyMusicDir();
                    File target = new File(path);
                    if (!target.getCanonicalPath().startsWith(dir.getCanonicalPath())) {
                        call.reject("path outside download dir");
                        return;
                    }
                    target.delete();
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void saveAudio(PluginCall call) {
        String taskId = call.getString("taskId", "");
        String url = call.getString("url", "");
        String ext = call.getString("ext", "mp3");
        String name = sanitize(call.getString("displayName", taskId)) + "." + ext;
        if (taskId.isEmpty() || url.isEmpty()) {
            call.reject("taskId/url required");
            return;
        }
        String title = call.getString("title", "");
        String artist = call.getString("artist", "");
        String album = call.getString("album", "");
        final long declaredSize = call.getData().opt("declaredSize") instanceof Number
                ? ((Number) call.getData().opt("declaredSize")).longValue() : 0L;
        String mime = audioMime(ext);
        Context ctx = getContext();
        pool.execute(() -> {
            Uri contentUri = null;
            File legacyFile = null;
            File legacyFinal = null;
            try {
                Request request = new Request.Builder().url(url).build();
                okhttp3.Call httpCall = CLIENT.newCall(request);
                activeCalls.put(taskId, httpCall);
                try (Response response = httpCall.execute()) {
                    if (!response.isSuccessful()) {
                        throw new IOException("HTTP " + response.code());
                    }
                    BufferedSource source = response.body() != null
                            ? response.body().source() : null;
                    if (source == null) throw new IOException("empty body");

                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Audio.Media.DISPLAY_NAME, name);
                        values.put(MediaStore.Audio.Media.MIME_TYPE, mime);
                        values.put(MediaStore.Audio.Media.RELATIVE_PATH,
                                Environment.DIRECTORY_MUSIC + "/" + MUSIC_DIR);
                        values.put(MediaStore.Audio.Media.IS_PENDING, 1);
                        contentUri = ctx.getContentResolver().insert(
                                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values);
                        if (contentUri == null) throw new IOException("MediaStore insert failed");
                        try (OutputStream out =
                                ctx.getContentResolver().openOutputStream(contentUri)) {
                            pipe(taskId, source, out, declaredSize);
                        }
                    } else {
                        legacyFile = new File(legacyMusicDir(), name + ".part");
                        try (OutputStream out = new FileOutputStream(legacyFile)) {
                            pipe(taskId, source, out, declaredSize);
                        }
                    }
                }
                if (activeCalls.remove(taskId) == null) {
                    // 已被 cancel：清理半成品后不再 emit（cancel 方负责状态）；
                    // call 必须有终态，否则 JS 侧 await saveAudio 永久悬挂
                    cleanup(ctx, contentUri, legacyFile);
                    call.resolve();
                    return;
                }
                String path;
                if (contentUri != null) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Audio.Media.IS_PENDING, 0);
                    if (!title.isEmpty()) values.put(MediaStore.Audio.Media.TITLE, title);
                    if (!artist.isEmpty()) values.put(MediaStore.Audio.Media.ARTIST, artist);
                    if (!album.isEmpty()) values.put(MediaStore.Audio.Media.ALBUM, album);
                    ctx.getContentResolver().update(contentUri, values, null, null);
                    // 同 RELATIVE_PATH 同 DISPLAY_NAME 时 MediaStore 自动改存 "xxx (1).ext"，
                    // 必须读回实际文件名拼路径，否则 filePath 指向不存在的文件
                    String actualName = name;
                    try (Cursor c = ctx.getContentResolver().query(
                            contentUri,
                            new String[] {MediaStore.Audio.Media.DISPLAY_NAME},
                            null,
                            null,
                            null)) {
                        if (c != null && c.moveToFirst()) {
                            String n = c.getString(0);
                            if (n != null && !n.isEmpty()) actualName = n;
                        }
                    } catch (Exception ignored) {
                        // 读回失败时退回原始名（同名冲突场景退化）
                    }
                    path = Environment.getExternalStorageDirectory().getAbsolutePath()
                            + "/" + Environment.DIRECTORY_MUSIC + "/" + MUSIC_DIR + "/" + actualName;
                } else {
                    legacyFinal = legacyConflictFreeTarget(name);
                    if (!legacyFile.renameTo(legacyFinal)) throw new IOException("rename failed");
                    path = legacyFinal != null ? legacyFinal.getAbsolutePath() : "";
                }
                JSObject ret = new JSObject();
                ret.put("taskId", taskId);
                ret.put("filePath", path);
                emitState(ret);
                call.resolve();
            } catch (Exception e) {
                // 只清理本次产物；注意不能按最终文件名删——失败可能发生在任何产物创建前，
                // 那样会误删之前已完成的同名下载
                cleanup(ctx, contentUri, legacyFile);
                activeCalls.remove(taskId);
                JSObject ret = new JSObject();
                ret.put("taskId", taskId);
                ret.put("errorCode", e.getMessage() != null ? e.getMessage() : "unknown");
                emitState(ret);
                call.reject(e.getMessage(), e);
            }
        });
    }

    /** 边读边写 + 进度事件 */
    private void pipe(String taskId, BufferedSource source, OutputStream out, long total)
            throws IOException {
        long received = 0;
        long lastEmitted = 0;
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = source.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            received += read;
            if (received - lastEmitted >= PROGRESS_STEP_BYTES) {
                lastEmitted = received;
                JSObject progress = new JSObject();
                progress.put("taskId", taskId);
                progress.put("received", received);
                progress.put("total", total);
                notifyListeners("event", progressEvent(progress));
            }
        }
        out.flush();
    }

    private JSObject progressEvent(JSObject progress) {
        JSObject event = new JSObject();
        event.put("type", "progress");
        event.put("data", progress);
        return event;
    }

    private void emitState(JSObject data) {
        JSObject event = new JSObject();
        event.put("type", "state");
        event.put("data", data);
        notifyListeners("event", event);
    }

    /** 半成品清理：删除 pending 行或 .part 文件 */
    private void cleanup(Context ctx, Uri contentUri, File legacyFile) {
        try {
            if (contentUri != null) {
                ctx.getContentResolver().delete(contentUri, null, null);
            } else if (legacyFile != null && legacyFile.exists()) {
                legacyFile.delete();
            }
        } catch (Exception ignored) {
            // 清理失败不影响错误上报
        }
    }

    /**
     * 写文本伴生文件（.lrc / .ttml）
     * @param call - { name, content, audio }
     */
    @PluginMethod
    public void saveText(PluginCall call) {
        String name = sanitize(call.getString("name", ""));
        String content = call.getString("content", "");
        boolean audio = Boolean.TRUE.equals(call.getBoolean("audio", false));
        if (name.isEmpty()) {
            call.reject("name required");
            return;
        }
        Uri pendingUri = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/" + MUSIC_DIR);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("MediaStore insert failed");
                pendingUri = uri;
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new IOException("output stream null");
                    out.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, values, null, null);
            } else {
                File dir = legacyMusicDir();
                try (FileOutputStream out = new FileOutputStream(new File(dir, name))) {
                    out.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
            }
            call.resolve();
        } catch (Exception e) {
            // 与 saveAudio 一致：失败时删除 pending 行，否则媒体扫描器里残留幽灵条目
            if (pendingUri != null) {
                try {
                    getContext().getContentResolver().delete(pendingUri, null, null);
                } catch (Exception ignored) {
                    // 清理失败不影响错误上报
                }
            }
            call.reject(e.getMessage(), e);
        }
    }

    /**
     * 取消在途下载
     * @param call - { taskId }
     */
    @PluginMethod
    public void cancel(PluginCall call) {
        String taskId = call.getString("taskId", "");
        okhttp3.Call httpCall = activeCalls.remove(taskId);
        if (httpCall != null) httpCall.cancel();
        call.resolve();
    }

    /**
     * 查询下载目录展示路径
     * @param call - {}
     */
    @PluginMethod
    public void getDir(PluginCall call) {
        String path;
        if (Build.VERSION.SDK_INT >= 29) {
            path = "/storage/emulated/0/" + Environment.DIRECTORY_MUSIC + "/" + MUSIC_DIR;
        } else {
            path = legacyMusicDir().getAbsolutePath();
        }
        JSObject ret = new JSObject();
        ret.put("path", path);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        pool.shutdownNow();
        for (okhttp3.Call httpCall : activeCalls.values()) httpCall.cancel();
        activeCalls.clear();
        super.handleOnDestroy();
    }
}
