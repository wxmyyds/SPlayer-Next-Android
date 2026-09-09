package com.wxmyyds.splayer.next;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * 极简 SQLite 桥（Android 内置 android.database.sqlite，零新依赖）。
 *
 * 对标上游 dev 的 better-sqlite3 用法（建表 + 预编译读写），只是调用变异步：
 * - exec: 批量执行 DDL/DML（建表、增删改），无返回值
 * - query: SELECT 返回行数组（列值仅含 string/number/null，与 JSON 兼容）
 *
 * 库文件：getFilesDir()/database/library.db（与上游 library.db 同名），WAL 模式。
 * SQLiteOpenHelper 不接受含路径分隔符的库名，改为手动 openOrCreateDatabase；
 * 单连接长持有，请求串行在单线程池里，无线程竞争。
 */
@CapacitorPlugin(name = "SPlayerDb")
public class DbPlugin extends Plugin {

    private final ExecutorService queue = Executors.newSingleThreadExecutor();
    private SQLiteDatabase db;

    @Override
    public void load() {
        queue.execute(
                () -> {
                    try {
                        File dir = new File(getContext().getFilesDir(), "database");
                        if (!dir.exists()) dir.mkdirs();
                        db = SQLiteDatabase.openOrCreateDatabase(new File(dir, "library.db"), null);
                        db.enableWriteAheadLogging();
                    } catch (Exception ignored) {
                    }
                });
    }

    /** 批量执行 DDL/DML（分号分隔亦可，逐条执行） */
    @PluginMethod
    public void exec(PluginCall call) {
        String sql = call.getString("sql", "");
        if (sql.isEmpty()) {
            call.reject("missing sql");
            return;
        }
        queue.execute(
                () -> {
                    if (db == null) {
                        call.reject("database not ready");
                        return;
                    }
                    try {
                        for (String stmt : sql.split(";")) {
                            String trimmed = stmt.trim();
                            if (!trimmed.isEmpty()) db.execSQL(trimmed);
                        }
                        call.resolve();
                    } catch (Exception e) {
                        call.reject(e.getMessage(), e);
                    }
                });
    }

    /** 预编译写入（INSERT/UPDATE/DELETE）：values 按 ? 占位绑定 */
    @PluginMethod
    public void run(PluginCall call) {
        String sql = call.getString("sql", "");
        if (sql.isEmpty()) {
            call.reject("missing sql");
            return;
        }
        List<Object> values = toList(call.getArray("values", new JSArray()));
        queue.execute(
                () -> {
                    if (db == null) {
                        call.reject("database not ready");
                        return;
                    }
                    try {
                        SQLiteStatement stmt = db.compileStatement(sql);
                        try {
                            bind(stmt, values);
                            JSObject ret = new JSObject();
                            if (sql.trim().regionMatches(true, 0, "INSERT", 0, 6)) {
                                long rowId = stmt.executeInsert();
                                ret.put("lastInsertRowId", rowId);
                            } else {
                                // UPDATE/DELETE：executeInsert 会抛异常，用 executeUpdateDelete 取变更行数
                                ret.put("changes", stmt.executeUpdateDelete());
                            }
                            call.resolve(ret);
                        } finally {
                            stmt.close();
                        }
                    } catch (Exception e) {
                        call.reject(e.getMessage(), e);
                    }
                });
    }

    /** 查询：返回 { values: [row] }，列值仅 string/double/long/null */
    @PluginMethod
    public void query(PluginCall call) {
        String sql = call.getString("sql", "");
        if (sql.isEmpty()) {
            call.reject("missing sql");
            return;
        }
        List<Object> values = toList(call.getArray("values", new JSArray()));
        queue.execute(
                () -> {
                    if (db == null) {
                        call.reject("database not ready");
                        return;
                    }
                    try {
                        String[] args = new String[values.size()];
                        for (int i = 0; i < values.size(); i++) {
                            Object v = values.get(i);
                            args[i] = v == null ? null : String.valueOf(v);
                        }
                        JSArray rows = new JSArray();
                        try (Cursor cursor = db.rawQuery(sql, args)) {
                            String[] columns = cursor.getColumnNames();
                            while (cursor.moveToNext()) {
                                JSObject row = new JSObject();
                                for (int i = 0; i < columns.length; i++) {
                                    if (cursor.isNull(i)) {
                                        row.put(columns[i], JSObject.NULL);
                                    } else {
                                        switch (cursor.getType(i)) {
                                            case Cursor.FIELD_TYPE_INTEGER:
                                                row.put(columns[i], cursor.getLong(i));
                                                break;
                                            case Cursor.FIELD_TYPE_FLOAT:
                                                row.put(columns[i], cursor.getDouble(i));
                                                break;
                                            default:
                                                row.put(columns[i], cursor.getString(i));
                                                break;
                                        }
                                    }
                                }
                                rows.put(row);
                            }
                        }
                        JSObject ret = new JSObject();
                        ret.put("values", rows);
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject(e.getMessage(), e);
                    }
                });
    }

    private static List<Object> toList(JSArray array) {
        List<Object> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            Object v = array.opt(i);
            if (v == null || v == JSONObject.NULL) {
                out.add(null);
            } else if (v instanceof Number || v instanceof Boolean) {
                out.add(v);
            } else {
                out.add(String.valueOf(v));
            }
        }
        return out;
    }

    private static void bind(SQLiteStatement stmt, List<Object> values) {
        stmt.clearBindings();
        for (int i = 0; i < values.size(); i++) {
            Object v = values.get(i);
            int index = i + 1;
            if (v == null) {
                stmt.bindNull(index);
            } else if (v instanceof Double || v instanceof Float) {
                stmt.bindDouble(index, ((Number) v).doubleValue());
            } else if (v instanceof Number) {
                stmt.bindLong(index, ((Number) v).longValue());
            } else if (v instanceof Boolean) {
                stmt.bindLong(index, (Boolean) v ? 1 : 0);
            } else {
                stmt.bindString(index, String.valueOf(v));
            }
        }
    }
}
