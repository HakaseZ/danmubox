//! 发弹幕：节流、请求与 `SendOutcome` 归一化（`docs/protocol.md` §11）。
//!
//! 判定规则只按 §11.2 的字符约定（`"f"` / `"k"`）。**具体错误码的语义尚未实测**
//! （附录 A17），因此非 0 且未命中被吞标记的响应一律归为 `failed` 并保留原始 code，
//! 不猜测它属于 `rate_limited` / `medal_required` / `muted`。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use danmubox_core::ports::{DanmakuSender, EmoteToken, SendReport};
use danmubox_core::{ConfigStore, Error, Result, SendOutcome};
use serde_json::Value;

use crate::http::BiliHttp;
use crate::wbi;

/// 同房间最小发送间隔（`docs/contract.md` §4）。
pub const MIN_INTERVAL: Duration = Duration::from_secs(2);
/// 相同内容去重窗口（`docs/contract.md` §4）。
pub const DEDUP_WINDOW: Duration = Duration::from_secs(5);

const EP_MSG_SEND: &str = "https://api.live.bilibili.com/msg/send";

/// 响应 → `SendOutcome`（`docs/protocol.md` §11.2 / §11.3）。
///
/// 纯函数，便于离线覆盖各分支；真实发送的复核见附录 A16。
/// 归一化结论 + 上游原始 code / 原话。界面要回答「为什么失败」就靠它，
/// 因此 `code` 与 `msg` 一律原样带回，不翻译、不映射语义。
pub fn report_from_response(value: &Value) -> SendReport {
    SendReport {
        outcome: outcome_from_response(value),
        upstream_code: value.get("code").and_then(Value::as_i64),
        upstream_message: value
            .get("msg")
            .and_then(Value::as_str)
            .or_else(|| value.get("message").and_then(Value::as_str))
            .map(str::to_owned),
    }
}

pub fn outcome_from_response(value: &Value) -> SendOutcome {
    // 被吞标记优先于 code：实测脚本里被吞时 code 仍为 0。
    let marker = value
        .get("msg")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str));
    match marker {
        Some("f") => return SendOutcome::BlockedPlatform,
        Some("k") => return SendOutcome::BlockedRoom,
        _ => {}
    }

    match value.get("code").and_then(Value::as_i64) {
        Some(0) => SendOutcome::Ok,
        // 未实测的错误码集合：不赋予语义，保留原始 code 供日志与后续校准。
        _ => SendOutcome::Failed,
    }
}

/// 被吞时上游会回显原文：`data.mode_info.extra` 是 JSON 字符串，取其 `content`。
pub fn swallowed_content(value: &Value) -> Option<String> {
    let extra = value
        .pointer("/data/mode_info/extra")
        .and_then(Value::as_str)?;
    let parsed: Value = serde_json::from_str(extra).ok()?;
    parsed
        .get("content")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 原始响应里的 code 与 message，供日志使用（不含任何凭据）。
pub fn failure_detail(value: &Value) -> String {
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
    let message = value
        .get("message")
        .or_else(|| value.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!("code={code} message={message}")
}

/// 单房间节流状态。时间由调用方注入，便于离线测试。
#[derive(Debug, Default)]
pub struct Throttle {
    last_sent: Option<Instant>,
    last_content: Option<(String, Instant)>,
}

impl Throttle {
    /// 返回 `Err(原因)` 表示本次发送被本地节流拦下。
    pub fn check(&mut self, content: &str, now: Instant) -> std::result::Result<(), &'static str> {
        if let Some(last) = self.last_sent {
            if now.duration_since(last) < MIN_INTERVAL {
                return Err("发送过于频繁");
            }
        }
        if let Some((previous, at)) = &self.last_content {
            if previous == content && now.duration_since(*at) < DEDUP_WINDOW {
                return Err("内容与刚才重复");
            }
        }
        Ok(())
    }

    /// 记录一次**实际发出**的请求。被节流拦下时不调用，因此不刷新窗口。
    pub fn record(&mut self, content: &str, now: Instant) {
        self.last_sent = Some(now);
        self.last_content = Some((content.to_string(), now));
    }
}

pub struct BiliSender {
    http: BiliHttp,
    store: std::sync::Arc<ConfigStore>,
    throttle: Mutex<HashMap<i64, Throttle>>,
}

impl BiliSender {
    pub fn new(store: std::sync::Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(std::sync::Arc::clone(&store))?,
            store,
            throttle: Mutex::new(HashMap::new()),
        })
    }
}

#[async_trait]
impl DanmakuSender for BiliSender {
    async fn send(
        &self,
        room_id: i64,
        content: &str,
        color: Option<i64>,
        mode: Option<i64>,
        emote: Option<&EmoteToken>,
    ) -> Result<SendReport> {
        let profile = self
            .store
            .active()
            .filter(|p| p.is_complete())
            .ok_or(Error::NotLoggedIn)?;
        if content.trim().is_empty() {
            return Err(Error::BadRequest("弹幕内容为空".into()));
        }

        // 本地节流：拦下时立即返回，不发请求（`docs/contract.md` §4）。
        let now = Instant::now();
        {
            let mut rooms = self.throttle.lock().expect("throttle poisoned");
            let throttle = rooms.entry(room_id).or_default();
            if let Err(reason) = throttle.check(content, now) {
                return Err(Error::RateLimited(format!("{reason}（本地节流）")));
            }
            throttle.record(content, now);
        }

        let (img_key, sub_key) = self.http.wbi_keys().await?;
        let mixin = wbi::mixin_key(&img_key, &sub_key);
        let params = build_params(
            room_id,
            content,
            color,
            mode,
            emote,
            &profile.bili_jct,
            &format!("{}", now.elapsed().as_nanos()),
            unix_seconds(),
        );
        let body = wbi::signed_query(&params, &mixin);

        let value = self.http.post_form(EP_MSG_SEND, &body).await?;
        let report = report_from_response(&value);
        match report.outcome {
            SendOutcome::Ok => {}
            SendOutcome::BlockedPlatform | SendOutcome::BlockedRoom => {
                // 被吞原因与原文只记日志，不回显给前端（前端本就知道自己发了什么）。
                tracing::debug!(
                    room_id,
                    swallowed = swallowed_content(&value).unwrap_or_default(),
                    "弹幕被吞"
                );
            }
            _ => {
                tracing::warn!(room_id, detail = %failure_detail(&value), "发送失败");
            }
        }
        Ok(report)
    }
}

/// 组装 `msg/send` 的参数。抽成纯函数是为了能脱离网络直接断言载荷形状——
/// 「发出去但不是表情」这类问题肉眼看不出来，只能靠断言钉住。
///
/// 表情分支照抄官方实现：`msg = emoticon_unique`、`dm_type = 1`、附 `emoticonOptions`。
#[allow(clippy::too_many_arguments)]
fn build_params(
    room_id: i64,
    content: &str,
    color: Option<i64>,
    mode: Option<i64>,
    emote: Option<&EmoteToken>,
    csrf: &str,
    rnd: &str,
    wts: u64,
) -> Vec<(String, String)> {
    let mut params = vec![
        ("roomid".to_string(), room_id.to_string()),
        (
            "msg".to_string(),
            match emote {
                Some(token) => token.emoticon_unique.clone(),
                None => content.to_string(),
            },
        ),
        ("color".to_string(), color.unwrap_or(16_777_215).to_string()),
        ("fontsize".to_string(), "25".to_string()),
        ("mode".to_string(), mode.unwrap_or(1).to_string()),
        ("rnd".to_string(), rnd.to_string()),
        ("csrf".to_string(), csrf.to_string()),
        ("csrf_token".to_string(), csrf.to_string()),
        ("wts".to_string(), wts.to_string()),
    ];
    if let Some(token) = emote {
        params.push(("dm_type".to_string(), "1".to_string()));
        params.push(("emoticonOptions".to_string(), emote_options(token)));
    }
    params
}

/// 官方发送载荷里的 `emoticonOptions`（字段名照抄官方实现，camelCase）。
///
/// **编码方式待实测**：官方前端把整个对象交给它自己的请求器，本实现按 JSON 字符串
/// 放进表单；若上游不接受，会表现为「发送成功但不是表情」，见 `docs/protocol.md` §11.4。
fn emote_options(token: &EmoteToken) -> String {
    serde_json::json!({
        "width": token.width,
        "height": token.height,
        "inPlayerArea": i64::from(token.in_player_area),
        "url": token.url,
        "emoji": token.emoji,
        "isDynamic": i64::from(token.is_dynamic),
        "bulgeDisplay": i64::from(token.bulge_display),
        "emoticonUnique": token.emoticon_unique,
    })
    .to_string()
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
    use serde_json::json;

    #[test]
    fn platform_swallow_maps_to_blocked_platform() {
        for key in ["msg", "message"] {
            let value = json!({"code": 0, key: "f"});
            assert_eq!(outcome_from_response(&value), SendOutcome::BlockedPlatform);
        }
    }

    #[test]
    fn room_swallow_maps_to_blocked_room() {
        for key in ["msg", "message"] {
            let value = json!({"code": 0, key: "k"});
            assert_eq!(outcome_from_response(&value), SendOutcome::BlockedRoom);
        }
    }

    #[test]
    fn success_is_ok() {
        assert_eq!(
            outcome_from_response(&json!({"code": 0, "msg": "ok", "message": "ok"})),
            SendOutcome::Ok
        );
    }

    #[test]
    fn zero_code_without_marker_is_ok() {
        assert_eq!(outcome_from_response(&json!({"code": 0})), SendOutcome::Ok);
    }

    #[test]
    fn unknown_error_codes_are_failed_without_invented_meaning() {
        // A17 未实测前，任何非 0 code 都只能是 failed——不得猜测成 rate_limited 等。
        for code in [-101, 10030, 10031, -403, 12345] {
            let value = json!({"code": code, "message": "something"});
            assert_eq!(
                outcome_from_response(&value),
                SendOutcome::Failed,
                "code={code} 不得被赋予未实测的语义"
            );
            assert!(failure_detail(&value).contains(&code.to_string()));
        }
    }

    #[test]
    fn swallow_marker_wins_over_nonzero_code() {
        let value = json!({"code": -400, "msg": "f"});
        assert_eq!(outcome_from_response(&value), SendOutcome::BlockedPlatform);
    }

    #[test]
    fn swallowed_content_is_read_from_the_extra_json_string() {
        let value = json!({
            "code": 0,
            "msg": "f",
            "data": {"mode_info": {"extra": "{\"content\":\"被吞的原文\",\"mode\":0}"}}
        });
        assert_eq!(swallowed_content(&value).as_deref(), Some("被吞的原文"));
    }

    #[test]
    fn swallowed_content_is_none_when_absent_or_broken() {
        assert!(swallowed_content(&json!({"code": 0})).is_none());
        assert!(
            swallowed_content(&json!({"data": {"mode_info": {"extra": "not json"}}})).is_none()
        );
        assert!(
            swallowed_content(&json!({"data": {"mode_info": {"extra": "{\"content\":\"\"}"}}}))
                .is_none(),
            "空内容不算回显"
        );
    }

    fn token() -> EmoteToken {
        EmoteToken {
            emoticon_unique: "official_345".into(),
            emoji: "这个好耶".into(),
            url: "https://i0.hdslb.com/bfs/live/x.png".into(),
            width: 200,
            height: 60,
            is_dynamic: true,
            in_player_area: true,
            bulge_display: false,
        }
    }

    fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
        params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn plain_send_carries_no_emote_fields() {
        let params = build_params(7, "普通弹幕", None, None, None, "csrf", "1", 1);
        assert_eq!(param(&params, "msg"), Some("普通弹幕"));
        assert_eq!(param(&params, "dm_type"), None, "普通弹幕不得带 dm_type");
        assert_eq!(param(&params, "emoticonOptions"), None);
    }

    #[test]
    fn emote_send_sends_the_unique_key_not_the_name() {
        // 用户实测：发名字会被上游当成普通文本。官方实现发的是 emoticon_unique。
        let params = build_params(7, "这个好耶", None, None, Some(&token()), "csrf", "1", 1);
        assert_eq!(
            param(&params, "msg"),
            Some("official_345"),
            "表情弹幕的 msg 必须是唯一键，不是表情名"
        );
        assert_eq!(param(&params, "dm_type"), Some("1"), "必须标记为表情弹幕");
        let options: serde_json::Value =
            serde_json::from_str(param(&params, "emoticonOptions").expect("要有 emoticonOptions"))
                .expect("emoticonOptions 必须是合法 JSON");
        assert_eq!(options["emoticonUnique"], "official_345");
        assert_eq!(options["emoji"], "这个好耶");
        assert_eq!(options["width"], 200);
        assert_eq!(options["height"], 60);
        assert_eq!(options["isDynamic"], 1, "布尔要按官方实现转成 0/1");
        assert_eq!(options["inPlayerArea"], 1);
        assert_eq!(options["bulgeDisplay"], 0);
        assert_eq!(options["url"], "https://i0.hdslb.com/bfs/live/x.png");
    }

    #[test]
    fn throttle_enforces_min_interval() {
        let mut throttle = Throttle::default();
        let t0 = Instant::now();
        assert!(throttle.check("a", t0).is_ok());
        throttle.record("a", t0);

        assert!(
            throttle
                .check("b", t0 + Duration::from_millis(1900))
                .is_err(),
            "2 秒内第二条必须被拦"
        );
        assert!(throttle
            .check("b", t0 + Duration::from_millis(2000))
            .is_ok());
    }

    #[test]
    fn throttle_deduplicates_identical_content_within_window() {
        let mut throttle = Throttle::default();
        let t0 = Instant::now();
        throttle.record("一样的", t0);

        assert!(throttle
            .check("一样的", t0 + Duration::from_secs(3))
            .is_err());
        assert!(throttle
            .check("一样的", t0 + Duration::from_secs(5))
            .is_ok());
        assert!(throttle
            .check("不一样的", t0 + Duration::from_secs(3))
            .is_ok());
    }

    #[test]
    fn blocked_attempt_does_not_refresh_the_window() {
        let mut throttle = Throttle::default();
        let t0 = Instant::now();
        throttle.record("a", t0);

        // 1.8s 时尝试第二条，被最小间隔拦下。
        assert!(throttle
            .check("b", t0 + Duration::from_millis(1800))
            .is_err());
        // 关键：被拦下不调用 record，因此到 2.0s 就应放行；
        // 若拦下也刷新了窗口，这里仍会被拦。
        assert!(
            throttle
                .check("b", t0 + Duration::from_millis(2000))
                .is_ok(),
            "被拦下的尝试不得延长窗口"
        );
    }
}
