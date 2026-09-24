//! `cmd` → 领域消息的映射（`docs/protocol.md` §10）。
//!
//! 只使用 `docs/protocol.md` 已确认的取值路径；未确认的字段一律留默认值，
//! 并在 `debug` 级别打印原始载荷，供阶段 1 的字段实测校准使用
//! （`docs/protocol.md` 附录 A / B）。

use std::collections::HashMap;
use std::time::Duration;

use danmubox_core::{Counters, Message, MessageKind};
use prost::Message as _;
use serde_json::Value;
use tokio::time::Instant;

use crate::pb::InteractWordV2;

/// 会产生一条 `system` 消息的命令：生命周期与公告类。
/// `docs/protocol.md` §10.7 对每一类都给了缓冲策略。
///
/// 第三个字段是**开播状态**（`docs/protocol.md` §10.7 的侧路）：`Some(n)` = 这条命令到达时
/// 把本房间的 `live_status` 置成 `n` 并冒泡给界面（`LIVE` → 1 直播中、`PREPARING` → 0 未开播）。
/// `None` = 与开播状态无关。轮播（`2`）不由这两条推出：它是主播另设的状态，无实测表明
/// `PREPARING` 会切到轮播；推错也只是短暂不一致，列表页那一拍会用上游的只读值纠回来。
const SYSTEM_CMDS: [(&str, &str, Option<i32>); 5] = [
    ("LIVE", "开播", Some(1)),
    ("PREPARING", "下播", Some(0)),
    ("ROOM_CHANGE", "标题或分区变更", None),
    ("CUT_OFF", "被切断", None),
    ("NOTICE_MSG", "系统公告", None),
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
    /// **房间的开播状态变了**（`LIVE` / `PREPARING`，协议 §10.7 的侧路）。
    ///
    /// 与 [`Dispatch::Message`] 不是二选一：这两条命令**照旧**入会话缓冲一条 `system` 消息
    /// （「开播」/「下播」），同时把状态冒泡给界面 —— 用户 2026-09-16 报的
    /// 「开播下播时状态不会自动更新」缺的正是后者（事件到了只入缓冲，没人把它写回房间状态）。
    /// 两者一起带出来，消费方按「先投消息、再投状态」处理，顺序与从前一致。
    LiveStatus {
        message: Message,
        live_status: i32,
    },
    /// **房间的标题变了**（`ROOM_CHANGE`，协议 §10.7）。
    ///
    /// 与 [`Dispatch::LiveStatus`] 同一条路子：这条命令**照旧**入会话缓冲一条 `system` 消息
    /// （「标题或分区变更」），同时把新标题冒泡给界面 —— 主播自己改了标题时，
    /// 「我的直播间」面板不该还挂着改之前那一份（issue202609241553 第 6 条）。
    ///
    /// 字段名取自参照实现 `HakaseZ/BiliLiveWatcher`（`ROOM_CHANGE.go` 只读 `data.room_id` 与
    /// `data.title`，用户自有、已实跑）；**本仓未实测**，两个字段任一取不到就退回
    /// [`Dispatch::Message`]，绝不猜。分区不在该事件的载荷里（参照实现也没读），
    /// 仍以 `anchor_room` 重读为准。
    RoomTitle {
        message: Message,
        room_id: i64,
        title: String,
    },
    /// **大航海**（`GUARD_BUY` / `USER_TOAST_MSG`，协议 §10.6）：同一笔购买上游会拆成两条载荷，
    /// 两条都投就会同一笔算两次金额（issue 2609171849 #1）。消费方**不得**直接投递，
    /// 必须先经 [`GuardMerge`] 按笔合并（§12.3「按时间窗合并为一条播报」）。
    Guard {
        message: Message,
        source: GuardSource,
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

    // `LIVE` / `PREPARING` 顺带带出的开播状态（协议 §10.7 的侧路）：只在 `SYSTEM_CMDS` 里标注了
    // 状态的那两条上被赋值，其余命令恒为 `None`（因此产出仍是 `Dispatch::Message`）。
    let mut status_update: Option<i32> = None;
    // 大航海的来源命令（协议 §10.6）：只有 `GUARD_BUY` / `USER_TOAST_MSG` 两条会给它赋值，
    // 赋了值就说明这条产出是「一笔购买的一半」，必须走 `Dispatch::Guard` 交给 [`GuardMerge`]。
    let mut guard_source: Option<GuardSource> = None;
    // `ROOM_CHANGE` 顺带带出的新标题（协议 §10.7）：只有这条命令会给它赋值，
    // 且只在 `data.room_id` / `data.title` **都**取到时才赋（取不到就当普通系统消息）。
    let mut title_update: Option<(i64, String)> = None;

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
        // 大航海：这两条是**同一笔购买**的两条载荷（§10.6），各自的 `price` 语义不同
        // （见 [`GuardSource`]）—— 归一出 `Dispatch::Guard`，投递前还必须按笔合并。
        "GUARD_BUY" => {
            guard_source = Some(GuardSource::Buy);
            guard(room_id, value, GuardSource::Buy)
        }
        "USER_TOAST_MSG" => {
            guard_source = Some(GuardSource::Toast);
            guard(room_id, value, GuardSource::Toast)
        }
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
                match SYSTEM_CMDS.iter().find(|(name, _, _)| *name == other) {
                    Some((name, label, live)) => {
                        let mut m =
                            Message::new(room_id, MessageKind::System, danmubox_core::now_ms());
                        m.content = (*label).to_string();
                        // `LIVE` / `PREPARING` 另带开播状态（协议 §10.7 的侧路）：
                        // 界面靠它把房间头 / 标签页 / 列表卡片的状态点在原地换掉，不必重连重刷。
                        status_update = *live;
                        // `ROOM_CHANGE` 另带新标题：两个字段齐了才冒泡，缺一个就只当系统消息。
                        if *name == "ROOM_CHANGE" {
                            let changed_room = value
                                .pointer("/data/room_id")
                                .and_then(Value::as_i64)
                                .unwrap_or_default();
                            let title = value
                                .pointer("/data/title")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            if changed_room > 0 && !title.is_empty() {
                                title_update = Some((changed_room, title));
                            }
                        }
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
            // 发言人的 uid 不进日志（`AGENT.md` §8 第 1 条）：命令与类型足以定位解析问题，
            // 要核对原始字段时另有 `danmubox::raw` 这一条专用出口（`docs/protocol.md` 附录 B.1）。
            tracing::debug!(
                cmd,
                kind = m.kind.as_str(),
                "已归一化命令（原始载荷见上一条 debug 输出）"
            );
        }
    }
    if let Some(source) = guard_source {
        // 大航海不在这里定去留：同一笔的另一半随时可能到，合并由 [`GuardMerge`] 按时间窗完成。
        return message.map(|message| Dispatch::Guard { message, source });
    }
    // `LIVE` / `PREPARING` 不会同时带标题，`ROOM_CHANGE` 也不会带开播状态 ——
    // 两条侧路互斥，与各自的命令一一对应；都没带就是一条普通系统消息。
    match (message, title_update, status_update) {
        (Some(message), Some((room_id, title)), _) => Some(Dispatch::RoomTitle {
            message,
            room_id,
            title,
        }),
        (Some(message), None, Some(live_status)) => Some(Dispatch::LiveStatus {
            message,
            live_status,
        }),
        (Some(message), None, None) => Some(Dispatch::Message(message)),
        (None, _, _) => None,
    }
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
        // 「这块牌亮不亮」= 官方决定画不画它的判据（见 `Message.medal_lit` 的注释）。
        // 字段缺失按"亮"处理：上游本会给，缺了是异常，不该因此少画一块牌。
        message.medal_lit = user
            .pointer("/medal/is_light")
            .and_then(Value::as_i64)
            .map(|value| value != 0)
            .unwrap_or(true);
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
        message.emote =
            crate::emote::emote_ref_from_object(&Value::Object(emote.clone())).map(Box::new);
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
            let reply_mid = parsed.get("reply_mid").and_then(Value::as_i64).unwrap_or(0);
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

            // 另一族表情：**正文里的行内文字表情**（`[dog]`、`[大笑]` 这类），路由与
            // 「表情弹幕」不同——`info[0][13]` 是**空槽位** `"{}"`，图只出现在这份 JSON 的
            // `emots` map 里（键是正文里那个 token）。实测 49294 条真实 `DANMU_MSG`：
            // 带 `emots` 的 1196 条，槽位 13 **全是** `"{}"`；槽位 13 是对象的 4043 条里
            // `emots` 全为空——两类互不重叠，所以只看槽位 13 就整族丢掉，界面只剩 `[dog]` 原文
            // （用户 2026-09-13 报的「表情包【dog】渲染不出来」）。
            //
            // 只有「**整条正文就是这个 token**」时才按整条画图，与 `history.rs` 同一口径：
            // 正文里夹着别的字（本族 1196 条里 855 条如此）时保持原文——`Message.emote`
            // 是「整条画图」语义，替不了正文内的行内替换，整段画掉会把用户的话吞了。
            if message.emote.is_none() {
                message.emote = parsed
                    .get("emots")
                    .and_then(Value::as_object)
                    .and_then(|emots| emots.get(&message.content))
                    .and_then(crate::emote::emote_ref_from_object)
                    .map(Box::new);
            }
        }
    }

    Some(message)
}

/// 礼物。字段名（礼物名 / 数量 / 金额）待实测校准，暂只取已确认存在的可读文本。
/// V1 礼物（`SEND_GIFT`）。字段名按社区文档核对（`docs/live/gift.md`）：
/// `name` 礼物名、`price` 单位为金瓜子（文档记「该值/1000 的单位为元」，即 1 元 = 1000 金瓜子）、
/// `coin_type` 一般为 `gold`（电池体系）。**尚未观测到真实样本**——实测流量里只出现 `SEND_GIFT_V2`。
///
/// 头像**故意留空**：社区文档的字段表里没有头像，载荷本身也没有可确证的昵称同层头像槽位，
/// 实测样本又是零条（`docs/protocol.md` 附录 A8）——没有可靠来源就不填（契约 §5 的 `face`）。
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
    let name = data
        .get("giftName")
        .or_else(|| data.get("gift_name"))
        .and_then(Value::as_str);
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
    // 头像：pb 顶层 tag 3 已解出（`pb::GiftV2::face`，与 uid / uname 同层）。
    message.face = decoded.face;
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
/// **金额单位是元，不是金瓜子**：样本 `price = 30` 正是 ac站 SC 的最低档，
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
    // 头像与上面那个昵称同层（`uinfo.base`）：同一个用户对象，取不到即空串。
    message.face = data
        .pointer("/uinfo/base/face")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
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
/// `data.uinfo.base.name`（2026-09-11 实测）。头像走**同一个** `uinfo.base`：
/// 这两条 JSON 路径都没有独立的昵称同层头像槽位（`docs/protocol.md` §10.4）。
///
/// **时间口径**：`ts` 一律是**本地收包时刻**，与 `interact_v2`（protobuf 那条路）同口径，
/// 理由写在那里的注释 —— 两条路必须同口径，界面那两个判据才不会因命令不同而异。
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
    message.face = data
        .pointer("/uinfo/base/face")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(message)
}

/// 互动（protobuf 载荷）：base64 位于 **`data.pb`**，不是 `data` 本身。
/// 该路径于 2026-09-11 用真实流量确认（曾误把 `data` 当载荷，导致静默产出空消息）。
///
/// **时间口径**：与 JSON 那条路（`interact_json`）一致，`ts` 一律是**本地收包时刻**，
/// 上游那两个时间戳槽位（`timestamp_millisecond` / `timestamp`）只留档、不写进
/// `Message.ts`，理由见函数体里的注释。
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
            // 不因 protobuf 载荷报错（阶段目标 S1-AC6，阶段史见 `CHANGELOG.md` 归档区）。
            Counters::bump(&counters.malformed_dropped);
            tracing::debug!(%err, "INTERACT_WORD_V2 protobuf 解码失败，丢弃");
            return None;
        }
    };

    let (medal_level, medal_name) = decoded.medal();
    // `ts` 一律取**本地收包时刻**（与 `interact_json` 同口径），上游那两个时间戳
    // （`timestamp_millisecond` / `timestamp`）只在这里留档，不写进 `Message.ts`：
    // ① 不可信 —— 上游时钟与本地的偏差没有实测依据（`protocol.md` 附录 A7 仍是
    //    待实测校准）；② `ts` 只服务界面那两条判据（按时间排序、`interactAutoHidden`
    //    的 `ts + 8000ms <= now`），拿上游时钟当判据就是「行刚出现就消失」或
    //    「永不消失的透明占位」（用户 2026-09-22 报的第 1、2 条）。留档是为了字段
    //    校准仍查得到原值。
    if let Some(upstream_ts_ms) = decoded.ts_ms() {
        tracing::debug!(
            room_id,
            upstream_ts_ms,
            "INTERACT_WORD_V2 的载荷时间戳只留档，不写进 Message.ts"
        );
    }
    let mut message = Message::new(room_id, MessageKind::Interact, danmubox_core::now_ms());
    message.uid = decoded.uid as i64;
    message.uname = decoded.display_name();
    // 头像与昵称同源（`user_info.base`，tag 22 的 `2: face`）。
    message.face = decoded.face();
    message.medal_level = medal_level;
    message.medal_name = medal_name;
    Some(message)
}

/// 一次进场的键：`room_id` + `uid`。
///
/// `room_id` 必须在键里：合并器活在**房间运行时**之上（不随连接重建），
/// 没有它两个房间的同一个 uid 会互相吞掉对方的进场。
type InteractKey = (i64, i64);

/// 一次进场只投一条的合并器（`docs/protocol.md` §10.4 / §12.3）。
///
/// 三条命令归一成同一个 `kind=interact`（见 [`dispatch`]）：`ENTRY_EFFECT`、
/// `INTERACT_WORD`、`INTERACT_WORD_V2`。同一次进场上游会**先后**推其中两条，
/// 两条都投就是「XX 进入直播间」连着两行 —— `docs/protocol.md` 那条
/// 「`ENTRY_EFFECT` 与 `INTERACT_WORD` 不重复计数」的断言此前只有文档、没有代码兜着
/// （用户 2026-09-22 报的第 1 条）。
///
/// | 到手的载荷 | 行为 |
/// |---|---|
/// | 窗口内这个 (`room_id`, `uid`) 没投过 | 立刻投 |
/// | 窗口内已经投过（同源的第二条） | 压掉不投 |
/// | 不同观众 | 各投一条 |
/// | 同一观众在窗口过后的再次进场 | 照投一条 |
///
/// 窗口 **5s**（与 [`GuardMerge`] 同尺度）：两条同源载荷的间隔是毫秒级，5s 绰绰有余；
/// 而真实「退出又进来」不会发生在 5s 内，压掉它正是想要的。状态只保留窗口内那几项
/// （每次调用顺手清理），不随会话增长。
///
/// 与 [`GuardMerge`] 的形状差异是**故意**的：这里没有 `pending` / `deadline` /
/// `flush` / `take_pending` —— 互动消息没有「等另一半」这回事，第一条就是完整的一条，
/// 压后投递只会让它迟到，而 `Message.ts` 是本地收包时刻（界面按 `ts + 8s` 收起这一行），
/// 压几秒再投等于让它刚出现就消失。因此没有待放项、也不需要定时器：压掉的那条
/// 没有第二次机会。
pub struct InteractMerge {
    window: Duration,
    /// 窗口内**已经投过**的进场与投递时刻。
    seen: HashMap<InteractKey, Instant>,
}

impl Default for InteractMerge {
    fn default() -> Self {
        Self::new()
    }
}

impl InteractMerge {
    /// 生产口径：窗口 5s（依据见类型文档）。
    pub fn new() -> Self {
        Self::with_window(Duration::from_secs(5))
    }

    /// 指定窗口，供测试卡住边界。
    pub fn with_window(window: Duration) -> Self {
        Self {
            window,
            seen: HashMap::new(),
        }
    }

    /// 过一遍互动消息；返回**现在就该投递**的那一条（同源重复时为 `None`）。
    pub fn absorb(&mut self, now: Instant, message: Message) -> Option<Message> {
        self.prune(now);
        let key = (message.room_id, message.uid);
        if self.seen.contains_key(&key) {
            tracing::debug!(
                room_id = message.room_id,
                "同一次进场又来了一条载荷，压掉不投"
            );
            return None;
        }
        self.seen.insert(key, now);
        Some(message)
    }

    /// 丢掉窗口外的记录：`seen` 只用来压掉紧跟着到的另一条。
    fn prune(&mut self, now: Instant) {
        let window = self.window;
        self.seen
            .retain(|_, at| now.saturating_duration_since(*at) <= window);
    }
}

/// 大航海载荷的来源命令（`docs/protocol.md` §10.6）。
///
/// 同一笔大航海开通 / 续费，上游会**先后**发两条载荷，两条的 `price` **语义不同**
/// （2026-09-17 用真实抓包逐笔核对，样本量见 §10.6）：
///
/// | 命令 | 含义 | `price` 语义 | 实测取值（舰长 / 提督） |
/// |---|---|---|---|
/// | `GUARD_BUY` | 购买事件 | **标价（原价）** | 舰长恒为 `198000`（= 198 元）；提督 `1998000` |
/// | `USER_TOAST_MSG` | 播报 | **实付** | 舰长 `138000`（连续包月）/ `168000`（单月）/ 少数无折扣 `198000`；提督 `1998000`（个别折后 `1598000`） |
///
/// 金额只能取实付那一份：拿标价当金额，同一笔就会被统计成两次（issue 2609171849 #1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardSource {
    /// `GUARD_BUY`：购买事件。`price` 是标价，**不进** `Message.amount`。
    Buy,
    /// `USER_TOAST_MSG`：播报。`price` 是实付，即 `Message.amount`。
    Toast,
}

/// 大航海开通 / 续费（`GUARD_BUY` 与 `USER_TOAST_MSG` 共用一套字段）。
///
/// 等级口径 `1` 总督 / `2` 提督 / `3` 舰长（社区文档 + 实测样本一致）。
/// 实测样本（2026-09-17 核对，某个在播房间的两次长窗口抓包）另给出两条更正：
/// `USER_TOAST_MSG` **带昵称**（`data.username`，样本 100% 有）与订单号 `payflow_id`；
/// `GUARD_BUY` **没有** `payflow_id`，因此 `Message.upstream_id` 对购买事件是空串。
///
/// 头像**留空**：两条命令的字段表里都没有头像字段（实测样本同样没有）——没有来源就不填
/// （`docs/protocol.md` §10.6 的记录与契约 §5 的 `face`）。
fn guard(room_id: i64, value: &Value, source: GuardSource) -> Option<Message> {
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

    message.guard_level = data.get("guard_level").and_then(Value::as_i64).unwrap_or(0);
    // 金额只认**实付**：`GUARD_BUY.price` 是标价（原价），拿它当金额就会把同一笔的
    // 原价与实付各统计一次（issue 2609171849 #1）。标价不进 `Message`，只在 `debug`
    // 留个读数供字段校准 —— 购买事件在窗口内没等到播报时，那一行按契约 §5
    // 「无法确证时 `0`，不得推算」留 0（界面因此不画金额格，而不是拿原价冒充）。
    let price = data.get("price").and_then(Value::as_i64).unwrap_or(0);
    message.amount = match source {
        GuardSource::Toast => price,
        GuardSource::Buy => {
            tracing::debug!(price, "GUARD_BUY 的 price 是标价（原价），不作金额");
            0
        }
    };
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

/// 大航海等级 → 名称。取值按社区文档与实测样本（1 总督 / 2 提督 / 3 舰长），未知等级不编造。
fn guard_title(level: i64) -> &'static str {
    match level {
        1 => "总督",
        2 => "提督",
        3 => "舰长",
        _ => "大航海",
    }
}

/// 同一笔大航海的键：`room_id` + `uid` + `guard_level`（**没有载荷时间戳**）。
///
/// 改前是 `(uid, guard_level, ts)`，`ts` 取自 `data.start_time`：该字段一旦缺失 /
/// 非整数 / ≤ 0，两条载荷各自回落成收包时刻 → 键不同 → 同一笔**必然**投两行
/// （播报立即投、购买行再被 `flush` 投出，就是用户 2026-09-22 报的第 4 条）。
/// 认「同一笔」因此改由**到达时刻**负责（[`GuardMerge`] 的窗口与 `announced`）：
/// 实测两条的间隔 p50 43ms / p90 113ms / p99 1.99s / 最大 2.16s（699 对），窗口足够。
/// 代价是同一用户在 [`GUARD_ANNOUNCED_TTL`] 内再买同一档会被并成一条（只投一条）——
/// 漏一条播报比同一笔算两次金额轻（issue 2609171849 #1）。
///
/// `room_id` 必须在键里：合并器活在**房间运行时**之上（不随连接重建），
/// 没有它两个房间的同一 uid + 等级会互相吞掉对方的播报。
type GuardKey = (i64, i64, i64);

/// 购买事件等播报的窗口（依据见 [`GuardKey`] 上的实测间隔）。
const GUARD_WINDOW: Duration = Duration::from_secs(5);

/// 已投过的那笔在多久之内还认得出来 —— **必须比 `GUARD_WINDOW` 长**。
///
/// 两个出口会写 `announced`：窗口到期放行的 [`GuardMerge::flush`]，与连接收尾的
/// [`GuardMerge::take_pending`]。放行之后同一笔的播报仍可能迟到（甚至落在下一条连接上），
/// `announced` 若按窗口 5s 清理，那条迟到的播报就会变成第二行 —— 用户 2026-09-22
/// 报的第 4 条正是这一种。取 30s：6 倍窗口，既盖得住「购买事件先放行、播报后到」，
/// 也盖得住一次退避重连（5s 起）。
const GUARD_ANNOUNCED_TTL: Duration = Duration::from_secs(30);

/// 「一笔大航海只投一条播报」的合并器（`docs/protocol.md` §10.6 / §12.3）。
///
/// 上游把同一笔拆成两条载荷（[`GuardSource`]），两条都投就会**同一笔算两次金额**：
/// 舰长的标价与实付各进一次统计，界面汇总因此出 `198 + 138 = 336 元` 这种数
/// （issue 2609171849 #1）。口径是「一笔一条，金额取实付」：
///
/// | 到手的载荷 | 行为 |
/// |---|---|
/// | 先 `GUARD_BUY`、窗口内又收到 `USER_TOAST_MSG` | 只投**播报**那条（金额 = 实付），购买事件被吸收 |
/// | 只有 `GUARD_BUY`（窗口内没等到播报） | 窗口到期后照投一条，**金额留 0**（标价不是实付，见 [`guard`]） |
/// | 只有 `USER_TOAST_MSG` | 立即投播报（金额 = 实付） |
/// | 同一笔的第二条（方向不限、[`GUARD_ANNOUNCED_TTL`] 内） | 压掉不投 —— 一笔一条是硬口径 |
///
/// 窗口取 **5s**（`GUARD_WINDOW`）：实测两条到达间隔 p50 43ms / p90 113ms / p99 1.99s /
/// 最大 2.16s（699 对）。状态只保留窗口内的那几笔（每次调用顺手清理旧项），不会随会话增长。
///
/// 它活在**房间运行时**上、**不随连接重建**（理由见 `ws::BiliLive` 上那两个字段的注释）：
/// 同一笔的两条载荷完全可能分处两次连接（购买事件在这条、播报在下一条），
/// 每次连接新建一个合并器就认不出是同一笔 —— 那时 `GUARD_BUY` 被 `take_pending` 放行、
/// 播报随后又投一条，正是「一笔买出两行」。
pub struct GuardMerge {
    window: Duration,
    /// 已投过的那笔还能被认出多久（`GUARD_ANNOUNCED_TTL`）：与 `window` 分开，
    /// 因为它要盖住「放行之后才到的那一半」，见常量上的说明。
    announced_ttl: Duration,
    /// 已到、还没等到播报的购买事件（附到达时刻；窗口到期由 [`GuardMerge::flush`] 放出）。
    pending: HashMap<GuardKey, (Instant, Message)>,
    /// 已经投过的那几笔：后到的另一半一律压掉。
    announced: HashMap<GuardKey, Instant>,
}

impl Default for GuardMerge {
    fn default() -> Self {
        Self::new()
    }
}

impl GuardMerge {
    /// 生产口径：窗口 5s（依据见类型文档）。
    pub fn new() -> Self {
        Self::with_window(GUARD_WINDOW)
    }

    /// 指定窗口，供测试卡住边界（`announced` 的 TTL 用生产值 `GUARD_ANNOUNCED_TTL`）。
    pub fn with_window(window: Duration) -> Self {
        Self {
            window,
            announced_ttl: GUARD_ANNOUNCED_TTL,
            pending: HashMap::new(),
            announced: HashMap::new(),
        }
    }

    /// 还压着的购买事件最早什么时候到期（`None` = 没有待放项）。
    /// 调用方拿它当定时器的截止时刻 —— 没有待放项时**不该**起定时器。
    pub fn deadline(&self) -> Option<Instant> {
        self.pending.values().map(|(at, _)| *at + self.window).min()
    }

    /// 吸收一条大航海载荷；返回**现在就该投递**的那一条（暂存 / 压掉时为 `None`）。
    pub fn absorb(
        &mut self,
        now: Instant,
        message: Message,
        source: GuardSource,
    ) -> Option<Message> {
        self.prune(now);
        let key = (message.room_id, message.uid, message.guard_level);
        if self.announced.contains_key(&key) {
            // 同一笔已经投过（另一条载荷早到、或购买事件已被 `flush` 放出）。
            tracing::debug!(
                room_id = message.room_id,
                "同一笔大航海的第二条载荷，压掉不投"
            );
            return None;
        }
        match source {
            GuardSource::Toast => {
                // 播报自带实付金额与昵称，直接投；顺手把窗口里同一笔的购买事件消化掉。
                self.pending.remove(&key);
                self.announced.insert(key, now);
                Some(message)
            }
            GuardSource::Buy => {
                // 购买事件先压着：它的 `price` 是标价，投出去就会把原价算进统计。
                self.pending.entry(key).or_insert((now, message));
                None
            }
        }
    }

    /// 窗口到期时放出「没等到播报」的购买事件（调用方按 [`GuardMerge::deadline`] 驱动）。
    pub fn flush(&mut self, now: Instant) -> Option<Message> {
        self.prune(now);
        let key = self
            .pending
            .iter()
            .find(|(_, (at, _))| now.saturating_duration_since(*at) > self.window)
            .map(|(key, _)| *key)?;
        let (_, message) = self.pending.remove(&key)?;
        self.announced.insert(key, now);
        tracing::debug!(
            room_id = message.room_id,
            "大航海购买事件在窗口内没等到播报，按无金额放行"
        );
        Some(message)
    }

    /// 连接收尾：把还压着的购买事件**不论窗口**一律放出去。
    /// 断连 / 手停都不该吃掉一条已经收到的开通 —— 重连不清缓冲（§12.3），这条同理。
    ///
    /// 放出去的也要记进 `announced`：连断在两条载荷之间时，播报会落在**下一条**连接上，
    /// 没有这条记录它就会被当成新的一笔再投一行（用户 2026-09-22 报的第 4 条）。
    pub fn take_pending(&mut self, now: Instant) -> impl Iterator<Item = Message> + '_ {
        let keys: Vec<GuardKey> = self.pending.keys().copied().collect();
        for key in keys {
            self.announced.insert(key, now);
        }
        self.pending.drain().map(|(_, (_, message))| message)
    }

    /// 丢掉过期的记录：`pending` 由 `flush` 负责（按 `window`），`announced` 用自己的
    /// 更长 TTL（`announced_ttl`）—— 见 [`GUARD_ANNOUNCED_TTL`] 上的说明。
    fn prune(&mut self, now: Instant) {
        let announced_ttl = self.announced_ttl;
        self.announced
            .retain(|_, at| now.saturating_duration_since(*at) <= announced_ttl);
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
            // `LIVE` / `PREPARING` 也带一条 `system` 消息（另外那份开播状态由
            // `live_and_preparing_bubble_the_room_status` 单独断言）。
            Some(Dispatch::LiveStatus { message, .. }) => Some(message),
            // `ROOM_CHANGE` 也带一条 `system` 消息（另外那份新标题由
            // `room_change_bubbles_title` 单独断言）。
            Some(Dispatch::RoomTitle { message, .. }) => Some(message),
            // 大航海走 `Dispatch::Guard`（同一笔的两条载荷由 `GuardMerge` 合并，
            // 见 `guard_pair_is_merged_into_one_announcement_with_the_paid_price`）。
            Some(Dispatch::Guard { message, .. }) => Some(message),
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
        assert_eq!(
            message.face, "http://f/x.png",
            "头像在 info[0][15].user.base.face"
        );
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
        assert_eq!(
            m.medal_guard_level, 3,
            "牌子自身的舰长标记仍要带出，供牌面样式用"
        );

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
            emote.url, "https://i0.hdslb.com/bfs/live/2ce08b31618d3ad0d34877bf949ef0089a0438b7.png",
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
    fn inline_text_emote_danmaku_carries_the_image_url() {
        // 用户 2026-09-13「表情包【dog】渲染不出来」的那条真实记录（夹具
        // `smoke/fixtures/danmaku-rows.json` 的 `emots`）：正文就是 `[dog]`，
        // `info[0][13]` 是**空槽位** `"{}"`，表情只在 `extra.emots` 里。
        let extra = json!({
            "emots": {"[dog]": {
                "count": 1, "descript": "[dog]", "emoji": "[dog]", "emoticon_id": 208,
                "emoticon_unique": "emoji_208", "width": 20, "height": 20,
                "url": "http://i0.hdslb.com/bfs/live/4428c84e694fbf4e0ef6c06e958d9352c3582740.png"
            }},
            "id_str": "x"
        })
        .to_string();
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_207_769_778i64, 1_789_207_769i64, 0, "x", 0, 0, 0, "", 0,
                 "{}", "{}", {"extra": extra, "user": {"uid": 7, "base": {"name": "观众乙"}}}],
                "[dog]"
            ]
        });
        let message = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(message.content, "[dog]", "正文仍是那个 token");
        let emote = message.emote.expect("extra.emots 里的表情必须带出来");
        assert_eq!(
            emote.url, "https://i0.hdslb.com/bfs/live/4428c84e694fbf4e0ef6c06e958d9352c3582740.png",
            "表情图必须升级到 https，否则在客户端里根本加载不出来"
        );
        assert_eq!(emote.emoticon_unique, "emoji_208");
        assert_eq!((emote.width, emote.height), (20, 20));
        assert!(
            !emote.bulge_display,
            "文字表情没有 bulge_display，不得当成大表情"
        );
    }

    #[test]
    fn mixed_text_emote_danmaku_keeps_the_text() {
        // 同一个 `emots` map，但正文里夹着别的字（真实记录：`点歌 大风吹 刘惜君[dog]`）。
        // 这一支**不能**设 `emote`：`Message.emote` 是「整条画图」语义，会把正文吞掉。
        let extra = json!({
            "emots": {"[dog]": {
                "emoticon_unique": "emoji_208", "width": 20, "height": 20,
                "url": "http://i0.hdslb.com/bfs/live/4428c84e694fbf4e0ef6c06e958d9352c3582740.png"
            }}
        })
        .to_string();
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1_789_199_426_822i64, 1_789_199_426i64, 0, "x", 0, 0, 0, "", 0,
                 "{}", "{}", {"extra": extra, "user": {"uid": 7, "base": {"name": "观众乙"}}}],
                "点歌 大风吹 刘惜君[dog]"
            ]
        });
        let message = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert!(
            message.emote.is_none(),
            "正文不等于 token 时保持原文，不得整条画成表情"
        );
        assert_eq!(message.content, "点歌 大风吹 刘惜君[dog]");
    }

    #[test]
    fn emote_danmaku_slot_wins_over_emots_map() {
        // 两类在真实流量里互不重叠（实测 49294 条），但真同时出现时以槽位 13 为准：
        // 那是「整条就是一张表情」的权威来源，`emots` 只是文字表情的补充。
        let extra = json!({
            "emots": {"[dog]": {
                "emoticon_unique": "emoji_208", "width": 20, "height": 20,
                "url": "http://i0.hdslb.com/bfs/live/4428c84e694fbf4e0ef6c06e958d9352c3582740.png"
            }}
        })
        .to_string();
        let payload = json!({
            "cmd": "DANMU_MSG",
            "info": [
                [0, 1, 25, 16777215, 1, 1, 0, "x", 0, 0, 0, "", 0,
                 {"emoticon_unique": "official_345", "width": 200, "height": 60,
                  "url": "http://i0.hdslb.com/bfs/live/2ce08b31618d3ad0d34877bf949ef0089a0438b7.png"},
                 "{}", {"extra": extra, "user": {"uid": 7, "base": {"name": "观众乙"}}}],
                "[dog]"
            ]
        });
        let message = message(7, &payload, &counters()).expect("必须解出弹幕");
        assert_eq!(
            message.emote.expect("必须有表情").emoticon_unique,
            "official_345",
            "槽位 13 的表情优先"
        );
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
            user_info: Some(crate::pb::UserInfo {
                uid: 777,
                base: Some(crate::pb::UserBase {
                    uname: "路人".into(),
                    face: "https://i0.hdslb.com/bfs/face/interact.png".into(),
                }),
                medal_info: None,
            }),
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
        assert_eq!(
            message.face, "https://i0.hdslb.com/bfs/face/interact.png",
            "头像取 pb 的 user_info.base.face"
        );
        // 口径（2026-09-22）：互动的 `ts` 一律是**本地收包时刻**，上游那两个时间戳槽位
        // 只留档、不写进 `Message.ts`（理由见 `interact_v2`）。载荷里给的
        // `1_700_000_000_500` 因此**不会**成为 `ts`。
        assert!(
            (message.ts - danmubox_core::now_ms()).abs() < 5_000,
            "ts 必须是本地收包时刻，不是载荷里的 1700000000500（实测 {}）",
            message.ts
        );
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
            let payload =
                json!({"cmd": cmd, "data": {"pb": "CgtvbmxpbmVfcmFuaw==", "playurl": {}}});
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
        // 头像走同一个 uinfo.base（`protocol.md` §10.4）。
        let payload = json!({
            "cmd": "ENTRY_EFFECT",
            "data": {"uid": 7757052, "uinfo": {"base": {
                "name": "包包子的der一个",
                "face": "https://i0.hdslb.com/bfs/face/entry.png"
            }}}
        });
        let message = message(1, &payload, &counters()).unwrap();
        assert_eq!(message.kind, MessageKind::Interact);
        assert_eq!(message.uid, 7757052);
        assert_eq!(message.uname, "包包子的der一个");
        assert_eq!(message.face, "https://i0.hdslb.com/bfs/face/entry.png");
    }

    /// 同一次进场上游推两条载荷（`ENTRY_EFFECT` + `INTERACT_WORD(_V2)`）：只投一条。
    /// `docs/protocol.md` §10.4 的「不重复计数」此前只有文档、没有代码兜着
    /// （用户 2026-09-22 报的第 1 条）。
    #[test]
    fn interact_merge_suppresses_the_second_payload_of_one_entry() {
        let c = counters();
        let mut merge = InteractMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let entry = message(
            7,
            &json!({"cmd": "ENTRY_EFFECT", "data": {"uid": 7757052, "uinfo": {"base": {"name": "进房的人"}}}}),
            &c,
        )
        .expect("进场特效要解出来");
        let twin = message(
            7,
            &json!({"cmd": "INTERACT_WORD", "data": {"uid": 7757052, "uname": "进房的人"}}),
            &c,
        )
        .expect("互动要解出来");

        let published = merge.absorb(now, entry).expect("第一条要投");
        assert_eq!(published.uid, 7757052);
        assert!(
            merge
                .absorb(now + Duration::from_millis(43), twin)
                .is_none(),
            "同一次进场的第二条压掉不投"
        );
    }

    /// 不同观众各投一条；同一观众窗口过后再次进场照投（`prune` 的边界）。
    #[test]
    fn interact_merge_keeps_other_viewers_and_later_entries() {
        let c = counters();
        let mut merge = InteractMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();
        let enter = |uid: i64| {
            message(
                7,
                &json!({"cmd": "INTERACT_WORD", "data": {"uid": uid}}),
                &c,
            )
            .unwrap()
        };

        assert!(merge.absorb(now, enter(1)).is_some());
        assert!(merge.absorb(now, enter(2)).is_some(), "不同观众互不影响");
        assert!(
            merge
                .absorb(now + Duration::from_millis(10), enter(1))
                .is_none(),
            "窗口内的同源重复压掉"
        );
        assert!(
            merge
                .absorb(
                    now + Duration::from_secs(5) + Duration::from_millis(1),
                    enter(1)
                )
                .is_some(),
            "窗口过后的再次进场照投"
        );
    }

    /// `room_id` 在键里：两个房间的同一个 uid 互不吞（合并器活在房间运行时上）。
    #[test]
    fn interact_merge_scopes_the_key_to_the_room() {
        let c = counters();
        let mut merge = InteractMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();
        let enter = |room_id: i64| {
            message(
                room_id,
                &json!({"cmd": "INTERACT_WORD", "data": {"uid": 42}}),
                &c,
            )
            .unwrap()
        };
        assert!(merge.absorb(now, enter(7)).is_some());
        assert!(
            merge
                .absorb(now + Duration::from_millis(1), enter(8))
                .is_some(),
            "另一个房间的同一 uid 是另一次进场"
        );
    }

    /// V1 礼物与大航海没有可靠的头像来源：这两支必须留空串，不许拿别的字段顶替
    /// （`docs/protocol.md` §10.2 / §10.6）。
    #[test]
    fn gift_v1_and_guard_leave_face_empty() {
        let gift = message(
            7,
            &json!({
                "cmd": "SEND_GIFT",
                "data": {"uid": 1, "uname": "送礼的人", "giftName": "辣条", "num": 1, "price": 100}
            }),
            &counters(),
        )
        .expect("V1 礼物仍要解出来");
        assert_eq!(gift.uname, "送礼的人");
        assert!(gift.face.is_empty(), "V1 礼物没有头像字段");

        let guard = message(
            7,
            &json!({
                "cmd": "GUARD_BUY",
                "data": {"uid": 2, "username": "开舰长的人", "guard_level": 3, "price": 138000}
            }),
            &counters(),
        )
        .expect("大航海仍要解出来");
        assert_eq!(guard.uname, "开舰长的人");
        assert!(guard.face.is_empty(), "大航海没有头像字段");
    }

    /// 大航海的两条载荷（`docs/protocol.md` §10.6）：同一笔购买上游拆成
    /// `GUARD_BUY`（购买事件，`price` = **标价**）与 `USER_TOAST_MSG`（播报，`price` = **实付**）。
    /// 形状照 2026-09-17 核对过的真实样本（合成 uid / 昵称 / 订单号，数值形态一致）。
    fn guard_buy(uid: i64, level: i64, price: i64, start: i64) -> Value {
        json!({
            "cmd": "GUARD_BUY",
            "data": {
                "uid": uid, "username": "开舰长的人", "guard_level": level, "num": 1,
                "price": price, "gift_name": "舰长", "start_time": start, "end_time": start
            }
        })
    }

    fn guard_toast(uid: i64, level: i64, price: i64, start: i64) -> Value {
        json!({
            "cmd": "USER_TOAST_MSG",
            "data": {
                "uid": uid, "username": "开舰长的人", "guard_level": level, "num": 1,
                "price": price, "role_name": "舰长", "start_time": start, "end_time": start,
                "payflow_id": "2604040000000000000000000"
            }
        })
    }

    fn guard_event(room_id: i64, value: &Value, counters: &Counters) -> (Message, GuardSource) {
        match dispatch(room_id, value, counters) {
            Some(Dispatch::Guard { message, source }) => (message, source),
            _ => panic!("大航海必须产出 Dispatch::Guard（交付前由 GuardMerge 按笔合并）"),
        }
    }

    /// `GUARD_BUY.price` 是**标价（原价）**，不得进 `Message.amount`；实付只来自播报。
    /// 舰长的实测取值：标价 `198000`（= 198 元），实付 `138000`（连续包月）/ `168000`（单月）。
    #[test]
    fn guard_buy_price_is_the_list_price_and_never_becomes_the_amount() {
        let c = counters();
        let (buy, source) = guard_event(7, &guard_buy(90001, 3, 198_000, 1_775_317_388), &c);
        assert_eq!(source, GuardSource::Buy);
        assert_eq!(buy.kind, MessageKind::Guard);
        assert_eq!(buy.uid, 90001);
        assert_eq!(buy.uname, "开舰长的人");
        assert_eq!(buy.amount, 0, "购买事件给的是标价，不能当金额");
        assert_eq!(buy.guard_level, 3);
        assert_eq!(buy.content, "开通 舰长 ×1", "名称取 gift_name，数量取 num");
        assert_eq!(
            buy.ts, 1_775_317_388_000,
            "ts 取载荷 start_time（秒 → 毫秒）"
        );
        assert!(
            buy.upstream_id.is_empty(),
            "GUARD_BUY 没有 payflow_id（真实样本如此）"
        );

        let (toast, source) = guard_event(7, &guard_toast(90001, 3, 138_000, 1_775_317_388), &c);
        assert_eq!(source, GuardSource::Toast);
        assert_eq!(toast.amount, 138_000, "播报的 price 是实付，进金额");
        assert_eq!(toast.content, "开通 舰长 ×1");
        assert_eq!(toast.uname, "开舰长的人");
        assert_eq!(toast.upstream_id, "2604040000000000000000000");
    }

    /// **issue 2609171849 #1 的回归**：同一笔的两条载荷只投**一条**，金额取实付 ——
    /// 改前两条都投，界面汇总把标价 198 与实付 138 各算一次（336 元）。
    #[test]
    fn guard_pair_is_merged_into_one_announcement_with_the_paid_price() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let (buy, source) = guard_event(7, &guard_buy(90001, 3, 198_000, 1_775_317_388), &c);
        assert!(merge.absorb(now, buy, source).is_none(), "购买事件先压着");

        let (toast, source) = guard_event(7, &guard_toast(90001, 3, 138_000, 1_775_317_388), &c);
        let published = merge
            .absorb(now + Duration::from_millis(43), toast, source)
            .expect("同笔的播报要投出去");
        assert_eq!(published.amount, 138_000, "金额取实付，不是标价 198000");
        assert_eq!(published.content, "开通 舰长 ×1");

        // 一笔一条：窗口里没有别的产出，等到天荒地老也不会再放一条。
        assert!(merge.deadline().is_none());
        assert!(merge.flush(now + Duration::from_secs(600)).is_none());
    }

    /// 只有购买事件（窗口内没等到播报）：窗口到期后照投一条，**金额留 0** ——
    /// 标价不是实付，按契约 §5「无法确证时 `0`，不得推算」不拿它冒充。
    #[test]
    fn guard_buy_without_a_toast_is_released_without_an_amount() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let (buy, source) = guard_event(7, &guard_buy(90002, 3, 198_000, 1_775_317_390), &c);
        assert!(merge.absorb(now, buy, source).is_none());
        assert_eq!(merge.deadline(), Some(now + Duration::from_secs(5)));
        assert!(
            merge.flush(now + Duration::from_secs(4)).is_none(),
            "窗口没到不放行"
        );

        let released = merge
            .flush(now + Duration::from_secs(5) + Duration::from_millis(1))
            .expect("窗口到期要放行");
        assert_eq!(released.amount, 0);
        assert_eq!(released.content, "开通 舰长 ×1");
        assert!(
            merge.flush(now + Duration::from_secs(600)).is_none(),
            "放行过的不再重复"
        );
    }

    /// 只有播报（比如连接正好停在两条之间）：立即投，金额即实付。
    #[test]
    fn guard_toast_alone_is_published_immediately() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();
        let (toast, source) = guard_event(7, &guard_toast(90003, 3, 168_000, 1_775_317_400), &c);
        let published = merge.absorb(now, toast, source).expect("播报不必等另一半");
        assert_eq!(published.amount, 168_000);
        assert!(merge.deadline().is_none());
    }

    /// 同一笔的第二条载荷（方向不限、含重连补发）一律压掉；两笔不同的购买互不串台。
    #[test]
    fn a_second_payload_of_the_same_purchase_is_suppressed() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        // 反向顺序：播报先到，随后到的购买事件属于同一笔 → 压掉。
        let (toast, source) = guard_event(7, &guard_toast(90003, 3, 168_000, 1_775_317_400), &c);
        assert_eq!(merge.absorb(now, toast, source).unwrap().amount, 168_000);
        let (late_buy, source) = guard_event(7, &guard_buy(90003, 3, 198_000, 1_775_317_400), &c);
        assert!(
            merge
                .absorb(now + Duration::from_millis(20), late_buy, source)
                .is_none(),
            "同一笔已经投过，第二条不再投"
        );

        // 同一笔的购买事件重复到达 —— 也只留一条。
        let (first, s1) = guard_event(7, &guard_buy(90004, 3, 198_000, 1_775_317_410), &c);
        let (again, s2) = guard_event(7, &guard_buy(90004, 3, 198_000, 1_775_317_410), &c);
        assert!(merge.absorb(now, first, s1).is_none());
        assert!(merge
            .absorb(now + Duration::from_millis(5), again, s2)
            .is_none());

        // 另一笔（uid 不同）同时压着：两条各自成行，不互相吞。
        let (other_buy, s3) = guard_event(7, &guard_buy(90005, 3, 198_000, 1_775_317_410), &c);
        assert!(merge
            .absorb(now + Duration::from_millis(6), other_buy, s3)
            .is_none());
        let (other_toast, s4) = guard_event(7, &guard_toast(90005, 3, 138_000, 1_775_317_410), &c);
        assert_eq!(
            merge
                .absorb(now + Duration::from_millis(40), other_toast, s4)
                .unwrap()
                .amount,
            138_000
        );

        // 只剩 90004 那条「没等到播报」的要放行（金额 0），90005 已随播报投过。
        let released = merge
            .flush(now + Duration::from_secs(6))
            .expect("该放 90004");
        assert_eq!(released.uid, 90004);
        assert_eq!(released.amount, 0);
        assert!(merge.flush(now + Duration::from_secs(600)).is_none());
    }

    /// 断连收尾：还压着的购买事件**不论窗口**一律放出去 —— 重连不清缓冲（§12.3），
    /// 一条已经收到的开通不该随连接一起消失。
    #[test]
    fn take_pending_releases_everything_on_connection_end() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();
        for (uid, start) in [(90006, 1_775_317_420), (90007, 1_775_317_421)] {
            let (buy, source) = guard_event(7, &guard_buy(uid, 3, 198_000, start), &c);
            assert!(merge.absorb(now, buy, source).is_none());
        }
        let released: Vec<Message> = merge.take_pending(now).collect();
        assert_eq!(released.len(), 2, "两条都还没投过，收尾时一并放行");
        assert!(released.iter().all(|message| message.amount == 0));
        assert!(merge.take_pending(now).next().is_none(), "放完就空了");
    }

    /// **「一笔买出两行」的回归**（用户 2026-09-22 报的第 4 条）：键里不再有 `ts`，
    /// 因此两条载荷的 `start_time` 不同、缺失、甚至非整数，都仍认得出是同一笔 ——
    /// 改前 `ts` 各自回落成收包时刻，键不同，播报投一条、购买行 5 秒后又被 `flush` 投一条。
    #[test]
    fn guard_key_ignores_the_payload_timestamp() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        // ① 两条的 `start_time` 不同（上游两条口径不一致时就是这样）。
        let (buy, s1) = guard_event(7, &guard_buy(91001, 3, 198_000, 1_775_317_388), &c);
        let (toast, s2) = guard_event(7, &guard_toast(91001, 3, 138_000, 1_775_317_399), &c);
        assert!(merge.absorb(now, buy, s1).is_none());
        let published = merge
            .absorb(now + Duration::from_millis(43), toast, s2)
            .expect("播报要投");
        assert_eq!(published.amount, 138_000, "金额取实付");
        assert!(merge.deadline().is_none(), "购买事件被吸收，没有待放项");
        assert!(
            merge.flush(now + Duration::from_secs(600)).is_none(),
            "一笔一条"
        );

        // ② 两条都**没有** `start_time`（改前必然两行的那种）。
        let no_start = |cmd: &str| {
            json!({"cmd": cmd, "data": {
                "uid": 91002, "username": "开舰长的人", "guard_level": 3, "num": 1,
                "price": 138_000, "gift_name": "舰长", "role_name": "舰长"
            }})
        };
        let (buy, s1) = guard_event(7, &no_start("GUARD_BUY"), &c);
        let (toast, s2) = guard_event(7, &no_start("USER_TOAST_MSG"), &c);
        assert!(merge.absorb(now, buy, s1).is_none());
        assert!(merge
            .absorb(now + Duration::from_millis(43), toast, s2)
            .is_some());
        assert!(merge.deadline().is_none(), "没有第二行");

        // ③ `start_time` 不是整数（`as_i64` 返回 None，同样会回落本地时间）。
        let weird = |cmd: &str| {
            json!({"cmd": cmd, "data": {
                "uid": 91003, "username": "开舰长的人", "guard_level": 3, "num": 1,
                "price": 138_000, "start_time": "1775317388"
            }})
        };
        let (buy, s1) = guard_event(7, &weird("GUARD_BUY"), &c);
        let (toast, s2) = guard_event(7, &weird("USER_TOAST_MSG"), &c);
        assert!(merge.absorb(now, buy, s1).is_none());
        assert!(merge
            .absorb(now + Duration::from_millis(43), toast, s2)
            .is_some());
        assert!(merge.deadline().is_none());
    }

    /// 购买事件被窗口放行之后，迟到的播报**不得**再投一行：放行也要写 `announced`，
    /// 且 `announced` 的 TTL 必须比放行窗口长（改前共用 5s，播报晚于 ~10s 就漏压）。
    #[test]
    fn a_late_toast_after_the_buy_was_released_is_suppressed() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let (buy, source) = guard_event(7, &guard_buy(91004, 3, 198_000, 1_775_317_388), &c);
        assert!(merge.absorb(now, buy, source).is_none());
        let released = merge
            .flush(now + Duration::from_secs(5) + Duration::from_millis(1))
            .expect("窗口到期放行");
        assert_eq!(released.amount, 0, "放行的是购买事件，金额留 0");

        // 播报迟到 10 秒（落在下一条连接上也不罕见）。
        let (late, source) = guard_event(7, &guard_toast(91004, 3, 138_000, 1_775_317_388), &c);
        assert!(
            merge
                .absorb(now + Duration::from_secs(10), late, source)
                .is_none(),
            "同一笔已经投过一行，迟到的播报不再投"
        );
    }

    /// 反向护栏：`announced` 不是永久的 —— 过了 TTL，同一用户同一档的**新一笔**照投。
    #[test]
    fn a_new_purchase_after_the_announced_ttl_is_published_again() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let (toast, source) = guard_event(7, &guard_toast(91005, 3, 138_000, 1_775_317_388), &c);
        assert!(merge.absorb(now, toast, source).is_some());

        let (twin, source) = guard_event(7, &guard_toast(91005, 3, 138_000, 1_775_317_500), &c);
        assert!(
            merge
                .absorb(now + Duration::from_secs(10), twin, source)
                .is_none(),
            "TTL 内是同一笔，第二条压掉"
        );

        let (again, source) = guard_event(7, &guard_toast(91005, 3, 138_000, 1_775_317_600), &c);
        assert!(
            merge
                .absorb(
                    now + GUARD_ANNOUNCED_TTL + Duration::from_millis(1),
                    again,
                    source
                )
                .is_some(),
            "过了 TTL 是新的一笔，照投"
        );
    }

    /// `room_id` 在键里：两个房间的同一个 uid + 等级互不吞。
    #[test]
    fn guard_keys_are_scoped_to_the_room() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let (buy, s1) = guard_event(7, &guard_buy(91006, 3, 198_000, 1_775_317_388), &c);
        let (other, s2) = guard_event(8, &guard_buy(91006, 3, 198_000, 1_775_317_388), &c);
        assert!(merge.absorb(now, buy, s1).is_none());
        assert!(merge.absorb(now, other, s2).is_none());

        let mut released: Vec<Message> = std::iter::from_fn(|| {
            merge.flush(now + Duration::from_secs(5) + Duration::from_millis(1))
        })
        .collect();
        released.sort_by_key(|message| message.room_id);
        assert_eq!(
            released
                .iter()
                .map(|message| message.room_id)
                .collect::<Vec<_>>(),
            vec![7, 8],
            "两个房间各放行一条"
        );
        assert!(merge.flush(now + Duration::from_secs(600)).is_none());
    }

    /// 连接收尾放行的购买事件也要记进 `announced`：断连在两条载荷之间时，播报落在
    /// **下一条**连接上，没有这条记录就会再投一行（第 4 条的第二种形态）。
    #[test]
    fn take_pending_marks_the_purchase_as_announced() {
        let c = counters();
        let mut merge = GuardMerge::with_window(Duration::from_secs(5));
        let now = Instant::now();

        let (buy, source) = guard_event(7, &guard_buy(91007, 3, 198_000, 1_775_317_388), &c);
        assert!(merge.absorb(now, buy, source).is_none());
        let released: Vec<Message> = merge
            .take_pending(now + Duration::from_millis(10))
            .collect();
        assert_eq!(released.len(), 1, "收尾放行一条");

        // 下一条连接上才到的播报。
        let (toast, source) = guard_event(7, &guard_toast(91007, 3, 138_000, 1_775_317_388), &c);
        assert!(
            merge
                .absorb(now + Duration::from_secs(6), toast, source)
                .is_none(),
            "收尾已经放过一行，迟到的播报不再投"
        );
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
            face: "https://i2.hdslb.com/bfs/face/x.jpg".into(),
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
        assert_eq!(
            message.face, "https://i2.hdslb.com/bfs/face/x.jpg",
            "头像取 pb 顶层 tag 3（与 uid / uname 同层）"
        );
        assert_eq!(message.content, "投喂 粉丝团灯牌");
        assert_eq!(message.amount, 200, "100 金瓜子 × 2");
        assert_eq!(message.ts, 1_789_177_882_000, "pb 里是秒级时间戳");
        assert_eq!(message.medal_level, 12);
        assert_eq!(message.medal_name, "牌子");
        assert_eq!(
            message.upstream_id, "4816040157599941120",
            "订单号即上游标识"
        );
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
        assert_eq!(
            c.snapshot().malformed_dropped,
            2,
            "能解码但无礼物子消息的不计 malformed"
        );
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
    fn user_toast_msg_falls_back_to_the_level_title() {
        // `role_name` 可能缺失——此时按等级补名字（`username` 的兜底链同理：
        // 实测样本里有 `username`，字段表却说没有，因此**两条路都要留着**）。
        let payload = json!({
            "cmd": "USER_TOAST_MSG",
            "data": {"guard_level": 2, "num": 2, "price": 2000000}
        });
        let m = message(7, &payload, &counters()).expect("必须解出播报");
        assert_eq!(m.guard_level, 2);
        assert_eq!(m.content, "开通 提督 ×2");
        assert_eq!(m.amount, 2000000, "播报的 price 是实付");
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
                "uinfo": {"base": {"name": "留言的人", "face": "https://i1.hdslb.com/bfs/face/sc.png"}},
                "user_info": {"uname": "留言的人", "guard_level": 0, "manager": 0},
                "medal_info": {"medal_level": 10, "medal_name": "粉丝团", "guard_level": 3}
            }
        });
        let m = message(7, &payload, &counters()).expect("必须解出 SC");
        assert_eq!(m.kind, MessageKind::Superchat);
        assert_eq!(m.content, "很好的一段留言");
        assert_eq!(m.uname, "留言的人");
        assert_eq!(
            m.face, "https://i1.hdslb.com/bfs/face/sc.png",
            "头像取 data.uinfo.base.face（与昵称同层）"
        );
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
    fn live_and_preparing_bubble_the_room_status() {
        let c = counters();

        // ① `LIVE`：照旧入一条「开播」的 `system` 消息，**并且**把开播状态带出来
        //    （用户 2026-09-16：开播下播时状态不会自动更新）。
        let live = dispatch(1, &json!({"cmd": "LIVE"}), &c).expect("LIVE 必须产生产出");
        let Dispatch::LiveStatus {
            message,
            live_status,
        } = live
        else {
            panic!("LIVE 必须带上房间的开播状态");
        };
        assert_eq!(live_status, 1, "LIVE → 直播中");
        assert_eq!(message.kind, MessageKind::System);
        assert_eq!(message.content, "开播");

        // ② `PREPARING`：下播 → 未开播。
        let preparing =
            dispatch(1, &json!({"cmd": "PREPARING"}), &c).expect("PREPARING 必须产生产出");
        let Dispatch::LiveStatus {
            message,
            live_status,
        } = preparing
        else {
            panic!("PREPARING 必须带上房间的开播状态");
        };
        assert_eq!(live_status, 0, "PREPARING → 未开播");
        assert_eq!(message.content, "下播");

        // ③ 其余系统类命令**不带**状态：它们不改 `live_status`（轮播也不由这两条推出）。
        let other =
            dispatch(1, &json!({"cmd": "ROOM_CHANGE"}), &c).expect("ROOM_CHANGE 必须产生消息");
        assert!(
            matches!(other, Dispatch::Message(_)),
            "只有 LIVE / PREPARING 带开播状态"
        );
    }

    #[test]
    fn room_change_bubbles_title() {
        let c = counters();
        // ① 带 `data.room_id` 与 `data.title` → 产出 `RoomTitle`（issue202609241553 第 6 条），
        //    且仍带一条「标题或分区变更」的 `system` 消息（先投消息、再冒泡标题）。
        //    字段名取自参照实现 `HakaseZ/BiliLiveWatcher` 的 `ROOM_CHANGE.go`。
        let value = json!({
            "cmd": "ROOM_CHANGE",
            "data": {"room_id": 777, "title": "新标题"}
        });
        let dispatched = dispatch(1, &value, &c).expect("ROOM_CHANGE 必须产生产出");
        let Dispatch::RoomTitle {
            message,
            room_id,
            title,
        } = dispatched
        else {
            panic!("ROOM_CHANGE 带 room_id/title 必须产 RoomTitle");
        };
        assert_eq!(room_id, 777);
        assert_eq!(title, "新标题");
        assert_eq!(message.kind, MessageKind::System);
        assert_eq!(message.content, "标题或分区变更");

        // ② 缺字段 → 退回普通 `system` 消息（绝不猜）：任一取不到都不冒泡标题。
        let empty = dispatch(1, &json!({"cmd": "ROOM_CHANGE"}), &c).expect("仍产生产出");
        assert!(
            matches!(empty, Dispatch::Message(_)),
            "缺 room_id/title 退回 Message"
        );
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
