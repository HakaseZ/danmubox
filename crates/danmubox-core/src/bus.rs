use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Notify};

use crate::model::{Message, MessageKind, Room, RoomSession};

/// 连接状态。UI 的四种呈现以此为准（`docs/ui.md`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnState {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusEvent {
    pub room_id: i64,
    pub state: ConnState,
    /// 人类可读补充；认证失败时只放原始 code，不赋予未知 code 具体含义。
    pub detail: String,
}

/// 房间观众数（`docs/contract.md` §5）。
///
/// 两个数各自随不同的上游命令到达，因此两侧都是可选的：未到达的一侧为 `None`，
/// 消费方保留上一次的值即可，不需要在协议层拼出一个「完整快照」。
/// 它们变化频繁但与连接状态无关，因此单独一个事件，不挤进 `Status`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomStats {
    pub room_id: i64,
    /// 在线人数（`ONLINE_RANK_COUNT` 的 `online_count`），协议 §10.7。
    pub online: Option<i64>,
    /// 累计看过（`WATCHED_CHANGE` 的 `num`），协议 §10.7。
    pub watched: Option<i64>,
}

/// 事件总线上的事件。UI、会话缓冲、日志三个消费方共用同一份。
///
/// clippy 会建议把 `Message` 装箱以缩小枚举。**不采用**：`Message` 是域模型本体，
/// 装箱意味着**每条消息**多发一次堆分配（热路径上真正要省的东西），而枚举本身只活在
/// 固定容量的广播缓冲里，多出的字节有上界、也不参与逐条拷贝链。模型侧该省的已经省了
/// （`Message.emote` 才有装箱，见 `model.rs`），这里保留内联是刻意的取舍。
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone)]
pub enum Event {
    Message(Message),
    Room(Room),
    /// 房间会话结束（离开房间），缓冲随之销毁。
    RoomClosed(i64),
    Status(StatusEvent),
    Session(RoomSession),
    /// 房间观众数变化（在线人数 / 累计看过）。
    RoomStats(RoomStats),
}

/// 广播总线。慢消费者由 `broadcast` 自行丢弃旧值，不阻塞上游。
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
}

impl EventBus {
    pub const DEFAULT_CAPACITY: usize = 1024;

    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity.max(1));
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    pub fn publish(&self, event: Event) {
        // 没有订阅者时返回 Err，属正常情形，不算失败。
        let _ = self.tx.send(event);
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(Self::DEFAULT_CAPACITY)
    }
}

/// 协议层计数。`docs/roadmap.md` 的 S1-AC5 / S1-AC7 要求这些丢弃量可见。
#[derive(Debug, Default)]
pub struct Counters {
    pub packets: AtomicU64,
    pub messages: AtomicU64,
    pub decompress_errors: AtomicU64,
    pub oversize_dropped: AtomicU64,
    pub malformed_dropped: AtomicU64,
    pub mirrored_dropped: AtomicU64,
    pub unknown_cmd: AtomicU64,
    /// 计数类命令（人气/看过/点赞/榜单）：按 `docs/protocol.md` §10.7
    /// 只更新房间内存计数，**不写入会话缓冲**。
    pub counter_updates: AtomicU64,
    /// 上游 HTTP 心跳失败次数。S1-AC2 要用它判断「是否因缺心跳被判死」。
    pub heartbeat_failures: AtomicU64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CounterSnapshot {
    pub packets: u64,
    pub messages: u64,
    pub decompress_errors: u64,
    pub oversize_dropped: u64,
    pub malformed_dropped: u64,
    pub mirrored_dropped: u64,
    pub unknown_cmd: u64,
    pub counter_updates: u64,
    pub heartbeat_failures: u64,
}

impl Counters {
    pub fn snapshot(&self) -> CounterSnapshot {
        CounterSnapshot {
            packets: self.packets.load(Ordering::Relaxed),
            messages: self.messages.load(Ordering::Relaxed),
            decompress_errors: self.decompress_errors.load(Ordering::Relaxed),
            oversize_dropped: self.oversize_dropped.load(Ordering::Relaxed),
            malformed_dropped: self.malformed_dropped.load(Ordering::Relaxed),
            mirrored_dropped: self.mirrored_dropped.load(Ordering::Relaxed),
            unknown_cmd: self.unknown_cmd.load(Ordering::Relaxed),
            counter_updates: self.counter_updates.load(Ordering::Relaxed),
            heartbeat_failures: self.heartbeat_failures.load(Ordering::Relaxed),
        }
    }

    pub fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }
}

/// 适配器与引擎之间唯一的投递口：适配器只认识 `MessageSink`，
/// 不接触总线订阅者，也不接触缓冲。
#[derive(Clone)]
pub struct MessageSink {
    bus: EventBus,
    counters: Arc<Counters>,
    next_local_id: Arc<AtomicU64>,
    /// 本会话最近发布过的弹幕指纹（环形窗口）。见 [`MessageSink::publish_with`]。
    seen_danmaku: Arc<Mutex<VecDeque<u64>>>,
}

/// 记住多少条「刚发过的弹幕」用于去重：同一条被送两遍的时间差是毫秒级，
/// 256 条在再热闹的房间里也覆盖得住（按每秒上百条算仍有 2 秒余量）。
const SEEN_DANMAKU_WINDOW: usize = 256;

/// 弹幕指纹：`uid + ts + 正文 + 表情`。**同一帧/同一秒里同一个人说同样的话**是常态，
/// 但那种情况每条各有各的上游 `ts`，指纹不同；指纹相同只可能是**同一条**。
fn danmaku_fingerprint(message: &Message) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    message.uid.hash(&mut hasher);
    message.ts.hash(&mut hasher);
    message.content.hash(&mut hasher);
    message
        .emote
        .as_ref()
        .map(|emote| emote.emoticon_unique.as_str())
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

impl MessageSink {
    pub fn new(bus: EventBus, counters: Arc<Counters>) -> Self {
        Self {
            bus,
            counters,
            next_local_id: Arc::new(AtomicU64::new(0)),
            seen_danmaku: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    /// 投递一条归一化消息；`local_id` 由本方法分配（适配器不负责）。
    pub fn publish_message(&self, message: Message) {
        self.publish_with(message, true);
    }

    /// 投递一条**进场回填**的历史弹幕。
    ///
    /// 与实时消息**共用同一套会话序号**——界面拿 `local_id` 当列表 key，
    /// 两条路径（`danmubox://message` 与 `history_query`）给出的号必须一致且唯一，
    /// 否则回填的这批会全部以 `local_id = 0` 落到同一个 key 上。
    /// 但回填**不计入** `messages` 统计：它不是「收到的包」。
    pub fn publish_history(&self, message: Message) {
        self.publish_with(message, false);
    }

    /// 投递一条消息；**同一条弹幕的第二份在这里就被挡下**，不进总线
    /// （`docs/ui.md` §4.7：界面与缓冲必须看到同一份事实）。
    ///
    /// 为什么必须挡在这一层：界面消费的是**事件**（`danmubox://message`）与
    /// `history_query` 快照两条路，只挡缓冲挡不住事件；而界面按 `(uid, 正文, ts)`
    /// 合并行，同一条的两份会被画成一行 `×2` —— 看着像用户重复发言，其实是同一条
    /// 被送了两遍。上游两条路都会带它：`gethistory` 的回填与 WS 实时、
    /// 或者同一帧里压缩子包与明文子包各一份。
    ///
    /// 只认 `danmaku`：它是唯一「回填 + 实时回推」两条路都有的类型；礼物/互动允许
    /// 上游反复推同一条（连击、榜单刷新），按内容去重会误伤真实重复。
    fn publish_with(&self, mut message: Message, count: bool) {
        if message.kind == MessageKind::Danmaku {
            let fingerprint = danmaku_fingerprint(&message);
            let mut seen = self.seen_danmaku.lock().expect("seen poisoned");
            if seen.contains(&fingerprint) {
                tracing::debug!(
                    room_id = message.room_id,
                    uid = message.uid,
                    "同一条弹幕又来了（回填/实时两条路），丢弃第二份"
                );
                return;
            }
            seen.push_back(fingerprint);
            while seen.len() > SEEN_DANMAKU_WINDOW {
                seen.pop_front();
            }
        }
        message.local_id = self.next_local_id.fetch_add(1, Ordering::Relaxed) + 1;
        if count {
            Counters::bump(&self.counters.messages);
        }
        self.bus.publish(Event::Message(message));
    }

    pub fn publish_status(&self, room_id: i64, state: ConnState, detail: impl Into<String>) {
        self.bus.publish(Event::Status(StatusEvent {
            room_id,
            state,
            detail: detail.into(),
        }));
    }

    /// 房间观众数：只影响界面上的两个数字，因此不经过会话缓冲，也不计入流量统计。
    pub fn publish_room_stats(&self, room_id: i64, online: Option<i64>, watched: Option<i64>) {
        self.bus.publish(Event::RoomStats(RoomStats {
            room_id,
            online,
            watched,
        }));
    }

    pub fn publish_room(&self, room: Room) {
        self.bus.publish(Event::Room(room));
    }

    pub fn publish_session(&self, session: RoomSession) {
        self.bus.publish(Event::Session(session));
    }

    pub fn counters(&self) -> &Arc<Counters> {
        &self.counters
    }

    pub fn bus(&self) -> &EventBus {
        &self.bus
    }
}

/// 取消信号。用 `AtomicBool` + `Notify` 实现，避免为单点需求引入额外依赖；
/// `cancelled()` 自带复查循环，消除「检查后取消」的竞态。
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
    /// 父令牌（见 [`Cancel::child`]）。子令牌自己不一定要被 `cancel()`，父取消时它同样算取消。
    parent: Option<Arc<Cancel>>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    /// 子令牌：**父令牌取消时它跟着取消**。一次连接的取消信号用它——会话结束必须
    /// 把在途的那一次连接一起停掉。会话的 `close()` 只能 abort 驱动任务，而连接跑在
    /// 驱动另起的一个任务里（abort 驱动不会连带停它），取消信号不跟着父走就会留下
    /// 一条孤儿连接：它照样读包、照样往总线上投弹幕，界面于是收到同一房间的第二份。
    pub fn child(parent: &Cancel) -> Self {
        // 拍平到根：`cancelled()` 只并两个 `cancelled_here()`（免得异步递归），
        // 祖辈的取消也不会被漏掉。
        Self {
            parent: Some(Arc::new(parent.root())),
            ..Self::default()
        }
    }

    /// 取消链的根（没有父就是自己）。
    fn root(&self) -> Cancel {
        match &self.parent {
            Some(parent) => parent.root(),
            None => self.clone(),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
            || self
                .parent
                .as_ref()
                .is_some_and(|parent| parent.is_cancelled())
    }

    pub async fn cancelled(&self) {
        match self.parent.clone() {
            None => self.cancelled_here().await,
            // 父已经拍平成根了，两个 `cancelled_here()` 就够。
            Some(parent) => {
                tokio::select! {
                    _ = self.cancelled_here() => {}
                    _ = parent.cancelled_here() => {}
                }
            }
        }
    }

    /// 只看本令牌自己的标志位（父的那份由调用方 select 进来）。
    async fn cancelled_here(&self) {
        loop {
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
            let waiter = self.notify.notified();
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
            waiter.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MessageKind;

    #[tokio::test]
    async fn sink_assigns_monotonic_local_ids() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe();
        let sink = MessageSink::new(bus.clone(), Arc::new(Counters::default()));

        sink.publish_message(Message::new(1, MessageKind::Danmaku, 1));
        sink.publish_message(Message::new(1, MessageKind::Danmaku, 2));

        let a = match rx.recv().await.unwrap() {
            Event::Message(m) => m,
            other => panic!("unexpected {other:?}"),
        };
        let b = match rx.recv().await.unwrap() {
            Event::Message(m) => m,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(a.local_id, 1);
        assert_eq!(b.local_id, 2);
        assert_eq!(sink.counters().snapshot().messages, 2);
    }

    #[tokio::test]
    async fn publish_without_subscribers_is_not_an_error() {
        let bus = EventBus::default();
        bus.publish(Event::RoomClosed(1));
        assert_eq!(bus.subscriber_count(), 0);
    }

    /// 子令牌必须跟着父令牌取消：会话一结束，在途的那次连接就得停
    /// （`session.rs` 的连接信号是 `Cancel::child(&session)`，见那里的注释）。
    #[tokio::test]
    async fn child_cancel_follows_its_parent() {
        let parent = Cancel::new();
        let child = Cancel::child(&parent);
        assert!(!child.is_cancelled());

        parent.cancel();
        assert!(child.is_cancelled(), "父取消后子必须算已取消");
        tokio::time::timeout(std::time::Duration::from_secs(1), child.cancelled())
            .await
            .expect("父取消后子的 cancelled() 必须立即返回");

        // 子自己取消不牵连父：单次连接被「刷新」掐掉，会话仍要继续。
        let parent = Cancel::new();
        let child = Cancel::child(&parent);
        child.cancel();
        assert!(child.is_cancelled());
        assert!(!parent.is_cancelled(), "子取消不得反噬父（会话还要接着用）");
    }

    #[tokio::test]
    async fn cancel_is_observable_and_not_racy() {
        let cancel = Cancel::new();
        let waiter = {
            let cancel = cancel.clone();
            tokio::spawn(async move { cancel.cancelled().await })
        };
        cancel.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("cancelled() 必须立即返回")
            .unwrap();

        let already = Cancel::new();
        already.cancel();
        tokio::time::timeout(std::time::Duration::from_secs(1), already.cancelled())
            .await
            .expect("已取消的 token 必须立即返回");
    }
}
