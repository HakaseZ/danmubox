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
    pub content: String,
    pub color: i64,
    pub medal_level: i64,
    pub medal_name: String,
    pub guard_level: i64,
    pub is_admin: bool,
    /// 是否来自**进场回填**的历史弹幕（上游 `dM/gethistory`，上限 10+10，
    /// 见 `docs/protocol.md` 附录 A30）。实时推来的消息恒为 `false`。
    #[serde(default)]
    pub is_history: bool,
    pub amount: i64,
    /// 表情弹幕的图片地址（已规范化为 https）；非表情弹幕为空串。
    /// 上游把表情信息放在 `DANMU_MSG` 的 `info[0][13]`，非表情时该槽位是空对象。
    #[serde(default)]
    pub emote_url: String,
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
            content: String::new(),
            color: 0,
            medal_level: 0,
            medal_name: String::new(),
            guard_level: 0,
            is_admin: false,
            is_history: false,
            amount: 0,
            emote_url: String::new(),
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

/// 房间元信息。`anchor_uid` 用于派生「主播」徽标，不另设字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Room {
    pub room_id: i64,
    pub short_id: i64,
    pub anchor_uid: i64,
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
    Admin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Emote {
    pub key: String,
    pub package_kind: EmotePackage,
    pub text: String,
    pub url: String,
    pub room_id: i64,
}

/// 关注列表条目。展示时 `live_status == 1` 置顶。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FollowedRoom {
    pub room_id: i64,
    pub uname: String,
    pub face: String,
    pub live_status: i32,
    pub group_name: String,
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
                live_status: 0,
                group_name: String::new(),
            },
            FollowedRoom {
                room_id: 2,
                uname: "b".into(),
                face: String::new(),
                live_status: 1,
                group_name: String::new(),
            },
            FollowedRoom {
                room_id: 1,
                uname: "a".into(),
                face: String::new(),
                live_status: 1,
                group_name: String::new(),
            },
        ];
        sort_followed(&mut rooms);
        let ids: Vec<i64> = rooms.iter().map(|r| r.room_id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }
}
