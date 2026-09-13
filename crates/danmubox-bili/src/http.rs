//! B 站 HTTP 端点：房间解析、`buvid3`、WBI 密钥、`getDanmuInfo`、上游 HTTP 心跳。
//!
//! 对应 `docs/protocol.md` §2.1、§8.2 与 `docs/auth.md` §3、§4、§5。

use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use danmubox_core::{Error, Result, Room};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, COOKIE, REFERER, USER_AGENT};
use reqwest::StatusCode;
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

/// WBI 密钥的缓存时长（`docs/auth.md` §4.3）。
///
/// key 由服务端**按自然日**轮换，30 分钟远短于轮换周期，命中因此不可能跨越轮换点；
/// 而「连发几条弹幕」这种目标场景之间必然命中。
const WBI_KEY_TTL: Duration = Duration::from_secs(30 * 60);

/// 取回来的一份 WBI 密钥 + 它的新鲜度依据。
struct CachedWbiKeys {
    img_key: String,
    sub_key: String,
    fetched_at: Instant,
    /// UTC+8 的自然日（`docs/auth.md` §4.3 的 `fetched_at_day`）。
    ///
    /// 单调时钟在系统休眠期间不前进，只看 `fetched_at` 会把「睡一觉跨天」的旧 key
    /// 当新鲜，所以日期是这里的兜底判据。
    fetched_day: i64,
}

impl CachedWbiKeys {
    fn is_fresh(&self, now: Instant, today: i64) -> bool {
        self.fetched_day == today
            && now
                .checked_duration_since(self.fetched_at)
                .is_some_and(|age| age < WBI_KEY_TTL)
    }
}

/// 进程内共享的 WBI 密钥缓存。
///
/// 桌面端**每次发送都新建 `BiliHttp`**（`apps/desktop` 的 `chat_send` 即如此），
/// 缓存放在实例字段里等于没缓存，所以必须是进程级静态槽位。密钥与账号无关
/// （游客态 `nav` 也下发同一份，`docs/auth.md` §4.2），一个槽位即可。
static WBI_KEY_CACHE: LazyLock<tokio::sync::Mutex<Option<CachedWbiKeys>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

/// B 站 HTTP 客户端。Cookie 只在进程内传递，绝不写日志。
#[derive(Clone)]
pub struct BiliHttp {
    client: reqwest::Client,
    cookie: CookieMode,
    /// `nav` 端点。生产恒为 `EP_NAV`；测试指到本地桩服务器以计数请求。
    nav_url: String,
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
        Ok(Self {
            client,
            cookie,
            nav_url: EP_NAV.to_string(),
        })
    }

    /// 仅测试：把 `nav` 指到本地桩服务器，用于计数请求（生产恒为 `EP_NAV`）。
    #[cfg(test)]
    fn with_nav_url(mut self, url: String) -> Self {
        self.nav_url = url;
        self
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
    ///
    /// 解析失败时带上 HTTP 状态、`content-type` 与响应体开头：上游在风控或 CDN 抽风时会用
    /// **非 JSON 的页面**应答（实测 412 验证页是 `text/html`，见 `docs/protocol.md` A45），
    /// 只报一句 `error decoding response body` 的话，现场没有任何可查的线索。
    ///
    /// **瞬时的非 JSON 应答重试一次**（`attempt == 1` 且状态不是 4xx）：第一次什么都没拿到，
    /// 再问一次即可恢复；4xx 是上游明确的拒绝（例如 412 风控），重试只会白费一次请求、
    /// 还可能让风控升级，因此不重试。
    ///
    /// 本函数只发 **GET**——幂等、只读，重试不会产生副作用，所以重试**不可能重复发弹幕**：
    /// 发弹幕走 [`Self::post_form`]，那里一律不重试。
    pub async fn get_with_cookies(&self, url: &str) -> Result<(Value, Vec<(String, String)>)> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let response = self
                .get(url)
                .send()
                .await
                .map_err(|e| Error::Upstream(format!("请求失败: {e}")))?;
            let status = response.status();
            let content_type = header_text(response.headers(), CONTENT_TYPE);
            let cookies = collect_set_cookies(response.headers());
            let body = response
                .bytes()
                .await
                .map_err(|e| Error::Upstream(format!("读取响应失败: {e}")))?;
            match serde_json::from_slice::<Value>(&body) {
                Ok(value) => return Ok((value, cookies)),
                Err(_) if attempt == 1 && !status.is_client_error() => {
                    tracing::debug!(
                        target: "danmubox_bili::http",
                        url,
                        status = status.as_u16(),
                        "上游返回的不是 JSON，按瞬时故障重试一次"
                    );
                }
                Err(_) => {
                    return Err(Error::Upstream(decode_failure(
                        "GET",
                        url,
                        status,
                        &content_type,
                        &body,
                    )))
                }
            }
        }
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
    ///
    /// 与 [`Self::get_with_cookies`] 同款诊断（状态 / `content-type` / 响应体开头），
    /// 但 **POST 一律不重试**：请求可能已经生效——上游回了页面而不是 JSON，并不能证明它没写进去，
    /// 重试就可能把同一条弹幕发两遍、或把同一个用户禁言两次。
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
        let status = response.status();
        let content_type = header_text(response.headers(), CONTENT_TYPE);
        let raw = response
            .bytes()
            .await
            .map_err(|e| Error::Upstream(format!("读取响应失败: {e}")))?;
        serde_json::from_slice::<Value>(&raw)
            .map_err(|_| Error::Upstream(decode_failure("POST", url, status, &content_type, &raw)))
    }

    /// WBI 的 `img_key` / `sub_key`，取自 `nav` 的图片文件名。
    ///
    /// **带进程内缓存**（`WBI_KEY_CACHE`，`docs/auth.md` §4.3）：密钥按自然日轮换，
    /// 缓存 TTL 30 分钟，因此「连发弹幕」不再每条都重打一次 `nav`。
    ///
    /// 取不到时把错误原样交给调用方，**缓存槽位保持不动**，下一次调用照旧重试——
    /// 缓存只用来省一次访问，绝不让发送因为缓存而失败。
    pub(crate) async fn wbi_keys(&self) -> Result<(String, String)> {
        // 单飞：锁跨一次网络请求，并发到达的调用排队后只会看到新鲜槽位，
        // 不会各打一次 `nav`。
        let mut slot = WBI_KEY_CACHE.lock().await;
        let today = utc8_day();
        if let Some(keys) = slot.as_ref() {
            if keys.is_fresh(Instant::now(), today) {
                tracing::debug!(target: "danmubox_bili::http", "WBI 密钥缓存命中");
                return Ok((keys.img_key.clone(), keys.sub_key.clone()));
            }
        }
        let (img_key, sub_key) = self.fetch_wbi_keys().await?;
        tracing::debug!(target: "danmubox_bili::http", "WBI 密钥已刷新");
        *slot = Some(CachedWbiKeys {
            img_key: img_key.clone(),
            sub_key: sub_key.clone(),
            fetched_at: Instant::now(),
            fetched_day: today,
        });
        Ok((img_key, sub_key))
    }

    /// 无条件向 `nav` 取一次密钥；缓存读写由 [`Self::wbi_keys`] 负责。
    async fn fetch_wbi_keys(&self) -> Result<(String, String)> {
        let value = self
            .get(&self.nav_url)
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

/// UTC+8 的自然日序号（`docs/auth.md` §4.3 的 `fetched_at_day`）。
///
/// 用日期而非单调时钟兜底：系统休眠期间 `Instant` 不前进，只靠它会把跨天的旧 key 当新鲜。
fn utc8_day() -> i64 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    ((seconds + 8 * 3600) / 86_400) as i64
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    headers.insert(REFERER, HeaderValue::from_static(REFERER_LIVE));
    headers
}

/// 疑似凭据的键名：凭据文件的字段，加上上游下发过的会话令牌。
///
/// 错误信息里只放响应体的开头，但「上游把请求原样回显」在风控页上并非不可能，
/// 所以这些键的值必须在出门之前被抹掉（`AGENT.md` §8）。
const SECRET_KEYS: [&str; 7] = [
    "dedeuserid__ckmd5",
    "dedeuserid",
    "sessdata",
    "bili_jct",
    "csrf_token",
    "qrcode_key",
    "csrf",
];

/// 值的结束符（属于值之外的第一个字符就能收尾）。
fn is_value_end(ch: char) -> bool {
    matches!(
        ch,
        '&' | ';' | ',' | '"' | '\'' | '}' | ')' | '<' | ' ' | '\t' | '\r' | '\n'
    )
}

/// 在**小写副本** `lowered` 里找 `from` 之后最靠前的一个凭据键名 → （位置, 键名）。
///
/// 同一位置命中多个键名时取**最长**的那个：`dedeuserid__ckmd5` 与 `csrf_token` 分别把
/// `dedeuserid` 与 `csrf` 包在里面，先匹配短的会把键名截成两段。
fn next_secret_key(lowered: &str, from: usize) -> Option<(usize, &'static str)> {
    SECRET_KEYS
        .iter()
        .filter_map(|key| {
            lowered[from..]
                .find(key)
                .map(|offset| (from + offset, *key))
        })
        .min_by_key(|(at, key)| (*at, std::cmp::Reverse(key.len())))
}

/// 把 `key=value` / `"key":"value"` 里的值抹成 `***`，其余文本原样保留。
///
/// 只认「键名 + 分隔符 + 值」三种成分齐全的位置：上游原话 `CSRF 校验失败` 里的键名之后
/// 没有分隔符，不能被改写——错误信息里保留上游原话才有诊断价值。
fn redact_secrets(text: &str) -> String {
    let lowered = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut search = 0;
    while let Some((at, key)) = next_secret_key(&lowered, search) {
        let after_key = at + key.len();
        match secret_value(&text[after_key..]) {
            Some((value_at, value_len)) => {
                let value_start = after_key + value_at;
                let value_end = value_start + value_len;
                out.push_str(&text[copied..value_start]);
                out.push_str("***");
                copied = value_end;
                search = value_end;
            }
            // 只是键名本身（例如上游原话里出现 `csrf` 一词）：原样保留，从键名之后继续找。
            None => search = after_key,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// 键名之后若跟着「分隔符 + 值」→ 返回（分隔符长度, 值长度）。
///
/// 分隔符是 `=` / `:` / 引号，允许中间夹空格（`"csrf": "值"`）；值到下一个 `is_value_end`
/// 字符为止。只有键名而没有值 → `None`。
fn secret_value(rest: &str) -> Option<(usize, usize)> {
    let mut delimited = false;
    for (index, ch) in rest.char_indices() {
        match ch {
            '=' | ':' | '"' | '\'' => delimited = true,
            ' ' | '\t' if delimited => {}
            _ => {
                if !delimited || is_value_end(ch) {
                    return None;
                }
                let length = rest[index..]
                    .find(is_value_end)
                    .unwrap_or(rest.len() - index);
                return Some((index, length));
            }
        }
    }
    None
}

/// 响应体开头至多 `limit` 字节的可读文本：丢控制字符、抹疑似凭据，截断时以 `…` 收尾。
///
/// 空体返回 `（空）`——「上游回了 200 但没给身体」和「回了别的页面」是两种故障，
/// 文案里必须能一眼分开。
fn body_head(body: &[u8], limit: usize) -> String {
    let head = &body[..body.len().min(limit)];
    let lossy = String::from_utf8_lossy(head);
    // 切口可能落在多字节字符中间，末尾那个替换符是切出来的，不代表上游内容。
    let text = lossy.trim_end_matches(char::REPLACEMENT_CHARACTER);
    let visible: String = text.chars().filter(|ch| !ch.is_control()).collect();
    let visible = redact_secrets(&visible);
    if visible.is_empty() {
        return "（空）".to_string();
    }
    if body.len() > limit {
        return format!("{visible}…");
    }
    visible
}

/// 响应体不是 JSON 时的错误文案：端点路径、HTTP 状态、`content-type`、响应体开头。
///
/// 端点只取**路径**：查询串里有 `qrcode_key` / `anchor_id` 一类值，请求体（csrf、弹幕原文）
/// 更是绝不能出门（`AGENT.md` §8）。地址解析不出来时连路径都不报，只报「无法解析」。
fn decode_failure(
    method: &str,
    url: &str,
    status: StatusCode,
    content_type: &str,
    body: &[u8],
) -> String {
    let path = url::Url::parse(url)
        .map(|parsed| parsed.path().to_string())
        .unwrap_or_else(|_| "<无法解析的地址>".into());
    format!(
        "{method} {path} 响应不是 JSON：HTTP {status}，content-type={content_type}，响应体前 {} 字节：{}",
        DECODE_BODY_HEAD_BYTES,
        body_head(body, DECODE_BODY_HEAD_BYTES)
    )
}

/// 解码失败文案里回显的响应体长度上限。够看清是 HTML 错误页、验证页还是空体，
/// 又不至于把上游整页塞进错误信息。
const DECODE_BODY_HEAD_BYTES: usize = 128;

/// 响应头的文本值；缺头或非 UTF-8 → `<无>`。
fn header_text(headers: &HeaderMap, name: reqwest::header::HeaderName) -> String {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("<无>")
        .to_string()
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

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

    /// 合成（非真实）的 `nav` 响应：两个 32 位十六进制 key，形状与实测一致。
    const NAV_OK: &str = r#"{"code":0,"data":{"wbi_img":{"img_url":"https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png","sub_url":"https://i0.hdslb.com/bfs/wbi/fedcba9876543210fedcba9876543210.png"}}}"#;

    /// 缓存是**进程级**静态槽位（`WBI_KEY_CACHE`），碰它的测试必须串行，
    /// 否则互相清空 / 互相喂桩数据会互相打架。
    ///
    /// 用异步锁而不是 `std::sync::Mutex`：这几个测试要跨 `await` 持锁，
    /// 持 `std` 的锁等 IO 会被 clippy 的 `await_holding_lock` 拦下（也确实会阻塞运行时线程）。
    static CACHE_TEST_LOCK: LazyLock<tokio::sync::Mutex<()>> =
        LazyLock::new(|| tokio::sync::Mutex::new(()));

    /// 本地桩服务器：按顺序回放 `responses`（最后一份复用），统计收到的请求数。
    ///
    /// 每份响应是「状态码、`content-type`、响应体」；返回**基址**（调用方自己拼路径，
    /// 因此任意端点都能桩住）与命中计数。
    fn spawn_stub(responses: &[(u16, &str, &str)], delay: Duration) -> (String, Arc<AtomicUsize>) {
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
                let mut reader =
                    std::io::BufReader::new(stream.try_clone().expect("克隆桩连接"));
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
                std::thread::sleep(delay);
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        (format!("http://{address}"), hits)
    }

    /// 本地 `nav` 桩服务器：按顺序回放 `bodies`（最后一份复用），统计收到的请求数。
    fn spawn_nav_stub(bodies: &[&str], delay: Duration) -> (String, Arc<AtomicUsize>) {
        let responses: Vec<(u16, &str, &str)> = bodies
            .iter()
            .map(|body| (200u16, "application/json", *body))
            .collect();
        let (base, hits) = spawn_stub(&responses, delay);
        (format!("{base}/nav"), hits)
    }

    async fn reset_wbi_cache() {
        *WBI_KEY_CACHE.lock().await = None;
    }

    /// 回归护栏（`docs/auth.md` §4.3）：连续两次取 WBI 密钥只该打一次 `nav`。
    ///
    /// 改前 `wbi_keys` 每次无条件请求 `nav`，本测试会数到 2 次——发送链路上那
    /// ~130ms 的结构性浪费就是这么来的。加回来等于把这条护栏拆了，测试立刻变红。
    #[tokio::test]
    async fn consecutive_wbi_key_reads_hit_nav_once() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (nav_url, hits) = spawn_nav_stub(&[NAV_OK], Duration::ZERO);
        reset_wbi_cache().await;
        let http = BiliHttp::new().unwrap().with_nav_url(nav_url);

        let first = http.wbi_keys().await.expect("第一次取 key");
        let second = http.wbi_keys().await.expect("第二次取 key");

        assert_eq!(first, second, "两次取到同一份密钥");
        assert_eq!(first.0, "0123456789abcdef0123456789abcdef");
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "连续两次取 key 只该打一次 nav"
        );
    }

    /// 并发安全：多条发送同时到达时，`nav` 也只该被打一次（单飞），不同时打多个。
    #[tokio::test]
    async fn concurrent_wbi_key_reads_hit_nav_once() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (nav_url, hits) = spawn_nav_stub(&[NAV_OK], Duration::from_millis(80));
        reset_wbi_cache().await;
        let http = BiliHttp::new().unwrap().with_nav_url(nav_url);

        let (first, second, third, fourth) = tokio::join!(
            http.wbi_keys(),
            http.wbi_keys(),
            http.wbi_keys(),
            http.wbi_keys()
        );

        for keys in [&first, &second, &third, &fourth] {
            assert!(keys.is_ok(), "并发取 key 都该成功：{keys:?}");
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1, "并发取 key 只该打一次 nav");
    }

    /// 失败降级：`nav` 取不到时错误照旧上抛，且**不写缓存**——下一次调用重新请求，
    /// 上游恢复后自动回到正常，不需要重启进程。
    #[tokio::test]
    async fn failed_nav_fetch_is_not_cached_and_next_call_retries() {
        let _guard = CACHE_TEST_LOCK.lock().await;
        let (nav_url, hits) = spawn_nav_stub(&[r#"{"code":0,"data":{}}"#, NAV_OK], Duration::ZERO);
        reset_wbi_cache().await;
        let http = BiliHttp::new().unwrap().with_nav_url(nav_url);

        let error = http.wbi_keys().await.expect_err("nav 没有 wbi_img 时必须报错");
        assert_eq!(error.code(), "UPSTREAM_ERROR");
        let recovered = http.wbi_keys().await.expect("上游恢复后重新取到 key");
        assert_eq!(recovered.0, "0123456789abcdef0123456789abcdef");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "失败的那次不许被缓存");
    }

    /// 轮换兜底（`docs/auth.md` §4.3）：TTL 到点、或跨 UTC+8 自然日，缓存都必须失效。
    #[test]
    fn cached_keys_go_stale_on_ttl_and_day_rollover() {
        let now = Instant::now();
        let keys = CachedWbiKeys {
            img_key: "a".into(),
            sub_key: "b".into(),
            fetched_at: now,
            fetched_day: 100,
        };

        assert!(keys.is_fresh(now, 100), "刚取回来必须算新鲜");
        assert!(
            keys.is_fresh(now + WBI_KEY_TTL - Duration::from_millis(1), 100),
            "TTL 之内仍算新鲜"
        );
        assert!(!keys.is_fresh(now + WBI_KEY_TTL, 100), "TTL 到点必须重取");
        assert!(!keys.is_fresh(now, 101), "跨自然日必须重取");
    }

    /// 回归护栏（issue 2609132259 #6）：上游用**非 JSON 的页面**应答时（实测 412 风控页是
    /// `text/html`，见 `docs/protocol.md` A45），错误里必须能看出「哪个端点、什么状态、
    /// 什么内容」——只报一句 `error decoding response body` 等于没有线索。
    #[tokio::test]
    async fn non_json_get_names_endpoint_status_and_body_head() {
        let (base, hits) = spawn_stub(
            &[(
                412,
                "text/html",
                "<!DOCTYPE html>\n<html lang=\"zh-cn\"><head><title>出错啦! - bilibili.com</title>",
            )],
            Duration::ZERO,
        );
        let url = format!(
            "{base}/xlive/web-ucenter/v1/banned/GetSilentUserList?room_id=5440&csrf=SECRET"
        );
        let error = BiliHttp::new()
            .unwrap()
            .get_with_cookies(&url)
            .await
            .expect_err("412 的 HTML 页面不是 JSON");

        assert_eq!(error.code(), "UPSTREAM_ERROR");
        let text = error.to_string();
        assert!(
            text.starts_with("upstream error: "),
            "前缀语义不许变：{text}"
        );
        assert!(
            text.contains("GET /xlive/web-ucenter/v1/banned/GetSilentUserList"),
            "{text}"
        );
        assert!(text.contains("HTTP 412"), "{text}");
        assert!(text.contains("content-type=text/html"), "{text}");
        assert!(
            text.contains("<!DOCTYPE html>"),
            "响应体开头要给出来：{text}"
        );
        assert!(
            !text.contains("room_id=5440") && !text.contains("SECRET"),
            "查询串不许进错误信息：{text}"
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "4xx 是上游的明确拒绝，重试没有意义"
        );
    }

    /// 瞬时的非 JSON（CDN 错误页那类 5xx 应答）重试一次就该恢复。
    #[tokio::test]
    async fn transient_non_json_get_retries_once_then_succeeds() {
        let (base, hits) = spawn_stub(
            &[
                (502, "text/html", "<html>502 Bad Gateway</html>"),
                (200, "application/json", r#"{"code":0,"data":{}}"#),
            ],
            Duration::ZERO,
        );
        let (value, _) = BiliHttp::new()
            .unwrap()
            .get_with_cookies(&format!("{base}/x"))
            .await
            .expect("重试一次后应当成功");

        assert_eq!(value["code"], 0);
        assert_eq!(hits.load(Ordering::SeqCst), 2, "只重试一次");
    }

    /// 重试有上限：两次都不是 JSON 就报错，不会没完没了地打上游。
    #[tokio::test]
    async fn repeated_non_json_get_gives_up_after_one_retry() {
        let (base, hits) = spawn_stub(&[(502, "text/html", "<html>502</html>")], Duration::ZERO);
        let error = BiliHttp::new()
            .unwrap()
            .get_with_cookies(&format!("{base}/x"))
            .await
            .expect_err("两次都不是 JSON");

        assert_eq!(error.code(), "UPSTREAM_ERROR");
        assert!(error.to_string().contains("HTTP 502"), "{error}");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "最多两次");
    }

    /// POST **一律不重试**：请求可能已经生效，重试就会重复发弹幕 / 重复禁言。
    /// 同一测试顺带护栏回显内容——响应体里夹带的凭据值必须在进错误信息前被抹掉。
    #[tokio::test]
    async fn post_form_never_retries_and_redacts_reflected_credentials() {
        let (base, hits) = spawn_stub(
            &[(
                412,
                "text/html",
                "<html>csrf=REAL-SECRET&room_id=5440</html>",
            )],
            Duration::ZERO,
        );
        let error = BiliHttp::new()
            .unwrap()
            .post_form(
                &format!("{base}/xlive/web-ucenter/v1/banned/GetSilentUserList"),
                "room_id=5440&csrf=REAL-SECRET",
            )
            .await
            .expect_err("HTML 页面不是 JSON");

        assert_eq!(error.code(), "UPSTREAM_ERROR");
        let text = error.to_string();
        assert!(
            text.contains("POST /xlive/web-ucenter/v1/banned/GetSilentUserList"),
            "{text}"
        );
        assert!(
            text.contains("HTTP 412") && text.contains("content-type=text/html"),
            "{text}"
        );
        assert!(text.contains("csrf=***"), "键名后的值必须被抹掉：{text}");
        assert!(!text.contains("REAL-SECRET"), "凭据不许进错误信息：{text}");
        assert_eq!(hits.load(Ordering::SeqCst), 1, "POST 不重试");
    }

    /// 错误信息里的响应体开头：128 字节封顶、控制字符清掉（错误信息是单行日志）、
    /// 空体写明「（空）」——「上游回了空体」与「上游回了别的页面」是两种故障。
    #[test]
    fn body_head_is_bounded_visible_and_marks_empty_or_truncated() {
        assert_eq!(body_head(b"", 128), "（空）");
        assert_eq!(body_head(b"{\"code\":0}\r\n", 128), r#"{"code":0}"#);

        let long = "x".repeat(300);
        let head = body_head(long.as_bytes(), 128);
        assert!(head.ends_with('…'), "截断了就要有标记：{head}");
        assert_eq!(head.trim_end_matches('…').len(), 128, "超出部分不许带上");
    }

    /// 凭据抹除只认「键名 + 分隔符 + 值」三种成分齐全的位置：上游原话 `CSRF 校验失败`
    /// 不许被改写（错误信息里保留上游原话才有诊断价值），而 `key=value` / `"key": "value"`
    /// / 长短键名并存这几种形态都必须抹干净。
    #[test]
    fn redaction_covers_cookie_and_token_shapes_without_touching_prose() {
        assert_eq!(
            redact_secrets("SESSDATA=abc; bili_jct=def&z=1"),
            "SESSDATA=***; bili_jct=***&z=1"
        );
        assert_eq!(
            redact_secrets(r#"{"csrf_token":"tok","k":"v"}"#),
            r#"{"csrf_token":"***","k":"v"}"#
        );
        assert_eq!(redact_secrets(r#"{"csrf": "tok"}"#), r#"{"csrf": "***"}"#);
        assert_eq!(redact_secrets("CSRF 校验失败"), "CSRF 校验失败");
        assert_eq!(
            redact_secrets("dedeuserid__ckmd5=zz"),
            "dedeuserid__ckmd5=***",
            "长键名不许被短键名截断"
        );
    }
}
