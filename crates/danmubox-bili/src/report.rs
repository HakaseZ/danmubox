//! 举报弹幕（`docs/contract.md` §3 `DanmakuReporter`）。
//!
//! 需求是「同官方的举报行为」（`REQUIREMENTS.md` §2.4）。官方 web 端举报一条直播弹幕
//! 走 `xlive/web-ucenter/v1/dMReport/Report`；本模块按该形态实现：理由按不透明字符串
//! 传递，响应 code 只透传不解释，绝不为未实测的枚举或结果码编造语义。
//!
//! ## 未实测项（由维护者统一登记到 `docs/protocol.md` 附录 A）
//!
//! | 项 | 现状 | 说明 |
//! |---|---|---|
//! | 端点 | `POST https://api.live.bilibili.com/xlive/web-ucenter/v1/dMReport/Report` | **未实测**。仅做过一次无凭据 POST 探测，返回 `{"code":-101,"message":"账号未登录"}`，只能证明该路径存在；登录态真实举报待核对 |
//! | 表单字段 | `roomid` / `id_str` / `tuid` / `msg` / `reason` / `dm_type` / `csrf` / `csrf_token` | **未实测**。字段集合取自一个公开的第三方直播客户端，未与官方 web 抓包逐字对照 |
//! | 举报标识 | `id_str` = `Message.upstream_id` | `upstream_id` 的来源已实测（`protocol.md` §10.1：`info[0][15].extra` 的 `id_str`，36 位十六进制）；上游是否同时要求数字型 `id` **未实测** |
//! | 理由取值 | 原样传递调用方传入的字符串 | 合法取值集合 **未实测**，且 `reason` → `reason_id` 的映射未知；代码里不得写死理由枚举或该映射 |
//! | `sign` / `ts` / `reason_id` / `token` | **不发送** | 第三方实现会附带逐条弹幕的 `check_info.ct`（`sign`）与 `check_info.ts`（`ts`）；而契约 §5 固定的 `Message` 字段集不含这两个值，无从提供。是否必需、缺失时上游如何拒绝，均 **未实测** |
//! | 结果码 | 只判 `code == 0` | 非 0 一律 `Error::Upstream` 并保留原始 code 与 message，**不解释**语义 |
//! | WBI 签名 | 照 `send.rs` 对表单做 WBI 签名（含 `wts` / `w_rid`） | 是否必需 **未实测**；参考实现未签名 |

use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::DanmakuReporter;
use danmubox_core::{ConfigStore, Error, Message, ReportReason, Result};
use serde_json::Value;

use crate::http::BiliHttp;
use crate::wbi;

/// 直播弹幕举报端点。**未实测**（见模块文档）。
pub const EP_DM_REPORT: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/dMReport/Report";

/// 举报理由清单端点。**已实测**（2026-09-11，登录态 `code=0`，返回 7 条 `{id, reason}`）。
pub const EP_FOR_REASON: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/dMReport/ForReason";

/// 解析理由清单。信封是 `data.data[]`，每项 `{id, reason}`（实测形状）。
///
/// 无法解析的条目直接跳过——理由清单只用于给用户选，缺一条不影响其它条目可用。
pub fn parse_reasons(value: &Value) -> Vec<ReportReason> {
    value
        .pointer("/data/data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ReportReason {
                        id: item.get("id").and_then(Value::as_i64)?,
                        reason: item.get("reason").and_then(Value::as_str)?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 组装举报表单参数（不含 `wts` / `w_rid`，签名由调用方补）。
///
/// 纯函数，便于离线覆盖。房间号由参数传入，**不读 `message.room_id`**，
/// 以免把载荷内的房间字段带进请求（`docs/protocol.md` §10.1 的房间来源约定）。
/// 理由按不透明字符串原样传递，不做枚举映射。
pub fn report_params(
    message: &Message,
    reason: &ReportReason,
    csrf: &str,
    room_id: i64,
) -> Vec<(String, String)> {
    vec![
        ("roomid".to_string(), room_id.to_string()),
        // 举报标识：`id_str`（`upstream_id` 已被实测为 36 位十六进制串）。
        ("id_str".to_string(), message.upstream_id.clone()),
        // 被举报弹幕的发送者与原文；参考实现的请求带这两项。
        ("tuid".to_string(), message.uid.to_string()),
        ("msg".to_string(), message.content.clone()),
        // 官方实现同时上报文案与 id：id 从 ForReason 清单里按文案反查得到。
        ("reason".to_string(), reason.reason.clone()),
        ("reason_id".to_string(), reason.id.to_string()),
        // 参考实现对文本弹幕固定发 `dm_type=0`；该取值语义未实测。
        ("dm_type".to_string(), "0".to_string()),
        ("csrf".to_string(), csrf.to_string()),
        ("csrf_token".to_string(), csrf.to_string()),
    ]
}

/// 举报响应 → `Result<()>`：`code == 0` 视为成功，其余保留原始 code 与 message 报错。
///
/// 响应缺失 `code` 时同样报错——举报不得因为解析不到字段而**默默成功**。
pub fn outcome_from_report(value: &Value) -> Result<()> {
    let code = value.get("code").and_then(Value::as_i64);
    if code == Some(0) {
        return Ok(());
    }
    let message = value
        .get("message")
        .or_else(|| value.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    // code 缺失时用 `None` 明确暴露，不折算成任何编造的错误码。
    Err(Error::Upstream(format!(
        "举报失败 code={code:?} message={message}"
    )))
}

pub struct BiliReporter {
    http: BiliHttp,
    store: Arc<ConfigStore>,
}

impl BiliReporter {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
        })
    }
}

#[async_trait]
impl DanmakuReporter for BiliReporter {
    async fn reasons(&self) -> Result<Vec<ReportReason>> {
        let (value, _cookies) = self.http.get_with_cookies(EP_FOR_REASON).await?;
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            // 未实测的码集合：保留原始 code，不赋予语义。
            return Err(Error::Upstream(format!("ForReason code={code}")));
        }
        Ok(parse_reasons(&value))
    }

    async fn report(&self, message: &Message, reason: &ReportReason) -> Result<()> {
        let profile = self
            .store
            .active()
            .filter(|p| p.is_complete())
            .ok_or(Error::NotLoggedIn)?;
        if reason.reason.trim().is_empty() {
            return Err(Error::BadRequest("举报理由为空".into()));
        }
        if message.upstream_id.trim().is_empty() {
            return Err(Error::BadRequest(
                "该弹幕缺少举报标识（upstream_id 为空），无法举报".into(),
            ));
        }

        let (img_key, sub_key) = self.http.wbi_keys().await?;
        let mixin = wbi::mixin_key(&img_key, &sub_key);
        // 端口只给出 `Message`；房间号取其 `room_id`（适配器从连接上下文填充，
        // 非上游载荷内的房间字段）。纯函数仍通过参数接收，便于单测断言。
        let mut params = report_params(message, reason, &profile.bili_jct, message.room_id);
        params.push(("wts".to_string(), unix_seconds().to_string()));
        let body = wbi::signed_query(&params, &mixin);

        let value = self.http.post_form(EP_DM_REPORT, &body).await?;
        outcome_from_report(&value)
    }
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmubox_core::{MessageKind, Profile};
    use serde_json::json;

    fn sample_message() -> Message {
        let mut message = Message::new(1, MessageKind::Danmaku, 0);
        message.uid = 42;
        message.uname = "观众".into();
        message.content = "被举报的内容".into();
        message.upstream_id = "0123456789abcdef0123456789abcdef0123".into();
        message
    }

    fn not_logged_in_store(tag: &str) -> Arc<ConfigStore> {
        let path = std::env::temp_dir()
            .join(format!("danmubox-report-test-{}-{tag}", std::process::id()))
            .join("config.toml");
        Arc::new(ConfigStore::load(path).expect("空配置应可加载"))
    }

    fn store_with_login(tag: &str) -> Arc<ConfigStore> {
        let store = not_logged_in_store(tag);
        store
            .upsert_active(Profile {
                sessdata: "SESSDATA".into(),
                bili_jct: "JCT".into(),
                dede_user_id: "42".into(),
                ..Default::default()
            })
            .expect("写入临时配置");
        store
    }

    #[test]
    fn report_params_carry_target_reason_csrf_and_the_passed_room() {
        let message = sample_message();
        let params = report_params(
            &message,
            &ReportReason { id: 3, reason: "色情低俗".into() },
            "CSRF-TOKEN",
            9999,
        );
        let value = |key: &str| {
            params
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };

        assert_eq!(value("csrf"), Some("CSRF-TOKEN"));
        assert_eq!(value("csrf_token"), Some("CSRF-TOKEN"));
        // 目标标识必须来自 `upstream_id`。
        assert_eq!(value("id_str"), Some(message.upstream_id.as_str()));
        assert_eq!(value("reason"), Some("色情低俗"));
        assert_eq!(value("tuid"), Some("42"));
        assert_eq!(value("msg"), Some("被举报的内容"));
        // 房间号只认参数：载荷里的 room_id 是 1，这里必须原样用 9999。
        assert_eq!(
            value("roomid"),
            Some("9999"),
            "房间号必须来自参数，不得回落到载荷内的 room_id"
        );
    }

    #[test]
    fn zero_code_is_ok() {
        assert!(outcome_from_report(&json!({"code": 0, "message": "0"})).is_ok());
    }

    #[test]
    fn non_zero_code_keeps_raw_code_and_message_without_invented_meaning() {
        // 这些 code 只用于验证「原样透传」；其语义未实测，不在此断言任何归类。
        for code in [-101, -111, -400, 36203, 12345] {
            let text = format!("upstream message {code}");
            let error = outcome_from_report(&json!({"code": code, "message": text}))
                .expect_err("非 0 code 必须报错");
            assert_eq!(error.code(), "UPSTREAM_ERROR");
            let rendered = error.to_string();
            assert!(
                rendered.contains(&code.to_string()),
                "必须保留原始 code：{rendered}"
            );
            assert!(rendered.contains(&text), "必须保留原始 message：{rendered}");
        }
    }

    #[test]
    fn missing_code_is_an_error_not_a_silent_success() {
        let error = outcome_from_report(&json!({"message": "无 code"})).expect_err("缺 code 必须报错");
        assert_eq!(error.code(), "UPSTREAM_ERROR");
    }

    #[tokio::test]
    async fn not_logged_in_is_rejected() {
        let reporter = BiliReporter::new(not_logged_in_store("anon")).unwrap();
        let error = reporter
            .report(
                &sample_message(),
                &ReportReason { id: 8, reason: "垃圾广告".into() },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code(), "NOT_LOGGED_IN");
    }

    #[tokio::test]
    async fn empty_reason_is_bad_request() {
        let reporter = BiliReporter::new(store_with_login("reason")).unwrap();
        for text in ["", "   ", "\t\n"] {
            let reason = ReportReason {
                id: 0,
                reason: text.into(),
            };
            let error = reporter
                .report(&sample_message(), &reason)
                .await
                .unwrap_err();
            assert_eq!(error.code(), "BAD_REQUEST", "reason={text:?}");
        }
    }

    #[tokio::test]
    async fn empty_upstream_id_is_bad_request() {
        let reporter = BiliReporter::new(store_with_login("upstream")).unwrap();

        let mut message = sample_message();
        message.upstream_id.clear();
        let error = reporter.report(&message, &ReportReason { id: 8, reason: "垃圾广告".into() }).await.unwrap_err();
        assert_eq!(error.code(), "BAD_REQUEST");

        // 全空白标识同样拒绝，不得静默放行。
        message.upstream_id = "   ".into();
        let error = reporter.report(&message, &ReportReason { id: 8, reason: "垃圾广告".into() }).await.unwrap_err();
        assert_eq!(error.code(), "BAD_REQUEST");
    }
}
