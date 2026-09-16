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

/// **导出文件**额外要抹的键名（见 [`redact_for_export`]）：房间号在日志里刻意保留，
/// 在要外发的诊断文件里必须消失。
///
/// `room` 也在列：`room=5440` 这种写法在错误文案里出现过；`room_id` 比它长，
/// 同一位置按最长键名优先，因此 `room_id=5440` 不会被短键名截成两半。
const EXPORT_KEYS: [&str; 3] = ["room_id", "roomid", "room"];

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
fn next_secret_key(lowered: &str, from: usize, keys: &[&'static str]) -> Option<(usize, &'static str)> {
    keys
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
    redact_keys(text, &SECRET_KEYS)
}

/// [`redact`] 的键名可变版：导出链路要按更严的一档再抹一遍（见 [`redact_for_export`]），
/// 规则本身仍然只写在这里。
fn redact_keys(text: &str, keys: &[&'static str]) -> String {
    let lowered = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut search = 0;
    while let Some((at, key)) = next_secret_key(&lowered, search, keys) {
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

/// 导出的诊断文件（一键诊断，`docs/operations.md` §2.9）的**更严一档**脱敏。
///
/// 与日志口径的差别只有一处：**房间号也抹掉**。日志里房间号是刻意保留的
/// （排障主键，见本模块顶部），但这份文件是**要发给别人**的 —— 房间与主播的关联
/// 公开可查，留着等于把「谁在用、在哪个房间」一起送出去。
///
/// 两层都做，缺一不可：
///
/// - 先按日志口径 [`redact`]（凭据 / uid / 昵称），再抹房间号的**键名形态**
///   （`room_id=` / `roomid=` / `room=`，日志与错误文案里的写法）；
/// - 再按 `secret_numbers` 逐值抹**裸数字**：`getDanmuInfo` 的查询串是 `?id=5440`，
///   `id=` 不在键名白名单里（别的接口也用它），靠键名认不出来；调用方把本机已知的
///   房间号 / 短号 / 主播 uid 传进来，报告里这些数字一律消失。
pub(crate) fn redact_for_export(text: &str, secret_numbers: &[i64]) -> String {
    let text = redact_keys(text, &SECRET_KEYS);
    let text = redact_keys(&text, &EXPORT_KEYS);
    if secret_numbers.is_empty() {
        return text;
    }
    mask_numbers(&text, secret_numbers)
}

/// 把整段数字里**等于**给定值的那些换成占位符（`15440` 这种更长的一串不动）。
///
/// 只处理「看起来是个独立数字」的位置。三类**一律不碰** —— 它们是报告存在的理由
/// （时间 / 版本 / 计数 / 时长 / 从开始算起的偏移），误伤比漏抹严重：
///
/// - **只有一位**的：`共 1 次记录`、`[1] 开始`、`host_list[0]`。一位数当房间号只可能
///   是公开测试房间 `1`（契约 §4.1 明记的例外），为它把报告里的序号与计数全抹掉，
///   等于把诊断报告变成一份读不懂的文件；
/// - 两侧是 `.` / `:` 的：`0.1.0`（版本）、`13:55:01`（时刻）、`+1.56 s`（小数）；
/// - 左边是 `+` 的：`+619 ms` / `+32.75 s`（相对开始的偏移）。
///
/// 首次实测（2026-09-16，公开测试房间 `1`）就是被这三类反例打回来的：房间号 `1` 让
/// `应用版本：0.***.0`、`13:55:***`、`共 *** 次记录`、`+***.56 s` 全成了 `***`。
/// 房间号真正会出现的形状（`room_id=5440`、`?id=5440`、`房间 5440`）都不在反例里，
/// 因此仍然照抹。
fn mask_numbers(text: &str, numbers: &[i64]) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            let ch = text[index..].chars().next().expect("下标在字符边界上");
            out.push(ch);
            index += ch.len_utf8();
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let run = &text[start..index];
        let before = text[..start].chars().next_back();
        let after = text[index..].chars().next();
        // 「键值对形态」的值位（`room_id=1`、`?id=1`、`&id=1`）：这里的一位数字**也认**，
        // 因为上下文已经说清它是个标识，不存在「计数」的歧义。
        let after_equals = matches!(before, Some('=') | Some('?') | Some('&'));
        let standalone = after_equals
            || (run.len() >= 2
                && !matches!(before, Some('.') | Some(':') | Some('+'))
                && !matches!(after, Some('.') | Some(':')));
        match run.parse::<i64>() {
            Ok(value) if standalone && numbers.contains(&value) => out.push_str(PLACEHOLDER),
            _ => out.push_str(run),
        }
    }
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

    /// ④ 实测打回来过的一条（2026-09-16，用户复核公开测试房间 `1` 的那份报告）：
    /// **时间戳（含秒）/ 应用版本 / 计数 / 时长 / 偏移必须原样**，只有房间号与 uid 该消失。
    /// 房间号 `1` 是个位数，早先的实现把 `0.1.0` / `13:55:01` / `共 1 次` / `+1.56 s`
    /// 一起抹成了 `***` —— 那份报告就没法读了。
    #[test]
    fn export_redaction_keeps_times_versions_and_counts() {
        let text = "应用版本：0.1.0    生成时间：2026-09-16 13:55:01 UTC\n\
                    连接尝试：共 1 次记录    [1] 开始 2026-09-16 13:55:00 UTC\n\
                    首条业务载荷：+1.56 s    认证包发出：+619 ms\n\
                    收包 88    入站帧 36 条    host_list[0] zj-cn-live-comet.chat.bilibili.com\n\
                    房间 1 未登记    room_id=1    ?id=1    uid=7654321";
        let out = redact_for_export(text, &[1, 7654321]);
        for keep in [
            "应用版本：0.1.0",
            "13:55:01",
            "13:55:00",
            "共 1 次记录",
            "[1] 开始",
            "+1.56 s",
            "+619 ms",
            "收包 88",
            "入站帧 36 条",
            "host_list[0]",
        ] {
            assert!(out.contains(keep), "「{keep}」必须原样保留：\n{out}");
        }
        for gone in ["room_id=1", "?id=1", "uid=7654321"] {
            assert!(!out.contains(gone), "「{gone}」必须被抹掉：\n{out}");
        }
        // 反例的**边界**也钉住：裸文本里的**一位**数字不抹。一位数当房间号只可能是公开
        // 测试房间 `1`（契约 §4.1 明记的例外），为它把「房间 1 未登记」这类文案里的 `1`
        // 抹掉，就会连 `共 1 次记录` / `[1] 开始` 一起毁掉 —— 报告的可读性优先，
        // 而键值对形态（`room_id=1` / `?id=1`，上面刚断言过）一位也照样抹。
        assert!(out.contains("房间 1 未登记"), "裸文本的一位数字不抹：\n{out}");
    }

    /// ③ 导出文件的更严一档：房间号也抹掉，且覆盖「键名形态」与「裸数字」两种，
    /// 凭据 / uid / 昵称照旧（日志口径那一层不能因为叠了一层就漏）。
    #[test]
    fn export_redaction_also_removes_room_numbers() {
        let text = "GET /getDanmuInfo?id=5440&type=0 room_id=5440 roomid=5440 \
                    room=5440 DedeUserID=7654321 uname=某主播 观看 15440 人";
        let out = redact_for_export(text, &[5440]);
        assert_eq!(
            out,
            "GET /getDanmuInfo?id=***&type=0 room_id=*** roomid=*** room=*** \
             DedeUserID=*** uname=*** 观看 15440 人",
            "键名形态与裸数字都要抹，更长的一串数字（15440）不许误伤"
        );
        // 没给房间号时只走键名那一层，裸数字保持原样（调用方负责把已知值传全）。
        let keys_only = redact_for_export("id=5440", &[]);
        assert_eq!(keys_only, "id=5440");
    }

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
