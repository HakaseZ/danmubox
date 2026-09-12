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
            "ui.opacity",
            Ty::Num,
            json!(1.0),
            Some(0.3),
            Some(1.0),
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
        spec("ui.merge_similar", Ty::Bool, json!(true), None, None, None),
        spec(
            "ui.merge_window_ms",
            Ty::Int,
            json!(8000),
            Some(0.0),
            Some(600_000.0),
            None,
        ),
        spec(
            "ui.gift_panel_mode",
            Ty::Str,
            json!("merged"),
            None,
            None,
            Some(&["merged", "separate"]),
        ),
        // 自定义短语（需求 §2.2）。颜文字是内置常量，不进偏好。
        spec("composer.phrases", Ty::StrArr, json!([]), None, None, None),
        spec("filter.keywords", Ty::StrArr, json!([]), None, None, None),
        spec(
            "filter.keywords_mode",
            Ty::Str,
            json!("hide"),
            None,
            None,
            Some(&["hide", "only"]),
        ),
        spec(
            "filter.keywords_alert",
            Ty::Bool,
            json!(false),
            None,
            None,
            None,
        ),
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
        if let Some(obj) = parsed.as_object() {
            for (key, value) in obj {
                match find_spec(key) {
                    Some(spec) if validate(spec, value).is_ok() => {
                        prefs.overrides.insert(key.clone(), value.clone());
                    }
                    _ => {
                        tracing::warn!(key, "忽略非法或未知的偏好键");
                    }
                }
            }
        }
        prefs
    }

    /// 原子写入：临时文件 + rename（`docs/contract.md` §4.2）。
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

    #[test]
    fn spec_table_matches_contract_keys() {
        // 数量与契约 §8 的表逐行对应：加/删偏好键必须同时改这里与契约。
        assert_eq!(SPECS.len(), 16, "契约 §8 规定 16 个偏好键");
        let effective = Prefs::new().effective();
        assert_eq!(effective.as_object().unwrap().len(), 16);
    }

    #[test]
    fn defaults_are_the_documented_ones() {
        let prefs = Prefs::new();
        assert_eq!(prefs.get("ui.theme").unwrap(), json!("system"));
        assert_eq!(prefs.get("ui.gift_panel_mode").unwrap(), json!("merged"));
        assert_eq!(prefs.get("filter.keywords_mode").unwrap(), json!("hide"));
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
            json!({ "ui.opacity": 0.1 }),
            json!({ "ui.theme": "neon" }),
            json!({ "ui.auto_scroll": "yes" }),
            json!({ "filter.kinds": ["danmaku", "notice"] }),
            json!({ "filter.uids": [1, "2"] }),
            json!({ "history.buffer_rows": 5 }),
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
    fn roundtrip_persists_only_overrides() {
        let dir = std::env::temp_dir().join(format!("danmubox-prefs-{}", std::process::id()));
        let path = dir.join("prefs.json");
        let mut prefs = Prefs::new();
        prefs
            .set_patch(&json!({ "ui.font_scale": 1.14, "filter.keywords": ["抽奖"] }))
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

        let _ = std::fs::remove_dir_all(&dir);
    }
}
