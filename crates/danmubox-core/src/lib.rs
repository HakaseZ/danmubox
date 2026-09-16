//! danmubox 引擎：领域模型、端口、事件总线、会话缓冲与本地文件。
//!
//! 本 crate 是唯一的事实来源，**不得**依赖任何具体上游实现（B 站字段、URL、
//! 签名、protobuf 一律不准出现），也**不得**依赖 `tauri`。上游知识只允许存在于
//! `danmubox-bili`。

pub mod bus;
pub mod config;
pub mod diagnose;
pub mod error;
pub mod model;
pub mod paths;
pub mod ports;
pub mod prefs;
pub mod session;

pub use bus::{Cancel, ConnState, Counters, Event, EventBus, MessageSink, RoomStats, StatusEvent};
pub use config::{account_name_from, validate_account_name, AppConfig, ConfigStore, Profile};
pub use error::{Error, Result};
pub use model::{
    sort_followed, BlacklistedUser, Emote, EmotePackage, EmoteRef, FollowedRoom, Message,
    MessageKind, ReportReason, Room, RoomSession, SendOutcome, SilentUser,
};
pub use paths::{config_path, data_dir, downloads_dir, prefs_path};
pub use prefs::Prefs;
pub use session::{HistoryQuery, MessageBuffer, RoomRuntime};

/// UTC 毫秒时间戳。
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
