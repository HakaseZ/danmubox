//! 日志与错误文案的**唯一**脱敏出口：凭据、用户标识、设备标识的规则只在这里写一遍。
//!
//! 为什么必须收敛到一个地方（`AGENT.md` §8 第 1 条、`docs/operations.md` §3）：
//!
//! - 上游把「谁」写在查询串里：`x/relation/followings?vmid=<自己的 uid>`、
//!   `Room/get_status_info_by_uids?uids[]=<关注的每一个人>`、黑名单的 `anchor_id=<主播 uid>`。
//!   这些 URL 会原样进 `debug` 日志，`vmid` 就是本机的 `DedeUserID`。
//! - `reqwest::Error` 的 `Display` 会把**完整 URL** 拼进错误文案（`… for url (…)`），
//!   所以「只记 URL、不记 body」这条老约定挡不住它——脱敏必须发生在文案成形的那一刻。
//!
//! 两处用法各一个出口：URL 日志走 `http::log_request`，错误文案走 `http::upstream`
//! （以及各回显上游 `message` 的地方），它们都只调本模块的 [`redact`]。
//!
//! **为什么是固定占位符而不是短哈希**：uid 的取值空间只有 10 位数，短哈希可以被离线
//! 暴力枚举反推，「看起来脱敏了」但挡不住任何人；而排障真正需要的四件事——哪个接口、
//! 哪个房间、第几页、这一批几个值——都不依赖 uid 本身（`follow.rs` 的翻页与批量取法
//! 都能从剩下的字段看出来）。占位符与凭据共用 `***`，日志只有一种读法。

/// 敏感值被替换成的占位符。
pub(crate) const PLACEHOLDER: &str = "***";

/// 敏感键名：凭据文件的字段、上游下发过的会话令牌，以及用户标识与设备标识。
///
/// 匹配在**小写副本**上做，因此 `SESSDATA=` / `DedeUserID=` / `vmid=` 三种大小写都认；
/// `uids%5b%5d` 是表单编码后的 `uids[]`，URL 日志里就是这个形状（实测日志为
/// `uids%5B%5D=`，大小写不影响匹配）。
const SECRET_KEYS: [&str; 20] = [
    // 凭据与会话令牌
    "dedeuserid__ckmd5",
    "dedeuserid",
    "dede_user_id",
    "sessdata",
    "bili_jct",
    "csrf_token",
    "qrcode_key",
    "csrf",
    // 用户标识：账号自己的 uid（`vmid` 就是 `DedeUserID`）与别人的 uid / 昵称
    "vmid",
    "uids%5b%5d",
    "uids[]",
    "uid",
    "tuid",
    "reply_mid",
    "mid",
    "anchor_id",
    "uname",
    "nickname",
    // 设备标识：与账号凭据同时出现即可被关联（`docs/operations.md` §3）
    "buvid3",
    "buvid4",
];

/// 值的结束符（属于值之外的第一个字符就能收尾）。
fn is_value_end(ch: char) -> bool {
    matches!(
        ch,
        '&' | ';' | ',' | '"' | '\'' | '}' | ')' | '<' | ' ' | '\t' | '\r' | '\n'
    )
}

/// 在**小写副本** `lowered` 里找 `from` 之后最靠前的一个敏感键名 →（位置, 键名）。
///
/// 两条消歧规则，缺一不可：
///
/// - **前缀必须是词边界**（前一个字符不是字母或数字）：`roomid=5440` 里的 `mid`、
///   `guid=` 里的 `uid` 都不算键名。房间号必须留在日志里——它是排障主键（实测踩到过
///   `gethistory?roomid=…` 被 `mid` 误伤）。
/// - 同一位置命中多个键名时取**最长**的那个：`dedeuserid__ckmd5` 把 `dedeuserid` 包在里面，
///   `uids[]` 把 `uid` 包在里面。位置优先于长度，所以 `vmid=` 不会被里面的 `mid=` 抢走。
fn next_secret_key(lowered: &str, from: usize) -> Option<(usize, &'static str)> {
    SECRET_KEYS
        .iter()
        .filter_map(|key| {
            let mut search = from;
            loop {
                let at = lowered[search..].find(key)? + search;
                // 键名都是 ASCII，`at - 1` 与 `at + 1` 一定落在字符边界上。
                let bounded = at == 0 || !lowered.as_bytes()[at - 1].is_ascii_alphanumeric();
                if bounded {
                    return Some((at, *key));
                }
                search = at + 1;
            }
        })
        .min_by_key(|(at, key)| (*at, std::cmp::Reverse(key.len())))
}

/// 把 `key=value` / `"key":"value"` / `key: value` 里的敏感值抹成 `***`，其余文本原样保留。
///
/// 只认「键名 + 分隔符 + 值」三种成分齐全的位置：上游原话 `CSRF 校验失败` 里的键名之后
/// 没有分隔符，不能被改写——错误信息里保留上游原话才有诊断价值。
pub(crate) fn redact(text: &str) -> String {
    let lowered = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut search = 0;
    while let Some((at, key)) = next_secret_key(&lowered, search) {
        let after_key = at + key.len();
        match secret_value(&text[after_key..]) {
            Some((value_at, value_len)) => {
                let value_start = after_key + value_at;
                let value_end = value_start + value_len;
                out.push_str(&text[copied..value_start]);
                out.push_str(PLACEHOLDER);
                copied = value_end;
                search = value_end;
            }
            // 只是键名本身（例如上游原话里出现 `csrf` / URL 里的 `…/by_uids?room_id=`）：
            // 原样保留，从键名之后继续找。
            None => search = after_key,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// 上游回显文案（URL、响应体片段、上游 `message`）成形前的脱敏：`reqwest::Error` 的
/// `Display` 自带完整 URL，所以**任何**把它拼进错误信息的地方都得过这一道。
pub(crate) fn redact_display(text: impl std::fmt::Display) -> String {
    redact(&text.to_string())
}

/// 键名之后若跟着「分隔符 + 值」→ 返回（值起点偏移, 值长度）。
///
/// 分隔符是 `=` / `:` / 引号，允许中间夹空格（`"csrf": "值"`）；值到下一个 `is_value_end`
/// 字符为止。只有键名而没有值 → `None`。
fn secret_value(rest: &str) -> Option<(usize, usize)> {
    let mut delimited = false;
    for (index, ch) in rest.char_indices() {
        match ch {
            '=' | ':' | '"' | '\'' => delimited = true,
            ' ' | '\t' if delimited => {}
            _ => {
                if !delimited || is_value_end(ch) {
                    return None;
                }
                let length = rest[index..]
                    .find(is_value_end)
                    .unwrap_or(rest.len() - index);
                return Some((index, length));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ① 实测泄漏样本的形状：`relation/followings?vmid=<自己>` 与批量状态接口的 `uids[]`
    /// 都不许留下数字。`vmid` 就是本机的 `DedeUserID`（`docs/contract.md` §4.1）。
    #[test]
    fn url_identity_query_values_are_replaced() {
        assert_eq!(
            redact("https://api.bilibili.com/x/relation/followings?vmid=1234567890&ps=50&pn=2"),
            "https://api.bilibili.com/x/relation/followings?vmid=***&ps=50&pn=2"
        );
        // 实测日志里是表单编码后的 `uids%5B%5D=`（大写十六进制），一条 URL 里重复多次。
        assert_eq!(
            redact(
                "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids\
                 ?uids%5B%5D=11&uids%5B%5D=22&uids%5B%5D=33"
            ),
            "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids\
             ?uids%5B%5D=***&uids%5B%5D=***&uids%5B%5D=***"
        );
    }

    /// ② 错误文案里的账号标识：`reqwest::Error` 会把完整 URL 拼进去（` for url (…)`），
    /// 上游回显的 JSON 片段也可能带 `DedeUserID=`。
    #[test]
    fn error_text_with_account_identifier_is_replaced() {
        assert_eq!(
            redact("nav 求证失败: DedeUserID=1234567; SESSDATA=abc&bili_jct=def"),
            "nav 求证失败: DedeUserID=***; SESSDATA=***&bili_jct=***"
        );
        assert_eq!(
            redact_display(format_args!(
                "请求失败: error sending request for url \
                 (https://api.live.bilibili.com/xlive/app-ucenter/v2/xbanned/banned/GetBlackList\
                 ?anchor_id=98765&pn=1&ps=30)"
            )),
            "请求失败: error sending request for url \
             (https://api.live.bilibili.com/xlive/app-ucenter/v2/xbanned/banned/GetBlackList\
             ?anchor_id=***&pn=1&ps=30)"
        );
    }

    /// ③ 不该误伤：接口名、房间号、页码、条数、上游原话都得原样留着——脱敏不得削弱排障性。
    #[test]
    fn endpoints_rooms_pages_and_prose_survive() {
        for text in [
            "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids\
             ?room_id=5440&page=2&page_size=30&ignoreMyself=1",
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser\
             ?room_id=1&from=0&not_mock_enter_effect=0",
            // 实测踩到的误伤：`roomid` 里含 `mid`，房间号必须活下来（它是排障主键）。
            "https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=5440&room_type=1",
            "GET /xlive/web-ucenter/v1/banned/GetBlackList?pn=3&ps=30",
            "GetWebList code=0 page=2 message=接口超时",
            "CSRF 校验失败",
            "关注列表达到翻页上限，截断返回",
        ] {
            assert_eq!(redact(text), text, "不该被改写：{text}");
        }
    }

    /// 键名匹配的消歧规则：前缀必须是词边界 + 同位置取最长键名。
    #[test]
    fn key_matching_respects_word_boundaries_and_prefers_long_keys() {
        assert_eq!(redact("dedeuserid__ckmd5=zz"), "dedeuserid__ckmd5=***");
        assert_eq!(redact("dede_user_id=7"), "dede_user_id=***");
        assert_eq!(redact("vmid=8&mid=9&tuid=1"), "vmid=***&mid=***&tuid=***");
        assert_eq!(redact("buvid3=ABC"), "buvid3=***");
        // 只是把敏感键名当子串的普通参数：不给它开刀。
        assert_eq!(
            redact("buvid_fp=ABC&guid=xyz&roomid=5440&amid=7"),
            "buvid_fp=ABC&guid=xyz&roomid=5440&amid=7"
        );
        // 但真正以敏感键名开头的参数照抹不误（哪怕前面是 `_` 串起来的）。
        assert_eq!(redact("x_uid=42"), "x_uid=***");
    }

    /// 引号 / 冒号形态（上游把请求原样回显成 JSON 时的形状）与原凭据用例。
    #[test]
    fn quoted_and_colon_shapes_are_covered() {
        assert_eq!(
            redact(r#"{"csrf_token":"tok","k":"v"}"#),
            r#"{"csrf_token":"***","k":"v"}"#
        );
        assert_eq!(redact(r#"{"csrf": "tok"}"#), r#"{"csrf": "***"}"#);
        assert_eq!(
            redact(r#"{"data":{"mid":42,"uname":"某人"},"code":0}"#),
            r#"{"data":{"mid":***,"uname":"***"},"code":0}"#
        );
        assert_eq!(
            redact("SESSDATA=abc; bili_jct=def&z=1"),
            "SESSDATA=***; bili_jct=***&z=1"
        );
    }
}
