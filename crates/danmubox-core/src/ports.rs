//! 端口（trait）。`danmubox-core` 只定义能力边界与领域模型，
//! 所有上游知识（URL、字段下标、签名、protobuf）都在 `danmubox-bili` 内实现。
//!
//! 端口集合见 `docs/contract.md` §3。新增能力先把端口补在这里，
//! 再决定要不要在 IPC 层暴露（`docs/ipc.md` §9）。
//!
//! 统一用 `#[async_trait]`：这些端口要以 `Arc<dyn Trait>` 持有，
//! 原生 `async fn` in trait 不具备 dyn 兼容性。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::bus::{Cancel, MessageSink};
use crate::error::Result;
use crate::model::{Emote, FollowedRoom, Message, ReportReason, Room, RoomSession, SendOutcome};

/// 登录态。**不含**任何 Cookie 值（`docs/contract.md` §7）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    pub logged_in: bool,
    pub uid: i64,
    pub nickname: String,
    pub active_profile: String,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            logged_in: false,
            uid: 0,
            nickname: String::new(),
            active_profile: "default".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QrChallenge {
    pub key: String,
    pub url: String,
}

/// 扫码状态机的归一化取值；上游未知状态码一律归入 `Pending`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QrState {
    Pending,
    Scanned,
    Confirmed,
    Expired,
}

#[async_trait]
pub trait AuthProvider: Send + Sync {
    async fn session(&self) -> Result<SessionState>;
    async fn begin_qr(&self) -> Result<QrChallenge>;
    async fn poll_qr(&self, key: &str) -> Result<QrState>;
    async fn logout(&self) -> Result<()>;
    async fn profiles(&self) -> Result<Vec<String>>;
    async fn switch_profile(&self, name: &str) -> Result<SessionState>;
}

#[async_trait]
pub trait LiveSource: Send + Sync {
    /// 进场回填：上游能给的**最近若干条**弹幕（上限 10 条普通 + 10 条房管，
    /// 不可翻页，见 `docs/protocol.md` 附录 A30）。返回的每条 `is_history` 为 `true`。
    ///
    /// 这是"进场时不要空着"，**不是**可翻页的历史；失败只记日志，不得阻塞会话。
    async fn recent(&self, room_id: i64) -> Result<Vec<Message>>;

    /// 房间号 / 短号 / URL → 房间元信息。
    async fn resolve_room(&self, input: &str) -> Result<Room>;

    /// 保持连接直到 `cancel` 触发；心跳、解包、重连与退避都在实现内完成。
    /// 返回 `Ok(())` 表示被正常取消。
    async fn stream(&self, room_id: i64, sink: MessageSink, cancel: Cancel) -> Result<()>;
}

/// 一次发送的完整结果：归一化结论 + 上游的原始答复。
///
/// `SendOutcome` 只表达**已经敢下结论**的那几种；上游的 `code` 与 `msg` 原话一并带回，
/// 界面才能回答「为什么失败」（`REQUIREMENTS.md` §2.3 要求给出禁言 / 频率 / 粉丝牌等原因）。
/// **不做码表映射**：`code` 只原样透传，不翻译成自造语义（`docs/protocol.md` 附录 A17）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendReport {
    pub outcome: SendOutcome,
    /// 上游 `code`；本地节流拦下时为 `None`（那时根本没发请求）。
    pub upstream_code: Option<i64>,
    /// 上游 `msg` / `message` 原文，不翻译。
    pub upstream_message: Option<String>,
}

impl SendReport {
    /// 已知结论且无附加信息的报告（本地判定用）。
    pub fn local(outcome: SendOutcome) -> Self {
        Self {
            outcome,
            upstream_code: None,
            upstream_message: None,
        }
    }
}

/// 发送一条**表情弹幕**所需的全部字段，取值直接来自表情包接口（`Emote`）。
///
/// 官方 web 客户端的发送载荷（`msg/send`）是：`msg = emoticon_unique`、`dm_type = 1`、
/// `emoticonOptions = { width, height, inPlayerArea, url, emoji, isDynamic,
/// bulgeDisplay, emoticonUnique }`——见 `docs/protocol.md` §11.4。
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EmoteToken {
    pub emoticon_unique: String,
    pub emoji: String,
    pub url: String,
    pub width: i64,
    pub height: i64,
    pub is_dynamic: bool,
    pub in_player_area: bool,
    pub bulge_display: bool,
}

/// @ 某人与回复某条弹幕所需的目标信息。
///
/// 官方 web 客户端的载荷（见 `docs/protocol.md` §11.6）：`reply_mid`（被 @ 者 uid）、
/// `reply_uname`、`reply_type`，回复某条时另有 `replay_dmid`（**官方字段名就是这个拼写**）。
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ReplyTarget {
    pub mid: i64,
    pub uname: String,
    /// 被回复弹幕的上游标识（`Message.upstream_id`）；仅 @ 时为空。
    #[serde(default)]
    pub dmid: String,
}

#[async_trait]
pub trait DanmakuSender: Send + Sync {
    /// 发送弹幕；被吞的两种情形由上游响应判定（`docs/contract.md` §5）。
    ///
    /// `emote` 为 `Some` 时发送**表情弹幕**（此时 `content` 仅用于日志与节流判重）。
    async fn send(
        &self,
        room_id: i64,
        content: &str,
        color: Option<i64>,
        mode: Option<i64>,
        emote: Option<&EmoteToken>,
        reply: Option<&ReplyTarget>,
    ) -> Result<SendReport>;
}

#[async_trait]
pub trait DanmakuReporter: Send + Sync {
    /// 上游固定的举报理由清单（官方客户端用它反查 `reason_id`）。
    async fn reasons(&self) -> Result<Vec<ReportReason>>;

    /// 举报一条弹幕。理由取自上一步返回的清单——官方客户端同时上报 `reason` 文案与 `reason_id`。
    async fn report(&self, message: &Message, reason: &ReportReason) -> Result<()>;
}

#[async_trait]
pub trait EmoteProvider: Send + Sync {
    /// 按我在该房间的身份（粉丝牌 / 大航海 / 房管）加载可用表情包。
    async fn emotes(&self, room_id: i64, session: &RoomSession) -> Result<Vec<Emote>>;
}

#[async_trait]
pub trait RoomCatalog: Send + Sync {
    /// 关注列表；展示时直播中置顶（用 `crate::model::sort_followed`）。
    async fn followed(&self) -> Result<Vec<FollowedRoom>>;
}

#[async_trait]
pub trait WalletProvider: Send + Sync {
    /// 电池余额。
    async fn balance(&self) -> Result<i64>;
}
