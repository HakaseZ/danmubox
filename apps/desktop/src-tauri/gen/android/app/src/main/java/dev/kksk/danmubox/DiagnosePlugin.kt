package dev.kksk.danmubox

import android.app.Activity
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/** `writeDownload` 的入参（与 Rust 侧 `diagnose::android::WriteArgs` 一一对应）。 */
@InvokeArg
class WriteDownloadArgs {
  lateinit var name: String
  lateinit var text: String
}

/**
 * 一键诊断的 Android 落盘出口（`docs/operations.md` §2.9）。
 *
 * 为什么必须落到原生：Android 10（API 29）起的**作用域存储**里，应用不能再用
 * `std::fs` 往 `/sdcard/Download` 写文件 —— 那条路只有经 `MediaStore` 插入才成立，
 * 而 `MediaStore` 只有 Java/Kotlin 侧能调。于是 Rust 侧把渲染好的报告文本整串交过来
 * （一次调用一个文件，不经临时文件），这里把它写进**公共下载目录**。
 *
 * 不碰别的地方：不写应用私有目录、不写外部存储的其它目录，因此设备上除这一份报告
 * 不会多出任何东西（`docs/operations.md` §4.3）。
 *
 * API 29 以下**不支持**：那条路要 `WRITE_EXTERNAL_STORAGE`（本应用未声明存储类权限；权限清单见 `AndroidManifest.xml`），
 * 且 Android 10 之前没有 `MediaStore.Downloads`。这里明确回一句「不支持」，
 * 而不是偷偷写到应用私有目录去（用户口径：不要难找、不要污染设备）。
 */
@TauriPlugin
class DiagnosePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun writeDownload(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      invoke.reject("Android 10（API 29）以下不能写公共下载目录：那条路要 WRITE_EXTERNAL_STORAGE，本应用没有该权限")
      return
    }
    val args =
      try {
        invoke.parseArgs(WriteDownloadArgs::class.java)
      } catch (error: Exception) {
        invoke.reject("参数不合法：$error")
        return
      }

    val resolver = activity.contentResolver
    val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val values =
      ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, args.name)
        put(MediaStore.Downloads.MIME_TYPE, "text/plain")
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        // 先标 pending：写完之前别的应用（含文件管理器）看不到这个半成品。
        put(MediaStore.Downloads.IS_PENDING, 1)
      }

    val uri =
      try {
        resolver.insert(collection, values)
      } catch (error: Exception) {
        invoke.reject("在公共下载目录里新建文件失败：$error")
        return
      }
    if (uri == null) {
      invoke.reject("在公共下载目录里新建文件失败：MediaStore 没有返回 URI")
      return
    }

    try {
      val stream =
        resolver.openOutputStream(uri, "w") ?: throw IllegalStateException("打不开输出流")
      stream.use {
        it.write(args.text.toByteArray(Charsets.UTF_8))
        it.flush()
      }
    } catch (error: Exception) {
      // 半截文件不留：失败就把刚插进去的那条记录删掉。
      resolver.delete(uri, null, null)
      invoke.reject("写入公共下载目录失败：$error")
      return
    }

    values.clear()
    values.put(MediaStore.Downloads.IS_PENDING, 0)
    resolver.update(uri, values, null, null)

    val path =
      File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), args.name)
        .absolutePath
    val result = JSObject()
    result.put("path", path)
    invoke.resolve(result)
  }
}
