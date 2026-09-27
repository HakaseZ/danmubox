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
//! # 412 风控与并发突发（A45）
//!
//! 三条**只读**列表（禁言 / 黑名单 / 屏蔽词）在房管面板打开瞬间若**并发**拉取，
//! 会触发 app-ucenter 网关的 412 风控验证页（`text/html`，非 JSON）；A45 实测补
//! `buvid3/buvid4` 仍 412，即不是缺设备指纹，根因是「并发突发 + 客户端指纹」。两层防御：
//!
//! 1. **串行**：进程级护栏 [`LISTS_GUARD`] 把三条只读列表强制串行，从源头消除并发突发
//!    （桌面端三个 IPC 命令每次都 `BiliAdmin::new`、实例不共享，故用进程级锁而非实例字段）。
//! 2. **有界重试**：黑名单这一条走 `app-ucenter` 的 **GET**，遇 412 退避后重试
//!    [`BLACKLIST_412_MAX_RETRIES`] 次（间隔 [`BLACKLIST_412_BACKOFF`]）。这是 admin 层
//!    纵深防御，与 `http.rs` 全局「4xx 不重试」不矛盾——那个纪律防的是 POST 副作用 /
//!    防风控升级，这里是幂等只读 GET。退避时长 / 重试次数**待 `docs/protocol.md` 附录 A
//!    实测校准**，先取与 [`PAGE_GAP`] 同量级的值。
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

/// 黑名单单页条数（官方前端 `ps`；实测 36 条名单在 `ps=30` 时截断，
/// `ps=50/100/200` 均一页返回全部 36 条）。
const BLACK_PAGE_SIZE: i64 = 100;
/// 禁言名单每页固定 10 条（上游 `ps` 是**页码**不是条数，实测 `ps=1` 取到前 10 条）。
const SILENT_PAGE_SIZE: i64 = 10;
/// 翻页之间的间隔。
///
/// 一份 481 条的禁言名单 = 49 次 POST；改前一次调用把整份翻完、**连发**几十次，
/// 被上游风控挡回 HTTP 412 的验证页（`docs/protocol.md` A45，`text/html`）。
/// 串行 + 间隔是唯一不触发风控的路径 —— 代价是单次全量从「秒级」变成「数秒」，
/// 这是刻意换来的：房管面板是低频功能，宁慢勿被挡。
const PAGE_GAP: std::time::Duration = std::time::Duration::from_millis(200);
/// 单次调用最多翻多少页（安全阀，防 `total` / `total_page` 恒真时无限请求）。
///
/// 取值有实测依据：禁言名单**每页固定 10 条**，一个真实房间实测 481 条 / 49 页——
/// 上限太小会在真实房间里静默截断。触顶时打 `warn`，调用方从日志就能看出被截断。
const MAX_PAGES: i64 = 60;

/// 黑名单 GET 遇 412 风控页时的有界重试次数（A45）。
///
/// 只对**幂等只读 GET** 退避重试；POST（禁言 / 屏蔽词列表）按 `http.rs` 全局纪律一律不重试。
/// 具体次数**待 `docs/protocol.md` 附录 A 实测校准**，先取 2（首请求 + 两次重试 = 最多 3 次）。
const BLACKLIST_412_MAX_RETRIES: u32 = 2;
/// 412 重试之间的退避时长（A45）。**待 `docs/protocol.md` 附录 A 实测校准**，
/// 先取与 [`PAGE_GAP`] 同量级的 200ms。
const BLACKLIST_412_BACKOFF: std::time::Duration = std::time::Duration::from_millis(200);

/// 房管「三个只读列表」的串行护栏（A45）。
///
/// 房管面板打开瞬间并发拉取禁言 / 黑名单 / 屏蔽词三条只读列表会触发 412 风控页。
/// 桌面端 `admin_silent_list` / `admin_blacklist_list` / `admin_keywords_list` 每个 IPC 命令
/// 都 `BiliAdmin::new`，实例不共享，故用**进程级**护栏把三条只读列表强制串行，
/// 从源头消除「并发突发」。写操作（禁言 / 拉黑 / 屏蔽词增删）不进此锁——
/// 它们是用户单次触发的低频动作，且全局纪律要求 POST 一律不重试。
static LISTS_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    ///
    /// 幂等只读 GET：遇 412 风控页（`docs/protocol.md` A45，`text/html`）做**有界退避重试**
    /// （最多 [`BLACKLIST_412_MAX_RETRIES`] 次，间隔 [`BLACKLIST_412_BACKOFF`]）。这是 admin
    /// 层的纵深防御，与 `http.rs` 全局「4xx 不重试」不矛盾——那个纪律防的是 POST 副作用 /
    /// 防风控升级，这里是不可变只读 GET。其它错误（含非 412 的 4xx）直接透传，不重试。
    async fn get(&self, url: &str, params: &[(&str, String)]) -> Result<Value> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
            .finish();
        let full = format!("{url}?{query}");
        let mut attempt: u32 = 0;
        loop {
            match self.http.get_with_cookies(&full).await {
                Ok((value, _)) => return Ok(value),
                // 仅对 412 风控页退避重试：幂等只读 GET，重试无副作用。
                Err(e) if is_412_risk(&e) && attempt < BLACKLIST_412_MAX_RETRIES => {
                    attempt += 1;
                    tracing::warn!(
                        url = url,
                        attempt,
                        max = BLACKLIST_412_MAX_RETRIES,
                        "黑名单 GET 遇 412 风控页，退避后重试（退避/次数待 protocol.md 附录 A 实测校准）"
                    );
                    tokio::time::sleep(BLACKLIST_412_BACKOFF).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
}

/// 非 0 code → `UPSTREAM_ERROR`，原样带回 code 与上游 message。
fn ensure_ok(value: &Value, what: &str) -> Result<()> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        other => Err(Error::Upstream(crate::redact::redact(&format!(
            "{what} code={other:?} message={}",
            value.get("message").and_then(Value::as_str).unwrap_or("")
        )))),
    }
}

/// 判断错误是否来自上游 412 风控验证页（A45）。
///
/// 依赖 `http.rs` 的 `get_with_cookies` 在 `UPSTREAM_ERROR` 文案里写入 `HTTP 412`
/// （已被 `http.rs` 的 `non_json_get_names_endpoint_status_and_body_head` 回归锁死）。
/// 若 `http.rs` 改写错误文案格式，这里必须同步。
fn is_412_risk(e: &Error) -> bool {
    e.code() == "UPSTREAM_ERROR" && e.to_string().contains("HTTP 412")
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
/// 实测条目字段（2026-09-12，一个 35 条的真实名单）：`uid` / `name` / `face` /
/// `mtime` / `operator_name` / `admin_level` / `is_anchor` / `is_mystery`——
/// **与禁言列表不同名**：这里是人 `uid` + `name`，禁言列表才是 `tuid` + `tname`。
/// 两种名字都收（后一种是未观测到的旧形态），取不到一律零值/空串，不报错。
pub fn map_blacklisted(value: &Value) -> Vec<BlacklistedUser> {
    let Some(items) = value.pointer("/data/data").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .map(|item| BlacklistedUser {
            uid: int(item, &["uid", "tuid", "mid"]),
            uname: text(item, &["name", "tname", "uname"]),
            face: text(item, &["face"]),
        })
        .collect()
}

/// 屏蔽词响应 → `String[]`（实测字段名 `data.keyword_list`）。
///
/// 实测（2026-09-12，真实房管权限下加/删一个测试词）：**条目是对象，不是字符串**——
/// `{is_anchor, keyword, name, uid}`，词在 `keyword` 上，`name`/`uid` 是添加者
/// （官方前端面板也这么解）。此前只按字符串解，一个**非空**列表会被静默解析成
/// 空列表；两种形态都收。
pub fn map_keywords(value: &Value) -> Vec<String> {
    value
        .pointer("/data/keyword_list")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item {
                    Value::String(word) => Some(word.as_str()),
                    Value::Object(_) => item.get("keyword").and_then(Value::as_str),
                    _ => None,
                })
                .filter(|word| !word.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl RoomAdmin for BiliAdmin {
    async fn silent_list(
        &self,
        room_id: i64,
        offset: i64,
        limit: i64,
    ) -> Result<(Vec<SilentUser>, i64)> {
        // A45：三条只读列表强制串行，消除并发突发。
        let _guard = LISTS_GUARD.lock().await;
        if limit <= 0 || offset < 0 {
            return Ok((Vec::new(), 0));
        }
        let csrf = self.csrf()?;
        let mut out: Vec<SilentUser> = Vec::new();
        let mut total = 0i64;
        // `ps` 是**页码**、每页固定 10 条，所以 `offset` 要拆成
        // 「跳到第几页」+「页内再跳几条」。
        let mut page = offset / SILENT_PAGE_SIZE + 1;
        let mut skip = (offset % SILENT_PAGE_SIZE) as usize;
        let mut fetched = 0i64;
        loop {
            // 翻页停止条件（issue 271100 + CodeRabbit 评审）：首请求（`fetched` 尚为 0）
            // 必定放行；此后一旦「下一页起点 ≥ 总数」即收口 —— `total` 为 0 时首请求取回
            // 空段、下一轮这里直接停，不再空翻到 `MAX_PAGES`（每轮还 `sleep(PAGE_GAP)`，
            // 末尾白白卡 ~MAX_PAGES*200ms）。
            if fetched > 0 && (page - 1) * SILENT_PAGE_SIZE >= total {
                break;
            }
            let value = self
                .post(
                    EP_SILENT_LIST,
                    &csrf,
                    vec![("room_id", room_id.to_string()), ("ps", page.to_string())],
                )
                .await?;
            ensure_ok(&value, "GetSilentUserList")?;
            let mut items = map_silent_users(&value);
            if skip > 0 {
                items = items.split_off(skip.min(items.len()));
                skip = 0;
            }
            let pages = value
                .pointer("/data/total_page")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            total = value
                .pointer("/data/total")
                .and_then(Value::as_i64)
                .unwrap_or(pages * SILENT_PAGE_SIZE);
            out.extend(items);
            if out.len() as i64 > limit {
                out.truncate(limit as usize);
            }
            fetched += 1;
            if (out.len() as i64) >= limit || page >= pages {
                break;
            }
            if fetched >= MAX_PAGES {
                tracing::warn!(
                    room_id,
                    page,
                    pages,
                    "禁言名单单次调用达到翻页上限，本次提前收口"
                );
                break;
            }
            page += 1;
            tokio::time::sleep(PAGE_GAP).await;
        }
        Ok((out, total))
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

    async fn blacklist(
        &self,
        room_id: i64,
        offset: i64,
        limit: i64,
    ) -> Result<(Vec<BlacklistedUser>, i64)> {
        // A45：三条只读列表强制串行，消除并发突发。
        let _guard = LISTS_GUARD.lock().await;
        if limit <= 0 || offset < 0 {
            return Ok((Vec::new(), 0));
        }
        let anchor_uid = self.anchor_uid(room_id).await?;
        let mut out: Vec<BlacklistedUser> = Vec::new();
        let mut total = 0i64;
        // `pn` 是页码、`ps` 是页条数（这里是真的条数，与禁言那个 `ps` 不同名同义）。
        let mut page = offset / BLACK_PAGE_SIZE + 1;
        let mut skip = (offset % BLACK_PAGE_SIZE) as usize;
        let mut fetched = 0i64;
        loop {
            // 翻页停止条件（issue 271100 + CodeRabbit 评审）：首请求（`fetched` 尚为 0）
            // 必定放行；此后一旦「下一页起点 ≥ 总数」即收口 —— `total` 为 0 时首请求取回
            // 空段、下一轮这里直接停，不再空翻到 `MAX_PAGES`（每轮还 `sleep(PAGE_GAP)`，
            // 末尾白白卡 ~MAX_PAGES*200ms）。
            if fetched > 0 && (page - 1) * BLACK_PAGE_SIZE >= total {
                break;
            }
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
            let mut items = map_blacklisted(&value);
            if skip > 0 {
                items = items.split_off(skip.min(items.len()));
                skip = 0;
            }
            total = value
                .pointer("/data/total")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            out.extend(items);
            if out.len() as i64 > limit {
                out.truncate(limit as usize);
            }
            fetched += 1;
            if (out.len() as i64) >= limit || (total > 0 && (out.len() as i64) >= total) {
                break;
            }
            if fetched >= MAX_PAGES {
                tracing::warn!(
                    room_id,
                    page,
                    total,
                    "黑名单单次调用达到翻页上限，本次提前收口"
                );
                break;
            }
            page += 1;
            tokio::time::sleep(PAGE_GAP).await;
        }
        Ok((out, total))
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
        // A45：三条只读列表强制串行，消除并发突发。
        let _guard = LISTS_GUARD.lock().await;
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
        assert!(
            map_silent_users(&json!({"code": 100004, "data": {"data": [], "total": 0}})).is_empty()
        );
        assert!(map_silent_users(&json!({})).is_empty());
        assert!(map_silent_users(&json!({"data": {"data": null}})).is_empty());
    }

    #[test]
    fn blacklist_maps_real_field_names_and_tolerates_null() {
        // 黑名单为空的响应形状：`data.data` 是 null。
        assert!(
            map_blacklisted(&json!({"code": 0, "data": {"data": null, "total": 0}})).is_empty()
        );
        // 实测条目形状（35 条的真实名单）：uid / name / face / operator_name。
        let value = json!({"data": {"data": [{
            "uid": 7, "name": "拉黑的人", "face": "https://i/7.jpg",
            "operator_name": "房管", "mtime": "2026-09-07 13:36:42", "admin_level": 0
        }]}});
        let users = map_blacklisted(&value);
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].uid, 7);
        assert_eq!(users[0].uname, "拉黑的人", "黑名单用 name，不是 tname");
        assert_eq!(users[0].face, "https://i/7.jpg");

        // 未观测到的旧名形态也容错，不因此丢条目。
        let alias = json!({"data": {"data": [{"tuid": 8, "tname": "别名"}]}});
        assert_eq!(map_blacklisted(&alias)[0].uid, 8);
        assert_eq!(map_blacklisted(&alias)[0].uname, "别名");
    }

    #[test]
    fn keywords_read_the_object_items_of_the_real_response() {
        // 真实响应（2026-09-12，加完测试词后立刻读回）：`keyword_list` 是**对象数组**，
        // 词在 `keyword` 上，`name`/`uid` 是添加者。按字符串解会静默得到空列表。
        let value = json!({
            "code": 0,
            "data": {"keyword_list": [
                {"is_anchor": 0, "keyword": "danmubox-selftest", "name": "房管", "uid": 7}
            ], "max_limit": 1000}
        });
        assert_eq!(map_keywords(&value), vec!["danmubox-selftest"]);

        // 字符串形态（未观测到的旧形态）同样收，不丢词。
        let strings = json!({"data": {"keyword_list": ["刷屏", "广告"]}});
        assert_eq!(map_keywords(&strings), vec!["刷屏", "广告"]);

        assert!(map_keywords(
            &json!({"code": 100007, "data": {"keyword_list": [], "max_limit": 0}})
        )
        .is_empty());
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

    #[test]
    fn is_412_risk_detects_risk_page_only() {
        // 412 风控页（A45）：`http.rs` 的 `decode_failure` 在本错误文案里写 `HTTP 412`。
        let risk = Error::Upstream(
            "upstream error: GET /xlive/app-ucenter/v2/xbanned/banned/GetBlackList \
             HTTP 412 content-type=text/html <!DOCTYPE html>..."
                .into(),
        );
        assert!(is_412_risk(&risk), "412 风控页必须识别为可重试");
        // 非 412 的 4xx（例如路径写错返回 404）：不可重试，直接透传。
        let not_risk = Error::Upstream(
            "upstream error: GET /xlive/.../GetBlackList HTTP 404 content-type=text/html".into(),
        );
        assert!(!is_412_risk(&not_risk), "404 不应触发重试");
        // 网络层错误（不含 HTTP 状态码）：不可重试。
        let net = Error::Upstream("upstream error: 请求失败: error sending request".into());
        assert!(!is_412_risk(&net), "网络错误不应触发重试");
        // 其它错误类别（非 UPSTREAM_ERROR）一律不重试。
        assert!(!is_412_risk(&Error::NotLoggedIn), "非上游错误不重试");
    }
}
