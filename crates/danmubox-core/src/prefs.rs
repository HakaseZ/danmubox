//! 界面偏好：`prefs.json`（`docs/contract.md` §4.2、§8）。
//!
//! 只存被显式改过的键；读取时与默认值合并得到「生效值」。
//! 未知键或非法值在写入时一律报 `BAD_REQUEST`。

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use serde_json::{json, Map, Value};

use crate::error::{Error, Result};

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

const KINDS: [&str; 6] = [
    "danmaku",
    "gift",
    "superchat",
    "interact",
    "guard",
    "system",
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
        spec(
            "ui.gift_panel_mode",
            Ty::Str,
            json!("merged"),
            None,
            None,
            Some(&["merged", "separate"]),
        ),
        // 互动/进场消息：默认「显示一会儿就淡出」，关掉则常驻（需求 §2.4）。
        spec(
            "ui.interact_auto_hide",
            Ty::Bool,
            json!(true),
            None,
            None,
            None,
        ),
        // 系统通知（开播 / 下播 / 标题变更 / 公告）：默认不显示（需求 §2.4）。
        spec("ui.system_notice", Ty::Bool, json!(false), None, None, None),
        // 弹幕时间戳列（需求 §2.1 / 契约 §8）。**曾漏登记在白名单里**：界面、契约、
        // 文档三处都写了它，但 SPECS 没有 → `set_patch` 命中未知键分支返回
        // `BAD_REQUEST`，开关存不下去也读不回来（用户 2026-09-12 核 issue #6 时发现）。
        spec("ui.show_timestamp", Ty::Bool, json!(false), None, None, None),
        // 自定义短语（需求 §2.2）；短语面板里唯一的内容来源（内置颜文字已删，见 issue #19）。
        spec("composer.phrases", Ty::StrArr, json!([]), None, None, None),
        spec("filter.uids", Ty::IntArr, json!([]), None, None, None),
        spec("filter.kinds", Ty::KindArr, json!(KINDS), None, None, None),
        spec(
            "filter.medal_level_min",
            Ty::Int,
            json!(0),
            Some(0.0),
            Some(60.0),
            None,
        ),
        spec(
            "history.buffer_rows",
            Ty::Int,
            json!(5000),
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

    pub fn buffer_rows(&self) -> usize {
        self.get("history.buffer_rows")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(5000)
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(prefs.get("ui.gift_panel_mode").unwrap(), json!("merged"));
        assert_eq!(prefs.get("ui.interact_auto_hide").unwrap(), json!(true));
        assert_eq!(prefs.get("ui.system_notice").unwrap(), json!(false));
        assert_eq!(prefs.get("history.buffer_rows").unwrap(), json!(5000));
        assert_eq!(prefs.buffer_rows(), 5000);
        assert_eq!(
            prefs.get("filter.kinds").unwrap().as_array().unwrap().len(),
            6
        );
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
            json!({ "ui.interact_auto_hide": 1 }),
            json!({ "ui.system_notice": "on" }),
            json!({ "filter.kinds": ["danmaku", "notice"] }),
            json!({ "filter.uids": [1, "2"] }),
            json!({ "history.buffer_rows": 5 }),
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
        prefs
            .set_patch(&json!({ "ui.font_scale": 1.14, "filter.uids": [7] }))
            .unwrap();
        prefs.save(&path).unwrap();

        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw.as_object().unwrap().len(), 2);

        let loaded = Prefs::load(&path);
        assert_eq!(loaded.get("ui.font_scale").unwrap(), json!(1.14));
        assert_eq!(loaded.get("ui.theme").unwrap(), json!("system"));

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
}
