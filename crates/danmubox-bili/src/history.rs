//! 进场回填：上游能给的「最近若干条」弹幕（`dM/gethistory`）。
//!
//! 需求来源：官方 web 客户端进房间时弹幕区不是空的，而是先铺一批最近的弹幕。
//! 本模块只做这一件事；生命周期与语义见 `docs/contract.md` §4.3。
//!
//! ## 实测结论（2026-09-12，详见 `docs/protocol.md` 附录 A30）
//!
//! | 项 | 值 |
//! |---|---|
//! | 端点 | `GET https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory` |
//! | 参数 | `roomid`（真实房间号）+ `room_type`（官方页面取值为 `0` 或 `1`，两者都实测返回过数据） |
//! | 上限 | `data.room` 恰好 10 条（普通用户）+ `data.admin` 至多 10 条（房管）= **最多 20 条** |
//! | 分页 | **不存在**：`limit` / `page_size` / `size` / `ps` / `page` / `offset` / `last_id` 实测均不加量 |
//! | 登录 | **不需要**；带与不带 Cookie 实测结果一致 |
//! | 时间 | `timeline` 是**北京时间（UTC+8）**的 `yyyy-MM-dd HH:mm:ss`，秒级 |
//!
//! ## 上游不可靠，因此本模块是「尽力而为」
//!
//! 实测该端点在服务端**成批地在「正常返回」与「`code=0` 但两个数组皆空」之间翻转**：
//! 同一房间、同一参数、同一秒内，页面原生请求能拿到 10+10，而紧接着的请求（**包括在页面
//! 内部发的 fetch**）拿到 0+0；空窗可持续数十秒以上。因此：
//!
//! - **空数组既不是错误、也不代表该房间没有弹幕**，一律按「这次没取到」处理；
//! - 不重试、不阻塞进场（拿不到就和平常一样从空列表开始，见 `contract.md` §4.3）；
//! - 取到的每一条都标 `is_history = true`，界面上与实时弹幕区分（`docs/ui.md` §4.7）。

use danmubox_core::{Message, MessageKind, Result};
use serde_json::Value;

use crate::http::BiliHttp;

pub const EP_HISTORY: &str = "https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory";

/// 官方页面对该接口的取值之一；`room_type=0` 亦有实测样本。
const ROOM_TYPE: i64 = 1;

/// 单次请求超时。进场回填是锦上添花，上游卡住时绝不允许拖住连接建立。
const HISTORY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2_000);

/// 北京时间相对 UTC 的固定偏移（东八区，无夏令时）。
const BEIJING_OFFSET_MS: i64 = 8 * 60 * 60 * 1000;

/// 把 `yyyy-MM-dd HH:mm:ss`（**北京时间**）转成 UTC 毫秒。
///
/// 实测依据：请求时 UTC 为 `00:49`，返回的 `timeline` 为 `08:49`，差 8 小时。
/// 任何字段缺失、越界或格式不符一律返回 `None`（不做容错猜测，避免造出假时间）。
pub fn parse_beijing_ts(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b' ' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let slice = text.get(from..to)?;
        if !slice.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        slice.parse::<i64>().ok()
    };
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }

    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(seconds * 1_000 - BEIJING_OFFSET_MS)
}

/// 公历日期 → 自 1970-01-01 起的天数（Howard Hinnant 的 `days_from_civil`）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 把 `gethistory` 响应映射成历史弹幕（`is_history = true`）。
///
/// `data.room`（普通用户）与 `data.admin`（房管）都映射，保持各自原始顺序：
/// 先房管后普通，与官方客户端一致（两者上限各 10 条）。
pub fn map_history(room_id: i64, value: &Value) -> Vec<Message> {
    let mut out = Vec::new();
    for key in ["admin", "room"] {
        let Some(items) = value.pointer(&format!("/data/{key}")).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(message) = map_item(room_id, item) {
                out.push(message);
            }
        }
    }
    out
}

fn map_item(room_id: i64, item: &Value) -> Option<Message> {
    let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
    let uid = item.get("uid").and_then(Value::as_i64).unwrap_or(0);
    // 既无内容也无发送者，视为解析不出的一条，直接丢弃而不是造一条空弹幕。
    if text.is_empty() && uid == 0 {
        return None;
    }

    let mut message = Message::new(
        room_id,
        MessageKind::Danmaku,
        item.get("timeline")
            .and_then(Value::as_str)
            .and_then(parse_beijing_ts)
            .unwrap_or(0),
    );
    message.uid = uid;
    message.uname = item
        .get("nickname")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    message.content = text.to_string();
    // 历史条目没有文字颜色字段（实测字段清单里只有 uname_color），置 0 表示未知。
    message.color = 0;
    // 粉丝牌取结构化的 `user.medal.{level,name}`（官方文档的响应样例如此），
    // 顶层 `medal` 数组的下标含义未见文档，不猜。
    message.medal_level = item
        .pointer("/user/medal/level")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    message.medal_name = item
        .pointer("/user/medal/name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    message.guard_level = item.get("guard_level").and_then(Value::as_i64).unwrap_or(0);
    message.is_admin = item.get("isadmin").and_then(Value::as_i64).unwrap_or(0) != 0;
    message.upstream_id = item
        .get("id_str")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // 表情弹幕：历史条目的字段布局与实时 `DANMU_MSG` **不同**——实时在 `info[0][13]`，
    // 历史在顶层的 `emoticon` 对象里（`{emoticon_unique, text, url, width, height, is_dynamic, ...}`）。
    // 不处理这一支，回填进来的表情就只会显示成表情名（用户实测如此）。
    // 只有当**整条正文就是这个表情**时才画图（实测样本的正文正是 `[小电视_赞]` 这类 token）。
    // 正文里夹着别的字（如「谢谢[小电视_赞]」）时保持原文——整段替换会吞掉正文。
    if let Some(emote) = item.get("emoticon").and_then(Value::as_object) {
        let emote_text = emote
            .get("text")
            .or_else(|| emote.get("emoji"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(url) = emote.get("url").and_then(Value::as_str) {
            if !url.is_empty() && emote_text == message.content {
                message.emote_url = crate::asset::secure_url(url);
            }
        }
    }

    message.is_history = true;
    Some(message)
}

/// 拉取一次历史弹幕；**不重试**，失败与空结果都由调用方按「没取到」处理。
pub async fn fetch_history(http: &BiliHttp, room_id: i64) -> Result<Vec<Message>> {
    let url = format!("{EP_HISTORY}?roomid={room_id}&room_type={ROOM_TYPE}");
    let (value, _cookies) = tokio::time::timeout(HISTORY_TIMEOUT, http.get_with_cookies(&url))
        .await
        .map_err(|_| {
            danmubox_core::Error::Upstream(format!(
                "历史弹幕请求超时（{}ms）",
                HISTORY_TIMEOUT.as_millis()
            ))
        })??;
    Ok(map_history(room_id, &value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn beijing_time_is_converted_to_utc() {
        // 实测样本：UTC 00:49 时上游返回 08:49。
        assert_eq!(
            parse_beijing_ts("2026-09-12 08:49:31"),
            Some(1_789_174_171_000),
            "北京时间 08:49:31 应为 UTC 00:49:31"
        );
    }

    #[test]
    fn epoch_boundary_is_exact() {
        // 北京时间 1970-01-01 08:00:00 == UTC 纪元。
        assert_eq!(parse_beijing_ts("1970-01-01 08:00:00"), Some(0));
        assert_eq!(parse_beijing_ts("1970-01-01 00:00:00"), Some(-28_800_000));
    }

    #[test]
    fn malformed_timelines_are_rejected_not_guessed() {
        for bad in [
            "",
            "2026-09-12",
            "2026/09/12 08:49:31",
            "2026-09-12 08:49",
            "2026-13-12 08:49:31",
            "2026-09-32 08:49:31",
            "2026-09-12 24:00:00",
            "2026-09-12 08:60:00",
            "abcd-09-12 08:49:31",
        ] {
            assert_eq!(parse_beijing_ts(bad), None, "不应接受 {bad:?}");
        }
    }

    #[test]
    fn maps_both_arrays_in_order_with_history_flag() {
        let value = json!({
            "code": 0,
            "data": {
                "admin": [{
                    "text": "房管的弹幕",
                    "uid": 11,
                    "nickname": "admin-a",
                    "timeline": "2026-09-12 08:49:31",
                    "isadmin": 1,
                    "guard_level": 3,
                    "id_str": "aaa",
                    "user": {"medal": {"name": "牌子", "level": 21}}
                }],
                "room": [{
                    "text": "普通弹幕",
                    "uid": 22,
                    "nickname": "user-b",
                    "timeline": "2026-09-12 08:49:32",
                    "isadmin": 0,
                    "guard_level": 0,
                    "id_str": "bbb"
                }]
            }
        });

        let messages = map_history(7, &value);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "房管的弹幕", "房管数组在前");
        assert_eq!(messages[1].content, "普通弹幕");
        assert!(messages[0].is_history && messages[1].is_history);
        assert_eq!(messages[0].room_id, 7);
        assert_eq!(messages[0].uid, 11);
        assert!(messages[0].is_admin);
        assert_eq!(messages[0].guard_level, 3);
        assert_eq!(messages[0].medal_level, 21);
        assert_eq!(messages[0].medal_name, "牌子");
        assert_eq!(messages[0].upstream_id, "aaa", "举报需要上游标识");
        assert_eq!(messages[0].kind, MessageKind::Danmaku);
        assert!(messages[1].medal_level == 0 && messages[1].medal_name.is_empty());
    }

    #[test]
    fn history_emote_danmaku_carries_the_image_url() {
        // 历史条目的表情在顶层 `emoticon` 对象里（与实时弹幕的 `info[0][13]` 不同布局）。
        let value = json!({
            "data": {"room": [{
                "text": "这个好耶",
                "uid": 22,
                "nickname": "观众乙",
                "timeline": "2026-09-12 08:49:32",
                "dm_type": 1,
                "emoticon": {
                    "id": 0,
                    "emoticon_unique": "official_345",
                    "text": "这个好耶",
                    "url": "http://i0.hdslb.com/bfs/live/x.png",
                    "is_dynamic": 1,
                    "height": 60,
                    "width": 200
                }
            }]}
        });
        let messages = map_history(7, &value);
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].emote_url,
            "https://i0.hdslb.com/bfs/live/x.png",
            "历史里的表情同样要升级为 https，否则在客户端里加载不出来"
        );
        assert_eq!(messages[0].content, "这个好耶");
    }

    #[test]
    fn history_text_with_extra_words_keeps_the_text() {
        // 表情只是正文的一部分时不画图——整段替换会把「谢谢」吞掉。
        let value = json!({"data": {"room": [{
            "text": "谢谢[小电视_赞]", "uid": 22, "timeline": "2026-09-12 08:49:32",
            "dm_type": 1,
            "emoticon": {"text": "[小电视_赞]", "url": "https://i0.hdslb.com/bfs/emote/x.png"}
        }]}});
        let messages = map_history(7, &value);
        assert_eq!(messages[0].content, "谢谢[小电视_赞]");
        assert!(messages[0].emote_url.is_empty(), "混排正文不得被整段替换成图片");
    }

    #[test]
    fn history_entry_without_emote_stays_text() {
        let value = json!({"data": {"room": [{
            "text": "普通弹幕", "uid": 22, "timeline": "2026-09-12 08:49:32",
            "emoticon": {"emoticon_unique": "", "url": ""}
        }]}});
        let messages = map_history(7, &value);
        assert!(messages[0].emote_url.is_empty(), "空 url 不得当成表情");
    }

    #[test]
    fn empty_arrays_yield_nothing_and_missing_timeline_is_zero_not_a_guess() {
        assert!(map_history(7, &json!({"code": 0, "data": {"admin": [], "room": []}})).is_empty());
        assert!(map_history(7, &json!({"code": 0})).is_empty());

        let value = json!({"data": {"room": [{"text": "没有时间", "uid": 5}]}});
        let messages = map_history(7, &value);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].ts, 0, "时间解析不出来时不编造时间");
    }

    #[test]
    fn entries_without_text_and_sender_are_dropped() {
        let value = json!({"data": {"room": [{"timeline": "2026-09-12 08:49:31"}]}});
        assert!(map_history(7, &value).is_empty());
    }
}
