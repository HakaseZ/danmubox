//! 电池余额（`docs/contract.md` §3 `WalletProvider`，IPC `wallet_balance`）。
//!
//! 端点与字段均于 **2026-09-11** 用真实登录态实测确认（`docs/protocol.md` 附录 A29）。
//! 此前的候选端点（`xlive/revenue/v1/wallet/getUserWallet` 等）实测全部 404，
//! 真实路径是从直播页自身的前端产物里检索出来的。
//!
//! | 项 | 值 |
//! |---|---|
//! | 端点 | `GET https://api.live.bilibili.com/xlive/revenue/v1/wallet/myWallet` |
//! | 响应字段 | `data.gold`（金瓜子）、`data.silver`（银瓜子）、`data.bp` |
//! | 换算 | **电池 = 金瓜子 / 100** |
//!
//! 换算依据：社区接口文档记载「金瓜子数量 / 100 = 电池数量」；并用同一账号交叉验证——
//! `gold = 15000` 恰好等于 15 元、即 150 电池，两条口径一致。上游**没有**独立的
//! 「电池」字段，因此换算是本模块的职责。

use danmubox_core::ports::WalletProvider;
use danmubox_core::{ConfigStore, Error, Result};
use serde_json::Value;

use crate::http::BiliHttp;

const EP_WALLET: &str = "https://api.live.bilibili.com/xlive/revenue/v1/wallet/myWallet";

/// 金瓜子与电池的换算比（1 电池 = 100 金瓜子）。
const GOLD_PER_BATTERY: i64 = 100;

/// 从钱包响应解析电池数量。
///
/// 只认 `data.gold`；取不到就报错——**不得返回 0 冒充成功**（0 是合法余额，无法与失败区分）。
pub fn parse_balance(value: &Value) -> Result<i64> {
    let code = value.get("code").and_then(Value::as_i64);
    if code != Some(0) {
        return Err(Error::Upstream(format!(
            "钱包接口返回 code={}",
            code.map(|c| c.to_string()).unwrap_or_else(|| "缺失".into())
        )));
    }

    let gold = value
        .pointer("/data/gold")
        .and_then(|raw| match raw {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.parse::<i64>().ok(),
            _ => None,
        })
        .ok_or_else(|| Error::Upstream("钱包响应缺少可解析的 data.gold".into()))?;

    Ok(gold / GOLD_PER_BATTERY)
}

pub struct BiliWallet {
    http: BiliHttp,
    store: std::sync::Arc<ConfigStore>,
}

impl BiliWallet {
    pub fn new(store: std::sync::Arc<ConfigStore>) -> Result<Self> {
        Ok(Self {
            http: BiliHttp::with_store(std::sync::Arc::clone(&store))?,
            store,
        })
    }
}

#[async_trait::async_trait]
impl WalletProvider for BiliWallet {
    async fn balance(&self) -> Result<i64> {
        if !self.store.is_logged_in() {
            return Err(Error::NotLoggedIn);
        }
        let (value, _cookies) = self.http.get_with_cookies(EP_WALLET).await?;
        parse_balance(&value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_battery_as_gold_over_hundred() {
        // 实测样本：gold=15000 → 150 电池（10 金瓜子 = 0.1 电池 = 1 分钱）。
        let value = json!({"code": 0, "message": "OK", "data": {"gold": 15000, "silver": 44, "bp": "0"}});
        assert_eq!(parse_balance(&value).unwrap(), 150);
    }

    #[test]
    fn zero_gold_is_a_valid_zero_balance() {
        let value = json!({"code": 0, "data": {"gold": 0, "silver": 0}});
        assert_eq!(parse_balance(&value).unwrap(), 0);
    }

    #[test]
    fn accepts_string_encoded_gold() {
        // 上游的 bp 是字符串，gold 目前是数字，但两种都容错。
        assert_eq!(parse_balance(&json!({"code": 0, "data": {"gold": "1234"}})).unwrap(), 12);
    }

    #[test]
    fn missing_gold_is_an_error_not_zero() {
        for payload in [
            json!({"code": 0, "data": {}}),
            json!({"code": 0, "data": {"silver": 44}}),
            json!({"code": 0}),
            json!({"code": 0, "data": null}),
        ] {
            let err = parse_balance(&payload).unwrap_err();
            assert_eq!(err.code(), "UPSTREAM_ERROR", "payload={payload}");
        }
    }

    #[test]
    fn nonzero_or_missing_code_keeps_raw_code_without_invented_meaning() {
        for code in [-101, -352, 800501007, 12345] {
            let err = parse_balance(&json!({"code": code, "data": {"gold": 1}})).unwrap_err();
            assert_eq!(err.code(), "UPSTREAM_ERROR");
            assert!(err.to_string().contains(&code.to_string()));
        }
        assert!(parse_balance(&json!({"data": {"gold": 1}})).is_err());
    }

    #[tokio::test]
    async fn not_logged_in_is_rejected_without_a_request() {
        let dir = std::env::temp_dir().join(format!("danmubox-wallet-{}", std::process::id()));
        let store = std::sync::Arc::new(danmubox_core::ConfigStore::load(dir.join("config.toml")).unwrap());
        let wallet = BiliWallet::new(store).unwrap();
        assert_eq!(wallet.balance().await.unwrap_err().code(), "NOT_LOGGED_IN");
    }
}
