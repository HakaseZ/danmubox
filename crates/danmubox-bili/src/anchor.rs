//! **我自己的直播间**（主播视角）：`AnchorRoom` 端口（`docs/contract.md` §3，
//! IPC `anchor_room` / `anchor_title_set` / `anchor_live_set`）。
//!
//! 与 [`crate::http::BiliHttp::room_play_info`] 的分工：那个是「看别人的房间」（只读，游客也可用），
//! 这里是「管自己的房间」——改标题、开播、下播三件写操作，**只作用于当前账号自己的直播间**
//! （`AGENT.md` §8.15：不换房间、不换账号、不换参数重试；失败即停）。
//!
//! | 动作 | 端点 |
//! |---|---|
//! | 找自己直播间 | `GET room/v2/Room/room_id_by_uid?uid=` |
//! | 房间信息 | `GET room/v1/Room/get_info?room_id=` |
//! | 改标题 | `POST room/v1/Room/update` |
//! | 开播 a | `GET https://api.bilibili.com/x/report/click/now` |
//! | 开播 b | `GET xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion?system_version=2&ts=&sign=` |
//! | 开播 c | `POST room/v1/Room/startLive`（整个参数集带 app 签名） |
//! | 下播 | `POST room/v1/Room/stopLive` |
//!
//! **本仓尚未实测**：端点、字段与签名口径全部来自两份社区实现
//! （ChaceQC/bilibili_live_stream_code、Zeppelinpp/bilibili-streamer）；本次唯一有实证的是
//! `room_id_by_uid`（`code=0` 时 `data` 只有 `room_id`）与 `get_info` 的分区字段
//! （`data.area_id` 有值，`area_v2_id` 恒为 `null`）——2026-09-19 由 Main 用公开测试房间只读实测。
//! 写操作链路（`update` / `startLive` / `stopLive`）一次都没打过，实测状态待
//! `docs/protocol.md` 附录 A 回填。
//!
//! 两处**明确未实测**，实现按「不赋语义」处理：
//! - **「该账号没有开通直播间」时上游回什么 `code` / 什么信封**——没有样本。因此只在
//!   `code == 0` 且 `data.room_id` 缺失 / 非正数时才判为「没有直播间」（`Ok(None)`）；
//!   任何非 0 `code` 都原样报错，不往这个结论上靠。
//! - 开播成功响应的 `data.protocols[]` 具体形态——按「第一条 `rtmp` 作备用、第一条 `srt`
//!   作 SRT」解析，缺的组给 `None`（不猜、不补默认）。
//!
//! 上游非 0 `code`（含人脸认证那类，两份实现观察到 60024 / 60043）**原样带回、不赋语义**：
//! 不辨认数值、不读 `data.qr`、不弹二维码，界面只拿到 `code` 与 `msg`。
//!
//! **写错误文案的坑（后来人最容易再踩）**：错误串里不得出现「`键名` + `:` + 值」的形态。
//! 文案要过 [`crate::redact`]，而 `room_id_by_uid` / `csrf_token` 这类标签里含 `uid`、`csrf`
//! 键名，键名后面紧跟 `:` 会被判成「键名 + 分隔符 + 值」，紧跟在后的那段措辞（到下一个
//! 值结束符为止）就被抹成 `***`——诊断信息里最要紧的那截正好没了。
//! 本模块的 `ensure_ok` 因此用**空格**分隔标签与措辞（`admin.rs` 同款）：`"{what} 上游返回 code=… msg=…"`。

use std::sync::Arc;

use danmubox_core::ports::AnchorRoom;
use danmubox_core::{ConfigStore, Error, OwnRoom, Result, StreamEndpoint, StreamEndpoints};
use serde_json::Value;

use crate::http::BiliHttp;

const EP_ROOM_ID_BY_UID: &str = "https://api.live.bilibili.com/room/v2/Room/room_id_by_uid";
const EP_ROOM_INFO: &str = "https://api.live.bilibili.com/room/v1/Room/get_info";
const EP_ROOM_UPDATE: &str = "https://api.live.bilibili.com/room/v1/Room/update";
/// 服务端当前时间戳（开播三段式的第一段）。
const EP_CLICK_NOW: &str = "https://api.bilibili.com/x/report/click/now";
/// 开播客户端版本（第二段）。官方 web 端开播也走它，只有拿到 build / version 才能开播。
const EP_LIVE_VERSION: &str =
    "https://api.live.bilibili.com/xlive/app-blink/v1/liveVersionInfo/getHomePageLiveVersion";
const EP_START_LIVE: &str = "https://api.live.bilibili.com/room/v1/Room/startLive";
const EP_STOP_LIVE: &str = "https://api.live.bilibili.com/room/v1/Room/stopLive";

/// 直播姬的公开 app key（两份社区实现逐字一致；这是客户端标识，**不是账号凭据**）。
const APPKEY: &str = "aae92bc66f3edfab";
/// 与 [`APPKEY`] 配套的公开 app secret。
const APPSEC: &str = "af125a0d5279fd576c1b4418a3e8276d";

/// 开播 / 改标题等写操作的 `platform` 取值（官方 pc_link 形态）。
const PLATFORM: &str = "pc_link";

/// app 签名：参数加 `appkey` → 按 key 升序排序 → `urlencode` → `sign = md5(query + appsec)`，
/// 再把 `sign` 并进参数（追加在末尾）。
///
/// 纯函数：给定参数集，结果完全确定，便于用固定向量断言（不联网）。
pub fn app_sign(mut params: Vec<(String, String)>) -> Vec<(String, String)> {
    params.push(("appkey".to_string(), APPKEY.to_string()));
    params.sort_by(|a, b| a.0.cmp(&b.0));
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in &params {
        serializer.append_pair(key, value);
    }
    let digest = md5::compute(format!("{}{APPSEC}", serializer.finish()).as_bytes());
    params.push(("sign".to_string(), format!("{digest:x}")));
    params
}

/// 参数表 → `application/x-www-form-urlencoded` 串（保序）。
fn encode(params: &[(String, String)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .finish()
}

/// 上游的整数字段有时是数字、有时是字符串（`wallet.rs` 同款容错）；统一取文本形态。
fn value_as_text(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// 非 0 `code` → `UPSTREAM_ERROR`，`code` 与上游 `msg` **原样带回、不赋语义**。
///
/// 人脸认证那类码（60024 / 60043）在这里与其它非 0 code 走完全同一条路径：
/// 不辨认数值、不读 `data.qr`、不弹二维码，只把原值交给界面。
///
/// `what` 与后面的措辞之间**用空格、不用冒号**（`admin.rs` 同款写法）：文案要过
/// [`crate::redact`]，而 `room_id_by_uid` / `csrf_token` 这类标签里含 `uid`、`csrf` 键名，
/// 键名后面紧跟 `:` 会被判成「键名 + 分隔符 + 值」，紧跟其后的那段措辞就被抹成 `***`
/// （用本地复刻验证过：`room_id_by_uid: 上游返回 code=-352` → `room_id_by_uid: *** code=-352`）。
/// 空格不是分隔符，键名因此原样保留。
fn ensure_ok(value: &Value, what: &str) -> Result<()> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        code => {
            let code = code.map(|c| c.to_string()).unwrap_or_else(|| "缺失".into());
            let msg = value.get("message").and_then(Value::as_str).unwrap_or("");
            // 上游 `message` 可能把请求原样吐回来（`admin.rs` 同款顾虑），成文即脱敏。
            Err(Error::Upstream(crate::redact::redact(&format!(
                "{what} 上游返回 code={code} msg={msg}"
            ))))
        }
    }
}

/// `room_id_by_uid` 响应 → 直播间号；`Ok(None)` = 该账号**没有直播间**。
///
/// 判据只有一条：`code == 0` 且 `data.room_id` 缺失 / `<= 0`。实测（2026-09-19，公开测试房间）
/// 只钉死了 `code=0` 时 `data` 只有 `room_id` 一个键；**「没有开通直播间」时上游到底回什么
/// code / 什么信封，本仓一次都没实测过**——所以不拿任何非 0 `code` 当这个判据。
///
/// 非 0 `code`（风控 `-352`、凭据失效 `-101` 等）原样报错：把它们静默渲染成「没开通直播间」
/// 会让用户与日志都看不到真实原因（`AGENT.md` §8.9）。
fn own_room_id(value: &Value) -> Result<Option<i64>> {
    ensure_ok(value, "room_id_by_uid")?;
    Ok(value
        .pointer("/data/room_id")
        .and_then(Value::as_i64)
        .filter(|room_id| *room_id > 0))
}

/// 分区名的展示形态：「父 · 子」（`OwnRoom.area_name` 的注释口径）；
/// 只有一边就给那一边，两边都没有就是空串。
fn area_display_name(data: &Value) -> String {
    let parent = data
        .get("parent_area_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let child = data
        .get("area_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    match (parent.is_empty(), child.is_empty()) {
        (false, false) => format!("{parent} · {child}"),
        (false, true) => parent.to_string(),
        (true, false) => child.to_string(),
        (true, true) => String::new(),
    }
}

/// `get_info` 响应 → `OwnRoom`（上游字段名只允许出现在这个函数里）。
fn own_room_from_info(room_id: i64, value: &Value) -> Result<OwnRoom> {
    ensure_ok(value, "get_info")?;
    let data = value
        .get("data")
        .filter(|data| !data.is_null())
        .ok_or_else(|| Error::Upstream("get_info 响应缺少 data".into()))?;
    Ok(OwnRoom {
        room_id,
        title: data
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        live_status: data.get("live_status").and_then(Value::as_i64).unwrap_or(0) as i32,
        // 只用 `area_id`：实测 `area_v2_id` 恒为 `null`（2026-09-19，公开测试房间）。
        // `0` = 上游没给分区，开播时据此拒绝（不许自造默认分区，`AGENT.md` §8.7）。
        area_id: data.get("area_id").and_then(Value::as_i64).unwrap_or(0),
        area_name: area_display_name(data),
    })
}

/// 一组推流端点；`addr` 或 `code` 缺一就整组作废（不猜、不补默认）。
fn endpoint_of(value: &Value) -> Option<StreamEndpoint> {
    let addr = value
        .get("addr")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if addr.is_empty() || code.is_empty() {
        return None;
    }
    Some(StreamEndpoint {
        addr: addr.to_string(),
        code: code.to_string(),
    })
}

/// `startLive` 响应 → 三组推流端点：主 `data.rtmp`，`data.protocols[]` 里第一条
/// `rtmp` 作备用、第一条 `srt` 作 SRT；上游没给的那组是 `None`。
fn stream_endpoints(value: &Value) -> StreamEndpoints {
    let data = value.get("data").unwrap_or(&Value::Null);
    let protocols = data
        .get("protocols")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let first_of = |protocol: &str| {
        protocols
            .iter()
            .find(|item| item.get("protocol").and_then(Value::as_str) == Some(protocol))
            .and_then(endpoint_of)
    };
    StreamEndpoints {
        rtmp: data.get("rtmp").and_then(endpoint_of),
        rtmp_backup: first_of("rtmp"),
        srt: first_of("srt"),
    }
}

/// 主播侧直播间适配器。凭据由 `BiliHttp` 实时读取当前账号，
/// 因此切换账号后无需重建客户端，写操作也只会落到当前账号自己的直播间。
pub struct BiliAnchor {
    http: BiliHttp,
    store: Arc<ConfigStore>,
    /// 端点根地址：生产恒为空串（直接用 `EP_*` 的全量地址）；
    /// 测试指向本地桩服务器，好逐段断言请求。
    base: String,
}

impl BiliAnchor {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
            base: String::new(),
        })
    }

    /// 仅测试：把全部端点重定向到本地桩服务器（生产恒为空串）。
    #[cfg(test)]
    fn with_base(mut self, base: String) -> Self {
        self.base = base;
        self
    }

    /// 端点地址。`base` 非空时只保留路径并改挂到它下面——桩服务器按路径应答，不区分主机。
    fn endpoint(&self, full: &str) -> String {
        if self.base.is_empty() {
            return full.to_string();
        }
        let rest = full.split_once("://").map(|(_, rest)| rest).unwrap_or(full);
        let path = rest.find('/').map(|at| &rest[at..]).unwrap_or("/");
        format!("{}{path}", self.base)
    }

    /// 取 `csrf` 值（即 `bili_jct`）。所有写操作都要它（`admin.rs` 同款口径）。
    fn csrf(&self) -> Result<String> {
        let profile = self
            .store
            .active()
            .filter(|profile| profile.is_complete())
            .ok_or(Error::NotLoggedIn)?;
        if profile.bili_jct.is_empty() {
            return Err(Error::NotLoggedIn);
        }
        Ok(profile.bili_jct)
    }

    /// GET 并取回 JSON（`Set-Cookie` 用不上，丢弃）。
    async fn get_json(&self, url: &str) -> Result<Value> {
        let (value, _cookies) = self.http.get_with_cookies(url).await?;
        Ok(value)
    }

    /// 当前账号自己直播间的房间号。
    ///
    /// 写操作的目标**只能**是自己的直播间：没有直播间就没有合法目标，报错而不是
    /// 换房间 / 换账号（`AGENT.md` §8.15）。
    async fn own_room_id(&self) -> Result<i64> {
        match self.own().await? {
            Some(room) => Ok(room.room_id),
            None => Err(Error::Upstream("当前账号没有开通直播间".into())),
        }
    }
}

#[async_trait::async_trait]
impl AnchorRoom for BiliAnchor {
    async fn own(&self) -> Result<Option<OwnRoom>> {
        if !self.store.is_logged_in() {
            return Err(Error::NotLoggedIn);
        }
        // uid 取当前凭据里的 `DedeUserID`：登录时与 Cookie 一起落盘，同源且不必多打一次
        // `nav`（`room_id_by_uid` 只认 uid）。0 = 凭据里的 uid 不可用，等同未登录。
        let uid = self
            .store
            .active()
            .map(|profile| profile.uid())
            .unwrap_or(0);
        if uid <= 0 {
            return Err(Error::NotLoggedIn);
        }

        let url = self.endpoint(EP_ROOM_ID_BY_UID);
        let query = encode(&[("uid".to_string(), uid.to_string())]);
        let value = self.get_json(&format!("{url}?{query}")).await?;
        let Some(room_id) = own_room_id(&value)? else {
            return Ok(None);
        };

        let url = self.endpoint(EP_ROOM_INFO);
        let query = encode(&[("room_id".to_string(), room_id.to_string())]);
        let value = self.get_json(&format!("{url}?{query}")).await?;
        Ok(Some(own_room_from_info(room_id, &value)?))
    }

    async fn set_title(&self, title: &str) -> Result<()> {
        // 空标题在**发请求之前**就拒掉：上游唯一可能的答复是报错，没有理由打这一枪。
        let title = title.trim();
        if title.is_empty() {
            return Err(Error::BadRequest("直播间标题不能为空".into()));
        }
        let csrf = self.csrf()?;
        let room_id = self.own_room_id().await?;
        // 不签名（两份社区实现一致）：只带 csrf / csrf_token。
        let body = encode(&[
            ("room_id".to_string(), room_id.to_string()),
            ("platform".to_string(), PLATFORM.to_string()),
            ("title".to_string(), title.to_string()),
            ("csrf_token".to_string(), csrf.clone()),
            ("csrf".to_string(), csrf),
        ]);
        let url = self.endpoint(EP_ROOM_UPDATE);
        let value = self.http.post_form(&url, &body).await?;
        ensure_ok(&value, "改直播间标题")
    }

    async fn go_live(&self) -> Result<StreamEndpoints> {
        let room = self
            .own()
            .await?
            .ok_or_else(|| Error::Upstream("当前账号没有开通直播间".into()))?;
        if room.area_id <= 0 {
            // 分区必须来自上游：自造默认分区会把直播推到错误的分区（`AGENT.md` §8.7）。
            return Err(Error::Upstream(
                "上游没有给出该直播间的分区，无法开播".into(),
            ));
        }
        let csrf = self.csrf()?;

        // a. 服务端当前时间戳。
        let url = self.endpoint(EP_CLICK_NOW);
        let now = self.get_json(&url).await?;
        ensure_ok(&now, "click/now")?;
        let ts = now
            .pointer("/data/now")
            .and_then(value_as_text)
            .ok_or_else(|| Error::Upstream("click/now 未返回 data.now".into()))?;

        // b. 开播客户端 build / version（带 app 签名）。
        let signed = app_sign(vec![
            ("system_version".to_string(), "2".to_string()),
            ("ts".to_string(), ts.clone()),
        ]);
        let url = self.endpoint(EP_LIVE_VERSION);
        let value = self.get_json(&format!("{url}?{}", encode(&signed))).await?;
        ensure_ok(&value, "liveVersionInfo")?;
        let build = value
            .pointer("/data/build")
            .and_then(value_as_text)
            .ok_or_else(|| Error::Upstream("liveVersionInfo 未返回 data.build".into()))?;
        let version = value
            .pointer("/data/curr_version")
            .and_then(value_as_text)
            .ok_or_else(|| Error::Upstream("liveVersionInfo 未返回 data.curr_version".into()))?;

        // c. 开播。整个参数集（含 csrf）一并做 app 签名；用房间当前分区，不改分区。
        let signed = app_sign(vec![
            ("room_id".to_string(), room.room_id.to_string()),
            ("platform".to_string(), PLATFORM.to_string()),
            ("area_v2".to_string(), room.area_id.to_string()),
            ("backup_stream".to_string(), "0".to_string()),
            ("csrf_token".to_string(), csrf.clone()),
            ("csrf".to_string(), csrf),
            ("build".to_string(), build),
            ("version".to_string(), version),
            ("ts".to_string(), ts),
        ]);
        let url = self.endpoint(EP_START_LIVE);
        let value = self.http.post_form(&url, &encode(&signed)).await?;
        ensure_ok(&value, "开播")?;
        Ok(stream_endpoints(&value))
    }

    async fn end_live(&self) -> Result<()> {
        let csrf = self.csrf()?;
        let room_id = self.own_room_id().await?;
        let body = encode(&[
            ("room_id".to_string(), room_id.to_string()),
            ("platform".to_string(), PLATFORM.to_string()),
            ("csrf_token".to_string(), csrf.clone()),
            ("csrf".to_string(), csrf),
        ]);
        let url = self.endpoint(EP_STOP_LIVE);
        let value = self.http.post_form(&url, &body).await?;
        ensure_ok(&value, "下播")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmubox_core::Profile;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 本地桩服务器：按顺序回放 `responses`（最后一份复用），并记录收到的请求数。
    ///
    /// 与 `http.rs` 测试里的 `spawn_stub` 同款（同样的理由：`RequestBuilder` 的
    /// append 语义、以及「有没有真的发请求」只能从线上形态看出来）。这里只留 `hits`，
    /// 因为锚点请求的参数全部落在 URL / body 里，本模块的断言不依赖请求头。
    struct Stub {
        base: String,
        hits: Arc<AtomicUsize>,
    }

    impl Stub {
        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    fn spawn_stub(responses: &[(u16, &str, &str)]) -> Stub {
        use std::io::{BufRead, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定本地桩");
        let address = listener.local_addr().expect("本地桩地址");
        let queue: Arc<Mutex<Vec<(u16, String, String)>>> = Arc::new(Mutex::new(
            responses
                .iter()
                .map(|(status, content_type, body)| {
                    (*status, content_type.to_string(), body.to_string())
                })
                .collect(),
        ));
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);

        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                // 读到请求头结束再回，避免在客户端发完请求前抢跑（reqwest 会报 broken pipe）。
                let mut reader = std::io::BufReader::new(stream.try_clone().expect("克隆桩连接"));
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if line == "\r\n" => break,
                        Ok(_) => {}
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let (status, content_type, body) = {
                    let mut queue = queue.lock().expect("桩队列");
                    if queue.len() > 1 {
                        queue.remove(0)
                    } else {
                        queue.first().cloned().unwrap_or_default()
                    }
                };
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        Stub {
            base: format!("http://{address}"),
            hits,
        }
    }

    fn logged_out_store(tag: &str) -> Arc<ConfigStore> {
        let path = std::env::temp_dir()
            .join(format!("danmubox-anchor-test-{}-{tag}", std::process::id()))
            .join("config.toml");
        Arc::new(ConfigStore::load(path).expect("空配置应可加载"))
    }

    /// 登录态 + 一个可用的 uid（`own()` 的 uid 来自凭据，不发 `nav`）。
    fn store_with_login(tag: &str, uid: i64) -> Arc<ConfigStore> {
        let store = logged_out_store(tag);
        let name = store.active_name();
        store
            .save_profile(
                &name,
                Profile {
                    sessdata: "SESSDATA".into(),
                    bili_jct: "JCT".into(),
                    dede_user_id: uid.to_string(),
                    ..Default::default()
                },
                true,
            )
            .expect("写入临时配置");
        store
    }

    fn anchor_with_stub(tag: &str, uid: i64, stub: &Stub) -> BiliAnchor {
        BiliAnchor::new(store_with_login(tag, uid))
            .expect("构造适配器")
            .with_base(stub.base.clone())
    }

    /// 一份正常的 `get_info` 载荷（字段形态取自 2026-09-19 公开测试房间的实测：
    /// `area_id` 有值、`area_v2_id` 为 null、分区名分父子两段）。
    fn info_body(title: &str, area_id: i64) -> String {
        json!({
            "code": 0,
            "message": "0",
            "data": {
                "room_id": 5440,
                "title": title,
                "live_status": 0,
                "area_id": area_id,
                "area_v2_id": null,
                "area_name": "视频唱见",
                "parent_area_name": "娱乐"
            }
        })
        .to_string()
    }

    #[test]
    fn app_sign_matches_hand_computed_md5() {
        // 手算向量：query = appkey=aae92bc66f3edfab&system_version=2&ts=1700000000，
        // sign = md5(query + appsec)。值由外部脚本算出后冻结，不使用本模块的代码路径。
        let signed = app_sign(vec![
            ("ts".to_string(), "1700000000".to_string()),
            ("system_version".to_string(), "2".to_string()),
        ]);
        assert_eq!(
            signed,
            vec![
                ("appkey".to_string(), "aae92bc66f3edfab".to_string()),
                ("system_version".to_string(), "2".to_string()),
                ("ts".to_string(), "1700000000".to_string()),
                (
                    "sign".to_string(),
                    "a98e8814240417bed555873f3892c131".to_string()
                ),
            ],
            "签名必须按 key 升序、appkey 参与签名、sign 追加在末尾"
        );
    }

    #[test]
    fn app_sign_covers_every_start_live_parameter() {
        // 开播载荷的完整签名向量（含 csrf / build / version / 分区）。
        let signed = app_sign(vec![
            ("room_id".to_string(), "5440".to_string()),
            ("platform".to_string(), "pc_link".to_string()),
            ("area_v2".to_string(), "21".to_string()),
            ("backup_stream".to_string(), "0".to_string()),
            ("csrf_token".to_string(), "JCT".to_string()),
            ("csrf".to_string(), "JCT".to_string()),
            ("build".to_string(), "8191".to_string()),
            ("version".to_string(), "8.19.1".to_string()),
            ("ts".to_string(), "1700000000".to_string()),
        ]);
        let sign = signed.last().expect("sign 在末尾");
        assert_eq!(sign.0, "sign");
        assert_eq!(sign.1, "3eb8e005282cb296133df58caf62dc02");
    }

    #[tokio::test]
    async fn own_is_rejected_without_a_request_when_logged_out() {
        let stub = spawn_stub(&[(200, "application/json", "{}")]);
        let anchor = BiliAnchor::new(logged_out_store("own-logged-out"))
            .expect("构造适配器")
            .with_base(stub.base.clone());
        assert_eq!(anchor.own().await.unwrap_err().code(), "NOT_LOGGED_IN");
        assert_eq!(stub.hits(), 0, "未登录不得发请求");
    }

    #[tokio::test]
    async fn own_returns_none_when_code_is_zero_but_room_id_is_absent_or_zero() {
        // 「没有直播间」的唯一判据：code=0 且拿不到正数 room_id。
        let stub = spawn_stub(&[
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{}}"#,
            ),
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{"room_id":0}}"#,
            ),
        ]);
        let anchor = anchor_with_stub("own-no-room", 42, &stub);
        assert!(anchor.own().await.unwrap().is_none());
        assert!(anchor.own().await.unwrap().is_none());
        assert_eq!(stub.hits(), 2, "没有直播间就不该再问 get_info");
    }

    #[tokio::test]
    async fn own_reports_a_nonzero_code_verbatim_instead_of_calling_it_no_room() {
        // -352 是风控码：它不是「没开通直播间」，静默成 Ok(None) 会让界面整块消失、
        // 也让日志失去原因（`AGENT.md` §8.9）。
        let stub = spawn_stub(&[(
            200,
            "application/json",
            r#"{"code":-352,"message":"风控校验失败"}"#,
        )]);
        let anchor = anchor_with_stub("own-code", 42, &stub);
        let err = anchor.own().await.unwrap_err();
        assert_eq!(err.code(), "UPSTREAM_ERROR");
        let text = err.to_string();
        assert!(text.contains("-352"), "错误串必须含原始 code：{text}");
        assert!(
            text.contains("风控校验失败"),
            "错误串必须含上游 msg：{text}"
        );
        assert_eq!(stub.hits(), 1);
    }

    #[tokio::test]
    async fn own_maps_room_id_title_status_and_composed_area_name() {
        let info = info_body("我的标题", 21);
        let stub = spawn_stub(&[
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{"room_id":5440}}"#,
            ),
            (200, "application/json", info.as_str()),
        ]);
        let anchor = anchor_with_stub("own-ok", 42, &stub);
        let room = anchor.own().await.unwrap().expect("应有直播间");
        assert_eq!(room.room_id, 5440);
        assert_eq!(room.title, "我的标题");
        assert_eq!(room.live_status, 0);
        assert_eq!(room.area_id, 21);
        assert_eq!(room.area_name, "娱乐 · 视频唱见");
        assert!(!room.is_live());
        assert_eq!(stub.hits(), 2);
    }

    #[test]
    fn area_name_falls_back_to_the_half_that_exists() {
        let only_child = json!({"area_name": "视频唱见", "parent_area_name": ""});
        assert_eq!(area_display_name(&only_child), "视频唱见");
        let only_parent = json!({"area_name": "", "parent_area_name": "娱乐"});
        assert_eq!(area_display_name(&only_parent), "娱乐");
        let neither = json!({"area_name": null, "parent_area_name": null});
        assert_eq!(area_display_name(&neither), "");
    }

    #[tokio::test]
    async fn set_title_rejects_a_blank_title_without_a_request() {
        let stub = spawn_stub(&[(200, "application/json", "{}")]);
        let anchor = anchor_with_stub("title-blank", 42, &stub);
        let err = anchor.set_title("   ").await.unwrap_err();
        assert_eq!(err.code(), "BAD_REQUEST");
        assert_eq!(stub.hits(), 0, "空标题不该发请求");
    }

    #[tokio::test]
    async fn set_title_keeps_the_upstream_code_verbatim() {
        // 60024 是社区实现观察到的人脸认证码：本层**不辨认**，与其它非 0 code 一样只透传。
        let info = info_body("我的标题", 21);
        let stub = spawn_stub(&[
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{"room_id":5440}}"#,
            ),
            (200, "application/json", info.as_str()),
            (
                200,
                "application/json",
                r#"{"code":60024,"message":"需要人脸认证","data":{"qr":"..."}}"#,
            ),
        ]);
        let anchor = anchor_with_stub("title-code", 42, &stub);
        let err = anchor.set_title("新标题").await.unwrap_err();
        assert_eq!(err.code(), "UPSTREAM_ERROR");
        let text = err.to_string();
        assert!(text.contains("60024"), "错误串必须含原始 code：{text}");
        assert!(
            text.contains("需要人脸认证"),
            "错误串必须含上游 msg：{text}"
        );
        assert!(!text.contains("qr"), "不得把二维码载荷带进错误文案：{text}");
        assert_eq!(stub.hits(), 3);
    }

    #[tokio::test]
    async fn go_live_parses_all_three_endpoint_groups() {
        let info = info_body("我的标题", 21);
        let stub = spawn_stub(&[
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{"room_id":5440}}"#,
            ),
            (200, "application/json", info.as_str()),
            (
                200,
                "application/json",
                r#"{"code":0,"data":{"now":1700000000}}"#,
            ),
            (
                200,
                "application/json",
                r#"{"code":0,"data":{"build":8191,"curr_version":"8.19.1"}}"#,
            ),
            (
                200,
                "application/json",
                r#"{"code":0,"data":{"rtmp":{"addr":"rtmp://live-push.example/live/","code":"MAIN"},"protocols":[{"protocol":"rtmp","addr":"rtmp://backup.example/live/","code":"BACKUP"},{"protocol":"srt","addr":"srt://srt.example:1935","code":"SRTCODE"}]}}"#,
            ),
        ]);
        let anchor = anchor_with_stub("go-live", 42, &stub);
        let endpoints = anchor.go_live().await.unwrap();
        assert_eq!(
            endpoints.rtmp,
            Some(StreamEndpoint {
                addr: "rtmp://live-push.example/live/".into(),
                code: "MAIN".into()
            })
        );
        assert_eq!(
            endpoints.rtmp_backup,
            Some(StreamEndpoint {
                addr: "rtmp://backup.example/live/".into(),
                code: "BACKUP".into()
            })
        );
        assert_eq!(
            endpoints.srt,
            Some(StreamEndpoint {
                addr: "srt://srt.example:1935".into(),
                code: "SRTCODE".into()
            })
        );
        assert_eq!(stub.hits(), 5, "三段式：自己直播间 ×2 + a + b + c");
    }

    #[tokio::test]
    async fn go_live_stops_before_the_three_step_flow_when_area_is_missing() {
        // area_id = 0：上游没给分区。
        let info = info_body("我的标题", 0);
        let stub = spawn_stub(&[
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{"room_id":5440}}"#,
            ),
            (200, "application/json", info.as_str()),
        ]);
        let anchor = anchor_with_stub("go-live-no-area", 42, &stub);
        let err = anchor.go_live().await.unwrap_err();
        assert_eq!(err.code(), "UPSTREAM_ERROR");
        assert!(
            err.to_string().contains("分区"),
            "文案要说清是分区缺失：{err}"
        );
        assert_eq!(stub.hits(), 2, "分区缺失时不得再发开播请求");
    }

    #[tokio::test]
    async fn end_live_reports_the_upstream_code() {
        let info = info_body("我的标题", 21);
        let stub = spawn_stub(&[
            (
                200,
                "application/json",
                r#"{"code":0,"message":"0","data":{"room_id":5440}}"#,
            ),
            (200, "application/json", info.as_str()),
            (
                200,
                "application/json",
                r#"{"code":-400,"message":"未开播"}"#,
            ),
        ]);
        let anchor = anchor_with_stub("end-live", 42, &stub);
        let err = anchor.end_live().await.unwrap_err();
        assert_eq!(err.code(), "UPSTREAM_ERROR");
        assert!(err.to_string().contains("-400"));
        assert_eq!(stub.hits(), 3);
    }

    #[tokio::test]
    async fn end_live_without_a_room_is_an_error_not_a_request() {
        let stub = spawn_stub(&[(
            200,
            "application/json",
            r#"{"code":0,"message":"0","data":{}}"#,
        )]);
        let anchor = anchor_with_stub("end-live-no-room", 42, &stub);
        let err = anchor.end_live().await.unwrap_err();
        assert_eq!(err.code(), "UPSTREAM_ERROR");
        assert!(err.to_string().contains("没有开通直播间"), "{err}");
        assert_eq!(stub.hits(), 1, "没有直播间就没有可下播的目标");
    }

    #[test]
    fn missing_endpoint_groups_stay_none() {
        let value = json!({"code": 0, "data": {"rtmp": {"addr": "rtmp://x", "code": "C"}}});
        let endpoints = stream_endpoints(&value);
        assert_eq!(endpoints.rtmp_backup, None);
        assert_eq!(endpoints.srt, None);
        // addr / code 缺一即整组作废，不拿半组冒充成功。
        let half = json!({"code": 0, "data": {"rtmp": {"addr": "rtmp://x"}}});
        assert_eq!(stream_endpoints(&half).rtmp, None);
    }
}
