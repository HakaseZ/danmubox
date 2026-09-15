//! `INTERACT_WORD_V2` 的 protobuf 载荷（`docs/protocol.md` §10.4）。
//!
//! 载荷在 JSON 的 **`data.pb`** 字段里（base64），不是 `data` 本身。
//!
//! 本文件只声明**已用真实流量核对过**的字段：
//! 2026-09-11 在真实房间抓取的样本逐字段比对（房间号不写入仓库，见 `AGENT.md` §8）。
//! 未核对的字段一律不声明——prost 会跳过未声明的 tag，少声明比声明错更安全：
//! 字段号或类型写错会直接导致解码失败，从而丢掉整条消息。

use prost::Message;

#[derive(Clone, PartialEq, Message)]
pub struct UserBase {
    #[prost(string, tag = "1")]
    pub uname: String,
    #[prost(string, tag = "2")]
    pub face: String,
}

/// 用户在本房间的粉丝牌。字段名待校准，等级与名称已按样本核对。
#[derive(Clone, PartialEq, Message)]
pub struct UserMedalInfo {
    #[prost(string, tag = "1")]
    pub name: String,
    #[prost(uint32, tag = "2")]
    pub level: u32,
}

#[derive(Clone, PartialEq, Message)]
pub struct UserInfo {
    #[prost(uint32, tag = "1")]
    pub uid: u32,
    #[prost(message, optional, tag = "2")]
    pub base: Option<UserBase>,
    #[prost(message, optional, tag = "3")]
    pub medal_info: Option<UserMedalInfo>,
}

/// 进场/互动事件的 protobuf 载荷。
#[derive(Clone, PartialEq, Message)]
pub struct InteractWordV2 {
    #[prost(uint32, tag = "1")]
    pub uid: u32,
    #[prost(string, tag = "2")]
    pub uname: String,
    #[prost(uint32, tag = "5")]
    pub msg_type: u32,
    #[prost(uint32, tag = "6")]
    pub roomid: u32,
    /// 秒级时间戳。
    #[prost(uint64, tag = "7")]
    pub timestamp: u64,
    /// 毫秒级时间戳。这一字段与 `timestamp` 同为 varint，
    /// 但社区 schema 曾把它写成 32 位——毫秒值必然溢出，故按 64 位声明。
    #[prost(uint64, tag = "8")]
    pub timestamp_millisecond: u64,
    #[prost(message, optional, tag = "22")]
    pub user_info: Option<UserInfo>,
}

impl InteractWordV2 {
    /// 时间戳：优先毫秒字段，回落到秒字段；两者都没有则返回 `None`。
    pub fn ts_ms(&self) -> Option<i64> {
        if self.timestamp_millisecond > 0 {
            Some(self.timestamp_millisecond as i64)
        } else if self.timestamp > 0 {
            Some(self.timestamp as i64 * 1000)
        } else {
            None
        }
    }

    /// 昵称：顶层为空时回落到 `user_info.base.uname`。
    pub fn display_name(&self) -> String {
        if !self.uname.is_empty() {
            return self.uname.clone();
        }
        self.user_info
            .as_ref()
            .and_then(|u| u.base.as_ref())
            .map(|b| b.uname.clone())
            .unwrap_or_default()
    }

    /// 头像：`user_info.base.face`（与昵称同层，`docs/protocol.md` §10.4 的 tag 22）。
    /// 顶层没有头像字段，取不到即空串——不拿别的层的值顶替。
    pub fn face(&self) -> String {
        self.user_info
            .as_ref()
            .and_then(|u| u.base.as_ref())
            .map(|b| b.face.clone())
            .unwrap_or_default()
    }

    /// 粉丝牌等级与名称。互动事件不携带大航海等级，统一回落为 0。
    pub fn medal(&self) -> (i64, String) {
        match self.user_info.as_ref().and_then(|u| u.medal_info.as_ref()) {
            Some(medal) => (medal.level as i64, medal.name.clone()),
            None => (0, String::new()),
        }
    }
}

/// `SEND_GIFT_V2` 的 protobuf 载荷（`docs/protocol.md` §10.2）。
///
/// 与 `INTERACT_WORD_V2` 同一套路：JSON 只有 `{dmscore, pb}`，内容在 `pb` 里。
///
/// **字段名的来源**：礼物子消息（`GiftV2Item`）的字段名与 tag 抄自官方前端产物里
/// 生成好的 proto 代码；顶层这几个字段（uid / uname / face / 粉丝牌 / 接收者）
/// 则是按真实样本的取值形态核对出来的（10 位数且与用户名同现 → uid，等等）。
/// 顶层还有一个 `sender_uinfo`（嵌套用户信息），tag 未知、本实现不用。
/// 社区文档里没有这个命令的 schema。
#[derive(Clone, PartialEq, Message)]
pub struct GiftV2 {
    #[prost(uint64, tag = "1")]
    pub uid: u64,
    #[prost(string, tag = "2")]
    pub uname: String,
    #[prost(string, tag = "3")]
    pub face: String,
    #[prost(message, optional, tag = "8")]
    pub medal: Option<GiftV2Medal>,
    #[prost(message, optional, tag = "10")]
    pub gift: Option<GiftV2Item>,
    #[prost(message, optional, tag = "29")]
    pub anchor: Option<GiftV2Anchor>,
}

/// 送礼者的粉丝牌。`5`/`6` 分别是等级与名称（按取值形态反推）。
#[derive(Clone, PartialEq, Message)]
pub struct GiftV2Medal {
    #[prost(uint32, tag = "5")]
    pub level: u32,
    #[prost(string, tag = "6")]
    pub name: String,
}

/// 礼物本体，对应官方 `bilibili.live.gift.v1.GiftItem`。
///
/// 字段名与 tag 取自**官方前端产物里生成好的 proto 代码**（`t.GiftItem=function(){…}`
/// 的字段声明顺序即 tag 顺序），因此不再是"按取值反推"。
/// 只声明用得到的字段：prost 会跳过未声明的 tag。
#[derive(Clone, PartialEq, Message)]
pub struct GiftV2Item {
    #[prost(uint64, tag = "1")]
    pub gift_id: u64,
    #[prost(string, tag = "2")]
    pub gift_name: String,
    /// 数量。
    #[prost(uint64, tag = "3")]
    pub num: u64,
    /// 原价（金瓜子）。
    #[prost(uint64, tag = "5")]
    pub price: u64,
    /// 折后价（金瓜子）。
    #[prost(uint64, tag = "6")]
    pub discount_price: u64,
    /// 金瓜子 / 银瓜子等口径。
    #[prost(string, tag = "8")]
    pub coin_type: String,
    /// 订单号。
    #[prost(string, tag = "9")]
    pub tid: String,
    /// 秒级时间戳。
    #[prost(uint64, tag = "10")]
    pub timestamp: u64,
    /// 连击标识（样本形如 `batch:gift:combo_id:…`），供会话内聚合。
    #[prost(string, tag = "12")]
    pub batch_combo_id: String,
    /// 本次投喂的总瓜子数（价 × 数量）。
    #[prost(uint64, tag = "7")]
    pub total_coin: u64,
    /// 动作词，样本为「投喂」。
    #[prost(string, tag = "18")]
    pub action: String,
}

/// 受赠主播。
#[derive(Clone, PartialEq, Message)]
pub struct GiftV2Anchor {
    #[prost(string, tag = "1")]
    pub uname: String,
    #[prost(uint64, tag = "2")]
    pub uid: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_roundtripped_payload() {
        let original = InteractWordV2 {
            uid: 12345,
            uname: "路人甲".into(),
            msg_type: 1,
            roomid: 7654321,
            timestamp: 1_789_134_579,
            timestamp_millisecond: 1_789_134_579_109,
            user_info: Some(UserInfo {
                uid: 12345,
                base: Some(UserBase {
                    uname: "路人甲".into(),
                    face: "https://i0.hdslb.com/bfs/face/aef6.png".into(),
                }),
                medal_info: None,
            }),
        };
        let bytes = original.encode_to_vec();
        let decoded = InteractWordV2::decode(bytes.as_slice()).unwrap();

        assert_eq!(decoded.uid, 12345);
        assert_eq!(decoded.roomid, 7654321);
        assert_eq!(decoded.display_name(), "路人甲");
        assert_eq!(decoded.ts_ms(), Some(1_789_134_579_109));
    }

    #[test]
    fn unknown_fields_are_skipped() {
        // 线上样本里存在多个未声明 tag（4 / 12 / 15 / 19 / 23 / 24），
        // 解码必须忽略它们而不是失败。
        let mut bytes = InteractWordV2 {
            uid: 7,
            uname: "u".into(),
            ..Default::default()
        }
        .encode_to_vec();
        bytes.extend_from_slice(&[0x78, 0x01]); // field 15, varint 1
        bytes.extend_from_slice(&[0xC2, 0x01, 0x03, b'a', b'b', b'c']); // field 24, "abc"
        let decoded = InteractWordV2::decode(bytes.as_slice()).unwrap();
        assert_eq!(decoded.uid, 7);
        assert_eq!(decoded.uname, "u");
    }

    #[test]
    fn falls_back_to_nested_name_and_medal() {
        let decoded = InteractWordV2 {
            uid: 5,
            user_info: Some(UserInfo {
                uid: 5,
                base: Some(UserBase {
                    uname: "nested".into(),
                    face: "http://x/y.png".into(),
                }),
                medal_info: Some(UserMedalInfo {
                    name: "粉丝牌".into(),
                    level: 24,
                }),
            }),
            ..Default::default()
        };
        assert_eq!(decoded.display_name(), "nested");
        assert_eq!(decoded.medal(), (24, "粉丝牌".to_string()));
        assert_eq!(decoded.ts_ms(), None, "两个时间戳都缺失时不得编造");
    }

    #[test]
    fn gift_v2_decodes_gift_sender_and_combo() {
        use prost::Message as _;
        let item = GiftV2Item {
            gift_id: 31164,
            gift_name: "粉丝团灯牌".into(),
            num: 1,
            price: 100,
            discount_price: 100,
            coin_type: "gold".into(),
            tid: "4816040157599941120".into(),
            timestamp: 1_789_177_882,
            batch_combo_id: "batch:gift:combo_id:1:2:31164:1789177882.31".into(),
            total_coin: 100,
            action: "投喂".into(),
        };
        let original = GiftV2 {
            uid: 1920714644,
            uname: "送礼的人".into(),
            face: "https://i2.hdslb.com/bfs/face/x.jpg".into(),
            medal: Some(GiftV2Medal {
                level: 12,
                name: "小碗茶".into(),
            }),
            gift: Some(item),
            anchor: Some(GiftV2Anchor {
                uname: "主播".into(),
                uid: 401742377,
            }),
        };
        let bytes = original.encode_to_vec();
        let decoded = GiftV2::decode(bytes.as_slice()).expect("必须解得出来");
        assert_eq!(decoded.uid, 1920714644);
        assert_eq!(decoded.uname, "送礼的人");
        let gift = decoded.gift.expect("礼物子消息");
        assert_eq!(gift.gift_name, "粉丝团灯牌");
        assert_eq!(gift.price, 100);
        assert_eq!(gift.coin_type, "gold");
        assert_eq!(gift.num, 1);
        assert!(gift.batch_combo_id.starts_with("batch:gift:combo_id:"));
        assert_eq!(decoded.medal.map(|m| m.level), Some(12));
    }
}
