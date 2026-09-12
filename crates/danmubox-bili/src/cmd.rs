//! `cmd` → 领域消息的映射（`docs/protocol.md` §10）。
//!
//! 只使用 `docs/protocol.md` 已确认的取值路径；未确认的字段一律留默认值，
//! 并在 `debug` 级别打印原始载荷，供阶段 1 的字段实测校准使用
//! （`docs/protocol.md` 附录 A / B）。

use danmubox_core::{Counters, Message, MessageKind};
use prost::Message as _;
use serde_json::Value;

use crate::pb::InteractWordV2;

/// 会产生一条 `system` 消息的命令：生命周期与公告类。
/// `docs/protocol.md` §10.7 对每一类都给了缓冲策略。
const SYSTEM_CMDS: [(&str, &str); 5] = [
    ("LIVE", "开播"),
    ("PREPARING", "下播"),
    ("ROOM_CHANGE", "标题或分区变更"),
    ("CUT_OFF", "被切断"),
    ("NOTICE_MSG", "系统公告"),
];

/// 计数类命令：**不写入会话缓冲**（`docs/protocol.md` §10.7），
/// 只更新房间内存计数。人气值的主要来源是 `POPULARITY_CHANGE`。
const COUNTER_CMDS: [&str; 6] = [
    "POPULARITY_CHANGE",
    "ROOM_REAL_TIME_MESSAGE_UPDATE",
    "WATCHED_CHANGE",
    "LIKE_INFO_V3_CLICK",
    "LIKE_INFO_V3_UPDATE",
    "ONLINE_RANK_V2",
];

/// 已知但与当前订阅房间无关、或纯客户端提示的命令：丢弃且不计为未知。
const IGNORED_CMDS: [&str; 2] = ["STOP_LIVE_ROOM_LIST", "HOT_ROOM_NOTIFY"];

/// `dispatch` 的产出。多数命令产出一条消息；人气值走单独支路——
/// 它高频、只影响界面上的一个数字，既不该进会话缓冲，也不该被当成消息。
///
/// `allow(large_enum_variant)`：`Message` 比 `i64` 大得多，但本枚举是**按值返回**的
/// 临时载体（从不进集合），尺寸不影响任何东西；按 lint 的建议装箱反而会给
/// 每条弹幕多一次堆分配，那才是真的代价。
#[allow(clippy::large_enum_variant)]
pub enum Dispatch {
    Message(Message),
    /// `POPULARITY_CHANGE` 携带的人气值（协议 §10.7）。
    Popularity(i64),
}

/// 把一条业务 JSON 载荷映射为领域产出；不产生任何产出时返回 `None`。
pub fn dispatch(room_id: i64, value: &Value, counters: &Counters) -> Option<Dispatch> {
    let cmd = value.get("cmd").and_then(Value::as_str).unwrap_or_default();
    // 形如 `DANMU_MSG:4:0:2:2:2:0` 的带后缀命令取主干。
    let cmd = cmd.split(':').next().unwrap_or(cmd);

    // 阶段 1 的字段实测校准入口：`DANMUBOX_LOG=debug` 时输出原始载荷
    // （`docs/protocol.md` 附录 B.1）。关闭级别时不做任何格式化。
    tracing::debug!(target: "danmubox::raw", cmd, payload = %value, "原始业务载荷");

    let message = match cmd {
        "DANMU_MSG" => danmaku(room_id, value),
        "DANMU_MSG_MIRROR" => {
            // 非本房间的镜像弹幕：默认丢弃并计数（`docs/protocol.md` §10.7）。
            Counters::bump(&counters.mirrored_dropped);
            tracing::debug!("丢弃镜像弹幕 DANMU_MSG_MIRROR");
            None
        }
        "SEND_GIFT" => gift(room_id, value),
        // V2 礼物管线：内容在 `data.pb`（protobuf），字段见 `pb::GiftV2`。
        // 有些直播间只发这个命令，不接就等于完全看不到礼物（需求 §2.7）。
        "SEND_GIFT_V2" => gift_v2(room_id, value, counters),
        "SUPER_CHAT_MESSAGE" | "SUPER_CHAT_MESSAGE_JP" => superchat(room_id, value),
        "INTERACT_WORD" => interact_json(room_id, value),
        "INTERACT_WORD_V2" => interact_v2(room_id, value, counters),
        "ENTRY_EFFECT" => interact_json(room_id, value),
        "GUARD_BUY" | "USER_TOAST_MSG" => guard(room_id, value),
        other => {
            if COUNTER_CMDS.contains(&other) {
                Counters::bump(&counters.counter_updates);
                let popularity = value
                    .pointer("/data/popularity")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_default();
                tracing::debug!(
                    cmd = other,
                    popularity,
                    "计数类命令：只更新房间计数，不入缓冲"
                );
                // 人气值是唯一要冒泡给界面的计数类命令：其余几类只是数字统计。
                if other == "POPULARITY_CHANGE" {
                    return Some(Dispatch::Popularity(popularity));
                }
                None
            } else if IGNORED_CMDS.contains(&other) {
                tracing::debug!(cmd = other, "已知但与当前房间无关的命令，丢弃");
                None
            } else {
                match SYSTEM_CMDS.iter().find(|(name, _)| *name == other) {
                    Some((_, label)) => {
                        let mut m =
                            Message::new(room_id, MessageKind::System, danmubox_core::now_ms());
                        m.content = (*label).to_string();
                        Some(m)
                    }
                    None => {
                        Counters::bump(&counters.unknown_cmd);
                        tracing::debug!(cmd = other, "未处理的命令，丢弃并计数");
                        None
                    }
                }
            }
        }
    };

    if tracing::enabled!(tracing::Level::DEBUG) {
        if let Some(m) = &message {
            tracing::debug!(
                cmd,
                kind = m.kind.as_str(),
                uid = m.uid,
                "已归一化命令（原始载荷见上一条 debug 输出）"
            );
        }
    }
    message.map(Dispatch::Message)
}

/// 单条弹幕。取值路径均于 2026-09-11 用真实流量核对（`docs/protocol.md` §10.1）：
/// 内容 `info[1]`；颜色 `info[0][3]`；时间戳 `info[0][4]`（毫秒）；
/// 明文用户对象 `info[0][15].user`；粉丝牌 `…user.medal.{level,name,guard_level}`；
/// 举报标识 `info[0][15].extra`（JSON 字符串）的 `id_str`。
fn danmaku(room_id: i64, value: &Value) -> Option<Message> {
    let info = value.get("info")?.as_array()?;
    let content = info.get(1)?.as_str().unwrap_or_default();

    let meta = info.first().and_then(Value::as_array);
    let slot15 = meta.and_then(|m| m.get(15));
    let user = slot15.and_then(|slot| slot.get("user"));

    let mut message = Message::new(room_id, MessageKind::Danmaku, danmubox_core::now_ms());
    message.content = content.to_string();

    if let Some(meta) = meta {
        if let Some(color) = meta.get(3).and_then(Value::as_i64) {
            message.color = color;
        }
        if let Some(ts) = meta.get(4).and_then(Value::as_i64) {
            if ts > 0 {
                message.ts = ts;
            }
        }
    }

    if let Some(user) = user {
        message.uid = user.get("uid").and_then(Value::as_i64).unwrap_or(0);
        message.uname = user
            .pointer("/base/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(level) = user.pointer("/medal/level").and_then(Value::as_i64) {
            message.medal_level = level;
        }
        if let Some(name) = user.pointer("/medal/name").and_then(Value::as_str) {
            message.medal_name = name.to_string();
        }
        message.guard_level = user
            .pointer("/guard/level")
            .and_then(Value::as_i64)
            .or_else(|| user.pointer("/medal/guard_level").and_then(Value::as_i64))
            .unwrap_or(0);
    }

    // 表情弹幕：`info[0][13]` 是**对象**时才有表情信息（非表情弹幕该槽位是字符串 `"{}"`，
    // 实测自两个在播房间（房间号不写入仓库）。此时 `info[1]` 的正文就是表情名，
    // 只显示文字会让人以为「表情没渲染」，所以把图片地址一并带回。
    if let Some(emote) = meta.and_then(|m| m.get(13)).and_then(Value::as_object) {
        if let Some(url) = emote.get("url").and_then(Value::as_str) {
            if !url.is_empty() {
                message.emote_url = crate::asset::secure_url(url);
            }
        }
    }

    // 房管：经典槽位 `info[2][2]`。尚无正向样本，见 `docs/protocol.md` 附录 A 的校准项。
    message.is_admin = info
        .get(2)
        .and_then(Value::as_array)
        .and_then(|slots| slots.get(2))
        .and_then(Value::as_i64)
        == Some(1);

    // 举报所需的上游弹幕标识藏在 extra 这个 JSON 字符串里。
    if let Some(extra) = slot15
        .and_then(|slot| slot.get("extra"))
        .and_then(Value::as_str)
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(extra) {
            if let Some(id) = parsed.get("id_str").and_then(Value::as_str) {
                message.upstream_id = id.to_string();
            }
        }
    }

    Some(message)
}

/// 礼物。字段名（礼物名 / 数量 / 金额）待实测校准，暂只取已确认存在的可读文本。
fn gift(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let mut message = Message::new(room_id, MessageKind::Gift, danmubox_core::now_ms());
    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    message.uname = data
        .get("uname")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(message)
}

/// `SEND_GIFT_V2`：V2 礼物管线的礼物事件（`docs/protocol.md` §10.2）。
///
/// 载荷是 base64 的 protobuf（`data.pb`），字段反推自真实样本（`pb::GiftV2` 的注释记了判据）。
/// 解析失败一律丢弃并计入 `malformed`——宁可少显示一条礼物，也不能产出半条假消息。
fn gift_v2(room_id: i64, value: &Value, counters: &Counters) -> Option<Message> {
    let encoded = value.pointer("/data/pb").and_then(Value::as_str)?;
    let bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded) {
        Ok(bytes) => bytes,
        Err(err) => {
            tracing::debug!(%err, "SEND_GIFT_V2 的 data.pb 不是合法 base64，丢弃");
            Counters::bump(&counters.malformed_dropped);
            return None;
        }
    };
    let decoded = match crate::pb::GiftV2::decode(bytes.as_slice()) {
        Ok(decoded) => decoded,
        Err(err) => {
            tracing::debug!(%err, "SEND_GIFT_V2 protobuf 解码失败，丢弃");
            Counters::bump(&counters.malformed_dropped);
            return None;
        }
    };
    let Some(item) = decoded.gift else {
        tracing::debug!("SEND_GIFT_V2 没有礼物子消息，丢弃");
        Counters::bump(&counters.malformed_dropped);
        return None;
    };

    let num = i64::try_from(item.num.max(1)).unwrap_or(1);
    // 金额优先用官方给的 `total_coin`（价 × 数量）；缺失时按折后价或原价 × 数量算，都没有则为 0。
    let unit = if item.discount_price > 0 {
        item.discount_price
    } else {
        item.price
    };
    let amount = if item.total_coin > 0 {
        i64::try_from(item.total_coin).unwrap_or(0)
    } else {
        i64::try_from(unit).unwrap_or(0) * num
    };
    let ts_ms = if item.timestamp > 0 {
        i64::try_from(item.timestamp).unwrap_or(0) * 1000
    } else {
        danmubox_core::now_ms()
    };

    let mut message = Message::new(room_id, MessageKind::Gift, ts_ms);
    message.uid = decoded.uid as i64;
    message.uname = decoded.uname;
    // 正文不带数量：界面按连击聚合后的次数统一显示 ×N，避免出现「×1 ×5」。
    message.content = format!("{} {}", item.action, item.gift_name);
    message.amount = amount;
    // 连击标识用于会话内聚合；订单号是这条礼物的上游标识。
    message.upstream_id = item.tid;
    message.combo_id = item.batch_combo_id;
    if let Some(medal) = decoded.medal {
        message.medal_level = i64::from(medal.level);
        message.medal_name = medal.name;
    }
    Some(message)
}

/// 醒目留言。金额与标识字段名待实测校准。
fn superchat(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let mut message = Message::new(room_id, MessageKind::Superchat, danmubox_core::now_ms());
    message.content = data
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    message.uname = data
        .get("user_info")
        .and_then(|u| u.get("uname"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(message)
}

/// 互动（进场等，JSON 形态）。`content` 留空：文案属展示层，见 `docs/ui.md`。
///
/// 昵称优先取 `data.uname`；`ENTRY_EFFECT` 没有该字段，回落到
/// `data.uinfo.base.name`（2026-09-11 实测）。
fn interact_json(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let mut message = Message::new(room_id, MessageKind::Interact, danmubox_core::now_ms());
    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    message.uname = data
        .get("uname")
        .and_then(Value::as_str)
        .or_else(|| data.pointer("/uinfo/base/name").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    Some(message)
}

/// 互动（protobuf 载荷）：base64 位于 **`data.pb`**，不是 `data` 本身。
/// 该路径于 2026-09-11 用真实流量确认（曾误把 `data` 当载荷，导致静默产出空消息）。
fn interact_v2(room_id: i64, value: &Value, counters: &Counters) -> Option<Message> {
    use base64::Engine as _;

    let encoded = value
        .pointer("/data/pb")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if encoded.is_empty() {
        Counters::bump(&counters.malformed_dropped);
        tracing::debug!("INTERACT_WORD_V2 缺少 data.pb，丢弃");
        return None;
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(encoded) {
        Ok(bytes) => bytes,
        Err(err) => {
            Counters::bump(&counters.malformed_dropped);
            tracing::debug!(%err, "INTERACT_WORD_V2 的 data.pb 不是合法 base64，丢弃");
            return None;
        }
    };
    if bytes.is_empty() {
        Counters::bump(&counters.malformed_dropped);
        tracing::debug!("INTERACT_WORD_V2 的 data.pb 解出空字节，丢弃");
        return None;
    }
    let decoded = match InteractWordV2::decode(bytes.as_slice()) {
        Ok(decoded) => decoded,
        Err(err) => {
            // 不因 protobuf 载荷报错（`docs/roadmap.md` S1-AC6）。
            Counters::bump(&counters.malformed_dropped);
            tracing::debug!(%err, "INTERACT_WORD_V2 protobuf 解码失败，丢弃");
            return None;
        }
    };

    let (medal_level, medal_name) = decoded.medal();
    let mut message = Message::new(room_id, MessageKind::Interact, danmubox_core::now_ms());
    message.uid = decoded.uid as i64;
    message.uname = decoded.display_name();
    message.medal_level = medal_level;
    message.medal_name = medal_name;
    if let Some(ts) = decoded.ts_ms() {
        message.ts = ts;
    }
    Some(message)
}

/// 大航海开通。等级口径（1 总督 / 2 提督 / 3 舰长）待实测校准。
fn guard(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let mut message = Message::new(room_id, MessageKind::Guard, danmubox_core::now_ms());
    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    message.uname = data
        .get("username")
        .and_then(Value::as_str)
        .or_else(|| data.get("uname").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    Some(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn counters() -> Counters {
        Counters::default()
    }

    /// 测试里多数场景只关心「有没有产出消息」，用这个包一层；
    /// 人气值支路由 `popularity_is_reported_separately` 单独覆盖。
    fn message(room_id: i64, value: &Value, counters: &Counters) -> Option<Message> {
        match dispatch(room_id, value, counters) {
            Some(Dispatch::Message(message)) => Some(message),
            Some(Dispatch::Popularity(value)) => {
                panic!("期望消息，实际拿到人气值 {value}")
            }
            None => None,
        }
    }

    #[test]
    fn danmaku_uses_confirmed_paths_only() {
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_134_601_006i64, 1_789_134_600i64, 0, "0cf552e3", 0, 0, 0, "", 0, "{}", "{}",
                 {
                    "extra": "{\"content\":\"hi\",\"id_str\":\"0123456789abcdef0123456789abcdef0123\"}",
                    "user": {
                        "uid": 123456789012345i64,
                        "base": {"name": "观众甲", "face": "http://f/x.png"},
                        "medal": {"level": 24, "name": "粉丝牌", "guard_level": 3}
                    }
                 }],
                "亏爆57米",
                [123456789012345i64, "观众甲", 0, 0, 0, 10000, 1, ""],
                [24, "粉丝牌", "主播甲", 7654321, 1725515, "", 0, 1725515, 1725515, 5414290, 0, 1]
            ]
        });
        let message = message(7654321, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(message.kind, MessageKind::Danmaku);
        assert_eq!(message.content, "亏爆57米");
        assert_eq!(message.uid, 123456789012345);
        assert_eq!(message.uname, "观众甲");
        assert_eq!(message.color, 16777215, "颜色在 info[0][3]");
        assert_eq!(message.ts, 1_789_134_601_006, "毫秒时间戳在 info[0][4]");
        assert_eq!(message.medal_level, 24);
        assert_eq!(message.medal_name, "粉丝牌");
        assert_eq!(message.guard_level, 3);
        assert_eq!(
            message.upstream_id, "0123456789abcdef0123456789abcdef0123",
            "举报标识取自 extra.id_str"
        );
        assert!(!message.is_admin);
    }

    #[test]
    fn emote_danmaku_carries_the_image_url_over_https() {
        // 实测样本（某个在播房间（房间号不写入仓库） 的真实弹幕）：正文是表情名，表情信息在 info[0][13]，
        // 且上游给的是 http 地址——客户端在安全上下文里会拦掉，必须升级成 https。
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_176_282_410i64, 1_789_175_842i64, 0, "x", 0, 0, 0, "", 0,
                 {
                    "bulge_display": 0, "emoticon_unique": "official_345", "height": 60,
                    "in_player_area": 1, "is_dynamic": 1, "width": 200,
                    "url": "http://i0.hdslb.com/bfs/live/2ce08b31618d3ad0d34877bf949ef0089a0438b7.png"
                 },
                 "{}",
                 {"user": {"uid": 7, "base": {"name": "观众乙"}, "medal": {"level": 0}}}],
                "这个好耶"
            ]
        });
        let message = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(message.content, "这个好耶", "正文仍是表情名");
        assert_eq!(
            message.emote_url,
            "https://i0.hdslb.com/bfs/live/2ce08b31618d3ad0d34877bf949ef0089a0438b7.png",
            "表情图必须升级到 https，否则在客户端里根本加载不出来"
        );
    }

    #[test]
    fn plain_danmaku_has_no_emote() {
        // 非表情弹幕的 info[0][13] 是字符串 "{}"（实测），不得被当成表情对象。
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_134_601_006i64, 1_789_134_600i64, 0, "x", 0, 0, 0, "", 0,
                 "{}", "{}", {"user": {"uid": 7, "base": {"name": "观众乙"}, "medal": {"level": 0}}}],
                "普通弹幕"
            ]
        });
        let message = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert!(message.emote_url.is_empty(), "空槽位不得产出表情地址");
    }

    #[test]
    fn emote_object_without_url_is_ignored() {
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_134_601_006i64, 1_789_134_600i64, 0, "x", 0, 0, 0, "", 0,
                 {"emoticon_unique": "official_1", "url": ""},
                 "{}", {"user": {"uid": 7, "base": {"name": "观众乙"}, "medal": {"level": 0}}}],
                "表情名"
            ]
        });
        let message = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert!(message.emote_url.is_empty(), "空 url 不得当成表情");
    }

    #[test]
    fn danmaku_without_extra_json_still_decodes() {
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [[0, 1, 25, 1, 1, 1, 0, "", 0, 0, 0, "", 0, "{}", "{}",
                      {"extra": "not json", "user": {"uid": 1, "base": {"name": "u"}}}],
                     "hi", [1, "u"], []]
        });
        let message = message(1, &payload, &counters()).unwrap();
        assert_eq!(message.content, "hi");
        assert!(
            message.upstream_id.is_empty(),
            "extra 解析失败时留空，不编造"
        );
    }

    #[test]
    fn danmaku_tolerates_missing_user_object() {
        let payload = json!({"cmd": "DANMU_MSG", "info": [[], "只有内容"]});
        let message = message(9, &payload, &counters()).expect("内容仍在");
        assert_eq!(message.content, "只有内容");
        assert_eq!(message.uid, 0);
        assert!(message.uname.is_empty());
        assert_eq!(message.guard_level, 0);
    }

    #[test]
    fn mirror_danmaku_is_dropped_and_counted() {
        let c = counters();
        let payload = json!({"cmd": "DANMU_MSG_MIRROR", "info": [[], "x"]});
        assert!(message(1, &payload, &c).is_none());
        assert_eq!(c.snapshot().mirrored_dropped, 1);
    }

    #[test]
    fn interact_v2_decodes_base64_protobuf() {
        use base64::Engine as _;
        let proto = InteractWordV2 {
            uid: 777,
            uname: "路人".into(),
            msg_type: 1,
            timestamp_millisecond: 1_700_000_000_500,
            ..Default::default()
        };
        let payload = json!({
            "cmd": "INTERACT_WORD_V2",
            "data": {
                "dmscore": 3,
                "pb": base64::engine::general_purpose::STANDARD.encode(proto.encode_to_vec()),
            },
        });
        let message = message(5, &payload, &counters()).expect("protobuf 必须解出");
        assert_eq!(message.kind, MessageKind::Interact);
        assert_eq!(message.uid, 777);
        assert_eq!(message.uname, "路人");
        assert_eq!(message.ts, 1_700_000_000_500);
    }

    #[test]
    fn interact_v2_without_pb_field_yields_nothing() {
        // 曾把 `data` 本身当载荷，空 base64 会解出全默认值的假消息。
        let c = counters();
        let payload = json!({"cmd": "INTERACT_WORD_V2", "data": {"dmscore": 3}});
        assert!(message(5, &payload, &c).is_none());
        assert_eq!(c.snapshot().malformed_dropped, 1);
    }

    #[test]
    fn interact_v2_with_broken_payload_is_counted_not_fatal() {
        let c = counters();
        let payload = json!({"cmd": "INTERACT_WORD_V2", "data": {"pb": "!!!not-base64!!!"}});
        assert!(message(5, &payload, &c).is_none());
        assert_eq!(c.snapshot().malformed_dropped, 1);
    }

    #[test]
    fn entry_effect_takes_name_from_uinfo() {
        // ENTRY_EFFECT 没有 data.uname，昵称在 data.uinfo.base.name（实测）。
        let payload = json!({
            "cmd": "ENTRY_EFFECT",
            "data": {"uid": 7757052, "uinfo": {"base": {"name": "包包子的der一个"}}}
        });
        let message = message(1, &payload, &counters()).unwrap();
        assert_eq!(message.kind, MessageKind::Interact);
        assert_eq!(message.uid, 7757052);
        assert_eq!(message.uname, "包包子的der一个");
    }

    #[test]
    fn cmd_with_suffix_is_recognised() {
        let payload = json!({
            "cmd": "DANMU_MSG:4:0:2:2:2:0",
            "info": [[], "带后缀", []]
        });
        let message = message(1, &payload, &counters()).expect("带后缀命令必须识别");
        assert_eq!(message.content, "带后缀");
    }

    #[test]
    fn system_cmds_map_to_labels_and_unknown_is_counted() {
        let c = counters();
        let live = message(1, &json!({"cmd": "LIVE"}), &c).unwrap();
        assert_eq!(live.kind, MessageKind::System);
        assert_eq!(live.content, "开播");
        assert!(message(1, &json!({"cmd": "SOME_NEW_CMD"}), &c).is_none());
        assert_eq!(c.snapshot().unknown_cmd, 1);
    }

    #[test]
    fn send_gift_v2_maps_to_a_gift_message() {
        use base64::Engine as _;
        use prost::Message as _;

        // 用真实样本的字段结构自造载荷（样本里含他人昵称，不入仓库）。
        let original = crate::pb::GiftV2 {
            uid: 1920714644,
            uname: "送礼的人".into(),
            face: String::new(),
            medal: Some(crate::pb::GiftV2Medal {
                level: 12,
                name: "牌子".into(),
            }),
            gift: Some(crate::pb::GiftV2Item {
                gift_id: 31164,
                gift_name: "粉丝团灯牌".into(),
                num: 2,
                price: 100,
                discount_price: 100,
                coin_type: "gold".into(),
                tid: "4816040157599941120".into(),
                timestamp: 1_789_177_882,
                batch_combo_id: "batch:gift:combo_id:1:2:31164:1789177882.31".into(),
                total_coin: 200,
                action: "投喂".into(),
            }),
            anchor: None,
        };
        let payload = json!({
            "cmd": "SEND_GIFT_V2",
            "data": {
                "dmscore": 6,
                "pb": base64::engine::general_purpose::STANDARD.encode(original.encode_to_vec()),
            }
        });

        let message = message(7, &payload, &counters()).expect("必须解出礼物");
        assert_eq!(message.kind, MessageKind::Gift);
        assert_eq!(message.uid, 1920714644);
        assert_eq!(message.uname, "送礼的人");
        assert_eq!(message.content, "投喂 粉丝团灯牌");
        assert_eq!(message.amount, 200, "100 金瓜子 × 2");
        assert_eq!(message.ts, 1_789_177_882_000, "pb 里是秒级时间戳");
        assert_eq!(message.medal_level, 12);
        assert_eq!(message.medal_name, "牌子");
        assert_eq!(message.upstream_id, "4816040157599941120", "订单号即上游标识");
        assert!(
            message.combo_id.starts_with("batch:gift:combo_id:"),
            "连击标识要带出来，界面靠它聚合"
        );
    }

    #[test]
    fn broken_send_gift_v2_payloads_are_dropped_and_counted() {
        let c = counters();
        for payload in [
            json!({"cmd": "SEND_GIFT_V2", "data": {"pb": "%%%不是 base64%%%"}}),
            json!({"cmd": "SEND_GIFT_V2", "data": {"pb": "AAAA"}}),
            json!({"cmd": "SEND_GIFT_V2", "data": {}}),
        ] {
            assert!(message(7, &payload, &c).is_none(), "坏载荷必须丢弃");
        }
        assert_eq!(c.snapshot().malformed_dropped, 2, "能解码但无礼物子消息的不计 malformed");
    }

    #[test]
    fn popularity_is_reported_separately_from_messages() {
        // 人气值高频且只影响界面上的一个数字：不进会话缓冲，也不能当成消息。
        let counters = counters();
        let payload = json!({"cmd": "POPULARITY_CHANGE", "data": {"popularity": 12345}});
        match dispatch(7, &payload, &counters) {
            Some(Dispatch::Popularity(value)) => assert_eq!(value, 12345),
            other => panic!("应产出人气值，实际是 {:?}", other.is_some()),
        }
        assert_eq!(
            counters.snapshot().counter_updates,
            1,
            "人气值仍要计入计数类命令统计"
        );

        // 其余计数类命令不产出人气值。
        let watched = json!({"cmd": "WATCHED_CHANGE", "data": {"popularity": 9}});
        assert!(dispatch(7, &watched, &counters).is_none());
    }

    #[test]
    fn counter_cmds_update_counts_without_entering_the_buffer() {
        let c = counters();
        for cmd in [
            "POPULARITY_CHANGE",
            "WATCHED_CHANGE",
            "LIKE_INFO_V3_CLICK",
            "LIKE_INFO_V3_UPDATE",
            "ONLINE_RANK_V2",
            "ROOM_REAL_TIME_MESSAGE_UPDATE",
        ] {
            let produced = dispatch(1, &json!({"cmd": cmd, "data": {"popularity": 123}}), &c);
            assert!(
                !matches!(produced, Some(Dispatch::Message(_))),
                "{cmd} 按 protocol.md §10.7 不得产生消息"
            );
        }
        assert_eq!(c.snapshot().counter_updates, 6);
        assert_eq!(c.snapshot().unknown_cmd, 0, "已识别的计数命令不算未知");
    }

    #[test]
    fn irrelevant_known_cmds_are_dropped_silently() {
        let c = counters();
        for cmd in ["STOP_LIVE_ROOM_LIST", "HOT_ROOM_NOTIFY"] {
            assert!(message(1, &json!({"cmd": cmd}), &c).is_none());
        }
        assert_eq!(c.snapshot().unknown_cmd, 0);
        assert_eq!(c.snapshot().counter_updates, 0);
    }

    #[test]
    fn every_mapped_kind_is_one_of_six() {
        let payloads = [
            json!({"cmd": "LIVE"}),
            json!({"cmd": "SEND_GIFT", "data": {"uid": 1, "uname": "u"}}),
            json!({"cmd": "SUPER_CHAT_MESSAGE", "data": {"uid": 1, "message": "m"}}),
            json!({"cmd": "INTERACT_WORD", "data": {"uid": 1, "uname": "u"}}),
            json!({"cmd": "GUARD_BUY", "data": {"uid": 1, "username": "u"}}),
        ];
        for payload in payloads {
            let message = message(1, &payload, &counters()).unwrap();
            assert!(MessageKind::ALL.contains(&message.kind));
        }
    }
}
