use serde::{Deserialize, Serialize};

/// 归一化消息类型。取值**只有六种**（`docs/contract.md` §5），
/// 任何上游命令都必须映射到其中之一。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    Danmaku,
    Gift,
    Superchat,
    Interact,
    Guard,
    System,
}

impl MessageKind {
    pub const ALL: [MessageKind; 6] = [
        Self::Danmaku,
        Self::Gift,
        Self::Superchat,
        Self::Interact,
        Self::Guard,
        Self::System,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Danmaku => "danmaku",
            Self::Gift => "gift",
            Self::Superchat => "superchat",
            Self::Interact => "interact",
            Self::Guard => "guard",
            Self::System => "system",
        }
    }
}

impl std::str::FromStr for MessageKind {
    type Err = crate::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "danmaku" => Ok(Self::Danmaku),
            "gift" => Ok(Self::Gift),
            "superchat" => Ok(Self::Superchat),
            "interact" => Ok(Self::Interact),
            "guard" => Ok(Self::Guard),
            "system" => Ok(Self::System),
            other => Err(crate::Error::BadRequest(format!("unknown kind: {other}"))),
        }
    }
}

/// 归一化消息。字段集合见 `docs/contract.md` §5，不得增删。
///
/// `local_id` 由会话缓冲分配（0 表示尚未分配）；`upstream_id` 是举报所需的上游标识，
/// 其来源在 `docs/protocol.md` 的待实测校准表中登记。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub local_id: u64,
    pub room_id: i64,
    pub kind: MessageKind,
    pub ts: i64,
    pub uid: i64,
    pub uname: String,
    /// 发送者头像地址（上游 `user.base.face`，实时弹幕与历史条目同一位置）。
    /// 取不到或上游未下发时为空串——界面据此决定是否渲染头像。
    #[serde(default)]
    pub face: String,
    pub content: String,
    pub color: i64,
    pub medal_level: i64,
    pub medal_name: String,
    /// 粉丝牌配色，取值是上游的 **CSS 十六进制串**（带 alpha，如 `#3FB4F699`）。
    ///
    /// 来源是弹幕载荷里 `user.medal` 的 `v2_medal_color_*` 一组（`docs/protocol.md` 附录 A37）。
    /// 官方前端的 `getMedalHtml` 用的就是这四个；同层还有 `v2_medal_color_level`，
    /// 本期不消费。缺失时为空串——**空串不是可用的颜色**，界面必须自备兜底色，
    /// 不得拿空串当 `#000000` 渲染。
    #[serde(default)]
    pub medal_color_start: String,
    #[serde(default)]
    pub medal_color_end: String,
    #[serde(default)]
    pub medal_color_border: String,
    #[serde(default)]
    pub medal_color_text: String,
    /// 发送者**在本房间**的大航海等级：0 无 / 1 总督 / 2 提督 / 3 舰长。
    ///
    /// 只认本房间的身份（`docs/protocol.md` 附录 A39）。**不得**拿粉丝牌上的
    /// `guard_level` 兜底：「别的房间的舰长」戴的是那个房间的舰长牌，
    /// 用牌子来画舰长标就是把别的房间的身份按到本房间头上。
    pub guard_level: i64,
    /// 发送者**粉丝牌自身**的舰长标记（上游 `user.medal.guard_level`）。
    ///
    /// 与 `guard_level` 是两回事：它表示「这块牌子来自某个房间的舰长」，
    /// 官方前端只用它做**粉丝牌**的样式区分（牌面留白与描边），
    /// **不**用它画舰长标。两者都留，界面才不会混用。
    #[serde(default)]
    pub medal_guard_level: i64,
    pub is_admin: bool,
    /// 是否来自**进场回填**的历史弹幕（上游 `dM/gethistory`，上限 10+10，
    /// 见 `docs/protocol.md` 附录 A30）。实时推来的消息恒为 `false`。
    #[serde(default)]
    pub is_history: bool,
    pub amount: i64,
    /// 礼物连击标识（上游 `batch_combo_id`）；非连击类消息为空串。
    /// 同一次连击的每条礼物共用它，界面据此聚合展示（`docs/protocol.md` §10.2）。
    #[serde(default)]
    pub combo_id: String,
    /// 表情弹幕的表情信息；非表情弹幕为 `None`。
    ///
    /// 存的是**整份**表情信息（而不只是图片地址），因为界面要能把它**再发出去**——
    /// 上游有些表情家族（如 `upower_` 的 UP 主专属表情）不在直播表情接口里，
    /// 只能从收到的弹幕里学到。见 `docs/protocol.md` 附录 A35。
    // 装箱：绝大多数消息没有表情，内联会让 `Message` 大出一百多字节，
    // 进而把 `Event` 这类以 `Message` 为变体的枚举顶过 clippy 的尺寸阈值。
    // 装箱只在真有表情时分配一次，换取消息本体保持紧凑。
    #[serde(default)]
    pub emote: Option<Box<EmoteRef>>,
    /// 被回复者的 uid；`0` 表示这条不是回复。
    ///
    /// 上游把回复关系塞在 `info[0][15].extra` 这个 JSON 字符串里（历史条目则是
    /// 顶层的 `reply` 对象），字段名都是 `reply_mid`（`docs/protocol.md` §11.6、附录 A40）。
    #[serde(default)]
    pub reply_to_uid: i64,
    /// 被回复者昵称；非回复为空串（上游 `reply_uname`）。
    #[serde(default)]
    pub reply_to_uname: String,
    /// 上游的回复类型枚举（实时 `extra.reply_type_enum`，历史 `reply.reply_type_enum`）。
    ///
    /// 官方枚举是 `{NO_REPLY: 0, NORMAL_REPLY: 1, MATCH_REPLY: 2}`（官方前端产物里的定义）。
    /// **实测只观测到 `0` 与 `1`**（`docs/protocol.md` 附录 A40）：`0` 恒伴随
    /// `reply_to_uid == 0`，`1` 恒伴随 `reply_to_uid != 0` 且 `reply_uname` 非空。
    /// `1` 究竟指「纯 @」还是「回复某条弹幕」**未实测**——收包载荷里没有任何指回
    /// 被回复弹幕的 id（`extra` 的键集合已全量枚举），所以**不要**用它区分这两者。
    #[serde(default)]
    pub reply_type_enum: i64,
    /// 上游的 `show_reply`。
    ///
    /// **实测在所有样本（包括完全没有回复关系的那些）里都是 `true`**，因此它当前
    /// 不是一个可用的判别式；原样带出只为后续校准与调试。
    #[serde(default)]
    pub show_reply: bool,
    /// 被 @ 者名字的颜色（上游 `reply_uname_color`，实测形如 `#FB7299`）；无关系时为空串。
    /// 官方前端用它给「@昵称」上色，界面可用可不用。
    #[serde(default)]
    pub reply_uname_color: String,
    pub upstream_id: String,
}

impl Message {
    /// 以房间与时序构造一条空消息，其余字段由适配器填充。
    pub fn new(room_id: i64, kind: MessageKind, ts: i64) -> Self {
        Self {
            local_id: 0,
            room_id,
            kind,
            ts,
            uid: 0,
            uname: String::new(),
            face: String::new(),
            content: String::new(),
            color: 0,
            medal_level: 0,
            medal_name: String::new(),
            medal_color_start: String::new(),
            medal_color_end: String::new(),
            medal_color_border: String::new(),
            medal_color_text: String::new(),
            guard_level: 0,
            medal_guard_level: 0,
            is_admin: false,
            is_history: false,
            amount: 0,
            combo_id: String::new(),
            emote: None,
            reply_to_uid: 0,
            reply_to_uname: String::new(),
            reply_type_enum: 0,
            show_reply: false,
            reply_uname_color: String::new(),
            upstream_id: String::new(),
        }
    }
}

/// 发弹幕结果（`docs/contract.md` §5）。被吞的两种情形由上游响应判定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SendOutcome {
    Ok,
    BlockedPlatform,
    BlockedRoom,
    RateLimited,
    MedalRequired,
    Muted,
    Failed,
}

/// 弹幕里携带的表情（发送与渲染共用同一份信息）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmoteRef {
    /// 上游唯一键（`emoticon_unique`）——**发送表情弹幕时 `msg` 传的就是它**。
    pub emoticon_unique: String,
    /// 图片地址（已规范化为 https）。
    pub url: String,
    pub width: i64,
    pub height: i64,
    pub is_dynamic: bool,
    pub in_player_area: bool,
    pub bulge_display: bool,
}

/// 举报理由（上游 `dMReport/ForReason` 给的固定清单，官方客户端按文案反查 `id` 后一并上报）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportReason {
    pub id: i64,
    pub reason: String,
}

/// 房间元信息。`anchor_uid` 用于派生「主播」徽标，不另设字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Room {
    pub room_id: i64,
    pub short_id: i64,
    pub anchor_uid: i64,
    /// 主播昵称（上游 `getRoomPlayInfo` 的 `anchor_info.base_info.uname`，只读解析）。
    ///
    /// 界面用它代替房间号展示房间（用户 2026-09-12：#17 房间列表、#18 标签条）。
    /// 上游没给时为空串——界面回落到 `title`，不渲染空。
    #[serde(default)]
    pub anchor_uname: String,
    pub title: String,
    /// 0 未开播 / 1 直播中 / 2 轮播
    pub live_status: i32,
}

impl Room {
    pub fn is_live(&self) -> bool {
        self.live_status == 1
    }

    /// 「主播」徽标：由 `uid == anchor_uid` 派生。
    pub fn is_anchor(&self, uid: i64) -> bool {
        uid != 0 && uid == self.anchor_uid
    }
}

/// 我在某个房间里的身份（会话级，不落盘）。与 `Message` 的牌区分：
/// 后者是发送者的牌，这里是**我**在这个房间的牌。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RoomSession {
    pub room_id: i64,
    pub my_medal_level: i64,
    pub my_medal_name: String,
    pub my_guard_level: i64,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmotePackage {
    Common,
    /// **房间相关**：UP 主大表情与房间专属表情。实测两者的 `pkg_type` 都是 `2`
    /// （`pkg_id` 形如 `327` / `100327`），与通用表情（`pkg_type = 1`）可区分。
    Room,
    Medal,
    Guard,
    /// **主站「我的表情」**：与直播间那套（通用 / 房间 / 粉丝牌 / 大航海）来源不同，
    /// 取自主站表情面板（`docs/protocol.md` 附录 A35 结案）。这些表情没有上游
    /// `emoticon_unique`，唯一键由 `upower_` + 表情文本拼装。
    Owned,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Emote {
    pub key: String,
    pub package_kind: EmotePackage,
    /// 上游唯一键（`emoticon_unique`，如 `official_345` / `room_<房间号>_<id>`）。
    /// 发送表情弹幕时 **`msg` 传的就是它**（官方实现如此，见 `docs/protocol.md` §11.4）。
    pub emoticon_unique: String,
    /// 表情字符（`emoji`），仅用于展示与搜索。
    pub text: String,
    pub url: String,
    /// 以下四项与 `is_dynamic` / `bulge_display` 一起构成官方发送载荷里的 `emoticonOptions`。
    pub width: i64,
    pub height: i64,
    pub is_dynamic: bool,
    pub in_player_area: bool,
    pub bulge_display: bool,
    pub room_id: i64,
    /// **我**现在能不能用这个表情：`true` = 无权限，界面应置灰（不是隐藏）。
    ///
    /// 上游**会**把无权使用的表情一并返回，并在**表情级**用 `perm` 标明可用性；
    /// 实测（`docs/protocol.md` A26 补记）：同一个房间、两个身份不同的账号拿到
    /// **完全相同**的 68 个表情，只有「舰长专属」那一批（`identity = 3`）的
    /// `perm` 随身份从 `0` 变成 `1`。因此这一位由 `perm == 0` 派生，
    /// **字段缺失时按「可用」处理**（宁可少置灰一个，也不要把整面板灰掉）。
    ///
    /// 派生而不把 `perm` 原样透传，是因为界面只需要一个判定位，
    /// 而 `perm` 是上游内部编码（实测只出现过 0 / 1），语义属于适配层。
    #[serde(default)]
    pub locked: bool,
}

/// 关注列表条目。展示时 `live_status == 1` 置顶。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FollowedRoom {
    pub room_id: i64,
    pub uname: String,
    pub face: String,
    /// 直播间标题（上游 `GetWebList` 的 `title`，实测 2026-09-12）；缺失/为空时不展示。
    #[serde(default)]
    pub title: String,
    pub live_status: i32,
    pub group_name: String,
    /// 本场开播时刻（上游 `liveTime`，**Unix 秒**）；`0` 表示未开播或上游未给。
    ///
    /// 与上游另一个同名的 `live_time`（已开播**秒数**，两者相加约等于当前时间）
    /// 是两回事，取值时必须区分，见 `docs/protocol.md` 附录 A28。
    #[serde(default)]
    pub live_start_at: i64,
    /// 在线人数（上游 `online`）；未开播或缺失时为 `0`。
    #[serde(default)]
    pub online: i64,
}

/// 被禁言的观众（房管面板的只读列表项）。字段对应上游列表里的
/// `tuid` / `tname` / `face`（`docs/protocol.md` 附录 A36）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SilentUser {
    pub uid: i64,
    pub uname: String,
    pub face: String,
}

/// 房间黑名单条目（`docs/protocol.md` 附录 A36）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlacklistedUser {
    pub uid: i64,
    pub uname: String,
    pub face: String,
}

/// 关注列表排序：直播中置顶，其余按房间号稳定升序。
pub fn sort_followed(rooms: &mut [FollowedRoom]) {
    rooms.sort_by(|a, b| {
        let a_live = a.live_status == 1;
        let b_live = b.live_status == 1;
        b_live.cmp(&a_live).then_with(|| a.room_id.cmp(&b.room_id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_roundtrip_covers_exactly_six() {
        assert_eq!(MessageKind::ALL.len(), 6);
        for k in MessageKind::ALL {
            assert_eq!(k.as_str().parse::<MessageKind>().unwrap(), k);
        }
        assert!("superchat".parse::<MessageKind>().is_ok());
        assert!("notice".parse::<MessageKind>().is_err());
    }

    #[test]
    fn anchor_is_derived_not_orphan() {
        let room = Room {
            anchor_uid: 42,
            ..Default::default()
        };
        assert!(room.is_anchor(42));
        assert!(!room.is_anchor(7));
        assert!(!room.is_anchor(0), "uid=0 不得被当成主播");
    }

    #[test]
    fn followed_rooms_put_live_first() {
        let mut rooms = vec![
            FollowedRoom {
                room_id: 3,
                uname: "c".into(),
                face: String::new(),
                title: String::new(),
                live_status: 0,
                group_name: String::new(),
                live_start_at: 0,
                online: 0,
            },
            FollowedRoom {
                room_id: 2,
                uname: "b".into(),
                face: String::new(),
                title: String::new(),
                live_status: 1,
                group_name: String::new(),
                live_start_at: 0,
                online: 0,
            },
            FollowedRoom {
                room_id: 1,
                uname: "a".into(),
                face: String::new(),
                title: String::new(),
                live_status: 1,
                group_name: String::new(),
                live_start_at: 0,
                online: 0,
            },
        ];
        sort_followed(&mut rooms);
        let ids: Vec<i64> = rooms.iter().map(|r| r.room_id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }
}
