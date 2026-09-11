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

    /// 粉丝牌等级与名称。互动事件不携带大航海等级，统一回落为 0。
    pub fn medal(&self) -> (i64, String) {
        match self.user_info.as_ref().and_then(|u| u.medal_info.as_ref()) {
            Some(medal) => (medal.level as i64, medal.name.clone()),
            None => (0, String::new()),
        }
    }
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
}
