//! 凭据文件 `config.toml`（`docs/contract.md` §4.1）。
//!
//! 形态：**明文 TOML**，权限 `0600`，写入走临时文件 + rename。
//! 多账号用 `[profiles.<name>]` 承载，`active_profile` 指定当前生效者。
//! 存储层仍叫 profile（表键就是 `[profiles.<name>]`，见契约 §4.1），
//! 但对外（IPC / 文档 / 界面）一律叫「账号」——一个账号 = 一份具名凭据。
//!
//! 本模块只负责「存与取」，不做任何网络请求；登录流程在 `danmubox-bili`。
//! 凭据值**绝不**出现在日志里——`Debug` 实现已手写作遮蔽处理。

use std::collections::{BTreeMap, BTreeSet};
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

    /// 清空**账号级**凭据字段（登出）。
    ///
    /// `buvid3` / `buvid4` 是**设备级**标识、不绑定账号，刻意保留：清掉它们会让
    /// 每次登出都换一次设备指纹，反而触发上游风控重新评估（`docs/auth.md` §3.3）。
    pub fn clear_credentials(&mut self) {
        self.sessdata.clear();
        self.bili_jct.clear();
        self.dede_user_id.clear();
        self.dede_user_id_ck_md5.clear();
        self.sid.clear();
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

/// 账号名允许的最大长度。
const ACCOUNT_NAME_MAX: usize = 32;

/// 校验**显式给出**的账号名。
///
/// 只用 `[A-Za-z0-9_-]`：名字既是 `config.toml` 里的表键（`[profiles.<name>]`），
/// 也是界面上可输入、可对比的标识。放行空白与引号等字符会让 TOML 往返需要转义，
/// 也让「同名 / 名字里只有空格」这类输入无法给出清晰结论，因此在入口收敛。
pub fn validate_account_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(Error::BadRequest("账号名不能为空".into()));
    }
    if trimmed.len() > ACCOUNT_NAME_MAX {
        return Err(Error::BadRequest(format!(
            "账号名不能超过 {ACCOUNT_NAME_MAX} 个字符"
        )));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(Error::BadRequest(
            "账号名只能包含字母、数字、下划线与连字符".into(),
        ));
    }
    // 收敛两端的空白：`"  work  "` 与 `"work"` 视为同一个名字，避免造出看不见的重名。
    Ok(trimmed.to_string())
}

/// 按昵称派生一个合法账号名；昵称里没有可用字符时退回 `uid<数字>`。
///
/// 这条规则是给**扫码新增**用的：用户不该先给账号起名再扫码，所以名字由扫码得到的
/// 昵称自动生成。昵称常常是中文，而账号名只允许 `[A-Za-z0-9_-]`
/// （见 `validate_account_name`），因此这里**不做转写**——只保留 ASCII 字母数字与
/// `-`/`_`，其余字符（含全部中文）直接丢掉；一个字符都不剩时用 uid 兜底，
/// 保证自动命名一定有结果，也不会因为「中文昵称被清空」而让两个账号撞同一个名字。
pub fn account_name_from(nickname: &str, uid: i64) -> String {
    let cleaned: String = nickname
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let cleaned = cleaned.trim_matches(|c| c == '_' || c == '-');
    let base = if cleaned.is_empty() {
        format!("uid{uid}")
    } else {
        cleaned.to_string()
    };
    base.chars().take(ACCOUNT_NAME_MAX).collect()
}

/// 凭据文件的内存态 + 落盘点。适配器通过它读取当前 Cookie，
/// 因此切换 profile 后无需重建 HTTP 客户端。
pub struct ConfigStore {
    path: PathBuf,
    config: RwLock<AppConfig>,
}

impl ConfigStore {
    /// 读取凭据文件。文件不存在按「空配置」处理；文件存在但解析失败则删掉重建为空文件、
    /// 以游客态继续（契约 §4.1）；读取 / 删除 / 重建失败等其它错误照旧上报。
    pub fn load(path: PathBuf) -> Result<Self> {
        let config = if path.exists() {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| Error::Internal(format!("读取 {} 失败: {e}", path.display())))?;
            match toml::from_str::<AppConfig>(&raw) {
                Ok(parsed) => parsed,
                // 解析失败（契约 §4.1）：删掉重建空文件、以游客态继续，不再让启动失败。
                // 只处理这一条分支；读取 / 权限 / IO 错误照旧往上抛。
                Err(_) => reset_corrupt_file(&path)?,
            }
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

    /// 全部账号（名字 + 凭据），按名字字典序。`accounts_list` 一次取够，
    /// 免得每个账号都再抢一次读锁。
    pub fn accounts(&self) -> Vec<(String, Profile)> {
        self.config
            .read()
            .expect("config poisoned")
            .profiles
            .iter()
            .map(|(name, profile)| (name.clone(), profile.clone()))
            .collect()
    }

    /// 某个账号的凭据；不存在返回 `None`。
    pub fn profile(&self, name: &str) -> Option<Profile> {
        self.config
            .read()
            .expect("config poisoned")
            .profiles
            .get(name)
            .cloned()
    }

    /// 给一个按昵称派生的名字找一个没被占用的版本：先试它本身，
    /// 被占用则依次试 `<base>-2`、`<base>-3`…（加后缀时保持总长不超上限）。
    pub fn unique_account_name(&self, base: &str) -> String {
        let taken: BTreeSet<String> = self.names().into_iter().collect();
        if !taken.contains(base) {
            return base.to_string();
        }
        for n in 2..=taken.len() + 2 {
            let suffix = format!("-{n}");
            let keep = ACCOUNT_NAME_MAX.saturating_sub(suffix.len());
            let candidate = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
            if !taken.contains(&candidate) {
                return candidate;
            }
        }
        // 候选数与已占用的名字数相同，不可能全被占；这里只是让编译器满意。
        unreachable!("候选名数量多于已占用名字数，必然存在空位")
    }

    /// 切换当前账号；目标不存在时报 `NOT_FOUND`。
    pub fn set_active(&self, name: &str) -> Result<()> {
        let mut config = self.snapshot();
        if !config.profiles.contains_key(name) {
            return Err(Error::NotFound(format!("账号 `{name}` 不存在")));
        }
        config.active_profile = name.to_string();
        self.persist(&config)
    }

    /// 删除一个账号。
    ///
    /// 两条护栏：不能删掉最后一个账号（配置里至少要留一个身份）；
    /// 删的若是当前账号，则把当前指向切到剩下的第一个，保证
    /// `active_profile` 始终指向一个存在的条目。
    pub fn remove_account(&self, name: &str) -> Result<()> {
        let mut config = self.snapshot();
        if !config.profiles.contains_key(name) {
            return Err(Error::NotFound(format!("账号 `{name}` 不存在")));
        }
        if config.profiles.len() <= 1 {
            return Err(Error::BadRequest("不能删除最后一个账号".into()));
        }
        config.profiles.remove(name);
        if config.active_profile == name {
            // BTreeMap 的 key 顺序确定，切换目标可复现。
            let next = config
                .profiles
                .keys()
                .next()
                .cloned()
                .expect("至少剩一个账号");
            config.active_profile = next;
        }
        self.persist(&config)
    }

    /// 写入某个账号的凭据：不存在则新建，已存在则**覆盖**（重新登录同一个账号）。
    ///
    /// `make_active` 决定写入后是否把它设为当前账号。调用方负责「重名怎么办」：
    /// 扫码新增用 `unique_account_name` 避开已占用的名字；重新登录某个账号时显式给出
    /// 它的名字就是要覆盖那个账号的凭据。
    pub fn save_profile(&self, name: &str, profile: Profile, make_active: bool) -> Result<()> {
        let name = validate_account_name(name)?;
        let mut config = self.snapshot();
        config.profiles.insert(name.clone(), profile);
        if make_active {
            config.active_profile = name;
        }
        self.persist(&config)
    }

    /// 清空一个账号的凭据字段，**保留账号条目**（登出）。`None` = 当前账号。
    ///
    /// 保留条目是刻意的：退回游客态之后这个账号的槽位还在，界面能继续显示
    /// 「已登出的账号」而不是让它凭空消失（`REQUIREMENTS.md` §2.5）。
    pub fn clear_credentials(&self, name: Option<&str>) -> Result<()> {
        let explicit = name.is_some();
        let mut config = self.snapshot();
        let target = name
            .map(str::to_string)
            .unwrap_or_else(|| config.active_profile.clone());
        match config.profiles.get_mut(&target) {
            Some(profile) => profile.clear_credentials(),
            // 全新安装（零账号）下的登出：没有条目可清，不是错误。
            None if !explicit => return Ok(()),
            None => return Err(Error::NotFound(format!("账号 `{target}` 不存在"))),
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

/// 凭据文件坏掉时的自愈：删掉再建一个空文件（`0600`），并给出空配置以按游客态继续（契约 §4.1）。
///
/// 用户裁决（2026-09-19）：**不备份** —— 解析失败的凭据已经用不了，留一份损坏副本只会让
/// 下次启动再失败一次。删除 / 重建失败（权限、IO）一律照旧上报，不吞。
///
/// 日志只写文件路径与处置结论：TOML 的解析错误文本会内嵌出错行的源码片段，凭据值**绝不**进日志。
fn reset_corrupt_file(path: &Path) -> Result<AppConfig> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(Error::Internal(format!(
                "删除损坏的 {} 失败: {err}",
                path.display()
            )))
        }
    }
    tracing::warn!(path = %path.display(), "凭据文件损坏，已重建为空文件，请重新扫码登录");
    write_private(path, b"")?;
    Ok(AppConfig::default())
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
            .save_profile(
                DEFAULT_PROFILE,
                profile(&[
                    ("sessdata", "S1"),
                    ("bili_jct", "J1"),
                    ("dede_user_id", "1"),
                ]),
                true,
            )
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
            .save_profile(
                DEFAULT_PROFILE,
                profile(&[("sessdata", "S"), ("bili_jct", "J"), ("dede_user_id", "1")]),
                true,
            )
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
            .save_profile(
                DEFAULT_PROFILE,
                profile(&[("sessdata", "A"), ("bili_jct", "JA"), ("dede_user_id", "1")]),
                true,
            )
            .unwrap();

        // 手工再造一个账号（绕过登录流程，模拟文件里已经有另一个账号）
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
            "切到不存在的账号必须报 NOT_FOUND"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_an_account_creates_or_overwrites_it() {
        let dir = temp_dir("save");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .save_profile(
                "default",
                profile(&[("sessdata", "S"), ("bili_jct", "J"), ("dede_user_id", "1")]),
                true,
            )
            .unwrap();
        assert!(store.is_logged_in());

        // 同名再写一次 = 重新登录：覆盖凭据，不是再造一个账号
        store
            .save_profile(
                "default",
                profile(&[
                    ("sessdata", "S2"),
                    ("bili_jct", "J2"),
                    ("dede_user_id", "2"),
                ]),
                true,
            )
            .unwrap();
        assert_eq!(store.names(), vec!["default".to_string()]);
        assert_eq!(store.active().unwrap().sessdata, "S2");

        // make_active = false：只写凭据，不动当前账号指针
        store
            .save_profile(
                "work",
                profile(&[("sessdata", "W"), ("bili_jct", "WJ"), ("dede_user_id", "9")]),
                false,
            )
            .unwrap();
        assert_eq!(store.active_name(), "default");
        assert_eq!(store.profile("work").unwrap().sessdata, "W");
        assert!(store.profile("ghost").is_none(), "没写过的账号取不到");

        let reloaded = ConfigStore::load(path.clone()).unwrap();
        assert_eq!(reloaded.active_name(), "default");
        assert_eq!(
            reloaded.names(),
            vec!["default".to_string(), "work".to_string()]
        );
        assert_eq!(reloaded.accounts().len(), 2);

        for bad in ["", "   ", "a b", "a/b", "中文名", &"x".repeat(33)] {
            assert_eq!(
                store
                    .save_profile(bad, Profile::default(), true)
                    .unwrap_err()
                    .code(),
                "BAD_REQUEST",
                "{bad:?} 必须拒绝"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn account_name_comes_from_the_nickname_with_a_uid_fallback() {
        // 中文昵称一个可用字符都不剩 → 用 uid 兜底，绝不能生成空名字
        assert_eq!(account_name_from("张三", 42), "uid42");
        assert_eq!(account_name_from("Kirikosama", 7), "Kirikosama");
        assert_eq!(account_name_from("Zhang San", 7), "ZhangSan");
        assert_eq!(account_name_from("_-_", 5), "uid5", "只剩分隔符也算空");
        assert_eq!(account_name_from(&"x".repeat(40), 1).chars().count(), 32);

        // 重名自动加后缀
        let dir = temp_dir("names");
        let store = ConfigStore::load(dir.join("config.toml")).unwrap();
        assert_eq!(store.unique_account_name("Kirikosama"), "Kirikosama");
        store
            .save_profile("Kirikosama", Profile::default(), false)
            .unwrap();
        assert_eq!(store.unique_account_name("Kirikosama"), "Kirikosama-2");
        store
            .save_profile("Kirikosama-2", Profile::default(), false)
            .unwrap();
        assert_eq!(store.unique_account_name("Kirikosama"), "Kirikosama-3");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_an_account_keeps_one_and_repairs_the_pointer() {
        let dir = temp_dir("remove");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .save_profile(
                "default",
                profile(&[("sessdata", "S"), ("bili_jct", "J"), ("dede_user_id", "1")]),
                true,
            )
            .unwrap();
        store
            .save_profile("work", Profile::default(), true)
            .unwrap();
        store.set_active("default").unwrap();

        store.remove_account("work").unwrap();
        assert_eq!(store.names(), vec!["default".to_string()]);
        assert_eq!(store.active_name(), "default", "删非当前项不动指针");

        assert_eq!(
            store.remove_account("default").unwrap_err().code(),
            "BAD_REQUEST",
            "不能删掉最后一个账号"
        );
        assert_eq!(
            store.remove_account("ghost").unwrap_err().code(),
            "NOT_FOUND"
        );

        store
            .save_profile("work", Profile::default(), false)
            .unwrap();
        store.set_active("default").unwrap();
        store.remove_account("default").unwrap();
        assert_eq!(store.active_name(), "work", "删当前项要切到剩下的条目");
        assert_eq!(
            ConfigStore::load(path.clone()).unwrap().active_name(),
            "work",
            "切换必须落盘"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logout_clears_credentials_but_keeps_the_account_entry() {
        let dir = temp_dir("logout");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path.clone()).unwrap();
        store
            .save_profile(
                "default",
                profile(&[
                    ("sessdata", "S"),
                    ("bili_jct", "J"),
                    ("dede_user_id", "1"),
                    ("buvid3", "BV3"),
                ]),
                true,
            )
            .unwrap();
        store
            .save_profile(
                "work",
                profile(&[("sessdata", "W"), ("bili_jct", "WJ"), ("dede_user_id", "2")]),
                false,
            )
            .unwrap();
        assert!(store.is_logged_in());

        // 指名登出只动那一个账号
        store.clear_credentials(Some("work")).unwrap();
        assert!(store.is_logged_in(), "清的是 work，当前账号不受影响");
        assert!(!store.profile("work").unwrap().is_complete());

        // 缺省 = 当前账号
        store.clear_credentials(None).unwrap();
        assert!(!store.is_logged_in());
        let header = store.cookie_header().unwrap_or_default();
        assert!(
            !header.contains("SESSDATA") && !header.contains("bili_jct"),
            "账号凭据必须清空，实际 {header}"
        );
        assert_eq!(store.names().len(), 2, "账号条目保留，只清空字段");
        assert_eq!(
            store.profile("default").unwrap().buvid3,
            "BV3",
            "设备标识不绑定账号，登出不得清掉（docs/auth.md §3.3）"
        );

        assert_eq!(
            store.clear_credentials(Some("ghost")).unwrap_err().code(),
            "NOT_FOUND"
        );

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("SESSDATA") && !raw.contains("sessdata = \"S\""));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn logout_without_any_account_is_a_no_op() {
        // 全新安装是零账号：此时登出没有条目可清，不该报错。
        let dir = temp_dir("logout-empty");
        let store = ConfigStore::load(dir.join("config.toml")).unwrap();
        store.clear_credentials(None).unwrap();
        assert!(store.accounts().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 凭据文件损坏不该让应用起不来（契约 §4.1）：删掉重建为空文件，并按游客态继续。
    #[test]
    fn corrupt_file_is_rebuilt_empty_and_starts_as_guest() {
        let dir = temp_dir("corrupt");
        let path = dir.join("config.toml");
        std::fs::write(&path, b"this is not toml = = =").unwrap();

        let store = ConfigStore::load(path.clone()).unwrap();
        assert!(!store.is_logged_in(), "损坏即游客态");
        assert_eq!(store.active_name(), DEFAULT_PROFILE);
        assert!(store.accounts().is_empty());

        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            0,
            "重建后必须是空文件"
        );
        // 空文件本身是合法输入：下次启动不再触发自愈，也不会再报一次。
        ConfigStore::load(path.clone()).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "重建后的凭据文件仍必须是 0600，实际 {mode:o}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 红线（契约 §4.1）：损坏文件的内容不得被回显 —— 日志里只有路径与处置结论。
    #[test]
    fn corrupt_file_content_never_reaches_the_logs() {
        let dir = temp_dir("corrupt-log");
        let path = dir.join("config.toml");
        std::fs::write(&path, b"sessdata = \"SENTINEL-LEAK\" = =\n").unwrap();

        let logs = captured_logs(|| {
            ConfigStore::load(path.clone()).unwrap();
        });

        assert!(
            logs.contains("凭据文件损坏"),
            "自愈必须留下一条 warn：{logs}"
        );
        assert!(
            !logs.contains("SENTINEL-LEAK"),
            "日志里不得出现文件内容：{logs}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 自愈只归解析失败管：读不出来（这里让目录占住文件路径）照旧报错，也不动现场。
    #[test]
    fn other_failures_are_still_reported_and_change_nothing() {
        let dir = temp_dir("unreadable");
        let path = dir.join("config.toml");
        std::fs::create_dir(&path).unwrap();

        let err = ConfigStore::load(path.clone()).unwrap_err();
        assert_eq!(err.code(), "INTERNAL");
        assert!(path.is_dir(), "非解析失败的错误不得触发删除重建");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 捕获 `body` 期间**本线程**打出的日志。
    ///
    /// 手写最小订阅者：本 crate 不依赖 `tracing-subscriber`，这里只需要「把事件字段按 debug
    /// 记下来」这一件事。缓冲区是**线程本地**的，因此并行跑的其它用例互不影响。
    fn captured_logs(body: impl FnOnce()) -> String {
        use std::cell::RefCell;
        use std::fmt::Write as _;

        thread_local! {
            static CAPTURED: RefCell<String> = const { RefCell::new(String::new()) };
        }

        struct Capture;

        impl tracing::field::Visit for Capture {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                CAPTURED.with(|out| {
                    let mut out = out.borrow_mut();
                    let _ = write!(*out, "{}={value:?} ", field.name());
                });
            }
        }

        impl tracing::Subscriber for Capture {
            fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
                true
            }
            fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
                tracing::span::Id::from_u64(1)
            }
            fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
            fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
            fn event(&self, event: &tracing::Event<'_>) {
                event.record(&mut Capture);
            }
            fn enter(&self, _: &tracing::span::Id) {}
            fn exit(&self, _: &tracing::span::Id) {}
        }

        // 订阅者常驻**进程级**，而不是按线程 `with_default`：tracing 的 callsite 兴趣缓存
        // 与 max level 是进程级的，而 trace-core 在「活着的订阅者 ≤ 1」时走
        // `Dispatchers::JustOne` 快路径 —— 它用的是**调用线程当前**的订阅者，而
        // `with_default` 把订阅者装上去之前那一刻是「无订阅者」。并行跑时就有用例会把这条
        // `warn!` 的 callsite 缓存成「永不启用」，本用例再装线程本地订阅者也收不到它
        // （实测：`cargo test -p danmubox-core --lib` 约有一半的轮次因此失败，
        // `--test-threads=1` 才稳定绿）。常驻的全局订阅者让进程里永远有一个活着的订阅者，
        // 兴趣与 max level 都稳定，断言读到的才是「这条日志有没有发出来」。
        static INSTALL: std::sync::Once = std::sync::Once::new();
        INSTALL.call_once(|| {
            let _ = tracing::subscriber::set_global_default(Capture);
        });

        CAPTURED.with(|out| out.borrow_mut().clear());
        body();
        CAPTURED.with(|out| out.borrow().clone())
    }

    #[test]
    fn buvid3_comes_from_the_active_profile() {
        let dir = temp_dir("buvid");
        let path = dir.join("config.toml");
        let store = ConfigStore::load(path).unwrap();
        assert!(store.buvid3().is_none());
        store
            .save_profile(
                DEFAULT_PROFILE,
                profile(&[
                    ("sessdata", "S"),
                    ("bili_jct", "J"),
                    ("dede_user_id", "1"),
                    ("buvid3", "BV3"),
                ]),
                true,
            )
            .unwrap();
        assert_eq!(store.buvid3().as_deref(), Some("BV3"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
