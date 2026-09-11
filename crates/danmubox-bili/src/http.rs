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

/// Cookie 来源。`Store` 让请求实时读取当前 profile，
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
        let mut req = self.client.get(url);
        if let Some(cookie) = self.current_cookie() {
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
        let room_id = data.get("room_id").and_then(Value::as_i64).unwrap_or(0);
        if room_id == 0 {
            return Err(Error::RoomNotFound(format!("输入 `{input}` 未解析出房间")));
        }
        Ok(Room {
            room_id,
            short_id: data
                .get("short_id")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            anchor_uid: data.get("uid").and_then(Value::as_i64).unwrap_or(0),
            title: data
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            live_status: data.get("live_status").and_then(Value::as_i64).unwrap_or(0) as i32,
        })
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

    /// 已登录账号的昵称。未登录或上游返回非 0 code 时返回 `None`——
    /// 查昵称失败不应让整个 `session_status` 失败。
    pub async fn account_nickname(&self) -> Result<Option<String>> {
        let value = self
            .get(EP_NAV)
            .send()
            .await
            .map_err(|e| Error::Upstream(format!("nav: {e}")))?
            .json::<Value>()
            .await
            .map_err(|e| Error::Upstream(format!("nav decode: {e}")))?;
        if value.get("code").and_then(Value::as_i64) != Some(0) {
            return Ok(None);
        }
        Ok(value
            .pointer("/data/uname")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_string))
    }

    /// POST 表单。`body` 必须已是签名后的查询串（含 `w_rid`）。
    pub async fn post_form(&self, url: &str, body: &str) -> Result<Value> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
