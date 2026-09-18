package com.wxmyyds.splayer.next;

/**
 * rquickjs 引擎的 JNI 边界（实现在 android/js-engine/src/lib.rs）
 *
 * 生命周期：nativeCreate → nativeEval(bundle) → 多次 nativeCall → nativeDestroy。
 * nativeCall 串行（调用方单线程执行器保证）；Rust 侧泵 20s 截止。
 */
final class JsEngine {
    private JsEngine() {}

    /**
     * 创建引擎运行时
     * @return 引擎指针，失败返回 0
     */
    static native long nativeCreate();

    /**
     * 加载 bundle（IIFE 全局脚本）
     * @param ptr - 引擎指针
     * @param code - bundle 源码
     * @return 错误文本，成功返回空串
     */
    static native String nativeEval(long ptr, String code);

    /**
     * 调用 __engineCall 并泵至结果就绪
     * @param ptr - 引擎指针
     * @param argsJson - 请求 JSON
     * @return 结果 JSON（含 ok/error 字段，永不抛出）
     */
    static native String nativeCall(long ptr, String argsJson);

    /**
     * 销毁引擎
     * @param ptr - 引擎指针
     */
    static native void nativeDestroy(long ptr);
}
