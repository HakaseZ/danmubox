//! 关注列表（`docs/contract.md` §3 `RoomCatalog`）。
//!
//! 需求来源：`REQUIREMENTS.md` §2.6「登录后能看到所有关注的直播间，并且置顶正在直播的直播间」。
//! 排序不在这里自造：`followed()` 在返回前调用 `danmubox_core::sort_followed`，
//! 后者把 `live_status == 1` 置顶、其余按房间号稳定升序。
//!
//! ## 实测结论（2026-09-11，校准项见 `docs/protocol.md` 附录 A28）
//!
//! 端点与信封已用真实登录态实测；该账号关注数为 0，因此**条目字段名仍未能确认**。
//!
//! - **端点**：`GET /xlive/web-ucenter/v1/xfetter/GetWebList`（实测 `code=0`）。
//!   此前猜测的 `/xlive/web-interface/v1/relation/getUserFollowList` 不成立。
//! - **分页参数**：`page` / `page_size` 实测可用。
//! - **响应信封**：`data.{rooms, list, count, not_living_num}`。
//!   `rooms` 与 `list` 哪个承载房间列表**尚未确认**（该账号 `count=0`，两者都是空数组），
//!   代码取 `data.list`；等有非空关注时复核。
//! - **分页终止**：响应里**没有** `has_more`。改为「本页条数 == page_size 则认为还有下一页」
//!   （可观察且保守）；若上游某天真的给了 `has_more`，优先采信它。
//! - **条目字段名**（每个字段按候选顺序取，全部缺失时用零值/空串并打 debug）：
//!   - 房间号：`roomid` / `room_id`。
//!   - 昵称：`uname` / `name` / `nickname`。
//!   - 头像：`face` / `cover` / `user_cover`。
//!   - 直播状态：`live_status` / `liveStatus`。
//!   - 分组名：`group_name` / `groupName` / `tag_name` / `group`。
//!   - 本场开播时刻：`liveTime`（Unix 秒，实测 2026-09-12）——注意同响应里
//!     还有 `live_time`（已开播秒数），两者是不同的量，不能混用。
//!   - 在线人数：`online`（实测 2026-09-12）。
//! - **`live_status` 口径**：只按 JSON 整数值归一（`0` 未开播 / `1` 直播中 / `2` 轮播，
//!   见 `docs/contract.md` §5）；**不**为任何其它整数值编造含义，非整数一律按 `0` 容错。
//! - **结果码语义**：非 0 code 一律作为 `UPSTREAM_ERROR` 上报并保留原始 code，
//!   不赋予「未登录 / 权限不足」等未实测语义。

use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::RoomCatalog;
use danmubox_core::{sort_followed, ConfigStore, Error, FollowedRoom, Result};
use serde_json::Value;

use crate::http::BiliHttp;

/// 关注列表端点（**未实测**，见模块文档候选列表）。
const EP_FOLLOW_LIST: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/xfetter/GetWebList";

/// 单页拉取条数（**未实测**，候选 20 / 30 / 50）。
pub const PAGE_SIZE: i64 = 30;

/// 翻页上限，防止 `has_more` 恒真时无限请求（安全阀，非上游约定）。
pub const MAX_PAGES: i64 = 20;

/// 从响应信封中取出列表数组；识别不了时返回 `None`（由调用方按空列表容错）。
fn items(value: &Value) -> Option<&Vec<Value>> {
    value
        .pointer("/data/list")
        .and_then(Value::as_array)
        .or_else(|| value.pointer("/data/items").and_then(Value::as_array))
        .or_else(|| value.get("data").and_then(Value::as_array))
}

/// 按候选名依次取字符串字段，全部缺失或为空串时返回空串。
fn str_field(item: &Value, names: &[&str]) -> String {
    for name in names {
        if let Some(text) = item.get(*name).and_then(Value::as_str) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

/// 按候选名依次取整数字段，全部缺失或非整数时返回 0。
///
/// 只接受 JSON 整数；字符串数字不在此猜测转换（未实测，见模块文档）。
fn int_field(item: &Value, names: &[&str]) -> i64 {
    for name in names {
        if let Some(number) = item.get(*name).and_then(Value::as_i64) {
            return number;
        }
    }
    0
}

/// 单条关注记录 → `FollowedRoom`（字段候选名见模块文档）。
fn map_item(item: &Value) -> FollowedRoom {
    let room_id = int_field(item, &["roomid", "room_id"]);
    if room_id == 0 {
        tracing::debug!("关注列表条目缺 roomid/room_id，按 0 容错");
    }
    FollowedRoom {
        room_id,
        uname: str_field(item, &["uname", "name", "nickname"]),
        face: str_field(item, &["face", "cover", "user_cover"]),
        live_status: int_field(item, &["live_status", "liveStatus"]) as i32,
        group_name: str_field(item, &["group_name", "groupName", "tag_name", "group"]),
        // 开播时刻取 `liveTime`（Unix 秒）。**不要**误取 `live_time`：后者是
        // 「已开播秒数」，两者相加约等于当前时间（实测同一响应里
        // `liveTime=1789174974` 与 `live_time=12699` 同时存在）。
        live_start_at: int_field(item, &["liveTime", "live_start_at"]),
        online: int_field(item, &["online"]),
    }
}

/// 响应 → 关注列表（纯函数，便于离线覆盖各分支）。
///
/// 缺字段一律零值/空串容错并打 debug，不猜测、不报错、不编造语义。
pub fn map_followed(value: &Value) -> Vec<FollowedRoom> {
    let Some(list) = items(value) else {
        tracing::debug!("关注列表响应缺少可识别的列表字段，按空列表容错");
        return Vec::new();
    };
    list.iter().map(map_item).collect()
}

/// 是否还有下一页。
///
/// 上游响应里没有 `has_more`（实测），因此：
///
/// 1. 若某天真的出现 `data.has_more` / `data.hasMore`，优先采信它（bool 或 0/1 整数）；
/// 2. 否则按「本页条数 == `page_size`」推断还有下一页——可观察且保守，
///    少翻一页只是少几条数据，不会多打请求。
pub fn has_more(value: &Value, page_size: i64) -> bool {
    let flag = value
        .pointer("/data/has_more")
        .or_else(|| value.pointer("/data/hasMore"));
    match flag {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().map(|n| n != 0).unwrap_or(false),
        _ => items(value).map(|list| list.len() as i64 >= page_size).unwrap_or(false),
    }
}

/// 关注列表适配器。凭据由 `BiliHttp` 实时读取当前 profile，
/// 因此切换账号后无需重建本实例。
pub struct BiliFollow {
    http: BiliHttp,
    store: Arc<ConfigStore>,
}

impl BiliFollow {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
        })
    }
}

#[async_trait]
impl RoomCatalog for BiliFollow {
    async fn followed(&self) -> Result<Vec<FollowedRoom>> {
        if !self.store.is_logged_in() {
            return Err(Error::NotLoggedIn);
        }

        let mut rooms = Vec::new();
        let mut page = 1i64;
        loop {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("page", &page.to_string())
                .append_pair("page_size", &PAGE_SIZE.to_string())
                .append_pair("ignoreMyself", "1")
                .finish();
            let (value, _) = self
                .http
                .get_with_cookies(&format!("{EP_FOLLOW_LIST}?{query}"))
                .await?;

            let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
            if code != 0 {
                // 未实测的结果码集合：不赋予语义，保留原始 code 供日志与后续校准。
                return Err(Error::Upstream(format!("getUserFollowList code={code}")));
            }

            let page_rooms = map_followed(&value);
            let more = has_more(&value, PAGE_SIZE);
            if page_rooms.is_empty() {
                break;
            }
            rooms.extend(page_rooms);

            if !more || page >= MAX_PAGES {
                if more {
                    tracing::debug!(page, MAX_PAGES, "关注列表达到翻页上限，截断返回");
                }
                break;
            }
            page += 1;
        }

        sort_followed(&mut rooms);
        Ok(rooms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn follow_map_normal_list_puts_live_first() {
        let value = json!({
            "code": 0,
            "data": {
                "has_more": 0,
                "list": [
                    {
                        "roomid": 3,
                        "uname": "离线主播",
                        "face": "https://example.invalid/3.jpg",
                        "live_status": 0,
                        "group_name": "默认分组"
                    },
                    {
                        "roomid": 1,
                        "uname": "在播主播",
                        "face": "https://example.invalid/1.jpg",
                        "live_status": 1,
                        "group_name": "默认分组"
                    }
                ]
            }
        });
        let mut rooms = map_followed(&value);
        assert_eq!(rooms.len(), 2);
        assert_eq!(rooms[0].room_id, 3, "映射阶段保持上游顺序");

        sort_followed(&mut rooms);
        let ids: Vec<i64> = rooms.iter().map(|r| r.room_id).collect();
        assert_eq!(ids, vec![1, 3], "直播中置顶");
        assert_eq!(rooms[0].uname, "在播主播");
        assert_eq!(rooms[0].face, "https://example.invalid/1.jpg");
        assert_eq!(rooms[0].live_status, 1);
        assert_eq!(rooms[0].group_name, "默认分组");
        assert_eq!(rooms[1].live_status, 0);
    }

    #[test]
    fn follow_map_missing_fields_zeroed() {
        let value = json!({ "code": 0, "data": { "list": [{}] } });
        let rooms = map_followed(&value);
        assert_eq!(
            rooms,
            vec![FollowedRoom {
                room_id: 0,
                uname: String::new(),
                face: String::new(),
                live_status: 0,
                group_name: String::new(),
                live_start_at: 0,
                online: 0,
            }]
        );
    }

    #[test]
    fn follow_map_uses_live_time_not_live_time_seconds() {
        // 实测同响应里两个字段并存：`liveTime` 是开播时刻（Unix 秒），
        // `live_time` 是已开播秒数。只能取前者。
        let value = json!({
            "data": { "list": [{
                "roomid": 1,
                "liveTime": 1789174974,
                "live_time": 12699,
                "online": 3739
            }] }
        });
        let rooms = map_followed(&value);
        assert_eq!(rooms[0].live_start_at, 1789174974);
        assert_eq!(rooms[0].online, 3739);
    }

    #[test]
    fn follow_map_accepts_snake_case_live_start_at() {
        let value = json!({ "data": { "list": [{ "roomid": 1, "live_start_at": 123 }] } });
        assert_eq!(map_followed(&value)[0].live_start_at, 123);
    }

    #[test]
    fn follow_map_empty_list() {
        assert!(map_followed(&json!({ "code": 0, "data": { "list": [] } })).is_empty());
        // 识别不了信封时也按空列表容错，不 panic。
        assert!(map_followed(&json!({ "code": 0 })).is_empty());
        assert!(map_followed(&json!({ "data": null })).is_empty());
    }

    #[test]
    fn follow_map_alternate_field_names() {
        let value = json!({
            "data": {
                "items": [
                    {
                        "room_id": 42,
                        "nickname": "别名主播",
                        "user_cover": "https://example.invalid/42.jpg",
                        "liveStatus": 2,
                        "groupName": "别名分组"
                    }
                ]
            }
        });
        let rooms = map_followed(&value);
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].room_id, 42);
        assert_eq!(rooms[0].uname, "别名主播");
        assert_eq!(rooms[0].face, "https://example.invalid/42.jpg");
        assert_eq!(rooms[0].live_status, 2);
        assert_eq!(rooms[0].group_name, "别名分组");
    }

    #[test]
    fn follow_map_live_status_only_integer() {
        // 非整数（字符串/浮点）不为任何值编造含义，一律按 0 容错。
        let value = json!({
            "data": { "list": [
                { "roomid": 1, "live_status": "1" },
                { "roomid": 2, "live_status": 1.5 }
            ] }
        });
        let rooms = map_followed(&value);
        assert_eq!(rooms[0].live_status, 0);
        assert_eq!(rooms[1].live_status, 0);
    }

    #[test]
    fn follow_has_more_prefers_flag_when_upstream_sends_one() {
        assert!(has_more(&json!({ "data": { "has_more": true } }), 30));
        assert!(has_more(&json!({ "data": { "has_more": 1 } }), 30));
        assert!(!has_more(&json!({ "data": { "has_more": false } }), 30));
        assert!(!has_more(&json!({ "data": { "has_more": 0 } }), 30));
        assert!(has_more(&json!({ "data": { "hasMore": 1 } }), 30));
    }

    #[test]
    fn follow_has_more_falls_back_to_full_page_rule() {
        // 上游实测不给 has_more：满页认为还有下一页，不满页即终止。
        let full: Vec<Value> = (0..30).map(|i| json!({ "roomid": i })).collect();
        let short: Vec<Value> = (0..29).map(|i| json!({ "roomid": i })).collect();
        assert!(has_more(&json!({ "data": { "list": full } }), 30));
        assert!(!has_more(&json!({ "data": { "list": short } }), 30));
        assert!(!has_more(&json!({ "data": { "list": [] } }), 30));
        // 类型不认识的 has_more 不当作标志位，回落满页规则。
        assert!(!has_more(&json!({ "data": { "has_more": "1", "list": [] } }), 30));
    }
}
