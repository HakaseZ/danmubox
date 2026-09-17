use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::bus::{Cancel, ConnState, Counters, Event, EventBus, MessageSink};
use crate::error::Result;
use crate::model::{Message, MessageKind, Room, RoomSession};
use crate::ports::LiveSource;

/// 历史查询条件（`docs/contract.md` §7 的 `history_query` 参数）。
/// 语义：先按条件过滤，再取**最后** `limit` 条，返回按时间升序。
/// `limit == 0` 表示不截断。
#[derive(Debug, Clone)]
pub struct HistoryQuery {
    pub limit: usize,
    pub after: Option<i64>,
    pub before: Option<i64>,
    pub kinds: Option<Vec<MessageKind>>,
    pub uid: Option<i64>,
    pub q: Option<String>,
}

impl Default for HistoryQuery {
    fn default() -> Self {
        Self {
            limit: 200,
            after: None,
            before: None,
            kinds: None,
            uid: None,
            q: None,
        }
    }
}

impl HistoryQuery {
    fn matches(&self, m: &Message) -> bool {
        if let Some(after) = self.after {
            if m.ts <= after {
                return false;
            }
        }
        if let Some(before) = self.before {
            if m.ts >= before {
                return false;
            }
        }
        if let Some(kinds) = &self.kinds {
            if !kinds.contains(&m.kind) {
                return false;
            }
        }
        if let Some(uid) = self.uid {
            if m.uid != uid {
                return false;
            }
        }
        if let Some(needle) = &self.q {
            if !needle.is_empty() && !m.content.contains(needle.as_str()) {
                return false;
            }
        }
        true
    }
}

/// 会话缓冲各档上限（`docs/contract.md` §4.3 / §8）。
///
/// **按 `kind` 分档**：弹幕一条道，礼物再按金额分三档（价值越高留得越多），
/// SC / 大航海 / 互动 / 系统各一条道 —— 互动与系统那两档刻意小得多，
/// 它们量大或价值低，不能让它们把弹幕挤出去。
///
/// 数值来自偏好键 `history.buffer_rows_*`，**只在建立会话时读一次**。
/// [`BufferCaps::default`] 必须与契约 §8 的默认值逐项一致（`prefs.rs` 有单测把住）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BufferCaps {
    pub danmaku: usize,
    pub gift: usize,
    pub superchat: usize,
    pub guard: usize,
    pub interact: usize,
    pub system: usize,
}

impl Default for BufferCaps {
    fn default() -> Self {
        Self {
            danmaku: 5000,
            gift: 2000,
            superchat: 500,
            guard: 200,
            interact: 300,
            system: 200,
        }
    }
}

impl BufferCaps {
    /// 各档上限之和；界面/CLI 报「上限」时用它。
    ///
    /// 注意它**不是**「礼物三档之和」的近似式：礼物三档的条数之和恒等于 `gift`
    /// （见 [`gift_tier_caps`]），因此这里的六个字段加总就是缓冲真正能容纳的条数。
    pub fn total(self) -> usize {
        self.danmaku + self.gift + self.superchat + self.guard + self.interact + self.system
    }

    /// 每道各自的条数上限，下标与 [`Lane::ALL`] 一致。
    fn lanes(self) -> [usize; Lane::COUNT] {
        let [low, mid, high] = gift_tier_caps(self.gift);
        [
            self.danmaku.max(1),
            low,
            mid,
            high,
            self.superchat.max(1),
            self.guard.max(1),
            self.interact.max(1),
            self.system.max(1),
        ]
    }
}

/// 礼物三档各占礼物档总额度的百分比（`docs/contract.md` §4.3）。
///
/// 低档只留一点点、高档留最多 —— 这就是「价值越高权重越高」的落点：
/// 三档各自 FIFO，而**高价值礼物到得少**，同样的条数在时间轴上覆盖得远长于低档。
const GIFT_TIER_SHARE: [usize; 3] = [10, 40, 50];

/// 低档礼物的金额上界（金瓜子）：**复用**契约 §8 既有的「低价礼物」门槛
/// （≤ 0.1 元；按契约 §5「金额单位」的 1 元 = 1000 金瓜子即 100 金瓜子）。
const GIFT_LOW_MAX: i64 = 100;

/// 高档礼物的金额下界（金瓜子，10 元）**以上**即进高档。
///
/// 档位是本地的保留策略取舍，**不对上游礼物价位作任何断言**：它只决定「同一条道里留多少条」，
/// 与礼物本身的价格无关。
const GIFT_HIGH_MIN: i64 = 10_000;

/// 礼物按金额分档：`0` 低 / `1` 中 / `2` 高。判据是 `Message.amount`（金瓜子，契约 §5）。
///
/// `amount <= 0` 是「上游没给价」（契约 §5 的既有口径）——**不算低价**：进中档，
/// 不猜价、也不当高档。两个金额门槛都取**闭区间**（`≤ 100` 是低、`≤ 10000` 是中）。
fn gift_tier(amount: i64) -> usize {
    if amount > GIFT_HIGH_MIN {
        2
    } else if amount > 0 && amount <= GIFT_LOW_MAX {
        0
    } else {
        1
    }
}

/// 礼物三档各自的条数：按 [`GIFT_TIER_SHARE`] 切礼物档总额度，**余数给高档**
/// （三档之和因此恒等于总额度，不会因为取整凭空多出或少掉条数）。
/// 每档至少 1 条：总额度再小也不该出现一条都留不下的档。
fn gift_tier_caps(gift: usize) -> [usize; 3] {
    let low = (gift * GIFT_TIER_SHARE[0] / 100).max(1);
    let mid = (gift * GIFT_TIER_SHARE[1] / 100).max(1);
    let high = gift.saturating_sub(low + mid).max(1);
    [low, mid, high]
}

/// 缓冲分道（`docs/contract.md` §4.3）：每个 `kind` 一条，`gift` 再按金额档拆成三条。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lane {
    Danmaku,
    GiftLow,
    GiftMid,
    GiftHigh,
    Superchat,
    Guard,
    Interact,
    System,
}

impl Lane {
    const COUNT: usize = 8;

    /// 全部道，顺序即 [`BufferCaps::lanes`] 的下标顺序。
    const ALL: [Lane; Self::COUNT] = [
        Self::Danmaku,
        Self::GiftLow,
        Self::GiftMid,
        Self::GiftHigh,
        Self::Superchat,
        Self::Guard,
        Self::Interact,
        Self::System,
    ];

    /// 礼物三档，下标与 [`gift_tier`] 的返回值同序。
    const GIFT_TIERS: [Lane; 3] = [Self::GiftLow, Self::GiftMid, Self::GiftHigh];

    /// 这条消息进哪一道。
    fn of(message: &Message) -> Lane {
        match message.kind {
            MessageKind::Danmaku => Self::Danmaku,
            MessageKind::Gift => Self::GIFT_TIERS[gift_tier(message.amount)],
            MessageKind::Superchat => Self::Superchat,
            MessageKind::Guard => Self::Guard,
            MessageKind::Interact => Self::Interact,
            MessageKind::System => Self::System,
        }
    }
}

/// 单次房内会话的环形缓冲：进入房间创建，离开房间销毁（`docs/contract.md` §4.3）。
///
/// **按 `kind` 分道**（礼物另按金额分三档，见 [`Lane`]），每道各按自己的上限丢最旧；
/// 不落盘、不回看、不导出。分道的意义是**互不挤占**：互动/进场的洪水不再把弹幕顶掉。
pub struct MessageBuffer {
    caps: BufferCaps,
    /// 每道的条数上限（礼物三档在这里落成具体条数），建缓冲时算一次。
    lane_caps: [usize; Lane::COUNT],
    lanes: [VecDeque<Message>; Lane::COUNT],
    next_local_id: u64,
}

impl MessageBuffer {
    pub fn new(caps: BufferCaps) -> Self {
        Self {
            caps,
            lane_caps: caps.lanes(),
            lanes: Lane::ALL.map(|_| VecDeque::new()),
            next_local_id: 0,
        }
    }

    pub fn caps(&self) -> BufferCaps {
        self.caps
    }

    /// 缓冲总条数（各道之和）。
    pub fn len(&self) -> usize {
        self.lanes.iter().map(VecDeque::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.lanes.iter().all(VecDeque::is_empty)
    }

    pub fn clear(&mut self) {
        for lane in &mut self.lanes {
            lane.clear();
        }
    }

    /// 追加一条；`local_id` 已由 `MessageSink` 分配时**原样保留**，未分配（0）才由本缓冲补号。
    ///
    /// 必须保留的原因：同一个 `local_id` 会经两条路径到达界面（`danmubox://message`
    /// 事件与 `history_query` 快照），二次编号会让两条路径给出不同的号，界面按
    /// `local_id` 做 key 就会错乱。返回被淘汰的最旧一条（若有）。
    pub fn push(&mut self, mut message: Message) -> Option<Message> {
        if message.local_id == 0 {
            self.next_local_id += 1;
            message.local_id = self.next_local_id;
        } else {
            self.next_local_id = self.next_local_id.max(message.local_id);
        }
        let lane = Lane::of(&message) as usize;
        let lane_cap = self.lane_caps[lane];
        let ring = &mut self.lanes[lane];
        ring.push_back(message);
        if ring.len() > lane_cap {
            return ring.pop_front();
        }
        None
    }

    /// 当前缓冲内的全部消息，按到达顺序（`local_id` 升序）。
    ///
    /// 分道之后顺序不再是「一条队列的自然顺序」，得重新归并：`local_id` 是会话内单调的到达序号
    /// （`MessageSink` 分配，契约 §5），按它排序即回到单一队列时代的顺序 —— 界面与
    /// `history_query` 看到的相对次序与分道前一致。
    pub fn snapshot(&self) -> Vec<Message> {
        let mut all: Vec<Message> = self
            .lanes
            .iter()
            .flat_map(|lane| lane.iter().cloned())
            .collect();
        all.sort_unstable_by_key(|message| message.local_id);
        all
    }

    pub fn query(&self, query: &HistoryQuery) -> Vec<Message> {
        let mut hits: Vec<Message> = self
            .snapshot()
            .into_iter()
            .filter(|message| query.matches(message))
            .collect();
        if query.limit > 0 && hits.len() > query.limit {
            hits.drain(..hits.len() - query.limit);
        }
        hits
    }

    /// 供适配器/测试直接注入（不经过总线）。
    pub fn inject(&mut self, message: Message) -> Option<Message> {
        self.push(message)
    }
}

impl std::fmt::Debug for MessageBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MessageBuffer")
            .field("caps", &self.caps)
            .field("len", &self.len())
            .finish()
    }
}

/// 一个房间的运行时：会话缓冲 + 取消信号 + 后台任务。
///
/// 生命周期 = 一次房内会话；`close()` 之后缓冲清空、任务停止，
/// 再次进入同一房间是一个全新的 `RoomRuntime`。
pub struct RoomRuntime {
    pub room: Room,
    buffer: Arc<Mutex<MessageBuffer>>,
    /// 本人在这房间的身份（会话级、不落盘）。会话建立时取一次；取不到即全零身份。
    session: Arc<Mutex<RoomSession>>,
    bus: EventBus,
    /// 会话级取消：结束整次房内会话。
    cancel: Cancel,
    /// 连接级信号：房间内「刷新」触发立即重连，缓冲不变。
    restart: Arc<tokio::sync::Notify>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl RoomRuntime {
    /// 启动一次房内会话：订阅总线喂缓冲，并驱动适配器的连接循环。
    ///
    /// 用当前线程的 runtime 上下文（`Handle::current()`）来托后台任务。**只在
    /// 调用方身处 Tokio runtime 里时才可用**——从普通线程（例如 Tauri 的同步
    /// command）调用会 panic：「there is no reactor running」。那种场合要么把调用
    /// 方变成 async，要么用 [`RoomRuntime::spawn_on`] 显式给一个 runtime 句柄。
    pub fn spawn(
        room: Room,
        caps: BufferCaps,
        bus: EventBus,
        counters: Arc<Counters>,
        source: Arc<dyn LiveSource>,
    ) -> Self {
        Self::spawn_on(
            &tokio::runtime::Handle::current(),
            room,
            caps,
            bus,
            counters,
            source,
        )
    }

    /// 同上，但由调用方给定 runtime 句柄：**任何线程**都可以建会话，后台任务落在
    /// 那个 runtime 上。
    ///
    /// 存在的理由：界面上的「刷新连接」是 Tauri 的**同步** command，跑在主线程上，
    /// 那里没有 runtime 上下文；断连之后刷新会走到这里当场新建会话。把 runtime
    /// 句柄当参数传进来，这条路就不必依赖「当前线程刚好在 runtime 里」。
    pub fn spawn_on(
        handle: &tokio::runtime::Handle,
        room: Room,
        caps: BufferCaps,
        bus: EventBus,
        counters: Arc<Counters>,
        source: Arc<dyn LiveSource>,
    ) -> Self {
        let handle = handle.clone();
        let buffer = Arc::new(Mutex::new(MessageBuffer::new(caps)));
        let cancel = Cancel::new();
        let session_state = Arc::new(Mutex::new(RoomSession {
            room_id: room.room_id,
            ..Default::default()
        }));

        let room_id = room.room_id;

        // 本人身份（粉丝牌 / 大航海 / 房管）：**并发**取，不占连接路径的时间——
        // 房管菜单要它做权限前置，但晚一两百毫秒拿到也远好过拖慢进房。
        // 与历史回填同属「尽力而为」：未登录或上游失败都只记日志，留全零身份。
        let identity = {
            let source = Arc::clone(&source);
            let session_state = Arc::clone(&session_state);
            let bus = bus.clone();
            handle.spawn(async move {
                match source.room_identity(room_id).await {
                    Ok(identity) => {
                        *session_state.lock().expect("session poisoned") = identity.clone();
                        bus.publish(Event::Session(identity));
                    }
                    Err(err) => {
                        tracing::debug!(room_id, %err, "本人房内身份未取到，按全零身份继续");
                    }
                }
            })
        };
        let collector = {
            let buffer = Arc::clone(&buffer);
            let mut rx = bus.subscribe();
            handle.spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(Event::Message(message)) => {
                            if message.room_id == room_id {
                                buffer.lock().expect("buffer poisoned").push(message);
                            }
                        }
                        Ok(Event::RoomClosed(closed)) if closed == room_id => break,
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(dropped)) => {
                            tracing::warn!(room_id, dropped, "会话缓冲订阅落后，上游消息已丢弃");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            })
        };

        let restart = Arc::new(tokio::sync::Notify::new());
        let driver_handle = handle.clone();
        let driver = {
            let sink = MessageSink::new(bus.clone(), counters);
            let session = cancel.clone();
            let restart = Arc::clone(&restart);
            handle.spawn(async move {
                // 进场回填（`docs/contract.md` §4.3）：先把上游能给的最近若干条铺进总线，
                // 再开始连接——顺序因此天然是「历史在前、实时在后」，不需要额外的排序。
                // 上游该接口不可靠且会成批返回空（见 `docs/protocol.md` 附录 A30），
                // 因此空结果与失败都只记日志，绝不阻塞会话。
                match source.recent(room_id).await {
                    Ok(items) if !items.is_empty() => {
                        tracing::debug!(room_id, count = items.len(), "进场回填历史弹幕");
                        for message in items {
                            sink.publish_history(message);
                        }
                    }
                    Ok(_) => tracing::debug!(room_id, "上游未返回历史弹幕，按空列表进场"),
                    Err(err) => tracing::debug!(room_id, %err, "历史弹幕拉取失败，按空列表进场"),
                }

                loop {
                    if session.is_cancelled() {
                        return;
                    }
                    // 每次连接一个子取消信号：会话取消或「刷新」都能只终止当前连接。
                    // **必须是子令牌**：驱动跑在自己的任务里，`close()` 只能 abort 驱动；
                    // 连接跑在驱动另起的任务里，不会被连带 abort。取消信号不跟着会话走，
                    // 会话结束后就留下一条孤儿连接 —— 它照样往总线上投弹幕，界面收到
                    // 同一房间的第二份（用户 2026-09-13 报的「界面上出现 ×2」）。
                    let connection = Cancel::child(&session);
                    let attempt = {
                        let source = Arc::clone(&source);
                        let sink = sink.clone();
                        let connection = connection.clone();
                        driver_handle
                            .spawn(async move { source.stream(room_id, sink, connection).await })
                    };
                    let mut attempt = attempt;

                    tokio::select! {
                        _ = &mut attempt => {}
                        _ = session.cancelled() => {
                            connection.cancel();
                            let _ = attempt.await;
                            return;
                        }
                        _ = restart.notified() => {
                            connection.cancel();
                            let _ = attempt.await;
                            sink.publish_status(room_id, ConnState::Connecting, "手动重连");
                        }
                    }

                    if session.is_cancelled() {
                        return;
                    }
                }
            })
        };

        Self {
            room,
            buffer,
            session: session_state,
            bus,
            cancel,
            restart,
            tasks: vec![identity, collector, driver],
        }
    }

    /// 本人在这房间的身份；会话刚建立、上游还没回来时是全零身份（`is_admin = false`）。
    ///
    /// 界面据此决定房管菜单的可见性：拿不到身份时**按无权限处理**，
    /// 而不是先放行再等服务端报错。
    pub fn session(&self) -> RoomSession {
        self.session.lock().expect("session poisoned").clone()
    }

    /// 房间内「刷新」：立即重建连接，**保持会话缓冲不变**（`docs/contract.md` §4.3）。
    /// 新连接的首次尝试是立即发起的，因此不经过退避等待。
    pub fn reconnect(&self) {
        self.restart.notify_one();
    }

    pub fn query(&self, query: &HistoryQuery) -> Vec<Message> {
        self.buffer.lock().expect("buffer poisoned").query(query)
    }

    pub fn len(&self) -> usize {
        self.buffer.lock().expect("buffer poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 本次会话各档上限（建立会话时读的那一份，`docs/contract.md` §4.3）。
    pub fn caps(&self) -> BufferCaps {
        self.buffer.lock().expect("buffer poisoned").caps()
    }

    /// 结束这次会话：广播关闭、取消后台任务、清空缓冲。
    pub async fn close(self) -> Result<()> {
        self.bus.publish(Event::RoomClosed(self.room.room_id));
        self.cancel.cancel();
        for task in &self.tasks {
            task.abort();
        }
        self.buffer.lock().expect("buffer poisoned").clear();
        Ok(())
    }

    pub fn cancel_token(&self) -> Cancel {
        self.cancel.clone()
    }
}

impl Drop for RoomRuntime {
    fn drop(&mut self) {
        self.cancel.cancel();
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MessageKind;

    fn msg(ts: i64, kind: MessageKind, uid: i64, content: &str) -> Message {
        let mut m = Message::new(7, kind, ts);
        m.uid = uid;
        m.content = content.to_string();
        m
    }

    /// 礼物消息（`amount` 是金瓜子，契约 §5）。
    fn gift(ts: i64, amount: i64, content: &str) -> Message {
        let mut m = msg(ts, MessageKind::Gift, 9, content);
        m.amount = amount;
        m
    }

    /// 测试用上限：六档同值。只关心某一档时其余档给足，免得别的档先淘汰干扰读数。
    fn caps_all(n: usize) -> BufferCaps {
        BufferCaps {
            danmaku: n,
            gift: n,
            superchat: n,
            guard: n,
            interact: n,
            system: n,
        }
    }

    /// 某一道当前留下的条数（走 `query`，与界面同一条读路径）。
    fn kinds_len(buf: &MessageBuffer, kind: MessageKind) -> usize {
        buf.query(&HistoryQuery {
            limit: 0,
            kinds: Some(vec![kind]),
            ..Default::default()
        })
        .len()
    }

    #[test]
    fn buffer_evicts_oldest_when_over_capacity() {
        let mut buf = MessageBuffer::new(caps_all(3));
        for ts in 0..5 {
            buf.push(msg(ts, MessageKind::Danmaku, 1, "x"));
        }
        assert_eq!(buf.len(), 3);
        let ts: Vec<i64> = buf.snapshot().iter().map(|m| m.ts).collect();
        assert_eq!(ts, vec![2, 3, 4], "必须丢最旧");
        assert_eq!(buf.query(&HistoryQuery::default()).len(), 3);
    }

    #[test]
    fn local_ids_are_monotonic_and_survive_eviction() {
        let mut buf = MessageBuffer::new(caps_all(2));
        for ts in 0..4 {
            buf.push(msg(ts, MessageKind::Danmaku, 1, "x"));
        }
        let ids: Vec<u64> = buf.snapshot().iter().map(|m| m.local_id).collect();
        assert_eq!(ids, vec![3, 4]);
    }

    #[test]
    fn query_filters_then_keeps_tail_in_ascending_order() {
        let mut buf = MessageBuffer::new(caps_all(100));
        for ts in 0..10 {
            let kind = if ts % 2 == 0 {
                MessageKind::Danmaku
            } else {
                MessageKind::Gift
            };
            buf.push(msg(ts, kind, if ts < 5 { 1 } else { 2 }, "hit"));
        }

        let q = HistoryQuery {
            limit: 2,
            kinds: Some(vec![MessageKind::Gift]),
            ..Default::default()
        };
        let got = buf.query(&q);
        assert_eq!(got.len(), 2);
        assert_eq!(got.iter().map(|m| m.ts).collect::<Vec<_>>(), vec![7, 9]);

        let q = HistoryQuery {
            limit: 0,
            uid: Some(2),
            after: Some(4),
            ..Default::default()
        };
        assert_eq!(buf.query(&q).len(), 5);

        let q = HistoryQuery {
            limit: 0,
            q: Some("miss".into()),
            ..Default::default()
        };
        assert!(buf.query(&q).is_empty());
    }

    #[test]
    fn before_and_after_are_exclusive() {
        let mut buf = MessageBuffer::new(caps_all(10));
        for ts in 0..5 {
            buf.push(msg(ts, MessageKind::Danmaku, 1, "x"));
        }
        let q = HistoryQuery {
            limit: 0,
            after: Some(1),
            before: Some(4),
            ..Default::default()
        };
        assert_eq!(
            buf.query(&q).iter().map(|m| m.ts).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    /// 分道的核心承诺（issue 2609171849 第 3 条）：互动/进场的洪水**挤不掉**弹幕。
    ///
    /// 单一环形缓冲时代它们共用一条队列，一个热闹房间的进场消息能把弹幕整段顶出去；
    /// 分道之后各档各按自己的上限裁剪，互不挤占。
    #[test]
    fn interact_flood_does_not_evict_danmaku() {
        let caps = BufferCaps {
            danmaku: 200,
            interact: 5,
            system: 2,
            ..caps_all(200)
        };
        let mut buf = MessageBuffer::new(caps);
        for ts in 0..200 {
            buf.push(msg(ts, MessageKind::Danmaku, 1, "弹幕"));
        }
        for ts in 0..500 {
            buf.push(msg(1000 + ts, MessageKind::Interact, 2, "进入直播间"));
        }
        for ts in 0..50 {
            buf.push(msg(2000 + ts, MessageKind::System, 0, "开播"));
        }

        assert_eq!(
            kinds_len(&buf, MessageKind::Danmaku),
            200,
            "互动/系统再热闹，弹幕那 200 条也一条都不该被挤掉"
        );
        assert_eq!(
            kinds_len(&buf, MessageKind::Interact),
            5,
            "互动档按自己的小上限裁剪（只留最新 5 条）"
        );
        assert_eq!(kinds_len(&buf, MessageKind::System), 2, "系统档只留最新 2 条");

        // 留下的必须是**最新的**那批（各档内部照旧丢最旧）。
        let kept: Vec<i64> = buf
            .query(&HistoryQuery {
                limit: 0,
                kinds: Some(vec![MessageKind::Interact]),
                ..Default::default()
            })
            .iter()
            .map(|m| m.ts)
            .collect();
        assert_eq!(kept, vec![1495, 1496, 1497, 1498, 1499]);
    }

    /// 归并后的顺序仍是**到达顺序**：分道打乱了「一条队列」的天然次序，
    /// `snapshot()` 必须把它还原回去 —— 界面拿 `local_id` 当 key，`history_query`
    /// 抽出来的次序就是用户上滚时看到的次序。
    #[test]
    fn snapshot_merges_lanes_back_into_arrival_order() {
        let mut buf = MessageBuffer::new(caps_all(10));
        for i in 0..30_i64 {
            let kind = match i % 3 {
                0 => MessageKind::Danmaku,
                1 => MessageKind::Interact,
                _ => MessageKind::System,
            };
            buf.push(msg(i, kind, 1, "x"));
        }
        let ids: Vec<u64> = buf.snapshot().iter().map(|m| m.local_id).collect();
        assert_eq!(ids, (1..=30).collect::<Vec<u64>>(), "归并后必须与到达顺序一致");
    }

    /// 礼物分级缓存（issue 2609171849 第 3 条）：价值越高，留得越多。
    ///
    /// 三档各自 FIFO，档位由 `amount`（金瓜子，契约 §5）定，档位条数是礼物档总额度的
    /// 10% / 40% / 50%（契约 §4.3）。低档的条数上限最小，因此**同样的时间内**它滚得最快。
    #[test]
    fn expensive_gifts_are_kept_longer_than_cheap_ones() {
        // 礼物档 1000 条 → 低 100 / 中 400 / 高 500。
        let mut buf = MessageBuffer::new(BufferCaps {
            gift: 1000,
            ..caps_all(1000)
        });
        for ts in 0..5000 {
            buf.push(gift(ts, GIFT_LOW_MAX, "小心心")); // 低档（0.1 元）
        }
        for ts in 0..600 {
            buf.push(gift(5000 + ts, 1_000, "普通礼物")); // 中档（1 元）
        }
        for ts in 0..20 {
            buf.push(gift(9000 + ts, 138_000, "舰长")); // 高档（138 元）
        }

        let amounts: Vec<i64> = buf
            .query(&HistoryQuery {
                limit: 0,
                kinds: Some(vec![MessageKind::Gift]),
                ..Default::default()
            })
            .iter()
            .map(|m| m.amount)
            .collect();
        assert_eq!(
            amounts.iter().filter(|a| **a == GIFT_LOW_MAX).count(),
            100,
            "低档只留得住自己那 100 条（灌了 5000 条）"
        );
        assert_eq!(
            amounts.iter().filter(|a| **a == 1_000).count(),
            400,
            "中档留得住自己那 400 条（灌了 600 条）"
        );
        assert_eq!(
            amounts.iter().filter(|a| **a == 138_000).count(),
            20,
            "最贵的那批一条都不丢（高档还有余量）"
        );
        assert_eq!(amounts.len(), 520, "三档之和就是礼物档能容纳的条数");
    }

    /// 档位判据走**保留条数**这条可观察路径来验（而不是直接调私有函数）：
    /// 低档 ≤ 0.1 元（复用契约 §8 既有的低价礼物门槛）、中档 ≤ 10 元、高档 > 10 元，
    /// 而 `amount <= 0`（上游没给价，契约 §5）**不算低价** —— 它进中档，不猜价也不当高档。
    #[test]
    fn gift_tiers_split_by_amount_and_missing_price_rides_the_middle() {
        assert_eq!(
            gift_tier_caps(1000),
            [100, 400, 500],
            "三档之和恒等于礼物档总额度（余数给高档，不因取整漏条数）"
        );
        assert_eq!(
            gift_tier_caps(1),
            [1, 1, 1],
            "总额度再小也不会出现「一条都留不下」的档"
        );

        // 礼物档 100 条 → 低 10 / 中 40 / 高 50；灌 200 条，读数即该档上限。
        for (amount, expected, label) in [
            (100_i64, 10_usize, "0.1 元整 = 低档（闭区间）"),
            (101, 40, "刚过 0.1 元 = 中档"),
            (10_000, 40, "10 元整 = 中档（闭区间）"),
            (10_001, 50, "刚过 10 元 = 高档"),
            (0, 40, "上游没给价 → 中档，不当低价"),
            (-1, 40, "脏数据（负数）同「没给价」处理"),
        ] {
            let mut buf = MessageBuffer::new(BufferCaps {
                gift: 100,
                ..caps_all(100)
            });
            for ts in 0..200 {
                buf.push(gift(ts, amount, "礼物"));
            }
            assert_eq!(
                kinds_len(&buf, MessageKind::Gift),
                expected,
                "amount={amount}：{label}"
            );
        }
    }

    /// 各档上限之和 = 缓冲真正能容纳的条数；`gift` 那一档要按三档之和算，不是按字段值。
    #[test]
    fn caps_total_counts_every_lane() {
        assert_eq!(
            Lane::ALL.map(|lane| lane as usize),
            std::array::from_fn(|index| index),
            "道的下标必须等于它在 Lane::ALL 里的位置（lane_caps / lanes 两个数组都按它索引）"
        );

        let caps = BufferCaps::default();
        assert_eq!(
            caps.total(),
            5000 + 2000 + 500 + 200 + 300 + 200,
            "契约 §8 的六枚键加总"
        );
        assert_eq!(
            caps.lanes().iter().sum::<usize>(),
            5000 + 2000 + 500 + 200 + 300 + 200,
            "每道上限之和与六枚键加总一致（礼物三档不多不少）"
        );
    }

    /// 端口层的假适配器：先返回预置历史，再投递预置实时消息，然后挂起等待取消。
    struct FakeSource {
        messages: Vec<Message>,
        history: Vec<Message>,
        /// 历史拉取失败时使用，用于验证「失败不影响进场」。
        history_fails: bool,
        /// 预置的本人身份（房间号由调用方覆盖）。
        identity: RoomSession,
        /// 身份拉取失败时使用，用于验证「失败按全零身份继续」。
        identity_fails: bool,
    }

    #[async_trait::async_trait]
    impl LiveSource for FakeSource {
        async fn recent(&self, _room_id: i64) -> Result<Vec<Message>> {
            if self.history_fails {
                return Err(crate::Error::Upstream("假适配器的历史失败".into()));
            }
            Ok(self.history.clone())
        }

        async fn resolve_room(&self, _input: &str) -> Result<Room> {
            Ok(Room::default())
        }

        // 会话测试与开播状态无关（那条通路在 `cmd.rs` / `http.rs` 各自有用例）：给未开播。
        async fn live_status(&self, _room_id: i64) -> Result<i32> {
            Ok(0)
        }

        async fn room_identity(&self, room_id: i64) -> Result<RoomSession> {
            if self.identity_fails {
                return Err(crate::Error::Upstream("假适配器的身份失败".into()));
            }
            Ok(RoomSession {
                room_id,
                ..self.identity.clone()
            })
        }

        async fn stream(&self, _room_id: i64, sink: MessageSink, cancel: Cancel) -> Result<()> {
            for message in &self.messages {
                sink.publish_message(message.clone());
            }
            cancel.cancelled().await;
            Ok(())
        }
    }

    async fn settle() {
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    }

    fn history_msg(ts: i64, uid: i64, content: &str) -> Message {
        let mut m = msg(ts, MessageKind::Danmaku, uid, content);
        m.is_history = true;
        m
    }

    #[tokio::test]
    async fn history_is_seeded_before_live_and_flagged() {
        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let room = Room {
            room_id: 7,
            ..Default::default()
        };
        let source: Arc<dyn LiveSource> = Arc::new(FakeSource {
            history: vec![history_msg(100, 9, "进场前的弹幕")],
            messages: vec![msg(200, MessageKind::Danmaku, 8, "进场后的弹幕")],
            history_fails: false,
            identity: RoomSession::default(),
            identity_fails: false,
        });

        let runtime = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters.clone(), source);
        settle().await;

        let rows = runtime.query(&HistoryQuery::default());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].content, "进场前的弹幕", "历史必须排在实时之前");
        assert!(rows[0].is_history, "回填的必须带历史标记");
        assert_eq!(rows[1].content, "进场后的弹幕");
        assert!(!rows[1].is_history, "实时消息不得被标成历史");
        assert_eq!(
            counters.snapshot().messages,
            1,
            "回填不计入「收到的消息」（它不是收到的包）"
        );

        // 关键不变式：界面拿 `local_id` 当列表 key，而同一个号会经两条路径到达
        // ——`danmubox://message` 事件与 `history_query` 快照。两条路径必须给出
        // 同一套、非零、互不相同的号，否则回填那批会全部落到 key 0 上。
        let ids: Vec<u64> = rows.iter().map(|m| m.local_id).collect();
        assert!(
            ids.iter().all(|id| *id > 0),
            "回填也必须由 MessageSink 编号，不得留 0：{ids:?}"
        );
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "local_id 不得重复：{ids:?}");
        assert!(ids.windows(2).all(|w| w[0] < w[1]), "号必须递增：{ids:?}");
        assert_eq!(ids, vec![1, 2], "历史先于实时，占用最早的号：{ids:?}");
        runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn history_failure_or_emptiness_does_not_block_the_session() {
        for history_fails in [true, false] {
            let bus = EventBus::default();
            let counters = Arc::new(Counters::default());
            let room = Room {
                room_id: 7,
                ..Default::default()
            };
            // history_fails=false 且 history 为空 == 上游返回空数组（实测常态之一）。
            let source: Arc<dyn LiveSource> = Arc::new(FakeSource {
                history: vec![],
                messages: vec![msg(200, MessageKind::Danmaku, 8, "实时消息")],
                history_fails,
                identity: RoomSession::default(),
                identity_fails: false,
            });
            let runtime = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters, source);
            settle().await;
            assert_eq!(
                runtime.query(&HistoryQuery::default()).len(),
                1,
                "历史失败或为空时仍必须正常收实时消息（history_fails={history_fails}）"
            );
            runtime.close().await.unwrap();
        }
    }

    #[tokio::test]
    async fn runtime_buffer_lives_exactly_one_session() {
        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let room = Room {
            room_id: 7,
            ..Default::default()
        };

        let noisy: Arc<dyn LiveSource> = Arc::new(FakeSource {
            messages: vec![
                msg(1, MessageKind::Danmaku, 1, "第一条"),
                msg(2, MessageKind::Gift, 2, "第二条"),
            ],
            history: vec![],
            history_fails: false,
            identity: RoomSession::default(),
            identity_fails: false,
        });
        let mut events = bus.subscribe();
        let first = RoomRuntime::spawn(room.clone(), BufferCaps::default(), bus.clone(), counters.clone(), noisy);
        settle().await;
        assert_eq!(first.len(), 2, "本会话收到的消息应在缓冲内");
        assert_eq!(first.caps(), BufferCaps::default());
        first.close().await.unwrap();

        // 会话关闭必须广播，且缓冲随会话销毁。
        let mut saw_closed = false;
        while let Ok(event) = events.try_recv() {
            if matches!(event, Event::RoomClosed(7)) {
                saw_closed = true;
            }
        }
        assert!(saw_closed, "关闭会话必须广播 RoomClosed");

        // 重进同一房间是全新会话：不得带出上一次的任何消息。
        let quiet: Arc<dyn LiveSource> = Arc::new(FakeSource {
            messages: vec![],
            history: vec![],
            history_fails: false,
            identity: RoomSession::default(),
            identity_fails: false,
        });
        let second = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters, quiet);
        settle().await;
        assert!(second.is_empty(), "重进必须是新会话，旧缓冲不得残留");
        second.close().await.unwrap();
    }

    #[tokio::test]
    async fn room_identity_is_stored_and_published() {
        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let room = Room {
            room_id: 7,
            ..Default::default()
        };
        let identity = RoomSession {
            room_id: 7,
            my_medal_level: 21,
            my_medal_name: "牌子".into(),
            my_medal_worn: true,
            my_guard_level: 3,
            is_admin: true,
            // 弹幕上限随身份一起透传（item 12）：它是**房间给的值**，界面据此截断输入。
            danmaku_length: 40,
        };
        let source: Arc<dyn LiveSource> = Arc::new(FakeSource {
            messages: vec![],
            history: vec![],
            history_fails: false,
            identity: identity.clone(),
            identity_fails: false,
        });

        let mut events = bus.subscribe();
        let runtime = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters, source);
        settle().await;

        // 房间页要在「点了才会知道有没有权限」之外有一条确定答案：
        // 这条状态既可以直接读，也要经事件推给消费方。
        assert_eq!(runtime.session(), identity, "身份必须能被读出来");
        let mut published = None;
        while let Ok(event) = events.try_recv() {
            if let Event::Session(session) = event {
                published = Some(session);
            }
        }
        assert_eq!(published, Some(identity), "身份必须经 Event::Session 广播");
        runtime.close().await.unwrap();
    }

    #[tokio::test]
    async fn identity_failure_leaves_a_zero_identity_without_blocking() {
        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let room = Room {
            room_id: 7,
            ..Default::default()
        };
        let source: Arc<dyn LiveSource> = Arc::new(FakeSource {
            messages: vec![msg(5, MessageKind::Danmaku, 1, "实时消息")],
            history: vec![],
            history_fails: false,
            identity: RoomSession::default(),
            identity_fails: true,
        });

        let mut events = bus.subscribe();
        let runtime = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters, source);
        settle().await;

        assert_eq!(
            runtime.session(),
            RoomSession {
                room_id: 7,
                ..Default::default()
            },
            "身份取不到时按全零处理（即：无房管权限），不报错"
        );
        let mut saw_session = false;
        while let Ok(event) = events.try_recv() {
            if matches!(event, Event::Session(_)) {
                saw_session = true;
            }
        }
        assert!(!saw_session, "没拿到身份就不该广播一个假身份");
        assert_eq!(
            runtime.query(&HistoryQuery::default()).len(),
            1,
            "身份失败不得影响收弹幕"
        );
        runtime.close().await.unwrap();
    }

    /// 假适配器：第一次连接报告成功后**自行掉线**（上游 reset 就是这种收场），
    /// 之后的每一次都挂在那里等取消。用来观察「掉线之后有没有真的重连」。
    struct DroppingSource {
        attempts: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl LiveSource for DroppingSource {
        async fn recent(&self, _room_id: i64) -> Result<Vec<Message>> {
            Ok(Vec::new())
        }

        async fn resolve_room(&self, _input: &str) -> Result<Room> {
            Ok(Room::default())
        }

        // 会话测试与开播状态无关（那条通路在 `cmd.rs` / `http.rs` 各自有用例）：给未开播。
        async fn live_status(&self, _room_id: i64) -> Result<i32> {
            Ok(0)
        }

        async fn room_identity(&self, room_id: i64) -> Result<RoomSession> {
            Ok(RoomSession {
                room_id,
                ..Default::default()
            })
        }

        async fn stream(&self, room_id: i64, sink: MessageSink, cancel: Cancel) -> Result<()> {
            use std::sync::atomic::Ordering;
            let nth = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
            sink.publish_status(room_id, ConnState::Connected, format!("第 {nth} 次连接"));
            if nth == 1 {
                return Err(crate::Error::Upstream("模拟掉线".into()));
            }
            cancel.cancelled().await;
            Ok(())
        }
    }

    #[tokio::test]
    async fn dropped_connection_recovers_and_refresh_restarts_it() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let attempts = Arc::new(AtomicUsize::new(0));
        let source: Arc<dyn LiveSource> = Arc::new(DroppingSource {
            attempts: Arc::clone(&attempts),
        });
        let room = Room {
            room_id: 7,
            ..Default::default()
        };
        let mut events = bus.subscribe();
        let runtime = RoomRuntime::spawn(room, BufferCaps::default(), bus.clone(), counters, source);

        // 掉线不等人：第一次连接一断，核心必须立刻再起一次，而不是停在断连态。
        settle().await;
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "掉线后引擎必须立刻重连（当前只尝试了 {} 次）",
            attempts.load(Ordering::SeqCst)
        );

        // 「刷新」= 用户手里那颗键：必须再发起一次连接，并推出 connecting，
        // 否则菜单点了没有任何反应（断连态会一直挂着）。
        let before = attempts.load(Ordering::SeqCst);
        runtime.reconnect();
        settle().await;
        assert!(
            attempts.load(Ordering::SeqCst) > before,
            "「刷新」必须真的再发起一次连接"
        );

        let mut saw_manual = false;
        let mut last_state = None;
        while let Ok(event) = events.try_recv() {
            if let Event::Status(status) = event {
                saw_manual |= status.detail.contains("手动重连");
                last_state = Some(status.state);
            }
        }
        assert!(saw_manual, "手动重连必须广播 connecting（点完不能没有反应）");
        assert_eq!(
            last_state,
            Some(ConnState::Connected),
            "最后的状态不得停在断连"
        );
        runtime.close().await.unwrap();
    }

    /// 记「此刻还有几条 stream 活着」的假适配器：进出各动一次计数。
    /// 界面上的 ×2 永远来自「同一个房间有两份消息」，所以这份计数就是判据。
    struct CountingSource {
        active: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl LiveSource for CountingSource {
        async fn recent(&self, _room_id: i64) -> Result<Vec<Message>> {
            Ok(Vec::new())
        }

        async fn resolve_room(&self, _input: &str) -> Result<Room> {
            Ok(Room::default())
        }

        // 会话测试与开播状态无关（那条通路在 `cmd.rs` / `http.rs` 各自有用例）：给未开播。
        async fn live_status(&self, _room_id: i64) -> Result<i32> {
            Ok(0)
        }

        async fn room_identity(&self, room_id: i64) -> Result<RoomSession> {
            Ok(RoomSession {
                room_id,
                ..Default::default()
            })
        }

        async fn stream(&self, _room_id: i64, _sink: MessageSink, cancel: Cancel) -> Result<()> {
            use std::sync::atomic::Ordering;
            self.active.fetch_add(1, Ordering::SeqCst);
            cancel.cancelled().await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(())
        }
    }

    /// 会话结束（`close()`）必须把**在途的那一次连接**一起停掉：杀驱动任务并不会
    /// 取消它（连接由驱动另起一个任务跑），孤儿连接照样读包、照样往总线上投弹幕。
    /// 于是「断开再重进」之后同一房间有两条连接，界面收到两份同样的弹幕 → ×2
    /// （用户 2026-09-13 报的「界面上出现 ×2」）。
    #[tokio::test]
    async fn closing_a_session_stops_its_connection_for_good() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let active = Arc::new(AtomicUsize::new(0));
        let source: Arc<dyn LiveSource> = Arc::new(CountingSource {
            active: Arc::clone(&active),
        });
        let room = Room {
            room_id: 7,
            ..Default::default()
        };

        let runtime = RoomRuntime::spawn(
            room.clone(),
            BufferCaps::default(),
            bus.clone(),
            Arc::clone(&counters),
            Arc::clone(&source),
        );
        settle().await;
        assert_eq!(active.load(Ordering::SeqCst), 1, "进房必须真的去连");

        runtime.close().await.unwrap();
        settle().await;
        assert_eq!(
            active.load(Ordering::SeqCst),
            0,
            "会话结束后在途的连接必须跟着停（否则它是一条孤儿连接，照样往总线投弹幕）"
        );

        // 重进同一房间：只能有一条连接 —— 两条就是界面上 ×2 的源头。
        let again = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters, source);
        settle().await;
        assert_eq!(
            active.load(Ordering::SeqCst),
            1,
            "重进同一房间后只允许一条连接，否则界面必然出现 ×2"
        );
        again.close().await.unwrap();
    }

    /// 同一条弹幕不得既从进场回填来一次、又从实时路径来一次。上游两种情形都会这样：
    /// ① `gethistory` 与 WS 都带了它；② 同一帧里压缩子包与明文子包各带一份。
    /// 两份都进会话缓冲的话，界面按 (uid, 正文, ts) 把同一条合并成一行 ×2。
    #[tokio::test]
    async fn a_backfilled_danmaku_is_not_repeated_by_the_live_path() {
        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let room = Room {
            room_id: 7,
            ..Default::default()
        };
        let backfilled = history_msg(100, 9, "好");
        let mut echoed_live = backfilled.clone();
        echoed_live.is_history = false;
        let source: Arc<dyn LiveSource> = Arc::new(FakeSource {
            history: vec![backfilled],
            messages: vec![echoed_live],
            history_fails: false,
            identity: RoomSession::default(),
            identity_fails: false,
        });

        let runtime = RoomRuntime::spawn(room, BufferCaps::default(), bus, counters, source);
        settle().await;

        let rows = runtime.query(&HistoryQuery::default());
        assert_eq!(
            rows.len(),
            1,
            "同一条弹幕只能留下一份：既从回填又从实时各来一份就是界面上那行 ×2"
        );
        assert!(rows[0].is_history, "留下的是先到的那份（进场回填）");
        runtime.close().await.unwrap();
    }

    /// 端到端那条路（总线 → collector → 分道缓冲）：互动洪水过后弹幕仍在。
    ///
    /// 缓冲级的用例验的是 `MessageBuffer` 本身；这一条把 collector 也带进来 ——
    /// 「按 kind 分道」这件事在真实投递路径上同样成立（`rooms_connect` 建会话时读到的
    /// `BufferCaps` 一路传到缓冲，中间没有第二个裁剪点）。
    #[tokio::test]
    async fn interact_storm_through_the_bus_leaves_danmaku_intact() {
        let caps = BufferCaps {
            danmaku: 50,
            interact: 5,
            ..caps_all(50)
        };
        let mut messages = Vec::new();
        for ts in 0..300 {
            messages.push(msg(ts, MessageKind::Danmaku, 1, "弹幕"));
        }
        for ts in 0..300 {
            messages.push(msg(5000 + ts, MessageKind::Interact, 2, "进入直播间"));
        }

        let bus = EventBus::default();
        let counters = Arc::new(Counters::default());
        let room = Room {
            room_id: 7,
            ..Default::default()
        };
        let source: Arc<dyn LiveSource> = Arc::new(FakeSource {
            messages,
            history: vec![],
            history_fails: false,
            identity: RoomSession::default(),
            identity_fails: false,
        });

        let runtime = RoomRuntime::spawn(room, caps, bus, counters, source);
        settle().await;

        let count = |kind: MessageKind| {
            runtime
                .query(&HistoryQuery {
                    limit: 0,
                    kinds: Some(vec![kind]),
                    ..Default::default()
                })
                .len()
        };
        assert_eq!(count(MessageKind::Danmaku), 50, "弹幕档留下自己那 50 条");
        assert_eq!(count(MessageKind::Interact), 5, "互动档只留最新 5 条");
        assert_eq!(runtime.len(), 55, "总条数 = 各档之和");
        assert_eq!(runtime.caps(), caps, "会话读到的是建会话时那一份上限");
        runtime.close().await.unwrap();
    }
}
