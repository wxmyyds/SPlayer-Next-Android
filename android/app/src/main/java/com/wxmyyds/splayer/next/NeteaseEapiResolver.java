package com.wxmyyds.splayer.next;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;
import okhttp3.FormBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 网易云 eapi 歌曲地址原生解析器（锁屏兜底自治切歌）：
 * WebView 冻结时 JS 无法解析 URL，ENDED 后由原生按 eapi 固定算法直接向
 * interface.music.163.com 解析下一首，队列自治推进完全不依赖 WebView（参照 SFA）。
 * 算法与 platform/android/vendor/netease/core/crypto.ts 的 eapi() 保持一致；
 * 易变的设备指纹/cookie 由 JS 下发（resolve 上下文），原生只实现不变的加密与请求。
 */
public final class NeteaseEapiResolver {

    private static final String TAG = "EapiResolver";
    private static final String EAPI_KEY = "e82ckenh8dichen8";
    private static final String SEPARATOR = "-36cd479b6b5-";
    private static final String API_DOMAIN = "https://interface.music.163.com";

    private static final OkHttpClient CLIENT =
            new OkHttpClient.Builder()
                    .connectTimeout(8, TimeUnit.SECONDS)
                    .readTimeout(8, TimeUnit.SECONDS)
                    .build();

    private NeteaseEapiResolver() {}

    /**
     * 解析歌曲播放地址
     * @param ctx JS 下发的解析上下文（path/header/cookie/userAgent）
     * @param songId 网易云歌曲数字 id
     * @param level 音质档位（standard/exhigh/lossless/hires 等）
     * @returns 播放地址
     */
    public static String resolve(JSONObject ctx, String songId, String level) throws Exception {
        String path = ctx.optString("path", "/api/song/enhance/player/url/v1");
        JSONObject header = ctx.optJSONObject("header");
        if (header == null) header = new JSONObject();

        JSONObject payload = new JSONObject();
        payload.put("ids", "[" + songId + "]");
        payload.put("level", level);
        payload.put("encodeType", "flac");
        payload.put("header", header);

        String text = payload.toString();
        String digest = md5Hex("nobody" + path + "use" + text + "md5forencrypt");
        String data = path + SEPARATOR + text + SEPARATOR + digest;
        String params = hexEncode(aesEcb(EAPI_KEY, data.getBytes(StandardCharsets.UTF_8), true));

        Request request =
                new Request.Builder()
                        .url(API_DOMAIN + "/eapi" + path.substring(4))
                        .header("User-Agent", ctx.optString("userAgent", "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)"))
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .header("Cookie", ctx.optString("cookie", ""))
                        .post(new FormBody.Builder().add("params", params).build())
                        .build();

        try (okhttp3.Response res = CLIENT.newCall(request).execute()) {
            String bodyStr = res.body() != null ? res.body().string() : "";
            JSONObject json;
            try {
                json = new JSONObject(bodyStr);
            } catch (Exception notPlain) {
                // 兼容 e_r=true 的加密响应：hex 密文 AES-ECB 解密后为 JSON
                json = new JSONObject(new String(aesEcb(EAPI_KEY, hexDecode(bodyStr.trim()), false), StandardCharsets.UTF_8));
            }
            int code = json.optInt("code", 0);
            if (code != 200) {
                throw new IOException("eapi code=" + code);
            }
            JSONArray arr = json.optJSONArray("data");
            if (arr == null || arr.length() == 0) {
                throw new IOException("eapi empty data");
            }
            String url = arr.optJSONObject(0).optString("url", "");
            if (url.isEmpty()) {
                throw new IOException("eapi url null (vip/copyright)");
            }
            Log.i(TAG, "resolved songId=" + songId + " level=" + level);
            return url;
        }
    }

    /** AES-128-ECB PKCS5；encrypt=false 时为解密 */
    private static byte[] aesEcb(String key, byte[] input, boolean encrypt) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(
                encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE,
                new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"));
        return cipher.doFinal(input);
    }

    private static String md5Hex(String text) throws Exception {
        byte[] digest = MessageDigest.getInstance("MD5").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private static String hexEncode(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02X", b));
        }
        return sb.toString();
    }

    private static byte[] hexDecode(String hex) throws IOException {
        int len = hex.length();
        if (len == 0 || len % 2 != 0) {
            throw new IOException("bad hex response");
        }
        byte[] out = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            out[i / 2] = (byte) Integer.parseInt(hex.substring(i, i + 2), 16);
        }
        return out;
    }
}
