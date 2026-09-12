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
//! - 包裹分类（通用 / 粉丝牌 / 大航海 / 房管）的**真实**判定依据未实测。
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
//! `session`（我在该房间的粉丝牌 / 大航海 / 房管）本期**只用于日志**。假设上游按
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
use danmubox_core::{ConfigStore, Emote, EmotePackage, Error, Result, RoomSession};
use serde_json::Value;

use crate::http::BiliHttp;

const EP_EMOTICONS: &str =
    "https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons";

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
        let pkg_token = pkg_id
            .clone()
            .unwrap_or_else(|| format!("pkg{pkg_index}"));

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

            out.push(Emote {
                key: format!("{pkg_token}:{token}"),
                package_kind: kind,
                // 真实字段是 `emoji`（表情字符本身，如「啊」）；`descript` 常为空串，
                // `text` 字段**不存在**（实测自 38 个表情的响应）。
                text: item
                    .get("emoji")
                    .or_else(|| item.get("descript"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                url: item
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                room_id: if is_room_scoped || kind == EmotePackage::Room {
                    room_id
                } else {
                    0
                },
            });
        }
    }
    out
}

/// 包分类。
///
/// 判定顺序（前两步来自房间 `15122413` 的实测样本，见 `docs/protocol.md` 附录 A26）：
///
/// 1. **包名关键字**：房管 / 大航海 / 粉丝牌——这三类**仍无独立样本**，靠名字兜底；
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
    if pkg_name.contains("房管") || pkg_name.contains("管理") {
        return EmotePackage::Admin;
    }
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

    let medal_scoped = emoticons.iter().any(|emote| {
        emote
            .get("unlock_need_level")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            > 0
            || matches!(emote.get("identity").and_then(Value::as_i64), Some(1..=4))
    });
    if medal_scoped {
        return EmotePackage::Medal;
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
    fn room_scoped_packages_carry_the_room_id() {
        // 实测形态：房间 15122413 的 UP主大表情/房间专属表情，pkg_type=2、唯一键 room_<房间号>_<id>。
        let value = json!({
            "data": {"data": [{
                "pkg_id": 327,
                "pkg_name": "UP主大表情",
                "pkg_type": 2,
                "emoticons": [
                    {"emoticon_unique": "room_15122413_847", "emoji": "再来亿把", "url": "https://i/r.png"}
                ]
            }]}
        });
        let emotes = map_packages(15122413, &value);
        assert_eq!(emotes.len(), 1);
        assert_eq!(emotes[0].package_kind, EmotePackage::Room);
        assert_eq!(emotes[0].room_id, 15122413, "房间专属必须绑定房间号");
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
        assert_eq!(classify_package("大航海表情", 2, &none), EmotePackage::Guard);
        assert_eq!(classify_package("房管表情", 2, &none), EmotePackage::Admin);
        assert_eq!(classify_package("管理组", 2, &none), EmotePackage::Admin);
    }

    #[test]
    fn real_packages_of_room_15122413_are_classified_by_emote_fields() {
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
