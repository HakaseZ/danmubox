//! 长连接：认证、双心跳、读循环与重连退避（`docs/protocol.md` §7–§9、§13、§14）。
//!
//! 游客模式也走完整流程：`getDanmuInfo` 拿票据（需要 `buvid` 与 WBI 签名），
//! 认证包带 `uid=0` 与空 `key`。

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use danmubox_core::ports::LiveSource;
use danmubox_core::{
    Cancel, ConnState, Counters, Error, Message, MessageSink, Result, Room, RoomSession,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::cmd;
use crate::http::{BiliHttp, REFERER_LIVE, UA};
use crate::proto::{self, Decoded};

/// 重连退避起点与上限（`docs/contract.md` §4）。
pub const INITIAL_BACKOFF: Duration = Duration::from_secs(5);
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// WS 心跳：首包 60 秒内发出，此后每 30 秒一次。
const WS_HEARTBEAT_FIRST: Duration = Duration::from_secs(60);
const WS_HEARTBEAT_PERIOD: Duration = Duration::from_secs(30);
/// 上游 HTTP 心跳周期。
const HTTP_HEARTBEAT_PERIOD: Duration = Duration::from_secs(60);
/// 会话短于该时长视为「未真正建立」，不重置退避，避免紧循环重连。
const HEALTHY_SESSION: Duration = Duration::from_secs(30);
/// 单个弹幕节点的拨号超时；超时即换下一个节点。
const WS_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// WS 心跳包体：字面量，见 `docs/protocol.md` §8.1。
const HEARTBEAT_BODY: &[u8] = b"[object Object]";

/// 官方 web 客户端进房时用来取「本人在该房间的身份」的端点
/// （`GET`，需 Cookie；实测结论见 `docs/protocol.md` 附录 A38）。
const EP_ROOM_USER: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser";

/// 身份请求的超时。与历史回填同理：它只是给界面做权限前置，
/// 卡住时不能让会话建立停在原地。
const ROOM_USER_TIMEOUT: Duration = Duration::from_millis(2_000);

/// `property.danmu.length` 缺失时的缺省上限，照官方前端的回落（产物里 `t.danmu_length || 20`）。
///
/// 只在**上游没给这一项**时兜底；正常响应里它是按房间下发的真实值（实测 40）。
/// 界面只消费 `RoomSession.danmaku_length`，不重复写死数字。
const DEFAULT_DANMAKU_LENGTH: u32 = 20;

/// `getInfoByUser` 响应 → 本人在该房间的身份（纯函数，便于离线覆盖）。
///
/// 实测字段（2026-09-12，见附录 A38）：
///
/// | 目标 | 路径 |
/// |---|---|
/// | 是否房管 | `data.badge.is_room_admin`（布尔；同层 `admin_level` 亦可，`> 0` 同为房管）|
/// | 我的粉丝牌等级 / 名 | `data.medal.up_medal.level` / `.medal_name`（无牌时为 `null`）|
/// | 我的大航海等级 | `data.uinfo.guard.level` |
/// | 弹幕字数上限 | `data.property.danmu.length`（官方前端读的同一个键，见 `docs/protocol.md` A44）|
///
/// 缺任何一项都按 0 / 空串 / `false` 容错：宁可显示「无牌、非房管」，
/// 也不编造一个身份出来。弹幕长度是唯一有**非零**缺省的一项——
/// 官方前端对缺失回落 `20`，照抄（`DEFAULT_DANMAKU_LENGTH`）。
pub fn parse_room_identity(room_id: i64, value: &Value) -> RoomSession {
    let is_admin = value
        .pointer("/data/badge/is_room_admin")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || value
            .pointer("/data/badge/admin_level")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            > 0;
    // `0` 与缺失同解：都按官方缺省 20 —— 上限 0 会让输入框一个字都打不进去，
    // 而上游正常响应里这一项恒为正数（实测 40）。u32 收窄在这里是安全的：
    // 上游不会下发一个超过 u32 的弹幕字数。
    let danmaku_length = value
        .pointer("/data/property/danmu/length")
        .and_then(Value::as_u64)
        .filter(|length| *length > 0)
        .map_or(DEFAULT_DANMAKU_LENGTH, |length| length as u32);
    RoomSession {
        room_id,
        my_medal_level: value
            .pointer("/data/medal/up_medal/level")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        my_medal_name: value
            .pointer("/data/medal/up_medal/medal_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // 「是否**佩戴**着这块牌」—— 画不画它的唯一判据（弹幕侧同一个判据是 `medal_lit`）。
        // 实测（2026-09-13）：`up_medal` 只说明**持有**（level/medal_name/medal_color），
        // 佩戴与否在同层的 `is_weared` 上。字段缺失按"没戴"：宁可少画一块牌，
        // 也不画出一块别人都看不到的牌（用户报的就是这块幻影牌）。
        my_medal_worn: value
            .pointer("/data/medal/is_weared")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        my_guard_level: value
            .pointer("/data/uinfo/guard/level")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        is_admin,
        danmaku_length,
    }
}

pub struct BiliLive {
    http: BiliHttp,
    counters: Arc<Counters>,
    buvid3: Mutex<Option<String>>,
    /// 有凭据文件时，`buvid3` 优先用配置里的（登录后由上游下发），
    /// 省掉一次 `finger/spi` 请求，也让连接与账号绑定。
    store: Option<Arc<danmubox_core::ConfigStore>>,
}

impl BiliLive {
    pub fn new() -> Result<Self> {
        Self::with_cookie(None)
    }

    /// `cookie` 为完整 Cookie 串；`None` 即游客态。
    pub fn with_cookie(cookie: Option<String>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_cookie(cookie)?,
            counters: Arc::new(Counters::default()),
            buvid3: Mutex::new(None),
            store: None,
        })
    }

    /// 凭据来自凭据文件：登录态与游客态由文件内容决定（`docs/contract.md` §4.1）。
    pub fn with_store(store: Arc<danmubox_core::ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            counters: Arc::new(Counters::default()),
            buvid3: Mutex::new(None),
            store: Some(store),
        })
    }

    pub fn counters(&self) -> Arc<Counters> {
        Arc::clone(&self.counters)
    }

    /// `buvid3` 优先取凭据文件，其次向 `finger/spi` 申请；成功后缓存。
    async fn buvid3(&self) -> Result<String> {
        let mut cached = self.buvid3.lock().await;
        if let Some(value) = cached.as_ref() {
            return Ok(value.clone());
        }
        if let Some(value) = self.store.as_ref().and_then(|store| store.buvid3()) {
            *cached = Some(value.clone());
            return Ok(value);
        }
        let (buvid3, _buvid4) = self.http.buvid().await?;
        *cached = Some(buvid3.clone());
        Ok(buvid3)
    }

    /// 建立一次连接并读到断开为止。返回是否曾认证成功。
    async fn run_once(&self, room_id: i64, sink: &MessageSink, cancel: &Cancel) -> Result<bool> {
        let buvid3 = self.buvid3().await?;
        let info = self.http.danmu_info(room_id, &buvid3).await?;

        // `host_list` 就是候选节点表：逐个尝试，单个节点拨号必须有超时，
        // 否则一个不可达节点会让整条连接无限挂起（实测踩过）。
        let mut last_error: Option<Error> = None;
        let mut connected = None;
        let mut chosen_host = String::new();
        for host in &info.hosts {
            let url = format!("wss://{host}/sub");
            let mut request = url
                .clone()
                .into_client_request()
                .map_err(|e| Error::Upstream(format!("构造 WS 请求失败: {e}")))?;
            {
                let headers = request.headers_mut();
                headers.insert("User-Agent", HeaderValue::from_static(UA));
                headers.insert("Referer", HeaderValue::from_static(REFERER_LIVE));
            }
            tracing::debug!(room_id, host = %host, "尝试连接弹幕服务器");
            match tokio::time::timeout(WS_DIAL_TIMEOUT, tokio_tungstenite::connect_async(request))
                .await
            {
                Ok(Ok((stream, _response))) => {
                    tracing::debug!(room_id, host = %host, "WS 握手完成");
                    chosen_host = host.clone();
                    connected = Some(stream);
                    break;
                }
                Ok(Err(err)) => {
                    tracing::warn!(room_id, host = %host, %err, "节点连接失败，尝试下一个");
                    last_error = Some(Error::Upstream(format!("{host} 连接失败: {err}")));
                }
                Err(_) => {
                    tracing::warn!(
                        room_id,
                        host = %host,
                        timeout_ms = WS_DIAL_TIMEOUT.as_millis() as u64,
                        "节点连接超时，尝试下一个"
                    );
                    last_error = Some(Error::Upstream(format!("{host} 连接超时")));
                }
            }
        }
        let stream = connected.ok_or_else(|| {
            last_error.unwrap_or_else(|| Error::Upstream("host_list 为空".into()))
        })?;
        let (mut write, mut read) = stream.split();

        // 认证包的 uid 必须与换取 token 的账号一致：游客态为 0，登录态为真实 uid。
        // 实测（2026-09-11）：登录后仍发 uid=0 会被上游在握手后立刻 reset。
        let uid = self
            .store
            .as_ref()
            .and_then(|store| store.active())
            .map(|profile| profile.uid())
            .unwrap_or(0);

        // 认证包（op=7，帧头 protover=1，body 里声明想用的载荷版本 3）。
        let auth = serde_json::json!({
            "uid": uid,
            "roomid": room_id,
            "protover": proto::PROTOVER_BROTLI,
            "buvid": buvid3,
            "platform": "web",
            "type": 2,
            "key": info.token,
        });
        // 认证包的 uid 不进日志（`AGENT.md` §8 第 1 条，uid 即 `DedeUserID`）：
        // 「登录态还是游客态」这一条信息由 `logged_in` 承载就够了。
        tracing::debug!(room_id, logged_in = uid != 0, host = %chosen_host, "发送认证包");
        write
            .send(WsMessage::Binary(
                proto::build_packet(
                    proto::OP_VERIFY,
                    proto::PROTOVER_HEARTBEAT,
                    auth.to_string().as_bytes(),
                )
                .into(),
            ))
            .await
            .map_err(|e| Error::Upstream(format!("发送认证包失败: {e}")))?;

        // 本次会话的心跳作用域，任何退出路径都会停掉两个心跳任务。
        let session = Cancel::new();
        let heartbeat_ws = {
            let session = session.clone();
            let mut write = write;
            tokio::spawn(async move {
                let mut first = true;
                loop {
                    let wait = if first {
                        WS_HEARTBEAT_FIRST
                    } else {
                        WS_HEARTBEAT_PERIOD
                    };
                    tokio::select! {
                        _ = session.cancelled() => break,
                        _ = tokio::time::sleep(wait) => {}
                    }
                    if session.is_cancelled() {
                        break;
                    }
                    let packet = proto::build_packet(
                        proto::OP_HEARTBEAT,
                        proto::PROTOVER_HEARTBEAT,
                        HEARTBEAT_BODY,
                    );
                    if write.send(WsMessage::Binary(packet.into())).await.is_err() {
                        break;
                    }
                    first = false;
                }
            })
        };
        let heartbeat_http = {
            let session = session.clone();
            let http = self.http.clone();
            let counters = Arc::clone(&self.counters);
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = session.cancelled() => break,
                        _ = tokio::time::sleep(HTTP_HEARTBEAT_PERIOD) => {}
                    }
                    if session.is_cancelled() {
                        break;
                    }
                    if let Err(err) = http.web_heartbeat(room_id).await {
                        Counters::bump(&counters.heartbeat_failures);
                        tracing::warn!(room_id, %err, "上游 HTTP 心跳失败");
                    }
                }
            })
        };

        let outcome = self.read_loop(room_id, sink, cancel, &mut read).await;

        session.cancel();
        heartbeat_ws.abort();
        heartbeat_http.abort();
        outcome
    }

    async fn read_loop<S>(
        &self,
        room_id: i64,
        sink: &MessageSink,
        cancel: &Cancel,
        read: &mut S,
    ) -> Result<bool>
    where
        S: futures_util::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        let mut verified = false;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return Ok(verified),
                incoming = read.next() => {
                    match incoming {
                        None => return Err(Error::Upstream("连接已被对端关闭".into())),
                        Some(Err(err)) => return Err(Error::Upstream(format!("读取失败: {err}"))),
                        Some(Ok(WsMessage::Binary(bytes))) => {
                            let mut decoded = Vec::new();
                            proto::decode_stream(&bytes, &self.counters, &mut decoded);
                            for item in decoded {
                                match item {
                                    Decoded::Business(value) => {
                                        // 观众数走单独支路：它不进会话缓冲，只更新界面数字。
                                        match cmd::dispatch(room_id, &value, &self.counters) {
                                            Some(cmd::Dispatch::Message(message)) => {
                                                sink.publish_message(message)
                                            }
                                            Some(cmd::Dispatch::RoomStats {
                                                online,
                                                watched,
                                            }) => sink.publish_room_stats(room_id, online, watched),
                                            None => {}
                                        }
                                    }
                                    Decoded::Popularity(value) => {
                                        // `op=3` 心跳回应携带的是人气值（与 `POPULARITY_CHANGE`
                                        // 同口径，见 A23）。界面不再展示人气值，因此只记日志。
                                        tracing::debug!(room_id, popularity = value, "人气值");
                                    }
                                    Decoded::VerifyReply(value) => {
                                        let code = value
                                            .get("code")
                                            .and_then(Value::as_i64)
                                            .unwrap_or(-1);
                                        if code == 0 {
                                            verified = true;
                                            sink.publish_status(
                                                room_id,
                                                ConnState::Connected,
                                                "verified",
                                            );
                                        } else {
                                            // 未知 code 只记录原始值，不赋予含义（§13.4）。
                                            return Err(Error::Upstream(format!(
                                                "认证失败 code={code}"
                                            )));
                                        }
                                    }
                                    Decoded::Other(op) => {
                                        tracing::trace!(room_id, op, "其他包");
                                    }
                                }
                            }
                        }
                        Some(Ok(WsMessage::Text(text))) => {
                            tracing::debug!(room_id, len = text.len(), "收到文本帧");
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            return Err(Error::Upstream(format!("对端发送关闭帧: {frame:?}")));
                        }
                        Some(Ok(_)) => {}
                    }
                }
            }
        }
    }
}

#[async_trait]
impl LiveSource for BiliLive {
    async fn recent(&self, room_id: i64) -> Result<Vec<Message>> {
        crate::history::fetch_history(&self.http, room_id).await
    }

    async fn resolve_room(&self, input: &str) -> Result<Room> {
        self.http.room_play_info(input).await
    }

    async fn room_identity(&self, room_id: i64) -> Result<RoomSession> {
        // 游客态没有「本人身份」可言：不发请求，直接给全零身份。
        if !self.store.as_ref().map(|s| s.is_logged_in()).unwrap_or(false) {
            return Ok(RoomSession {
                room_id,
                ..Default::default()
            });
        }

        // 与历史回填同样的护栏：身份是「锦上添花」，卡住时不能让会话停在原地。
        let url = format!("{EP_ROOM_USER}?room_id={room_id}&from=0&not_mock_enter_effect=0");
        let request = self.http.get_with_cookies(&url);
        let (value, _) = tokio::time::timeout(ROOM_USER_TIMEOUT, request)
            .await
            .map_err(|_| {
                Error::Upstream(format!(
                    "getInfoByUser 超时（{}ms）",
                    ROOM_USER_TIMEOUT.as_millis()
                ))
            })??;

        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            // 未实测的码集合：原样带回，不赋予语义。
            return Err(Error::Upstream(format!("getInfoByUser code={code}")));
        }
        Ok(parse_room_identity(room_id, &value))
    }

    async fn stream(&self, room_id: i64, sink: MessageSink, cancel: Cancel) -> Result<()> {
        let mut backoff = INITIAL_BACKOFF;
        loop {
            if cancel.is_cancelled() {
                return Ok(());
            }
            sink.publish_status(room_id, ConnState::Connecting, "连接中");

            let started = Instant::now();
            let outcome = self.run_once(room_id, &sink, &cancel).await;
            if cancel.is_cancelled() {
                return Ok(());
            }

            // 会话活过 `HEALTHY_SESSION` 就算「健康」：无论它是被取消收场还是**掉线**
            // 收场，退避都回到起点。旧实现把重置写在 `Ok(true)` 这一支里——那是「被取消」
            // 的收场；掉线走的是 `Err` 分支，于是同一天里每次掉线都把退避翻倍，实测日志
            // 里 `5s→10s→20s→40s→60s` 单调爬升、**从不回落**：断连后要干等一分钟才重连，
            // 用户看到的就是「断了就回不来了」。
            let healthy = started.elapsed() >= HEALTHY_SESSION;
            if let Err(err) = outcome {
                sink.publish_status(room_id, ConnState::Disconnected, err.to_string());
                tracing::warn!(
                    room_id,
                    %err,
                    backoff_ms = backoff.as_millis() as u64,
                    "连接中断，准备重连"
                );
            }

            backoff = wait_after_break(backoff, healthy);
            let wait = jitter(backoff);
            tokio::select! {
                _ = cancel.cancelled() => return Ok(()),
                _ = tokio::time::sleep(wait) => {}
            }
            backoff = next_backoff(backoff);
        }
    }
}

/// 退避递增，60 秒封顶。
pub fn next_backoff(current: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > MAX_BACKOFF {
        MAX_BACKOFF
    } else {
        doubled
    }
}

/// 一次中断之后，为**下一次**连接尝试准备的退避基数（`docs/contract.md` §4）。
///
/// 活过 `HEALTHY_SESSION` 的连接算「健康会话」：它的中断是偶发的，退避回到 5 秒起点。
/// 没活过阈值的（连不上、认证失败、刚握手就被断）继续 `next_backoff` 递增，60 秒封顶。
pub fn wait_after_break(current: Duration, healthy: bool) -> Duration {
    if healthy {
        INITIAL_BACKOFF
    } else {
        current
    }
}

/// ±20% 抖动；用系统时间纳秒做源，避免为抖动引入额外依赖。
pub fn jitter(base: Duration) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let percent = (nanos % 41) as f64 / 100.0 - 0.20;
    base.mul_f64(1.0 + percent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmubox_core::{Event, EventBus};

    #[test]
    fn backoff_sequence_matches_contract() {
        let mut d = INITIAL_BACKOFF;
        let mut seen = vec![d];
        for _ in 0..6 {
            d = next_backoff(d);
            seen.push(d);
        }
        assert_eq!(
            seen,
            vec![
                Duration::from_secs(5),
                Duration::from_secs(10),
                Duration::from_secs(20),
                Duration::from_secs(40),
                Duration::from_secs(60),
                Duration::from_secs(60),
                Duration::from_secs(60),
            ]
        );
    }

    /// 一次健康会话（活过 `HEALTHY_SESSION`）掉线之后，退避必须回到 5 秒起点。
    /// 旧实现只在「被取消」收场时才重置，掉线（`Err`）一律翻倍——实测日志里
    /// `5s→10s→20s→40s→60s` 单调爬升、从不回落，断连后要干等一分钟才重连。
    #[test]
    fn healthy_session_drops_the_backoff_back_to_the_start() {
        assert_eq!(wait_after_break(MAX_BACKOFF, true), INITIAL_BACKOFF);
        // 连续失败（没活过阈值）不缩短等待，照旧递增、60 秒封顶。
        assert_eq!(wait_after_break(INITIAL_BACKOFF, false), INITIAL_BACKOFF);
        assert_eq!(wait_after_break(MAX_BACKOFF, false), MAX_BACKOFF);
    }

    #[test]
    fn jitter_stays_within_twenty_percent() {
        let base = Duration::from_secs(10);
        for _ in 0..200 {
            let j = jitter(base);
            assert!(j >= base.mul_f64(0.79) && j <= base.mul_f64(1.21), "{j:?}");
        }
    }

    #[test]
    fn heartbeat_body_is_the_literal_from_protocol() {
        assert_eq!(HEARTBEAT_BODY, b"[object Object]");
    }

    #[test]
    fn room_identity_reads_admin_medal_and_guard() {
        // 形状照抄实测响应（2026-09-12，房间号写成中性值，昵称与 uid 不参与断言）。
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "badge": {"admin_level": 0, "is_room_admin": true, "permissions": null},
                "medal": {
                    "is_weared": true,
                    "up_medal": {"level": 21, "medal_name": "牌子", "uid": 1}
                },
                "uinfo": {"guard": {"level": 3}},
                // 实测（2026-09-13，A44）：`property.danmu.length` 就是官方前端读的
                // danmaku_length 上限，当前账号 × 8 个房间都是 40。
                "property": {"danmu": {"length": 40}}
            }
        });
        assert_eq!(
            parse_room_identity(5440, &value),
            RoomSession {
                room_id: 5440,
                my_medal_level: 21,
                my_medal_name: "牌子".into(),
                my_medal_worn: true,
                my_guard_level: 3,
                is_admin: true,
                danmaku_length: 40,
            }
        );
    }

    /// 弹幕上限**缺失**时按官方前端的缺省 20（产物里 `t.danmu_length || 20`），**不是** 0：
    /// 0 会让输入框一个字都打不进去。上游给 0 / 负数同样走这一档。
    #[test]
    fn room_identity_falls_back_to_default_danmaku_length() {
        let missing = serde_json::json!({
            "code": 0,
            "data": {"badge": {"is_room_admin": false}}
        });
        assert_eq!(
            parse_room_identity(7, &missing).danmaku_length,
            DEFAULT_DANMAKU_LENGTH
        );
        let zero = serde_json::json!({
            "code": 0,
            "data": {"property": {"danmu": {"length": 0}}}
        });
        assert_eq!(
            parse_room_identity(7, &zero).danmaku_length,
            DEFAULT_DANMAKU_LENGTH,
            "0 当成缺省值，不当成「一个字都不许发」"
        );
    }

    /// **持有 ≠ 佩戴**（形状照抄 2026-09-13 的真实只读取数）：`up_medal` 只说明**持有**
    /// 这房间的牌，佩戴与否在同层的 `is_weared` 上。用户当天报的「刚发出去多出一块 1 级
    /// 本房间粉丝牌」正是这一格：持有 Lv1 牌、`is_weared = false`（没戴）。
    /// 这条断言是那个 bug 的回归护栏：谁再把 `my_medal_worn` 删掉、或让界面忽略它，这里先红。
    #[test]
    fn room_identity_separates_held_medal_from_worn_one() {
        let value = serde_json::json!({
            "code": 0,
            "data": {
                "badge": {"admin_level": 0, "is_room_admin": false},
                "medal": {
                    "cnt": 38,
                    "is_weared": false,
                    "curr_weared": null,
                    "up_medal": {"level": 1, "medal_color": 6067854, "medal_name": "牌子", "uid": 1}
                },
                "uinfo": {"guard": {"level": 0}}
            }
        });
        let session = parse_room_identity(7, &value);
        assert_eq!(session.my_medal_level, 1, "持有：等级仍然带出来");
        assert_eq!(session.my_medal_name, "牌子");
        assert!(!session.my_medal_worn, "没佩戴 —— 界面不许画这块牌");
    }

    #[test]
    fn room_identity_accepts_admin_level_as_the_only_admin_signal() {
        let value = serde_json::json!({
            "data": {"badge": {"admin_level": 2, "is_room_admin": false}}
        });
        assert!(parse_room_identity(1, &value).is_admin, "admin_level>0 也是房管");
    }

    #[test]
    fn room_identity_defaults_when_medal_is_hidden_or_missing() {
        // 粉丝牌可被用户隐藏（`fans_medal: null` 一类），此时是「无牌」而不是错误。
        let value = serde_json::json!({
            "code": 0,
            "data": {"badge": {"is_room_admin": false}, "medal": {"up_medal": null}}
        });
        assert_eq!(
            parse_room_identity(7, &value),
            RoomSession {
                room_id: 7,
                // 唯独弹幕上限不是零：它是官方缺省 20（见上面那条测试）。
                danmaku_length: DEFAULT_DANMAKU_LENGTH,
                ..Default::default()
            },
            "取不到就全零（弹幕上限按官方缺省），不编造身份"
        );
        assert_eq!(
            parse_room_identity(7, &serde_json::json!({"code": 0})),
            RoomSession {
                room_id: 7,
                danmaku_length: DEFAULT_DANMAKU_LENGTH,
                ..Default::default()
            }
        );
    }

    #[test]
    fn auth_packet_uses_heartbeat_framing_and_brotli_payload_version() {
        let body = serde_json::json!({
            "uid": 0, "roomid": 1, "protover": proto::PROTOVER_BROTLI,
            "buvid": "x", "platform": "web", "type": 2, "key": ""
        });
        let packet = proto::build_packet(
            proto::OP_VERIFY,
            proto::PROTOVER_HEARTBEAT,
            body.to_string().as_bytes(),
        );
        let header = proto::Header::parse(&packet).unwrap();
        assert_eq!(header.op, proto::OP_VERIFY);
        assert_eq!(header.protover, proto::PROTOVER_HEARTBEAT);
        assert_eq!(header.packet_len as usize, packet.len());
        let payload: Value = serde_json::from_slice(&packet[16..]).unwrap();
        assert_eq!(payload["protover"], 3);
        assert_eq!(payload["uid"], 0);
        assert_eq!(payload["key"], "");
    }

    fn test_sink() -> (MessageSink, EventBus) {
        let bus = EventBus::default();
        let sink = MessageSink::new(bus.clone(), std::sync::Arc::new(Counters::default()));
        (sink, bus)
    }

    /// `docs/roadmap.md` S1-AC9：非 0 认证 code 一律按失败处理，且只记录原始值。
    #[tokio::test]
    async fn non_zero_verify_code_fails_the_session() {
        let live = BiliLive::new().unwrap();
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let frame = proto::build_packet(
            proto::OP_VERIFY_REPLY,
            proto::PROTOVER_HEARTBEAT,
            br#"{"code":-101}"#,
        );
        let items: Vec<std::result::Result<WsMessage, tokio_tungstenite::tungstenite::Error>> =
            vec![Ok(WsMessage::Binary(frame.into()))];
        let mut stream = Box::pin(futures_util::stream::iter(items));

        let err = live
            .read_loop(1, &sink, &cancel, &mut stream)
            .await
            .expect_err("非 0 code 必须报错");
        assert_eq!(err.code(), "UPSTREAM_ERROR");
        assert!(
            err.to_string().contains("-101"),
            "只记录原始 code，不赋予含义：{err}"
        );
    }

    #[tokio::test]
    async fn zero_verify_code_publishes_connected_and_keeps_running() {
        let live = BiliLive::new().unwrap();
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let cancel = Cancel::new();
        let frame = proto::build_packet(
            proto::OP_VERIFY_REPLY,
            proto::PROTOVER_HEARTBEAT,
            br#"{"code":0}"#,
        );
        let items: Vec<std::result::Result<WsMessage, tokio_tungstenite::tungstenite::Error>> =
            vec![Ok(WsMessage::Binary(frame.into()))];
        let mut stream =
            Box::pin(futures_util::stream::iter(items).chain(futures_util::stream::pending()));

        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                cancel.cancel();
            })
        };
        let outcome = live.read_loop(1, &sink, &cancel, &mut stream).await;
        canceller.await.unwrap();
        assert!(outcome.unwrap(), "认证成功后应保持运行直到被取消");

        let mut connected = false;
        while let Ok(event) = events.try_recv() {
            if let Event::Status(status) = event {
                connected |= status.state == ConnState::Connected;
            }
        }
        assert!(connected, "认证成功必须广播 Connected");
    }
}
