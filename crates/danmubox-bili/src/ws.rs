//! 长连接：认证、双心跳、读循环与重连退避（`docs/protocol.md` §7–§9、§13、§14）。
//!
//! 游客模式也走完整流程：`getDanmuInfo` 拿票据（需要 `buvid` 与 WBI 签名），
//! 认证包带 `uid=0` 与空 `key`。

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use danmubox_core::ports::LiveSource;
use danmubox_core::{Cancel, ConnState, Counters, Error, MessageSink, Result, Room};
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

/// WS 心跳包体：字面量，见 `docs/protocol.md` §8.1。
const HEARTBEAT_BODY: &[u8] = b"[object Object]";

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
        let host = info
            .hosts
            .first()
            .cloned()
            .ok_or_else(|| Error::Upstream("getDanmuInfo 未返回可用地址".into()))?;

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

        let (stream, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| Error::Upstream(format!("连接弹幕服务器失败: {e}")))?;
        let (mut write, mut read) = stream.split();

        // 认证包（op=7，帧头 protover=1，body 里声明想用的载荷版本 3）。
        let auth = serde_json::json!({
            "uid": 0,
            "roomid": room_id,
            "protover": proto::PROTOVER_BROTLI,
            "buvid": buvid3,
            "platform": "web",
            "type": 2,
            "key": info.token,
        });
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
                                        if let Some(message) =
                                            cmd::dispatch(room_id, &value, &self.counters)
                                        {
                                            sink.publish_message(message);
                                        }
                                    }
                                    Decoded::Popularity(value) => {
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
    async fn resolve_room(&self, input: &str) -> Result<Room> {
        self.http.room_play_info(input).await
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

            match outcome {
                Ok(true) if started.elapsed() >= HEALTHY_SESSION => {
                    backoff = INITIAL_BACKOFF;
                }
                Ok(_) => {}
                Err(err) => {
                    sink.publish_status(room_id, ConnState::Disconnected, err.to_string());
                    tracing::warn!(
                        room_id,
                        %err,
                        backoff_ms = backoff.as_millis() as u64,
                        "连接中断，准备重连"
                    );
                }
            }

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
