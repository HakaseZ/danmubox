use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Notify};

use crate::model::{Message, Room, RoomSession};

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

/// 事件总线上的事件。UI、会话缓冲、日志三个消费方共用同一份。
#[derive(Debug, Clone)]
pub enum Event {
    Message(Message),
    Room(Room),
    /// 房间会话结束（离开房间），缓冲随之销毁。
    RoomClosed(i64),
    Status(StatusEvent),
    Session(RoomSession),
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
}

impl MessageSink {
    pub fn new(bus: EventBus, counters: Arc<Counters>) -> Self {
        Self {
            bus,
            counters,
            next_local_id: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 投递一条归一化消息；`local_id` 由本方法分配（适配器不负责）。
    pub fn publish_message(&self, mut message: Message) {
        message.local_id = self.next_local_id.fetch_add(1, Ordering::Relaxed) + 1;
        Counters::bump(&self.counters.messages);
        self.bus.publish(Event::Message(message));
    }

    pub fn publish_status(&self, room_id: i64, state: ConnState, detail: impl Into<String>) {
        self.bus.publish(Event::Status(StatusEvent {
            room_id,
            state,
            detail: detail.into(),
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
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let waiter = self.notify.notified();
            if self.is_cancelled() {
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
