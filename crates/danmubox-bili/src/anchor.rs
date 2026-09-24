//! 我自己的直播间（主播视角）：开播 / 下播 / 改标题 / 分区列表（`docs/contract.md` §3 `AnchorRoom`）。
//!
//! # 端点与签名
//!
//! 端点、字段下标与 app 签名口径来自 `docs/protocol.md` §18 / §18.2 / §18.3（社区实现
//! `ChaceQC/bilibili_live_stream_code` 与 `Zeppelinpp/bilibili-streamer` 佐证）。本仓的实测状态
//! 逐条登记在 `docs/protocol.md` 附录 A66：已实测 `room_id_by_uid` / `get_info` / `click/now` /
//! `getHomePageLiveVersion`（app 签名被接受）/ `Room/update` 改标题；`startLive` 的请求形状被接受
//! （返回业务码 `60043`），成功分支（`data.rtmp` / `data.protocols[]`）、`stopLive`、`60024` 与
//! `data.qr` 仍未实测。
//!
//! **分区列表 `Area/getList` 的字段形态来自参照实现**（`Zeppelinpp/bilibili-streamer` 的
//! `live_service.rs::refresh_partitions`），**未经本仓实测**：`data` 直接是数组、父名在
//! `data[].name`、子分区在 `data[].list[]`、子 id 在 `data[].list[].id`；父 id 参照实现压根没读。
//! 详见 `map_areas` 的注释与附录 A66 —— 不得读成已实测（issue202609241553 第 4 条按此落地）。
//!
//! # 上游隔离
//!
//! 这里**唯一**允许出现 ac站的开播 URL、字段下标与签名算法。认证页地址的拼装与 `data.qr` 的读取
//! 也只在此模块；`core` 只见 `AnchorGate` 那两个字符串（`docs/contract.md` §5）。
//!
//! # 纪律
//!
//! 写操作**只作用于该账号自己的直播间**（账号在 `new_for` 构造时定死：缺省当前账号，
//! `Some(name)` 按账号名取，**不必切号**；房间号由 `own_room_id()` 现取），失败即停、不重试；
//! 上游非 0 code 原样带回、不赋语义；仅 `60043` / `60024` 转 `AnchorGate` 引导（`docs/protocol.md`
//! §18.5）。推流码是账号级凭据，Rust 侧绝不打印（日志一律 `redact`）。

use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::{AnchorLiveOutcome, AnchorRoom};
use danmubox_core::{
    AnchorArea, AnchorGate, AnchorGateKind, ConfigStore, Error, OwnRoom, Profile, Result,
    StreamEndpoint, StreamEndpoints,
};
use serde_json::Value;

use crate::http::BiliHttp;
use crate::redact::redact;

/// 直播姬公开客户端标识（**不是账号凭据**，`docs/protocol.md` §18.3）。
const APPKEY: &str = "aae92bc66f3edfab";
const APPSEC: &str = "af125a0d5279fd576c1b4418a3e8276d";

const EP_ROOM_ID_BY_UID: &str = "https://api.live.bilibili.com/room/v2/Room/room_id_by_uid";
const EP_GET_INFO: &str = "https://api.live.bilibili.com/room/v1/Room/get_info";
const EP_UPDATE: &str = "https://api.live.bilibili.com/room/v1/Room/update";
const EP_STOP_LIVE: &str = "https://api.live.bilibili.com/room/v1/Room/stopLive";
const EP_AREA_LIST: &str = "https://api.live.bilibili.com/room/v1/Area/getList";
const EP_CLICK_NOW: &str = "https://api.bilibili.com/x/report/click/now";
const EP_HOME_VER: &str =
    "https://api.live.bilibili.com/xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion";
const EP_START_LIVE: &str = "https://api.live.bilibili.com/room/v1/Room/startLive";

/// 主播视角适配器。
///
/// **作用于哪个账号在构造时定死**：缺省是当前账号，`account` 指定时按账号名取该账号的凭据
/// —— 管理别的账号的直播间**不必先切号**（issue202609241553 第 3 条）。
pub struct BiliAnchor {
    http: BiliHttp,
    /// 构造时取下的凭据快照：`uid` / `csrf` 都从它来，之后不再回头看「当前账号」。
    profile: Profile,
}

impl BiliAnchor {
    /// 当前账号（缺省行为）。
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Self::new_for(store, None)
    }

    /// 指定账号：`None` = 当前账号，`Some(name)` = 该账号（凭据在 `config.toml` 里按名字存）。
    ///
    /// 为什么取**快照**而不是让 `BiliHttp` 每次现读：后者那条通道（`with_store`）读的永远是当前
    /// 账号，用它去开别人的直播等于拿错人的凭据。指定账号时改走固定 cookie 通道
    /// （`BiliHttp::with_cookie`），一次定死、读写同源。
    pub fn new_for(store: Arc<ConfigStore>, account: Option<&str>) -> Result<Self> {
        let profile = match account {
            None => store.active(),
            Some(name) => store.profile(name),
        };
        let profile = profile.ok_or_else(|| match account {
            Some(name) => Error::BadRequest(format!("账号不存在：{name}")),
            None => Error::NotLoggedIn,
        })?;
        if !profile.is_complete() {
            // 指定了一个没登录（凭据不全）的账号：不许悄悄退回当前账号顶替。
            return Err(Error::NotLoggedIn);
        }
        let http = match account {
            None => BiliHttp::with_store(store)?,
            Some(_) => BiliHttp::with_cookie(profile.cookie_header())?,
        };
        Ok(Self { http, profile })
    }

    /// 当前账号 uid（即凭据里的 `DedeUserID`）。账号级标识不进日志。
    fn uid(&self) -> Result<String> {
        if self.profile.dede_user_id.is_empty() {
            return Err(Error::NotLoggedIn);
        }
        Ok(self.profile.dede_user_id.clone())
    }

    /// 取 `csrf`（即 `bili_jct`）。所有 web 写操作都要它。
    fn csrf(&self) -> Result<String> {
        if self.profile.bili_jct.is_empty() {
            return Err(Error::NotLoggedIn);
        }
        Ok(self.profile.bili_jct.clone())
    }

    /// 找自己直播间：返回房间号；没开通（`code==0` 且 `data.room_id<=0`）→ `Ok(None)`。
    async fn own_room_id(&self) -> Result<Option<i64>> {
        let uid = self.uid()?;
        let value = self
            .http
            .get_with_cookies(&format!("{EP_ROOM_ID_BY_UID}?uid={uid}"))
            .await?
            .0;
        parse_own_room_id(&value)
    }

    /// 直播间信息（`get_info`，不签名）。
    async fn room_info(&self, room_id: i64) -> Result<Value> {
        let value = self
            .http
            .get_with_cookies(&format!("{EP_GET_INFO}?room_id={room_id}"))
            .await?
            .0;
        ensure_ok(&value, "get_info")?;
        Ok(value)
    }

    /// 普通 web 表单 POST：自动补 `csrf` / `csrf_token`。
    async fn post(&self, url: &str, csrf: &str, mut params: Vec<(&str, String)>) -> Result<Value> {
        params.push(("csrf", csrf.to_string()));
        params.push(("csrf_token", csrf.to_string()));
        let body = encode_pairs(&params);
        self.http.post_form(url, &body).await
    }

    /// app 签名的 GET：在 `business` 基础上补 `appkey` + `sign`。
    async fn get_signed(&self, url: &str, business: &[(&str, String)]) -> Result<Value> {
        let mut params: Vec<(&str, String)> = business.to_vec();
        params.push(("appkey", APPKEY.to_string()));
        let sign = app_sign(&params);
        params.push(("sign", sign));
        let query = encode_pairs(&params);
        let (value, _) = self
            .http
            .get_with_cookies(&format!("{url}?{query}"))
            .await?;
        Ok(value)
    }

    /// app 签名的 POST：在 `business` 基础上补 `csrf` / `csrf_token` / `appkey` + `sign`。
    async fn post_signed(
        &self,
        url: &str,
        csrf: &str,
        business: &[(&str, String)],
    ) -> Result<Value> {
        let mut params: Vec<(&str, String)> = business.to_vec();
        params.push(("csrf", csrf.to_string()));
        params.push(("csrf_token", csrf.to_string()));
        params.push(("appkey", APPKEY.to_string()));
        let sign = app_sign(&params);
        params.push(("sign", sign));
        let body = encode_pairs(&params);
        self.http.post_form(url, &body).await
    }
}

#[async_trait]
impl AnchorRoom for BiliAnchor {
    async fn own(&self) -> Result<Option<OwnRoom>> {
        let Some(room_id) = self.own_room_id().await? else {
            return Ok(None);
        };
        let info = self.room_info(room_id).await?;
        let data = info.pointer("/data").cloned().unwrap_or(Value::Null);
        let parent = text(&data, &["parent_area_name"]);
        let child = text(&data, &["area_name"]);
        let area_name = match (parent.is_empty(), child.is_empty()) {
            (true, _) => child,
            (false, true) => parent,
            (false, false) => format!("{parent} · {child}"),
        };
        Ok(Some(OwnRoom {
            room_id,
            title: text(&data, &["title"]),
            live_status: int(&data, &["live_status"]) as i32,
            area_id: int(&data, &["area_id"]),
            area_name,
        }))
    }

    async fn set_title(&self, title: &str) -> Result<OwnRoom> {
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::BadRequest("直播间标题不能为空".into()));
        }
        let Some(room_id) = self.own_room_id().await? else {
            return Err(Error::Upstream("该账号没有开通直播间".into()));
        };
        let csrf = self.csrf()?;
        let value = self
            .post(
                EP_UPDATE,
                &csrf,
                vec![
                    ("room_id", room_id.to_string()),
                    ("platform", "pc_link".to_string()),
                    ("title", title.to_string()),
                ],
            )
            .await?;
        ensure_ok(&value, "Room/update")?;
        // 保存成功就地重读。
        self.own()
            .await?
            .ok_or_else(|| Error::Upstream("改标题后读不到直播间".into()))
    }

    async fn set_area(&self, area_v2: i64) -> Result<OwnRoom> {
        // 与开播同一条口径：`area_id` / `area_v2` 都是**子分区 id**（参照实现
        // `Zeppelinpp/bilibili-streamer` 的 `update_area` 与 `start_live` 传的是同一个值；
        // 本仓已实测的 `get_info.data.area_id` 亦同）。非法值一律 `BAD_REQUEST`，不静默回退。
        if area_v2 <= 0 {
            return Err(Error::BadRequest("开播分区非法".into()));
        }
        let Some(room_id) = self.own_room_id().await? else {
            return Err(Error::Upstream("该账号没有开通直播间".into()));
        };
        let csrf = self.csrf()?;
        // 改分区是**独立入口**：不必等到开播，`Room/update` 带 `area_id` 就能改
        // （参照实现的 `update_area` 就是这么做的）。
        let value = self
            .post(
                EP_UPDATE,
                &csrf,
                vec![
                    ("room_id", room_id.to_string()),
                    ("platform", "pc_link".to_string()),
                    ("area_id", area_v2.to_string()),
                ],
            )
            .await?;
        ensure_ok(&value, "Room/update")?;
        // 写成功就地重读：不猜上游怎么改的，以远端为准。
        self.own()
            .await?
            .ok_or_else(|| Error::Upstream("改分区后读不到直播间".into()))
    }

    async fn go_live(&self, area_v2: Option<i64>) -> Result<AnchorLiveOutcome> {
        let Some(room_id) = self.own_room_id().await? else {
            return Err(Error::Upstream("该账号没有开通直播间".into()));
        };
        let info = self.room_info(room_id).await?;
        let data = info.pointer("/data").cloned().unwrap_or(Value::Null);
        // 分区：界面所选覆盖 → 否则沿用当前（上次开播）分区 → 都没有就不发开播请求。
        let area_v2 = resolve_area(area_v2, int(&data, &["area_id"]))?;

        // 三段式：a. click/now 取服务端时间戳；b. getHomePageLiveVersion（带 app 签名）；c. startLive（整参签名）。
        let now_value = self.http.get_with_cookies(EP_CLICK_NOW).await?.0;
        ensure_ok(&now_value, "click/now")?;
        let now = text(&now_value, &["data", "now"]);

        let home = self
            .get_signed(
                EP_HOME_VER,
                &[("system_version", "2".to_string()), ("ts", now.clone())],
            )
            .await?;
        ensure_ok(&home, "getHomePageLiveVersion")?;
        let build = text(&home, &["data", "build"]);
        let version = text(&home, &["data", "curr_version"]);

        let business = vec![
            ("room_id", room_id.to_string()),
            ("platform", "pc_link".to_string()),
            ("area_v2", area_v2.to_string()),
            ("backup_stream", "0".to_string()),
            ("build", build),
            ("version", version),
            ("ts", now),
        ];
        let csrf = self.csrf()?;
        let live = self.post_signed(EP_START_LIVE, &csrf, &business).await?;

        match live.get("code").and_then(Value::as_i64) {
            Some(0) => {
                let d = live.pointer("/data").cloned().unwrap_or(Value::Null);
                Ok(AnchorLiveOutcome::Opened(map_endpoints(&d)))
            }
            Some(code @ (60043 | 60024)) => {
                let message = text(&live, &["message"]);
                let (kind, url, qr) = if code == 60024 {
                    (
                        AnchorGateKind::QrConfirm,
                        String::new(),
                        text(&live, &["data", "qr"]),
                    )
                } else {
                    (
                        AnchorGateKind::FaceAuth,
                        face_auth_url(&self.uid()?),
                        String::new(),
                    )
                };
                Ok(AnchorLiveOutcome::Blocked(AnchorGate {
                    code,
                    message,
                    kind,
                    url,
                    qr,
                }))
            }
            _ => Err(upstream_err("startLive", &live)),
        }
    }

    async fn end_live(&self) -> Result<()> {
        let Some(room_id) = self.own_room_id().await? else {
            return Err(Error::Upstream("该账号没有开通直播间".into()));
        };
        let csrf = self.csrf()?;
        let value = self
            .post(
                EP_STOP_LIVE,
                &csrf,
                vec![
                    ("room_id", room_id.to_string()),
                    ("platform", "pc_link".to_string()),
                ],
            )
            .await?;
        ensure_ok(&value, "stopLive")
    }

    async fn area_list(&self) -> Result<Vec<AnchorArea>> {
        let value = self
            .http
            .get_with_cookies(&format!("{EP_AREA_LIST}?show_pinyin=1"))
            .await?
            .0;
        ensure_ok(&value, "Area/getList")?;
        Ok(map_areas(&value))
    }
}

/// 定开播分区（`docs/contract.md` §3 / §7）：
/// - `Some(v>0)` = 界面所选子分区，覆盖；
/// - `None` = 沿用直播间当前 `area_id`（上次开播分区）；
/// - `Some(<=0)` = 界面给了非法值 → `BAD_REQUEST`（**不静默回退**，否则「选了个空分区」会变成「照上次开播」）；
/// - `None` 且上游没给分区 = 不发开播请求（`UPSTREAM_ERROR`），**不许**拿自造默认分区顶替（`AGENT.md` §8.7）。
fn resolve_area(area_v2: Option<i64>, current: i64) -> Result<i64> {
    match area_v2 {
        Some(v) if v > 0 => Ok(v),
        Some(_) => Err(Error::BadRequest("开播分区非法".into())),
        None if current > 0 => Ok(current),
        None => Err(Error::Upstream("上游未给出分区，无法开播".into())),
    }
}

/// 人脸认证页地址（认证页地址来自社区实现，**未实测**，`docs/protocol.md` §18.5）。
/// `mid` 就是本人 uid（`DedeUserID`）。
fn face_auth_url(uid: &str) -> String {
    format!(
        "https://www.bilibili.com/blackboard/live/face-auth-middle.html?source_event=400&mid={uid}"
    )
}

/// 开播成功时上游下发的推流端点集合（`docs/protocol.md` §18.2：主 `rtmp` + `protocols[]` 里的 `srt`）。
fn map_endpoints(d: &Value) -> StreamEndpoints {
    let endpoint = |obj: &Value| -> Option<StreamEndpoint> {
        obj.as_object().map(|o| StreamEndpoint {
            addr: o
                .get("addr")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            code: o
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
    };
    let rtmp = d.get("rtmp").and_then(endpoint);
    let rtmp_backup = d.get("rtmp_backup").and_then(endpoint);
    let srt = d
        .get("protocols")
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter().find_map(|p| {
                let proto = p
                    .get("protocol")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if proto == "srt" {
                    endpoint(p)
                } else {
                    None
                }
            })
        });
    StreamEndpoints {
        rtmp,
        rtmp_backup,
        srt,
    }
}

/// 分区列表响应 → `AnchorArea[]`（两级：父 → 子）。
///
/// **字段形态来自参照实现** `Zeppelinpp/bilibili-streamer`
/// （`src-tauri/src/services/live_service.rs::refresh_partitions`）：`data` **直接是数组**，
/// `data[].name` 是父分区名、`data[].list[]` 是子分区数组、子分区 id 取 `data[].list[].id`
/// —— 与 `startLive` 的 `area_v2`、`Room/update` 的 `area_id` 同口径，都是**子分区 id**
/// （同文件 `update_area` / `start_live` 双向印证；本仓已实测的 `get_info.data.area_id` 亦同）。
///
/// ⚠ 该端点的**真实响应未经本仓实测**（`docs/protocol.md` 附录 A66），这里是照参照实现落地、
/// 待真机回填，不得读成已实测。父分区 id 参照实现**根本没有读**（它只用名字做 key），因此
/// 取到就用、取不到置 0 —— **父 id 只作界面的 key，不参与任何写操作**。
fn map_areas(value: &Value) -> Vec<AnchorArea> {
    let Some(parents) = value.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    parents
        .iter()
        .filter_map(|parent| {
            let name = text(parent, &["name"]);
            // 父分区只按名字认（参照实现同口径）：没有名字的一级不渲染成空行。
            if name.is_empty() {
                return None;
            }
            let children = parent
                .get("list")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|child| {
                            let cid = int(child, &["id"]);
                            let cname = text(child, &["name"]);
                            // 子分区 id 才是开播 / 改分区要用的值，取不到就不能进桶。
                            (cid > 0).then_some(AnchorArea {
                                id: cid,
                                name: cname,
                                children: Vec::new(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AnchorArea {
                id: int(parent, &["id"]),
                name,
                children,
            })
        })
        .collect()
}

/// `room_id_by_uid` 响应 → 房间号；`code==0` 且 `data.room_id<=0` 表示没开通直播间 → `None`。
fn parse_own_room_id(value: &Value) -> Result<Option<i64>> {
    ensure_ok(value, "room_id_by_uid")?;
    let room_id = int(value, &["data", "room_id"]);
    Ok((room_id > 0).then_some(room_id))
}

/// 非 0 code → `UPSTREAM_ERROR`，原样带回 code 与上游 message。**推流码等凭据不进日志**。
fn ensure_ok(value: &Value, what: &str) -> Result<()> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        _ => Err(upstream_err(what, value)),
    }
}

fn upstream_err(what: &str, value: &Value) -> Error {
    Error::Upstream(redact(&format!(
        "{what} code={:?} message={}",
        value.get("code"),
        value.get("message").and_then(Value::as_str).unwrap_or("")
    )))
}

/// 取嵌套整数字段（`["data", "room_id"]` → `data.room_id`），缺失 / 非数为 0。
fn int(value: &Value, keys: &[&str]) -> i64 {
    pointer(keys)
        .and_then(|path| value.pointer(&path))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

/// 取嵌套字符串字段，缺失 / 非串为空串。
fn text(value: &Value, keys: &[&str]) -> String {
    pointer(keys)
        .and_then(|path| value.pointer(&path))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 键列表 → JSON Pointer。空列表没有落点。
fn pointer(keys: &[&str]) -> Option<String> {
    if keys.is_empty() {
        return None;
    }
    Some(
        keys.iter()
            .map(|k| format!("/{k}"))
            .collect::<Vec<_>>()
            .join(""),
    )
}

/// 把参数集编码成 `key=value&...`（与签名同一套 `form_urlencoded` 编码，空格编成 `+`）。
fn encode_pairs(params: &[(&str, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
        .finish()
}

/// app 签名（纯函数，`docs/protocol.md` §18.3）：参数加 `appkey` → 按 key 升序 → 编码 →
/// `md5(<编码后><appsec>)`；`sign` 追加在末尾、不参与排序与摘要。
///
/// 调用方负责把 **已含 `appkey`** 的参数集传进来（不含 `sign`）。
fn app_sign(params: &[(&str, String)]) -> String {
    let mut pairs: Vec<(&str, String)> = params.to_vec();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    let raw = encode_pairs(&pairs);
    let digest = md5::compute(format!("{raw}{APPSEC}").as_bytes());
    format!("{digest:x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_sign_is_deterministic_and_sorted() {
        // 纯函数：同一输入 → 同一输出；排序后编码再 md5(appsec)。
        let params = vec![
            ("room_id", "123".to_string()),
            ("area_v2", "456".to_string()),
            ("appkey", APPKEY.to_string()),
        ];
        let first = app_sign(&params);
        let second = app_sign(&params);
        assert_eq!(first, second, "app_sign 必须确定");

        // 不同参数 → 不同签名（不是退化常量）。
        let other = app_sign(&[("appkey", APPKEY.to_string())]);
        assert_ne!(first, other, "签名应随参数变化");

        // 小写十六进制、32 位。
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn resolve_area_prefers_choice_then_current() {
        // 界面所选覆盖当前分区。
        assert_eq!(resolve_area(Some(456), 123).unwrap(), 456);
        // 缺省沿用当前（上次开播）分区。
        assert_eq!(resolve_area(None, 123).unwrap(), 123);
    }

    #[test]
    fn resolve_area_rejects_bad_choice_and_missing_current() {
        // Some(<=0) 是非法值 → BAD_REQUEST，不静默回退成「沿用上次」。
        let err = resolve_area(Some(0), 123).unwrap_err();
        assert_eq!(err.code(), "BAD_REQUEST", "非法分区应是 BAD_REQUEST");
        assert!(resolve_area(Some(-1), 123).is_err());
        // 上游没给分区 → 不发开播请求。
        assert!(resolve_area(None, 0).is_err());
    }

    #[test]
    fn nested_read_walks_path_not_aliases() {
        // `["data", "room_id"]` 是**嵌套路径**，不是两个并列别名：
        // 曾按并列别名实现，导致顶层 `data` 不是数字时静默取到 0。
        let value = json!({"code": 0, "data": {"room_id": 777, "title": "标题"}});
        assert_eq!(int(&value, &["data", "room_id"]), 777);
        assert_eq!(text(&value, &["data", "title"]), "标题");
        // 缺失落点为默认值，不外泄上游结构。
        assert_eq!(int(&value, &["data", "nope"]), 0);
        assert_eq!(text(&value, &["data", "nope"]), "");
    }

    #[test]
    fn own_room_id_none_when_missing_or_zero() {
        // 没开通直播间：`code==0` 但 `data.room_id` 缺失 / ≤ 0 → `None`。
        assert_eq!(
            parse_own_room_id(&json!({"code": 0, "data": {"room_id": 0}})).unwrap(),
            None
        );
        assert_eq!(
            parse_own_room_id(&json!({"code": 0, "data": {}})).unwrap(),
            None
        );
        // 开通了 → `Some(room_id)`。
        assert_eq!(
            parse_own_room_id(&json!({"code": 0, "data": {"room_id": 777}})).unwrap(),
            Some(777)
        );
    }

    #[test]
    fn own_room_id_nonzero_code_is_error() {
        // 非 0 code 一律是上游错误，不在此判「没开通」。
        let err = parse_own_room_id(&json!({"code": -101, "message": "请先登录"})).unwrap_err();
        let rendered = err.to_string();
        assert!(rendered.contains("-101"));
        assert!(rendered.contains("请先登录"));
    }

    /// `data` **直接是数组** —— 参照实现 `Zeppelinpp/bilibili-streamer`
    /// （`live_service.rs::refresh_partitions`）就是这么读的：`data[].name` / `data[].list[].id`。
    /// 改前本仓读的是 `data.list[]`（把 `data` 当对象），解析恒为空 → 界面降级成只读分区名、
    /// 用户看到「分区没有修改选项」（issue202609241553 第 4 条）。这条夹具就是那次错误的回归闸。
    #[test]
    fn area_list_parses_two_levels() {
        let value = json!({
            "code": 0,
            "data": [
                {"id": 1, "name": "娱乐", "list": [
                    {"id": 11, "name": "视频唱见"},
                    {"id": 12, "name": "聊天"}
                ]},
                {"id": 2, "name": "游戏", "list": [
                    {"id": 21, "name": "单机"}
                ]}
            ]
        });
        let areas = map_areas(&value);
        assert_eq!(areas.len(), 2);
        assert_eq!(areas[0].id, 1);
        assert_eq!(areas[0].name, "娱乐");
        assert_eq!(areas[0].children.len(), 2);
        assert_eq!(areas[0].children[0].id, 11);
        assert_eq!(areas[1].children[0].id, 21);
    }

    /// 父分区 id **不是**判据：参照实现只读父名、不读父 id（用名字做 key），
    /// 因此上游不给父 id 时这一级照样要出现在界面上（父 id 取 0，不参与写）。
    #[test]
    fn area_list_parent_without_id_is_kept() {
        let value = json!({
            "code": 0,
            "data": [{"name": "虚拟主播", "list": [{"id": 371, "name": "虚拟主播"}]}]
        });
        let areas = map_areas(&value);
        assert_eq!(areas.len(), 1);
        assert_eq!(areas[0].id, 0);
        assert_eq!(areas[0].children.len(), 1);
        assert_eq!(areas[0].children[0].id, 371);
    }

    /// 子分区 id 取不到就不能进桶：它是开播 / 改分区真正要用的值，缺了等于这一项是坏的。
    #[test]
    fn area_list_drops_children_without_id() {
        let value = json!({
            "code": 0,
            "data": [{"id": 1, "name": "娱乐", "list": [{"name": "没有 id"}, {"id": 12, "name": "聊天"}]}]
        });
        let areas = map_areas(&value);
        assert_eq!(areas[0].children.len(), 1);
        assert_eq!(areas[0].children[0].id, 12);
    }

    #[test]
    fn area_list_tolerates_missing_envelope() {
        // `data` 不是数组（含旧写法假设的 `data.list` 那种对象形态）→ 一律空，不 panic。
        assert!(map_areas(&json!({"code": 0, "data": {"list": []}})).is_empty());
        assert!(map_areas(&json!({"code": 0, "data": null})).is_empty());
        assert!(map_areas(&json!({})).is_empty());
    }

    #[test]
    fn endpoints_parse_rtmp_and_srt() {
        // 成功分支（未实测，仅形状容错）：主 `rtmp` + `protocols[]` 里的 `srt`。
        let d = json!({
            "rtmp": {"addr": "rtmp://a", "code": "secret-rtmp"},
            "rtmp_backup": {"addr": "rtmp://b", "code": "secret-backup"},
            "protocols": [
                {"protocol": "rtmp", "addr": "rtmp://a", "code": "secret-rtmp"},
                {"protocol": "srt", "addr": "srt://c", "code": "secret-srt"}
            ]
        });
        let se = map_endpoints(&d);
        assert_eq!(se.rtmp.as_ref().unwrap().addr, "rtmp://a");
        assert_eq!(se.rtmp_backup.as_ref().unwrap().code, "secret-backup");
        assert_eq!(se.srt.as_ref().unwrap().addr, "srt://c");
    }

    #[test]
    fn endpoints_tolerate_missing() {
        let se = map_endpoints(&json!({}));
        assert!(se.rtmp.is_none());
        assert!(se.rtmp_backup.is_none());
        assert!(se.srt.is_none());
    }
}
