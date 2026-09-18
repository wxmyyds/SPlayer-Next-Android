//! 内嵌 JS 引擎（rquickjs 同步运行时）
//!
//! 架构：单线程 JS——所有 JS 执行都发生在 nativeCall 的调用线程上；
//! native JS 函数（HTTP/随机/存储）阻塞式完成，async JS 的续延经
//! execute_pending_job 泵推进；setTimeout 由调度堆 + 泵循环等待驱动。
//! WebView 冻结不影响本引擎（app 进程内普通线程，FGS 保活）。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use jni::objects::{JClass, JString, JObject, JValue};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;
use rquickjs::{Context, Function, Runtime, Value};
use rquickjs::prelude::Func;
use std::collections::BinaryHeap;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// JavaVM 指针（nativeCreate 时保存，JNI 回调用）
static JAVA_VM: AtomicI64 = AtomicI64::new(0);

/// 定时器堆条目
struct TimerEntry {
    fire_at: Instant,
    id: i64,
}

/// 小根堆按时间序（BinaryHeap 是大根堆，反转比较）
impl PartialEq for TimerEntry {
    fn eq(&self, other: &Self) -> bool {
        self.fire_at == other.fire_at && self.id == other.id
    }
}
impl Eq for TimerEntry {}
impl PartialOrd for TimerEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for TimerEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .fire_at
            .cmp(&self.fire_at)
            .then_with(|| other.id.cmp(&self.id))
    }
}

/// 定时器调度（泵线程消费）
#[derive(Default)]
struct TimerScheduler {
    heap: Mutex<BinaryHeap<TimerEntry>>,
    signal: Condvar,
}

impl TimerScheduler {
    /// 注册定时器
    fn push(&self, id: i64, delay_ms: u64) {
        let mut heap = self.heap.lock().unwrap();
        heap.push(TimerEntry {
            fire_at: Instant::now() + Duration::from_millis(delay_ms),
            id,
        });
        self.signal.notify_all();
    }

    /// 到期定时器出队
    fn take_due(&self) -> Vec<i64> {
        let mut heap = self.heap.lock().unwrap();
        let now = Instant::now();
        let mut due = Vec::new();
        while let Some(top) = heap.peek() {
            if top.fire_at <= now {
                due.push(heap.pop().unwrap().id);
            } else {
                break;
            }
        }
        due
    }

    /// 等到下一截止或被唤醒（整体截止时间兜底）
    fn wait_until(&self, overall_deadline: Instant) {
        let heap = self.heap.lock().unwrap();
        let next = heap.peek().map(|t| t.fire_at);
        let wait_until = next.map_or(overall_deadline, |t| t.min(overall_deadline));
        let timeout = wait_until.saturating_duration_since(Instant::now());
        if !timeout.is_zero() {
            let _ = self.signal.wait_timeout(heap, timeout);
        }
    }
}

/// 引擎状态
struct EngineState {
    runtime: Runtime,
    context: Context,
    timers: Arc<TimerScheduler>,
}

/// 取消注册表（Phase 1 占位：HTTP 取消语义由 Kotlin 侧 Call 池承接）
type CancelSet = Arc<Mutex<std::collections::HashSet<String>>>;

/// 把 Rust 字符串写成 Java 字符串
fn to_jstring(env: &mut JNIEnv, s: &str) -> jstring {
    match env.new_string(s) {
        Ok(j) => j.into_raw(),
        Err(_) => match env.new_string("") {
            Ok(j) => j.into_raw(),
            Err(_) => std::ptr::null_mut(),
        },
    }
}

/// 调 Kotlin 静态方法（返回字符串）；当前线程已由 JNI attach
fn call_java_str(method: &str, sig: &str, args: &[&str]) -> Option<String> {
    let vm_ptr = JAVA_VM.load(Ordering::SeqCst);
    if vm_ptr == 0 {
        return None;
    }
    let vm = unsafe { jni::JavaVM::from_raw(vm_ptr as *mut _).ok()? };
    let mut env = vm.attach_current_thread().ok()?;
    let Ok(class) = env.find_class("com/wxmyyds/splayer/next/JsEngineBridge") else {
        return None;
    };
    let mut jstrings: Vec<JString> = Vec::with_capacity(args.len());
    for a in args {
        jstrings.push(env.new_string(*a).ok()?);
    }
    let jargs: Vec<JValue> = jstrings.iter().map(|j| JValue::Object(j)).collect();
    let result = env.call_static_method(&class, method, sig, &jargs).ok()?;
    let obj: JObject = result.l().ok()?;
    let jstr = JString::from(obj);
    let s: String = env.get_string(&jstr).ok()?.into();
    Some(s)
}

/// 调 Kotlin 静态 void 方法
fn call_java_void(method: &str, sig: &str, args: &[&str]) {
    let vm_ptr = JAVA_VM.load(Ordering::SeqCst);
    if vm_ptr == 0 {
        return;
    }
    let vm = unsafe { jni::JavaVM::from_raw(vm_ptr as *mut _).ok() };
    let Some(vm) = vm else { return };
    let Ok(mut env) = vm.attach_current_thread() else {
        return;
    };
    let Ok(class) = env.find_class("com/wxmyyds/splayer/next/JsEngineBridge") else {
        return;
    };
    let mut jstrings: Vec<JString> = Vec::with_capacity(args.len());
    for a in args {
        let Ok(js) = env.new_string(*a) else { return };
        jstrings.push(js);
    }
    let jargs: Vec<JValue> = jstrings.iter().map(|j| JValue::Object(j)).collect();
    let _ = env.call_static_method(&class, method, sig, &jargs);
}

/// 写 logcat
fn log(level: &str, message: &str) {
    call_java_void(
        "logFromEngine",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[level, message],
    );
}

/// 读 SharedPreferences 存储
fn store_get(key: &str) -> Option<String> {
    call_java_str(
        "storeGetFromEngine",
        "(Ljava/lang/String;)Ljava/lang/String;",
        &[key],
    )
}

/// 写 SharedPreferences（value 空串 = 删除）
fn store_set(key: &str, value: &str) {
    call_java_void(
        "storeSetFromEngine",
        "(Ljava/lang/String;Ljava/lang/String;)V",
        &[key, value],
    );
}

/// 全量键集合（JSON 数组字符串）
fn store_keys() -> Option<String> {
    call_java_str("storeKeysFromEngine", "()Ljava/lang/String;", &[])
}

/// 密码学安全随机（base64）
fn random_b64(n: usize) -> Option<String> {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).ok()?;
    Some(B64.encode(&buf))
}

/// inflate 解压（base64 入出）
fn inflate(b64_data: &str, format: &str) -> Result<String, String> {
    let data = B64.decode(b64_data).map_err(|e| e.to_string())?;
    let mut decoder: Box<dyn std::io::Read> = match format {
        "gzip" => Box::new(flate2::read::GzDecoder::new(&data[..])),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(&data[..])),
        "deflate-raw" => Box::new(flate2::read::DeflateDecoder::new(&data[..])),
        other => return Err(format!("unsupported format: {other}")),
    };
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut out).map_err(|e| e.to_string())?;
    Ok(B64.encode(&out))
}

/// native 错误（JS 侧收到 Error）
fn native_err(message: &str) -> rquickjs::Error {
    rquickjs::Error::FromJs {
        from: "native",
        to: "engine",
        message: Some(message.to_string()),
    }
}

/// 创建运行时并注入原生函数
fn build_engine(state: &mut EngineState, cancel: CancelSet) -> Result<(), String> {
    let timers = state.timers.clone();
    state.context.with(|ctx| {
        // 随机
        ctx.globals()
            .set(
                "__nativeRandom",
                Func::from(move |n: f64| -> Result<String, rquickjs::Error> {
                    random_b64(n.clamp(0.0, 65536.0) as usize)
                        .ok_or_else(|| native_err("getrandom failed"))
                }),
            )
            .map_err(|e| e.to_string())?;

        // 存储
        ctx.globals()
            .set(
                "__nativeStoreGet",
                Func::from(move |key: String| -> Option<String> { store_get(&key) }),
            )
            .map_err(|e| e.to_string())?;
        ctx.globals()
            .set(
                "__nativeStoreSet",
                Func::from(move |key: String, value: String| {
                    store_set(&key, &value);
                }),
            )
            .map_err(|e| e.to_string())?;
        ctx.globals()
            .set(
                "__nativeStoreKeys",
                Func::from(|| -> String { store_keys().unwrap_or_else(|| "[]".into()) }),
            )
            .map_err(|e| e.to_string())?;

        // logcat
        ctx.globals()
            .set(
                "__nativeLog",
                Func::from(move |level: String, message: String| {
                    log(&level, &message);
                }),
            )
            .map_err(|e| e.to_string())?;

        // 定时器
        let timers_timer = timers.clone();
        ctx.globals()
            .set(
                "__nativeSetTimeout",
                Func::from(move |id: i64, ms: i64| {
                    timers_timer.push(id, ms.clamp(0, 60_000) as u64);
                }),
            )
            .map_err(|e| e.to_string())?;

        // inflate
        ctx.globals()
            .set(
                "__nativeInflate",
                Func::from(
                    |data: String, format: String| -> Result<String, rquickjs::Error> {
                        inflate(&data, &format).map_err(|e| native_err(&e))
                    },
                ),
            )
            .map_err(|e| e.to_string())?;

        // HTTP：阻塞式 OkHttp（Kotlin 侧管理 Call 池与取消）
        ctx.globals()
            .set(
                "__nativeHttp",
                Func::from(|req_json: String| -> Result<String, rquickjs::Error> {
                    call_java_str(
                        "httpFromEngine",
                        "(Ljava/lang/String;)Ljava/lang/String;",
                        &[req_json.as_str()],
                    )
                    .ok_or_else(|| native_err("native http unavailable"))
                }),
            )
            .map_err(|e| e.to_string())?;

        // HTTP 取消：转发 Kotlin 注册表
        let cancel = cancel.clone();
        ctx.globals()
            .set(
                "__nativeHttpCancel",
                Func::from(move |request_id: String| {
                    cancel.lock().unwrap().insert(request_id);
                }),
            )
            .map_err(|e| e.to_string())?;

        Ok::<(), String>(())
    })?;
    Ok(())
}

/// 泵 pending job 直到无任务
fn pump_jobs(runtime: &Runtime) {
    let mut guard = 0;
    while runtime.is_job_pending() && guard < 10_000 {
        let _ = runtime.execute_pending_job();
        guard += 1;
    }
}

/// 读结果哨兵（"R" 前缀成功 / "E" 前缀失败 / 未设置）
fn take_result(ctx: &rquickjs::Ctx) -> Option<Result<String, String>> {
    let raw: Option<String> = ctx.globals().get("__engineResult").ok();
    let raw = raw?;
    if let Some(stripped) = raw.strip_prefix('R') {
        return Some(Ok(stripped.to_string()));
    }
    if let Some(stripped) = raw.strip_prefix('E') {
        return Some(Err(stripped.to_string()));
    }
    None
}

/// 泵循环：推进 job 与定时器，直到取到结果或超时
fn pump_until_result(state: &EngineState, overall_deadline: Instant) -> Result<String, String> {
    state.context.with(|ctx| loop {
        pump_jobs(&state.runtime);
        if let Some(r) = take_result(&ctx) {
            return r;
        }
        if Instant::now() >= overall_deadline {
            return Err("engine resolve timeout".to_string());
        }
        // 到期定时器先执行（回 __timerFire）
        for id in state.timers.take_due() {
            let fire: Function = ctx.globals().get("__timerFire").map_err(|e| e.to_string())?;
            let fired: () = fire.call((id,)).map_err(|e| e.to_string())?;
            let _ = fired;
        }
        pump_jobs(&state.runtime);
        if let Some(r) = take_result(&ctx) {
            return r;
        }
        if Instant::now() >= overall_deadline {
            return Err("engine resolve timeout".to_string());
        }
        // 等下一截止或唤醒
        state.timers.wait_until(overall_deadline);
    })
}

/// 创建引擎
#[no_mangle]
pub extern "system" fn Java_com_wxmyyds_splayer_next_JsEngine_nativeCreate(
    env: &mut JNIEnv,
    _class: JClass,
) -> jlong {
    let Ok(vm) = env.get_java_vm() else {
        return 0;
    };
    JAVA_VM.store(vm.get_java_vm_pointer() as i64, Ordering::SeqCst);

    let Ok(runtime) = Runtime::new() else {
        return 0;
    };
    runtime.set_memory_limit(96 * 1024 * 1024);
    runtime.set_max_stack_size(4 * 1024 * 1024);
    let Ok(context) = Context::full(&runtime) else {
        return 0;
    };
    let mut state = EngineState {
        runtime,
        context,
        timers: Arc::new(TimerScheduler::default()),
    };
    let cancel: CancelSet = Arc::new(Mutex::new(std::collections::HashSet::new()));
    if build_engine(&mut state, cancel).is_err() {
        return 0;
    }
    Box::into_raw(Box::new(state)) as jlong
}

/// 加载 bundle（IIFE 脚本），失败返回错误文本
#[no_mangle]
pub extern "system" fn Java_com_wxmyyds_splayer_next_JsEngine_nativeEval(
    env: &mut JNIEnv,
    _class: JClass,
    ptr: jlong,
    code: JString,
) -> jstring {
    let Ok(code) = env.get_string(&code) else {
        return to_jstring(env, "bad code string");
    };
    let code: String = code.into();
    let state = unsafe { &mut *(ptr as *mut EngineState) };
    let result: Result<(), String> =
        state
            .context
            .with(|ctx| ctx.eval::<(), _>(code.as_bytes()).map_err(|e| e.to_string()));
    match result {
        Ok(()) => to_jstring(env, ""),
        Err(e) => to_jstring(env, &e),
    }
}

/// 调用 globalThis.__engineCall（fire 后泵至结果就绪）
#[no_mangle]
pub extern "system" fn Java_com_wxmyyds_splayer_next_JsEngine_nativeCall(
    env: &mut JNIEnv,
    _class: JClass,
    ptr: jlong,
    args: JString,
) -> jstring {
    let Ok(args) = env.get_string(&args) else {
        return to_jstring(env, "{\"ok\":false,\"error\":\"bad args\"}");
    };
    let args: String = args.into();
    let state = unsafe { &mut *(ptr as *mut EngineState) };
    let deadline = Instant::now() + Duration::from_secs(20);

    let kick: Result<(), String> = state.context.with(|ctx| {
        ctx.globals()
            .set("__engineResult", Value::new_undefined(ctx.clone()))
            .map_err(|e| e.to_string())?;
        let call: Function = ctx.globals().get("__engineCall").map_err(|e| e.to_string())?;
        let fired: () = call.call((args,)).map_err(|e| e.to_string())?;
        let _ = fired;
        Ok(())
    });
    if let Err(e) = kick {
        let msg = serde_json::to_string(&e).unwrap_or_else(|_| "\"engine kick failed\"".into());
        return to_jstring(env, &format!("{{\"ok\":false,\"error\":{msg}}}"));
    }
    match pump_until_result(state, deadline) {
        Ok(s) => to_jstring(env, &s),
        Err(e) => {
            let msg = serde_json::to_string(&e).unwrap_or_else(|_| "\"engine pump failed\"".into());
            to_jstring(env, &format!("{{\"ok\":false,\"error\":{msg}}}"))
        }
    }
}

/// 销毁引擎
#[no_mangle]
pub extern "system" fn Java_com_wxmyyds_splayer_next_JsEngine_nativeDestroy(
    _env: &mut JNIEnv,
    _class: JClass,
    ptr: jlong,
) {
    if ptr != 0 {
        unsafe {
            drop(Box::from_raw(ptr as *mut EngineState));
        }
    }
}
