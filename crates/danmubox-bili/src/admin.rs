//! 直播间管理（房管）：禁言 / 黑名单 / 屏蔽词（`docs/contract.md` §3 `RoomAdmin`）。
//!
//! # 实测结论（2026-09-12，校准项见 `docs/protocol.md` 附录 A36）
//!
//! 三个**只读**列表接口已用真实登录态请求核对（路径、方法、参数名、响应信封）：
//!
//! | 操作 | 方法 / 路径 | 参数 | 响应 |
//! |---|---|---|---|
//! | 禁言列表 | `POST /xlive/web-ucenter/v1/banned/GetSilentUserList` | `room_id`、`ps`（页码）、`csrf`/`csrf_token` | `data.{data[], total, total_page}`；非房管 `code=100004`「不是管理员」|
//! | 黑名单 | `GET /xlive/app-ucenter/v2/xbanned/banned/GetBlackList` | `anchor_id`、`pn`、`ps`（**注意是 `app-ucenter`，且按主播 uid 而非房间号**）| `data.{data, total, pn, ps}`；实测 `code=0` |
//! | 屏蔽词 | `POST /xlive/web-ucenter/v1/banned/GetShieldKeywordList` | `room_id`、`csrf`/`csrf_token` | `data.{keyword_list[], max_limit}`；非房管 `code=100007`「你没有权限」|
//!
//! 写操作的方法与路径同样对照**官方前端产物**核对（禁言三件套另有社区文档
//! `docs/live/silent_user_manage.md` 佐证），但**参数与响应未做真实写入验证**——
//! 纪律要求写操作不得以真实观众为目标（`AGENT.md` §8.15），因此附录 A36 明标
//! 「按官方实现核对，未实测」的那些项不得当成实测事实引用：
//!
//! | 写操作 | 官方前端的请求形状 | 状态 |
//! |---|---|---|
//! | 禁言 | `POST …/v1/banned/AddSilentUser`，`{room_id, tuid, mobile_app:"web", type:1, hour, msg?}` | 参数按官方 + 社区文档核对，未实测 |
//! | 解除禁言 | `POST …/v1/banned/DelSilentUser`，`{tuid, room_id, mobi_app:"web"}` | 同上 |
//! | 加入黑名单 | `POST /xlive/app-ucenter/v2/xbanned/banned/AddBlack` | **路径实测存在**（空表单返回 `-111 CSRF 校验失败`，其它候选 404）；参数未实测 |
//! | 移出黑名单 | `POST /xlive/app-ucenter/v2/xbanned/banned/DelBlack`，`{anchor_id, tuid, spmid}` | 参数按官方前端核对，未实测 |
//! | 增加屏蔽词 | `POST …/v1/banned/AddShieldKeyword`，`{room_id, keyword}` | 参数按官方前端核对，未实测 |
//! | 删除屏蔽词 | `POST …/v1/banned/DelShieldKeyword`，`{room_id, keyword}` | 参数按官方前端核对，未实测 |
//!
//! # 错误处理
//!
//! 非 0 `code` 一律原样带回（`code` + 上游 `message`），**不赋予**「未登录 / 权限不足」
//! 等自造语义（`docs/protocol.md` 附录 A17 的纪律）。

use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::RoomAdmin;
use danmubox_core::{BlacklistedUser, ConfigStore, Error, Result, SilentUser};
use serde_json::Value;

use crate::http::BiliHttp;

const EP_SILENT_LIST: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/GetSilentUserList";
const EP_SILENT_ADD: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/AddSilentUser";
const EP_SILENT_DEL: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/DelSilentUser";
const EP_BLACK_LIST: &str =
    "https://api.live.bilibili.com/xlive/app-ucenter/v2/xbanned/banned/GetBlackList";
const EP_BLACK_ADD: &str =
    "https://api.live.bilibili.com/xlive/app-ucenter/v2/xbanned/banned/AddBlack";
const EP_BLACK_DEL: &str =
    "https://api.live.bilibili.com/xlive/app-ucenter/v2/xbanned/banned/DelBlack";
const EP_KEYWORD_LIST: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/GetShieldKeywordList";
const EP_KEYWORD_ADD: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/AddShieldKeyword";
const EP_KEYWORD_DEL: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v1/banned/DelShieldKeyword";

/// 黑名单单页条数（官方前端 `ps`；实测该接口接受 30）。
const BLACK_PAGE_SIZE: i64 = 30;
/// 黑名单翻页上限，防止 `total` 恒真时无限请求（安全阀，非上游约定）。
const BLACK_MAX_PAGES: i64 = 20;

/// 房管操作适配器。凭据由 `BiliHttp` 实时读取当前 profile。
pub struct BiliAdmin {
    http: BiliHttp,
    store: Arc<ConfigStore>,
}

impl BiliAdmin {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
        })
    }

    /// 取 `csrf` 值（即 `bili_jct`）。所有写操作都要它。
    fn csrf(&self) -> Result<String> {
        let profile = self
            .store
            .active()
            .filter(|p| p.is_complete())
            .ok_or(Error::NotLoggedIn)?;
        if profile.bili_jct.is_empty() {
            return Err(Error::NotLoggedIn);
        }
        Ok(profile.bili_jct)
    }

    /// 房间号 → 主播 uid。黑名单接口按 `anchor_id` 而不是房间号寻址。
    async fn anchor_uid(&self, room_id: i64) -> Result<i64> {
        let room = self.http.room_play_info(&room_id.to_string()).await?;
        if room.anchor_uid == 0 {
            return Err(Error::RoomNotFound(format!(
                "房间 {room_id} 未解析出主播 uid"
            )));
        }
        Ok(room.anchor_uid)
    }

    /// POST 表单：自动补 `csrf` / `csrf_token`（官方前端请求器也是这么做的）。
    async fn post(&self, url: &str, csrf: &str, mut params: Vec<(&str, String)>) -> Result<Value> {
        params.push(("csrf", csrf.to_string()));
        params.push(("csrf_token", csrf.to_string()));
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
            .finish();
        self.http.post_form(url, &body).await
    }

    /// GET（黑名单列表用）。
    async fn get(&self, url: &str, params: &[(&str, String)]) -> Result<Value> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
            .finish();
        let (value, _) = self.http.get_with_cookies(&format!("{url}?{query}")).await?;
        Ok(value)
    }
}

/// 非 0 code → `UPSTREAM_ERROR`，原样带回 code 与上游 message。
fn ensure_ok(value: &Value, what: &str) -> Result<()> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        other => Err(Error::Upstream(format!(
            "{what} code={other:?} message={}",
            value.get("message").and_then(Value::as_str).unwrap_or("")
        ))),
    }
}

fn int(value: &Value, keys: &[&str]) -> i64 {
    keys.iter()
        .find_map(|k| value.get(*k).and_then(Value::as_i64))
        .unwrap_or(0)
}

fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// 禁言列表响应 → `SilentUser`（上游字段 `tuid` / `tname` / `face`）。
pub fn map_silent_users(value: &Value) -> Vec<SilentUser> {
    let Some(items) = value.pointer("/data/data").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| SilentUser {
            uid: int(item, &["tuid", "uid"]),
            uname: text(item, &["tname", "uname"]),
            face: text(item, &["face"]),
        })
        .collect()
}

/// 黑名单响应 → `BlacklistedUser`。
///
/// 上游条目字段名未能观测（实测黑名单为空，`data.data` 为 `null`），因此按
/// 与禁言列表同形的候选名容错解析；取不到一律零值/空串，不报错。
pub fn map_blacklisted(value: &Value) -> Vec<BlacklistedUser> {
    let Some(items) = value.pointer("/data/data").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| BlacklistedUser {
            uid: int(item, &["tuid", "uid", "mid"]),
            uname: text(item, &["tname", "uname"]),
            face: text(item, &["face"]),
        })
        .collect()
}

/// 屏蔽词响应 → `String[]`（实测字段名 `data.keyword_list`）。
pub fn map_keywords(value: &Value) -> Vec<String> {
    value
        .pointer("/data/keyword_list")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|word| !word.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl RoomAdmin for BiliAdmin {
    async fn silent_list(&self, room_id: i64) -> Result<Vec<SilentUser>> {
        let csrf = self.csrf()?;
        let mut out = Vec::new();
        let mut page = 1i64;
        loop {
            let value = self
                .post(
                    EP_SILENT_LIST,
                    &csrf,
                    vec![("room_id", room_id.to_string()), ("ps", page.to_string())],
                )
                .await?;
            ensure_ok(&value, "GetSilentUserList")?;
            out.extend(map_silent_users(&value));
            let pages = value
                .pointer("/data/total_page")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            if page >= pages || page >= BLACK_MAX_PAGES {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    async fn mute(&self, room_id: i64, uid: i64, hour: i64, msg: Option<&str>) -> Result<()> {
        let csrf = self.csrf()?;
        let mut params = vec![
            ("room_id", room_id.to_string()),
            ("tuid", uid.to_string()),
            // 官方前端的固定值；社区文档同样要求 `mobile_app=web`。
            ("mobile_app", "web".to_string()),
            // 官方前端默认 `type=1`、`hour=-1`（永久）。
            ("type", "1".to_string()),
            ("hour", hour.to_string()),
        ];
        if let Some(msg) = msg.filter(|m| !m.is_empty()) {
            params.push(("msg", msg.to_string()));
        }
        let value = self.post(EP_SILENT_ADD, &csrf, params).await?;
        ensure_ok(&value, "AddSilentUser")
    }

    async fn unmute(&self, room_id: i64, uid: i64) -> Result<()> {
        let csrf = self.csrf()?;
        let value = self
            .post(
                EP_SILENT_DEL,
                &csrf,
                vec![
                    ("room_id", room_id.to_string()),
                    ("tuid", uid.to_string()),
                    ("mobi_app", "web".to_string()),
                ],
            )
            .await?;
        ensure_ok(&value, "DelSilentUser")
    }

    async fn blacklist(&self, room_id: i64) -> Result<Vec<BlacklistedUser>> {
        let anchor_uid = self.anchor_uid(room_id).await?;
        let mut out = Vec::new();
        let mut page = 1i64;
        loop {
            let value = self
                .get(
                    EP_BLACK_LIST,
                    &[
                        ("anchor_id", anchor_uid.to_string()),
                        ("pn", page.to_string()),
                        ("ps", BLACK_PAGE_SIZE.to_string()),
                    ],
                )
                .await?;
            ensure_ok(&value, "GetBlackList")?;
            out.extend(map_blacklisted(&value));
            let total = value.pointer("/data/total").and_then(Value::as_i64).unwrap_or(0);
            if (out.len() as i64) >= total || page >= BLACK_MAX_PAGES {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    async fn blacklist_add(&self, room_id: i64, uid: i64) -> Result<()> {
        let csrf = self.csrf()?;
        let anchor_uid = self.anchor_uid(room_id).await?;
        let value = self
            .post(
                EP_BLACK_ADD,
                &csrf,
                vec![
                    ("anchor_id", anchor_uid.to_string()),
                    ("tuid", uid.to_string()),
                    ("spmid", String::new()),
                ],
            )
            .await?;
        ensure_ok(&value, "AddBlack")
    }

    async fn blacklist_del(&self, room_id: i64, uid: i64) -> Result<()> {
        let csrf = self.csrf()?;
        let anchor_uid = self.anchor_uid(room_id).await?;
        let value = self
            .post(
                EP_BLACK_DEL,
                &csrf,
                vec![
                    ("anchor_id", anchor_uid.to_string()),
                    ("tuid", uid.to_string()),
                    ("spmid", String::new()),
                ],
            )
            .await?;
        ensure_ok(&value, "DelBlack")
    }

    async fn keywords(&self, room_id: i64) -> Result<Vec<String>> {
        let csrf = self.csrf()?;
        let value = self
            .post(
                EP_KEYWORD_LIST,
                &csrf,
                vec![("room_id", room_id.to_string())],
            )
            .await?;
        ensure_ok(&value, "GetShieldKeywordList")?;
        Ok(map_keywords(&value))
    }

    async fn keyword_add(&self, room_id: i64, word: &str) -> Result<()> {
        if word.trim().is_empty() {
            return Err(Error::BadRequest("屏蔽词不能为空".into()));
        }
        let csrf = self.csrf()?;
        let value = self
            .post(
                EP_KEYWORD_ADD,
                &csrf,
                vec![
                    ("room_id", room_id.to_string()),
                    ("keyword", word.to_string()),
                ],
            )
            .await?;
        ensure_ok(&value, "AddShieldKeyword")
    }

    async fn keyword_del(&self, room_id: i64, word: &str) -> Result<()> {
        if word.trim().is_empty() {
            return Err(Error::BadRequest("屏蔽词不能为空".into()));
        }
        let csrf = self.csrf()?;
        let value = self
            .post(
                EP_KEYWORD_DEL,
                &csrf,
                vec![
                    ("room_id", room_id.to_string()),
                    ("keyword", word.to_string()),
                ],
            )
            .await?;
        ensure_ok(&value, "DelShieldKeyword")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn silent_list_maps_tuid_tname_face() {
        let value = json!({
            "code": 0,
            "data": {
                "data": [
                    {"tuid": 42, "tname": "被禁言的人", "face": "https://i/42.jpg", "id": 7, "admin_level": 0},
                    {"uid": 43, "uname": "别名", "face": "https://i/43.jpg"}
                ],
                "total": 2,
                "total_page": 1
            }
        });
        let users = map_silent_users(&value);
        assert_eq!(users.len(), 2);
        assert_eq!(users[0].uid, 42);
        assert_eq!(users[0].uname, "被禁言的人");
        assert_eq!(users[0].face, "https://i/42.jpg");
        assert_eq!(users[1].uid, 43, "字段别名同样要能解析");
    }

    #[test]
    fn silent_list_tolerates_missing_envelope() {
        assert!(map_silent_users(&json!({"code": 100004, "data": {"data": [], "total": 0}})).is_empty());
        assert!(map_silent_users(&json!({})).is_empty());
        assert!(map_silent_users(&json!({"data": {"data": null}})).is_empty());
    }

    #[test]
    fn blacklist_maps_and_tolerates_null() {
        // 实测黑名单为空的响应形状：`data.data` 是 null。
        assert!(map_blacklisted(&json!({"code": 0, "data": {"data": null, "total": 0}})).is_empty());
        let value = json!({"data": {"data": [{"tuid": 7, "tname": "拉黑的人", "face": "https://i/7.jpg"}]}});
        let users = map_blacklisted(&value);
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].uid, 7);
        assert_eq!(users[0].uname, "拉黑的人");
    }

    #[test]
    fn keywords_read_keyword_list() {
        let value = json!({"code": 0, "data": {"keyword_list": ["刷屏", "广告"], "max_limit": 50}});
        assert_eq!(map_keywords(&value), vec!["刷屏", "广告"]);
        assert!(map_keywords(&json!({"code": 100007, "data": {"keyword_list": [], "max_limit": 0}})).is_empty());
        assert!(map_keywords(&json!({})).is_empty());
    }

    #[test]
    fn non_zero_code_is_reported_verbatim() {
        // 实测：非房管请求禁言列表得到 code=100004 + message「不是管理员」。
        let value = json!({"code": 100004, "message": "不是管理员"});
        let err = ensure_ok(&value, "GetSilentUserList").unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("100004"), "{rendered}");
        assert!(rendered.contains("不是管理员"), "{rendered}");
    }
}
