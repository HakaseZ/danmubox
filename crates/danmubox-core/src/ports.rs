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
use crate::model::{
    AnchorArea, AnchorGate, BlacklistedUser, Emote, FollowedRoom, Message, OwnRoom, ReportReason,
    Room, RoomSession, SendOutcome, SilentUser, StreamEndpoints,
};

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

/// 一个**账号**：一份具名凭据，外加它的登录状态与身份（`docs/contract.md` §5）。
///
/// 「账号」在存储上就是 `config.toml` 里的一份 `[profiles.<name>]`（契约 §4.1），
/// 但对外一律叫账号。游客态**不是**账号：没有具名凭据就没有条目。
/// `logged_in = false` 的账号仍然存在——它是「登出后留下的槽位」，
/// 可以再登录回来，也可以删掉。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    /// 账号名：`config.toml` 的表键，也是界面用来切换 / 删除的标识。
    pub name: String,
    /// 已登录时的昵称；未登录或求证失败时为空串。
    pub nickname: String,
    /// 已登录时的 uid；未登录时退回凭据里记着的 `DedeUserID`（可能为 0）。
    pub uid: i64,
    /// 已登录时的头像地址；未登录或求证失败时为空串（界面据此决定是否渲染头像）。
    pub face: String,
    /// 凭据是否有效。以 `nav` 求证为准，不只是「字段齐不齐」。
    pub logged_in: bool,
    /// 是否是当前生效的账号。
    pub active: bool,
}

/// 扫码轮询结果：归一化状态 + **确认时**落盘的那个账号。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QrPoll {
    pub state: QrState,
    /// 只有 `state == Confirmed` 时是 `Some`——那一次凭据已经落盘、账号已经存在。
    pub account: Option<Account>,
}

#[async_trait]
pub trait AuthProvider: Send + Sync {
    /// 当前登录态（不含任何 Cookie 值）。
    async fn session(&self) -> Result<SessionState>;

    /// 列出全部账号，**每个账号都带登录状态与身份**（昵称 / uid / 头像）。
    ///
    /// 有凭据的账号逐个向 `nav` 求证——字段齐全不等于凭据有效（契约 §7 的
    /// 判定口径与 `session` 一致）：凭据失效才算未登录，网络错误**不改**登录态。
    /// 各账号的求证必须并发发起，且单个账号失败不影响其余账号照常列出。
    async fn accounts(&self) -> Result<Vec<Account>>;

    /// 取回二维码内容。
    ///
    /// `target` 为 `None` = **新增一个账号**（账号名在确认后按昵称自动生成，
    /// 用户不需要先起名）；`Some(name)` = 给该账号重新登录，目标不存在报 `NOT_FOUND`。
    /// 新一轮扫码作废上一轮尚未消费的 `key`。
    async fn begin_qr(&self, target: Option<&str>) -> Result<QrChallenge>;

    /// 轮询扫码状态；`Confirmed` 时由实现**完成落盘**并返回该账号。
    ///
    /// `key` 从未开始或已被消费 → `NOT_FOUND`（终态：确认与失效都会消费掉 `key`）。
    async fn poll_qr(&self, key: &str) -> Result<QrPoll>;

    /// 切换当前账号，返回切换后的会话。
    async fn switch_account(&self, name: &str) -> Result<SessionState>;

    /// 登出：清空凭据但**保留账号条目**（`None` = 当前账号）。
    ///
    /// 清空后那个账号仍在列表里，只是 `logged_in = false`——这样既能退回游客态，
    /// 又留住了这个账号的槽位。返回登出之后的会话。
    async fn logout(&self, name: Option<&str>) -> Result<SessionState>;

    /// 删除账号：不许删掉最后一个；删的是当前账号则自动切到剩下的第一个。
    async fn remove_account(&self, name: &str) -> Result<SessionState>;
}

#[async_trait]
pub trait LiveSource: Send + Sync {
    /// 进场回填：上游能给的**最近若干条**弹幕（上限 10 条，不可翻页，见
    /// `docs/protocol.md` 附录 A30）。返回的每条 `is_history` 为 `true`，且按时间升序。
    ///
    /// 这是"进场时不要空着"，**不是**可翻页的历史；失败只记日志，不得阻塞会话。
    async fn recent(&self, room_id: i64) -> Result<Vec<Message>>;

    /// 房间号 / 短号 / URL → 房间元信息。
    async fn resolve_room(&self, input: &str) -> Result<Room>;

    /// 只读一次某房间的**开播状态**（`0` 未开播 / `1` 直播中 / `2` 轮播）。
    ///
    /// 与 [`LiveSource::resolve_room`] 的区别：**不做**昵称与标题那一跳（那一跳是
    /// 「登记房间」才要的锦上添花，`docs/contract.md` §6），只问状态本身。列表页的定期刷新
    /// （`contract.md` §4 的 30 秒那一拍）逐房间调它，因此这一条要尽量便宜：一次只读 GET。
    ///
    /// 房间号必须是**真实 `room_id`**（短号由 `resolve_room` 解析过）。
    async fn live_status(&self, room_id: i64) -> Result<i32>;

    /// 本人**在该房间**的身份（粉丝牌 / 大航海 / 房管；`RoomSession`）。
    ///
    /// 只有拿到它，界面才知道「我在这房间是不是房管」——房管菜单的可见性与禁用
    /// 状态靠它，而不是靠「点一次等上游报错」。未登录时返回全零身份（不是错误）；
    /// 上游取不到时报错，由调用方按「身份未知」容错。
    async fn room_identity(&self, room_id: i64) -> Result<RoomSession>;

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

    /// **主站「我的表情」**：当前账号拥有的表情包（`upower_` 家族）。
    ///
    /// 与 `emotes` 不是同一套上游：那套是直播间的通用 / 房间 / 粉丝牌 / 大航海，
    /// 而这套来自主站表情面板。弹幕里能收到 `upower_` 表情、直播表情接口却取不到，
    /// 只能靠这条路径把它们补进选择器（`docs/protocol.md` 附录 A35）。
    /// 未登录时上游会退化为免费表情包，照常返回。
    async fn owned(&self) -> Result<Vec<Emote>>;
}

/// 直播间管理（房管）能力。**只有请求者本人是该房间的房管时才成立**：
/// 非房管时上游返回非 0 code，本层原样带回，不赋语义
/// （`docs/protocol.md` 附录 A36）。
///
/// 纪律：任何写操作都**不得以真实观众为目标**做验证（`AGENT.md` §8.15）。
#[async_trait]
pub trait RoomAdmin: Send + Sync {
    /// 当前禁言名单（只读）。
    async fn silent_list(&self, room_id: i64) -> Result<Vec<SilentUser>>;

    /// 禁言一名观众。`hour`：`-1` 永久 / `0` 本场直播 / 其余为小时数；
    /// `msg` 是触发禁言的那条弹幕原文（上游可选）。
    async fn mute(&self, room_id: i64, uid: i64, hour: i64, msg: Option<&str>) -> Result<()>;

    /// 解除禁言。
    async fn unmute(&self, room_id: i64, uid: i64) -> Result<()>;

    /// 房间黑名单（只读）。
    async fn blacklist(&self, room_id: i64) -> Result<Vec<BlacklistedUser>>;

    /// 把一名观众加入黑名单。
    async fn blacklist_add(&self, room_id: i64, uid: i64) -> Result<()>;

    /// 把一名观众移出黑名单。
    async fn blacklist_del(&self, room_id: i64, uid: i64) -> Result<()>;

    /// 屏蔽词列表（只读）。
    async fn keywords(&self, room_id: i64) -> Result<Vec<String>>;

    /// 新增一个屏蔽词。上游一次只收一个 `keyword`；需要多个时由调用方逐个传。
    async fn keyword_add(&self, room_id: i64, word: &str) -> Result<()>;

    /// 删除一个屏蔽词。
    async fn keyword_del(&self, room_id: i64, word: &str) -> Result<()>;
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

/// 我自己的直播间（主播视角，`docs/contract.md` §3）。
///
/// 与 `LiveSource` 的分工：后者是「看别人的房间」（只读，游客也可用），
/// 这里是「管自己的房间」——三件写操作 + 取分区全落在这里。
///
/// 写操作纪律（`docs/contract.md` §3 / `AGENT.md` §8.14–16）：只作用于**该账号自己的直播间**
/// （账号在**构造期**定死，见 `danmubox_bili::BiliAnchor::new_for`：缺省当前账号，也可按账号名
/// 指定 —— 管理别的账号的直播间不必先切号），失败即停、不换房间 / 账号 / 参数重试；
/// 上游非 0 code 原样带回、不赋语义。
/// 唯一的例外是 `AnchorGate`：开播被身份校验挡住时产出引导而不是判定。
#[async_trait]
pub trait AnchorRoom: Send + Sync {
    /// 取该账号自己的直播间。**没开通返回 `Ok(None)`，不是错误**——界面据此整块不渲染。
    async fn own(&self) -> Result<Option<OwnRoom>>;

    /// 改自己直播间标题。空标题由调用方前置拒绝（见 `anchor_title_set`）。成功返回重读后的 `OwnRoom`。
    async fn set_title(&self, title: &str) -> Result<OwnRoom>;

    /// 改分区（`area_v2` = **子分区 id**）。这是**独立于开播**的写入口：不必等到开播就能改，
    /// 与 `go_live` 的 `area_v2` 覆盖互不替代。`<= 0` 为非法值 → `BAD_REQUEST`。
    /// 成功返回重读后的 `OwnRoom`。
    async fn set_area(&self, area_v2: i64) -> Result<OwnRoom>;

    /// 开播。`area_v2` 缺省沿用直播间当前 `area_id`（上次开播分区）；`Some(v)` 为界面所选子分区覆盖。
    ///
    /// 成功返回 `Opened(StreamEndpoints)`；被上游身份校验挡住返回 `Blocked(AnchorGate)`；
    /// 其余非 0 code 仍按纪律原样带回（`Err`）。
    async fn go_live(&self, area_v2: Option<i64>) -> Result<AnchorLiveOutcome>;

    /// 下播。成功返回 `Ok(())`。
    async fn end_live(&self) -> Result<()>;

    /// 开播分区树（两级）。用于界面分区选择；上游分区为公开数据，不登录也可。
    async fn area_list(&self) -> Result<Vec<AnchorArea>>;
}

/// `go_live` 的两种结果，互斥（`docs/contract.md` §3 / §7）。
pub enum AnchorLiveOutcome {
    /// 开播成功，给出推流端点。
    Opened(StreamEndpoints),
    /// 被上游身份校验挡住，给出引导。
    Blocked(AnchorGate),
}
