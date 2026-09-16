//! 长连接：认证、双心跳、读循环与重连退避（`docs/protocol.md` §7–§9、§13、§14、§15.3）。
//!
//! 游客模式也走完整流程：`getDanmuInfo` 拿票据（需要 `buvid` 与 WBI 签名），
//! 认证包带 `uid=0` 与空 `key`。
//!
//! 「连上了却收不到弹幕」这类收场由三条护栏兜住，它们全在本文件里：
//!
//! - **认证超时**（§7.3）：发出 `op=7` 后 10 秒内没有 `op=8` → 计一次认证失败、走退避；
//! - **僵死判定**（§8.1）：90 秒内没有任何入站帧 → 主动断开重连，日志给出距上次入站多久；
//! - **认证失败上限**（§13.2 / §13.3）：连续 3 次 → 停在 `Failed`，等人工重连；
//!
//! 外加**节点轮换**（§15.3）：同一节点连续失败 2 次就换 `host_list` 下一项。

use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use danmubox_core::diagnose::{self, Attempt as DiagAttempt};
use danmubox_core::ports::LiveSource;
use danmubox_core::{
    Cancel, ConnState, Counters, Error, Message, MessageSink, Result, Room, RoomSession,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::cmd;
use crate::http::{BiliHttp, REFERER_LIVE, UA};
use crate::proto::{self, Decoded};

/// 重连退避起点与上限（`docs/contract.md` §4）。
pub const INITIAL_BACKOFF: Duration = Duration::from_secs(5);
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// 上游 HTTP 心跳周期。
const HTTP_HEARTBEAT_PERIOD: Duration = Duration::from_secs(60);
/// 会话短于该时长视为「未真正建立」，不重置退避，避免紧循环重连。
const HEALTHY_SESSION: Duration = Duration::from_secs(30);
/// 单个弹幕节点的拨号超时；超时即换下一个节点。
const WS_DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// 连接护栏的时间与次数（`docs/protocol.md` §7.3 / §8.1 / §13.2 / §15.3）。
///
/// 收成一个结构只有一个理由：**单测要注入毫秒级的阈值**。10 秒 / 90 秒 / 30 秒
/// 这几条护栏照文档一字不改，靠真实时间跑测试却要几十秒；注入之后每条断言都是
/// 同一段代码在毫秒尺度上的同一次判定。
#[derive(Debug, Clone, Copy)]
struct Limits {
    /// 认证超时：发出 `op=7` 后多久没等到 `op=8` 算认证失败（§7.3）。
    auth_timeout: Duration,
    /// 僵死判定：多久没有收到任何入站帧就判死、主动断开（§8.1）。
    inbound_stale: Duration,
    /// WS 心跳周期（§8.1）。首包不等周期，认证成功即发。
    heartbeat_period: Duration,
    /// 连续认证失败上限，达到即停止自动重连（§13.2 / §13.3）。
    auth_failure_limit: u32,
    /// 同一节点连续失败多少次后轮换到下一项（§15.3）。
    node_failure_limit: u32,
    /// 退避起点与封顶（§13.2）。
    backoff_initial: Duration,
    backoff_max: Duration,
}

impl Default for Limits {
    /// 生产值，逐条对应文档：认证超时 10s（§7.3）、僵死 90s（§8.1）、
    /// 心跳 30s（§8.1）、认证失败上限 3（§13.2）、同节点失败 2 次换节点（§15.3）。
    fn default() -> Self {
        Self {
            auth_timeout: Duration::from_secs(10),
            inbound_stale: Duration::from_secs(90),
            heartbeat_period: Duration::from_secs(30),
            auth_failure_limit: 3,
            node_failure_limit: 2,
            backoff_initial: INITIAL_BACKOFF,
            backoff_max: MAX_BACKOFF,
        }
    }
}

/// 一次连接尝试的收场（`docs/protocol.md` §13.1 的各条出边）。
#[derive(Debug, PartialEq)]
enum End {
    /// 认证成功（`op=8` 且 `code=0`）之后收场（对端关闭 / 被取消）：健康的一次连接。
    Live,
    /// 认证失败：`op=8` 非 0 code，或超时没等到 `op=8`（§7.3 / §13.3）。
    /// 字符串里只放**原值**，不为未知 code 编造含义。
    AuthFailed(String),
    /// 连接或传输层失败：拨号、握手、读错误、僵死判定。
    Failed(String),
    /// 还没认证成功就被取消（会话关闭 / 手动刷新），不算失败。
    Cancelled,
}

/// 一次连接尝试的收场 + 两件记账要用的旁证。
#[derive(Debug)]
struct Attempt {
    /// 怎么结束的。
    end: End,
    /// 认证成功过（`op=8` 且 `code=0`）。它决定**连续认证失败计数**是否清零（§13.2）：
    /// 「接上过又掉」不是认证失败，不该把之前那几次的连续计数接着往上涨。
    verified: bool,
    /// 本次实际接入的候选节点下标（`host_list` 内的下标）；一个都没接上时是**起始候选**
    /// 的下标（它同样算一次失败，§15.3），`host_list` 都没取到时是 `None`。
    host: Option<usize>,
    /// 本次尝试在诊断采集器里的那条记录（一键诊断，`docs/operations.md` §2.9）。
    ///
    /// 放在这里而不是另开一条信道：重连循环要在收场之后补上「退避多久、连续失败几次」，
    /// 而那两件事是循环算出来的 —— 顺着收场结果带出来，比再传一个句柄更不容易丢。
    diag: Arc<DiagAttempt>,
}

impl Attempt {
    fn new(diag: &Arc<DiagAttempt>, end: End, verified: bool, host: Option<usize>) -> Self {
        Self {
            end,
            verified,
            host,
            diag: Arc::clone(diag),
        }
    }
}

/// [`End`] 说成一句人话，进诊断报告（`docs/operations.md` §2.9）。
///
/// 原样搬运连接层自己的判定，不额外解释：报告里要能看见「是认证失败、僵死、还是
/// 对端关的」，而不是一个笼统的「连接失败」。
fn end_reason(end: &End) -> String {
    match end {
        End::Live => "认证成功后收场（对端关闭或本次会话结束）".into(),
        End::AuthFailed(reason) => reason.clone(),
        End::Failed(reason) => reason.clone(),
        End::Cancelled => "本次连接被取消（离开房间 / 手动刷新）".into(),
    }
}

/// 业务载荷的 `cmd` 主干名（`DANMU_MSG:4:0:2:2:2:0` → `DANMU_MSG`）。
///
/// 与 `cmd::dispatch` 取主干的那一步同口径（那边是 `cmd.split(':').next()`）：
/// 一键诊断的「未识别命令名单」要与 `Counters.unknown_cmd` 的分类对得上，
/// 名字就不能带后缀。三行重复好过把 bili 的命令表复制第二份。
fn cmd_name(value: &Value) -> String {
    let raw = value.get("cmd").and_then(Value::as_str).unwrap_or_default();
    raw.split(':').next().unwrap_or(raw).to_string()
}

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

    /// 建立一次连接并读到断开为止（`docs/protocol.md` §13.1 的一轮 `Resolving → …`）。
    ///
    /// `node_start` 是本次尝试**从候选表的第几项开始**：调用方按 §15.3 记账轮换，
    /// 本函数把它对 `host_list` 取模后按顺序把候选试完一轮（一个不通就换下一个）。
    async fn run_once(
        &self,
        room_id: i64,
        sink: &MessageSink,
        cancel: &Cancel,
        limits: &Limits,
        node_start: usize,
        diag: &Arc<DiagAttempt>,
    ) -> Attempt {
        let buvid3 = match self.buvid3().await {
            Ok(buvid3) => buvid3,
            Err(err) => {
                return Attempt::new(
                    diag,
                    End::Failed(format!("取 buvid3 失败: {err}")),
                    false,
                    None,
                )
            }
        };
        let info = match self.http.danmu_info(room_id, &buvid3, diag).await {
            Ok(info) => info,
            Err(err) => {
                return Attempt::new(
                    diag,
                    End::Failed(format!("getDanmuInfo 失败: {err}")),
                    false,
                    None,
                )
            }
        };
        if info.hosts.is_empty() {
            return Attempt::new(diag, End::Failed("host_list 为空".into()), false, None);
        }

        // `host_list` 就是候选节点表：**从 `node_start` 起**逐个尝试（游标可能已经绕过
        // 好几轮，取模即可，§15.3），单个节点拨号必须有超时，否则一个不可达节点会让
        // 整条连接无限挂起（实测踩过）。
        let host_count = info.hosts.len();
        let first = node_start % host_count;
        let mut last_error = String::new();
        let mut connected = None;
        for offset in 0..host_count {
            let index = (first + offset) % host_count;
            let host = &info.hosts[index];
            let mut request = match format!("wss://{host}/sub").into_client_request() {
                Ok(request) => request,
                Err(err) => {
                    diag.dial_failed();
                    last_error = format!("构造 WS 请求失败: {err}");
                    continue;
                }
            };
            {
                let headers = request.headers_mut();
                headers.insert("User-Agent", HeaderValue::from_static(UA));
                headers.insert("Referer", HeaderValue::from_static(REFERER_LIVE));
            }
            tracing::debug!(room_id, index, host = %host, "尝试连接弹幕服务器");
            match tokio::time::timeout(WS_DIAL_TIMEOUT, tokio_tungstenite::connect_async(request))
                .await
            {
                Ok(Ok((stream, _response))) => {
                    tracing::debug!(room_id, index, host = %host, "WS 握手完成");
                    diag.node(index, Some(host));
                    diag.dialed(danmubox_core::now_ms());
                    connected = Some((index, host.clone(), stream));
                    break;
                }
                Ok(Err(err)) => {
                    diag.dial_failed();
                    tracing::warn!(room_id, index, host = %host, %err, "节点连接失败，尝试下一个");
                    last_error = format!("{host} 连接失败: {err}");
                }
                Err(_) => {
                    diag.dial_failed();
                    tracing::warn!(
                        room_id,
                        index,
                        host = %host,
                        timeout_ms = WS_DIAL_TIMEOUT.as_millis() as u64,
                        "节点连接超时，尝试下一个"
                    );
                    last_error = format!("{host} 连接超时");
                }
            }
        }
        let Some((host_index, chosen_host, stream)) = connected else {
            // 整个候选表都没接上：这次尝试在**起始候选**上收场（它同样算一次失败，§15.3）。
            diag.node(first, None);
            return Attempt::new(diag, End::Failed(last_error), false, Some(first));
        };
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
        if let Err(err) = write
            .send(WsMessage::Binary(
                proto::build_packet(
                    proto::OP_VERIFY,
                    proto::PROTOVER_HEARTBEAT,
                    auth.to_string().as_bytes(),
                )
                .into(),
            ))
            .await
        {
            return Attempt::new(
                diag,
                End::Failed(format!("发送认证包失败: {err}")),
                false,
                Some(host_index),
            );
        }
        // 认证包确实写出去了才算「已发出」（§7.3 的 10 秒从这一刻起算）。
        diag.auth_sent(danmubox_core::now_ms());

        // 本次会话的心跳作用域，任何退出路径都会停掉两个心跳任务。
        let session = Cancel::new();
        // 认证成功信号：读循环收到 `op=8` 且 `code=0` 时唤醒 WS 心跳任务**立刻**发首包。
        let verify = Arc::new(Notify::new());
        let heartbeat_ws = tokio::spawn(heartbeat_loop(
            write,
            room_id,
            Arc::clone(&verify),
            session.clone(),
            limits.heartbeat_period,
        ));
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

        let outcome = self
            .read_loop(room_id, sink, cancel, &verify, limits, &mut read, diag)
            .await;

        session.cancel();
        heartbeat_ws.abort();
        heartbeat_http.abort();
        Attempt {
            host: Some(host_index),
            ..outcome
        }
    }

    /// 读循环：解包投递，并守住两条时间护栏（`docs/protocol.md` §7.3 认证超时、
    /// §8.1 僵死判定）。
    ///
    /// 返回的 [`Attempt`] 里 `host` 是空的：`host_list` 只有 [`BiliLive::run_once`] 见过，
    /// 由它补上。
    async fn read_loop<S>(
        &self,
        room_id: i64,
        sink: &MessageSink,
        cancel: &Cancel,
        verify: &Notify,
        limits: &Limits,
        read: &mut S,
        diag: &Arc<DiagAttempt>,
    ) -> Attempt
    where
        S: futures_util::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        // 认证包由 `run_once` 紧接着发出，因此「发出 op=7」的时刻就取这里（§7.3）。
        let auth_deadline = tokio::time::Instant::now() + limits.auth_timeout;
        // 最后一次**任何**入站帧的时刻：§8.1 的僵死判据是「未收到任何入站帧」。
        let mut last_inbound = tokio::time::Instant::now();
        let mut verified = false;
        loop {
            let deadline = if verified {
                last_inbound + limits.inbound_stale
            } else {
                auth_deadline
            };
            tokio::select! {
                _ = cancel.cancelled() => {
                    let end = if verified { End::Live } else { End::Cancelled };
                    return Attempt::new(diag, end, verified, None);
                }
                _ = tokio::time::sleep_until(deadline) => {
                    if verified {
                        // 判定依据要留在日志里：**距上次入站多久**、阈值多少（§8.1）。
                        let idle = last_inbound.elapsed();
                        tracing::warn!(
                            room_id,
                            idle_ms = idle.as_millis() as u64,
                            stale_ms = limits.inbound_stale.as_millis() as u64,
                            "距上次入站帧已 {}ms（阈值 {}ms），判定连接僵死，主动断开重连",
                            idle.as_millis(),
                            limits.inbound_stale.as_millis()
                        );
                        return Attempt::new(
                            diag,
                            End::Failed(format!(
                                "僵死：距上次入站帧 {}ms（阈值 {}ms）",
                                idle.as_millis(),
                                limits.inbound_stale.as_millis()
                            )),
                            verified,
                            None,
                        );
                    }
                    tracing::warn!(
                        room_id,
                        timeout_ms = limits.auth_timeout.as_millis() as u64,
                        "发出认证包后未在超时内收到 op=8，按认证失败处理"
                    );
                    return Attempt::new(
                        diag,
                        End::AuthFailed(format!(
                            "认证超时：{}ms 内未收到 op=8",
                            limits.auth_timeout.as_millis()
                        )),
                        false,
                        None,
                    );
                }
                incoming = read.next() => {
                    let message = match incoming {
                        None => {
                            return Attempt::new(
                                diag,
                                End::Failed("连接已被对端关闭".into()),
                                verified,
                                None,
                            );
                        }
                        Some(Err(err)) => {
                            return Attempt::new(
                                diag,
                                End::Failed(format!("读取失败: {err}")),
                                verified,
                                None,
                            );
                        }
                        Some(Ok(message)) => message,
                    };
                    // 任何入站帧都把「最后一次入站」往前推：判据是「未收到**任何**入站帧」，
                    // `op=3` / `op=5` / `op=8` 之外的控制帧同样算它活着。
                    last_inbound = tokio::time::Instant::now();
                    // 同一个时刻进诊断采集器：护栏判死用的是这里，报告里要能对上（§2.9）。
                    let inbound_at = danmubox_core::now_ms();
                    diag.inbound(inbound_at);
                    match message {
                        WsMessage::Binary(bytes) => {
                            let mut decoded = Vec::new();
                            proto::decode_stream(&bytes, &self.counters, &mut decoded);
                            for item in decoded {
                                match item {
                                    Decoded::Business(value) => {
                                        // 首条业务载荷到达的时刻 = 「有没有在喂弹幕」的判据
                                        // （一键诊断，`docs/operations.md` §2.9）。
                                        diag.business(inbound_at);
                                        // 未识别命令的**名单**在这里补：`cmd::dispatch` 只累加
                                        // 计数（`Counters.unknown_cmd`），它的已知命令表是私有的；
                                        // 这里不重复一份表，改成看这次调用有没有把计数推上去。
                                        // 平时（没在采集）连那两次原子读都不做。
                                        let unknown_probe = diagnose::shared()
                                            .recording_at(inbound_at)
                                            .then(|| {
                                                (
                                                    cmd_name(&value),
                                                    self.counters.unknown_cmd.load(Ordering::Relaxed),
                                                )
                                            });
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
                                        if let Some((name, before)) = unknown_probe {
                                            if self.counters.unknown_cmd.load(Ordering::Relaxed) > before
                                            {
                                                diagnose::shared().note_unknown_cmd(inbound_at, &name);
                                            }
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
                                        diag.auth_reply(inbound_at, Some(code));
                                        if code == 0 {
                                            verified = true;
                                            // 认证成功 = 可以发心跳了：放行心跳任务的**首包**
                                            // （§8.1 的「60 秒内」是上界，不等一个周期）。
                                            verify.notify_one();
                                            sink.publish_status(
                                                room_id,
                                                ConnState::Connected,
                                                "verified",
                                            );
                                        } else {
                                            // 未知 code 只记录原始值，不赋予含义（§13.3 步骤 3）。
                                            tracing::warn!(
                                                room_id,
                                                code,
                                                "认证回应 code 非 0，按认证失败处理"
                                            );
                                            tracing::debug!(
                                                room_id,
                                                code,
                                                body = %value,
                                                "op=8 原始 body"
                                            );
                                            return Attempt::new(
                                                diag,
                                                End::AuthFailed(format!("认证失败 code={code}")),
                                                verified,
                                                None,
                                            );
                                        }
                                    }
                                    Decoded::Other(op) => {
                                        tracing::trace!(room_id, op, "其他包");
                                    }
                                }
                            }
                        }
                        WsMessage::Text(text) => {
                            tracing::debug!(room_id, len = text.len(), "收到文本帧");
                        }
                        WsMessage::Close(frame) => {
                            return Attempt::new(
                                diag,
                                End::Failed(format!("对端发送关闭帧: {frame:?}")),
                                verified,
                                None,
                            );
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

/// WS 心跳任务（`docs/protocol.md` §8.1）。
///
/// **首包不等周期**：认证回应 `code=0` 一到就发。文档里「认证成功后 60 秒内必须发出」
/// 是上界；等到 60 秒才发首包，会让一部分候选节点一直把我们挂在「心跳未建立」上——
/// 症状正是「能认证、能回心跳，但不下发弹幕」。此后每 `period` 一次。
///
/// 写端由本任务独占（读循环只用读半），因此不需要锁。
async fn heartbeat_loop<W>(
    mut write: W,
    room_id: i64,
    verify: Arc<Notify>,
    session: Cancel,
    period: Duration,
) where
    W: futures_util::Sink<WsMessage> + Unpin,
{
    tokio::select! {
        _ = session.cancelled() => return,
        _ = verify.notified() => {}
    }
    loop {
        if session.is_cancelled() {
            return;
        }
        let packet = proto::build_packet(
            proto::OP_HEARTBEAT,
            proto::PROTOVER_HEARTBEAT,
            HEARTBEAT_BODY,
        );
        if write.send(WsMessage::Binary(packet.into())).await.is_err() {
            // 「心跳失败不重试」（§8.1）：写端一断，整条连接按故障处理，
            // 由读循环收场，这里只停掉心跳。
            tracing::warn!(room_id, "WS 心跳发送失败，停止心跳");
            return;
        }
        tracing::trace!(room_id, "WS 心跳已发送");
        tokio::select! {
            _ = session.cancelled() => return,
            _ = tokio::time::sleep(period) => {}
        }
    }
}

/// 重连循环：退避、连续认证失败记账、节点轮换（`docs/protocol.md` §13.1 / §13.2 / §15.3）。
///
/// `attempt` 注入「一次连接怎么建、怎么收场」，本函数只负责**收到收场之后怎么走**。
/// 拆开是为了让护栏能被离线断言：真实的一次连接要连上游，而护栏的判定不依赖它。
///
/// 记账状态（连续认证失败计数、节点游标）活在**一次调用里**：§14 的手动重连是取消
/// 当前连接、重新调一次 `stream()`，于是计数与退避一起归零——这正是停在 `Failed`
/// 之后那颗「刷新」能把连接救回来的原因。
async fn reconnect_loop<F, Fut>(
    room_id: i64,
    sink: &MessageSink,
    cancel: &Cancel,
    limits: &Limits,
    mut attempt: F,
) -> Result<()>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Attempt>,
{
    let mut backoff = limits.backoff_initial;
    let mut auth_failures = 0u32;
    // 节点轮换游标（§15.3）：越界由 `run_once` 对 `host_list` 取模兜住，于是
    // 「轮完一轮回到首项」自然成立。
    let mut node_start = 0usize;
    let mut node_failures = 0u32;

    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        sink.publish_status(room_id, ConnState::Connecting, "连接中");

        let started = Instant::now();
        let outcome = attempt(node_start).await;
        // 收场先记账再判取消：一键诊断要看到**每一次**尝试的结局，
        // 包括「还没认证就被取消」那一档（`docs/operations.md` §2.9）。
        outcome
            .diag
            .ended(danmubox_core::now_ms(), &end_reason(&outcome.end), outcome.verified);
        if cancel.is_cancelled() {
            return Ok(());
        }
        // 活过 HEALTHY_SESSION 的一次连接算「健康会话」：它的中断是偶发的，
        // 退避回到起点；没活过阈值的（连不上、认证失败、刚握上就断）继续递增。
        let healthy = started.elapsed() >= HEALTHY_SESSION;

        match &outcome.end {
            End::Cancelled => {}
            End::Live => {
                auth_failures = 0;
                tracing::debug!(room_id, "连接正常收场");
            }
            End::Failed(reason) => {
                if outcome.verified {
                    // 接上过又掉：这是一次认证**成功**的连接，不该让连续认证失败的
                    // 计数接着往上涨（§13.2 的「连续 3 次」是连续的）。
                    auth_failures = 0;
                }
                sink.publish_status(room_id, ConnState::Disconnected, reason.clone());
                tracing::warn!(room_id, %reason, healthy, "连接中断，准备重连");
            }
            End::AuthFailed(reason) => {
                auth_failures += 1;
                if auth_failures >= limits.auth_failure_limit {
                    tracing::warn!(
                        room_id,
                        failures = auth_failures,
                        limit = limits.auth_failure_limit,
                        %reason,
                        "连续认证失败达上限，停止自动重连，等人工（rooms_reconnect）"
                    );
                    sink.publish_status(
                        room_id,
                        ConnState::Error,
                        format!(
                            "{reason}（连续 {auth_failures} 次认证失败，已停止自动重连；手动刷新可重置）"
                        ),
                    );
                    // §13.1 的 `Failed`：**停在原地等人工**。这里绝不返回——一旦返回，
                    // 核心驱动的循环会立刻再起一次连接，等于没停。
                    cancel.cancelled().await;
                    return Ok(());
                }
                tracing::warn!(room_id, failures = auth_failures, %reason, "认证失败，按退避重连");
                sink.publish_status(
                    room_id,
                    ConnState::Error,
                    format!("{reason}（连续 {auth_failures} 次）"),
                );
            }
        }

        // 节点轮换（§15.3）：这个节点没干成活就记一次，连续失败达上限换下一个候选。
        if matches!(outcome.end, End::AuthFailed(_) | End::Failed(_)) {
            node_failures += 1;
            if node_failures >= limits.node_failure_limit {
                let used = outcome.host.unwrap_or(node_start);
                tracing::warn!(
                    room_id,
                    node_index = used,
                    failures = node_failures,
                    "同一节点连续失败达上限，切换到下一个弹幕节点"
                );
                node_start = used + 1;
                node_failures = 0;
            }
        } else {
            node_failures = 0;
        }

        backoff = wait_after_break(backoff, healthy, limits.backoff_initial);
        let wait = jitter(backoff);
        tracing::debug!(
            room_id,
            wait_ms = wait.as_millis() as u64,
            auth_failures,
            node_start,
            "退避等待"
        );
        // 退避与连续失败次数是重连历史的两根坐标，跟着这一次尝试一起进报告。
        outcome
            .diag
            .backoff(wait.as_millis() as u64, auth_failures);
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = tokio::time::sleep(wait) => {}
        }
        backoff = next_backoff(backoff, limits.backoff_max);
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
        let limits = Limits::default();
        // 每次 `stream()` 调用都是一个**新的重连周期**（§14：手动重连取消当前连接、
        // 重新调到这里），因此连续认证失败计数与节点游标都从这里重新开始。
        //
        // 一键诊断：本周期用的那份协议计数交给采集器（报告里要的是「这一段连接」
        // 收了多少包、丢了多少，而不是进程开机以来的总数）。
        diagnose::shared().note_counters(Arc::clone(&self.counters));
        // 先把这两个借用取出来：下面的 `async move` 要按值捕获（每次尝试一条新记录），
        // 直接捕获 `sink` / `cancel` 会被理解成「把会话本身搬进闭包」，`FnMut` 搬不动。
        let (sink, cancel) = (&sink, &cancel);
        reconnect_loop(room_id, sink, cancel, &limits, |node_start| {
            // 每次尝试各开一条诊断记录：一个重连周期里可能有好几次尝试，
            // 报告要按次给出「票据 / 认证 / 首帧 / 结束原因 / 退避」。
            let diag = diagnose::shared().begin_attempt(danmubox_core::now_ms());
            async move {
                self.run_once(room_id, sink, cancel, &limits, node_start, &diag)
                    .await
            }
        })
        .await
    }
}

/// 退避递增，`max` 封顶（`docs/protocol.md` §13.2 / `docs/contract.md` §4 的
/// `5s / 10s / 20s / 40s / 60s` 封顶）。
pub fn next_backoff(current: Duration, max: Duration) -> Duration {
    let doubled = current.saturating_mul(2);
    if doubled > max {
        max
    } else {
        doubled
    }
}

/// 一次中断之后，为**下一次**连接尝试准备的退避基数（`docs/contract.md` §4）。
///
/// 活过 `HEALTHY_SESSION` 的连接算「健康会话」：它的中断是偶发的，退避回到 `initial`
/// （生产的 5 秒起点）。没活过阈值的（连不上、认证失败、刚握手就被断）继续
/// `next_backoff` 递增，`max` 封顶。旧实现把重置写在「被取消」那一支里，掉线走的是
/// 另一支，于是每次掉线都把退避翻倍、**从不回落**：断连后要干等一分钟才重连，
/// 用户看到的就是「断了就回不来了」。
pub fn wait_after_break(current: Duration, healthy: bool, initial: Duration) -> Duration {
    if healthy {
        initial
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
    use std::pin::Pin;
    // 与生产代码同名的 `Mutex` 在 `super::*` 里是 `tokio::sync::Mutex`；测试里要的是
    // 同步锁（不跨 await），因此显式别名，避免误用。
    use std::sync::Mutex as StdMutex;
    use std::task::{Context, Poll};

    #[test]
    fn backoff_sequence_matches_contract() {
        let mut d = INITIAL_BACKOFF;
        let mut seen = vec![d];
        for _ in 0..6 {
            d = next_backoff(d, MAX_BACKOFF);
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

    /// 一次健康会话（活过 `HEALTHY_SESSION`）掉线之后，退避必须回到起点。
    #[test]
    fn healthy_session_drops_the_backoff_back_to_the_start() {
        assert_eq!(
            wait_after_break(MAX_BACKOFF, true, INITIAL_BACKOFF),
            INITIAL_BACKOFF
        );
        // 连续失败（没活过阈值）不缩短等待，照旧递增、封顶。
        assert_eq!(
            wait_after_break(INITIAL_BACKOFF, false, INITIAL_BACKOFF),
            INITIAL_BACKOFF
        );
        assert_eq!(
            wait_after_break(MAX_BACKOFF, false, INITIAL_BACKOFF),
            MAX_BACKOFF
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

    /// 测试用的时间参数：同一段代码在毫秒尺度上跑，判定逻辑一字不改。
    /// 生产值见 [`Limits::default`]（10s / 90s / 30s / 3 / 2 / 5s / 60s）。
    fn test_limits() -> Limits {
        Limits {
            auth_timeout: Duration::from_millis(40),
            inbound_stale: Duration::from_millis(120),
            heartbeat_period: Duration::from_millis(100),
            auth_failure_limit: 3,
            node_failure_limit: 2,
            backoff_initial: Duration::from_millis(25),
            backoff_max: Duration::from_millis(50),
        }
    }

    /// 测试用的一条诊断记录：只为了满足 `Attempt` / `read_loop` 的签名，
    /// 断言都落在收场结果上（诊断采集器自己另有用例）。
    fn test_diag() -> Arc<DiagAttempt> {
        danmubox_core::diagnose::Diagnoser::new().begin_attempt(0)
    }

    fn frame(op: u32, body: &[u8]) -> WsMessage {
        WsMessage::Binary(proto::build_packet(op, proto::PROTOVER_HEARTBEAT, body).into())
    }

    fn verify_frame(code: i64) -> WsMessage {
        frame(
            proto::OP_VERIFY_REPLY,
            format!("{{\"code\":{code}}}").as_bytes(),
        )
    }

    type Frames = Vec<std::result::Result<WsMessage, tokio_tungstenite::tungstenite::Error>>;

    /// 等一个条件成立（真实时间，毫秒尺度）；超时即测试失败。
    async fn until(cond: impl Fn() -> bool, budget: Duration) {
        let deadline = Instant::now() + budget;
        loop {
            if cond() {
                return;
            }
            assert!(Instant::now() < deadline, "等待条件超时（{budget:?}）");
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    /// 记录写出去的每一帧。心跳任务独占写端，测试里就把这个假写端交出去，
    /// 于是「首包到底什么时候发」可以直接断言。
    #[derive(Clone, Default)]
    struct RecordingSink {
        frames: Arc<StdMutex<Vec<Vec<u8>>>>,
    }

    impl RecordingSink {
        fn frames(&self) -> Arc<StdMutex<Vec<Vec<u8>>>> {
            Arc::clone(&self.frames)
        }
    }

    impl futures_util::Sink<WsMessage> for RecordingSink {
        type Error = std::io::Error;

        fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(self: Pin<&mut Self>, item: WsMessage) -> std::result::Result<(), Self::Error> {
            if let WsMessage::Binary(bytes) = item {
                self.frames.lock().expect("lock poisoned").push(bytes.to_vec());
            }
            Ok(())
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    /// 跑一个「每次都认证失败」的重连循环，返回尝试次数与每次的时刻。
    fn spawn_auth_failing_loop(
        sink: &MessageSink,
        cancel: &Cancel,
        limits: &Limits,
        times: Arc<StdMutex<Vec<Instant>>>,
    ) -> tokio::task::JoinHandle<Result<()>> {
        let sink = sink.clone();
        let cancel = cancel.clone();
        let limits = *limits;
        tokio::spawn(async move {
            reconnect_loop(1, &sink, &cancel, &limits, |node_start| {
                times.lock().expect("lock poisoned").push(Instant::now());
                async move {
                    Attempt::new(
                        &test_diag(),
                        End::AuthFailed("认证超时：40ms 内未收到 op=8".into()),
                        false,
                        Some(node_start),
                    )
                }
            })
            .await
        })
    }

    /// `docs/roadmap.md` S1-AC9：非 0 认证 code 一律按失败处理，且只记录原始值。
    #[tokio::test]
    async fn non_zero_verify_code_fails_the_session() {
        let live = BiliLive::new().unwrap();
        let limits = test_limits();
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let verify = Notify::new();
        let items: Frames = vec![Ok(verify_frame(-101))];
        let mut stream = Box::pin(futures_util::stream::iter(items));

        let outcome = live
            .read_loop(1, &sink, &cancel, &verify, &limits, &mut stream, &test_diag())
            .await;
        match &outcome.end {
            End::AuthFailed(reason) => {
                assert!(
                    reason.contains("-101"),
                    "只记录原始 code，不赋予含义：{reason}"
                );
                assert!(!outcome.verified);
            }
            other => panic!("非 0 code 必须按认证失败处理，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn zero_verify_code_publishes_connected_and_keeps_running() {
        let live = BiliLive::new().unwrap();
        let limits = test_limits();
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let cancel = Cancel::new();
        let verify = Notify::new();
        let items: Frames = vec![Ok(verify_frame(0))];
        let mut stream =
            Box::pin(futures_util::stream::iter(items).chain(futures_util::stream::pending()));

        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                cancel.cancel();
            })
        };
        let outcome = live
            .read_loop(1, &sink, &cancel, &verify, &limits, &mut stream, &test_diag())
            .await;
        canceller.await.unwrap();
        assert_eq!(outcome.end, End::Live, "认证成功后应保持运行直到被取消");
        assert!(outcome.verified);
        // 认证成功必须放行心跳首包（§8.1）：`Notify` 的许可留在那里，随后立刻可取。
        tokio::time::timeout(Duration::from_millis(1), verify.notified())
            .await
            .expect("认证成功必须放行心跳任务");

        let mut connected = false;
        while let Ok(event) = events.try_recv() {
            if let Event::Status(status) = event {
                connected |= status.state == ConnState::Connected;
            }
        }
        assert!(connected, "认证成功必须广播 Connected");
    }

    /// §7.3：发出 `op=7` 后 10 秒内没有 `op=8` → 按认证失败处理，并按 §13.2 退避重连。
    #[tokio::test]
    async fn auth_timeout_is_a_failure_and_backs_off() {
        let live = BiliLive::new().unwrap();
        let limits = test_limits();
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let verify = Notify::new();
        // 静默对端：握手成功，一个字节都不发。
        let mut silent = Box::pin(futures_util::stream::pending::<std::result::Result<
            WsMessage,
            tokio_tungstenite::tungstenite::Error,
        >>());
        let started = Instant::now();
        let outcome = live
            .read_loop(1, &sink, &cancel, &verify, &limits, &mut silent, &test_diag())
            .await;
        match &outcome.end {
            End::AuthFailed(reason) => assert!(reason.contains("op=8"), "只描述事实：{reason}"),
            other => panic!("超时必须按认证失败收场，实际 {other:?}"),
        }
        assert!(!outcome.verified);
        assert!(
            started.elapsed() >= limits.auth_timeout,
            "不得提前判死（{:?}）",
            started.elapsed()
        );

        // 认证失败必须走退避：三次失败之间要能看到退避起点与递增。
        let times = Arc::new(StdMutex::new(Vec::new()));
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let runner = spawn_auth_failing_loop(&sink, &cancel, &limits, Arc::clone(&times));
        until(|| times.lock().expect("lock poisoned").len() >= 3, Duration::from_millis(2000)).await;
        let when = times.lock().expect("lock poisoned").clone();
        let first_gap = when[1] - when[0];
        let second_gap = when[2] - when[1];
        assert!(
            first_gap >= limits.backoff_initial.mul_f64(0.79),
            "两次重连之间必须等一个退避（起点 {:?}，实测 {first_gap:?}）",
            limits.backoff_initial
        );
        assert!(
            second_gap > first_gap,
            "退避必须递增（§13.2）：{first_gap:?} → {second_gap:?}"
        );
        // 连续 3 次到达上限：停在原地等人工（返回就等于核心驱动的循环立刻再连一次）。
        assert!(
            !runner.is_finished(),
            "达上限必须停在原地，不得返回"
        );
        assert_eq!(when.len(), 3, "达上限后不许再有第 4 次：{when:?}");
        tokio::time::sleep(limits.backoff_max * 3).await;
        assert_eq!(
            times.lock().expect("lock poisoned").len(),
            3,
            "停止自动重连之后，再等几个退避周期也不许重连"
        );
        cancel.cancel();
        runner.await.unwrap().unwrap();
    }

    /// §13.2 / §14：达上限停在 `Failed` 之后，手动重连（取消本次连接、重新调一次
    /// `stream()`）必须**重置计数**并**跳过退避**，第一次尝试立即发起。
    #[tokio::test]
    async fn manual_reconnect_resets_the_failure_count_and_skips_the_backoff() {
        let limits = test_limits();
        let (sink, _bus) = test_sink();

        // 第一个自动重连周期：连错 3 次 → 停在 Failed。
        let times = Arc::new(StdMutex::new(Vec::new()));
        let cancel = Cancel::new();
        let runner = spawn_auth_failing_loop(&sink, &cancel, &limits, Arc::clone(&times));
        until(|| times.lock().expect("lock poisoned").len() >= 3, Duration::from_millis(2000)).await;
        cancel.cancel();
        runner.await.unwrap().unwrap();
        assert_eq!(times.lock().expect("lock poisoned").len(), 3);

        // 「刷新」：换一个取消令牌 = 核心驱动重新调一次 `stream()`。
        let again = Arc::new(StdMutex::new(Vec::new()));
        let fresh = Cancel::new();
        let started = Instant::now();
        let runner = spawn_auth_failing_loop(&sink, &fresh, &limits, Arc::clone(&again));
        until(|| !again.lock().expect("lock poisoned").is_empty(), Duration::from_millis(2000)).await;
        assert!(
            started.elapsed() < limits.backoff_initial,
            "手动重连的第一步必须立即发起、不等退避（实测 {:?}）",
            started.elapsed()
        );
        // 计数归零：新一轮照样能连着试满 3 次，而不是一上来就停在 Failed。
        until(|| again.lock().expect("lock poisoned").len() >= 3, Duration::from_millis(2000)).await;
        assert_eq!(
            again.lock().expect("lock poisoned").len(),
            3,
            "手动重连后必须重新从 0 计数"
        );
        fresh.cancel();
        runner.await.unwrap().unwrap();
    }

    /// §8.1：认证成功后 90 秒内没有任何入站帧 → 判定僵死、主动断开（测试里 120ms）。
    /// 日志里要能看到判定依据（距上次入站多久），返回的失败原因里也带着它。
    #[tokio::test]
    async fn stale_connection_is_dropped_and_never_counts_as_auth_failure() {
        let live = BiliLive::new().unwrap();
        let limits = test_limits();
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let verify = Notify::new();
        // 认证成功（op=8 code=0）之后，再没有任何入站帧。
        let items: Frames = vec![Ok(verify_frame(0))];
        let mut stream =
            Box::pin(futures_util::stream::iter(items).chain(futures_util::stream::pending()));
        let started = Instant::now();
        let outcome = live
            .read_loop(1, &sink, &cancel, &verify, &limits, &mut stream, &test_diag())
            .await;
        let End::Failed(reason) = &outcome.end else {
            panic!("一直没有入站帧必须判死，实际 {:?}", outcome.end);
        };
        assert!(
            reason.contains("僵死") && reason.contains("入站帧"),
            "判定依据要写清楚（距上次入站多久）：{reason}"
        );
        assert!(
            reason.contains(&limits.inbound_stale.as_millis().to_string()),
            "阈值也要在原因里：{reason}"
        );
        assert!(
            outcome.verified,
            "是「认证成功之后不推弹幕」，不是认证问题"
        );
        assert!(started.elapsed() >= limits.inbound_stale, "不得提前判死");

        // 判死之后必须接着重连，而且**僵死不是认证失败**：连判 5 次也不许走到 Failed。
        let times = Arc::new(StdMutex::new(Vec::new()));
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let runner = {
            let sink = sink.clone();
            let cancel = cancel.clone();
            let times = Arc::clone(&times);
            tokio::spawn(async move {
                reconnect_loop(1, &sink, &cancel, &limits, |node_start| {
                    times.lock().expect("lock poisoned").push(Instant::now());
                    async move {
                        Attempt::new(
                            &test_diag(),
                            End::Failed("僵死：距上次入站帧 120ms（阈值 120ms）".into()),
                            true,
                            Some(node_start),
                        )
                    }
                })
                .await
            })
        };
        until(|| times.lock().expect("lock poisoned").len() >= 5, Duration::from_millis(3000)).await;
        assert!(
            !runner.is_finished(),
            "僵死不等于认证失败：不许把连接停在 Failed"
        );
        cancel.cancel();
        runner.await.unwrap().unwrap();
    }

    /// §8.1 的另一半：**有**入站帧就不许判僵死。心跳回应（op=3）也是入站帧。
    #[tokio::test]
    async fn inbound_frames_keep_the_connection_alive() {
        let live = BiliLive::new().unwrap();
        let limits = test_limits();
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let verify = Notify::new();
        // 认证成功之后每 20ms 来一个 op=3 心跳回应（远密于 120ms 的僵死阈值）。
        let ticks = futures_util::stream::unfold(0u32, |n| async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            if n > 40 {
                return None;
            }
            Some((
                Ok::<_, tokio_tungstenite::tungstenite::Error>(frame(
                    proto::OP_POPULARITY,
                    &(n + 1).to_be_bytes(),
                )),
                n + 1,
            ))
        });
        let items: Frames = vec![Ok(verify_frame(0))];
        let mut stream = Box::pin(futures_util::stream::iter(items).chain(ticks));
        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                cancel.cancel();
            })
        };
        let outcome = live
            .read_loop(1, &sink, &cancel, &verify, &limits, &mut stream, &test_diag())
            .await;
        canceller.await.unwrap();
        assert_eq!(outcome.end, End::Live, "有入站帧就不得判僵死");
        assert!(outcome.verified);
    }

    /// §8.1：认证成功即发首包心跳——不等一个周期，更不等 60 秒。
    /// 等满 60 秒才发首包，会让一部分候选节点一直把我们挂在「心跳未建立」上
    /// （表现就是能认证、能回心跳，但不下发弹幕）。
    #[tokio::test]
    async fn first_heartbeat_goes_out_right_after_verify() {
        let limits = test_limits();
        let sink = RecordingSink::default();
        let frames = sink.frames();
        let verify = Arc::new(Notify::new());
        let session = Cancel::new();
        let task = tokio::spawn(heartbeat_loop(
            sink,
            1,
            Arc::clone(&verify),
            session.clone(),
            limits.heartbeat_period,
        ));

        // 认证还没成功：先等满 3 个周期，确认一个心跳都没发（不是「还没到点」）。
        tokio::time::sleep(limits.heartbeat_period * 3).await;
        assert!(
            frames.lock().expect("lock poisoned").is_empty(),
            "认证成功之前不得发心跳（上游会把未认证的包按异常处置）"
        );

        let notified = Instant::now();
        verify.notify_one();
        until(
            || !frames.lock().expect("lock poisoned").is_empty(),
            Duration::from_millis(500),
        )
        .await;
        assert!(
            notified.elapsed() < limits.heartbeat_period,
            "首包必须立刻发，不能等到一个周期之后（实测 {:?}）",
            notified.elapsed()
        );
        let first = frames.lock().expect("lock poisoned")[0].clone();
        let header = proto::Header::parse(&first).unwrap();
        assert_eq!(header.op, proto::OP_HEARTBEAT);
        assert_eq!(header.protover, proto::PROTOVER_HEARTBEAT);
        assert_eq!(&first[16..], HEARTBEAT_BODY, "心跳体是字面量（§8.1）");

        // 之后按周期继续发。
        until(
            || frames.lock().expect("lock poisoned").len() >= 2,
            Duration::from_millis(1000),
        )
        .await;
        session.cancel();
        task.await.unwrap();
    }

    /// §15.3：同一节点连续失败 2 次后换 `host_list` 下一项，轮完一轮回到首项。
    #[tokio::test]
    async fn node_rotation_switches_after_two_consecutive_failures() {
        const HOSTS: usize = 3;
        let limits = test_limits();
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let starts = Arc::new(StdMutex::new(Vec::new()));
        let runner = {
            let sink = sink.clone();
            let cancel = cancel.clone();
            let starts = Arc::clone(&starts);
            tokio::spawn(async move {
                reconnect_loop(1, &sink, &cancel, &limits, |node_start| {
                    let index = node_start % HOSTS;
                    starts.lock().expect("lock poisoned").push(index);
                    // 传输层失败：认证失败会让连续认证失败计数先到上限而停在 Failed，
                    // 那不是本用例要看的轴。
                    async move {
                        Attempt::new(&test_diag(), End::Failed("模拟掉线".into()), false, Some(index))
                    }
                })
                .await
            })
        };
        until(
            || starts.lock().expect("lock poisoned").len() >= 7,
            Duration::from_millis(3000),
        )
        .await;
        cancel.cancel();
        runner.await.unwrap().unwrap();
        let seen = starts.lock().expect("lock poisoned").clone();
        assert_eq!(
            &seen[..7],
            &[0, 0, 1, 1, 2, 2, 0],
            "同一节点连续失败 2 次就换下一项，轮完一轮回到首项：{seen:?}"
        );
    }
}
