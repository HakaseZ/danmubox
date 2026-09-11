//! WBI 签名（`docs/auth.md` §4）。
//!
//! 置换表是 B 站协议知识，按契约 §3 只允许出现在本 crate 内，且**只此一处**；
//! 表内容变更属于协议变更，须同步 `docs/auth.md` 与 `CHANGELOG.md`。

/// 64 个下标，指向 `img_key + sub_key` 拼接串，取前 32 个字符组成混入密钥。
/// 该表已于 2026-09-11 通过真实请求确认（见 `docs/auth.md` §4.5）。
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// 由 `img_key` / `sub_key` 推导 32 字符混入密钥。
pub fn mixin_key(img_key: &str, sub_key: &str) -> String {
    let raw: Vec<char> = format!("{img_key}{sub_key}").chars().collect();
    MIXIN_KEY_ENC_TAB
        .iter()
        .take(32)
        .filter_map(|&i| raw.get(i).copied())
        .collect()
}

/// 参数值里必须剔除的字符（上游签名算法约定）。
fn filter_value(value: &str) -> String {
    value.replace(['!', '\'', '(', ')', '*'], "")
}

/// 生成带 `w_rid` 的查询串：值过滤 → 按 key 升序 → 百分号编码 → `md5(query + mixin)`。
///
/// `params` 必须已包含 `wts`；调用方负责把它放进参数再签名。
pub fn signed_query(params: &[(String, String)], mixin: &str) -> String {
    let mut items: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| (k.clone(), filter_value(v)))
        .collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));

    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in &items {
        serializer.append_pair(key, value);
    }
    let query = serializer.finish();

    let digest = md5::compute(format!("{query}{mixin}").as_bytes());
    format!("{query}&w_rid={digest:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixin_key_uses_first_32_permuted_slots() {
        // raw = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+-"
        let raw = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+-";
        let (img, sub) = raw.split_at(32);
        let key = mixin_key(img, sub);
        assert_eq!(key.chars().count(), 32);
        // 前三个下标是 46 / 47 / 18
        let chars: Vec<char> = raw.chars().collect();
        assert_eq!(key.chars().next().unwrap(), chars[46]);
        assert_eq!(key.chars().nth(1).unwrap(), chars[47]);
        assert_eq!(key.chars().nth(2).unwrap(), chars[18]);
    }

    #[test]
    fn mixin_key_is_empty_when_raw_too_short() {
        assert_eq!(mixin_key("ab", ""), "");
    }

    #[test]
    fn signing_filters_values_and_sorts_keys() {
        let params = vec![
            ("id".to_string(), "123".to_string()),
            ("wts".to_string(), "1700000000".to_string()),
            ("type".to_string(), "0".to_string()),
            ("note".to_string(), "a!b'c(d)e*f".to_string()),
        ];
        let query = signed_query(&params, "MIXINKEYMIXINKEYMIXINKEYMIXINKE");
        assert!(query.starts_with("id=123&note=abcdef&type=0&wts=1700000000&w_rid="));
        assert!(query.contains("&w_rid="));
        let rid = query.split("w_rid=").nth(1).unwrap();
        assert_eq!(rid.len(), 32, "w_rid 是 32 位十六进制");
        assert!(rid.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn signature_is_stable_for_the_same_input() {
        let params = vec![
            ("id".to_string(), "6".to_string()),
            ("wts".to_string(), "1700000000".to_string()),
            ("type".to_string(), "0".to_string()),
            ("web_location".to_string(), "444.8".to_string()),
        ];
        let a = signed_query(&params, "KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE");
        let b = signed_query(&params, "KEYKEYKEYKEYKEYKEYKEYKEYKEYKEYKE");
        assert_eq!(a, b);
    }
}
