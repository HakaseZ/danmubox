//! ac站适配器：把上游协议实现成 `danmubox-core` 的端口。
//!
//! 这里是**唯一**允许出现 ac站 URL、字段下标、签名算法与 protobuf 的 crate
//! （`docs/contract.md` §3 的上游隔离约束）。逆向或协议变更只改这里。

pub mod admin;
pub mod anchor;
pub mod asset;
pub mod auth;
pub mod cmd;
pub mod diagnose;
pub mod emote;
pub mod follow;
pub mod history;
pub mod http;
pub mod pb;
pub mod proto;
pub mod report;
pub mod send;
pub mod wallet;
pub mod wbi;

mod redact;
mod ws;

pub use admin::BiliAdmin;
pub use anchor::BiliAnchor;
pub use auth::{profile_from_cookies, qr_state_from_code, BiliAuth};
pub use emote::BiliEmotes;
pub use follow::BiliFollow;
pub use http::{normalize_room_input, BiliHttp, CookieMode, DanmuInfo, NavIdentity};
pub use report::BiliReporter;
pub use send::{failure_detail, outcome_from_response, swallowed_content, BiliSender, Throttle};
pub use wallet::BiliWallet;
pub use ws::{jitter, next_backoff, wait_after_break, BiliLive, INITIAL_BACKOFF, MAX_BACKOFF};
