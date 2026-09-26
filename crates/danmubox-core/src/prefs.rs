//! 界面偏好：`prefs.json`（`docs/contract.md` §4.2、§8）。
//!
//! 只存被显式改过的键；读取时与默认值合并得到「生效值」。
//! 未知键或非法值在写入时一律报 `BAD_REQUEST`。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};

use crate::error::{Error, Result};
use crate::session::BufferCaps;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ty {
    Num,
    Int,
    Bool,
    Str,
    StrArr,
    IntArr,
    KindArr,
    /// 「房间号 → 时刻」这类定宽映射：键是十进制房间号，值是 `i64`。
    IntMap,
}

struct Spec {
    key: &'static str,
    ty: Ty,
    default: Value,
    min: Option<f64>,
    max: Option<f64>,
    allowed: Option<&'static [&'static str]>,
}

/// `kind` 的**校验**集合：永远六种，勾回来的路必须留着（用户随时能把「系统」再选上）。
const KINDS: [&str; 6] = [
    "danmaku",
    "gift",
    "superchat",
    "interact",
    "guard",
    "system",
];

/// `filter.kinds` 的**默认**白名单：不含 `system`。
///
/// 需求 §2.4 要的是「系统通知默认不显示」。删掉 `ui.system_notice` 之后
/// （issue 2609140651 #1：它和「消息类型 → 系统」是逐字相同的一条门），
/// 这份默认值就是那句话的唯一落点。
const DEFAULT_KINDS: [&str; 5] = ["danmaku", "gift", "superchat", "interact", "guard"];

/// 已删除的历史偏好键（issue 2609140651 #1）。
///
/// 存量 `prefs.json` 里可能还写着它：`load` 时按它的值把结果**物化**进
/// `filter.kinds`（`false` → 去掉 `system`；`true` → 补上 `system`），
/// 旧键本身当未知键忽略；下次 `save` 只落 `overrides`，文件里就只剩新形态。
const LEGACY_SYSTEM_NOTICE: &str = "ui.system_notice";

/// 已删除的历史偏好键（issue 2609152029 #4）。
///
/// 存量 `prefs.json` 里可能还写着它：`load` 时按它的值物化进 `ui.gift_in_danmaku` /
/// `ui.gift_panel` 两枚新键（`separate` → `false` / `true`；`merged` → `true` / `false`），
/// 旧键本身当未知键忽略；下次 `save` 只落 `overrides`，文件里就只剩新形态。
const LEGACY_GIFT_PANEL_MODE: &str = "ui.gift_panel_mode";

/// 已删除的历史偏好键（issue 2609171849 #3）。
///
/// 单一环形缓冲拆成按 `kind` 分档之后，这一枚不再是「缓冲上限」这件事的完整表达（它盖不住
/// 六档）。存量 `prefs.json` 里可能还写着它：`load` 时按它的值物化进 `history.buffer_rows_danmaku`
/// —— 用户当初表达的是「缓冲区留多少条」，而弹幕是那个缓冲里的主流量，落点就是弹幕档。
/// 旧键本身当未知键忽略；下次 `save` 只落 `overrides`，文件里就只剩新形态。
const LEGACY_BUFFER_ROWS: &str = "history.buffer_rows";

/// 已在 `load` 里被接管的历史键：它们不参与白名单匹配，也不算「未知键」。
const LEGACY_KEYS: [&str; 3] = [
    LEGACY_SYSTEM_NOTICE,
    LEGACY_GIFT_PANEL_MODE,
    LEGACY_BUFFER_ROWS,
];

fn spec(
    key: &'static str,
    ty: Ty,
    default: Value,
    min: Option<f64>,
    max: Option<f64>,
    allowed: Option<&'static [&'static str]>,
) -> Spec {
    Spec {
        key,
        ty,
        default,
        min,
        max,
        allowed,
    }
}

/// 唯一权威的偏好键清单（`docs/contract.md` §8）。顺序即输出顺序。
static SPECS: LazyLock<Vec<Spec>> = LazyLock::new(|| {
    vec![
        spec(
            "ui.font_scale",
            Ty::Num,
            json!(1.0),
            Some(0.8),
            Some(2.0),
            None,
        ),
        spec(
            "ui.theme",
            Ty::Str,
            json!("system"),
            None,
            None,
            Some(&["system", "dark", "light"]),
        ),
        spec("ui.auto_scroll", Ty::Bool, json!(true), None, None, None),
        spec("ui.pause_on_hover", Ty::Bool, json!(true), None, None, None),
        // 礼物栏两枚独立开关（issue 2609152029 #4）。旧键 `ui.gift_panel_mode`
        // （`merged` / `separate`）是一个二选一的门，表达不了「都显示」或「都不显示」，
        // 已删除；存量迁移见 [`LEGACY_GIFT_PANEL_MODE`]。
        spec(
            "ui.gift_in_danmaku",
            Ty::Bool,
            json!(true),
            None,
            None,
            None,
        ),
        spec("ui.gift_panel", Ty::Bool, json!(true), None, None, None),
        // 礼物栏与弹幕区**共享一块上下分区**时的顺序与份额（issue #8，用户 2026-09-16）：
        // 默认 `false` / `0.35` 是改前的形态（礼物在下、弹幕吃掉绝大部分高度）。
        // 两者都只在 `ui.gift_panel` 为真时有意义；关掉那一枚时共享区域退化为弹幕区全高。
        // 比例的含义 = 礼物栏占**共享分区**高度的份额，与它在上还是在下无关（换位不改比例）；
        // 落到像素时再被两栏的最小高度夹一次（礼物栏 ≥ 其折叠头 / 弹幕区 ≥ 3 行），
        // 因此这里存的是**指针意图**而不是实测像素 —— 同一窗口尺寸下重开必然得到同一画面。
        spec(
            "ui.gift_pane_on_top",
            Ty::Bool,
            json!(false),
            None,
            None,
            None,
        ),
        spec(
            "ui.gift_pane_ratio",
            Ty::Num,
            json!(0.35),
            Some(0.10),
            Some(0.90),
            None,
        ),
        // 礼物栏内按 kind 筛选（契约 §8）：空数组 = 全显示，选中 N 项 = 只显示这 N 项的并集。
        // **只作用于礼物栏** —— 弹幕区有自己的 `filter.kinds`，两枚互不串味。
        // 类型沿用 `filter.kinds` 的 `KindArr`（六种 kind 的任意子集）：界面只渲染礼物三族，
        // 写进别的 kind 是**无效果**而不是非法值，因此不另立一枚更窄的类型。
        spec(
            "ui.gift_pane_kinds",
            Ty::KindArr,
            json!([]),
            None,
            None,
            None,
        ),
        // 低价礼物（单个价值 ≤ 0.1 元 = 100 金瓜子）的两枚开关（issue 2609162056 第 3、4 条）。
        // **默认都是 false**：多数人现有效果不该被这两条辅助开关改掉 —— 折叠会改礼物栏的分组形状、
        // 剔除会改折叠头的统计口径，两者都是「用户自己要才生效」的显示偏好。
        // 判定口径（门槛、`amount <= 0` 不算低价、只认 kind = "gift"）在契约 §8 与 ui.md §5.3。
        spec(
            "ui.gift_collapse_cheap",
            Ty::Bool,
            json!(false),
            None,
            None,
            None,
        ),
        spec(
            "ui.gift_exclude_cheap_stats",
            Ty::Bool,
            json!(false),
            None,
            None,
            None,
        ),
        // 互动/进场消息共用弹幕区一处固定槽位（仿官方网页直播间，默认开）。
        // 它同时就是「看不看互动消息」的总开关：开时互动消息不进弹幕列表，改在弹幕区底部
        // 浮层显示最新一条、下一条快速顶掉上一条，空闲片刻自动淡出，弹幕区底部为它留一段
        // 预留高度；关时互动消息**完全不显示**（列表与浮层都不画，预留高度一并收回）。
        // 纯派生、不改缓冲（docs/ui.md §4.8）。
        //
        // 旧的 `ui.interact_auto_hide`（显示一会儿自动淡出）已整条删除：单槽位这枚键
        // 已经把「看不看互动」这件事说完，再留一枚叠加的开关只会让用户不知道该拨哪一枚。
        spec(
            "ui.interact_single_slot",
            Ty::Bool,
            json!(true),
            None,
            None,
            None,
        ),
        // 弹幕聚合：同一条弹幕被不同观众在窗口内重复发送时折成一行（规则与常量见契约 §4）。
        // **默认 `true`**：聚合**本来就是现有行为**，这枚键只是把它变成可关的开关 ——
        // 关掉 = 逐条照原样显示。与 `ui.gift_collapse_cheap` 那两枚的取舍正好相反
        // （它们默认 `false`，因为会改变现有效果）；这里改默认值就会改变所有人眼下的画面。
        spec(
            "ui.danmaku_aggregate",
            Ty::Bool,
            json!(true),
            None,
            None,
            None,
        ),
        // 弹幕时间戳列（需求 §2.1 / 契约 §8）。**曾漏登记在白名单里**：界面、契约、
        // 文档三处都写了它，但 SPECS 没有 → `set_patch` 命中未知键分支返回
        // `BAD_REQUEST`，开关存不下去也读不回来（用户 2026-09-12 核 issue #6 时发现）。
        spec(
            "ui.show_timestamp",
            Ty::Bool,
            json!(false),
            None,
            None,
            None,
        ),
        // 自定义短语（需求 §2.2）；短语面板里唯一的内容来源（内置颜文字已删，见 issue #19）。
        spec("composer.phrases", Ty::StrArr, json!([]), None, None, None),
        spec("filter.uids", Ty::IntArr, json!([]), None, None, None),
        // 要不要看系统类消息（开播 / 下播 / 标题变更 / 公告）由这里的 `system` 项决定，
        // 没有单独的开关键：原先的 `ui.system_notice` 与「消息类型 → 系统」盖的消息集合
        // 逐字相同，已按用户裁决删除（issue 2609140651 #1，迁移见 [`LEGACY_SYSTEM_NOTICE`]）。
        spec(
            "filter.kinds",
            Ty::KindArr,
            json!(DEFAULT_KINDS),
            None,
            None,
            None,
        ),
        spec(
            "filter.medal_level_min",
            Ty::Int,
            json!(0),
            Some(0.0),
            Some(60.0),
            None,
        ),
        // 会话缓冲各档上限（issue 2609171849 第 3 条，契约 §4.3 / §8）。
        //
        // **按 kind 分档**：单一上限时代所有消息挤一条队列，一个热闹房间的进场消息能把弹幕
        // 整段顶出去。现在每档各按自己的上限丢最旧，互不挤占；礼物那一档内部再按金额分三档
        // （三档之比见 `session.rs` 的 `GIFT_TIER_SHARE`），价值越高留得越多。
        //
        // 互动与系统两档**刻意小得多**（300 / 200）：互动是「一次性、看过即弃」的消息
        // （默认只由弹幕区底部那处单槽位浮层呈现最新一条，`ui.interact_single_slot`），
        // 系统事件（开播 / 下播 / 标题变更 / 公告）一天也没几条 —— 两者都不需要深度回滚，
        // 而弹幕需要。
        //
        // 取值范围与旧键一致（100–100000）：六枚同域，文档里一行讲得清。
        spec(
            "history.buffer_rows_danmaku",
            Ty::Int,
            json!(5000),
            Some(100.0),
            Some(100_000.0),
            None,
        ),
        spec(
            "history.buffer_rows_gift",
            Ty::Int,
            json!(2000),
            Some(100.0),
            Some(100_000.0),
            None,
        ),
        spec(
            "history.buffer_rows_superchat",
            Ty::Int,
            json!(500),
            Some(100.0),
            Some(100_000.0),
            None,
        ),
        spec(
            "history.buffer_rows_guard",
            Ty::Int,
            json!(200),
            Some(100.0),
            Some(100_000.0),
            None,
        ),
        spec(
            "history.buffer_rows_interact",
            Ty::Int,
            json!(300),
            Some(100.0),
            Some(100_000.0),
            None,
        ),
        spec(
            "history.buffer_rows_system",
            Ty::Int,
            json!(200),
            Some(100.0),
            Some(100_000.0),
            None,
        ),
        // 关注列表的「最近观看」记号（用户 2026-09-12：#16 按最近观看降序）。
        // 键 = 房间号（十进制字符串），值 = 打开该房间的时刻（UTC 毫秒）。
        // 由界面在**打开房间**时写，人不会手动改它——但界面状态一律只落 prefs.json，
        // 不进 config.toml（config 只放凭据，见契约 §4.1）。
        spec("ui.recent_watched", Ty::IntMap, json!({}), None, None, None),
    ]
});

fn find_spec(key: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.key == key)
}

fn within(spec: &Spec, value: f64) -> bool {
    spec.min.is_none_or(|min| value >= min) && spec.max.is_none_or(|max| value <= max)
}

fn validate(spec: &Spec, value: &Value) -> Result<()> {
    let ok = match spec.ty {
        Ty::Num => value.as_f64().is_some_and(|v| within(spec, v)),
        Ty::Int => value.as_i64().is_some_and(|v| within(spec, v as f64)),
        Ty::Bool => value.is_boolean(),
        Ty::Str => value
            .as_str()
            .is_some_and(|s| spec.allowed.is_none_or(|a| a.contains(&s))),
        Ty::StrArr => value
            .as_array()
            .is_some_and(|a| a.iter().all(|v| v.is_string())),
        Ty::IntArr => value
            .as_array()
            .is_some_and(|a| a.iter().all(|v| v.is_i64())),
        Ty::KindArr => value.as_array().is_some_and(|a| {
            a.iter()
                .all(|v| v.as_str().is_some_and(|s| KINDS.contains(&s)))
        }),
        // 键必须是十进制房间号（不许出现 `room:123` 这类键，免得同一份数据两种写法），
        // 值是毫秒时间戳。空对象合法——「一次都没看过」就是这个样子。
        Ty::IntMap => value.as_object().is_some_and(|map| {
            map.keys()
                .all(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
                && map.values().all(Value::is_i64)
        }),
    };

    if ok {
        Ok(())
    } else {
        Err(Error::BadRequest(format!(
            "invalid value for preference `{}`",
            spec.key
        )))
    }
}

/// 偏好集合。内部只保存用户显式改过的键。
#[derive(Debug, Clone, Default)]
pub struct Prefs {
    overrides: BTreeMap<String, Value>,
}

impl Prefs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn keys() -> Vec<&'static str> {
        SPECS.iter().map(|s| s.key).collect()
    }

    /// 全部键的生效值（默认值已合并），键顺序与契约 §8 一致。
    pub fn effective(&self) -> Value {
        let mut map = Map::new();
        for spec in SPECS.iter() {
            let value = self
                .overrides
                .get(spec.key)
                .cloned()
                .unwrap_or_else(|| spec.default.clone());
            map.insert(spec.key.to_string(), value);
        }
        Value::Object(map)
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        let spec = find_spec(key)?;
        Some(
            self.overrides
                .get(key)
                .cloned()
                .unwrap_or_else(|| spec.default.clone()),
        )
    }

    /// 只保存显式改过的键。
    pub fn overrides(&self) -> &BTreeMap<String, Value> {
        &self.overrides
    }

    /// 应用部分补丁；未知键或非法值报 `BAD_REQUEST`，且不产生任何写入。
    pub fn set_patch(&mut self, patch: &Value) -> Result<()> {
        let obj = patch
            .as_object()
            .ok_or_else(|| Error::BadRequest("prefs patch must be an object".into()))?;

        let mut staged = Vec::with_capacity(obj.len());
        for (key, value) in obj {
            let spec = find_spec(key)
                .ok_or_else(|| Error::BadRequest(format!("unknown preference `{key}`")))?;
            validate(spec, value)?;
            staged.push((key.clone(), value.clone()));
        }
        for (key, value) in staged {
            self.overrides.insert(key, value);
        }
        Ok(())
    }

    /// 会话缓冲各档上限（契约 §8 的六枚 `history.buffer_rows_*`）。
    ///
    /// 只在**建立会话时**读一次：改动对下一次 `rooms_connect` 生效，当前会话的容量不变
    /// （与旧键 `history.buffer_rows` 的口径一致，见 `docs/architecture.md` §4.2）。
    pub fn buffer_caps(&self) -> BufferCaps {
        let cap = |key: &str, fallback: usize| {
            self.get(key)
                .and_then(|value| value.as_u64())
                .map(|value| value as usize)
                .unwrap_or(fallback)
        };
        let default = BufferCaps::default();
        BufferCaps {
            danmaku: cap("history.buffer_rows_danmaku", default.danmaku),
            gift: cap("history.buffer_rows_gift", default.gift),
            superchat: cap("history.buffer_rows_superchat", default.superchat),
            guard: cap("history.buffer_rows_guard", default.guard),
            interact: cap("history.buffer_rows_interact", default.interact),
            system: cap("history.buffer_rows_system", default.system),
        }
    }

    /// 读取 `prefs.json`。文件缺失或损坏都回落到默认值；
    /// 损坏时保留一份 `prefs.json.bak`。文件中的未知键被忽略（向前兼容）。
    pub fn load(path: &Path) -> Self {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(_) => return Self::new(),
        };

        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "prefs.json 解析失败，回落到默认值");
                let backup = path.with_extension("json.bak");
                let _ = std::fs::rename(path, &backup);
                return Self::new();
            }
        };

        let mut prefs = Self::new();
        let mut unknown: Vec<&str> = Vec::new();
        if let Some(obj) = parsed.as_object() {
            for (key, value) in obj {
                if LEGACY_KEYS.contains(&key.as_str()) {
                    continue; // 已删除的旧键，交给各自的迁移函数物化
                }
                match find_spec(key) {
                    Some(spec) if validate(spec, value).is_ok() => {
                        prefs.overrides.insert(key.clone(), value.clone());
                    }
                    // 未知键与非法值都只忽略：文件是应用自己写的，最常见的成因是
                    // **删掉某个偏好键之后留下的旧值**（`filter.keywords*`、`ui.merge_similar`
                    // 都是这么来的），不是用户能处置的事，所以只留一条聚合 debug。
                    // 补丁路径（`set_patch`）对未知键仍返回 `BAD_REQUEST` —— 那里的未知键是
                    // 代码写错，必须炸出来。下次落盘时 `save` 只写白名单内的键，文件即自愈。
                    _ => unknown.push(key.as_str()),
                }
            }
            migrate_legacy_system_notice(&mut prefs, obj);
            migrate_legacy_gift_panel_mode(&mut prefs, obj);
            migrate_legacy_buffer_rows(&mut prefs, obj);
        }
        if !unknown.is_empty() {
            tracing::debug!(keys = ?unknown, "忽略文件里未知或非法的偏好键（下次落盘即清理）");
        }
        prefs
    }

    /// 原子写入：临时文件 + rename（`docs/contract.md` §4.2）。
    ///
    /// 只写**白名单内的键**（`overrides` 里的每一项都过了 `find_spec` + `validate`），
    /// 因此文件里残留的未知键会在这次落盘时被清掉 —— `load` 忽略它们，`save` 顺手清掉，
    /// 不必再单独做一次迁移。
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Internal(format!("create prefs dir: {e}")))?;
        }
        let body = serde_json::to_vec_pretty(&Value::Object(
            self.overrides
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ))
        .map_err(|e| Error::Internal(format!("serialize prefs: {e}")))?;

        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &body).map_err(|e| Error::Internal(format!("write prefs: {e}")))?;
        std::fs::rename(&tmp, path).map_err(|e| Error::Internal(format!("replace prefs: {e}")))?;
        Ok(())
    }
}

/// 把历史键 `ui.system_notice` 的值物化进 `filter.kinds`（见 [`LEGACY_SYSTEM_NOTICE`]）。
///
/// 只在文件里真的写了布尔值时才动手；非布尔值（被手写坏了）按未知键忽略，不动白名单。
/// 结果**显式**写进 `overrides`（哪怕与默认值相同）：这样「用户当初把系统通知关掉」
/// 这件事在文件里有一份读得出来的落点，而不是靠默认值巧合对上。
fn migrate_legacy_system_notice(prefs: &mut Prefs, file: &Map<String, Value>) {
    let Some(Value::Bool(show_system)) = file.get(LEGACY_SYSTEM_NOTICE) else {
        return;
    };

    // 以「生效值」为底：文件里的 `filter.kinds` 合法就用它，否则回落默认值。
    let mut kinds: Vec<String> = prefs
        .get("filter.kinds")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();

    if *show_system {
        if !kinds.iter().any(|kind| kind == "system") {
            kinds.push("system".to_string());
        }
    } else {
        kinds.retain(|kind| kind != "system");
    }

    tracing::info!(
        show_system,
        "偏好键 ui.system_notice 已删除，按它的值物化进 filter.kinds"
    );
    prefs
        .overrides
        .insert("filter.kinds".to_string(), json!(kinds));
}

/// 把历史键 `ui.gift_panel_mode` 的值物化进两枚新布尔键（见 [`LEGACY_GIFT_PANEL_MODE`]）。
///
/// 两枚新键**各自**判断文件里有没有显式生效值：写了就以文件为准，没写才补旧键的迁移结果——
/// 迁移补的是「用户表达过、但用的是旧形态」的那部分，不该覆盖用户在新形态上的取值。
/// 值不是 `merged` | `separate`（被手写坏了）时按非法值忽略，两枚新键都不动。
fn migrate_legacy_gift_panel_mode(prefs: &mut Prefs, file: &Map<String, Value>) {
    let Some(Value::String(mode)) = file.get(LEGACY_GIFT_PANEL_MODE) else {
        return;
    };
    // `separate` = 礼物只进独立栏（弹幕流里不含）；`merged` = 礼物只在弹幕流里（没有独立栏）。
    let (in_danmaku, panel) = match mode.as_str() {
        "separate" => (false, true),
        "merged" => (true, false),
        other => {
            tracing::debug!(mode = other, "偏好键 ui.gift_panel_mode 取值不认识，忽略");
            return;
        }
    };

    tracing::info!(
        mode = %mode,
        "偏好键 ui.gift_panel_mode 已删除，按它的值物化进 ui.gift_in_danmaku / ui.gift_panel"
    );
    for (key, value) in [("ui.gift_in_danmaku", in_danmaku), ("ui.gift_panel", panel)] {
        if !prefs.overrides.contains_key(key) {
            prefs.overrides.insert(key.to_string(), json!(value));
        }
    }
}

/// 把历史键 `history.buffer_rows` 的值物化进弹幕档（见 [`LEGACY_BUFFER_ROWS`]）。
///
/// 只在文件里真的写了**合法**整数时才动手：取值域直接问 SPECS 要（新旧两键同域），
/// 免得把 100 / 100000 在两处各写一遍；文件里被手写坏的值按未知键忽略、不动新形态。
/// 文件里已经显式写出 `history.buffer_rows_danmaku` 的以文件为准 —— 迁移只补新形态没说的那部分
/// （与另两条迁移同一口径）。
fn migrate_legacy_buffer_rows(prefs: &mut Prefs, file: &Map<String, Value>) {
    const KEY: &str = "history.buffer_rows_danmaku";
    let Some(rows) = file.get(LEGACY_BUFFER_ROWS).and_then(Value::as_i64) else {
        return;
    };
    if prefs.overrides.contains_key(KEY) {
        return;
    }
    let value = json!(rows);
    match find_spec(KEY) {
        Some(spec) if validate(spec, &value).is_ok() => {}
        _ => {
            tracing::debug!(
                rows,
                "偏好键 history.buffer_rows 的取值超出 {KEY} 的取值域，忽略"
            );
            return;
        }
    }

    tracing::info!(
        rows,
        "偏好键 history.buffer_rows 已删除，按它的值物化进 {KEY}"
    );
    prefs.overrides.insert(KEY.to_string(), value);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 代码里**已经删掉、契约 §8 那张表还没同步删掉**的键。
    ///
    /// 一致性校验是双向的（契约里有而 SPECS 没有 = 界面那枚开关形同虚设；SPECS 里有而
    /// 契约没有 = 凭空多一枚键），删键这一趟两者必然错位一拍：本批 `docs/**` 由主线单独
    /// 同步。这里给一拍宽限 —— 契约删掉那一行后，把这个常量连同下面那处过滤一起删掉即可
    /// （留着也不会误放行：它只是让「已删的键」不参与比对）。
    const PENDING_CONTRACT_REMOVAL: &[&str] = &["ui.interact_auto_hide"];

    /// SPECS 必须与**契约 §8 的表**逐键一致——这里真的去读契约，不是数个数。
    ///
    /// 2026-09-12（issue #6）的教训：`ui.show_timestamp` 在界面、契约、文档、
    /// CHANGELOG 四处都有，却漏在 SPECS 白名单里，于是 `set_patch` 命中未知键
    /// 分支返回 `BAD_REQUEST`：开关存不下去也读不回来，形同虚设（而冒烟用假
    /// IPC 返回完整 prefs，照样全绿）。当时这条测试只断言 `SPECS.len() == 17`，
    /// 数量对得上就放行了——数个数挡不住「键漏了但数量没变」。
    #[test]
    fn spec_table_matches_contract_keys() {
        let contract = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/contract.md"
        ))
        .expect("读得到 docs/contract.md");

        let mut documented: Vec<String> = Vec::new();
        let mut in_section_8 = false;
        for line in contract.lines() {
            if line.starts_with("## ") {
                in_section_8 = line.starts_with("## 8.");
                continue;
            }
            if !in_section_8 {
                continue;
            }
            // 表格行形如：| `ui.theme` | string | `"system"` | 说明 |
            let Some(rest) = line.strip_prefix("| `") else {
                continue;
            };
            if let Some((key, _)) = rest.split_once('`') {
                // 已从代码删掉、契约待同步的那几枚不参与比对（见 `PENDING_CONTRACT_REMOVAL`）。
                if PENDING_CONTRACT_REMOVAL.contains(&key) {
                    continue;
                }
                documented.push(key.to_string());
            }
        }

        let specs = Prefs::keys();
        for key in &documented {
            assert!(
                specs.contains(&key.as_str()),
                "契约 §8 的 `{key}` 不在 SPECS 白名单里：界面用它存偏好会被 \
                 `set_patch` 当未知键拒绝（BAD_REQUEST），开关/设置形同虚设"
            );
        }
        for key in &specs {
            assert!(
                documented.iter().any(|k| k == key),
                "SPECS 里的 `{key}` 没写进契约 §8"
            );
        }
        let effective = Prefs::new().effective();
        assert_eq!(
            effective.as_object().unwrap().len(),
            documented.len(),
            "生效值的键数应与契约 §8 一致"
        );
    }

    #[test]
    fn defaults_are_the_documented_ones() {
        let prefs = Prefs::new();
        assert_eq!(prefs.get("ui.theme").unwrap(), json!("system"));
        assert_eq!(prefs.get("ui.gift_in_danmaku").unwrap(), json!(true));
        assert_eq!(prefs.get("ui.gift_panel").unwrap(), json!(true));
        assert_eq!(
            prefs.get("ui.gift_pane_on_top").unwrap(),
            json!(false),
            "默认礼物在下、弹幕在上（与改前一致，契约 §8）"
        );
        assert_eq!(prefs.get("ui.gift_pane_ratio").unwrap(), json!(0.35));
        assert_eq!(
            prefs.get("ui.gift_collapse_cheap").unwrap(),
            json!(false),
            "低价礼物折叠默认关：默认形态必须与改前一致（契约 §8）"
        );
        assert_eq!(
            prefs.get("ui.gift_exclude_cheap_stats").unwrap(),
            json!(false),
            "低价礼物剔除统计默认关：默认形态必须与改前一致（契约 §8）"
        );
        assert_eq!(
            prefs.get("ui.interact_single_slot").unwrap(),
            json!(true),
            "单槽位默认开：互动消息由弹幕区底部浮层呈现（契约 §8）"
        );
        assert_eq!(
            prefs.get("ui.danmaku_aggregate").unwrap(),
            json!(true),
            "聚合默认开 = 保留现有行为（契约 §8）"
        );
        // 会话缓冲的六枚键：默认值以 `BufferCaps::default()` 为准（`buffer_caps_are_the_six_keys`
        // 把两者钉在一起），这里只确认它们真的在 SPECS 里、读得出来。
        assert_eq!(
            prefs.buffer_caps(),
            BufferCaps::default(),
            "六枚键的默认值必须与 BufferCaps::default() 逐项一致"
        );
        assert_eq!(
            prefs.get("history.buffer_rows_danmaku").unwrap(),
            json!(5000)
        );
        assert_eq!(
            prefs.get("history.buffer_rows_interact").unwrap(),
            json!(300)
        );
        assert_eq!(
            prefs.get("history.buffer_rows_system").unwrap(),
            json!(200),
            "系统档默认明显小于弹幕档（issue 2609171849 第 3 条）"
        );
        assert_eq!(
            prefs.get("filter.kinds").unwrap(),
            json!(DEFAULT_KINDS),
            "默认白名单不含 system（系统通知默认不显示，需求 §2.4）"
        );
    }

    /// 默认集合与校验集合的关系：默认是「六种去掉 `system`」，勾回来的路必须还在。
    #[test]
    fn default_kinds_are_the_six_minus_system() {
        let expected: Vec<&str> = KINDS
            .iter()
            .copied()
            .filter(|kind| *kind != "system")
            .collect();
        assert_eq!(
            DEFAULT_KINDS.to_vec(),
            expected,
            "默认白名单照 KINDS 的顺序去掉 system"
        );

        let mut prefs = Prefs::new();
        prefs
            .set_patch(&json!({ "filter.kinds": KINDS }))
            .expect("用户把「系统」勾回来必须存得下去");
        assert!(prefs
            .get("filter.kinds")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .any(|kind| kind == "system"));
    }

    #[test]
    fn partial_patch_merges_and_leaves_others_untouched() {
        let mut prefs = Prefs::new();
        prefs.set_patch(&json!({ "ui.theme": "dark" })).unwrap();
        let effective = prefs.effective();
        assert_eq!(effective["ui.theme"], json!("dark"));
        assert_eq!(effective["ui.font_scale"], json!(1.0));
        assert_eq!(prefs.overrides().len(), 1, "只应保存显式改过的键");
    }

    #[test]
    fn unknown_key_and_bad_value_are_rejected_atomically() {
        let mut prefs = Prefs::new();
        let err = prefs
            .set_patch(&json!({ "ui.theme": "dark", "ui.fontsize": 1.4 }))
            .unwrap_err();
        assert_eq!(err.code(), "BAD_REQUEST");
        assert!(prefs.overrides().is_empty(), "整个补丁必须一起失败");

        for bad in [
            json!({ "ui.font_scale": 3.0 }),
            json!({ "ui.theme": "neon" }),
            json!({ "ui.auto_scroll": "yes" }),
            json!({ "ui.interact_single_slot": 1 }),
            // 共享分区的两枚键（契约 §8）：顺序只能是布尔、份额只能是 0.10–0.90 的数
            json!({ "ui.gift_pane_on_top": "yes" }),
            json!({ "ui.gift_pane_on_top": 1 }),
            json!({ "ui.gift_pane_ratio": "0.35" }),
            json!({ "ui.gift_pane_ratio": 0.0 }),
            json!({ "ui.gift_pane_ratio": 1.0 }),
            json!({ "ui.gift_pane_ratio": 1.5 }),
            json!({ "filter.kinds": ["danmaku", "notice"] }),
            json!({ "filter.uids": [1, "2"] }),
            // 会话缓冲六枚键：取值域仍是 100–100000（与旧键同域）
            json!({ "history.buffer_rows_danmaku": 99 }),
            json!({ "history.buffer_rows_danmaku": 100_001 }),
            json!({ "history.buffer_rows_interact": "300" }),
            // 旧的单一键已删除：按未知键拒绝（`deleted_pref_key_is_not_writable` 再钉一次）
            json!({ "history.buffer_rows": 5000 }),
            // 「最近观看」必须是「房间号 → 时刻」的映射：数组、字符串键、非整数时刻都不收
            json!({ "ui.recent_watched": [1, 2] }),
            json!({ "ui.recent_watched": { "room:7": 1 } }),
            json!({ "ui.recent_watched": { "7": 1.5 } }),
        ] {
            let mut p = Prefs::new();
            assert_eq!(
                p.set_patch(&bad).unwrap_err().code(),
                "BAD_REQUEST",
                "应拒绝 {bad}"
            );
        }
    }

    /// 共享分区的两枚键（issue #8）：份额的两端**闭区间**收，越界写不进去；
    /// 文件里被手写坏的值按非法值忽略、回落到默认（契约 §4.2：只忽略、不炸）。
    #[test]
    fn split_pane_prefs_bounds_and_file_fallback() {
        for ok in [0.10, 0.35, 0.90] {
            let mut prefs = Prefs::new();
            prefs
                .set_patch(&json!({ "ui.gift_pane_ratio": ok }))
                .unwrap_or_else(|e| panic!("0.35 档里 {ok} 应被接受：{e}"));
            assert_eq!(prefs.get("ui.gift_pane_ratio").unwrap(), json!(ok));
        }

        let mut prefs = Prefs::new();
        prefs
            .set_patch(&json!({
                "ui.gift_pane_on_top": true,
                "ui.gift_pane_ratio": 0.5,
            }))
            .unwrap();
        let effective = prefs.effective();
        assert_eq!(effective["ui.gift_pane_on_top"], json!(true));
        assert_eq!(effective["ui.gift_pane_ratio"], json!(0.5));

        let loaded = load_temp(
            "pane-bad",
            r#"{"ui.gift_pane_on_top":true,"ui.gift_pane_ratio":2.5}"#,
        );
        assert_eq!(
            loaded.get("ui.gift_pane_on_top").unwrap(),
            json!(true),
            "合法的那一枚照常生效"
        );
        assert_eq!(
            loaded.get("ui.gift_pane_ratio").unwrap(),
            json!(0.35),
            "越界的份额回落默认值"
        );
        assert!(
            loaded.overrides().get("ui.gift_pane_ratio").is_none(),
            "非法值不该进 overrides（下次落盘即清掉）"
        );
    }

    #[test]
    fn recent_watched_holds_room_stamps() {
        let mut prefs = Prefs::new();
        assert_eq!(
            prefs.get("ui.recent_watched").unwrap(),
            json!({}),
            "默认「一次都没看过」"
        );

        prefs
            .set_patch(&json!({ "ui.recent_watched": { "5440": 1_789_900_000_000i64 } }))
            .unwrap();
        let effective = prefs.effective();
        assert_eq!(
            effective["ui.recent_watched"]["5440"],
            json!(1_789_900_000_000i64),
            "读回来的仍是那个毫秒时刻"
        );
    }

    #[test]
    fn roundtrip_persists_only_overrides() {
        let dir = std::env::temp_dir().join(format!("danmubox-prefs-{}", std::process::id()));
        let path = dir.join("prefs.json");
        let mut prefs = Prefs::new();
        // 两枚低价礼物开关写进这一趟落盘 / 读回：它们的白名单与默认值由 `spec_table_matches_contract_keys`
        // 与 `defaults_are_the_documented_ones` 把住，这里补的是「改过的值真的落进 prefs.json 并读得回来」
        // —— 契约 §8 两枚键的默认都是 `false`，所以「读回来是 true」正是用户勾过的那件事。
        prefs
            .set_patch(&json!({
                "ui.font_scale": 1.14,
                "filter.uids": [7],
                "ui.gift_collapse_cheap": true,
                "ui.gift_exclude_cheap_stats": true,
            }))
            .unwrap();
        prefs.save(&path).unwrap();

        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw.as_object().unwrap().len(), 4);

        let loaded = Prefs::load(&path);
        assert_eq!(loaded.get("ui.font_scale").unwrap(), json!(1.14));
        assert_eq!(loaded.get("ui.theme").unwrap(), json!("system"));
        assert_eq!(
            loaded.get("ui.gift_collapse_cheap").unwrap(),
            json!(true),
            "折叠低价礼物勾上之后要读得回来（契约 §8）"
        );
        assert_eq!(
            loaded.get("ui.gift_exclude_cheap_stats").unwrap(),
            json!(true),
            "剔除低价礼物统计勾上之后要读得回来（契约 §8）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_falls_back_and_keeps_backup() {
        let dir = std::env::temp_dir().join(format!("danmubox-prefs-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prefs.json");
        std::fs::write(&path, b"{ not json").unwrap();

        let loaded = Prefs::load(&path);
        assert_eq!(loaded.get("ui.theme").unwrap(), json!("system"));
        assert!(!path.exists(), "损坏文件应被移走");
        assert!(path.with_extension("json.bak").exists(), "应保留 .bak");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_keys_in_file_are_ignored() {
        let dir = std::env::temp_dir().join(format!("danmubox-prefs-unk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prefs.json");
        std::fs::write(&path, br#"{"ui.theme":"dark","ui.nope":1}"#).unwrap();

        let loaded = Prefs::load(&path);
        assert_eq!(loaded.get("ui.theme").unwrap(), json!("dark"));
        assert_eq!(loaded.overrides().len(), 1);

        // 落盘即自愈：`save` 只写白名单内的键，所以「删掉某个偏好键之后残留的旧值」
        // 会在下一次写入时被清掉（P75），不需要另做一次迁移。
        loaded.save(&path).unwrap();
        let rewritten: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(rewritten.get("ui.nope").is_none(), "未知键应在落盘时被清掉");
        assert_eq!(rewritten.get("ui.theme").unwrap(), &json!("dark"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写一份临时的 `prefs.json` 再读回来，专门验 `load` 的迁移口径。
    fn load_temp(tag: &str, body: &str) -> Prefs {
        let dir = std::env::temp_dir().join(format!("danmubox-prefs-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("prefs.json");
        std::fs::write(&path, body).unwrap();

        let loaded = Prefs::load(&path);
        let _ = std::fs::remove_dir_all(&dir);
        loaded
    }

    /// 存量 `ui.system_notice` 的迁移（issue 2609140651 #1）：按它的值物化进 `filter.kinds`，
    /// 旧键本身不再留在 `overrides` 里（下次落盘即消失）。
    #[test]
    fn legacy_system_notice_migrates_into_filter_kinds() {
        let off = load_temp("mig-off", r#"{"ui.system_notice":false}"#);
        assert_eq!(off.get("filter.kinds").unwrap(), json!(DEFAULT_KINDS));
        assert!(
            off.overrides().get(LEGACY_SYSTEM_NOTICE).is_none(),
            "旧键不得留在 overrides 里"
        );

        let on = load_temp("mig-on", r#"{"ui.system_notice":true}"#);
        assert_eq!(on.get("filter.kinds").unwrap(), json!(KINDS));

        // 文件里本来就有 filter.kinds：以它为准增删，不动顺序里的其它项。
        let merged = load_temp(
            "mig-merged",
            r#"{"ui.system_notice":true,"filter.kinds":["danmaku","gift"]}"#,
        );
        assert_eq!(
            merged.get("filter.kinds").unwrap(),
            json!(["danmaku", "gift", "system"])
        );

        let pruned = load_temp(
            "mig-pruned",
            r#"{"ui.system_notice":false,"filter.kinds":["danmaku","system","guard"]}"#,
        );
        assert_eq!(
            pruned.get("filter.kinds").unwrap(),
            json!(["danmaku", "guard"])
        );

        // 非布尔值按非法值忽略：既不迁移，也不把旧键写进 overrides。
        let junk = load_temp("mig-junk", r#"{"ui.system_notice":"on"}"#);
        assert_eq!(junk.get("filter.kinds").unwrap(), json!(DEFAULT_KINDS));
        assert!(junk.overrides().is_empty());
    }

    /// 没有旧键就不动 `filter.kinds`——默认值本身就是「不含 system」。
    #[test]
    fn absent_legacy_key_leaves_filter_kinds_alone() {
        let loaded = load_temp("mig-absent", r#"{"ui.theme":"dark"}"#);
        assert_eq!(loaded.get("filter.kinds").unwrap(), json!(DEFAULT_KINDS));
        assert!(
            loaded.overrides().get("filter.kinds").is_none(),
            "没写过就不该凭空多出一条 overrides"
        );
    }

    /// 存量 `ui.gift_panel_mode` 的迁移（issue 2609152029 #4）：`separate` / `merged` 各自
    /// 物化成两枚新布尔键的一对取值，旧键本身不再留在 `overrides` 里。
    #[test]
    fn legacy_gift_panel_mode_migrates_into_two_booleans() {
        let separate = load_temp("mig-sep", r#"{"ui.gift_panel_mode":"separate"}"#);
        assert_eq!(separate.get("ui.gift_in_danmaku").unwrap(), json!(false));
        assert_eq!(separate.get("ui.gift_panel").unwrap(), json!(true));
        assert!(
            separate.overrides().get(LEGACY_GIFT_PANEL_MODE).is_none(),
            "旧键不得留在 overrides 里（下次落盘即消失）"
        );

        let merged = load_temp("mig-mrg", r#"{"ui.gift_panel_mode":"merged"}"#);
        assert_eq!(merged.get("ui.gift_in_danmaku").unwrap(), json!(true));
        assert_eq!(merged.get("ui.gift_panel").unwrap(), json!(false));

        // 文件里已显式写出新键的那一枚以文件为准，迁移只补另一枚。
        let half = load_temp(
            "mig-half",
            r#"{"ui.gift_panel_mode":"separate","ui.gift_in_danmaku":true}"#,
        );
        assert_eq!(half.get("ui.gift_in_danmaku").unwrap(), json!(true));
        assert_eq!(half.get("ui.gift_panel").unwrap(), json!(true));

        // 取值不认识 / 类型不对：按非法值忽略，两枚新键都回落默认值。
        for junk in [
            r#"{"ui.gift_panel_mode":"both"}"#,
            r#"{"ui.gift_panel_mode":true}"#,
        ] {
            let loaded = load_temp("mig-junk-gift", junk);
            assert_eq!(loaded.get("ui.gift_in_danmaku").unwrap(), json!(true));
            assert_eq!(loaded.get("ui.gift_panel").unwrap(), json!(true));
            assert!(loaded.overrides().is_empty(), "坏值不该写进 overrides");
        }

        // 没有旧键就不凭空多出两枚 overrides（默认值本身就是 true / true）。
        let absent = load_temp("mig-absent-gift", r#"{"ui.theme":"dark"}"#);
        assert!(absent.overrides().get("ui.gift_in_danmaku").is_none());
        assert!(absent.overrides().get("ui.gift_panel").is_none());
    }

    /// 删掉的键不能再被写入：`set_patch` 必须按未知键拒绝（开关已并进 `filter.kinds`）。
    #[test]
    fn deleted_pref_key_is_not_writable() {
        let mut prefs = Prefs::new();
        for (key, value) in [
            ("ui.system_notice", json!(false)),
            // 礼物栏旧键同理：两枚新键才是唯一入口（issue 2609152029 #4）。
            ("ui.gift_panel_mode", json!("separate")),
            // 单一缓冲上限同理：六枚 `history.buffer_rows_*` 才是唯一入口（issue 2609171849 #3）。
            ("history.buffer_rows", json!(5000)),
        ] {
            // 键是变量：`json!` 会把它当成字面 ident，这里显式拼 `Map`（否则测的是 `"key"`）。
            let mut patch = Map::new();
            patch.insert(key.to_string(), value);
            assert_eq!(
                prefs.set_patch(&Value::Object(patch)).unwrap_err().code(),
                "BAD_REQUEST",
                "`{key}` 已删除，必须按未知键拒绝"
            );
        }
        assert!(prefs.overrides().is_empty());
    }

    /// 存量 `history.buffer_rows` 的迁移（issue 2609171849 #3）：单档上限拆成六档之后，
    /// 旧键的值物化进**弹幕档**（用户当初表达的是「缓冲留多少条」，弹幕是那个缓冲的主流量），
    /// 旧键本身不再留在 `overrides` 里。
    #[test]
    fn legacy_buffer_rows_migrates_into_the_danmaku_cap() {
        let migrated = load_temp("mig-rows", r#"{"history.buffer_rows":8000}"#);
        assert_eq!(
            migrated.get("history.buffer_rows_danmaku").unwrap(),
            json!(8000),
            "用户当初设的 8000 必须落在弹幕档上"
        );
        assert_eq!(
            migrated.buffer_caps(),
            BufferCaps {
                danmaku: 8000,
                ..BufferCaps::default()
            },
            "其余五档走默认值"
        );
        assert!(
            migrated.overrides().get(LEGACY_BUFFER_ROWS).is_none(),
            "旧键不得留在 overrides 里（下次落盘即消失）"
        );

        // 文件里已显式写出新键的以文件为准：迁移不覆盖用户在新形态上的取值。
        let explicit = load_temp(
            "mig-rows-explicit",
            r#"{"history.buffer_rows":8000,"history.buffer_rows_danmaku":2000}"#,
        );
        assert_eq!(
            explicit.get("history.buffer_rows_danmaku").unwrap(),
            json!(2000)
        );

        // 取值超出新键取值域（100–100000）/ 类型不对：按坏值忽略，不留任何 down-level 痕迹。
        for junk in [
            r#"{"history.buffer_rows":5}"#,
            r#"{"history.buffer_rows":99999999}"#,
            r#"{"history.buffer_rows":"8000"}"#,
        ] {
            let loaded = load_temp("mig-rows-junk", junk);
            assert_eq!(loaded.buffer_caps(), BufferCaps::default(), "坏值 → 默认值");
            assert!(loaded.overrides().is_empty(), "坏值不该写进 overrides");
        }

        // 没有旧键就不凭空多出一条 overrides。
        let absent = load_temp("mig-rows-absent", r#"{"ui.theme":"dark"}"#);
        assert!(absent
            .overrides()
            .get("history.buffer_rows_danmaku")
            .is_none());
    }

    /// 六枚档位键的生效值汇总成 `BufferCaps`：只填两枚时其余五枚走默认值；
    /// 六枚各自独立（改一枚不动别的）。
    #[test]
    fn buffer_caps_read_the_six_keys_independently() {
        let mut prefs = Prefs::new();
        prefs
            .set_patch(&json!({
                "history.buffer_rows_danmaku": 9000,
                "history.buffer_rows_system": 100,
            }))
            .unwrap();
        assert_eq!(
            prefs.buffer_caps(),
            BufferCaps {
                danmaku: 9000,
                system: 100,
                ..BufferCaps::default()
            }
        );

        // 读回来的那一份要落进 prefs.json 并在重启后仍然生效（与其余键同一条往返路径）。
        let dir = std::env::temp_dir().join(format!("danmubox-prefs-caps-{}", std::process::id()));
        let path = dir.join("prefs.json");
        prefs.save(&path).unwrap();
        let loaded = Prefs::load(&path);
        assert_eq!(loaded.buffer_caps(), prefs.buffer_caps());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
