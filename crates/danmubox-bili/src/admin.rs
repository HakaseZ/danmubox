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

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use danmubox_core::ports::{AdminListSlice, RoomAdmin};
use danmubox_core::{BlacklistedUser, ConfigStore, Error, Result, SilentUser};
use futures_util::FutureExt as _;
use futures_util::StreamExt as _;
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
/// **首波之后**翻页之间的间隔（6.5）。
///
/// 一份 481 条的禁言名单 = 49 次 POST；改前一次调用把整份翻完、**连发**几十次，
/// 被上游风控挡回 HTTP 412 的验证页（`docs/protocol.md` A45，`text/html`）。
/// 串行 + 间隔是唯一不触发风控的路径 —— 代价是单次全量从「秒级」变成「数秒」，
/// 这是刻意换来的：房管面板是低频功能，宁慢勿被挡。
///
/// 口径（6.14）：**首波全量取回之前不施加它**（那里以并发取全、优先于任何限速），
/// 首波完成之后才逐页限速。
const PAGE_GAP: Duration = Duration::from_millis(200);

/// 单次调用最多翻多少页（安全阀，防 `total` / `total_page` 恒真时无限请求）。
///
/// 取值有实测依据：禁言名单**每页固定 10 条**，一个真实房间实测 481 条 / 49 页——
/// 上限太小会在真实房间里静默截断。触顶时返回 `done=false` 与**真实** `next_offset`，
/// 由消费方继续补齐（6.15 封顶不让条目永久取不到）；调用方从日志 / 游标就能看出被截断。
const MAX_PAGES: i64 = 60;

/// 首波并发取页的并发度（6.14 的「以并发度默认 3 并发补页」）。
///
/// **未实测**：3 是用户给出的起点值，真机上的风控阈值尚未验证；实测后按
/// `docs/protocol.md` 附录 A45 回填（`AGENT.md` §8 第 7 条）。
const ADMIN_CONCURRENCY: usize = 3;

/// 探针回显的响应体字节上限（`AGENT.md` §8 第 1 条：凭据绝不进日志 / 终端）。
const PROBE_BODY_BYTES: usize = 256;

/// 已把禁言名单翻到过终点的房间 —— 「首波全量已取回」的**进程级**标记。
///
/// 6.14 要求首波以并发取全、优先于任何限速；6.5 / 6.17 要求「首波全量完成**之后**」才施加
/// 进程级串行与 412 退避。适配器每次 IPC 都新建（`lib.rs` 的 `admin_*`），所以这个时序
/// 分界只能是进程级状态：某房间一旦把名单翻到过终点，其后的取数（补一段 / 静默刷新 /
/// 写后重读）就落进串行 + 退避通道。
static SILENT_FIRST_WAVE_DONE: LazyLock<std::sync::Mutex<HashSet<i64>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));
/// 同上，黑名单。
static BLACKLIST_FIRST_WAVE_DONE: LazyLock<std::sync::Mutex<HashSet<i64>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

/// 首波之后只读取数的**进程级串行链**（6.5 / 6.17）：同一时刻只跑一个。
///
/// 仓内没有 `Semaphore` 先例，这里也只需要「一个接一个」，用 Mutex 即可。
static ADMIN_READ_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// 该房间的这块名单是否已经完成过首波全量取回。
fn first_wave_done(flag: &LazyLock<std::sync::Mutex<HashSet<i64>>>, room_id: i64) -> bool {
    flag.lock().expect("首波标记锁").contains(&room_id)
}

/// 记下「该房间的这块名单首波已取全」。
fn mark_first_wave_done(flag: &LazyLock<std::sync::Mutex<HashSet<i64>>>, room_id: i64) {
    flag.lock().expect("首波标记锁").insert(room_id);
}

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
    /// `backoff` 为真时对 **HTTP 412** 走有界退避重试 —— 这是 6.6 的幂等 `GET` 例外，
    /// 只在**首波全量取回之后**启用（6.4 的分段口径）。`POST` 那条路（[`Self::post`]）一律不重试。
    async fn get(&self, url: &str, params: &[(&str, String)], backoff: bool) -> Result<Value> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
            .finish();
        let url = format!("{url}?{query}");
        let (value, _) = if backoff {
            self.http.get_with_cookies_backoff(&url).await?
        } else {
            self.http.get_with_cookies(&url).await?
        };
        Ok(value)
    }

    /// 禁言名单一页的原始载荷 → (条目, 上游总数)。
    ///
    /// `ps` 是**页码**、每页固定 10 条；`total_page` 缺省时按一页估总数。
    async fn silent_page(
        &self,
        csrf: &str,
        room_id: i64,
        page: i64,
    ) -> Result<(Vec<SilentUser>, i64)> {
        let value = self
            .post(
                EP_SILENT_LIST,
                csrf,
                vec![("room_id", room_id.to_string()), ("ps", page.to_string())],
            )
            .await?;
        ensure_ok(&value, "GetSilentUserList")?;
        let items = map_silent_users(&value);
        let pages = value
            .pointer("/data/total_page")
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let total = value
            .pointer("/data/total")
            .and_then(Value::as_i64)
            .unwrap_or(pages * SILENT_PAGE_SIZE);
        Ok((items, total))
    }

    /// 黑名单一页的原始载荷 → (条目, 上游总数)。
    ///
    /// `pn` 是页码、`ps` 是页条数（这里是真的条数，与禁言那个 `ps` 不同名同义）。
    /// `backoff` 透传给 [`Self::get`]：只在首波之后对 412 退避重试（黑名单基线是幂等 `GET`）。
    async fn black_page(
        &self,
        anchor_uid: i64,
        page: i64,
        backoff: bool,
    ) -> Result<(Vec<BlacklistedUser>, i64)> {
        let value = self
            .get(
                EP_BLACK_LIST,
                &[
                    ("anchor_id", anchor_uid.to_string()),
                    ("pn", page.to_string()),
                    ("ps", BLACK_PAGE_SIZE.to_string()),
                ],
                backoff,
            )
            .await?;
        ensure_ok(&value, "GetBlackList")?;
        let items = map_blacklisted(&value);
        let total = value
            .pointer("/data/total")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        Ok((items, total))
    }

    /// **只读探针**（`docs/protocol.md` 附录 A36 的补充实测）：对禁言列表端点发一次
    /// **GET**（带 Cookie、**不带 csrf**），返回 `HTTP 状态` / `content-type` /
    /// 响应体开头（截断 + 脱敏）。
    ///
    /// 目的：确认该端点收不收 GET —— 收则 `silent_list` 可改 GET、落进 6.6 的幂等例外；
    /// 不收则保持 POST（6.4 只点名黑名单，不受影响）。**只读、单次、失败即停**，
    /// 探测内部不换参数重试（`AGENT.md` §8 第 15 条）。
    pub async fn probe_silent_get(&self, room_id: i64) -> Result<(u16, String, String)> {
        let url = format!("{EP_SILENT_LIST}?room_id={room_id}&ps=1");
        let (status, content_type, body) = self.http.probe_get(&url).await?;
        let head = String::from_utf8_lossy(&body[..body.len().min(PROBE_BODY_BYTES)])
            .chars()
            .filter(|ch| !ch.is_control())
            .collect::<String>();
        Ok((status, content_type, crate::redact::redact(&head)))
    }
}

/// 一次调用要取的页号：`start`（含，**探测页必发**）与 `planned_last`（含，受单次翻页上限约束）。
///
/// `offset` 落在页内时，前面的若干条要跳过（跳过由 [`assemble_slice`] 负责）。
fn page_plan(offset: i64, limit: i64, page_size: i64) -> (i64, i64) {
    let start = offset / page_size + 1;
    // 取满 `limit` 条所需的最远页；再按单次翻页上限截断（封顶只限**体积**，不让条目
    // 永久取不到：截断处返回真实 `next_offset`，由消费方继续补齐，6.15）。
    let target_last = (offset + limit - 1) / page_size + 1;
    (start, target_last.min(start + MAX_PAGES - 1))
}

/// 已知 `total` 后把取页上界收口到「**下一页起点越过 `total`** 即停」（6.13）。
///
/// `total <= 0`（空名单 / 上游未给）时不提前收口 —— 是否到终点交给页式接口的通用形态判定
/// （见 [`assemble_slice`]）。
fn clamp_last(start: i64, planned_last: i64, total: i64, page_size: i64) -> i64 {
    if total <= 0 {
        return planned_last;
    }
    // 手写向上取整：`i64::div_ceil` 在当前工具链上仍是不稳定特性（`int_roundings`）。
    let last_by_total = (total + page_size - 1) / page_size;
    planned_last.min(last_by_total.max(start))
}

/// 空切片：`done = true`（没有可翻的下一段），游标停在 `offset`。
fn empty_slice<T>(offset: i64) -> AdminListSlice<T> {
    AdminListSlice {
        items: Vec::new(),
        total: 0,
        next_offset: offset.max(0),
        done: true,
    }
}

/// 把**按页号升序**取回的页拼成响应切片（纯函数，便于单测停止条件 / `next_offset` / `done`）。
fn assemble_slice<T: Clone>(
    offset: i64,
    limit: i64,
    page_size: i64,
    total: i64,
    pages: &[Vec<T>],
) -> AdminListSlice<T> {
    // `offset` 落在首页内的那几条不属于这一段；跨页累计着跳过（上游页边界与 `offset` 不一定对齐）。
    let mut skip = (offset % page_size) as usize;
    let mut items: Vec<T> = Vec::new();
    for page in pages {
        let start = skip.min(page.len());
        skip -= start;
        items.extend_from_slice(&page[start..]);
    }
    if items.len() as i64 > limit {
        items.truncate(limit as usize);
    }
    let next_offset = offset + items.len() as i64;
    let last_len = pages.last().map_or(0, Vec::len);
    // 终点判定：上游给了 `total` 就用它（下一页起点越过总数即收口，6.13）；
    // 没给时退回「最后一页不足一页 / 空页 = 到终点」的页式接口通用形态。
    let done = if total > 0 {
        next_offset >= total || last_len == 0
    } else {
        last_len < page_size as usize
    };
    AdminListSlice {
        items,
        total,
        next_offset,
        done,
    }
}

/// **首波**并发取页（6.14）：最多 [`ADMIN_CONCURRENCY`] 页同时在途、**保序**返回，
/// 页间**不**限速。任一页失败即整体失败（首波阶段不重试，6.4 的分段启用）。
async fn fetch_pages_concurrent<T, F, Fut>(pages: Vec<i64>, fetch: F) -> Result<Vec<(i64, T)>>
where
    T: Send,
    F: Fn(i64) -> Fut,
    Fut: std::future::Future<Output = Result<T>> + Send,
{
    let results: Vec<Result<(i64, T)>> = futures_util::stream::iter(pages)
        .map(|page| {
            fetch(page)
                .map(move |result| result.map(|value| (page, value)))
                .boxed()
        })
        .buffered(ADMIN_CONCURRENCY)
        .collect()
        .await;
    results.into_iter().collect()
}

/// **首波之后**串行取页（6.5 / 6.17）：逐页取、页间留 `gap`。
async fn fetch_pages_serial<T, F, Fut>(
    pages: Vec<i64>,
    fetch: F,
    gap: Duration,
) -> Result<Vec<(i64, T)>>
where
    F: Fn(i64) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut out = Vec::with_capacity(pages.len());
    for (index, page) in pages.into_iter().enumerate() {
        if index > 0 && !gap.is_zero() {
            tokio::time::sleep(gap).await;
        }
        out.push((page, fetch(page).await?));
    }
    Ok(out)
}

/// 分页取数的引擎（禁言 / 黑名单共用）：先取探测页拿 `total`，再按首波 / 首波后取其余页，
/// 最后拼出切片。
///
/// 抽成泛型函数是为了让「首波并发 / 首波后串行 / 停止条件 / 封顶」都能被单测直接钉住 ——
/// 测试注入假取页函数，不必起 HTTP 桩（真正走 HTTP 的接线由 [`RoomAdmin`] 实现负责）。
async fn paged_slice<T, F, Fut>(
    offset: i64,
    limit: i64,
    page_size: i64,
    first_wave: bool,
    gap: Duration,
    fetch_page: F,
) -> Result<AdminListSlice<T>>
where
    T: Clone + Send,
    F: Fn(i64) -> Fut,
    Fut: std::future::Future<Output = Result<(Vec<T>, i64)>> + Send,
{
    if offset < 0 || limit <= 0 {
        return Ok(empty_slice(offset));
    }
    let (start, planned_last) = page_plan(offset, limit, page_size);
    // 探测页**必发**（「首请求必放行」，6.13）：`total` 只有它带得回来。
    let (first_items, total) = fetch_page(start).await?;
    let last = clamp_last(start, planned_last, total, page_size);
    let mut pages: Vec<Vec<T>> = vec![first_items];
    let rest: Vec<i64> = ((start + 1)..=last).collect();
    if !rest.is_empty() {
        let fetched = if first_wave {
            fetch_pages_concurrent(rest, &fetch_page).await?
        } else {
            fetch_pages_serial(rest, &fetch_page, gap).await?
        };
        // 其余页的 `total` 与探测页同源，这里只用条目。
        pages.extend(fetched.into_iter().map(|(_, (items, _))| items));
    }
    Ok(assemble_slice(offset, limit, page_size, total, &pages))
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
    ) -> Result<AdminListSlice<SilentUser>> {
        if offset < 0 || limit <= 0 {
            return Ok(empty_slice(offset));
        }
        let first_wave = !first_wave_done(&SILENT_FIRST_WAVE_DONE, room_id);
        // 首波之后才施加进程级串行（6.5 / 6.17）；首波阶段三条只读列表之间并发取全（6.14）。
        let _serial = if first_wave {
            None
        } else {
            Some(ADMIN_READ_LOCK.lock().await)
        };
        let csrf = self.csrf()?;
        let slice = paged_slice(
            offset,
            limit,
            SILENT_PAGE_SIZE,
            first_wave,
            PAGE_GAP,
            |page| self.silent_page(&csrf, room_id, page),
        )
        .await?;
        if first_wave && slice.done {
            mark_first_wave_done(&SILENT_FIRST_WAVE_DONE, room_id);
        }
        Ok(slice)
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
    ) -> Result<AdminListSlice<BlacklistedUser>> {
        if offset < 0 || limit <= 0 {
            return Ok(empty_slice(offset));
        }
        let first_wave = !first_wave_done(&BLACKLIST_FIRST_WAVE_DONE, room_id);
        // 首波之后才施加进程级串行（6.5 / 6.17）；首波阶段三条只读列表之间并发取全（6.14）。
        let _serial = if first_wave {
            None
        } else {
            Some(ADMIN_READ_LOCK.lock().await)
        };
        let anchor_uid = self.anchor_uid(room_id).await?;
        let slice = paged_slice(
            offset,
            limit,
            BLACK_PAGE_SIZE,
            first_wave,
            PAGE_GAP,
            // 412 有界退避只在**首波之后**启用（6.4 的分段口径）；黑名单基线是幂等 `GET`。
            |page| self.black_page(anchor_uid, page, !first_wave),
        )
        .await?;
        if first_wave && slice.done {
            mark_first_wave_done(&BLACKLIST_FIRST_WAVE_DONE, room_id);
        }
        Ok(slice)
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    /// 合成一页的条目（页号从 1 起，末尾不足一页就短）—— 分页判据的假上游。
    fn page_items(page: i64, total: i64, page_size: i64) -> Vec<i64> {
        let start = (page - 1) * page_size;
        let end = (start + page_size).min(total);
        (start..end).collect()
    }

    #[test]
    fn page_plan_keeps_first_request_and_respects_single_call_cap() {
        assert_eq!(page_plan(0, 10, 10), (1, 1), "首请求必放行（6.13）");
        assert_eq!(page_plan(0, 100, 10), (1, 10));
        // `offset` 落在页内：起点页 + 页内跳过由 `assemble_slice` 负责。
        assert_eq!(page_plan(95, 10, 10), (10, 11));
        // 单次翻页上限：再多也只规划 MAX_PAGES 页（封顶不等于取不到，6.15）。
        assert_eq!(page_plan(0, 100_000, 10), (1, MAX_PAGES));
    }

    #[test]
    fn clamp_last_stops_when_the_next_page_start_passes_total() {
        // 上游 25 条、每页 10：到第 3 页即收口（第 4 页起点 30 > 25）。
        assert_eq!(clamp_last(1, 60, 25, 10), 3);
        // `total` 未知（0）时不提前收口。
        assert_eq!(clamp_last(1, 60, 0, 10), 60);
        // 起点已越过 `total`：不再补页（探测页本身仍已发出）。
        assert_eq!(clamp_last(5, 60, 30, 10), 5);
    }

    #[test]
    fn assemble_slice_skips_in_page_offset_and_reports_upstream_waterline() {
        // offset=12 → 首页跳 2 条；limit=3 → [12, 13, 14]；next_offset 是上游口径的 15。
        let pages = vec![(10..20).collect::<Vec<i64>>()];
        let slice = assemble_slice(12, 3, 10, 25, &pages);
        assert_eq!(slice.items, vec![12, 13, 14]);
        assert_eq!(
            slice.next_offset, 15,
            "水位是上游口径，不是去重后的列表长度"
        );
        assert!(!slice.done, "还有下一段");
    }

    #[test]
    fn assemble_slice_marks_done_on_empty_or_exhausted_list() {
        // 空名单：done = true（6.13 不让空名单空翻到页数上限）。
        let empty = assemble_slice::<i64>(0, 10, 10, 0, &[]);
        assert!(empty.done);
        assert_eq!(empty.next_offset, 0);

        // 上游 3 条、不足一页：total 未知时按「最后一页不足一页 = 到终点」收口。
        let short = assemble_slice(0, 10, 10, 0, &[vec![1, 2, 3]]);
        assert!(short.done);
        assert_eq!(short.next_offset, 3);

        // total 已知且已取满：收口。
        let full = assemble_slice(0, 10, 10, 3, &[vec![1, 2, 3]]);
        assert!(full.done);
        assert_eq!(full.next_offset, 3);
    }

    #[tokio::test]
    async fn paged_slice_stops_at_total_and_uses_upstream_waterline() {
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        let slice = paged_slice(0, 100, 10, true, Duration::ZERO, move |page| {
            let recorded = Arc::clone(&recorded);
            async move {
                recorded.lock().expect("页号记录").push(page);
                Ok::<_, Error>((page_items(page, 25, 10), 25))
            }
        })
        .await
        .expect("假取页都成功");

        assert_eq!(slice.items, (0..25).collect::<Vec<i64>>());
        assert_eq!(slice.total, 25);
        assert_eq!(slice.next_offset, 25);
        assert!(slice.done);
        assert_eq!(
            *calls.lock().expect("页号记录"),
            vec![1, 2, 3],
            "第 4 页起点 30 > total 25，不再请求（6.13）"
        );
    }

    #[tokio::test]
    async fn paged_slice_caps_single_response_without_losing_entries() {
        // 上游远大于单次翻页上限：封顶只限**体积** —— done = false + 真实 next_offset，
        // 由消费方继续补齐（6.15 封顶不得让条目永久取不到）。
        let slice = paged_slice(0, 100_000, 10, true, Duration::ZERO, |page| async move {
            Ok::<_, Error>((page_items(page, 100_000, 10), 100_000))
        })
        .await
        .expect("假取页都成功");

        assert_eq!(slice.items.len(), (MAX_PAGES * SILENT_PAGE_SIZE) as usize);
        assert!(!slice.done, "封顶不等于到终点");
        assert_eq!(slice.next_offset, MAX_PAGES * SILENT_PAGE_SIZE);
    }

    /// 首波确实**并发**取页（6.14），且并发度不超过上限。
    #[tokio::test]
    async fn first_wave_fetches_remaining_pages_concurrently() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let slice = paged_slice(0, 60, 10, true, Duration::ZERO, {
            let in_flight = Arc::clone(&in_flight);
            let peak = Arc::clone(&peak);
            move |page| {
                let in_flight = Arc::clone(&in_flight);
                let peak = Arc::clone(&peak);
                async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok::<_, Error>((page_items(page, 60, 10), 60))
                }
            }
        })
        .await
        .expect("假取页都成功");

        assert_eq!(slice.items.len(), 60);
        let observed = peak.load(Ordering::SeqCst);
        assert!(observed >= 2, "首波确实并发（peak={observed}）");
        assert!(
            observed <= ADMIN_CONCURRENCY,
            "并发不超过上限（peak={observed}）"
        );
    }

    /// 首波**之后**逐页串行（6.5 / 6.17）：任何时刻在途都只有一页。
    #[tokio::test]
    async fn pages_after_first_wave_are_serial() {
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let slice = paged_slice(0, 60, 10, false, Duration::from_millis(1), {
            let in_flight = Arc::clone(&in_flight);
            let peak = Arc::clone(&peak);
            move |page| {
                let in_flight = Arc::clone(&in_flight);
                let peak = Arc::clone(&peak);
                async move {
                    let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok::<_, Error>((page_items(page, 60, 10), 60))
                }
            }
        })
        .await
        .expect("假取页都成功");

        assert_eq!(slice.items.len(), 60);
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "首波之后逐页串行（6.5 / 6.17）"
        );
    }
}
