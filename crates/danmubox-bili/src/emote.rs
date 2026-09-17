//! 表情包库：按我在该房间的身份加载可用表情（`docs/contract.md` §3 `EmoteProvider`）。
//!
//! # 未实测项（**全部为推测**，待集成阶段用真实登录态校准，登记于 `docs/protocol.md` 附录 A）
//!
//! 上游端点与响应结构**尚未实测**，本模块按最可能的形态实现，并逐条标明假设：
//!
//! | 项 | 本期实现所依赖的形态 | 状态 |
//! |---|---|---|
//! | 端点 | `GET https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons` | 未实测 |
//! | 查询参数 | `room_id` + **`platform=pc`** | 实测：`web` 被上游拒为 `code=500`「平台来源错误」 |
//! | 签名 | 假设无需 WBI 签名（不构造 `w_rid` / `wts`） | 未实测 |
//! | 包裹列表路径 | 依次尝试 `data.data` → `data.packages` → `data`，取首个数组 | 未实测 |
//! | 包字段名 | `pkg_id`（数字或字符串）、`pkg_name`（字符串）、`emoticons`（数组） | 未实测 |
//! | 表情字段名 | 显示文本 `emoji`、图 `url`、唯一标识 `emoticon_unique`（回退 `emoticon_id`） | 实测（38 个表情）；**不存在 `text` 字段** |
//! | 结果码 | `code == 0` 为成功，非 0 一律 `Error::Upstream` 并保留原始 code；**不赋予具体码语义** | 未实测 |
//!
//! # 不得编造的部分
//!
//! - 包裹分类（通用 / 房间 / 粉丝牌 / 大航海）的**真实**判定依据未实测。
//!
//! **没有「房管」这一类**（2026-09-12，项目所有者确认）：官方前端的表情权限判定
//! `emoticonDanmakuPermCheck` 也只有「粉丝团」与「1/2/3 总督/提督/舰长」两个分支，
//! 全部「房管」命中都在禁言 / 拉黑 / 任命语境里。房管身份只体现为弹幕徽标（`is_admin`）。
//! 本模块曾据此凭空造出 `EmotePackage::Admin`，已删除。
//!   `classify_package` 只按**包名的子串**做启发式判断（下节写明），判不出即回落
//!   `Common` 并打 `debug` 日志。分类含义本身取自 `docs/contract.md` §5，无需猜测。
//! - 未实测的错误码不映射到任何业务含义，一律进 `Error::Upstream`。
//! - 字段缺失不报错：取不到就填空串 / 0，并保留条目（`docs/protocol.md` 待校准）。
//!
//! # 分类启发式（**未实测**，仅按包名子串）
//!
//! 判定顺序：含「房管 / 管理」→ `Admin`；含「舰 / 航海 / 提督 / 总督」→ `Guard`；
//! 含「粉丝 / 勋章」→ `Medal`；其余 → `Common`（并打 debug 日志）。
//! 这些子串只是**最可能的命名习惯**，不是上游语义；实测后以 `docs/protocol.md` 为准。
//!
//! # 参数 `session` 的用途
//!
//! `session`（我在该房间的粉丝牌 / 大航海）本期**只用于日志**。假设上游按
//! 房间与登录态下发**已过滤**的可用包裹，因此本模块**不做二次过滤**——若这个假设
//! 不成立（例如上游返回超集），校准后再按 `session` 补过滤。
//!
//! # `Emote.room_id` 口径
//!
//! 该端点按房间下发，但可观察字段无法区分「通用包」与「房间专属包」，
//! 因此本期统一填请求的房间号（非 0），待实测校准。

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::EmoteProvider;
use danmubox_core::{ConfigStore, Emote, EmotePackage, EmoteRef, Error, Result, RoomSession};
use serde_json::Value;

use crate::http::BiliHttp;

const EP_EMOTICONS: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons";

/// 主站「我的表情」面板（`docs/protocol.md` 附录 A35 结案，2026-09-12 实测）。
/// `business=live` 返回 `-400`，只有 `reply` / `dynamic` 两个取值。
const EP_EMOTE_OWNED: &str = "https://api.bilibili.com/x/emote/user/panel/web?business=reply";

/// 主站表情的唯一键前缀。
///
/// 主站表情对象**没有** `emoticon_unique`，编号语义与直播那套不同；唯一键由
/// `upower_` + 表情的 `text` 拼装。实测：接口返回的 `[Kirikosama_吃瓜]` 与弹幕里
/// 收到的那条 `upower_[Kirikosama_吃瓜]` 完全一致（A35 结案）。
const OWNED_UNIQUE_PREFIX: &str = "upower_";

pub struct BiliEmotes {
    http: BiliHttp,
    store: Arc<ConfigStore>,
}

impl BiliEmotes {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
        })
    }
}

/// 上游响应 → 表情列表（纯函数，便于离线覆盖）。
///
/// 展平全部包裹；`key` 由「包标识 + 表情标识」拼成，保证包内唯一。
/// 字段缺失一律容错：标识缺失退化为下标，文本 / 链接缺失填空串。
/// 从**弹幕载荷里的表情对象**解析出 `EmoteRef`（实时 `DANMU_MSG` 的 `info[0][13]`
/// 与历史条目的 `emoticon` 是同一套字段，实测确认）。
///
/// 存在的意义：**渲染弹幕里的表情**——正文把表情画成图，盒子取哪一档由 `bulge_display`
/// 与 `width / height` 的长宽比定（`docs/ui.md` §4.1）。
/// （曾以「学到的表情能再发回去」为由存这一族，2026-09-13 实测证伪并删除该机制：跨房间的
/// `room_<房间号>_<id>` 发送必被上游拒（`code=10203`）。）
pub fn emote_ref_from_object(emote: &Value) -> Option<EmoteRef> {
    let url = emote.get("url").and_then(Value::as_str)?;
    if url.is_empty() {
        return None;
    }
    let geom = |key: &str| emote.get(key).and_then(Value::as_i64).unwrap_or(0);
    let flag = |key: &str| emote.get(key).and_then(Value::as_i64).unwrap_or(0) != 0;
    Some(EmoteRef {
        emoticon_unique: emote
            .get("emoticon_unique")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        url: crate::asset::secure_url(url),
        width: geom("width"),
        height: geom("height"),
        is_dynamic: flag("is_dynamic"),
        in_player_area: flag("in_player_area"),
        bulge_display: flag("bulge_display"),
    })
}

pub fn map_packages(room_id: i64, value: &Value) -> Vec<Emote> {
    let Some(packages) = package_array(value) else {
        tracing::debug!("表情响应未找到包裹列表（路径未实测）");
        return Vec::new();
    };

    let mut out = Vec::new();
    for (pkg_index, package) in packages.iter().enumerate() {
        let pkg_id = package.get("pkg_id").and_then(scalar_string);
        let pkg_name = package
            .get("pkg_name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let pkg_type = package.get("pkg_type").and_then(Value::as_i64).unwrap_or(1);
        let empty = Vec::new();
        let package_items = package
            .get("emoticons")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let kind = classify_package(pkg_name, pkg_type, package_items);
        let pkg_token = pkg_id.clone().unwrap_or_else(|| format!("pkg{pkg_index}"));

        if package_items.is_empty() {
            tracing::debug!(pkg_index, "表情包缺少表情数组，跳过");
            continue;
        }
        let items = package_items;

        let mut seen: HashSet<String> = HashSet::new();
        for (emote_index, item) in items.iter().enumerate() {
            let mut token = item
                .get("emoticon_unique")
                .and_then(scalar_string)
                .or_else(|| item.get("emoticon_id").and_then(scalar_string))
                .unwrap_or_else(|| emote_index.to_string());
            if !seen.insert(token.clone()) {
                token = format!("{token}#{emote_index}");
                seen.insert(token.clone());
            }

            // 房间专属表情的 `emoticon_unique` 形如 `room_<房间号>_<id>`（实测），
            // 据此决定 `room_id`：契约 §5 要求「房间专属时非 0」，通用表情为 0。
            let is_room_scoped = item
                .get("emoticon_unique")
                .and_then(Value::as_str)
                .map(|unique| unique.starts_with("room_"))
                .unwrap_or(false);

            let geom = |key: &str| item.get(key).and_then(Value::as_i64).unwrap_or(0);
            let flag = |key: &str| item.get(key).and_then(Value::as_i64).unwrap_or(0) != 0;
            out.push(Emote {
                key: format!("{pkg_token}:{token}"),
                emoticon_unique: item
                    .get("emoticon_unique")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                width: geom("width"),
                height: geom("height"),
                is_dynamic: flag("is_dynamic"),
                in_player_area: flag("in_player_area"),
                bulge_display: flag("bulge_display"),
                package_kind: kind,
                // 真实字段是 `emoji`（表情字符本身，如「啊」）；`descript` 常为空串，
                // `text` 字段**不存在**（实测自 38 个表情的响应）。
                text: item
                    .get("emoji")
                    .or_else(|| item.get("descript"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                url: crate::asset::secure_url(
                    item.get("url").and_then(Value::as_str).unwrap_or_default(),
                ),
                room_id: if is_room_scoped || kind == EmotePackage::Room {
                    room_id
                } else {
                    0
                },
                // 上游按**调用者身份**算好的可用性：`perm == 0` 即「我无权使用」。
                // 实测（A26 补记）：同房间两个账号拿到同一份表情，舰长专属那批的 `perm`
                // 从 0 变 1，其它字段一模一样——所以置灰判据只能取这一位。
                // 字段缺失按「可用」处理（见 `Emote::locked` 的说明）。
                locked: item.get("perm").and_then(Value::as_i64) == Some(0),
            });
        }
    }
    out
}

/// 主站「我的表情」响应 → 表情列表（纯函数，便于离线覆盖）。
///
/// 结构（2026-09-12 实测）：包在 `data.packages[]`，表情在每个包的 **`emote[]`**
/// 字段里（**不是**直播那套的 `emoticons`）；每个表情有 `text`（完整名字，
/// 形如 `[Kirikosama_吃瓜]`）与 `url`。
///
/// 主站表情对象**没有** `width` / `height` / `is_dynamic` / `in_player_area` /
/// `bulge_display`：官方前端对这些量一律按 `width: c.width || 1`、`height: c.height || 1`
/// 兜底（表情面板渲染），因此这里宽高取 `1`、其余标志取 `false`。它们只影响发送
/// 表情弹幕时 `emoticonOptions` 里的尺寸/标志，不改变唯一键。
pub fn map_owned_packages(value: &Value) -> Vec<Emote> {
    let Some(packages) = value.pointer("/data/packages").and_then(Value::as_array) else {
        tracing::debug!("主站表情响应没有 data.packages");
        return Vec::new();
    };

    let mut out = Vec::new();
    for (pkg_index, package) in packages.iter().enumerate() {
        let pkg_token = package
            .get("id")
            .and_then(scalar_string)
            .unwrap_or_else(|| format!("pkg{pkg_index}"));
        let empty = Vec::new();
        let items = package
            .get("emote")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        if items.is_empty() {
            tracing::debug!(pkg_index, "主站表情包没有 emote 数组，跳过");
            continue;
        }

        let mut seen: HashSet<String> = HashSet::new();
        for (emote_index, item) in items.iter().enumerate() {
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            let url = item.get("url").and_then(Value::as_str).unwrap_or_default();
            // 没有文本就拼不出唯一键、没有图片就发不出去，两者缺一都跳过。
            if text.is_empty() || url.is_empty() {
                tracing::debug!(pkg_index, emote_index, "主站表情缺 text 或 url，跳过");
                continue;
            }

            let mut token = item
                .get("id")
                .and_then(scalar_string)
                .unwrap_or_else(|| emote_index.to_string());
            if !seen.insert(token.clone()) {
                token = format!("{token}#{emote_index}");
                seen.insert(token.clone());
            }

            out.push(Emote {
                key: format!("{pkg_token}:{token}"),
                package_kind: EmotePackage::Owned,
                emoticon_unique: format!("{OWNED_UNIQUE_PREFIX}{text}"),
                text: text.to_string(),
                url: crate::asset::secure_url(url),
                width: 1,
                height: 1,
                is_dynamic: false,
                in_player_area: false,
                bulge_display: false,
                room_id: 0,
                // 主站「我的表情」= 我拥有的表情，响应里没有 `perm` 这一位，
                // 也不存在「按房间身份解锁」的概念，因此一律可用。
                locked: false,
            });
        }
    }
    out
}

/// 包分类。
///
/// 判定顺序（前两步来自房间 `某个在播房间（房间号不写入仓库）` 的实测样本，见 `docs/protocol.md` 附录 A26）：
///
/// 1. **包名关键字**：大航海 / 粉丝牌——这两类**仍无独立样本**，靠名字兜底；
/// 2. **表情自身的解锁字段**：任一表情 `unlock_need_level > 0` 或 `identity ∈ 1..=4`，
///    说明这包是按粉丝牌档位分的；
/// 3. `pkg_type == 2` → 房间专属；否则通用。
///
/// 实测三个包（`pkg_type` / 表情侧字段 / 分类）：
///
/// | 包 | `pkg_type` | 表情侧 | 分类 |
/// |---|---|---|---|
/// | 通用表情 | `1` | `identity=99`、`unlock_need_level=0` | `Common` |
/// | UP主大表情 | `2` | `identity=1..4`、`unlock_need_level=1` | `Medal` |
/// | 房间专属表情 | `2` | `identity=99`、`unlock_need_level=0` | `Room` |
///
/// **包级**的 `pkg_perm` / `unlock_identity` / `unlock_need_gift` 在三个包里取值完全相同，
/// 不能用来区分；判据在**表情级**字段上。
fn classify_package(pkg_name: &str, pkg_type: i64, emoticons: &[Value]) -> EmotePackage {
    if pkg_name.contains("舰")
        || pkg_name.contains("航海")
        || pkg_name.contains("提督")
        || pkg_name.contains("总督")
    {
        return EmotePackage::Guard;
    }
    if pkg_name.contains("粉丝") || pkg_name.contains("勋章") {
        return EmotePackage::Medal;
    }

    // 表情级解锁判据。`identity` 的语义取自**官方客户端自己的解锁文案映射**
    // （`emoticonDanmakuPermCheck`）：`identity === 4` → 「加入主播的粉丝团」；
    // `identity` 1/2/3 → 「开通主播的总督/提督/舰长」。因此：
    //   有 identity 4 或有等级门槛 → 粉丝牌包；
    //   只有 identity 1..=3          → 大航海包；
    //   两者都没有（identity 99）    → 按 `pkg_type` 分通用 / 房间。
    // 一个包可能同时含粉丝团与大航海门槛的表情（实测样本即如此），此时按粉丝牌归类。
    let identities: Vec<i64> = emoticons
        .iter()
        .filter_map(|emote| emote.get("identity").and_then(Value::as_i64))
        .collect();
    let has_medal_tier = emoticons.iter().any(|emote| {
        emote
            .get("unlock_need_level")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            > 0
    });
    if has_medal_tier || identities.contains(&4) {
        return EmotePackage::Medal;
    }
    if identities.iter().any(|id| (1..=3).contains(id)) {
        return EmotePackage::Guard;
    }

    if pkg_type == 2 {
        EmotePackage::Room
    } else {
        EmotePackage::Common
    }
}

/// 依次尝试候选路径，取首个数组（路径名**未实测**）。
fn package_array(value: &Value) -> Option<&Vec<Value>> {
    const CANDIDATES: [&str; 3] = ["/data/data", "/data/packages", "/data"];
    for path in CANDIDATES {
        if let Some(array) = value.pointer(path).and_then(Value::as_array) {
            return Some(array);
        }
    }
    None
}

/// 上游标识可能是数字或字符串，统一取为字符串。
fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

#[async_trait]
impl EmoteProvider for BiliEmotes {
    async fn emotes(&self, room_id: i64, session: &RoomSession) -> Result<Vec<Emote>> {
        // 未登录：三要素不全即拒绝（`docs/contract.md` §4.1）。
        self.store
            .active()
            .filter(|profile| profile.is_complete())
            .ok_or(Error::NotLoggedIn)?;

        // `session` 本期只用于日志，不做二次过滤（假设见模块文档）。
        tracing::debug!(
            room_id,
            my_medal_level = session.my_medal_level,
            my_guard_level = session.my_guard_level,
            is_admin = session.is_admin,
            "加载表情包"
        );

        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("room_id", &room_id.to_string())
            .append_pair("platform", "pc")
            .finish();
        let (value, _) = self
            .http
            .get_with_cookies(&format!("{EP_EMOTICONS}?{query}"))
            .await?;

        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            // 未实测的码集合：保留原始 code，不赋予含义。
            return Err(Error::Upstream(format!("GetEmoticons code={code}")));
        }
        Ok(map_packages(room_id, &value))
    }

    async fn owned(&self) -> Result<Vec<Emote>> {
        // 刻意**不**要求登录：未登录时上游退化为免费表情包，照常返回即可
        // （任务约定；主站接口本身不需要任何额外签名）。
        let (value, _) = self.http.get_with_cookies(EP_EMOTE_OWNED).await?;

        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        if code != 0 {
            // 未实测的码集合：保留原始 code，不赋予含义。
            return Err(Error::Upstream(format!("emote/user/panel/web code={code}")));
        }
        Ok(map_owned_packages(&value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn not_logged_in_store() -> Arc<ConfigStore> {
        let path = std::env::temp_dir()
            .join(format!("danmubox-emote-test-{}", std::process::id()))
            .join("config.toml");
        Arc::new(ConfigStore::load(path).unwrap())
    }

    #[test]
    fn empty_response_maps_to_no_emotes() {
        assert!(map_packages(1, &json!({"code": 0, "data": {"data": []}})).is_empty());
        assert!(map_packages(1, &json!({})).is_empty());
        assert!(map_packages(1, &json!({"code": 0, "data": {"data": {}}})).is_empty());
    }

    #[test]
    fn flattens_package_with_many_emoticons() {
        let value = json!({
            "code": 0,
            "data": {"data": [{
                "pkg_id": 1,
                "pkg_name": "通用表情",
                "emoticons": [
                    {"emoticon_unique": "official_1", "emoji": "笑", "descript": "", "url": "https://i/a.png"},
                    {"emoticon_unique": "official_2", "emoji": "哭", "url": "https://i/b.png"}
                ]
            }]}
        });
        let emotes = map_packages(2233, &value);
        assert_eq!(emotes.len(), 2);
        assert_eq!(emotes[0].key, "1:official_1");
        assert_eq!(emotes[1].key, "1:official_2");
        assert_eq!(emotes[0].text, "笑", "显示文本取 emoji");
        assert_eq!(emotes[1].text, "哭");
        assert_eq!(emotes[1].url, "https://i/b.png");
        assert_eq!(emotes[0].package_kind, EmotePackage::Common);
        assert_eq!(emotes[0].room_id, 0, "通用表情不绑定房间（契约 §5）");
    }

    #[test]
    fn locked_follows_the_emote_level_perm_field() {
        // 实测形状（同一个房间、两个身份不同的账号各拉一次）：两边拿到**完全相同**的
        // 表情清单，只有「舰长专属」那批（identity=3）的 `perm` 随身份从 0 变 1。
        // 因此置灰判据只能取表情级 `perm`。
        let value = json!({
            "data": {"data": [{
                "pkg_id": 327, "pkg_name": "UP主大表情", "pkg_type": 2,
                "emoticons": [
                    {"emoji": "饭饭", "url": "https://i/a.png", "identity": 3, "perm": 0,
                     "unlock_need_level": 1},
                    {"emoji": "再来亿把", "url": "https://i/b.png", "identity": 4, "perm": 1,
                     "unlock_need_level": 1}
                ]
            }]}
        });
        let emotes = map_packages(2233, &value);
        assert!(emotes[0].locked, "perm=0 即我无权使用 → 界面置灰");
        assert!(!emotes[1].locked, "perm=1 即可用");
    }

    #[test]
    fn missing_perm_is_treated_as_usable() {
        // 字段没给时按可用处理：宁可少置灰一个，也不要把整个表情面板画成灰色
        // （置灰是提示，不是权限闸门——真正的拦截在上游发送侧）。
        let value = json!({
            "data": {"data": [{
                "pkg_id": 1, "pkg_name": "通用表情", "emoticons": [
                    {"emoji": "笑", "url": "https://i/a.png"},
                    {"emoji": "哭", "url": "https://i/b.png", "perm": 2}
                ]
            }]}
        });
        let emotes = map_packages(1, &value);
        assert!(!emotes[0].locked, "缺 perm 视为可用");
        assert!(
            !emotes[1].locked,
            "只有 0 才判为无权限；未观测到的其它取值不猜测语义"
        );
    }

    #[test]
    fn owned_emotes_are_never_locked() {
        let value = json!({
            "data": {"packages": [{"id": 4022, "text": "Kirikosama", "emote": [
                {"id": 1, "text": "[Kirikosama_吃瓜]", "url": "https://i/a.png"}
            ]}]}
        });
        let emotes = map_owned_packages(&value);
        assert_eq!(emotes.len(), 1);
        assert!(
            !emotes[0].locked,
            "主站「我的表情」是我拥有的，不存在按身份解锁"
        );
    }

    #[test]
    fn owned_emotes_use_the_emote_array_and_upower_unique() {
        let value = json!({
            "code": 0,
            "data": {"packages": [{
                "id": 4022,
                "text": "Kirikosama",
                "type": 3,
                "emote": [
                    {"id": 364855, "text": "[Kirikosama_吃瓜]", "url": "http://i0.hdslb.com/bfs/emote/abc.png"},
                    {"id": 364856, "text": "[Kirikosama_不要啊]", "url": "https://i0.hdslb.com/bfs/emote/def.png"}
                ]
            }]}
        });
        let emotes = map_owned_packages(&value);
        assert_eq!(emotes.len(), 2);
        assert_eq!(emotes[0].key, "4022:364855");
        assert_eq!(emotes[0].package_kind, EmotePackage::Owned);
        assert_eq!(emotes[0].emoticon_unique, "upower_[Kirikosama_吃瓜]");
        assert_eq!(emotes[0].text, "[Kirikosama_吃瓜]");
        assert_eq!(
            emotes[0].url, "https://i0.hdslb.com/bfs/emote/abc.png",
            "http 图必须升为 https"
        );
        assert_eq!(emotes[0].width, 1, "主站表情无宽高，按官方前端 ||1 兜底");
        assert_eq!(emotes[0].height, 1);
        assert_eq!(emotes[0].room_id, 0, "主站表情不绑定任何房间");
        assert_ne!(emotes[0].key, emotes[1].key);
        assert_ne!(
            emotes[0].emoticon_unique, emotes[1].emoticon_unique,
            "唯一键必须按 text 区分"
        );
    }

    #[test]
    fn owned_emotes_ignore_the_live_style_emoticons_field() {
        // 直播那套的表情数组叫 `emoticons`，主站叫 `emote`；混用会静默拿到空列表，
        // 因此这里把「串味」钉成断言。
        let value = json!({
            "data": {"packages": [{"id": 1, "emoticons": [{"text": "x", "url": "https://i/a.png"}]}]}
        });
        assert!(map_owned_packages(&value).is_empty());
        assert!(map_owned_packages(&json!({"code": 0, "data": {}})).is_empty());
        assert!(map_owned_packages(&json!({"code": 0})).is_empty());
    }

    #[test]
    fn owned_emotes_skip_entries_without_text_or_url() {
        let value = json!({"data": {"packages": [{"id": 9, "emote": [
            {"id": 1, "url": "https://i/a.png"},
            {"id": 2, "text": "[无图]"},
            {"id": 3, "text": "[可用]", "url": "https://i/b.png"}
        ]}]}});
        let emotes = map_owned_packages(&value);
        assert_eq!(emotes.len(), 1);
        assert_eq!(emotes[0].emoticon_unique, "upower_[可用]");
    }

    #[test]
    fn room_scoped_packages_carry_the_room_id() {
        // 实测形态：某个在播房间（房间号不写入仓库） 的 UP主大表情/房间专属表情，pkg_type=2、唯一键 room_<房间号>_<id>。
        let value = json!({
            "data": {"data": [{
                "pkg_id": 327,
                "pkg_name": "UP主大表情",
                "pkg_type": 2,
                "emoticons": [
                    {"emoticon_unique": "room_7654321_847", "emoji": "再来亿把", "url": "https://i/r.png"}
                ]
            }]}
        });
        let emotes = map_packages(7654321, &value);
        assert_eq!(emotes.len(), 1);
        assert_eq!(emotes[0].package_kind, EmotePackage::Room);
        assert_eq!(emotes[0].room_id, 7654321, "房间专属必须绑定房间号");
    }

    #[test]
    fn missing_fields_are_tolerated() {
        let value = json!({
            "code": 0,
            "data": {"data": [{"pkg_id": "room_9", "pkg_name": "怪包", "emoticons": [{}, {}]}]}
        });
        let emotes = map_packages(1, &value);
        assert_eq!(emotes.len(), 2);
        assert!(emotes.iter().all(|e| e.text.is_empty() && e.url.is_empty()));
        assert_ne!(emotes[0].key, emotes[1].key);
        assert_eq!(emotes[0].key, "room_9:0");
        assert_eq!(emotes[1].key, "room_9:1");
    }

    #[test]
    fn duplicate_identifiers_still_yield_unique_keys() {
        let value = json!({
            "data": {"packages": [{
                "pkg_id": 7,
                "pkg_name": "通用",
                "emoticons": [{"emoticon_id": 5}, {"emoticon_id": 5}]
            }]}
        });
        let emotes = map_packages(1, &value);
        assert_eq!(emotes.len(), 2);
        assert_ne!(emotes[0].key, emotes[1].key);
    }

    #[test]
    fn package_kind_name_heuristics_still_win() {
        // 身份类分类靠包名关键字，仍未独立实测（手上没有这类包）。
        let none: Vec<Value> = Vec::new();
        assert_eq!(classify_package("粉丝勋章", 2, &none), EmotePackage::Medal);
        assert_eq!(classify_package("舰长专属", 2, &none), EmotePackage::Guard);
        assert_eq!(
            classify_package("大航海表情", 2, &none),
            EmotePackage::Guard
        );
        // 「房管」不构成分类：房管没有表情包（项目所有者确认 + 官方前端无该分支）。
        // 万一上游真发了这种名字的包，按房间专属处理即可——不为此单开一类。
        assert_eq!(classify_package("房管表情", 2, &none), EmotePackage::Room);
    }

    #[test]
    fn guard_tier_identities_map_to_the_guard_group() {
        // 官方 emoticonDanmakuPermCheck 的文案映射：identity 1/2/3 = 总督/提督/舰长。
        // 只有大航海门槛、没有粉丝团门槛的包，应归「大航海」而不是「粉丝牌」。
        let guard_only = json!([
            {"identity": 1, "perm": 1, "unlock_need_level": 0},
            {"identity": 3, "perm": 1, "unlock_need_level": 0}
        ]);
        assert_eq!(
            classify_package("舰长表情", 2, &guard_only.as_array().cloned().unwrap()),
            EmotePackage::Guard
        );

        // 同时含粉丝团（identity 4）与大航海档位时，按粉丝牌归类（实测样本即如此）。
        let mixed = json!([
            {"identity": 4, "perm": 1, "unlock_need_level": 1},
            {"identity": 2, "perm": 0, "unlock_need_level": 1}
        ]);
        assert_eq!(
            classify_package("UP主大表情", 2, &mixed.as_array().cloned().unwrap()),
            EmotePackage::Medal
        );
    }

    #[test]
    fn real_packages_are_classified_by_emote_fields() {
        // 实测样本：三个包的包级 pkg_perm/unlock_identity/unlock_need_gift 完全相同，
        // 只有表情级字段能区分——UP主大表情其实是粉丝牌档位包。
        let common = json!([{"identity": 99, "unlock_need_level": 0}]);
        let medal = json!([
            {"identity": 4, "perm": 1, "unlock_need_level": 1, "unlock_need_gift": 31164},
            {"identity": 2, "perm": 0, "unlock_need_level": 1}
        ]);
        let room = json!([{"identity": 99, "unlock_need_level": 0}]);

        assert_eq!(
            classify_package("通用表情", 1, &common.as_array().cloned().unwrap()),
            EmotePackage::Common
        );
        assert_eq!(
            classify_package("UP主大表情", 2, &medal.as_array().cloned().unwrap()),
            EmotePackage::Medal,
            "有 unlock_need_level / identity 档位的是粉丝牌包"
        );
        assert_eq!(
            classify_package("房间专属表情", 2, &room.as_array().cloned().unwrap()),
            EmotePackage::Room
        );
        // 无表情可看时按 pkg_type 回落。
        let none: Vec<Value> = Vec::new();
        assert_eq!(classify_package("神秘包裹", 2, &none), EmotePackage::Room);
        assert_eq!(classify_package("神秘包裹", 1, &none), EmotePackage::Common);
    }

    #[tokio::test]
    async fn not_logged_in_is_rejected() {
        let provider = BiliEmotes::new(not_logged_in_store()).unwrap();
        let session = RoomSession::default();
        let error = provider.emotes(1, &session).await.unwrap_err();
        assert_eq!(error.code(), "NOT_LOGGED_IN");
    }
}
