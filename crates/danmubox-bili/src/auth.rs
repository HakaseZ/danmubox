//! 登录：扫码入口、凭据写回与账号切换（`docs/auth.md`）。
//!
//! 三种模式共用一套凭据文件：游客态 = 文件里没有可用凭据；
//! 「手填 Cookie」= 用户直接编辑 `config.toml`；扫码 = 本模块写回文件。

use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::{AuthProvider, QrChallenge, QrState, SessionState};
use danmubox_core::{ConfigStore, Error, Profile, Result};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::http::{BiliHttp, EP_QR_GENERATE, EP_QR_POLL};

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

pub struct BiliAuth {
    store: Arc<ConfigStore>,
    http: BiliHttp,
    /// 昵称有网络成本，登录成功后缓存一次；登出或换号即失效。
    nickname: Mutex<Option<String>>,
}

impl BiliAuth {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
            nickname: Mutex::new(None),
        })
    }

    pub fn store(&self) -> &Arc<ConfigStore> {
        &self.store
    }

    async fn nickname(&self) -> String {
        if let Some(cached) = self.nickname.lock().await.as_ref() {
            return cached.clone();
        }
        let fetched = self.http.account_nickname().await.unwrap_or_default();
        let fetched = fetched.unwrap_or_default();
        if !fetched.is_empty() {
            *self.nickname.lock().await = Some(fetched.clone());
        }
        fetched
    }

    async fn current_session(&self) -> Result<SessionState> {
        let active_profile = self.store.active_name();
        match self.store.active() {
            Some(profile) if profile.is_complete() => Ok(SessionState {
                logged_in: true,
                uid: profile.uid(),
                nickname: self.nickname().await,
                active_profile,
            }),
            // 游客态不发任何请求：不阻塞弹幕接收链路（`docs/roadmap.md` S2-AC1）。
            _ => Ok(SessionState {
                logged_in: false,
                uid: 0,
                nickname: String::new(),
                active_profile,
            }),
        }
    }
}

#[async_trait]
impl AuthProvider for BiliAuth {
    async fn session(&self) -> Result<SessionState> {
        self.current_session().await
    }

    async fn begin_qr(&self) -> Result<QrChallenge> {
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
        Ok(QrChallenge { key, url })
    }

    async fn poll_qr(&self, key: &str) -> Result<QrState> {
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
        if state == QrState::Confirmed {
            let previous = self.store.active();
            let profile = profile_from_cookies(&cookies, previous).ok_or_else(|| {
                // 判定成功却拿不到完整凭据：属于上游行为异常，明确报错而不是写半套凭据。
                Error::Upstream("扫码已确认但未取到完整凭据".into())
            })?;
            self.store.upsert_active(profile)?;
            *self.nickname.lock().await = None;
        } else if inner != 0 {
            tracing::debug!(code = inner, "扫码状态码（未确认）");
        }
        Ok(state)
    }

    async fn logout(&self) -> Result<()> {
        self.store.clear_active_credentials()?;
        *self.nickname.lock().await = None;
        Ok(())
    }

    async fn profiles(&self) -> Result<Vec<String>> {
        Ok(self.store.names())
    }

    async fn switch_profile(&self, name: &str) -> Result<SessionState> {
        self.store.set_active(name)?;
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
}
