//! 上游静态资源的地址规范化。
//!
//! ## 为什么必须有这一层
//!
//! 上游返回的表情图片地址**混着 `http://` 与 `https://`**（实测 6 条样本里 4 条是 http）。
//! 而客户端跑在**安全上下文**里（Tauri 的 `localhost` 页面 + macOS 的 ATS 默认策略），
//! 其中的 `http://` 子资源会被直接拦掉——WebKit 还不像 Chrome 那样往控制台打警告，
//! 于是表现成「表情图片全都不显示」且日志里**一条线索都没有**。
//!
//! 实测两条地址返回的是同一张图（均 200、`image/png`、字节数逐字节相同），
//! 因此统一升级到 https 是无损的。

/// 把上游图片地址规范化成 `https://`；非 `http://` 的一律原样返回。
pub fn secure_url(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrades_insecure_upstream_urls() {
        assert_eq!(
            secure_url("http://i0.hdslb.com/bfs/live/abc.png"),
            "https://i0.hdslb.com/bfs/live/abc.png"
        );
    }

    #[test]
    fn leaves_secure_and_other_schemes_alone() {
        for url in [
            "https://i0.hdslb.com/bfs/garb/abc.png",
            "data:image/png;base64,AAAA",
            "",
            "//i0.hdslb.com/bfs/live/abc.png",
        ] {
            assert_eq!(secure_url(url), url, "不该改动 {url}");
        }
    }
}
