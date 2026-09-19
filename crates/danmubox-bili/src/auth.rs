//! 登录：账号列表、扫码入口与账号切换（`docs/auth.md`）。
//!
//! 三种模式共用一套凭据文件：游客态 = 文件里没有可用凭据；扫码 = 本模块写回文件；
//! 该文件（`docs/auth.md` §8.4）由程序写回：不提供导入入口，也没有面向用户的手工编辑路径。
//!
//! 一个**账号** = `config.toml` 里的一份具名凭据（契约 §4.1）。扫码有两种用法，都在这里：
//! 不带目标 = **新增账号**（确认后按昵称自动起名，用户不必先想名字再扫码），
//! 带目标 = 给已有账号**重新登录**。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::{Account, AuthProvider, QrChallenge, QrPoll, QrState, SessionState};
use danmubox_core::{account_name_from, ConfigStore, Error, Profile, Result};
use futures_util::future::join_all;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::http::{BiliHttp, NavIdentity, EP_QR_GENERATE, EP_QR_POLL};

/// 上游扫码状态码 → 归一化状态。
///
/// `0` 成功、`86038` 已失效、`86090` 已扫码待确认、`86101` 未扫码；
/// **未知码一律归入 `Pending`**，不臆造语义（`docs/auth.md` §6.3）。
pub fn qr_state_from_code(code: i64) -> QrState {
    match code {
        0 => QrState::Confirmed,
        86038 => QrState::Expired,
        86090 => QrState::Scanned,
        _ => QrState::Pending,
    }
}

/// 从登录响应的 `Set-Cookie` 组装凭据。
///
/// 契约 §4.1 规定「可直接进入登录态」需要 `SESSDATA` / `bili_jct` / `DedeUserID` 三者，
/// 因此缺任一即视为失败——不写半套凭据进文件。
pub fn profile_from_cookies(
    cookies: &[(String, String)],
    previous: Option<Profile>,
) -> Option<Profile> {
    let find = |name: &str| {
        cookies
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };

    let mut profile = previous.unwrap_or_default();
    let sessdata = find("SESSDATA");
    let bili_jct = find("bili_jct");
    let dede_user_id = find("DedeUserID");

    profile.sessdata = sessdata;
    profile.bili_jct = bili_jct;
    profile.dede_user_id = dede_user_id;
    let ck_md5 = find("DedeUserID__ckMd5");
    if !ck_md5.is_empty() {
        profile.dede_user_id_ck_md5 = ck_md5;
    }
    let sid = find("sid");
    if !sid.is_empty() {
        profile.sid = sid;
    }
    let buvid3 = find("buvid3");
    if !buvid3.is_empty() {
        profile.buvid3 = buvid3;
    }

    profile.is_complete().then_some(profile)
}

/// 把「文件里的一个账号 + 它的 `nav` 求证结果」拼成对外的 [`Account`]。
///
/// 三种结果分开处理，这是本模块最容易出错的地方：
/// - `Ok(Some(身份))`：凭据有效，登录态与身份都取上游的；
/// - `Ok(None)`：**凭据失效**（上游 `code != 0`）→ 未登录，uid 退回文件里的 `DedeUserID`；
/// - `Err`：**没问到**（网络/解析失败）→ 不改登录态，沿用文件里的结论，身份那几格留空。
///
/// 最后一条是实测踩出来的（S2-AC5）：一次网络抖动不该把已登录的账号显示成未登录，
/// 也不该拿上一次的身份冒充这一次的结果。
fn account_from(
    name: String,
    uid_hint: i64,
    active: bool,
    identity: Result<Option<NavIdentity>>,
) -> Account {
    match identity {
        Ok(Some(identity)) => Account {
            name,
            nickname: identity.nickname,
            uid: if identity.uid > 0 {
                identity.uid
            } else {
                uid_hint
            },
            face: identity.face,
            logged_in: true,
            active,
        },
        Ok(None) => Account {
            name,
            nickname: String::new(),
            uid: uid_hint,
            face: String::new(),
            logged_in: false,
            active,
        },
        Err(err) => {
            tracing::warn!(%err, account = %name, "账号身份求证失败，沿用凭据文件里的结论");
            Account {
                name,
                nickname: String::new(),
                uid: uid_hint,
                face: String::new(),
                logged_in: true,
                active,
            }
        }
    }
}

pub struct BiliAuth {
    store: Arc<ConfigStore>,
    http: BiliHttp,
    /// 昵称有网络成本，登录成功后缓存一次；登出或换号即失效。
    nickname: Mutex<Option<String>>,
    /// 尚未消费的扫码 `key` → 这一轮扫码要落盘的账号（`None` = 新增）。
    ///
    /// 目标必须活过命令边界：`account_qr_start` 与 `account_qr_poll` 是两次独立调用，
    /// 而「扫码后写进哪个账号」只有 start 知道。新一轮扫码作废上一轮的 `key`。
    qr_targets: Mutex<HashMap<String, Option<String>>>,
}

impl BiliAuth {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
            nickname: Mutex::new(None),
            qr_targets: Mutex::new(HashMap::new()),
        })
    }

    pub fn store(&self) -> &Arc<ConfigStore> {
        &self.store
    }

    async fn nickname(&self) -> String {
        if let Some(cached) = self.nickname.lock().await.as_ref() {
            return cached.clone();
        }
        let fetched = self.http.nav_identity(None).await.unwrap_or_default();
        let fetched = fetched
            .map(|identity| identity.nickname)
            .unwrap_or_default();
        if !fetched.is_empty() {
            *self.nickname.lock().await = Some(fetched.clone());
        }
        fetched
    }

    async fn current_session(&self) -> Result<SessionState> {
        let active_profile = self.store.active_name();
        let Some(profile) = self.store.active().filter(|p| p.is_complete()) else {
            // 游客态不发任何请求：不阻塞弹幕接收链路（`docs/roadmap.md` S2-AC1）。
            return Ok(SessionState {
                logged_in: false,
                uid: 0,
                nickname: String::new(),
                active_profile,
            });
        };

        // **字段齐全不等于凭据有效**。向 `nav` 求证一次——这是实测踩出来的：
        // 失效的 SESSDATA 此前被当成"已登录"，于是 WS 认证发出后立刻被上游 reset
        // （`Connection reset without closing handshake`），而那条失败被归进普通
        // 连接错误，最终表现为「界面显示已登录、却永远连不上」（S2-AC5）。
        match self.http.nav_identity(None).await {
            Ok(Some(identity)) => {
                *self.nickname.lock().await = Some(identity.nickname.clone());
                Ok(SessionState {
                    logged_in: true,
                    uid: profile.uid(),
                    nickname: identity.nickname,
                    active_profile,
                })
            }
            Ok(None) => {
                tracing::warn!(profile = %active_profile, "凭据已失效（nav 返回未登录）");
                Ok(SessionState {
                    logged_in: false,
                    uid: 0,
                    nickname: String::new(),
                    active_profile,
                })
            }
            Err(err) => {
                // 网络错误不改变登录态：一次抖动不该把用户踢成游客。
                tracing::warn!(%err, "校验登录态失败，沿用配置文件里的结论");
                Ok(SessionState {
                    logged_in: true,
                    uid: profile.uid(),
                    nickname: self.nickname().await,
                    active_profile,
                })
            }
        }
    }

    /// 扫码确认后的落盘：写出凭据、决定账号名、返回账号。
    async fn finish_qr(
        &self,
        target: Option<String>,
        cookies: &[(String, String)],
    ) -> Result<Account> {
        // 重新登录同一个账号时继承它原有的设备标识与 md5；新增账号则只继承
        // **设备级**的 `buvid`（不绑定账号），不继承任何账号级字段。
        let previous = target.as_deref().and_then(|name| self.store.profile(name));
        let mut profile = profile_from_cookies(cookies, previous).ok_or_else(|| {
            // 判定成功却拿不到完整凭据：属于上游行为异常，明确报错而不是写半套凭据。
            Error::Upstream("扫码已确认但未取到完整凭据".into())
        })?;
        if profile.buvid3.is_empty() {
            if let Some(active) = self.store.active() {
                profile.buvid3 = active.buvid3;
                if profile.buvid4.is_empty() {
                    profile.buvid4 = active.buvid4;
                }
            }
        }

        let header = profile.cookie_header();
        let identity = self
            .http
            .nav_identity(header.as_deref())
            .await?
            .ok_or_else(|| Error::Upstream("扫码已确认，但 nav 仍报未登录".into()))?;

        let name = match target {
            Some(name) => name,
            None => {
                // 先扫码后起名：名字由昵称派生；中文昵称会被清成 uid 兜底，
                // 重名再加后缀（契约：新增不需要用户先起名）。
                let base = account_name_from(&identity.nickname, identity.uid);
                self.store.unique_account_name(&base)
            }
        };
        let uid = if identity.uid > 0 {
            identity.uid
        } else {
            profile.uid()
        };
        self.store.save_profile(&name, profile, true)?;
        *self.nickname.lock().await = None;
        Ok(Account {
            name,
            nickname: identity.nickname,
            uid,
            face: identity.face,
            logged_in: true,
            active: true,
        })
    }
}

#[async_trait]
impl AuthProvider for BiliAuth {
    async fn session(&self) -> Result<SessionState> {
        self.current_session().await
    }

    async fn accounts(&self) -> Result<Vec<Account>> {
        let active = self.store.active_name();
        // 一次取够全部账号，再并发求证：串行等 N 次 nav 会让账号多的人等出成倍延迟。
        let probes = self.store.accounts().into_iter().map(|(name, profile)| {
            let cookie = profile.cookie_header();
            let complete = profile.is_complete();
            let uid_hint = profile.uid();
            let is_active = name == active;
            async move {
                let identity = if complete {
                    self.http.nav_identity(cookie.as_deref()).await
                } else {
                    // 没有凭据就不发请求：它就是「已登出的账号」。
                    Ok(None)
                };
                account_from(name, uid_hint, is_active, identity)
            }
        });
        // 单个账号求证失败只会体现在它自己那一行（`account_from` 的 `Err` 分支），
        // 不会让整张列表失败——所以这里不需要 `Result` 短路。
        Ok(join_all(probes).await)
    }

    async fn begin_qr(&self, target: Option<&str>) -> Result<QrChallenge> {
        if let Some(name) = target {
            if self.store.profile(name).is_none() {
                // 给一个不存在的账号重新登录是调用方的错，不是上游的错。
                return Err(Error::NotFound(format!("账号 `{name}` 不存在")));
            }
        }
        let (value, _) = self.http.get_with_cookies(EP_QR_GENERATE).await?;
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            return Err(Error::Upstream(format!("二维码生成失败 code={code}")));
        }
        let key = value
            .pointer("/data/qrcode_key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let url = value
            .pointer("/data/url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if key.is_empty() || url.is_empty() {
            return Err(Error::Upstream("二维码响应缺少 qrcode_key 或 url".into()));
        }
        {
            let mut targets = self.qr_targets.lock().await;
            // 新一轮扫码作废上一轮：UI 反复点「刷新」不会把废弃的 key 攒在内存里，
            // 也让「旧 key 再轮询」得到明确的 NOT_FOUND（`docs/ipc.md` 的既有约定）。
            targets.clear();
            targets.insert(key.clone(), target.map(str::to_string));
        }
        Ok(QrChallenge { key, url })
    }

    async fn poll_qr(&self, key: &str) -> Result<QrPoll> {
        let target = { self.qr_targets.lock().await.get(key).cloned() };
        let Some(target) = target else {
            return Err(Error::NotFound(format!("扫码 key 已消费或不存在：{key}")));
        };

        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("qrcode_key", key)
            .finish();
        let (value, cookies) = self
            .http
            .get_with_cookies(&format!("{EP_QR_POLL}?{query}"))
            .await?;

        let outer = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if outer != 0 {
            return Err(Error::Upstream(format!("扫码轮询失败 code={outer}")));
        }
        let inner = value
            .pointer("/data/code")
            .and_then(Value::as_i64)
            .unwrap_or(-1);

        let state = qr_state_from_code(inner);
        if state != QrState::Confirmed {
            if state == QrState::Expired {
                // 失效是终态：消费掉 key，再轮询同一个 key 得到 NOT_FOUND。
                self.qr_targets.lock().await.remove(key);
            } else if inner != 0 {
                tracing::debug!(code = inner, "扫码状态码（未确认）");
            }
            return Ok(QrPoll {
                state,
                account: None,
            });
        }

        let account = self.finish_qr(target, &cookies).await?;
        self.qr_targets.lock().await.remove(key);
        Ok(QrPoll {
            state,
            account: Some(account),
        })
    }

    async fn switch_account(&self, name: &str) -> Result<SessionState> {
        self.store.set_active(name)?;
        *self.nickname.lock().await = None;
        self.current_session().await
    }

    async fn logout(&self, name: Option<&str>) -> Result<SessionState> {
        self.store.clear_credentials(name)?;
        *self.nickname.lock().await = None;
        self.current_session().await
    }

    async fn remove_account(&self, name: &str) -> Result<SessionState> {
        self.store.remove_account(name)?;
        *self.nickname.lock().await = None;
        self.current_session().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookies(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn qr_codes_map_to_normalized_states() {
        assert_eq!(qr_state_from_code(0), QrState::Confirmed);
        assert_eq!(qr_state_from_code(86038), QrState::Expired);
        assert_eq!(qr_state_from_code(86090), QrState::Scanned);
        assert_eq!(qr_state_from_code(86101), QrState::Pending);
        assert_eq!(
            qr_state_from_code(99999),
            QrState::Pending,
            "未知码按未确认"
        );
        assert_eq!(qr_state_from_code(-1), QrState::Pending);
    }

    #[test]
    fn complete_cookie_set_builds_a_usable_profile() {
        let profile = profile_from_cookies(
            &cookies(&[
                ("SESSDATA", "s%2Fx"),
                ("bili_jct", "jd"),
                ("DedeUserID", "42"),
                ("DedeUserID__ckMd5", "ab"),
                ("sid", "zz"),
            ]),
            None,
        )
        .expect("三要素齐全应可用");
        assert_eq!(profile.uid(), 42);
        assert_eq!(profile.dede_user_id_ck_md5, "ab");
        assert_eq!(profile.sid, "zz");
        assert!(profile.cookie_header().unwrap().contains("DedeUserID=42"));
    }

    #[test]
    fn incomplete_cookie_set_is_rejected() {
        assert!(profile_from_cookies(&cookies(&[("SESSDATA", "s")]), None).is_none());
        assert!(profile_from_cookies(&cookies(&[]), None).is_none());
    }

    #[test]
    fn re_login_keeps_buvid_obtained_earlier() {
        let previous = Profile {
            buvid3: "OLD-BUVID".into(),
            buvid4: "OLD-BUVID4".into(),
            ..Default::default()
        };
        let profile = profile_from_cookies(
            &cookies(&[("SESSDATA", "s"), ("bili_jct", "j"), ("DedeUserID", "7")]),
            Some(previous),
        )
        .unwrap();
        assert_eq!(profile.buvid3, "OLD-BUVID", "未下发时沿用旧设备标识");
        assert_eq!(profile.buvid4, "OLD-BUVID4");
    }

    #[test]
    fn freshly_issued_buvid_overrides_the_old_one() {
        let previous = Profile {
            buvid3: "OLD".into(),
            ..Default::default()
        };
        let profile = profile_from_cookies(
            &cookies(&[
                ("SESSDATA", "s"),
                ("bili_jct", "j"),
                ("DedeUserID", "7"),
                ("buvid3", "NEW"),
            ]),
            Some(previous),
        )
        .unwrap();
        assert_eq!(profile.buvid3, "NEW");
    }

    #[test]
    fn cookie_names_match_regardless_of_case() {
        let profile = profile_from_cookies(
            &cookies(&[("sessdata", "s"), ("BILI_JCT", "j"), ("dedeuserid", "9")]),
            None,
        )
        .unwrap();
        assert_eq!(profile.uid(), 9);
    }

    #[test]
    fn account_row_reports_login_state_and_identity() {
        let identity = NavIdentity {
            uid: 42,
            nickname: "某人".into(),
            face: "https://example.invalid/face.jpg".into(),
        };
        let row = account_from("me".into(), 1, true, Ok(Some(identity)));
        assert!(row.logged_in && row.active);
        assert_eq!(row.uid, 42, "身份以 nav 为准");
        assert_eq!(row.nickname, "某人");
        assert_eq!(row.face, "https://example.invalid/face.jpg");

        // nav 说未登录 = 凭据失效：登录态翻成 false，uid 退回文件里的那份
        let row = account_from("me".into(), 7, false, Ok(None));
        assert!(!row.logged_in);
        assert_eq!(row.uid, 7);
        assert!(row.nickname.is_empty() && row.face.is_empty());

        // 没问到（网络/解析失败）：不改登录态，身份留空而不是拿旧值冒充
        let row = account_from("me".into(), 7, false, Err(Error::Upstream("boom".into())));
        assert!(row.logged_in, "网络抖动不得把已登录账号显示成未登录");
        assert!(row.nickname.is_empty());
    }
}
