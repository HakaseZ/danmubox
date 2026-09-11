//! 凭据文件 `config.toml`（`docs/contract.md` §4.1）。
//!
//! 形态：**明文 TOML**，权限 `0600`，写入走临时文件 + rename。
//! 多账号用 `[profiles.<name>]` 承载，`active_profile` 指定当前生效者。
//!
//! 本模块只负责「存与取」，不做任何网络请求；登录流程在 `danmubox-bili`。
//! 凭据值**绝不**出现在日志里——`Debug` 实现已手写作遮蔽处理。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// 一个 profile 的七个凭据字段（与契约 §4.1 的 TOML 示例一一对应）。
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub sessdata: String,
    #[serde(default)]
    pub bili_jct: String,
    #[serde(default)]
    pub dede_user_id: String,
    #[serde(default)]
    pub dede_user_id_ck_md5: String,
    #[serde(default)]
    pub buvid3: String,
    #[serde(default)]
    pub buvid4: String,
    #[serde(default)]
    pub sid: String,
}

impl std::fmt::Debug for Profile {
    /// 手写实现：只暴露「哪些字段有值」，不暴露值本身。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let filled: Vec<&str> = [
            ("sessdata", &self.sessdata),
            ("bili_jct", &self.bili_jct),
            ("dede_user_id", &self.dede_user_id),
            ("dede_user_id_ck_md5", &self.dede_user_id_ck_md5),
            ("buvid3", &self.buvid3),
            ("buvid4", &self.buvid4),
            ("sid", &self.sid),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, _)| k)
        .collect();
        f.debug_struct("Profile")
            .field("filled", &filled)
            .finish_non_exhaustive()
    }
}

impl Profile {
    /// 可直接进入登录态的三要素（`docs/contract.md` §4.1）。
    pub fn is_complete(&self) -> bool {
        !self.sessdata.is_empty() && !self.bili_jct.is_empty() && !self.dede_user_id.is_empty()
    }

    pub fn uid(&self) -> i64 {
        self.dede_user_id.parse().unwrap_or(0)
    }

    /// 组装 Cookie 请求头；只包含非空字段。
    pub fn cookie_header(&self) -> Option<String> {
        let pairs = [
            ("SESSDATA", &self.sessdata),
            ("bili_jct", &self.bili_jct),
            ("DedeUserID", &self.dede_user_id),
            ("DedeUserID__ckMd5", &self.dede_user_id_ck_md5),
            ("buvid3", &self.buvid3),
            ("sid", &self.sid),
        ];
        let joined: Vec<String> = pairs
            .iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        if joined.is_empty() {
            None
        } else {
            Some(joined.join("; "))
        }
    }

    /// 清空全部字段（登出）。
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

/// `config.toml` 的完整内容。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_profile_name")]
    pub active_profile: String,
    #[serde(default)]
    pub profiles: BTreeMap<String, Profile>,
}

fn default_profile_name() -> String {
    DEFAULT_PROFILE.to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            active_profile: default_profile_name(),
            profiles: BTreeMap::new(),
        }
    }
}

impl std::fmt::Debug for AppConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppConfig")
            .field("active_profile", &self.active_profile)
            .field("profiles", &self.profiles.keys().collect::<Vec<_>>())
            .finish()
    }
}

pub const DEFAULT_PROFILE: &str = "default";

/// 凭据文件的内存态 + 落盘点。适配器通过它读取当前 Cookie，
/// 因此切换 profile 后无需重建 HTTP 客户端。
pub struct ConfigStore {
    path: PathBuf,
    config: RwLock<AppConfig>,
}

impl ConfigStore {
    /// 读取凭据文件。文件不存在按「空配置」处理；
    /// 文件存在但解析失败则报错——**不得**覆盖用户手工编辑过的文件。
    pub fn load(path: PathBuf) -> Result<Self> {
        let config = if path.exists() {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| Error::Internal(format!("读取 {} 失败: {e}", path.display())))?;
            toml::from_str::<AppConfig>(&raw).map_err(|e| {
                Error::Internal(format!(
                    "{} 解析失败（已保留原文件，未做改动）: {e}",
                    path.display()
                ))
            })?
        } else {
            AppConfig::default()
        };
        Ok(Self {
            path,
            config: RwLock::new(config),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn snapshot(&self) -> AppConfig {
        self.config.read().expect("config poisoned").clone()
    }

    pub fn active_name(&self) -> String {
        self.config
            .read()
            .expect("config poisoned")
            .active_profile
            .clone()
    }

    pub fn active(&self) -> Option<Profile> {
        let config = self.config.read().expect("config poisoned");
        config.profiles.get(&config.active_profile).cloned()
    }

    /// 当前生效的 Cookie 头；游客态返回 `None`。
    pub fn cookie_header(&self) -> Option<String> {
        self.active().and_then(|p| p.cookie_header())
    }

    /// 当前生效 profile 的 `buvid3`（登录后由上游下发，可复用为设备标识）。
    pub fn buvid3(&self) -> Option<String> {
        self.active().map(|p| p.buvid3).filter(|v| !v.is_empty())
    }

    pub fn is_logged_in(&self) -> bool {
        self.active().map(|p| p.is_complete()).unwrap_or(false)
    }

    pub fn names(&self) -> Vec<String> {
        self.config
            .read()
            .expect("config poisoned")
            .profiles
            .keys()
            .cloned()
            .collect()
    }

    /// 切换当前 profile；目标不存在时报 `NOT_FOUND`。
    pub fn set_active(&self, name: &str) -> Result<()> {
        let mut config = self.snapshot();
        if !config.profiles.contains_key(name) {
            return Err(Error::NotFound(format!("profile `{name}` 不存在")));
        }
        config.active_profile = name.to_string();
        self.persist(&config)
    }

    /// 写入当前 profile（登录成功后调用）；profile 不存在则创建。
    pub fn upsert_active(&self, profile: Profile) -> Result<()> {
        let mut config = self.snapshot();
        let name = config.active_profile.clone();
        config.profiles.insert(name, profile);
        self.persist(&config)
    }

    /// 清空当前 profile 的凭据字段，保留 profile 条目（登出）。
    pub fn clear_active_credentials(&self) -> Result<()> {
        let mut config = self.snapshot();
        let name = config.active_profile.clone();
        match config.profiles.get_mut(&name) {
            Some(profile) => profile.clear(),
            None => {
                config.profiles.insert(name, Profile::default());
            }
        }
        self.persist(&config)
    }

    fn persist(&self, config: &AppConfig) -> Result<()> {
        Self::save_atomic(&self.path, config)?;
        *self.config.write().expect("config poisoned") = config.clone();
        Ok(())
    }

    /// 原子写入 + 权限 `0600`：先写同目录临时文件并设权限，再 rename 覆盖。
    pub fn save_atomic(path: &Path, config: &AppConfig) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Internal(format!("创建数据目录失败: {e}")))?;
        }
        let body = toml::to_string_pretty(config)
            .map_err(|e| Error::Internal(format!("序列化 config.toml 失败: {e}")))?;

        let tmp = path.with_extension("toml.tmp");
        write_private(&tmp, body.as_bytes())?;
        std::fs::rename(&tmp, path)
            .map_err(|e| Error::Internal(format!("替换 config.toml 失败: {e}")))?;
        Ok(())
    }
}

/// 以 `0600` 创建文件并写入（Windows 上依赖用户目录 ACL）。
fn write_private(path: &Path, body: &[u8]) -> Result<()> {
    use std::io::Write as _;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| Error::Internal(format!("写入 {} 失败: {e}", path.display())))?;
    file.write_all(body)
        .map_err(|e| Error::Internal(format!("写入 {} 失败: {e}", path.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| Error::Internal(format!("设置权限失败: {e}")))?;
    }
    Ok(())
}

impl std::fmt::Debug for ConfigStore {
    /// 只暴露路径与 profile 名称；`AppConfig` 的 `Debug` 已做遮蔽。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfigStore")
            .field("path", &self.path)
            .field("config", &self.snapshot())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("danmubox-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn profile(cookies: &[(&str, &str)]) -> Profile {
        let mut p = Profile::default();
        for (k, v) in cookies {
            match *k {
                "sessdata" => p.sessdata = v.to_string(),
                "bili_jct" => p.bili_jct = v.to_string(),
                "dede_user_id" => p.dede_user_id = v.to_string(),
                "dede_user_id_ck_md5" => p.dede_user_id_ck_md5 = v.to_string(),
                "buvid3" => p.buvid3 = v.to_string(),
                "buvid4" => p.buvid4 = v.to_string(),
                "sid" => p.sid = v.to_string(),
                other => panic!("unknown field {other}"),
            }
        }
        p
    }

    #[test]
    fn missing_file_means_guest_not_an_error() {
        let dir = temp_dir("missing");
        let store = ConfigStore::load(dir.join("config.toml")).unwrap();
        assert!(!store.is_logged_in());
        assert_eq!(store.active_name(), DEFAULT_PROFILE);
        assert!(store.cookie_header().is_none());
        assert!(store.active().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn completeness_needs_the_three_key_fields() {
        assert!(!Profile::default().is_complete());
        let mut p = profile(&[("sessdata", "s"), ("bili_jct", "j")]);
        assert!(!p.is_complete(), "缺 DedeUserID 不算完整");
        p.dede_user_id = "42".into();
        assert!(p.is_complete());
        assert_eq!(p.uid(), 42);
    }

    #[test]
    fn cookie_header_skips_empty_fields() {
        let p = profile(&[
            ("sessdata", "S"),
            ("bili_jct", "J"),
            ("dede_user_id", "42"),
            ("buvid3", "B"),
        ]);
        let header = p.cookie_header().unwrap();
        assert_eq!(header, "SESSDATA=S; bili_jct=J; DedeUserID=42; buvid3=B");
        assert!(!header.contains("sid="), "空字段不得出现在请求头");
        assert!(Profile::default().cookie_header().is_none());
    }

    #[test]
    fn profile_debug_never_leaks_values() {
        let p = profile(&[("sessdata", "SUPER-SECRET"), ("bili_jct", "ALSO-SECRET")]);
        let rendered = format!("{p:?}");
        assert!(!rendered.contains("SUPER-SECRET"));
        assert!(!rendered.contains("ALSO-SECRET"));
        assert!(rendered.contains("sessdata"), "只暴露字段名");
    }

    #[test]
    fn roundtrip_persists_active_profile_and_profiles() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .upsert_active(profile(&[
                ("sessdata", "S1"),
                ("bili_jct", "J1"),
                ("dede_user_id", "1"),
            ]))
            .unwrap();
        assert!(store.is_logged_in());

        let reloaded = ConfigStore::load(path.clone()).unwrap();
        assert!(reloaded.is_logged_in());
        assert_eq!(reloaded.active().unwrap().sessdata, "S1");
        assert_eq!(reloaded.names(), vec![DEFAULT_PROFILE.to_string()]);

        // 文件形态必须是契约里的 active_profile + [profiles.*]
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("active_profile"));
        assert!(raw.contains("[profiles.default]"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn credential_file_is_written_with_0600() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = temp_dir("perms");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .upsert_active(profile(&[
                ("sessdata", "S"),
                ("bili_jct", "J"),
                ("dede_user_id", "1"),
            ]))
            .unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "凭据文件必须是 0600，实际 {mode:o}");
        assert!(
            !path.with_extension("toml.tmp").exists(),
            "临时文件必须已 rename"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switching_profile_rewrites_only_the_pointer() {
        let dir = temp_dir("switch");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .upsert_active(profile(&[
                ("sessdata", "A"),
                ("bili_jct", "JA"),
                ("dede_user_id", "1"),
            ]))
            .unwrap();

        // 手工再造一个 profile（模拟用户编辑文件）
        let mut config = store.snapshot();
        config.profiles.insert(
            "work".into(),
            profile(&[("sessdata", "B"), ("bili_jct", "JB"), ("dede_user_id", "2")]),
        );
        ConfigStore::save_atomic(&path, &config).unwrap();

        let store = ConfigStore::load(path.clone()).unwrap();
        assert_eq!(
            store.names(),
            vec!["default".to_string(), "work".to_string()]
        );
        store.set_active("work").unwrap();
        assert_eq!(store.active().unwrap().sessdata, "B");
        assert_eq!(
            store.cookie_header().unwrap(),
            "SESSDATA=B; bili_jct=JB; DedeUserID=2"
        );

        let reloaded = ConfigStore::load(path.clone()).unwrap();
        assert_eq!(reloaded.active_name(), "work");
        assert_eq!(reloaded.active().unwrap().dede_user_id, "2");

        assert_eq!(
            store.set_active("nope").unwrap_err().code(),
            "NOT_FOUND",
            "切到不存在的 profile 必须报 NOT_FOUND"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logout_clears_credentials_but_keeps_the_profile_entry() {
        let dir = temp_dir("logout");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .upsert_active(profile(&[
                ("sessdata", "S"),
                ("bili_jct", "J"),
                ("dede_user_id", "1"),
            ]))
            .unwrap();
        assert!(store.is_logged_in());

        store.clear_active_credentials().unwrap();
        assert!(!store.is_logged_in());
        assert!(store.cookie_header().is_none());
        assert_eq!(store.names().len(), 1, "profile 条目保留，只清空字段");

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("SESSDATA") && !raw.contains("sessdata = \"S\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_reported_not_overwritten() {
        let dir = temp_dir("corrupt");
        let path = dir.join("config.toml");
        std::fs::write(&path, b"this is not toml = = =").unwrap();

        let err = ConfigStore::load(path.clone()).unwrap_err();
        assert_eq!(err.code(), "INTERNAL");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "this is not toml = = =",
            "解析失败时不得改动用户的文件"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn buvid3_comes_from_the_active_profile() {
        let dir = temp_dir("buvid");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path).unwrap();
        assert!(store.buvid3().is_none());
        store
            .upsert_active(profile(&[
                ("sessdata", "S"),
                ("bili_jct", "J"),
                ("dede_user_id", "1"),
                ("buvid3", "BV3"),
            ]))
            .unwrap();
        assert_eq!(store.buvid3().as_deref(), Some("BV3"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
