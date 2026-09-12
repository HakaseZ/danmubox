//! 关注列表（`docs/contract.md` §3 `RoomCatalog`）。
//!
//! 需求来源：`REQUIREMENTS.md` §2.6「登录后能看到所有关注的直播间，并且置顶正在直播的直播间」。
//! 排序不在这里自造：`followed()` 在返回前调用 `danmubox_core::sort_followed`，
//! 后者把 `live_status == 1` 置顶、其余按房间号稳定升序。
//!
//! ## 实测结论（2026-09-13 复核，校准项见 `docs/protocol.md` 附录 A28）
//!
//! ### `GetWebList` **只给在播房间**（2026-09-13 只读实测，两个账号交叉验证）
//!
//! - **端点**：`GET /xlive/web-ucenter/v1/xfetter/GetWebList`（`code=0`）。
//!   此前猜测的 `/xlive/web-interface/v1/relation/getUserFollowList` 不成立。
//! - **分页参数**：`page` / `page_size` 实测可用。
//! - **响应信封**：`data.{rooms, list, count, not_living_num}`；`rooms` 与 `list` 内容相同。
//! - **关键（用户 2026-09-13 报的「看不到未开播的关注」就在这里）**：`list` **只承载在播房间**。
//!   实测账号关注 90 人、当下在播 0 人：`count=0`、`list=[]`、`rooms=[]`，而
//!   `not_living_num=90` —— 上游知道有多少人未开播，却**不把这批条目放进响应**。
//!   换 `page_size`（10/30/50/100）、翻到第 2/3 页、加 `type` / `sortRule` /
//!   `needNotLiving` / `includeNotLiving`、加带 `w_rid` 的 WBI 签名，均不给未开播条目；
//!   `hit_ab=false` 时连 `not_living_num` 也归零。原始响应见
//!   `smoke/fixtures/follow-getweblist-raw.json`（脱敏）。
//!   ⇒ 「关注了但没开播」**不是本实现丢的，是这个端点根本不给**。
//! - **全量关注的两步取法**（未开播那一份只能另取）：
//!   1. `GET https://api.bilibili.com/x/relation/followings?vmid=<自己>&ps=50&pn=<页>`
//!      —— 主站关注关系，`data.total` 是全量关注数，`data.list[].mid` 是 uid。
//!      实测总关注 90，与直播侧 `not_living_num=90` 对得上（两套上游对「关注了谁」口径一致）。
//!   2. `GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=<uid>...`
//!      —— 批量取直播间，`data` 是**以 uid 为键的对象**，条目字段名与 `GetWebList` 条目同构
//!      （`room_id`/`uname`/`face`/`title`/`live_status`/`online`/`short_id`/`area*`），
//!      **含未开播**。实测 90 个关注 → 70 个有直播间（另 20 个没有直播间，不产生列表项：
//!      没有房间可进），70 个的 `live_status` 全为 0。
//!   合并规则：`GetWebList` 的在播条目**优先**（它带 `liveTime` 开播时刻），
//!   状态接口只补它没给的那批（按 `room_id` 去重）。
//! - **分页终止**：响应里**没有** `has_more`。改为「本页条数 == page_size 则认为还有下一页」
//!   （可观察且保守）；若上游某天真的给了 `has_more`，优先采信它。
//! - **条目字段名**（每个字段按候选顺序取，全部缺失时用零值/空串并打 debug）：
//!   - 房间号：`roomid` / `room_id`。
//!   - 昵称：`uname` / `name` / `nickname`。
//!   - 头像：`face` / `cover` / `user_cover`。
//!   - 直播间标题：`title`（实测 2026-09-12：条目里同时有 `title` 与 `roomname`，
//!     前者是本场直播标题，与 `getH5InfoByRoom` 的 `room_info.title` 同义——
//!     `getRoomPlayInfo` 里根本没有标题字段）。
//!   - 直播状态：`live_status` / `liveStatus`。
//!   - 分组名：`group_name` / `groupName` / `group`。**不要**用 `tag_name`
//!     ——它是逗号拼接的房间标签列表，不是分组（实测样本见 `map_item` 注释）。
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

/// 在播关注端点：**只给在播房间**（2026-09-13 实测，见模块文档）。
const EP_FOLLOW_LIST: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/xfetter/GetWebList";

/// 全量关注端点（主站关注关系）：未开播的那一份只能从这里拿 uid。
const EP_FOLLOWINGS: &str = "https://api.bilibili.com/x/relation/followings";

/// 批量直播间信息端点（按 uid，**含未开播**）。
const EP_STATUS_BY_UIDS: &str =
    "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids";

/// 单页拉取条数（与在播端点共用）。
pub const PAGE_SIZE: i64 = 30;

/// 主站关注关系的单页条数：上游实测 `ps=50` 可用（关注 90 人 = 第 1 页 50 + 第 2 页 40）。
pub const FOLLOWINGS_PAGE_SIZE: i64 = 50;

/// 批量状态接口每批 uid 数（实测一次 90 个也接受，取 50 留余量）。
pub const STATUS_BATCH: usize = 50;

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
        // 直播间标题：`title`（实测 2026-09-12，A28）。同条目里另有 `roomname`
        // （房间默认名），本字段取的是**本场直播标题**。
        title: str_field(item, &["title"]),
        live_status: int_field(item, &["live_status", "liveStatus"]) as i32,
        // 分组名：**不能**退而取 `tag_name`。本端点实测（2026-09-12，A28/A34）
        // 不返回关注分组，而 `tag_name` 是逗号拼接的**房间标签列表**
        // （真实样本：`,,上下滑tag房间,第三方推流,,,,天选时刻进行中`），
        // 填进分组位会渲染成一串无意义文字（用户即据此报错）。
        // 取不到就留空，界面自行隐藏该位。
        group_name: str_field(item, &["group_name", "groupName", "group"]),
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

/// 主站关注响应 → (uid 列表, 全量关注数)。
///
/// 信封：`data.total`（全量关注数）+ `data.list[].mid`。识别不了时返回空列表与 0。
fn following_uids(value: &Value) -> (Vec<i64>, i64) {
    let total = value
        .pointer("/data/total")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let uids = value
        .pointer("/data/list")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.get("mid").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default();
    (uids, total)
}

/// 批量直播间响应 → 关注房间（含未开播）。
///
/// `data` 是**以 uid 为键的对象**（不是数组），值的字段名与 `GetWebList` 条目同构；
/// 没有直播间的关注（`room_id` 缺失或为 0）不产生列表项——没有房间可进。
pub fn map_status_rooms(value: &Value) -> Vec<FollowedRoom> {
    let Some(data) = value.pointer("/data").and_then(Value::as_object) else {
        tracing::debug!("批量直播间响应缺少可识别的 data 对象，按空列表容错");
        return Vec::new();
    };
    data.values()
        .map(map_item)
        .filter(|room| room.room_id != 0)
        .collect()
}

/// 在播侧条目 + 状态接口补齐的条目 → 一份关注列表。
///
/// 按 `room_id` 去重，**在播侧优先**：它带 `liveTime`（本场开播时刻），
/// 状态接口给不了这个量。
pub fn merge_followed(live: Vec<FollowedRoom>, rest: Vec<FollowedRoom>) -> Vec<FollowedRoom> {
    let mut merged = live;
    let mut seen: std::collections::HashSet<i64> = merged.iter().map(|r| r.room_id).collect();
    merged.extend(rest.into_iter().filter(|room| {
        room.room_id != 0 && seen.insert(room.room_id)
    }));
    merged
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

    /// 在播关注（`GetWebList`）：翻页到「本页不满」为止。
    ///
    /// **未开播的关注不在这个端点里**（2026-09-13 实测，见模块文档）。
    async fn fetch_live_rooms(&self) -> Result<Vec<FollowedRoom>> {
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
                return Err(Error::Upstream(format!("GetWebList code={code}")));
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
        Ok(rooms)
    }

    /// 全量关注的 uid（主站关注关系）：翻页到取满 `data.total` 为止。
    async fn fetch_following_uids(&self) -> Result<Vec<i64>> {
        let uid = self.store.active().map(|p| p.uid()).unwrap_or(0);
        if uid == 0 {
            return Err(Error::NotLoggedIn);
        }

        let mut uids = Vec::new();
        let mut page = 1i64;
        loop {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("vmid", &uid.to_string())
                .append_pair("ps", &FOLLOWINGS_PAGE_SIZE.to_string())
                .append_pair("pn", &page.to_string())
                .finish();
            let (value, _) = self
                .http
                .get_with_cookies(&format!("{EP_FOLLOWINGS}?{query}"))
                .await?;

            let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
            if code != 0 {
                return Err(Error::Upstream(format!("relation/followings code={code}")));
            }

            let (page_uids, total) = following_uids(&value);
            if page_uids.is_empty() {
                break;
            }
            uids.extend(page_uids);

            if uids.len() as i64 >= total || page >= MAX_PAGES {
                break;
            }
            page += 1;
        }
        Ok(uids)
    }

    /// 批量取直播间（含未开播）：`STATUS_BATCH` 个 uid 一批。
    async fn fetch_status_rooms(&self, uids: &[i64]) -> Result<Vec<FollowedRoom>> {
        let mut rooms = Vec::new();
        for chunk in uids.chunks(STATUS_BATCH) {
            let query = {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                for uid in chunk {
                    serializer.append_pair("uids[]", &uid.to_string());
                }
                serializer.finish()
            };
            let (value, _) = self
                .http
                .get_with_cookies(&format!("{EP_STATUS_BY_UIDS}?{query}"))
                .await?;

            let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
            if code != 0 {
                return Err(Error::Upstream(format!(
                    "get_status_info_by_uids code={code}"
                )));
            }
            rooms.extend(map_status_rooms(&value));
        }
        Ok(rooms)
    }
}

#[async_trait]
impl RoomCatalog for BiliFollow {
    async fn followed(&self) -> Result<Vec<FollowedRoom>> {
        if !self.store.is_logged_in() {
            return Err(Error::NotLoggedIn);
        }

        // 在播那一份（`GetWebList`）。它失败就是整条链路失败——这是原有行为。
        let live = self.fetch_live_rooms().await?;

        // 未开播那一份要另取：全量关注 → uid → 批量直播间信息。
        // 补不齐时**只丢这一份并发 warn**：让「列表少人」在日志里看得见，
        // 而不是把在播的那一份也一起丢掉。
        let rest = match self.fetch_following_uids().await {
            Ok(uids) => match self.fetch_status_rooms(&uids).await {
                Ok(rooms) => rooms,
                Err(error) => {
                    tracing::warn!(%error, "未开播关注补取失败，本次只返回在播房间");
                    Vec::new()
                }
            },
            Err(error) => {
                tracing::warn!(%error, "全量关注取失败，本次只返回在播房间");
                Vec::new()
            }
        };

        let mut rooms = merge_followed(live, rest);
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
                        "title": "离线主播的标题",
                        "live_status": 0,
                        "group_name": "默认分组"
                    },
                    {
                        "roomid": 1,
                        "uname": "在播主播",
                        "face": "https://example.invalid/1.jpg",
                        "title": "在播主播的标题",
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
        assert_eq!(rooms[0].title, "在播主播的标题");
        assert_eq!(rooms[0].live_status, 1);
        assert_eq!(rooms[0].group_name, "默认分组");
        assert_eq!(rooms[1].title, "离线主播的标题");
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
                title: String::new(),
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

    // ---- 2026-09-13 实测夹具（真实响应派生 + 脱敏，见 `docs/protocol.md` A28）----
    //
    // 这一组测试钉住的是**结论**而不是实现：未开播的关注不在 `GetWebList` 里，
    // 只能由「主站关注关系 + 批量直播间信息」两步取到。

    fn fixture(name: &str) -> Value {
        let raw = match name {
            "follow-getweblist-raw.json" => {
                include_str!("../../../apps/desktop/ui/smoke/fixtures/follow-getweblist-raw.json")
            }
            "follow-followings-raw.json" => {
                include_str!("../../../apps/desktop/ui/smoke/fixtures/follow-followings-raw.json")
            }
            "follow-status-raw.json" => {
                include_str!("../../../apps/desktop/ui/smoke/fixtures/follow-status-raw.json")
            }
            other => panic!("未登记的夹具：{other}"),
        };
        serde_json::from_str(raw).expect("夹具必须是合法 JSON")
    }

    fn followed(room_id: i64, live_status: i32) -> FollowedRoom {
        FollowedRoom {
            room_id,
            uname: format!("主播{room_id}"),
            face: String::new(),
            title: String::new(),
            live_status,
            group_name: String::new(),
            live_start_at: 0,
            online: 0,
        }
    }

    #[test]
    fn real_getweblist_fixture_returns_no_offline_entry() {
        // 关注 90 人、当时在播 0 人：上游给在播 0 条，只报「未开播 90」——
        // 用户报的「看不到未开播的关注」根因就在这里。
        let value = fixture("follow-getweblist-raw.json");
        assert_eq!(value.pointer("/data/count").and_then(Value::as_i64), Some(0));
        assert_eq!(
            value.pointer("/data/not_living_num").and_then(Value::as_i64),
            Some(90)
        );
        assert!(map_followed(&value).is_empty(), "本端点不给未开播条目");
    }

    #[test]
    fn real_status_fixture_carries_the_offline_follows() {
        // 同一批关注里「未开播」的那一份由批量状态接口给出。
        let value = fixture("follow-status-raw.json");
        let rooms = map_status_rooms(&value);
        assert_eq!(rooms.len(), 70, "90 个关注里 70 个有直播间");
        assert!(rooms.iter().all(|r| r.room_id != 0));
        assert!(rooms.iter().all(|r| r.live_status != 1), "取样当时无人开播");
        assert!(rooms
            .iter()
            .all(|r| !r.uname.is_empty() && !r.title.is_empty()));
    }

    #[test]
    fn real_followings_fixture_agrees_with_live_side_count() {
        let value = fixture("follow-followings-raw.json");
        let (uids, total) = following_uids(&value);
        assert_eq!(total, 90, "主站全量关注数");
        assert_eq!(uids.len(), 50, "第 1 页（ps=50）");
        // 两套上游对「关注了谁」口径一致：直播侧 not_living_num = 主站 total。
        let live = fixture("follow-getweblist-raw.json");
        assert_eq!(
            live.pointer("/data/not_living_num").and_then(Value::as_i64),
            Some(total)
        );
    }

    #[test]
    fn follow_status_map_skips_follows_without_room() {
        let value = json!({ "code": 0, "data": {
            "11": { "room_id": 111, "uname": "有直播间的" },
            "12": { "room_id": 0, "uname": "没有直播间的" }
        }});
        let rooms = map_status_rooms(&value);
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].room_id, 111);
        // 信封认不出来时按空列表容错。
        assert!(map_status_rooms(&json!({ "code": 0 })).is_empty());
    }

    #[test]
    fn follow_merge_keeps_live_entry_and_dedupes_by_room_id() {
        let mut on_air = followed(7, 1);
        on_air.live_start_at = 1789174974; // 在播侧独有：开播时刻
        let merged = merge_followed(vec![on_air], vec![followed(7, 1), followed(8, 0), followed(9, 0)]);
        let ids: Vec<i64> = merged.iter().map(|r| r.room_id).collect();
        assert_eq!(ids, vec![7, 8, 9]);
        assert_eq!(
            merged[0].live_start_at, 1789174974,
            "同 room_id 保留在播侧条目（它带 liveTime）"
        );
    }

    #[test]
    fn follow_followings_reads_mids_and_total() {
        let value = json!({ "code": 0, "data": { "total": 3, "list": [
            { "mid": 11 }, { "mid": 12 }, { "mid": "13" }
        ]}});
        // 只认整数 mid（字符串不猜），total 照收。
        assert_eq!(following_uids(&value), (vec![11, 12], 3));
        assert_eq!(following_uids(&json!({ "code": -352 })), (Vec::new(), 0));
    }
}
