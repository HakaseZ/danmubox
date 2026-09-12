//! 平台数据目录（`docs/contract.md` §4）。

use std::path::PathBuf;

/// 应用数据目录：凭据文件、偏好文件与日志都放这里。
///
/// 允许用环境变量 `DANMUBOX_HOME` 覆盖（测试与多环境并存时用）。
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("DANMUBOX_HOME") {
        return PathBuf::from(dir);
    }
    home_dir().join(APP_DIR)
}

/// 凭据文件路径。
pub fn config_path() -> PathBuf {
    data_dir().join("config.toml")
}

/// 偏好文件路径。
pub fn prefs_path() -> PathBuf {
    data_dir().join("prefs.json")
}

fn home_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

#[cfg(target_os = "macos")]
const APP_DIR: &str = "Library/Application Support/danmubox";
#[cfg(target_os = "windows")]
const APP_DIR: &str = "danmubox";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const APP_DIR: &str = ".local/share/danmubox";

#[cfg(test)]
mod tests {
    use super::*;

    /// 环境变量是进程级的，而 cargo 默认并发跑同一 binary 里的用例：
    /// 一个用例在设 `DANMUBOX_HOME`、另一个在删它，就会随机读到对方的状态。
    /// 这两个用例因此串行执行。
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn override_env_wins() {
        let _guard = env_guard();
        std::env::set_var("DANMUBOX_HOME", "/tmp/danmubox-test-home");
        assert_eq!(data_dir(), PathBuf::from("/tmp/danmubox-test-home"));
        assert_eq!(
            config_path(),
            PathBuf::from("/tmp/danmubox-test-home/config.toml")
        );
        assert_eq!(
            prefs_path(),
            PathBuf::from("/tmp/danmubox-test-home/prefs.json")
        );
        std::env::remove_var("DANMUBOX_HOME");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uses_application_support() {
        let _guard = env_guard();
        std::env::remove_var("DANMUBOX_HOME");
        assert!(data_dir().ends_with("Library/Application Support/danmubox"));
    }
}
