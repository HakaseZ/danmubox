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

use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use danmubox_core::ports::{LiveSource, UserProfile};
use danmubox_core::{
    Cancel, ConnState, Counters, Error, Message, MessageKind, MessageSink, Result, Room,
    RoomSession,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::cmd;
use crate::http::{BiliHttp, REFERER_LIVE, UA};
use crate::profile::BiliProfile;
use crate::proto::{self, Decoded};

/// 重连退避起点与上限（`docs/contract.md` §4）。
pub const INITIAL_BACKOFF: Duration = Duration::from_secs(5);
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// 上游 HTTP 心跳周期。
const HTTP_HEARTBEAT_PERIOD: Duration = Duration::from_secs(60);
/// 会话短于该时长视为「未真正建立」，不重置退避，避免紧循环重连。
///
/// **未认证成功过的尝试一律不算会话**，哪怕它把候选表逐个拨到超时、耗时远超本阈值：
/// 那不是「健康的会话掉线」，是「压根没连上」—— 只看时长会让网络黑洞（每个候选都
/// 拨号超时）落进「健康会话」那一档，5/10/20/40/60 的升级于是永不生效。
/// 两条判据（认证成功过 + 活过本阈值）在 `reconnect_loop` 的 `healthy` 那一行合取。
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
    /// 「健康会话」阈值（§13.2 的「连接成功后退避复位」）：**认证成功过**且活过它，
    /// 退避才回到起点；两条缺一都不算健康（`HEALTHY_SESSION`）。
    healthy_session: Duration,
    /// 退避起点与封顶（§13.2）。
    backoff_initial: Duration,
    backoff_max: Duration,
}

impl Default for Limits {
    /// 生产值，逐条对应文档：认证超时 10s（§7.3）、僵死 90s（§8.1）、
    /// 心跳 30s（§8.1）、认证失败上限 3（§13.2）、同节点失败 2 次换节点（§15.3）、
    /// 健康会话 30s（§13.2 的退避复位条件）。
    fn default() -> Self {
        Self {
            auth_timeout: Duration::from_secs(10),
            inbound_stale: Duration::from_secs(90),
            heartbeat_period: Duration::from_secs(30),
            auth_failure_limit: 3,
            node_failure_limit: 2,
            healthy_session: HEALTHY_SESSION,
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
}

impl Attempt {
    fn new(end: End, verified: bool, host: Option<usize>) -> Self {
        Self {
            end,
            verified,
            host,
        }
    }
}

/// 大航海合并器的定时分支（`docs/protocol.md` §10.6）：等到 `deadline` 就放行那条
/// 「窗口内没等到播报」的购买事件。
///
/// `deadline` 为 `None`（没有压着的购买事件）时返回一个**永不就绪**的 future ——
/// `select!` 因此不会为了它被唤醒，连接空闲时一个多余的定时器都没有。
async fn guard_flush_when_due(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending::<()>().await,
    }
}

/// 缺头像的消息最多等多久才上屏（`REQUIREMENTS.md` §三 3.5 给的**硬上限**）。
///
/// 到期即照常投递（`face` 留空串），由界面那头行内惰性补取（需求 3.6）——
/// 「等 600ms」与「一点都不等」之间只差首屏那一拍，绝不能因为等头像把弹幕卡住。
const FACE_WAIT: Duration = Duration::from_millis(600);

/// 「头像待补」的到期分支（需求 3.6）：队头等满了 [`FACE_WAIT`] 就放行它（`face` 留空）。
///
/// `deadline` 为 `None`（队列空）时返回一个**永不就绪**的 future —— 与
/// [`guard_flush_when_due`] 同一手法，连接空闲时不为它多起一个定时器。
async fn face_flush_when_due(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending::<()>().await,
    }
}

/// 排在「头像待补」队列里的一条消息（需求 3.5）。
struct FacePending {
    message: Message,
    /// 取数任务回填的槽位：`Some` 时里面的 `None` / `Some(face)` 分别表示「还在等」与「到位」
    /// （`Some("")` = 上游没给，按无头像上屏）。**本来就带头像的消息没有槽位**，走到队头即放行。
    slot: Option<Arc<StdMutex<Option<String>>>>,
    /// 这一条的等待上限 = 到达时刻 + [`FACE_WAIT`]。
    deadline: tokio::time::Instant,
}

impl FacePending {
    /// 结果已到位（`""` 也算到位：那是「上游没给」的结论）。
    fn filled(&self) -> bool {
        self.slot
            .as_ref()
            .is_some_and(|slot| slot.lock().expect("face slot poisoned").is_some())
    }

    /// 可以上屏了吗：本来就带头像、结果到位、或已经等过头（需求 3.6 的超时先上屏）。
    fn ready(&self, now: tokio::time::Instant) -> bool {
        self.slot.is_none() || self.filled() || now >= self.deadline
    }

    /// 取走到位的结果；`None` = 还在等（或本来就不需要补），上屏时保持原样。
    fn take_face(&self) -> Option<String> {
        self.slot
            .as_ref()
            .and_then(|slot| slot.lock().expect("face slot poisoned").clone())
    }
}

/// 「头像待补」队列（需求 §三 3.5 / 3.6）。
///
/// 三条口径：
///
/// 1. **按到达顺序放行**：队头不放行，后面的不许越过它 —— 否则一条大航海会把随后到达的弹幕
///    甩到自己前面（界面按投递顺序落行，顺序一乱就是「时间线跳了一下」）。代价是队头最多把
///    后面压 [`FACE_WAIT`]，此后一律放行（需求 3.6）。
/// 2. **不阻塞收包循环**：本结构只登记，取数由调用方 `spawn`；队头「结果到位」或「到期」
///    由 `select!` 的两个分支唤醒（[`face_flush_when_due`] 与 [`FaceWait::notify`]）。
/// 3. **连接收尾一并放行**（[`FaceWait::take_pending`]）：断连时还压着的消息照投、`face` 留空，
///    与 `cmd::GuardMerge::take_pending` 同一口径 —— 不然那条大航海会随断连一起消失。
struct FaceWait {
    queue: VecDeque<FacePending>,
    /// 取数任务回填后唤醒读循环。没有它，队头只能等满 `deadline` 才上屏，
    /// 需求 3.5 的「头像到位再上屏」就退化成「一律等 600ms」。
    notify: Arc<Notify>,
}

impl Default for FaceWait {
    fn default() -> Self {
        Self {
            queue: VecDeque::new(),
            notify: Arc::new(Notify::new()),
        }
    }
}

impl FaceWait {
    /// 这条消息需要按 uid 补头像吗？返回要问的 uid。
    ///
    /// 默认只有 `guard` / `gift` / `superchat` 三类需要现取；但 `interact` 也要纳入——
    /// 互动里**点赞**（`LIKE_INFO_V3_CLICK`）的载荷只有 `uname` / `uid` / `like_text`，
    /// 没有头像字段（`message_stream.md` 实测），而**关注 / 进场 / 分享**的 `interact`
    /// 已自带 `uinfo.base.face`（或 protobuf `user_info.base.face`），被下面第一行
    /// `!message.face.is_empty()` 拦掉、不会重复问。所以放开 `interact` 后，真正去问上游的
    /// 只有「face 为空」的那一条点赞（需求：所有点赞按 uid 现取头像，来源
    /// `UserProfile::face_of` → `x/space/wbi/acc/info`，`profile.rs`）。
    ///
    /// 已经有头像、或 uid 不可用（系统消息、游客弹幕的 `uid = 0`）→ `None`（**不问上游**）。
    fn needs_face(message: &Message) -> Option<i64> {
        if !message.face.is_empty() || message.uid <= 0 {
            return None;
        }
        matches!(
            message.kind,
            MessageKind::Guard | MessageKind::Gift | MessageKind::Superchat | MessageKind::Interact
        )
        .then_some(message.uid)
    }

    /// 入列一条消息。返回 `Some(槽位)` = 调用方要 `spawn` 取数任务并把结果写进槽位；
    /// `None` = 这条不需要补（走到队头即放行，但**照样排队**，见结构说明第 1 条）。
    fn enqueue(
        &mut self,
        message: Message,
        uid: Option<i64>,
        now: tokio::time::Instant,
    ) -> Option<Arc<StdMutex<Option<String>>>> {
        let slot = uid.map(|_| Arc::new(StdMutex::new(None)));
        self.queue.push_back(FacePending {
            message,
            slot: slot.clone(),
            deadline: now + FACE_WAIT,
        });
        slot
    }

    /// 放行队头所有可以上屏的消息（结果到位 / 已到期 / 本来就带头像）。
    fn flush(&mut self, now: tokio::time::Instant, sink: &MessageSink) {
        while self.queue.front().is_some_and(|head| head.ready(now)) {
            let pending = self.queue.pop_front().expect("刚看过队头");
            sink.publish_message(with_face(pending));
        }
    }

    /// 队头还压着的话，它最晚什么时候到期（`None` = 队列空，不 arm 定时器）。
    fn deadline(&self) -> Option<tokio::time::Instant> {
        self.queue.front().map(|head| head.deadline)
    }

    /// 连接收尾：把还压着的消息全部放行（头像没到就留空），按到达顺序返回。
    fn take_pending(&mut self) -> Vec<Message> {
        self.queue.drain(..).map(with_face).collect()
    }
}

/// 把到位的结果写回消息（没到 / 不需要补就原样返回）。
fn with_face(pending: FacePending) -> Message {
    let face = pending.take_face();
    let mut message = pending.message;
    if let Some(face) = face {
        message.face = face;
    }
    message
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
    /// 大航海按笔合并器（`cmd::GuardMerge`）：活在**房间运行时**这一层，不是每次连接 ——
    /// 同一笔购买的两条载荷完全可能分处两次连接（`GUARD_BUY` 在这条、播报在下一条），
    /// 每次连接新建一个就认不出是同一笔，于是「一笔买出两行」（用户 2026-09-22 第 4 条）。
    ///
    /// 用同步锁而不是把 `&mut` 传进 `read_loop`：`read_loop` 之上是重连循环的 `FnMut`
    /// 闭包，把 `&mut` 借进闭包返回的 future 会要求 `Fut` 带上调用点的生命周期；
    /// 而会话的 future 必须 `Send`，也不能把 `MutexGuard` 挂在 await 上。
    /// 临界区里只做一次 HashMap 操作，不跨 await。
    guard_merge: StdMutex<cmd::GuardMerge>,
    /// 互动（进场）同源去重器（`cmd::InteractMerge`）：与上面同一个理由活在这一层 ——
    /// 同一次进场的两条载荷同样可能分处两条连接。
    interact_merge: StdMutex<cmd::InteractMerge>,
    /// 头像来源（`docs/contract.md` §3 `UserProfile`）：大航海 / V1 礼物 / 缺头像的 SC
    /// 靠它按 uid 现取（需求 3.2–3.4）。取数本身在 [`BiliProfile`] 里带**进程级**缓存，
    /// 因此本层每次连接各持一份也不影响「同一 uid 只问一次上游」。
    ///
    /// `Arc<dyn ...>` 而不是具体类型：单测要注入一个指向本地桩的实现 ——
    /// 否则每喂一条大航海帧，测试就会真的去问一次上游（还要等 3 秒超时）。
    profile: Arc<dyn UserProfile>,
}

impl BiliLive {
    pub fn new() -> Result<Self> {
        Self::with_cookie(None)
    }

    /// `cookie` 为完整 Cookie 串；`None` 即游客态。
    pub fn with_cookie(cookie: Option<String>) -> Result<Self> {
        let http = BiliHttp::with_cookie(cookie)?;
        Ok(Self {
            // 头像来源复用**同一个**客户端（连接池、Cookie 来源、超时都在它身上）：
            // 为此再多建一个 reqwest 客户端只会多一处 Cookie 状态源。
            profile: Arc::new(BiliProfile::from_http(http.clone())),
            http,
            counters: Arc::new(Counters::default()),
            buvid3: Mutex::new(None),
            store: None,
            guard_merge: StdMutex::new(cmd::GuardMerge::new()),
            interact_merge: StdMutex::new(cmd::InteractMerge::new()),
        })
    }

    /// 凭据来自凭据文件：登录态与游客态由文件内容决定（`docs/contract.md` §4.1）。
    pub fn with_store(store: Arc<danmubox_core::ConfigStore>) -> Result<Self> {
        let http = BiliHttp::with_store(Arc::clone(&store))?;
        Ok(Self {
            profile: Arc::new(BiliProfile::from_http(http.clone())),
            http,
            counters: Arc::new(Counters::default()),
            buvid3: Mutex::new(None),
            store: Some(store),
            guard_merge: StdMutex::new(cmd::GuardMerge::new()),
            interact_merge: StdMutex::new(cmd::InteractMerge::new()),
        })
    }

    /// 仅测试：换掉头像来源（默认那份会真的去问上游）。
    #[cfg(test)]
    fn with_profile(mut self, profile: Arc<dyn UserProfile>) -> Self {
        self.profile = profile;
        self
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
    ) -> Attempt {
        let buvid3 = match self.buvid3().await {
            Ok(buvid3) => buvid3,
            Err(err) => {
                return Attempt::new(End::Failed(format!("取 buvid3 失败: {err}")), false, None)
            }
        };
        let info = match self.http.danmu_info(room_id, &buvid3).await {
            Ok(info) => info,
            Err(err) => {
                return Attempt::new(
                    End::Failed(format!("getDanmuInfo 失败: {err}")),
                    false,
                    None,
                )
            }
        };
        if info.hosts.is_empty() {
            return Attempt::new(End::Failed("host_list 为空".into()), false, None);
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
                    connected = Some((index, host.clone(), stream));
                    break;
                }
                Ok(Err(err)) => {
                    tracing::warn!(room_id, index, host = %host, %err, "节点连接失败，尝试下一个");
                    last_error = format!("{host} 连接失败: {err}");
                }
                Err(_) => {
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
            return Attempt::new(End::Failed(last_error), false, Some(first));
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
                End::Failed(format!("发送认证包失败: {err}")),
                false,
                Some(host_index),
            );
        }
        // 认证包确实写出去了才算「已发出」（§7.3 的 10 秒从这一刻起算）。
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

        // 头像待补队列**每次连接一份**：压在里面的消息只等 600ms，跨连接没有意义。
        let mut face_wait = FaceWait::default();
        let outcome = self
            .read_loop(
                room_id,
                sink,
                cancel,
                &verify,
                limits,
                &mut read,
                &mut face_wait,
            )
            .await;

        session.cancel();
        heartbeat_ws.abort();
        heartbeat_http.abort();
        Attempt {
            host: Some(host_index),
            ..outcome
        }
    }

    /// 大航海：同一笔的两条载荷在这里合成**一条**（`cmd::GuardMerge`，§10.6 / §12.3）。
    /// 返回 `None` = 这一条要压着等播报，或是同一笔已投过之后的第二条。
    fn absorb_guard(&self, message: Message, source: cmd::GuardSource) -> Option<Message> {
        self.guard_merge
            .lock()
            .expect("guard merge poisoned")
            .absorb(tokio::time::Instant::now(), message, source)
    }

    /// 大航海窗口到期：放出「没等到播报」的购买事件（金额留 0）。
    fn flush_guard(&self) -> Option<Message> {
        self.guard_merge
            .lock()
            .expect("guard merge poisoned")
            .flush(tokio::time::Instant::now())
    }

    /// 大航海还压着的购买事件最早什么时候到期（`None` = 没有待放项，不起定时器）。
    fn guard_deadline(&self) -> Option<tokio::time::Instant> {
        self.guard_merge
            .lock()
            .expect("guard merge poisoned")
            .deadline()
    }

    /// 把一条归一化消息交给「头像待补」队列（或立即投递）。
    ///
    /// **绝不 `await`**：需要补头像时只 `spawn` 一个取数任务并登记槽位，读循环立刻回去读下一帧
    /// —— 这是需求 3.5 的硬要求（等待不得阻塞收包循环）。放行由 `read_loop_inner` 的两个分支
    /// 负责：队头到期（[`face_flush_when_due`]）与结果到位（[`FaceWait::notify`]）。
    fn queue_message(&self, sink: &MessageSink, wait: &mut FaceWait, message: Message) {
        let uid = FaceWait::needs_face(&message);
        let slot = wait.enqueue(message, uid, tokio::time::Instant::now());
        if let (Some(uid), Some(slot)) = (uid, slot) {
            let profile = Arc::clone(&self.profile);
            let notify = Arc::clone(&wait.notify);
            tokio::spawn(async move {
                // 取不到就是空串（需求 3.3）：这里没有错误分支，也**不许**失败重试
                // （重试会让同一条消息的上游请求变成两次，去重在 `BiliProfile` 的缓存里）。
                let face = profile.face_of(uid).await;
                *slot.lock().expect("face slot poisoned") = Some(face);
                notify.notify_one();
            });
        }
        wait.flush(tokio::time::Instant::now(), sink);
    }

    /// 互动（进场）：同一次进场的两条载荷只投第一条（`cmd::InteractMerge`，§10.4）。
    fn absorb_interact(&self, message: Message) -> Option<Message> {
        self.interact_merge
            .lock()
            .expect("interact merge poisoned")
            .absorb(tokio::time::Instant::now(), message)
    }

    /// 读循环的外层：与 [`Self::read_loop_inner`] 只差**大航海按笔合并器**与
    /// **头像待补队列**的收尾。
    ///
    /// 两处都要在退出前把还压着的东西放出去（[`cmd::GuardMerge::take_pending`] 与
    /// [`FaceWait::take_pending`]），而内层有 5 条 `return` 出口（取消 / 认证超时 / 僵死 /
    /// 对端关闭 / 读失败），统一收在这一层才不会漏 —— 否则那条开通播报会随断连一起消失。
    ///
    /// 合并器本身由 [`BiliLive`] 持有（**不随连接重建**，理由见那两个字段的注释）；
    /// **头像队列则是每次连接一份**（压在里面的消息只等 600ms，跨连接没有意义），
    /// 由调用方建好传进来 —— 于是收尾处的两次放行都落在同一个队列上，
    /// 单测也能直接观察它（与 `Limits` 注入同一理由）。
    ///
    /// 收尾顺序：先把合并器放出的购买事件**过一遍头像队列**（那条大航海同样要补头像），
    /// 再把头像队列整个放行 —— 断连时不再等谁，`face` 留空照投。
    ///
    /// `#[allow(clippy::too_many_arguments)]`：入参就是「会话内五件套 + 入站流 + 头像队列」，
    /// 收成结构只是把同一串东西换个地方写（与 [`Self::read_loop_inner`] 的取舍一致）。
    /// 头像队列必须是**注入的**：它由调用方建、给单测直接观察（同 `Limits` 的理由）。
    #[allow(clippy::too_many_arguments)]
    async fn read_loop<S>(
        &self,
        room_id: i64,
        sink: &MessageSink,
        cancel: &Cancel,
        verify: &Notify,
        limits: &Limits,
        read: &mut S,
        face_wait: &mut FaceWait,
    ) -> Attempt
    where
        S: futures_util::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        let attempt = self
            .read_loop_inner(room_id, sink, cancel, verify, limits, read, face_wait)
            .await;
        for message in self
            .guard_merge
            .lock()
            .expect("guard merge poisoned")
            .take_pending(tokio::time::Instant::now())
        {
            self.queue_message(sink, face_wait, message);
        }
        for message in face_wait.take_pending() {
            sink.publish_message(message);
        }
        attempt
    }

    /// 读循环本体：解包投递，并守住两条时间护栏（`docs/protocol.md` §7.3 认证超时、
    /// §8.1 僵死判定）。
    ///
    /// 返回的 [`Attempt`] 里 `host` 是空的：`host_list` 只有 [`BiliLive::run_once`] 见过，
    /// 由它补上。
    ///
    /// 参数多是因为它同时握着「会话内五件套」（投递口 / 取消 / 认证回应通知 / 护栏阈值 /
    /// 入站流）加上头像待补队列 —— 收成结构只会让调用点更长，
    /// 与 `send::build_params` 同一取舍（那里的 `#[allow]` 注释同样说明了这点）。
    #[allow(clippy::too_many_arguments)]
    async fn read_loop_inner<S>(
        &self,
        room_id: i64,
        sink: &MessageSink,
        cancel: &Cancel,
        verify: &Notify,
        limits: &Limits,
        read: &mut S,
        face_wait: &mut FaceWait,
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
            // 大航海按笔合并的到期时刻（`docs/protocol.md` §10.6）：只有真压着「等播报的
            // 购买事件」时才有值，没有时不 arm 分支 —— 移动端不该为此常驻唤醒。
            let guard_deadline = self.guard_deadline();
            // 头像待补的两个唤醒源（需求 3.5 / 3.6）：
            // - `face_deadline` 到期 → 队头等满 600ms，照常上屏（`face` 留空）；
            // - `face_notify` 被取数任务叫醒 → 头像到位，立刻放行。
            // `Notify` 的克隆是为了**租借互不打扰**：`notified()` 借的是这个局部 `Arc`，
            // 分支体里 mutate `face_wait` 才不会与它冲突（`select!` 各分支的 future 在分支体
            // 执行时仍然存活）；`notify_one` 有许可语义，因此不会漏掉「上一轮就绪」的唤醒。
            let face_deadline = face_wait.deadline();
            let face_notify = Arc::clone(&face_wait.notify);
            tokio::select! {
                _ = guard_flush_when_due(guard_deadline) => {
                    if let Some(message) = self.flush_guard() {
                        // 放出来的购买事件同样要补头像（它就是一条大航海行）。
                        self.queue_message(sink, face_wait, message);
                    }
                }
                _ = face_flush_when_due(face_deadline) => {
                    face_wait.flush(tokio::time::Instant::now(), sink);
                }
                _ = face_notify.notified() => {
                    face_wait.flush(tokio::time::Instant::now(), sink);
                }
                _ = cancel.cancelled() => {
                    let end = if verified { End::Live } else { End::Cancelled };
                    return Attempt::new(end, verified, None);
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
                                End::Failed("连接已被对端关闭".into()),
                                verified,
                                None,
                            );
                        }
                        Some(Err(err)) => {
                            return Attempt::new(
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
                    match message {
                        WsMessage::Binary(bytes) => {
                            let mut decoded = Vec::new();
                            proto::decode_stream(&bytes, &self.counters, &mut decoded);
                            for item in decoded {
                                match item {
                                    Decoded::Business(value) => {
                                        // 观众数走单独支路：它不进会话缓冲，只更新界面数字。
                                        match cmd::dispatch(room_id, &value, &self.counters) {
                                            Some(cmd::Dispatch::Message(message)) => {
                                                // 互动（进场）先过同源去重：同一次进场上游推两条
                                                // 载荷（`ENTRY_EFFECT` 与 `INTERACT_WORD(_V2)`），
                                                // 两条都投就是「XX 进入直播间」连着两行（§10.4）。
                                                let message =
                                                    if message.kind == MessageKind::Interact {
                                                        match self.absorb_interact(message) {
                                                            Some(message) => message,
                                                            None => continue,
                                                        }
                                                    } else {
                                                        message
                                                    };
                                                // 走头像队列：缺头像的大航海 / V1 礼物 / SC
                                                // 在这里等一次短时限（需求 3.5），其余消息照投。
                                                self.queue_message(sink, face_wait, message);
                                            }
                                            // 大航海：同一笔购买的 `GUARD_BUY` 与
                                            // `USER_TOAST_MSG` 在这里合成**一条**播报
                                            // （§10.6 / §12.3），金额取实付那一份。
                                            Some(cmd::Dispatch::Guard { message, source }) => {
                                                if let Some(message) =
                                                    self.absorb_guard(message, source)
                                                {
                                                    self.queue_message(sink, face_wait, message);
                                                }
                                            }
                                            Some(cmd::Dispatch::RoomStats {
                                                online,
                                                watched,
                                            }) => sink.publish_room_stats(room_id, online, watched),
                                            // `LIVE` / `PREPARING`：先照旧投那条 `system` 消息
                                            // （缓冲里的先后顺序与从前一致），再把开播状态冒泡给
                                            // 界面 —— 用户 2026-09-16 报的「开播下播时状态不会自动
                                            // 更新」就靠这第二条（`docs/protocol.md` §10.7 的侧路）。
                                            Some(cmd::Dispatch::LiveStatus {
                                                message,
                                                live_status,
                                            }) => {
                                                sink.publish_message(message);
                                                sink.publish_live_status(room_id, live_status);
                                            }
                                            // `ROOM_CHANGE`：同样是「先投消息、再冒泡」——
                                            // 主播改了标题时，界面上挂着的旧标题要原地换掉
                                            // （issue202609241553 第 6 条）。房间号以**连接上下文**
                                            // 为准（`cmd.rs` 用 `dispatch` 的 `room_id`，不再是载荷里的
                                            // `data.room_id`——后者可能是短号，与登记表 key 对不上）。
                                            Some(cmd::Dispatch::RoomTitle {
                                                message,
                                                room_id,
                                                title,
                                            }) => {
                                                sink.publish_message(message);
                                                sink.publish_room_title(room_id, title);
                                            }
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
        if cancel.is_cancelled() {
            return Ok(());
        }
        // 「健康会话」= **两条同时满足**：
        // ① 认证成功过（`op=8` 且 `code=0`）—— 从没认证成功的尝试不是「掉线的会话」，
        //    是「压根没连上」，它没有资格把退避重置回起点；
        // ② 活过 HEALTHY_SESSION —— 刚握上就被断的算不上健康。
        // 只看时长会漏掉网络黑洞那一类：3 个候选各 10 秒拨号超时 = 一次尝试 30 秒 ≥ 阈值，
        // 于是每次都被判成健康会话、退避每次回到 5 秒，5/10/20/40/60 的升级实际不生效
        // （`docs/operations.md` §2.10.5 ②。回归单测：
        // `unverified_attempt_past_the_healthy_threshold_does_not_reset_the_backoff`）。
        let healthy = outcome.verified && started.elapsed() >= limits.healthy_session;

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

    /// 列表页定期刷新用（`docs/contract.md` §4）：只读一次 `getRoomPlayInfo`，不做昵称标题那一跳。
    async fn live_status(&self, room_id: i64) -> Result<i32> {
        self.http.room_live_status(room_id).await
    }

    async fn room_identity(&self, room_id: i64) -> Result<RoomSession> {
        // 游客态没有「本人身份」可言：不发请求，直接给全零身份。
        if !self
            .store
            .as_ref()
            .map(|s| s.is_logged_in())
            .unwrap_or(false)
        {
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
        // 先把这两个借用取出来：下面的 `async move` 要按值捕获 `node_start`，
        // 直接捕获 `sink` / `cancel` 会被理解成「把会话本身搬进闭包」，`FnMut` 搬不动。
        let (sink, cancel) = (&sink, &cancel);
        reconnect_loop(room_id, sink, cancel, &limits, |node_start| async move {
            self.run_once(room_id, sink, cancel, &limits, node_start)
                .await
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
/// `healthy` 由调用方按**两条**判据合取后传进来（`reconnect_loop` 的 `healthy` 那一行）：
/// **认证成功过**（`outcome.verified`）**且**活过 `HEALTHY_SESSION` —— 这样的连接算「健康会话」，
/// 它的中断是偶发的，退避回到 `initial`（生产的 5 秒起点）。其余的一律继续 `next_backoff`
/// 递增、`max` 封顶：连不上（含「把候选表逐个拨到超时」）、认证失败、刚握手就被断。
/// 旧实现把重置写在「被取消」那一支里，掉线走的是另一支，于是每次掉线都把退避翻倍、
/// **从不回落**：断连后要干等一分钟才重连，用户看到的就是「断了就回不来了」。
/// 反过来，把「活得久」当成健康的唯一判据又是另一个坑（网络黑洞里每次尝试都够久，
/// 升级永不生效）—— 所以两条缺一不可。
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

    /// 一次健康会话掉线之后，退避必须回到起点。
    ///
    /// 这里的 `true` 是 [`reconnect_loop`] 合取两条判据之后的结论：**认证成功过**
    /// （`outcome.verified`）**且**活过 `HEALTHY_SESSION`。缺任一条都不算健康会话
    /// （另见 `unverified_attempt_past_the_healthy_threshold_does_not_reset_the_backoff`）。
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
        assert!(
            parse_room_identity(1, &value).is_admin,
            "admin_level>0 也是房管"
        );
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
    /// 生产值见 [`Limits::default`]（10s / 90s / 30s / 3 / 2 / 30s / 5s / 60s）。
    fn test_limits() -> Limits {
        Limits {
            auth_timeout: Duration::from_millis(40),
            inbound_stale: Duration::from_millis(120),
            heartbeat_period: Duration::from_millis(100),
            auth_failure_limit: 3,
            node_failure_limit: 2,
            // 既有用例的每次尝试都是瞬时收场，因此这里的取值只影响本文件里
            // 专门跑「活过阈值」的那两条用例（它们各自再覆盖成毫秒级）。
            healthy_session: Duration::from_millis(100),
            backoff_initial: Duration::from_millis(25),
            backoff_max: Duration::from_millis(50),
        }
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

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(
            self: Pin<&mut Self>,
            item: WsMessage,
        ) -> std::result::Result<(), Self::Error> {
            if let WsMessage::Binary(bytes) = item {
                self.frames
                    .lock()
                    .expect("lock poisoned")
                    .push(bytes.to_vec());
            }
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
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
                        End::AuthFailed("认证超时：40ms 内未收到 op=8".into()),
                        false,
                        Some(node_start),
                    )
                }
            })
            .await
        })
    }

    /// 跑一个「每次尝试都**活过** `limits.healthy_session` 阈值」的重连循环：
    /// `verified` 决定它落在哪一档 —— `false` 是「压根没连上，只是把候选表逐个拨到
    /// 超时」，`true` 是「认证成功过、活过阈值又掉线」。两条判据（认证成功过 + 活过阈值）
    /// 由这对用例分别钉住。
    ///
    /// 回报的是**每次尝试的起始时刻**：退避只体现在「两次尝试之间等了多久」上，因此断言
    /// 读墙钟差值（与 [`spawn_auth_failing_loop`] 同一口径）。每次尝试自己固定睡
    /// `attempt_span`，减掉它就是循环算出的那次退避（带 ±20% 抖动）。
    fn spawn_past_threshold_failing_loop(
        sink: &MessageSink,
        cancel: &Cancel,
        limits: &Limits,
        attempt_span: Duration,
        verified: bool,
        times: Arc<StdMutex<Vec<Instant>>>,
    ) -> tokio::task::JoinHandle<Result<()>> {
        let sink = sink.clone();
        let cancel = cancel.clone();
        let limits = *limits;
        tokio::spawn(async move {
            reconnect_loop(1, &sink, &cancel, &limits, |node_start| {
                times.lock().expect("lock poisoned").push(Instant::now());
                async move {
                    // 一次尝试的时长：拨号超时 / 认证成功后的长连都只会更慢，不会更快。
                    tokio::time::sleep(attempt_span).await;
                    Attempt::new(
                        End::Failed("候选节点连接超时 / 掉线（语义由 verified 区分）".into()),
                        verified,
                        Some(node_start),
                    )
                }
            })
            .await
        })
    }

    /// 跑满 3 次尝试之后收场，返回相邻两次尝试之间的间隔（顺序 = 尝试顺序）。
    ///
    /// 要 3 次才够：这一段循环算出的退避作用在「这一次尝试之后」，
    /// 因此第 2 段间隔才是第二次尝试之后那次退避的读数 —— 而它正是两条判据分出胜负的地方。
    async fn run_past_threshold_loop(
        limits: &Limits,
        attempt_span: Duration,
        verified: bool,
    ) -> Vec<Duration> {
        let (sink, _bus) = test_sink();
        let cancel = Cancel::new();
        let times = Arc::new(StdMutex::new(Vec::new()));
        let runner = spawn_past_threshold_failing_loop(
            &sink,
            &cancel,
            limits,
            attempt_span,
            verified,
            Arc::clone(&times),
        );
        until(
            || times.lock().expect("lock poisoned").len() >= 3,
            Duration::from_millis(2000),
        )
        .await;
        cancel.cancel();
        runner.await.unwrap().unwrap();
        let starts = times.lock().expect("lock poisoned").clone();
        starts.windows(2).map(|pair| pair[1] - pair[0]).collect()
    }

    /// 这一对用例的量程：起点档 / 翻倍档各 200ms / 400ms，抖动 ±20%。
    ///
    /// 档位取得比 [`test_limits`] 大，是为了让「持平」与「翻倍」在墙钟上真正分得开：
    /// 起点档的上沿（240ms）与翻倍档的下沿（320ms）之间留了 80ms 余量，
    /// 够吃下调度噪声，又不必真按秒级等（一次尝试仅 15ms）。
    fn threshold_limits() -> Limits {
        Limits {
            healthy_session: Duration::from_millis(12),
            backoff_initial: Duration::from_millis(200),
            backoff_max: Duration::from_millis(800),
            ..test_limits()
        }
    }

    /// 阶段目标 S1-AC9（阶段史见 `CHANGELOG.md` 归档区）：非 0 认证 code 一律按失败处理，且只记录原始值。
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
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut stream,
                &mut FaceWait::default(),
            )
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
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut stream,
                &mut FaceWait::default(),
            )
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
        let mut silent = Box::pin(futures_util::stream::pending::<
            std::result::Result<WsMessage, tokio_tungstenite::tungstenite::Error>,
        >());
        let started = Instant::now();
        let outcome = live
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut silent,
                &mut FaceWait::default(),
            )
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
        until(
            || times.lock().expect("lock poisoned").len() >= 3,
            Duration::from_millis(2000),
        )
        .await;
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
        assert!(!runner.is_finished(), "达上限必须停在原地，不得返回");
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

    /// **回归（改前必失败）**：未认证成功的尝试即便把候选表逐个拨到超时、**耗时超过
    /// 「健康会话」阈值**，也不算健康会话 —— 退避必须继续递增，不许回到 5 秒起点。
    ///
    /// 旧判据只看时长（`healthy = started.elapsed() >= HEALTHY_SESSION`），于是网络黑洞
    /// （`host_list` 上 3 个候选各 10 秒拨号超时 = 一次尝试 30 秒，生产阈值正是 30 秒）
    /// 每次都落进「健康会话」那一档 → 退避每次回到 5 秒，`5/10/20/40/60` 的升级实际不生效。
    #[tokio::test]
    async fn unverified_attempt_past_the_healthy_threshold_does_not_reset_the_backoff() {
        // 阈值 12ms、每次尝试 15ms：每次尝试都「活过阈值」，但从未认证成功。
        let limits = threshold_limits();
        let span = Duration::from_millis(15);
        let gaps = run_past_threshold_loop(&limits, span, false).await;

        assert_eq!(gaps.len(), 2, "3 次尝试之间应有 2 段间隔：{gaps:?}");
        // 间隔 = 一次尝试自己的 `span` + 循环算出的退避（±20% 抖动）：
        // 起点档 200ms → 间隔在 [span+160, span+240]；翻倍档 400ms → [span+320, span+480]。
        let escalated_lower = span + limits.backoff_initial.mul_f64(2.0 * 0.79);
        // 第一段还看不出判据（两次用例的第一轮都是起点档），但翻倍档的下沿是条硬线：
        // 越过它就说明第一轮不是起点档。
        assert!(
            gaps[0] < escalated_lower,
            "第一次退避是起点档（间隔应 < {escalated_lower:?}）：{gaps:?}"
        );
        assert!(
            gaps[1] >= escalated_lower,
            "未认证成功的尝试不得把退避重置回起点：第二次之后应等翻倍档（间隔 ≥ {escalated_lower:?}），实测 {:?}",
            gaps[1]
        );
    }

    /// 反向护栏：**认证成功过**且活过阈值的连接掉线之后，退避照旧回到 5 秒起点。
    ///
    /// 与上一条只差 `verified`：防的是「把回落整条改没」（那会让断线后的重连一次比一次慢，
    /// 正是 `a111720` 修掉的旧缺陷）。
    #[tokio::test]
    async fn verified_attempt_past_the_healthy_threshold_still_resets_the_backoff() {
        let limits = threshold_limits();
        let span = Duration::from_millis(15);
        let gaps = run_past_threshold_loop(&limits, span, true).await;

        assert_eq!(gaps.len(), 2, "3 次尝试之间应有 2 段间隔：{gaps:?}");
        // 健康会话每轮都把退避拉回起点档：两段间隔都在 [span+160, span+240]。
        // 翻倍档的下沿（span+320）是条硬线：越过它就意味着退避没被拉回起点。
        let initial_lower = span + limits.backoff_initial.mul_f64(0.79);
        let escalated_lower = span + limits.backoff_initial.mul_f64(2.0 * 0.79);
        assert!(
            gaps[1] < escalated_lower,
            "认证成功过又掉线 = 健康会话，退避必须回到起点（间隔应 < {escalated_lower:?}）：{gaps:?}"
        );
        assert!(
            gaps[1] >= initial_lower,
            "回落的目标是起点档（间隔应 ≥ {initial_lower:?}）：{gaps:?}"
        );
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
        until(
            || times.lock().expect("lock poisoned").len() >= 3,
            Duration::from_millis(2000),
        )
        .await;
        cancel.cancel();
        runner.await.unwrap().unwrap();
        assert_eq!(times.lock().expect("lock poisoned").len(), 3);

        // 「刷新」：换一个取消令牌 = 核心驱动重新调一次 `stream()`。
        let again = Arc::new(StdMutex::new(Vec::new()));
        let fresh = Cancel::new();
        let started = Instant::now();
        let runner = spawn_auth_failing_loop(&sink, &fresh, &limits, Arc::clone(&again));
        until(
            || !again.lock().expect("lock poisoned").is_empty(),
            Duration::from_millis(2000),
        )
        .await;
        assert!(
            started.elapsed() < limits.backoff_initial,
            "手动重连的第一步必须立即发起、不等退避（实测 {:?}）",
            started.elapsed()
        );
        // 计数归零：新一轮照样能连着试满 3 次，而不是一上来就停在 Failed。
        until(
            || again.lock().expect("lock poisoned").len() >= 3,
            Duration::from_millis(2000),
        )
        .await;
        assert_eq!(
            again.lock().expect("lock poisoned").len(),
            3,
            "手动重连后必须重新从 0 计数"
        );
        fresh.cancel();
        runner.await.unwrap().unwrap();
    }

    /// 同一次会话里的重连**不重置会话编号**（`docs/contract.md` §4.3：重连仍属同一次会话，
    /// 已收到的消息保留）。
    ///
    /// 这不是记账细节：界面按 `local_id` 做单调判定
    /// （`apps/desktop/ui/src/store.ts` 的 `message.local_id <= last` → 直接丢），
    /// 编号一旦在某次重连之后回退，之后进来的**每一条**弹幕都会被界面悄悄丢掉 ——
    /// 表现就是「房间看着已连接，却再也不进来弹幕」。
    /// 断连窗口里丢的帧补不回来（上游没有可翻页的回放，见 `docs/protocol.md` A30），
    /// 那是另一件事；这条只钉「重连之后新来的弹幕还能不能进列表」。
    #[tokio::test]
    async fn reconnect_keeps_the_session_numbering_monotonic() {
        let limits = test_limits();
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let cancel = Cancel::new();
        let times = Arc::new(StdMutex::new(Vec::new()));

        let runner = {
            let sink = sink.clone();
            let cancel = cancel.clone();
            let times = Arc::clone(&times);
            tokio::spawn(async move {
                reconnect_loop(1, &sink, &cancel, &limits, |node_start| {
                    // 每次尝试投一条再收场（「连接中断」）—— 循环会拿着**同一份** sink 再试一次。
                    let round = {
                        let mut t = times.lock().expect("lock poisoned");
                        t.push(Instant::now());
                        t.len()
                    };
                    let sink = sink.clone();
                    async move {
                        // 内容按轮次变化，避开「同一条的第二份」那个指纹窗口。
                        let mut message =
                            Message::new(1, danmubox_core::MessageKind::Danmaku, round as i64);
                        message.content = format!("第 {round} 轮");
                        sink.publish_message(message);
                        Attempt::new(
                            End::Failed("连接已被对端关闭".into()),
                            false,
                            Some(node_start),
                        )
                    }
                })
                .await
            })
        };

        until(
            || times.lock().expect("lock poisoned").len() >= 3,
            Duration::from_millis(2000),
        )
        .await;
        cancel.cancel();
        runner.await.unwrap().unwrap();

        let ids: Vec<u64> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                Event::Message(message) => Some(message.local_id),
                _ => None,
            })
            .collect();
        assert_eq!(
            ids,
            vec![1, 2, 3],
            "会话内编号从 1 起连续分配（跨重连不回退）：{ids:?}"
        );
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
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut stream,
                &mut FaceWait::default(),
            )
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
        assert!(outcome.verified, "是「认证成功之后不推弹幕」，不是认证问题");
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
                            End::Failed("僵死：距上次入站帧 120ms（阈值 120ms）".into()),
                            true,
                            Some(node_start),
                        )
                    }
                })
                .await
            })
        };
        until(
            || times.lock().expect("lock poisoned").len() >= 5,
            Duration::from_millis(3000),
        )
        .await;
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
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut stream,
                &mut FaceWait::default(),
            )
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
                    async move { Attempt::new(End::Failed("模拟掉线".into()), false, Some(index)) }
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

    /* ------------------------------------------------ 头像待补（需求 §三 3.2–3.6） */

    /// 一条业务帧（`op=5` + 裸 JSON，`docs/protocol.md` §9）。
    fn business_frame(cmd: &str, data: Value) -> WsMessage {
        let body = serde_json::json!({ "cmd": cmd, "data": data }).to_string();
        WsMessage::Binary(
            proto::build_packet(proto::OP_NOTICE, proto::PROTOVER_JSON, body.as_bytes()).into(),
        )
    }

    /// 合成（非真实）的资料响应：形状按社区文档（`code` + `data.face`）。
    const ACC_FACE: &str = r#"{"code":0,"message":"0","data":{"mid":42,"face":"https://i0.hdslb.com/bfs/face/xyz.jpg"}}"#;

    /// 一条缺头像的大航海播报（`USER_TOAST_MSG` 单独到达时立即投递，见
    /// `guard_toast_alone_is_published_immediately`，因此它一定会走到头像队列）。
    fn guard_toast_frame(uid: i64) -> WsMessage {
        business_frame(
            "USER_TOAST_MSG",
            serde_json::json!({
                "uid": uid, "username": "开舰长的人", "guard_level": 3, "num": 1,
                "price": 138000, "start_time": 1, "payflow_id": "pf-1"
            }),
        )
    }

    /// 只有**大航海 / 礼物 / 醒目留言 / 互动**且**还没有头像**时才按 uid 去问上游
    /// （需求 3.2 / 3.3）：互动里的点赞（`LIKE_INFO_V3_CLICK`）payload 不含头像，要按
    /// uid 现取；但关注 / 进场 / 分享的互动已自带 `uinfo.base.face`，不会重复问。弹幕头像
    /// 本来就有可靠来源；系统消息连 uid 都没有。
    #[test]
    fn guard_gift_superchat_and_interact_without_a_face_ask_upstream() {
        for (kind, uid, face, expected) in [
            (MessageKind::Guard, 42, "", Some(42)),
            (MessageKind::Gift, 42, "", Some(42)),
            (MessageKind::Superchat, 42, "", Some(42)),
            // 互动：缺头像的点赞按 uid 现取；已带 face 的关注 / 进场 / 分享不重复问。
            (MessageKind::Interact, 42, "", Some(42)),
            (
                MessageKind::Interact,
                42,
                "https://i0.hdslb.com/x.png",
                None,
            ),
            (MessageKind::Gift, 42, "https://i0.hdslb.com/x.png", None),
            (MessageKind::Guard, 0, "", None),
            (MessageKind::Danmaku, 42, "", None),
            (MessageKind::System, 0, "", None),
        ] {
            let mut message = Message::new(1, kind, 1);
            message.uid = uid;
            message.face = face.to_string();
            assert_eq!(FaceWait::needs_face(&message), expected, "kind={kind:?}");
        }
    }

    /// 需求 3.5：结果到位就立刻上屏，且**带着那个头像** —— 在它到位之前一条都不许先投。
    #[tokio::test]
    async fn face_wait_publishes_the_head_once_the_face_arrives() {
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let mut wait = FaceWait::default();
        let mut message = Message::new(1, MessageKind::Guard, 1);
        message.uid = 42;
        let slot = wait
            .enqueue(message, Some(42), tokio::time::Instant::now())
            .expect("缺头像的大航海要补头像");

        wait.flush(tokio::time::Instant::now(), &sink);
        assert!(
            events.try_recv().is_err(),
            "头像还没到就不许先上屏（需求 3.5 的「头像到位再上屏」）"
        );

        *slot.lock().expect("face slot") = Some("https://i0.hdslb.com/bfs/face/xyz.jpg".into());
        wait.flush(tokio::time::Instant::now(), &sink);
        match events.try_recv() {
            Ok(Event::Message(message)) => {
                assert_eq!(message.kind, MessageKind::Guard);
                assert_eq!(message.uid, 42);
                assert_eq!(message.face, "https://i0.hdslb.com/bfs/face/xyz.jpg");
            }
            other => panic!("应当投出那一条大航海，实际 {other:?}"),
        }
    }

    /// 需求 3.6：等满 600ms 就**照常上屏**（`face` 留空串），界面那头行内惰性补取。
    ///
    /// 用「把 now 推到 deadline 之后」代替真睡 600ms：判据是同一段代码里的同一次比较，
    /// 睡与不睡看到的是同一个分支。
    #[tokio::test]
    async fn face_wait_releases_the_head_at_the_600ms_deadline() {
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let mut wait = FaceWait::default();
        let now = tokio::time::Instant::now();
        let mut message = Message::new(1, MessageKind::Guard, 1);
        message.uid = 42;
        let _slot = wait.enqueue(message, Some(42), now).expect("要补头像");

        wait.flush(now + FACE_WAIT - Duration::from_millis(1), &sink);
        assert!(events.try_recv().is_err(), "没到期就该继续等");

        wait.flush(now + FACE_WAIT, &sink);
        match events.try_recv() {
            Ok(Event::Message(message)) => {
                assert_eq!(message.kind, MessageKind::Guard);
                assert!(message.face.is_empty(), "超时先上屏，头像留空串");
            }
            other => panic!("到期必须放行，实际 {other:?}"),
        }
    }

    /// 队列**保序**：队头不放行，后面到达的消息不许越过它；放行时按到达顺序出去。
    #[tokio::test]
    async fn face_wait_keeps_the_arrival_order() {
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let mut wait = FaceWait::default();
        let now = tokio::time::Instant::now();

        let mut head = Message::new(1, MessageKind::Guard, 1);
        head.uid = 42;
        let mut tail = Message::new(1, MessageKind::Danmaku, 2);
        tail.uid = 7;
        tail.face = "https://i0.hdslb.com/bfs/face/danmaku.png".into();

        let slot = wait.enqueue(head, Some(42), now).expect("队头要补头像");
        assert!(
            wait.enqueue(tail, None, now).is_none(),
            "本来就有头像的消息不占槽位"
        );

        wait.flush(now, &sink);
        assert!(
            events.try_recv().is_err(),
            "队头还在等，后面那条不许越过它（否则时间线会跳一下）"
        );

        *slot.lock().expect("face slot") = Some("https://i0.hdslb.com/bfs/face/xyz.jpg".into());
        wait.flush(now, &sink);
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let Event::Message(message) = event {
                seen.push((message.kind, message.face));
            }
        }
        assert_eq!(
            seen,
            vec![
                (
                    MessageKind::Guard,
                    "https://i0.hdslb.com/bfs/face/xyz.jpg".to_string()
                ),
                (
                    MessageKind::Danmaku,
                    "https://i0.hdslb.com/bfs/face/danmaku.png".to_string()
                ),
            ]
        );
    }

    /// 连接收尾（`read_loop` 那一段）：还压着的消息全部放行、按到达顺序、没到位的 `face` 留空。
    #[tokio::test]
    async fn face_wait_releases_everything_on_connection_end() {
        let mut wait = FaceWait::default();
        let now = tokio::time::Instant::now();
        let mut first = Message::new(1, MessageKind::Guard, 1);
        first.uid = 42;
        let mut second = Message::new(1, MessageKind::Superchat, 2);
        second.uid = 43;

        let slot = wait.enqueue(first, Some(42), now).expect("要补头像");
        let _other = wait.enqueue(second, Some(43), now).expect("要补头像");
        *slot.lock().expect("face slot") = Some("https://i0.hdslb.com/bfs/face/xyz.jpg".into());

        let released = wait.take_pending();
        assert_eq!(released.len(), 2, "断连时压着的都要放出去");
        assert_eq!(released[0].uid, 42);
        assert_eq!(released[0].face, "https://i0.hdslb.com/bfs/face/xyz.jpg");
        assert_eq!(released[1].uid, 43);
        assert!(released[1].face.is_empty(), "没到位的按无头像上屏");
        assert!(wait.take_pending().is_empty(), "放完即空");
    }

    /// 端到端（需求 3.5）：缺头像的大航海**先压在队列里**，头像到位后带着头像上屏 ——
    /// 收包循环在这段时间里照旧跑（等待靠队列与 `select!` 唤醒，不是 `await` 在收包路径上）。
    #[tokio::test]
    async fn guard_row_waits_for_its_face_then_arrives_with_it() {
        // 两处进程级缓存都会被这一步动到（WBI 密钥 + 头像），必须与其余用例串行；
        // 顺便清空 —— 不然这个用例可能命中别的用例先填好的结论，断言就变成假绿。
        let _cache_guard = crate::http::CACHE_TEST_LOCK.lock().await;
        crate::http::reset_wbi_cache().await;
        crate::profile::reset_face_cache().await;

        let stub = crate::http::test_support::spawn_stub(
            &[
                (200, "application/json", crate::http::test_support::NAV_OK),
                (200, "application/json", ACC_FACE),
            ],
            Duration::from_millis(120),
        );
        let http = BiliHttp::new()
            .expect("客户端可建")
            .with_nav_url(format!("{}/nav", stub.base))
            .with_acc_info_url(format!("{}/acc", stub.base));
        let live = BiliLive::new()
            .expect("房间运行时")
            .with_profile(Arc::new(BiliProfile::from_http(http)));

        // 本用例要等几百毫秒的取数，而 `test_limits` 的僵死阈值是 120ms
        // （那是给「帧间相隔毫秒」的用例用的）：这里把入站阈值放宽，只留时间轴。
        let limits = Limits {
            inbound_stale: Duration::from_secs(5),
            ..test_limits()
        };
        let (sink, bus) = test_sink();
        let mut events = bus.subscribe();
        let cancel = Cancel::new();
        let verify = Notify::new();
        let items: Frames = vec![Ok(verify_frame(0)), Ok(guard_toast_frame(42))];
        let mut stream =
            Box::pin(futures_util::stream::iter(items).chain(futures_util::stream::pending()));

        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                cancel.cancel();
            })
        };
        let outcome = live
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut stream,
                &mut FaceWait::default(),
            )
            .await;
        canceller.await.unwrap();
        assert_eq!(outcome.end, End::Live);

        let mut guards = Vec::new();
        while let Ok(event) = events.try_recv() {
            if let Event::Message(message) = event {
                if message.kind == MessageKind::Guard {
                    guards.push(message);
                }
            }
        }
        assert_eq!(guards.len(), 1, "那一条大航海播报必须上屏");
        assert_eq!(
            guards[0].face, "https://i0.hdslb.com/bfs/face/xyz.jpg",
            "上屏时必须已经带上按 uid 现取的头像"
        );
        assert!(
            stub.hits.load(std::sync::atomic::Ordering::SeqCst) >= 1,
            "确实问过一次上游"
        );
    }

    /// 端到端（需求 3.6）：上游**迟迟不给**头像时，队头在 600ms 到期后照常上屏（`face` 留空），
    /// 读循环没有被这个等待卡住 —— 桩慢 2 秒，而这条消息必须在 600ms 左右就出来。
    #[tokio::test]
    async fn a_slow_face_fetch_still_releases_the_row_at_the_deadline() {
        let _cache_guard = crate::http::CACHE_TEST_LOCK.lock().await;
        crate::http::reset_wbi_cache().await;
        crate::profile::reset_face_cache().await;

        let stub = crate::http::test_support::spawn_stub(
            &[
                (200, "application/json", crate::http::test_support::NAV_OK),
                (200, "application/json", ACC_FACE),
            ],
            // 两跳都慢 2 秒：远长于 600ms 的上限（这一条测的就是「不等它」）。
            Duration::from_secs(2),
        );
        let http = BiliHttp::new()
            .expect("客户端可建")
            .with_nav_url(format!("{}/nav", stub.base))
            .with_acc_info_url(format!("{}/acc", stub.base));
        let live = BiliLive::new()
            .expect("房间运行时")
            .with_profile(Arc::new(BiliProfile::from_http(http)));

        // 同样放宽入站阈值：本用例的时间轴是 600ms 那档，不是毫秒级帧间隔。
        let limits = Limits {
            inbound_stale: Duration::from_secs(5),
            ..test_limits()
        };
        let (sink, bus) = test_sink();
        let published = Arc::new(StdMutex::new(Vec::new()));
        let recorder = {
            let published = Arc::clone(&published);
            let mut events = bus.subscribe();
            tokio::spawn(async move {
                while let Ok(event) = events.recv().await {
                    if let Event::Message(message) = event {
                        published.lock().expect("lock poisoned").push(message);
                    }
                }
            })
        };
        let cancel = Cancel::new();
        let verify = Notify::new();
        let items: Frames = vec![Ok(verify_frame(0)), Ok(guard_toast_frame(42))];
        let mut stream =
            Box::pin(futures_util::stream::iter(items).chain(futures_util::stream::pending()));

        // 那条消息一上屏就收连接（它在 600ms 到期时必然先到；上游要 2 秒）。
        let canceller = {
            let cancel = cancel.clone();
            let published = Arc::clone(&published);
            tokio::spawn(async move {
                until(
                    || published.lock().expect("lock poisoned").len() == 1,
                    Duration::from_millis(1500),
                )
                .await;
                cancel.cancel();
            })
        };
        let started = Instant::now();
        let outcome = live
            .read_loop(
                1,
                &sink,
                &cancel,
                &verify,
                &limits,
                &mut stream,
                &mut FaceWait::default(),
            )
            .await;
        canceller.await.unwrap();
        assert_eq!(outcome.end, End::Live);
        let seen = published.lock().expect("lock poisoned").clone();
        assert_eq!(seen.len(), 1, "只有那一条大航海播报");
        assert_eq!(seen[0].kind, MessageKind::Guard);
        assert!(
            seen[0].face.is_empty(),
            "上游还没给就按无头像先上屏（需求 3.6）"
        );
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "上屏走的是 600ms 的上限，不是干等上游（实测 {:?}）",
            started.elapsed()
        );
        recorder.abort();
    }
}
