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
/// 只更新房间内存计数。其中 `ONLINE_RANK_COUNT` / `WATCHED_CHANGE` 携带的
/// 两个观众数（在线人数 / 累计看过）要冒泡给界面，见 `Dispatch::RoomStats`。
const COUNTER_CMDS: [&str; 7] = [
    "POPULARITY_CHANGE",
    "ROOM_REAL_TIME_MESSAGE_UPDATE",
    "WATCHED_CHANGE",
    "LIKE_INFO_V3_CLICK",
    "LIKE_INFO_V3_UPDATE",
    "ONLINE_RANK_V2",
    "ONLINE_RANK_COUNT",
];

/// 已知但与当前订阅房间无关、或纯客户端提示的命令：丢弃且**不计为未知**。
///
/// 判据是载荷（实测样本，见 `docs/protocol.md` 附录 A22），不是命令名：
/// - `ONLINE_RANK_V3`：`data.pb` 是 protobuf 编码的高能榜，弹幕框不展示榜单。
///   它出现频率很高（一次 40 秒的观察里 43 条），放在这里才不会把 `unknown_cmd` 淹掉——
///   那个计数器是用来发现**真的没归类过**的命令的。
/// - `PLAYURL_RELOAD(_MASTER)`：`data` 只有 `room_id` / `playurl` / `reload_option`，
///   是播放器自己的事。
/// - `STOP_LIVE_ROOM_LIST`：整站未开播房间清单，与当前房间无关。
/// - `HOT_ROOM_NOTIFY`：推荐流阈值提示。
const IGNORED_CMDS: [&str; 5] = [
    "STOP_LIVE_ROOM_LIST",
    "HOT_ROOM_NOTIFY",
    "ONLINE_RANK_V3",
    "PLAYURL_RELOAD",
    "PLAYURL_RELOAD_MASTER",
];

/// `dispatch` 的产出。多数命令产出一条消息；观众数走单独支路——
/// 它们高频、只影响界面上的两个数字，既不该进会话缓冲，也不该被当成消息。
///
/// `allow(large_enum_variant)`：`Message` 比其它变体大得多，但本枚举是**按值返回**的
/// 临时载体（从不进集合），尺寸不影响任何东西；按 lint 的建议装箱反而会给
/// 每条弹幕多一次堆分配，那才是真的代价。
#[allow(clippy::large_enum_variant)]
pub enum Dispatch {
    Message(Message),
    /// 房间观众数：在线人数（`ONLINE_RANK_COUNT.online_count`）与
    /// 累计看过（`WATCHED_CHANGE.num`），协议 §10.7。两者各自到达，未到达的一侧为 `None`。
    RoomStats {
        online: Option<i64>,
        watched: Option<i64>,
    },
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
        // 进场特效：名字走 `uinfo.base.name`（实测载荷里没有 `uname`，但有 `uinfo`），
        // 因此能直接复用互动解析。文案由界面统一成「XX 进入直播间」——
        // 载荷里那个 `copy_writing` 模板（`"<%昵称%> 来了"`）留给上网页端用，
        // 两条进场路径的文案在这里保持一致。
        "ENTRY_EFFECT" => interact_json(room_id, value),
        "GUARD_BUY" | "USER_TOAST_MSG" => guard(room_id, value),
        other => {
            if COUNTER_CMDS.contains(&other) {
                Counters::bump(&counters.counter_updates);
                // 观众数是唯一要冒泡给界面的计数类数据：其余几类只是数字统计。
                // 字段取自实测载荷（`docs/protocol.md` 附录 A22 补充）：
                // `ONLINE_RANK_COUNT` 的 `online_count`、`WATCHED_CHANGE` 的 `num`。
                let online = match other {
                    "ONLINE_RANK_COUNT" => {
                        value.pointer("/data/online_count").and_then(Value::as_i64)
                    }
                    _ => None,
                };
                let watched = match other {
                    "WATCHED_CHANGE" => value.pointer("/data/num").and_then(Value::as_i64),
                    _ => None,
                };
                tracing::debug!(
                    cmd = other,
                    online,
                    watched,
                    "计数类命令：只更新房间计数，不入缓冲"
                );
                if online.is_some() || watched.is_some() {
                    return Some(Dispatch::RoomStats { online, watched });
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

/// 单条弹幕。取值路径均用真实流量核对（`docs/protocol.md` §10.1 与附录 A）：
/// 内容 `info[1]`；颜色 `info[0][3]`；时间戳 `info[0][4]`（毫秒）；
/// **本房间**大航海等级 `info[7]`（数字，不是数组）；
/// 明文用户对象 `info[0][15].user`；粉丝牌 `…user.medal.{level,name,guard_level}`；
/// `info[0][15].extra`（JSON 字符串）里同时有举报标识 `id_str` 与回复关系
/// `reply_mid` / `reply_uname`（见 §11.6 的更正）。
///
/// 两个易混点（都有实测依据，见 A39）：
/// `user.medal.guard_level` 是**牌子**所属房间的舰长标记，不是本房间的舰长标；
/// `user.guard` 在 180 条真实弹幕里恒为 `null`，别拿它当主要来源。
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
        // 头像与昵称同层（`user.base.face`）；历史条目的布局见 `history.rs`。
        message.face = user
            .pointer("/base/face")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(level) = user.pointer("/medal/level").and_then(Value::as_i64) {
            message.medal_level = level;
        }
        if let Some(name) = user.pointer("/medal/name").and_then(Value::as_str) {
            message.medal_name = name.to_string();
        }
        // 粉丝牌配色：上游给的是 CSS 十六进制串（带 alpha），官方前端 getMedalHtml 就取这组
        // （实测样本 `#3FB4F699` / `#FFFFFF`，见附录 A37）。缺失即空串，不拿 0 顶替。
        let color = |key: &str| {
            user.pointer(&format!("/medal/{key}"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        message.medal_color_start = color("v2_medal_color_start");
        message.medal_color_end = color("v2_medal_color_end");
        message.medal_color_border = color("v2_medal_color_border");
        message.medal_color_text = color("v2_medal_color_text");
        // 舰长标只认**本房间**的大航海等级：官方前端的弹幕解析取的就是这个槽位
        // （`info[7]`，一个数字）。**不能**拿 `user.medal.guard_level` 兜底——
        // 「别的房间的舰长」戴的是那个房间的舰长牌，用牌子画标就是张冠李戴。
        // 实测 180 条真实弹幕（附录 A39）：`user.guard` 恒为 `null`，真正区分
        // 「本房间舰长」与「戴他房间舰长牌」的只有 `info[7]`。
        message.guard_level = info
            .get(7)
            .and_then(Value::as_i64)
            .or_else(|| user.pointer("/guard/level").and_then(Value::as_i64))
            .unwrap_or(0);
        // 粉丝牌自己的舰长标记：官方只用它给**牌面**做样式区分，不是舰长标。
        message.medal_guard_level = user
            .pointer("/medal/guard_level")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    }

    // 表情弹幕：`info[0][13]` 是**对象**时才有表情信息（非表情弹幕该槽位是字符串 `"{}"`，
    // 实测自两个在播房间（房间号不写入仓库）。此时 `info[1]` 的正文就是表情名，
    // 只显示文字会让人以为「表情没渲染」，所以把图片地址一并带回。
    // 注意：实时表情对象里**没有文本字段**（实测样本只有 `emoticon_unique` / `url` / 尺寸），
    // 因此这一支无法像历史条目那样核对「正文是否就是这个表情」。
    // 观测到的实时表情弹幕正文就是表情本身（如 `info[1] == "这个好耶"`），故按整条画图处理。
    if let Some(emote) = meta.and_then(|m| m.get(13)).and_then(Value::as_object) {
        message.emote = crate::emote::emote_ref_from_object(&Value::Object(emote.clone()))
            .map(Box::new);
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
            // 回复关系也在这份 JSON 里（不在 `info` 的 `reply` 槽位上，见 §11.6 更正）。
            // `reply_mid == 0` 即不是回复。
            let reply_mid = parsed
                .get("reply_mid")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            if reply_mid != 0 {
                message.reply_to_uid = reply_mid;
                message.reply_to_uname = parsed
                    .get("reply_uname")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            // 这三个原样带出（语义与未知项见 `Message` 上的注释与附录 A40）：
            // `reply_type_enum` 只观测到 0/1，`show_reply` 在所有样本里都是 true，
            // 因此都**不能**用来区分「纯 @」与「回复某条弹幕」。
            message.reply_type_enum = parsed
                .get("reply_type_enum")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            message.show_reply = parsed
                .get("show_reply")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            message.reply_uname_color = parsed
                .get("reply_uname_color")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
    }

    Some(message)
}

/// 礼物。字段名（礼物名 / 数量 / 金额）待实测校准，暂只取已确认存在的可读文本。
/// V1 礼物（`SEND_GIFT`）。字段名按社区文档核对（`docs/live/gift.md`）：
/// `name` 礼物名、`price` 单位为金瓜子（文档记「该值/1000 的单位为元」，即 1 元 = 1000 金瓜子）、
/// `coin_type` 一般为 `gold`（电池体系）。**尚未观测到真实样本**——实测流量里只出现 `SEND_GIFT_V2`。
fn gift(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let mut message = Message::new(room_id, MessageKind::Gift, danmubox_core::now_ms());
    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    message.uname = data
        .get("uname")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let num = data.get("num").and_then(Value::as_i64).unwrap_or(1).max(1);
    let name = data.get("giftName").or_else(|| data.get("gift_name")).and_then(Value::as_str);
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        message.content = format!("投喂 {name} ×{num}");
    }
    message.amount = data.get("price").and_then(Value::as_i64).unwrap_or(0) * num;
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
/// 醒目留言。字段于 2026-09-12 用真实样本逐项核对（`docs/protocol.md` §10.3）。
///
/// **金额单位是元，不是金瓜子**：样本 `price = 30` 正是 B 站 SC 的最低档，
/// 同一载荷的 `rate = 1000` 给出换算（1 元 = 1000 金瓜子）。
/// 因此 `Message.amount` 对 SC 存的是**元**，与礼物（金瓜子）不同口径——
/// 契约 §5 对此的措辞是「礼物金瓜子或 SC 金额」，两套单位并存是既定设计。
fn superchat(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let ts_ms = data
        .get("ts")
        .or_else(|| data.get("start_time"))
        .and_then(Value::as_i64)
        .filter(|sec| *sec > 0)
        .map(|sec| sec * 1000)
        .unwrap_or_else(danmubox_core::now_ms);
    let mut message = Message::new(room_id, MessageKind::Superchat, ts_ms);
    message.content = data
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    // 昵称两处都有（实测同名）：优先 `uinfo.base.name`，回落 `user_info.uname`。
    message.uname = data
        .pointer("/uinfo/base/name")
        .or_else(|| data.pointer("/user_info/uname"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // 元。
    message.amount = data.get("price").and_then(Value::as_i64).unwrap_or(0);
    // SC 标识（样本为数字 id）；举报与去重都用得上。
    message.upstream_id = data
        .get("id")
        .map(|id| id.to_string().trim_matches('"').to_string())
        .unwrap_or_default();
    message.medal_level = data
        .pointer("/medal_info/medal_level")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    message.medal_name = data
        .pointer("/medal_info/medal_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // 与 DANMU_MSG 同理：`user_info.guard_level` 是本房间的大航海等级，
    // `medal_info.guard_level` 只是那块牌子的属性——两者不得互相兜底，
    // 否则「别的房间的舰长」会被画成本房间的舰长。
    message.guard_level = data
        .pointer("/user_info/guard_level")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    message.medal_guard_level = data
        .pointer("/medal_info/guard_level")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    // 房管标记：SC 载荷自带 `user_info.manager`（实测样本为 0）。
    message.is_admin = data
        .pointer("/user_info/manager")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        == 1;
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
/// 大航海开通 / 续费播报（`GUARD_BUY` 与 `USER_TOAST_MSG` 共用）。
///
/// 字段名按社区接口文档核对（`docs/live/message_stream.md` 两节都有字段表），
/// **尚未用真实样本观测**——这类事件在 10 分钟巨型房间采集里零条（见附录 A33）。
/// 文档给出的取值：`guard_level` 1 总督 / 2 提督 / 3 舰长；`price` 为原金瓜子标价（CNY×1000）。
fn guard(room_id: i64, value: &Value) -> Option<Message> {
    let data = value.get("data")?;
    let ts_ms = data
        .get("start_time")
        .and_then(Value::as_i64)
        .filter(|sec| *sec > 0)
        .map(|sec| sec * 1000)
        .unwrap_or_else(danmubox_core::now_ms);
    let mut message = Message::new(room_id, MessageKind::Guard, ts_ms);

    message.uid = data.get("uid").and_then(Value::as_i64).unwrap_or(0);
    message.uname = data
        .get("username")
        .or_else(|| data.get("uname"))
        .or_else(|| data.pointer("/user_info/uname"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    message.guard_level = data
        .get("guard_level")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    message.amount = data.get("price").and_then(Value::as_i64).unwrap_or(0);
    message.upstream_id = data
        .get("payflow_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let num = data.get("num").and_then(Value::as_i64).unwrap_or(1).max(1);
    // 名称优先取载荷里的（`gift_name` / `role_name`），缺失时按文档的等级映射补。
    let title = data
        .get("gift_name")
        .or_else(|| data.get("role_name"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| guard_title(message.guard_level).to_string());
    message.content = format!("开通 {title} ×{num}");
    Some(message)
}

/// 大航海等级 → 名称。取值按社区文档（1 总督 / 2 提督 / 3 舰长），未知等级不编造。
fn guard_title(level: i64) -> &'static str {
    match level {
        1 => "总督",
        2 => "提督",
        3 => "舰长",
        _ => "大航海",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn counters() -> Counters {
        Counters::default()
    }

    /// 测试里多数场景只关心「有没有产出消息」，用这个包一层；
    /// 观众数支路由 `room_stats_bubble_without_entering_the_buffer` 单独覆盖。
    fn message(room_id: i64, value: &Value, counters: &Counters) -> Option<Message> {
        match dispatch(room_id, value, counters) {
            Some(Dispatch::Message(message)) => Some(message),
            Some(Dispatch::RoomStats { .. }) => panic!("期望消息，实际拿到房间观众数"),
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
                        "medal": {
                            "level": 24,
                            "name": "粉丝牌",
                            "guard_level": 3,
                            "v2_medal_color_start": "#3FB4F699",
                            "v2_medal_color_end": "#3FB4F699",
                            "v2_medal_color_border": "#3FB4F699",
                            "v2_medal_color_text": "#FFFFFF",
                            "v2_medal_color_level": "#3FB4F6E6"
                        }
                    }
                 }],
                "亏爆57米",
                [123456789012345i64, "观众甲", 0, 0, 0, 10000, 1, ""],
                [24, "粉丝牌", "主播甲", 7654321, 1725515, "", 0, 1725515, 1725515, 5414290, 0, 1],
                [10, 0, 0, 1],
                [0, ""],
                0,
                3
            ]
        });
        let message = message(7654321, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(message.kind, MessageKind::Danmaku);
        assert_eq!(message.content, "亏爆57米");
        assert_eq!(message.uid, 123456789012345);
        assert_eq!(message.uname, "观众甲");
        assert_eq!(message.face, "http://f/x.png", "头像在 info[0][15].user.base.face");
        assert_eq!(message.color, 16777215, "颜色在 info[0][3]");
        assert_eq!(message.ts, 1_789_134_601_006, "毫秒时间戳在 info[0][4]");
        assert_eq!(message.medal_level, 24);
        assert_eq!(message.medal_name, "粉丝牌");
        assert_eq!(message.guard_level, 3, "本房间的大航海等级取 info[7]");
        assert_eq!(message.medal_guard_level, 3, "粉丝牌自身的舰长标记单独带出");
        assert_eq!(message.medal_color_start, "#3FB4F699");
        assert_eq!(message.medal_color_end, "#3FB4F699");
        assert_eq!(message.medal_color_border, "#3FB4F699");
        assert_eq!(message.medal_color_text, "#FFFFFF");
        assert_eq!(
            message.upstream_id, "0123456789abcdef0123456789abcdef0123",
            "举报标识取自 extra.id_str"
        );
        assert!(!message.is_admin);
    }

    #[test]
    fn guard_badge_ignores_medals_from_other_rooms() {
        // 实测形态（180 条真实弹幕，附录 A39）：戴着他房间舰长牌的人
        // `medal.guard_level = 3` 但 `info[7] = 0`；本房间舰长才 `info[7] = 3`。
        // 舰长标只看后者——拿牌子兜底就会把别的房间的身份按到本房间头上。
        let other_room = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1, 1, 0, "x", 0, 0, 0, "", 0, "{}", "{}",
                 {"user": {"uid": 7, "base": {"name": "外房间舰长"},
                           "guard": null, "medal": {"level": 30, "name": "别家牌", "guard_level": 3}}}],
                "早上好",
                [7, "外房间舰长", 0, 0, 0, 10000, 1, ""],
                [30, "别家牌", "别家主播", 999, 1, "", 0, 1, 1, 2, 0, 1],
                [10, 0, 0, 1],
                [0, ""],
                0,
                0
            ]
        });
        let m = message(7, &other_room, &counters()).expect("必须解出弹幕");
        assert_eq!(m.guard_level, 0, "别的房间的舰长不得画本房间的舰长标");
        assert_eq!(m.medal_guard_level, 3, "牌子自身的舰长标记仍要带出，供牌面样式用");

        let this_room = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1, 1, 0, "x", 0, 0, 0, "", 0, "{}", "{}",
                 {"user": {"uid": 8, "base": {"name": "本房间舰长"},
                           "medal": {"level": 30, "name": "本家牌", "guard_level": 3}}}],
                "晚上好",
                [8, "本房间舰长", 0, 0, 0, 10000, 1, ""],
                [30, "本家牌", "本房间主播", 7, 1, "", 0, 1, 1, 2, 0, 1],
                [10, 0, 0, 1],
                [0, ""],
                0,
                3
            ]
        });
        let m = message(7, &this_room, &counters()).expect("必须解出弹幕");
        assert_eq!(m.guard_level, 3, "本房间舰长要画标");
        assert_eq!(m.medal_guard_level, 3);
    }

    #[test]
    fn reply_target_comes_from_the_extra_json() {
        // 真实样本（180 条里 1 条回复弹幕）：回复关系在 `extra` 这个 JSON 字符串里，
        // 不在 `info` 的槽位上。同层还有 reply_uname_color / reply_type_enum /
        // reply_is_mystery / show_reply（本实现不消费）。
        let extra = json!({
            "content": "奇怪",
            "id_str": "0123456789abcdef",
            "show_reply": true,
            "reply_mid": 42424242,
            "reply_uname": "被回复的人",
            "reply_uname_color": "#FB7299",
            "reply_type_enum": 1,
            "reply_is_mystery": false
        })
        .to_string();
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1, 1, 0, "x", 0, 0, 0, "", 0, "{}", "{}",
                 {"extra": extra, "user": {"uid": 7, "base": {"name": "回复的人"},
                                           "medal": {"level": 0}}}],
                "奇怪",
                [7, "回复的人", 0, 0, 0, 10000, 1, ""],
                []
            ]
        });
        let m = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(m.reply_to_uid, 42424242);
        assert_eq!(m.reply_to_uname, "被回复的人");
        assert_eq!(m.upstream_id, "0123456789abcdef", "举报标识与回复同源");
        // 实测：有关系的那几条 `reply_type_enum` 都是 1、`show_reply` 都是 true；
        // 但 `1` 的语义（纯 @ 还是回复）未实测，故这两个字段只做**原样带出**的断言。
        assert_eq!(m.reply_type_enum, 1);
        assert!(m.show_reply);
        assert_eq!(m.reply_uname_color, "#FB7299");
    }

    #[test]
    fn plain_danmaku_carries_no_reply_relation() {
        // 无关系时的实测取值：`reply_mid=0`、`reply_type_enum=0`、`reply_uname_color=""`，
        // 而 `show_reply` **仍然是 true** —— 所以它不能当判别式用。
        let extra = json!({
            "id_str": "0123456789abcdef",
            "reply_mid": 0,
            "reply_uname": "",
            "reply_uname_color": "",
            "reply_type_enum": 0,
            "show_reply": true
        })
        .to_string();
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1, 1, 0, "x", 0, 0, 0, "", 0, "{}", "{}",
                 {"extra": extra, "user": {"uid": 7, "base": {"name": "路人"}, "medal": {"level": 0}}}],
                "普通弹幕",
                [7, "路人", 0, 0, 0, 10000, 1, ""],
                []
            ]
        });
        let m = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(m.reply_to_uid, 0);
        assert_eq!(m.reply_type_enum, 0);
        assert!(m.show_reply, "实测无关系的消息 show_reply 也是 true");
        assert!(m.reply_uname_color.is_empty());
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
        let emote = message.emote.expect("必须带出表情信息");
        assert_eq!(
            emote.url,
            "https://i0.hdslb.com/bfs/live/2ce08b31618d3ad0d34877bf949ef0089a0438b7.png",
            "表情图必须升级到 https，否则在客户端里根本加载不出来"
        );
        assert_eq!(emote.emoticon_unique, "official_345");
        assert_eq!((emote.width, emote.height), (200, 60));
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
        assert!(message.emote.is_none(), "空槽位不得产出表情");
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
        assert!(message.emote.is_none(), "空 url 不得当成表情");
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
        assert!(
            message.medal_color_start.is_empty() && message.medal_color_text.is_empty(),
            "没有粉丝牌时配色留空，不得拿黑色顶替"
        );
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
    fn 已知且无关的命令不计入未知() {
        // 载荷照抄实测样本的关键部分：V3 只有 pb（protobuf 高能榜），
        // PLAYURL_RELOAD 只有播放地址。它们不是「未归类」，只是与我们无关。
        for cmd in [
            "ONLINE_RANK_V3",
            "PLAYURL_RELOAD",
            "PLAYURL_RELOAD_MASTER",
            "STOP_LIVE_ROOM_LIST",
        ] {
            let payload = json!({"cmd": cmd, "data": {"pb": "CgtvbmxpbmVfcmFuaw==", "playurl": {}}});
            let c = counters();
            assert!(message(7, &payload, &c).is_none(), "{cmd} 不该产出消息");
            assert_eq!(
                c.snapshot().unknown_cmd,
                0,
                "{cmd} 是已知命令，不该污染 unknown_cmd"
            );
        }
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
    fn danmaku_admin_flag_comes_from_info_2_2() {
        // 2026-09-12 实测：同一用户在**他担任房管**的房间发弹幕 info[2][2]=1，
        // 在另两个他不是房管的房间全为 0（跨房间对照，见 A5）。
        let as_admin = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_180_000_000i64, 977288551, 0, "x", 0, 0, 0, "", 0, "{}", "{}",
                 {"user": {"uid": 7, "base": {"name": "房管"}, "medal": {"level": 0}}}],
                "房管的弹幕",
                [7, "房管", 1, 0, 0, 10000, 1, ""]
            ]
        });
        let m = message(7, &as_admin, &counters()).expect("必须解出弹幕");
        assert!(m.is_admin, "info[2][2] == 1 即房管");

        let as_normal = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_180_000_000i64, 977288551, 0, "x", 0, 0, 0, "", 0, "{}", "{}",
                 {"user": {"uid": 7, "base": {"name": "普通"}, "medal": {"level": 0}}}],
                "普通弹幕",
                [7, "普通", 0, 0, 0, 10000, 1, ""]
            ]
        });
        assert!(!message(7, &as_normal, &counters()).unwrap().is_admin);
    }

    #[test]
    fn guard_buy_uses_the_documented_fields() {
        // 形状取自社区文档的字段表（尚无真实样本，见 A33）。
        let payload = json!({
            "cmd": "GUARD_BUY",
            "data": {
                "uid": 12345, "username": "开舰长的人",
                "guard_level": 3, "num": 1, "price": 138000,
                "gift_id": 10003, "gift_name": "舰长", "start_time": 1_789_179_000
            }
        });
        let m = message(7, &payload, &counters()).expect("必须解出大航海");
        assert_eq!(m.kind, MessageKind::Guard);
        assert_eq!(m.uname, "开舰长的人");
        assert_eq!(m.guard_level, 3);
        assert_eq!(m.amount, 138000, "price 是金瓜子（文档记 CNY×1000）");
        assert_eq!(m.content, "开通 舰长 ×1");
        assert_eq!(m.ts, 1_789_179_000_000, "start_time 是秒级");
    }

    #[test]
    fn user_toast_msg_falls_back_to_the_level_title() {
        // USER_TOAST_MSG 没有昵称字段，且 role_name 可能缺失——此时按等级补名字。
        let payload = json!({
            "cmd": "USER_TOAST_MSG",
            "data": {"guard_level": 2, "num": 2, "price": 2000000}
        });
        let m = message(7, &payload, &counters()).expect("必须解出播报");
        assert_eq!(m.guard_level, 2);
        assert_eq!(m.content, "开通 提督 ×2");
        assert_eq!(m.amount, 2000000);
    }

    #[test]
    fn superchat_uses_the_measured_fields() {
        // 形状取自真实样本（人名与房间号换成中性值）。
        let payload = json!({
            "cmd": "SUPER_CHAT_MESSAGE",
            "data": {
                "message": "很好的一段留言",
                "price": 30,
                "rate": 1000,
                "time": 60,
                "id": 18968196,
                "ts": 1_789_179_382,
                "uid": 92322643,
                "uinfo": {"base": {"name": "留言的人"}},
                "user_info": {"uname": "留言的人", "guard_level": 0, "manager": 0},
                "medal_info": {"medal_level": 10, "medal_name": "粉丝团", "guard_level": 3}
            }
        });
        let m = message(7, &payload, &counters()).expect("必须解出 SC");
        assert_eq!(m.kind, MessageKind::Superchat);
        assert_eq!(m.content, "很好的一段留言");
        assert_eq!(m.uname, "留言的人");
        assert_eq!(m.amount, 30, "SC 的金额单位是元，不是金瓜子");
        assert_eq!(m.ts, 1_789_179_382_000, "ts 是秒级");
        assert_eq!(m.upstream_id, "18968196");
        assert_eq!(m.medal_level, 10);
        assert_eq!(m.medal_name, "粉丝团");
        assert_eq!(m.guard_level, 0, "SC 的舰长标只看 user_info（本房间）");
        assert_eq!(
            m.medal_guard_level, 3,
            "medal_info 的 guard_level 是牌子属性，单独带出、不参与舰长标"
        );
        assert!(!m.is_admin);
    }

    #[test]
    fn superchat_falls_back_and_survives_missing_fields() {
        // 缺 ts / 缺 uinfo / 缺 medal_info 都不得丢掉整条 SC。
        let payload = json!({
            "cmd": "SUPER_CHAT_MESSAGE",
            "data": {"message": "只有正文", "uid": 5, "user_info": {"uname": "甲"}}
        });
        let m = message(7, &payload, &counters()).expect("缺字段也要解出来");
        assert_eq!(m.content, "只有正文");
        assert_eq!(m.uname, "甲", "uinfo 缺失时回落 user_info.uname");
        assert_eq!(m.amount, 0);
        assert!(m.ts > 0, "缺时间戳时回落本地时间");
    }

    #[test]
    fn room_stats_bubble_without_entering_the_buffer() {
        // 观众数高频且只影响界面上的两个数字：不进会话缓冲，也不能当成消息。
        let counters = counters();
        let online = json!({
            "cmd": "ONLINE_RANK_COUNT",
            "data": {"count": 3, "online_count": 12345}
        });
        match dispatch(7, &online, &counters) {
            Some(Dispatch::RoomStats {
                online: Some(12345),
                watched: None,
            }) => {}
            other => panic!("应产出在线人数，实际是 {:?}", other.is_some()),
        }
        let watched = json!({
            "cmd": "WATCHED_CHANGE",
            "data": {"num": 456789, "text_small": "45.6万"}
        });
        match dispatch(7, &watched, &counters) {
            Some(Dispatch::RoomStats {
                online: None,
                watched: Some(456789),
            }) => {}
            other => panic!("应产出累计看过，实际是 {:?}", other.is_some()),
        }
        assert_eq!(
            counters.snapshot().counter_updates,
            2,
            "两个观众数命令仍要计入计数类统计"
        );

        // 载荷里没有对应字段时不冒泡（界面保留上一次的值，不显示 0）。
        let empty = json!({"cmd": "WATCHED_CHANGE", "data": {}});
        assert!(dispatch(7, &empty, &counters).is_none());

        // 其余计数类命令不产出观众数。
        let popularity = json!({"cmd": "POPULARITY_CHANGE", "data": {"popularity": 9}});
        assert!(dispatch(7, &popularity, &counters).is_none());
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
            "ONLINE_RANK_COUNT",
            "ROOM_REAL_TIME_MESSAGE_UPDATE",
        ] {
            let produced = dispatch(1, &json!({"cmd": cmd, "data": {"popularity": 123}}), &c);
            assert!(
                !matches!(produced, Some(Dispatch::Message(_))),
                "{cmd} 按 protocol.md §10.7 不得产生消息"
            );
        }
        assert_eq!(c.snapshot().counter_updates, 7);
        assert_eq!(
            c.snapshot().unknown_cmd,
            0,
            "已识别的计数命令（含 ONLINE_RANK_COUNT）不算未知"
        );
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
