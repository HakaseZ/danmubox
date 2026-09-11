use thiserror::Error;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// 领域错误。`code()` 与 `docs/contract.md` §7 的错误码集合一一对应，
/// 是 IPC / 本地接口层唯一允许暴露的错误词汇。
#[derive(Debug, Error)]
pub enum Error {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("room not found: {0}")]
    RoomNotFound(String),
    #[error("not logged in")]
    NotLoggedIn,
    #[error("rate limited: {0}")]
    RateLimited(String),
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::BadRequest(_) => "BAD_REQUEST",
            Error::Unauthorized => "UNAUTHORIZED",
            Error::NotFound(_) => "NOT_FOUND",
            Error::RoomNotFound(_) => "ROOM_NOT_FOUND",
            Error::NotLoggedIn => "NOT_LOGGED_IN",
            Error::RateLimited(_) => "RATE_LIMITED",
            Error::Upstream(_) => "UPSTREAM_ERROR",
            Error::Internal(_) => "INTERNAL",
        }
    }
}
