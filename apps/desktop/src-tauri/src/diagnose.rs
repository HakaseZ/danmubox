//! 一键诊断的外壳侧：环境信息、落盘位置与平台差异（`docs/operations.md` §2.9）。
//!
//! 采集在 `danmubox-core`、报告文本在 `danmubox-bili`，本模块只做三件事：
//! 把应用/系统版本凑齐、决定文件落在哪、把它写下去。**一次诊断只有一个文件**，
//! 因此这里没有临时文件、没有中转目录：桌面端直接写目标路径，Android 直接往
//! MediaStore 里插一条。

use danmubox_core::diagnose::ShellEnv;
#[cfg(target_os = "android")]
use tauri::Manager;

/// 报告文件名前缀（`docs/contract.md` §4.4）。
pub const FILE_PREFIX: &str = "danmubox-diagnose-";
/// 报告文件扩展名。
pub const FILE_SUFFIX: &str = ".txt";

/// 报告文件名：`danmubox-diagnose-YYYYMMDD-HHMMSS.txt`（**UTC**）。
///
/// 用 UTC 的理由见 `docs/contract.md` §4：全仓不引入本地时区换算。报告头里
/// 明写「UTC」，不给用户留「这时间跟我手机对不上」的疑点。
pub fn file_name(now_ms: i64) -> String {
    format!(
        "{FILE_PREFIX}{}{FILE_SUFFIX}",
        danmubox_core::diagnose::utc_parts(now_ms).stamp()
    )
}

/// 报告头要的平台与版本信息。
///
/// `engine` 由前端在**开始采集**时交上来（`navigator.userAgent`）：内核版本只有
/// 页面自己知道，而白屏一类问题恰恰同时取决于它（桌面端是 WKWebView / WebView2，
/// Android 是系统 WebView）。
pub fn shell_env(app: &tauri::AppHandle, engine: &str) -> ShellEnv {
    ShellEnv {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        engine: engine.to_string(),
        log_level: std::env::var("DANMUBOX_LOG").unwrap_or_else(|_| "info（默认）".to_string()),
    }
}

/// 写报告。返回**给用户看的位置**（Android 上是 `/sdcard/Download/<名字>`）。
pub async fn write_report(
    app: &tauri::AppHandle,
    name: &str,
    text: &str,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        android_write(app, name, text).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        write_to_downloads(name, text)
    }
}

/// 桌面三端：把报告写进**下载目录**（`downloads_dir()`），返回给用户看的位置。
///
/// 一次写一个文件：不写临时文件再改名（用户口径：一次诊断只出一个文件、中途不许落
/// 一堆临时文件）。窗口是 3 分钟一个、文件名带秒级时间戳，因此不存在「同一秒被写
/// 第二次」的覆盖风险。
pub fn write_to_downloads(name: &str, text: &str) -> Result<String, String> {
    write_report_into(&danmubox_core::downloads_dir(), name, text)
}

/// [`write_to_downloads`] 的目录可注入版：行为（文件名、内容、只落一个文件）与
/// 「写到哪个目录」是两件事，后者由平台口径决定、前者可以被直接断言。
pub fn write_report_into(dir: &std::path::Path, name: &str, text: &str) -> Result<String, String> {
    let path = dir.join(name);
    std::fs::write(&path, text).map_err(|err| format!("写入 {} 失败：{err}", path.display()))?;
    Ok(path.display().to_string())
}

/// Android：往**公共 `Download`** 目录插一条（MediaStore，API 29+ 不需要权限）。
///
/// 只写这一个位置：不碰应用私有目录、不写别的目录，因此设备上除了这一份报告
/// 不会多出任何东西（`docs/operations.md` §4.3）。
#[cfg(target_os = "android")]
async fn android_write(app: &tauri::AppHandle, name: &str, text: &str) -> Result<String, String> {
    use android::WriteArgs;

    // 用 `try_state` 而不是 `state`：拿不到句柄（插件没注册成功）时给一条能读的错误，
    // 而不是在命令里 panic。
    let handle = app
        .try_state::<android::Handle>()
        .ok_or_else(|| "原生写文件插件没有注册（DiagnosePlugin）".to_string())?;
    let reply: android::WriteReply = handle
        .0
        .run_mobile_plugin("writeDownload", WriteArgs { name, text })
        .map_err(|err| format!("写入公共下载目录失败：{err}"))?;
    Ok(reply.path)
}

/// Android 侧的原生写文件插件（Kotlin 实现在
/// `gen/android/app/src/main/java/dev/kksk/danmubox/DiagnosePlugin.kt`）。
///
/// 为什么必须落到原生：Android 10 起作用域存储生效，Rust 侧的 `std::fs` 写不进
/// 公共 `Download`；`MediaStore` 只有 Java/Kotlin 侧能用。这也是本仓库唯一一处
/// 「为落盘而写的原生代码」，桌面构建一字不变。
#[cfg(target_os = "android")]
pub mod android {
    use serde::{Deserialize, Serialize};
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{Manager, Runtime};

    /// 原生插件句柄。注册时放进 Tauri 的托管状态，导出命令从这里取。
    pub struct Handle(pub PluginHandle<tauri::Wry>);

    #[derive(Serialize)]
    pub struct WriteArgs<'a> {
        pub name: &'a str,
        pub text: &'a str,
    }

    #[derive(Deserialize)]
    pub struct WriteReply {
        /// 用户能照着找到的路径（`/sdcard/Download/<名字>`）。
        pub path: String,
    }

    pub fn plugin() -> TauriPlugin<tauri::Wry> {
        Builder::<tauri::Wry>::new("diagnose")
            .setup(|app, api| {
                let handle = api.register_android_plugin("dev.kksk.danmubox", "DiagnosePlugin")?;
                app.manage(Handle(handle));
                Ok(())
            })
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文件名就是用户要在下载目录里认出来的那个：前缀固定、时间戳是 UTC 的紧凑写法。
    #[test]
    fn file_name_is_the_contract_shape() {
        let name = file_name(1_789_531_954_000);
        assert_eq!(name, "danmubox-diagnose-20260916-041234.txt");
        assert!(name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX));
    }

    /// **一次诊断只出一个文件**（用户口径的硬要求）：写完之后目录里除了那一个文件
    /// 什么都没有（没有临时文件、没有第二个副本），内容逐字节等于给的文本。
    #[test]
    fn writing_a_report_leaves_exactly_one_file() {
        let dir = std::env::temp_dir().join(format!("danmubox-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");

        let name = file_name(1_789_531_954_000);
        let text = "danmubox 连接诊断报告\n（测试）\n";
        let path = write_report_into(&dir, &name, text).expect("写报告");

        assert_eq!(path, dir.join(&name).display().to_string());
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .expect("读目录")
            .map(|entry| {
                entry
                    .expect("目录项")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(
            entries,
            vec![name.clone()],
            "目录里只许有这一个文件：{entries:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(&name)).expect("读回"),
            text
        );

        std::fs::remove_dir_all(&dir).expect("清理");
    }
}
