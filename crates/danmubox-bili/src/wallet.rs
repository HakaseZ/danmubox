//! 电池余额（`docs/contract.md` §3 `WalletProvider`；REQUIREMENTS.md §2.7「电池余额」）。
//!
//! 对应 IPC `wallet_balance`（`docs/ipc.md` §3.2，载荷 `{ battery: number }`）。
//! 只读、不需要 `csrf`（`docs/auth.md` §9.3）；未登录时直接返回 `Error::NotLoggedIn`，
//! 不做游客态降级（游客没有余额可言）。
//!
//! # 未实测项（端点 / 字段名 / 口径）
//!
//! B 站直播钱包接口**尚未实测**（`docs/auth.md` §9.3 与 `docs/protocol.md` 附录 A19
//! 均登记为待校准）。本模块按最可能的形态实现，以下几项在真实登录态调用一次后
//! 由维护者回填 `docs/protocol.md`——本文件不改文档：
//!
//! | 项 | 当前实现 | 为何未确认 |
//! |---|---|---|
//! | 端点 | `https://api.live.bilibili.com/xlive/revenue/v1/wallet/getUserWallet`（候选路径） | 未用真实登录态调用过；`docs/auth.md` §9.3 只登记「候选为直播钱包接口」 |
//! | 结果码 | 仅按 `code == 0` 判成功；非 0（含缺 `code`）一律 `Error::Upstream` 并保留原始 code，**不赋语义** | 未实测的 code 集合，与 `send.rs` 同一纪律 |
//! | 字段名 | 依次尝试 `data.battery` → `data.gold` → `data.silver`，取第一个可解析为整数的值 | 返回里哪个字段才是「电池」未实测 |
//! | 口径 | 优先「电池」，缺失时才退到「金瓜子」/「银瓜子」；**不换算、不合并**，直接透传上游整数 | 三种口径的语义与单位未实测，无网络单测无法确证 |
//! | `csrf` | 不发送（只读） | 预期不需要，但未抓取官方请求确认 |
//!
//! ## 三种可能口径
//!
//! - **电池**：直播移动端的钱包口径，候选字段 `data.battery`。本模块的**首选**。
//! - **金瓜子**：付费瓜子，候选字段 `data.gold`。与电池可能是同一数量的两种叫法，
//!   也可能是不同币种，**未确认**。
//! - **银瓜子**：免费瓜子，候选字段 `data.silver`。若上游只返回它，界面显示的将不是
//!   用户以为的「电池」。
//!
//! 因此 [`parse_balance`] 把命中的字段名打进 `debug` 日志，供阶段 4 校准；
//! 一旦确认真实字段，应把候选表收敛为单一字段。**任何情况下都不回落成 0**——
//! `0` 是合法余额，用 0 冒充成功会让「未登录 / 接口变了」看起来像「余额为零」。

use std::sync::Arc;

use async_trait::async_trait;
use danmubox_core::ports::WalletProvider;
use danmubox_core::{ConfigStore, Error, Result};
use serde_json::Value;

use crate::http::BiliHttp;

/// 直播钱包接口。**候选路径，未实测**（见表）。
const EP_WALLET: &str = "https://api.live.bilibili.com/xlive/revenue/v1/wallet/getUserWallet";

/// 余额候选字段，按优先级排列：`(JSON 字段名, 口径说明)`。
///
/// 顺序即「当前选择」：先电池、再金瓜子、最后银瓜子。全部未实测，详见模块文档。
const BALANCE_CANDIDATES: &[(&str, &str)] = &[
    ("battery", "电池"),
    ("gold", "金瓜子"),
    ("silver", "银瓜子"),
];

/// 响应 → 余额整数。纯函数，便于离线覆盖各分支。
///
/// 规则（未实测前刻意保守，见模块文档）：
/// 1. `code` 必须存在且为 `0`；否则 `Error::Upstream` 并保留原始 code——**不**为具体码赋值语义。
/// 2. 依次尝试 [`BALANCE_CANDIDATES`]，取第一个存在且可解析为整数的值，并记 `debug` 日志。
/// 3. 一个都没有 → `Error::Upstream`；**绝不**回落成 `0`（0 是合法余额，不能冒充成功）。
pub fn parse_balance(value: &Value) -> Result<i64> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => {}
        other => {
            return Err(Error::Upstream(format!(
                "钱包接口返回非 0 code={other:?}"
            )))
        }
    }

    let data = value.get("data").unwrap_or(&Value::Null);
    for (field, caliber) in BALANCE_CANDIDATES {
        if let Some(balance) = data.get(field).and_then(as_i64_lenient) {
            tracing::debug!(field, caliber, balance, "钱包余额字段命中（口径未实测）");
            return Ok(balance);
        }
    }

    // 未命中：只把 `data` 的**键名**记进日志（不记值），便于阶段 4 校准字段名。
    let keys: Vec<&str> = data
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect())
        .unwrap_or_default();
    tracing::debug!(?keys, "钱包响应未命中候选字段（口径未实测）");
    Err(Error::Upstream(
        "钱包响应未包含任何已知的余额字段".to_string(),
    ))
}

/// 接受 JSON 数值与十进制字符串两种形态：上游返回形态未实测，两者都容忍。
fn as_i64_lenient(value: &Value) -> Option<i64> {
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    value.as_str()?.trim().parse::<i64>().ok()
}

/// 电池余额适配器。
pub struct BiliWallet {
    http: BiliHttp,
    store: Arc<ConfigStore>,
}

impl BiliWallet {
    pub fn new(store: Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(Arc::clone(&store))?,
            store,
        })
    }
}

#[async_trait]
impl WalletProvider for BiliWallet {
    async fn balance(&self) -> Result<i64> {
        // 未登录直接失败，不发请求：游客态没有余额，上游只会返回未登录错误。
        self.store
            .active()
            .filter(|profile| profile.is_complete())
            .ok_or(Error::NotLoggedIn)?;

        // Cookie 由 `BiliHttp` 从 store 实时读取，因此切号后无需重建本适配器。
        let (value, _cookies) = self.http.get_with_cookies(EP_WALLET).await?;
        parse_balance(&value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn not_logged_in_store() -> Arc<ConfigStore> {
        let path = std::env::temp_dir()
            .join(format!("danmubox-wallet-test-{}", std::process::id()))
            .join("config.toml");
        Arc::new(ConfigStore::load(path).expect("空配置应可加载"))
    }

    #[test]
    fn reads_battery_balance() {
        let value = json!({"code": 0, "msg": "ok", "data": {"battery": 1234}});
        assert_eq!(parse_balance(&value).unwrap(), 1234);
    }

    #[test]
    fn zero_balance_is_a_valid_success() {
        assert_eq!(
            parse_balance(&json!({"code": 0, "data": {"battery": 0}})).unwrap(),
            0,
            "0 是合法余额，不是错误"
        );
    }

    #[test]
    fn falls_back_through_documented_caliber_candidates() {
        // 优先级：battery → gold → silver，全部未实测（见模块文档）。
        let all = json!({"code": 0, "data": {"silver": 3, "gold": 2, "battery": 1}});
        assert_eq!(parse_balance(&all).unwrap(), 1);
        let gold_and_silver = json!({"code": 0, "data": {"silver": 3, "gold": 2}});
        assert_eq!(parse_balance(&gold_and_silver).unwrap(), 2);
        let silver_only = json!({"code": 0, "data": {"silver": 3}});
        assert_eq!(parse_balance(&silver_only).unwrap(), 3);
    }

    #[test]
    fn accepts_decimal_string_form() {
        let value = json!({"code": 0, "data": {"battery": "42"}});
        assert_eq!(parse_balance(&value).unwrap(), 42);
        // 非数字字符串不是余额，继续走候选表/报错路径。
        let broken = json!({"code": 0, "data": {"battery": "abc"}});
        assert_eq!(parse_balance(&broken).unwrap_err().code(), "UPSTREAM_ERROR");
    }

    #[test]
    fn missing_balance_field_is_upstream_error_not_zero() {
        for value in [
            json!({"code": 0}),
            json!({"code": 0, "data": {}}),
            json!({"code": 0, "data": {"coin": 9}}),
            json!({"code": 0, "data": null}),
        ] {
            let error = parse_balance(&value).unwrap_err();
            assert_eq!(error.code(), "UPSTREAM_ERROR", "输入 {value} 不得返回 0 冒充成功");
        }
    }

    #[test]
    fn nonzero_code_is_upstream_error_without_invented_meaning() {
        for code in [-101, -352, 10030, 12345] {
            let value = json!({"code": code, "msg": "something", "data": {"battery": 7}});
            let error = parse_balance(&value).unwrap_err();
            assert_eq!(error.code(), "UPSTREAM_ERROR");
            assert!(
                error.to_string().contains(&code.to_string()),
                "必须保留原始 code={code} 供校准"
            );
        }
    }

    #[test]
    fn missing_code_is_upstream_error() {
        assert_eq!(
            parse_balance(&json!({"data": {"battery": 7}}))
                .unwrap_err()
                .code(),
            "UPSTREAM_ERROR"
        );
    }

    #[tokio::test]
    async fn not_logged_in_is_rejected_without_a_request() {
        let wallet = BiliWallet::new(not_logged_in_store()).unwrap();
        let error = wallet.balance().await.unwrap_err();
        assert_eq!(error.code(), "NOT_LOGGED_IN");
    }
}
