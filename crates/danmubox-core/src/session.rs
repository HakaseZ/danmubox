use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::bus::{Cancel, ConnState, Counters, Event, EventBus, MessageSink};
use crate::error::Result;
use crate::model::{Message, MessageKind, Room};
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

/// 单次房内会话的环形缓冲：进入房间创建，离开房间销毁（`docs/contract.md` §4.3）。
/// 超出容量时丢弃最旧一条；不落盘、不回看、不导出。
pub struct MessageBuffer {
    cap: usize,
    items: VecDeque<Message>,
    next_local_id: u64,
}

impl MessageBuffer {
    pub fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            items: VecDeque::new(),
            next_local_id: 0,
        }
    }

    pub fn cap(&self) -> usize {
        self.cap
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    /// 追加一条并分配 `local_id`；返回被淘汰的最旧一条（若有）。
    pub fn push(&mut self, mut message: Message) -> Option<Message> {
        self.next_local_id += 1;
        message.local_id = self.next_local_id;
        self.items.push_back(message);
        if self.items.len() > self.cap {
            return self.items.pop_front();
        }
        None
    }

    /// 当前缓冲内的全部消息，按时间升序。
    pub fn snapshot(&self) -> Vec<Message> {
        self.items.iter().cloned().collect()
    }

    pub fn query(&self, query: &HistoryQuery) -> Vec<Message> {
        let mut hits: Vec<&Message> = self.items.iter().filter(|m| query.matches(m)).collect();
        if query.limit > 0 && hits.len() > query.limit {
            hits.drain(..hits.len() - query.limit);
        }
        hits.into_iter().cloned().collect()
    }

    /// 供适配器/测试直接注入（不经过总线）。
    pub fn inject(&mut self, message: Message) -> Option<Message> {
        self.push(message)
    }
}

impl std::fmt::Debug for MessageBuffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MessageBuffer")
            .field("cap", &self.cap)
            .field("len", &self.items.len())
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
    bus: EventBus,
    cancel: Cancel,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl RoomRuntime {
    /// 启动一次房内会话：订阅总线喂缓冲，并驱动适配器的连接循环。
    pub fn spawn(
        room: Room,
        buffer_rows: usize,
        bus: EventBus,
        counters: Arc<Counters>,
        source: Arc<dyn LiveSource>,
    ) -> Self {
        let buffer = Arc::new(Mutex::new(MessageBuffer::new(buffer_rows)));
        let cancel = Cancel::new();

        let room_id = room.room_id;
        let collector = {
            let buffer = Arc::clone(&buffer);
            let mut rx = bus.subscribe();
            tokio::spawn(async move {
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

        let driver = {
            let sink = MessageSink::new(bus.clone(), counters);
            let cancel = cancel.clone();
            tokio::spawn(async move {
                match source.stream(room_id, sink.clone(), cancel.clone()).await {
                    Ok(()) => sink.publish_status(room_id, ConnState::Disconnected, "closed"),
                    Err(err) => sink.publish_status(room_id, ConnState::Error, err.to_string()),
                }
            })
        };

        Self {
            room,
            buffer,
            bus,
            cancel,
            tasks: vec![collector, driver],
        }
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

    pub fn cap(&self) -> usize {
        self.buffer.lock().expect("buffer poisoned").cap()
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

    #[test]
    fn buffer_evicts_oldest_when_over_capacity() {
        let mut buf = MessageBuffer::new(3);
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
        let mut buf = MessageBuffer::new(2);
        for ts in 0..4 {
            buf.push(msg(ts, MessageKind::Danmaku, 1, "x"));
        }
        let ids: Vec<u64> = buf.snapshot().iter().map(|m| m.local_id).collect();
        assert_eq!(ids, vec![3, 4]);
    }

    #[test]
    fn query_filters_then_keeps_tail_in_ascending_order() {
        let mut buf = MessageBuffer::new(100);
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
        let mut buf = MessageBuffer::new(10);
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

    /// 端口层的假适配器：只投递预置消息，然后挂起等待取消。
    struct FakeSource {
        messages: Vec<Message>,
    }

    #[async_trait::async_trait]
    impl LiveSource for FakeSource {
        async fn resolve_room(&self, _input: &str) -> Result<Room> {
            Ok(Room::default())
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
        });
        let mut events = bus.subscribe();
        let first = RoomRuntime::spawn(room.clone(), 5000, bus.clone(), counters.clone(), noisy);
        settle().await;
        assert_eq!(first.len(), 2, "本会话收到的消息应在缓冲内");
        assert_eq!(first.cap(), 5000);
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
        let quiet: Arc<dyn LiveSource> = Arc::new(FakeSource { messages: vec![] });
        let second = RoomRuntime::spawn(room, 5000, bus, counters, quiet);
        settle().await;
        assert!(second.is_empty(), "重进必须是新会话，旧缓冲不得残留");
        second.close().await.unwrap();
    }
}
