//! B 站 HTTP 端点：房间解析、`buvid3`、WBI 密钥、`getDanmuInfo`、上游 HTTP 心跳。
//!
//! 对应 `docs/protocol.md` §2.1、§8.2 与 `docs/auth.md` §3、§4、§5。

use std::time::{SystemTime, UNIX_EPOCH};

use danmubox_core::{Error, Result, Room};
use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;

use crate::wbi;

pub(crate) const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
pub(crate) const REFERER_LIVE: &str = "https://live.bilibili.com/";

const EP_FINGER_SPI: &str = "https://api.bilibili.com/x/frontend/finger/spi";
const EP_NAV: &str = "https://api.bilibili.com/x/web-interface/nav";
const EP_ROOM_PLAY_INFO: &str =
    "https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomPlayInfo";
/// 主播昵称与直播间标题的来源。
///
/// `getRoomPlayInfo` **没有**这两个字段（见 `map_room_play_info` 的实测说明），
/// 名字只能另外问一次；同理它的 `data.room_info.short_id` 只有本接口有，
/// 所以两个接口都留着，不是重复调用。
const EP_ROOM_H5_INFO: &str =
    "https://api.live.bilibili.com/xlive/web-room/v1/index/getH5InfoByRoom";
const EP_DANMU_INFO: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
const EP_WEB_HEARTBEAT: &str =
    "https://live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat";
/// 扫码登录：生成二维码。
pub const EP_QR_GENERATE: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
/// 扫码登录：轮询扫码状态。
pub const EP_QR_POLL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";

/// 从响应头收集 `Set-Cookie` 的键值对（只取第一个 `=` 之前作为名）。
fn collect_set_cookies(headers: &reqwest::header::HeaderMap) -> Vec<(String, String)> {
    headers
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|raw| {
            let pair = raw.split(';').next()?.trim();
            let (name, value) = pair.split_once('=')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

/// `getDanmuInfo` 的结果：长连接票据与候选地址。
#[derive(Debug, Clone)]
pub struct DanmuInfo {
    pub token: String,
    pub hosts: Vec<String>,
}

/// `nav` 求证出来的账号身份：`data.mid` / `data.uname` / `data.face`。
///
/// 这是账号列表与「当前登录的是谁」的唯一身份来源——凭据文件里只有
/// `DedeUserID`（uid）与 Cookie，昵称和头像必须问上游要。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NavIdentity {
    pub uid: i64,
    pub nickname: String,
    pub face: String,
}

/// Cookie 来源。`Store` 让请求实时读取当前账号，
/// 因此切换账号后无需重建客户端。
#[derive(Clone)]
pub enum CookieMode {
    Guest,
    Fixed(String),
    Store(std::sync::Arc<danmubox_core::ConfigStore>),
}

/// B 站 HTTP 客户端。Cookie 只在进程内传递，绝不写日志。
#[derive(Clone)]
pub struct BiliHttp {
    client: reqwest::Client,
    cookie: CookieMode,
}

impl BiliHttp {
    pub fn new() -> Result<Self> {
        Self::with_cookie(None)
    }

    pub fn with_cookie(cookie: Option<String>) -> Result<Self> {
        let mode = match cookie {
            Some(value) if !value.is_empty() => CookieMode::Fixed(value),
            _ => CookieMode::Guest,
        };
        Self::with_mode(mode)
    }

    /// 凭据来自凭据文件：登录态与游客态由文件内容决定。
    pub fn with_store(store: std::sync::Arc<danmubox_core::ConfigStore>) -> Result<Self> {
        Self::with_mode(CookieMode::Store(store))
    }

    fn with_mode(cookie: CookieMode) -> Result<Self> {
        let client = reqwest::Client::builder()
            .default_headers(default_headers())
            .timeout(std::time::Duration::from_secs(15))
            // 心跳间隔 60s，若让空闲连接存活到下一次调用就会被上游回收的连接坑到；
            // 30s 的池内空闲上限保证心跳总是新建连接（见 `web_heartbeat` 的实测说明）。
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| Error::Internal(format!("build http client: {e}")))?;
        Ok(Self { client, cookie })
    }

    fn current_cookie(&self) -> Option<String> {
        match &self.cookie {
            CookieMode::Guest => None,
            CookieMode::Fixed(value) => Some(value.clone()),
            CookieMode::Store(store) => store.cookie_header(),
        }
    }

    fn get(&self, url: &str) -> reqwest::RequestBuilder {
        self.get_with_cookie(url, None)
    }

    /// `cookie` 显式给出时用它，否则用客户端配置的 Cookie 来源。
    ///
    /// 列多个账号时必须能给**每个账号**单独传 Cookie：客户端只有一个
    /// `ConfigStore` 来源（当前账号），拿它去求证别的账号只会得到同一个身份。
    fn get_with_cookie(&self, url: &str, cookie: Option<String>) -> reqwest::RequestBuilder {
        // 只记 URL，不记请求头与 body：凭据从不进日志。
        tracing::debug!(target: "danmubox_bili::http", method = "GET", url, "上游请求");
        let mut req = self.client.get(url);
        if let Some(cookie) = cookie
            .filter(|value| !value.is_empty())
            .or_else(|| self.current_cookie())
        {
            req = req.header(COOKIE, cookie);
        }
        req
    }

    /// GET 并同时取回 JSON 与 `Set-Cookie`（扫码轮询需要读回凭据）。
    pub async fn get_with_cookies(&self, url: &str) -> Result<(Value, Vec<(String, String)>)> {
        let response = self
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("请求失败: {e}")))?;
        let cookies = collect_set_cookies(response.headers());
        let value = response
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("响应解析失败: {e}")))?;
        Ok((value, cookies))
    }

    /// `buvid3` / `buvid4`：`getDanmuInfo` 的必需 Cookie。
    pub async fn buvid(&self) -> Result<(String, String)> {
        let value = self
            .get(EP_FINGER_SPI)
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("finger/spi: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("finger/spi decode: {e}")))?;
        require_ok(&value, "finger/spi")?;
        let data = value.get("data").unwrap_or(&Value::Null);
        let buvid3 = data.get("b_3").and_then(Value::as_str).unwrap_or_default();
        let buvid4 = data.get("b_4").and_then(Value::as_str).unwrap_or_default();
        if buvid3.is_empty() {
            return Err(Error::Upstream("finger/spi 未返回 b_3".into()));
        }
        Ok((buvid3.to_string(), buvid4.to_string()))
    }

    /// 房间号 / 短号 → 房间元信息（`docs/contract.md` §6）。
    pub async fn room_play_info(&self, input: &str) -> Result<Room> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("room_id", &normalize_room_input(input)?)
            .finish();
        let value = self
            .get(&format!("{EP_ROOM_PLAY_INFO}?{query}"))
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("getRoomPlayInfo: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("getRoomPlayInfo decode: {e}")))?;

        if value.get("code").and_then(Value::as_i64) != Some(0) {
            return Err(Error::RoomNotFound(format!(
                "输入 `{input}` 未解析出房间（上游 code={}）",
                value.get("code").and_then(Value::as_i64).unwrap_or(-1)
            )));
        }

        let data = value.get("data").unwrap_or(&Value::Null);
        // 名字与标题不在上面这个响应里，得再问一次 `getH5InfoByRoom`（见 `map_room_play_info`）。
        // 这一跳是**锦上添花**：拿不到就留空串，界面自己回落——绝不让登记房间失败。
        let room_id = data.get("room_id").and_then(Value::as_i64).unwrap_or(0);
        let h5 = if room_id == 0 {
            Value::Null
        } else {
            match self.room_h5_info(room_id).await {
                Ok(value) => value,
                Err(e) => {
                    tracing::debug!(
                        target: "danmubox_bili::http",
                        room_id,
                        error = %e,
                        "getH5InfoByRoom 失败，昵称与标题留空（界面回落到标题 / 房间号）"
                    );
                    Value::Null
                }
            }
        };
        map_room_play_info(data, h5.get("data").unwrap_or(&Value::Null), input)
    }

    /// 房间名与主播昵称：`getH5InfoByRoom` 的原始响应（`map_room_play_info` 只读它的 `data`）。
    async fn room_h5_info(&self, room_id: i64) -> Result<Value> {
        let value = self
            .get(&format!("{EP_ROOM_H5_INFO}?room_id={room_id}"))
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("getH5InfoByRoom: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("getH5InfoByRoom decode: {e}")))?;
        require_ok(&value, "getH5InfoByRoom")?;
        Ok(value)
    }

    /// 取长连接票据与候选地址。游客态同样需要 `buvid` 与 WBI 签名。
    pub async fn danmu_info(&self, room_id: i64, buvid3: &str) -> Result<DanmuInfo> {
        let (img_key, sub_key) = self.wbi_keys().await?;
        let mixin = wbi::mixin_key(&img_key, &sub_key);

        let params = vec![
            ("id".to_string(), room_id.to_string()),
            ("type".to_string(), "0".to_string()),
            ("web_location".to_string(), "444.8".to_string()),
            ("wts".to_string(), unix_seconds().to_string()),
        ];
        let query = wbi::signed_query(&params, &mixin);

        let value = self
            .get(&format!("{EP_DANMU_INFO}?{query}"))
            .header(COOKIE, format!("buvid3={buvid3}"))
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("getDanmuInfo: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("getDanmuInfo decode: {e}")))?;

        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            // -352 是签名/风控失败，与凭据失效区分（`docs/auth.md` §9.1）。
            return Err(Error::Upstream(format!("getDanmuInfo code={code}")));
        }

        let data = value.get("data").unwrap_or(&Value::Null);
        let token = data
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let hosts = data
            .get("host_list")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|h| h.get("host").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if token.is_empty() || hosts.is_empty() {
            return Err(Error::Upstream(
                "getDanmuInfo 缺少 token 或 host_list".into(),
            ));
        }
        Ok(DanmuInfo { token, hosts })
    }

    /// 上游 HTTP 心跳：每 60 秒一次，缺它长连接会被判死（`docs/protocol.md` §8.2）。
    ///
    /// 实测（2026-09-11，20 分钟长连）：该端点会出现**传输层**失败，典型成因是
    /// 空闲连接被上游回收后被连接池复用。因此这里做两件事：
    /// 缩短空闲连接存活时间（心跳间隔 60s > 30s，池内连接不会留到下一次），
    /// 以及失败后**重试一次**。两者都只针对传输层；业务 code 非 0 仍按错误上报。
    pub async fn web_heartbeat(&self, room_id: i64) -> Result<()> {
        use base64::Engine as _;
        let hb = base64::engine::general_purpose::STANDARD.encode(format!("60|{room_id}|1|0"));
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("pf", "web")
            .append_pair("hb", &hb)
            .finish();
        let url = format!("{EP_WEB_HEARTBEAT}?{query}");

        match self.heartbeat_once(&url).await {
            Ok(()) => Ok(()),
            Err(first) => {
                tracing::debug!(%first, "HTTP 心跳首次失败，重试一次");
                self.heartbeat_once(&url).await.map_err(|second| {
                    Error::Upstream(format!("webHeartBeat 重试后仍失败: {second}"))
                })
            }
        }
    }

    async fn heartbeat_once(&self, url: &str) -> Result<()> {
        let value = self
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("webHeartBeat: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("webHeartBeat decode: {e}")))?;
        require_ok(&value, "webHeartBeat")
    }

    /// 用指定 Cookie 向 `nav` 求证身份（`data.mid` / `data.uname` / `data.face`）。
    ///
    /// `cookie` 为 `None` = 用客户端配置的 Cookie 来源（`ConfigStore` 的当前账号）；
    /// 显式给出时用它——`accounts_list` 要一个一个账号分别求证。
    ///
    /// 上游 `code != 0`（未登录，典型是 `-101`）或取不到昵称 → `None`；
    /// 传输 / 解析失败 → `Err`。调用方按「未登录」与「没问到」区别对待：
    /// 前者是凭据失效，后者不该改变本地结论。
    pub async fn nav_identity(&self, cookie: Option<&str>) -> Result<Option<NavIdentity>> {
        let value = self
            .get_with_cookie(EP_NAV, cookie.map(str::to_string))
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("nav: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("nav decode: {e}")))?;
        if value.get("code").and_then(Value::as_i64) != Some(0) {
            return Ok(None);
        }
        let data = value.get("data").unwrap_or(&Value::Null);
        let nickname = data
            .get("uname")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if nickname.is_empty() {
            // 已登录却连昵称都没有：按未登录处理，不臆造身份。
            return Ok(None);
        }
        Ok(Some(NavIdentity {
            uid: data.get("mid").and_then(Value::as_i64).unwrap_or(0),
            nickname: nickname.to_string(),
            face: data
                .get("face")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }))
    }

    /// POST 表单。`body` 必须已是签名后的查询串（含 `w_rid`）。
    pub async fn post_form(&self, url: &str, body: &str) -> Result<Value> {
        // body 里含 csrf 与弹幕原文，一律不记；只记目标地址。
        tracing::debug!(target: "danmubox_bili::http", method = "POST", url, "上游请求");
        let mut request = self.client.post(url).header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        );
        if let Some(cookie) = self.current_cookie() {
            request = request.header(COOKIE, cookie);
        }
        let response = request
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("请求失败: {e}")))?;
        response
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("响应解析失败: {e}")))
    }

    /// WBI 的 `img_key` / `sub_key`，取自 `nav` 的图片文件名。
    pub(crate) async fn wbi_keys(&self) -> Result<(String, String)> {
        let value = self
            .get(EP_NAV)
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("nav: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("nav decode: {e}")))?;

        // 未登录时 nav 的 code 是 -101，但 wbi_img 仍然下发。
        let img = value
            .pointer("/data/wbi_img/img_url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let sub = value
            .pointer("/data/wbi_img/sub_url")
            .and_then(Value::as_str)
            .unwrap_or_default();

        let img_key = stem(img);
        let sub_key = stem(sub);
        if img_key.is_empty() || sub_key.is_empty() {
            return Err(Error::Upstream("nav 未返回 wbi_img".into()));
        }
        Ok((img_key, sub_key))
    }
}

/// 取 URL 文件名去掉扩展名的部分作为 WBI key。
fn stem(url: &str) -> String {
    url.rsplit('/')
        .next()
        .unwrap_or_default()
        .split('.')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    headers.insert(REFERER, HeaderValue::from_static(REFERER_LIVE));
    headers
}

fn require_ok(value: &Value, what: &str) -> Result<()> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => Ok(()),
        other => Err(Error::Upstream(format!("{what} 返回非 0 code={other:?}"))),
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 接受纯数字房间号、短号，或 `https://live.bilibili.com/12345` 形式的链接。
pub fn normalize_room_input(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(Error::BadRequest("房间输入为空".into()));
    }
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Ok(trimmed.to_string());
    }
    let digits: String = trimmed
        .split(['/', '?', '#'])
        .find(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string)
        .unwrap_or_default();
    if digits.is_empty() {
        return Err(Error::BadRequest(format!("无法从 `{input}` 解析房间号")));
    }
    Ok(digits)
}

/// `getRoomPlayInfo` + `getH5InfoByRoom` 的 `data` → `Room`（上游字段名只允许出现在这个函数里）。
///
/// **取证（2026-09-12，只读实测，夹具见 `smoke/fixtures/`）**：主播昵称与直播间标题
/// **不在 `getRoomPlayInfo` 里**——它的 `data` 只有 `room_id` / `short_id` / `uid` /
/// `live_status` / `play_url`（在播、轮播、带 Cookie 与不带 Cookie 都一样，`anchor_info`
/// 与 `title` 键根本不存在）。#17/#18 的原始故障就是把这层字段挂在了它下面：
/// `anchor_uname` 恒为空串，界面于是显示占位词。它们真正的家在
/// `getH5InfoByRoom`：`data.anchor_info.base_info.uname` / `data.room_info.title`。
///
/// 昵称与 `uid` 一样是「有就有、没有就没有」：取不到就留空串，由界面回落到标题、
/// 再回落到「房间 <号>」——不在这里编造，也不用房间号顶替。
fn map_room_play_info(play: &Value, h5: &Value, input: &str) -> Result<Room> {
    let room_id = play.get("room_id").and_then(Value::as_i64).unwrap_or(0);
    if room_id == 0 {
        return Err(Error::RoomNotFound(format!("输入 `{input}` 未解析出房间")));
    }
    Ok(Room {
        room_id,
        short_id: play
            .get("short_id")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        anchor_uid: play.get("uid").and_then(Value::as_i64).unwrap_or(0),
        anchor_uname: h5
            .pointer("/anchor_info/base_info/uname")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: h5
            .pointer("/room_info/title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        live_status: play.get("live_status").and_then(Value::as_i64).unwrap_or(0) as i32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实载荷夹具（只读抓取，2026-09-12）：公开测试房间 `1`（真实 `room_id` 5440）。
    ///
    /// 断言**只能从这两份夹具派生**——手写 JSON 正是 #17/#18 翻车的病因：
    /// 手写的那份「响应」里有 `anchor_info`，真实响应里没有，于是测试全绿而界面显示占位词。
    const ROOM_PLAY_INFO: &str =
        include_str!("../../../apps/desktop/ui/smoke/fixtures/room-play-info.json");
    const ROOM_H5_INFO: &str =
        include_str!("../../../apps/desktop/ui/smoke/fixtures/room-h5-info.json");

    fn fixture(name: &str) -> Value {
        serde_json::from_str(name).expect("夹具必须是合法 JSON")
    }

    #[test]
    fn play_info_carries_no_nickname_or_title() {
        // 病因取证：`getRoomPlayInfo` 的响应里既没有 `anchor_info` 也没有 `title`。
        // 这条断言是回归护栏：谁再把昵称解析挂回这个接口，它会直接失败。
        let play = fixture(ROOM_PLAY_INFO);
        assert!(play.pointer("/data/anchor_info").is_none());
        assert!(play.pointer("/data/title").is_none());
    }

    #[test]
    fn room_info_reads_anchor_nickname() {
        let room = map_room_play_info(
            &fixture(ROOM_PLAY_INFO)["data"],
            &fixture(ROOM_H5_INFO)["data"],
            "1",
        )
        .unwrap();
        assert_eq!(room.room_id, 5440);
        assert_eq!(room.short_id, 1);
        assert_eq!(room.anchor_uid, 9617619);
        assert_eq!(room.anchor_uname, "哔哩哔哩直播");
        assert_eq!(room.title, "PK赏金周赛S3火热开赛！");
        assert_eq!(room.live_status, 2);
    }

    #[test]
    fn room_info_without_anchor_block_leaves_nickname_empty() {
        // 从真实夹具派生的退化形态（显式删掉 `anchor_info`，不是另编一份 JSON）：
        // 上游不给昵称时不许编造，界面自己回落（`docs/ui.md` §2.2）。
        let mut h5 = fixture(ROOM_H5_INFO);
        h5["data"]
            .as_object_mut()
            .expect("夹具 data 是对象")
            .remove("anchor_info");
        let room = map_room_play_info(&fixture(ROOM_PLAY_INFO)["data"], &h5["data"], "1").unwrap();
        assert_eq!(room.anchor_uname, "");
        assert_eq!(room.title, "PK赏金周赛S3火热开赛！");
    }

    #[test]
    fn room_info_without_h5_leaves_nickname_and_title_empty() {
        // `getH5InfoByRoom` 不可达时的形态：两个字段都留空，房间照样登记得出来。
        let room =
            map_room_play_info(&fixture(ROOM_PLAY_INFO)["data"], &Value::Null, "1").unwrap();
        assert_eq!(room.room_id, 5440);
        assert_eq!(room.anchor_uname, "");
        assert_eq!(room.title, "");
    }

    #[test]
    fn room_info_without_room_id_is_not_found() {
        let err =
            map_room_play_info(&serde_json::json!({ "title": "x" }), &Value::Null, "9").unwrap_err();
        assert_eq!(err.code(), "ROOM_NOT_FOUND");
    }

    #[test]
    fn accepts_plain_room_id_and_short_id() {
        assert_eq!(normalize_room_input("2233").unwrap(), "2233");
        assert_eq!(normalize_room_input("  2233 ").unwrap(), "2233");
    }

    #[test]
    fn extracts_room_id_from_urls() {
        assert_eq!(
            normalize_room_input("https://live.bilibili.com/22637261").unwrap(),
            "22637261"
        );
        assert_eq!(
            normalize_room_input("https://live.bilibili.com/22637261?broadcast_type=0").unwrap(),
            "22637261"
        );
        assert_eq!(
            normalize_room_input("live.bilibili.com/123").unwrap(),
            "123"
        );
    }

    #[test]
    fn rejects_unparsable_input() {
        assert_eq!(normalize_room_input("").unwrap_err().code(), "BAD_REQUEST");
        assert_eq!(
            normalize_room_input("https://live.bilibili.com/")
                .unwrap_err()
                .code(),
            "BAD_REQUEST"
        );
    }

    #[test]
    fn stem_strips_path_and_extension() {
        assert_eq!(stem("https://i0.hdslb.com/bfs/wbi/abc123.png"), "abc123");
        assert_eq!(stem(""), "");
    }
}
