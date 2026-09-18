//! 弹幕框桌面端：Tauri 2 外壳与 IPC 命令层（`docs/ipc.md` 的实现侧）。
//!
//! 本 crate 只做三件事：把 `danmubox-core` 的端口与引擎挂到 IPC 上、
//! 把事件总线转发给前端、把错误映射成契约 §7 的错误模型。
//! **不包含任何 ac站协议知识**（那属于 `danmubox-bili`）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use danmubox_bili::{
    BiliAdmin, BiliAuth, BiliEmotes, BiliFollow, BiliLive, BiliReporter, BiliSender, BiliWallet,
};
use danmubox_core::ports::{
    Account, AuthProvider, DanmakuReporter, DanmakuSender, EmoteProvider, LiveSource, QrPoll,
    QrState, RoomAdmin, RoomCatalog, SessionState, WalletProvider,
};
use danmubox_core::{
    config_path, data_dir, prefs_path, BlacklistedUser, BufferCaps, ConfigStore, Counters, Emote,
    Event, EventBus, FollowedRoom, HistoryQuery, Message, MessageKind, Prefs, ReportReason, Room,
    RoomRuntime, RoomSession, SendOutcome, SilentUser,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

mod diagnose;

/// 事件总线容量（`docs/architecture.md` §4.3）。
const BUS_CAPACITY: usize = 1024;

/// 传给前端的错误：`docs/contract.md` §7 的统一错误模型。
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl From<danmubox_core::Error> for ApiError {
    fn from(err: danmubox_core::Error) -> Self {
        Self {
            code: err.code().to_string(),
            message: err.to_string(),
        }
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// 已添加房间的登记表。会话缓冲随 `RoomRuntime` 生死，离开房间即销毁。
#[derive(Default)]
struct Rooms {
    order: Vec<i64>,
    meta: HashMap<i64, Room>,
    runtimes: HashMap<i64, RoomRuntime>,
}

pub struct AppState {
    store: Arc<ConfigStore>,
    /// 长驻的鉴权实现。扫码的「这一轮要写进哪个账号」必须活过命令边界
    /// （`account_qr_start` 与 `account_qr_poll` 是两次独立调用），
    /// 所以不能像别的能力那样每条命令新建一个。
    auth: Arc<BiliAuth>,
    bus: EventBus,
    counters: Arc<Counters>,
    prefs: Mutex<Prefs>,
    /// 已登记房间。`Arc` 是因为**事件转发器也要改它**：`LIVE` / `PREPARING` 到达时先把
    /// `live_status` 落进登记表，再把整条 `Room` 推给界面 —— 不落登记表的话，下一次
    /// `rooms_list` 重拉（开房间 / 加房间 / 换号）会把旧状态盖回界面。
    rooms: Arc<Mutex<Rooms>>,
    /// 前端在**开始采集**时交上来的渲染引擎标识（`navigator.userAgent`）。
    ///
    /// 内核版本只有页面自己知道，而白屏一类问题同时取决于它：因此诊断开始时存下来，
    /// 导出时写进报告头（`docs/operations.md` §2.9）。
    engine: Mutex<String>,
}

impl AppState {
    pub fn new(store: Arc<ConfigStore>) -> danmubox_core::Result<Self> {
        Ok(Self {
            auth: Arc::new(BiliAuth::new(Arc::clone(&store))?),
            store,
            bus: EventBus::new(BUS_CAPACITY),
            counters: Arc::new(Counters::default()),
            prefs: Mutex::new(Prefs::load(&prefs_path())),
            rooms: Arc::new(Mutex::new(Rooms::default())),
            engine: Mutex::new(String::new()),
        })
    }
}

// ---------------------------------------------------------------- 视图模型

#[derive(Serialize)]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub config_path: String,
    pub logged_in: bool,
}

#[derive(Serialize)]
pub struct RoomView {
    pub room_id: i64,
    pub short_id: i64,
    pub anchor_uid: i64,
    /// 主播昵称（契约 §5 `Room.anchor_uname`）：界面用它代替房间号展示房间
    /// （用户 2026-09-12：#17 房间列表 / #18 标签条）。上游没给时为空串，
    /// 界面回落到 `title`、再回落到「房间 <号>」。
    pub anchor_uname: String,
    pub title: String,
    pub live_status: i32,
    /// 当前是否持有连接。
    pub connected: bool,
    /// 当前会话缓冲条数（会话结束后为 0）。
    pub buffered: usize,
}

#[derive(Serialize)]
pub struct ChatSendResult {
    pub room_id: i64,
    pub content: String,
    pub outcome: SendOutcome,
    /// 上游的原始答复（`outcome` 非 `ok` 时）：`msg` 原话 + `code`。
    /// 界面据此回答「为什么失败」（`REQUIREMENTS.md` §2.3）；**不做码表翻译**。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 把上游原始答复拼成给界面看的一行。
///
/// 只搬运上游自己给的文字与数字，不翻译、不归类——码表映射见
/// `docs/protocol.md` 附录 A17，结论出来之前一律原样透传。
fn send_detail(report: &danmubox_core::ports::SendReport) -> Option<String> {
    if report.outcome == SendOutcome::Ok {
        return None;
    }
    match (&report.upstream_message, report.upstream_code) {
        (Some(message), Some(code)) => Some(format!("{message}（code {code}）")),
        (Some(message), None) => Some(message.clone()),
        (None, Some(code)) => Some(format!("code {code}")),
        (None, None) => None,
    }
}

#[derive(Debug, Deserialize)]
pub struct HistoryQueryDto {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub before: Option<i64>,
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub uid: Option<i64>,
    #[serde(default)]
    pub q: Option<String>,
}

fn default_limit() -> usize {
    500
}

fn to_query(dto: HistoryQueryDto) -> ApiResult<HistoryQuery> {
    let kinds = match dto.kinds {
        Some(names) => {
            let mut kinds = Vec::with_capacity(names.len());
            for name in names {
                kinds.push(name.parse::<MessageKind>().map_err(ApiError::from)?);
            }
            Some(kinds)
        }
        None => None,
    };
    Ok(HistoryQuery {
        limit: dto.limit,
        after: dto.after,
        before: dto.before,
        kinds,
        uid: dto.uid,
        q: dto.q,
    })
}

fn view(state: &AppState, rooms: &Rooms, room_id: i64) -> Option<RoomView> {
    let _ = state;
    let room = rooms.meta.get(&room_id)?;
    Some(RoomView {
        room_id: room.room_id,
        short_id: room.short_id,
        anchor_uid: room.anchor_uid,
        anchor_uname: room.anchor_uname.clone(),
        title: room.title.clone(),
        live_status: room.live_status,
        connected: rooms.runtimes.contains_key(&room_id),
        buffered: rooms
            .runtimes
            .get(&room_id)
            .map(|runtime| runtime.len())
            .unwrap_or(0),
    })
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    // 前端挂载后第一件事就是调它；这条日志因此也是「页面已加载且 JS 已执行」的信号。
    tracing::debug!("IPC app_info");
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: data_dir().display().to_string(),
        config_path: config_path().display().to_string(),
        logged_in: state.store.is_logged_in(),
    }
}

#[tauri::command]
async fn session_status(state: State<'_, AppState>) -> ApiResult<SessionState> {
    state.auth.session().await.map_err(ApiError::from)
}

#[tauri::command]
fn rooms_list(state: State<'_, AppState>) -> Vec<RoomView> {
    let rooms = state.rooms.lock().expect("rooms poisoned");
    rooms
        .order
        .iter()
        .filter_map(|id| view(&state, &rooms, *id))
        .collect()
}

/// 定期刷新**已登记房间**的开播状态（`docs/contract.md` §4 的 30 秒那一拍、§7 的命令表）。
///
/// 列表页站着不动时，「我的房间」那些卡片的状态要自己跟着上游变 —— 在这之前它们的
/// `live_status` 只在 `rooms_add` 那一刻取过一次，之后永远不动（用户 2026-09-16 报的
/// 「开播下播时状态不会自动更新」在列表上的那一半）。
///
/// 三条纪律：
/// - **只动 `live_status`**：标题与昵称另有来源（`getH5InfoByRoom`），这一条路上不打那一跳，
///   每个房间因此只有**一次**只读 GET；
/// - **逐个房间并发**取；单个失败只跳过它（一个房间被删 / 被锁不该让整页都刷不成）；
/// - **一个都没成功**（多半是断网）→ `UPSTREAM_ERROR`：前端据此退避，
///   断网时不会每 30 秒打一次上游。没有已登记房间时**一个请求都不发**。
#[tauri::command]
async fn rooms_refresh_status(state: State<'_, AppState>) -> ApiResult<Vec<RoomView>> {
    let ids: Vec<i64> = {
        let rooms = state.rooms.lock().expect("rooms poisoned");
        rooms.order.clone()
    };

    if !ids.is_empty() {
        let live =
            Arc::new(BiliLive::with_store(Arc::clone(&state.store)).map_err(ApiError::from)?);
        let mut tasks = tokio::task::JoinSet::new();
        for room_id in ids {
            let live = Arc::clone(&live);
            tasks.spawn(async move { (room_id, live.live_status(room_id).await) });
        }

        let mut fresh: Vec<(i64, i32)> = Vec::with_capacity(tasks.len());
        let mut failed = 0usize;
        while let Some(joined) = tasks.join_next().await {
            match joined {
                Ok((room_id, Ok(live_status))) => fresh.push((room_id, live_status)),
                Ok((room_id, Err(error))) => {
                    failed += 1;
                    tracing::debug!(room_id, %error, "开播状态取失败，这一拍跳过这个房间");
                }
                Err(error) => {
                    failed += 1;
                    tracing::debug!(%error, "开播状态刷新任务未跑完");
                }
            }
        }

        if fresh.is_empty() {
            return Err(ApiError::from(danmubox_core::Error::Upstream(format!(
                "{failed} 个房间的开播状态都没取到"
            ))));
        }

        let mut rooms = state.rooms.lock().expect("rooms poisoned");
        for (room_id, live_status) in fresh {
            if let Some(room) = rooms.meta.get_mut(&room_id) {
                room.live_status = live_status;
            }
        }
    }

    let rooms = state.rooms.lock().expect("rooms poisoned");
    Ok(rooms
        .order
        .iter()
        .filter_map(|id| view(&state, &rooms, *id))
        .collect())
}

/// 解析房间号 / 短号 / URL 并登记；不建立连接。
#[tauri::command]
async fn rooms_add(state: State<'_, AppState>, input: String) -> ApiResult<RoomView> {
    let live = BiliLive::with_store(Arc::clone(&state.store)).map_err(ApiError::from)?;
    let room = live.resolve_room(&input).await.map_err(ApiError::from)?;

    let mut rooms = state.rooms.lock().expect("rooms poisoned");
    if !rooms.order.contains(&room.room_id) {
        rooms.order.push(room.room_id);
    }
    let room_id = room.room_id;
    rooms.meta.insert(room_id, room);
    view(&state, &rooms, room_id).ok_or_else(|| ApiError {
        code: "INTERNAL".into(),
        message: "登记房间失败".into(),
    })
}

#[tauri::command]
async fn rooms_remove(state: State<'_, AppState>, room_id: i64) -> ApiResult<()> {
    let runtime = {
        let mut rooms = state.rooms.lock().expect("rooms poisoned");
        rooms.order.retain(|id| *id != room_id);
        rooms.meta.remove(&room_id);
        rooms.runtimes.remove(&room_id)
    };
    if let Some(runtime) = runtime {
        runtime.close().await.map_err(ApiError::from)?;
    }
    Ok(())
}

#[tauri::command]
async fn rooms_connect(state: State<'_, AppState>, room_id: i64) -> ApiResult<()> {
    // 锁外先备好构造运行时需要的东西（凭据、偏好），避免把两把锁叠在一起。
    let source: Arc<dyn LiveSource> =
        Arc::new(BiliLive::with_store(Arc::clone(&state.store)).map_err(ApiError::from)?);
    let caps = state.prefs.lock().expect("prefs poisoned").buffer_caps();
    let mut rooms = state.rooms.lock().expect("rooms poisoned");
    spawn_runtime(
        &mut rooms,
        room_id,
        caps,
        state.bus.clone(),
        Arc::clone(&state.counters),
        source,
    )
}

/// 建一次房内会话（幂等：房间已有会话时原样返回）。
///
/// **存在性检查与插入必须在同一把锁内完成**：界面在 StrictMode 下会并发触发连接，
/// 若分两次加锁，两个调用都会通过检查并各自 `spawn` 一个运行时——于是同一个房间
/// 会有两套会话缓冲，两套都从 `local_id = 1` 开始回填，界面收到重复 id
/// （表现为 React 报「two children with the same key, 1」且刷满日志）。
/// `RoomRuntime::spawn_on` 是同步的（内部只起任务），因此**在锁内构造是安全的**。
fn spawn_runtime(
    rooms: &mut Rooms,
    room_id: i64,
    caps: BufferCaps,
    bus: EventBus,
    counters: Arc<Counters>,
    source: Arc<dyn LiveSource>,
) -> ApiResult<()> {
    if rooms.runtimes.contains_key(&room_id) {
        return Ok(());
    }
    let Some(room) = rooms.meta.get(&room_id).cloned() else {
        return Err(ApiError::from(danmubox_core::Error::RoomNotFound(format!(
            "房间 {room_id} 未登记"
        ))));
    };
    rooms.runtimes.insert(
        room_id,
        // 显式用 Tauri 的全局 runtime 句柄，而不是当前线程的 runtime 上下文：
        // `rooms_reconnect` 是同步 command，跑在主线程上，那里没有 runtime。
        RoomRuntime::spawn_on(
            tauri::async_runtime::handle().inner(),
            room,
            caps,
            bus,
            counters,
            source,
        ),
    );
    Ok(())
}

#[tauri::command]
async fn rooms_disconnect(state: State<'_, AppState>, room_id: i64) -> ApiResult<()> {
    let runtime = state
        .rooms
        .lock()
        .expect("rooms poisoned")
        .runtimes
        .remove(&room_id);
    if let Some(runtime) = runtime {
        runtime.close().await.map_err(ApiError::from)?;
    }
    Ok(())
}

/// 房间内「刷新」：立即重建连接，**不清空**会话缓冲（`docs/contract.md` §4.3）。
#[tauri::command]
fn rooms_reconnect(state: State<'_, AppState>, room_id: i64) -> ApiResult<()> {
    let caps = state.prefs.lock().expect("prefs poisoned").buffer_caps();
    let mut rooms = state.rooms.lock().expect("rooms poisoned");
    refresh_room(
        &mut rooms,
        room_id,
        caps,
        state.bus.clone(),
        Arc::clone(&state.counters),
        || Ok(Arc::new(BiliLive::with_store(Arc::clone(&state.store))?) as Arc<dyn LiveSource>),
    )
}

/// 「刷新连接」的全部决策，`rooms_reconnect` 只是它的 IPC 外壳。
///
/// - **会话还在**（连接中 / 退避中 / 已连接）→ `reconnect()`：只终止当前这一次连接，
///   立即发起下一次，**缓冲不变**，仍属同一次会话。
/// - **会话已经不在了**（用户点过「断开连接」，或房间被移除后又加了回来）→ 当场重建
///   一次会话：与「进房间」等价，缓冲从空开始（契约 §4.3：离开房间即销毁，重进是
///   全新会话）。
///
/// 第二种情况曾经直接返回 `ROOM_NOT_FOUND`（「房间 X 尚未连接」），于是菜单里那颗
/// 「刷新连接」在断连之后就是一颗**死键**：界面弹一条错误，连接回不来，用户只能退出
/// 房间再进来——而 `docs/ui.md` §3.3 明写 `disconnected` 档（含「已主动断开」）
/// 是「点击立即重连」。备凭据、建 HTTP 客户端只在真需要新建会话时才做
/// （`make_source` 是惰性的），刷一条活着的连接不付这份钱。
fn refresh_room(
    rooms: &mut Rooms,
    room_id: i64,
    caps: BufferCaps,
    bus: EventBus,
    counters: Arc<Counters>,
    make_source: impl FnOnce() -> danmubox_core::Result<Arc<dyn LiveSource>>,
) -> ApiResult<()> {
    if let Some(runtime) = rooms.runtimes.get(&room_id) {
        runtime.reconnect();
        return Ok(());
    }
    let source = make_source().map_err(ApiError::from)?;
    spawn_runtime(rooms, room_id, caps, bus, counters, source)
}

#[tauri::command]
fn history_query(
    state: State<'_, AppState>,
    room_id: i64,
    query: HistoryQueryDto,
) -> ApiResult<Vec<Message>> {
    let query = to_query(query)?;
    let rooms = state.rooms.lock().expect("rooms poisoned");
    Ok(match rooms.runtimes.get(&room_id) {
        Some(runtime) => runtime.query(&query),
        None => Vec::new(),
    })
}

#[tauri::command]
async fn chat_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    room_id: i64,
    content: String,
    color: Option<i64>,
    emote: Option<danmubox_core::ports::EmoteToken>,
    reply: Option<danmubox_core::ports::ReplyTarget>,
) -> ApiResult<ChatSendResult> {
    let sender = BiliSender::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    let report = sender
        .send(
            room_id,
            &content,
            color,
            None,
            emote.as_ref(),
            reply.as_ref(),
        )
        .await
        .map_err(ApiError::from)?;

    let result = ChatSendResult {
        room_id,
        content,
        outcome: report.outcome,
        detail: send_detail(&report),
    };
    let _ = app.emit("danmubox://send", &result);
    Ok(result)
}

/// 用系统默认浏览器打开一个链接（点昵称跳用户主页用）。
///
/// 桌面三端各一条系统命令就够，不为此引入依赖。Android 没有可用的系统命令
/// （既没有 `open` 也没有 `xdg-open`），只能经平台 Intent，因此**只在 Android 上**
/// 挂官方 `tauri-plugin-opener`（`Cargo.toml` 里按 `cfg(target_os = "android")` 声明，
/// 桌面构建的依赖图与产物一字不变）。这里是 Rust 侧调用，**不经过 capability 系统**，
/// 所以 `capabilities/default.json` 不需要 `opener:*` 权限。
/// 入口处的 http(s) 白名单照旧先行，其余平台仍明确返回不支持而不是静默失败。
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> ApiResult<()> {
    // 句柄只有 Android 那一支用得上（桌面三端各是一条系统命令），别处不做标记会被判未使用。
    #[cfg(not(target_os = "android"))]
    let _ = &app;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(ApiError {
            code: "BAD_REQUEST".into(),
            message: "只允许打开 http(s) 链接".into(),
        });
    }
    let spawned = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&url).spawn()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &url])
                .spawn()
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open").arg(&url).spawn()
        }
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_opener::OpenerExt as _;
            app.opener()
                .open_url(url.clone(), None::<&str>)
                .map_err(|err| std::io::Error::other(err.to_string()))
        }
        #[cfg(not(any(
            target_os = "macos",
            target_os = "windows",
            target_os = "linux",
            target_os = "android"
        )))]
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "当前平台没有打开外部链接的实现",
            ))
        }
    };
    spawned.map(|_| ()).map_err(|err| ApiError {
        code: "UPSTREAM_ERROR".into(),
        message: format!("打开链接失败：{err}"),
    })
}

#[tauri::command]
fn prefs_get(state: State<'_, AppState>) -> serde_json::Value {
    state.prefs.lock().expect("prefs poisoned").effective()
}

#[tauri::command]
fn prefs_set(state: State<'_, AppState>, patch: serde_json::Value) -> ApiResult<serde_json::Value> {
    let mut prefs = state.prefs.lock().expect("prefs poisoned");
    prefs.set_patch(&patch).map_err(ApiError::from)?;
    prefs.save(&prefs_path()).map_err(ApiError::from)?;
    Ok(prefs.effective())
}

/// 本人在该房间的身份（契约 §7）：粉丝牌 / 大航海 / 是否房管。
///
/// 房间没有活跃会话时返回该 `room_id` 的**全零身份**而不是报错——与
/// `history_query` 对「无活跃会话」的处理一致。界面对它的解释是「还没有身份
/// 信息」，因此房管入口必须按**无权限**渲染（拿不到就不放行），而不是先放行再
/// 等服务端报错。身份在会话建立时由引擎取一次，同时经 `danmubox://session`
/// 事件推送，因此这条命令只在进房时读一次快照即可。
#[tauri::command]
fn room_session(state: State<'_, AppState>, room_id: i64) -> RoomSession {
    state
        .rooms
        .lock()
        .expect("rooms poisoned")
        .runtimes
        .get(&room_id)
        .map(|runtime| runtime.session())
        .unwrap_or(RoomSession {
            room_id,
            ..Default::default()
        })
}

#[tauri::command]
async fn emotes_list(state: State<'_, AppState>, room_id: i64) -> ApiResult<Vec<Emote>> {
    let provider = BiliEmotes::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    // 身份取自当前会话（粉丝牌 / 大航海 / 房管）：上游按身份下发可用表情包，
    // 传全零会拿不到粉丝牌与大航海那几包。无会话时退回零身份（与上面同语义）。
    let session = {
        let rooms = state.rooms.lock().expect("rooms poisoned");
        rooms
            .runtimes
            .get(&room_id)
            .map(|runtime| runtime.session())
    }
    .unwrap_or(RoomSession {
        room_id,
        ..Default::default()
    });
    provider
        .emotes(room_id, &session)
        .await
        .map_err(ApiError::from)
}

/// 主站「我的表情」（契约 §7）：当前账号在**主站**拥有的表情包（`upower_` 家族）。
///
/// 与 `emotes_list` 不是同一套上游：后者是直播间的通用 / 房间 / 粉丝牌 / 大航海，
/// 这里取的是主站表情面板。未登录时上游会退化为免费表情包，照常返回。
#[tauri::command]
async fn emotes_owned(state: State<'_, AppState>) -> ApiResult<Vec<Emote>> {
    let provider = BiliEmotes::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    provider.owned().await.map_err(ApiError::from)
}

/// 禁言一名观众（契约 §7）。`hour`：`-1` 永久 / `0` 本场直播 / 其余小时数。
///
/// 只有请求者本人是该房间房管时才成立；非房管的 code 原样带回，不翻译。
#[tauri::command]
async fn admin_mute(
    state: State<'_, AppState>,
    room_id: i64,
    uid: i64,
    hour: i64,
    msg: Option<String>,
) -> ApiResult<()> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin
        .mute(room_id, uid, hour, msg.as_deref())
        .await
        .map_err(ApiError::from)
}

/// 解除禁言（契约 §7）。
#[tauri::command]
async fn admin_unmute(state: State<'_, AppState>, room_id: i64, uid: i64) -> ApiResult<()> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin.unmute(room_id, uid).await.map_err(ApiError::from)
}

/// 禁言名单（契约 §7）。与黑名单列表同款：只读，非房管时上游 code 原样带回。
#[tauri::command]
async fn admin_silent_list(state: State<'_, AppState>, room_id: i64) -> ApiResult<Vec<SilentUser>> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin.silent_list(room_id).await.map_err(ApiError::from)
}

/// 房间黑名单（契约 §7）。
#[tauri::command]
async fn admin_blacklist_list(
    state: State<'_, AppState>,
    room_id: i64,
) -> ApiResult<Vec<BlacklistedUser>> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin.blacklist(room_id).await.map_err(ApiError::from)
}

/// 加入黑名单（契约 §7）。
#[tauri::command]
async fn admin_blacklist_add(state: State<'_, AppState>, room_id: i64, uid: i64) -> ApiResult<()> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin
        .blacklist_add(room_id, uid)
        .await
        .map_err(ApiError::from)
}

/// 移出黑名单（契约 §7）。
#[tauri::command]
async fn admin_blacklist_del(state: State<'_, AppState>, room_id: i64, uid: i64) -> ApiResult<()> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin
        .blacklist_del(room_id, uid)
        .await
        .map_err(ApiError::from)
}

/// 屏蔽词列表（契约 §7）。
#[tauri::command]
async fn admin_keywords_list(state: State<'_, AppState>, room_id: i64) -> ApiResult<Vec<String>> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin.keywords(room_id).await.map_err(ApiError::from)
}

/// 新增屏蔽词（契约 §7）。上游一次只收一个关键词。
#[tauri::command]
async fn admin_keywords_add(
    state: State<'_, AppState>,
    room_id: i64,
    words: String,
) -> ApiResult<()> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin
        .keyword_add(room_id, &words)
        .await
        .map_err(ApiError::from)
}

/// 删除屏蔽词（契约 §7）。
#[tauri::command]
async fn admin_keywords_del(
    state: State<'_, AppState>,
    room_id: i64,
    word: String,
) -> ApiResult<()> {
    let admin = BiliAdmin::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    admin
        .keyword_del(room_id, &word)
        .await
        .map_err(ApiError::from)
}

#[tauri::command]
async fn chat_report(
    state: State<'_, AppState>,
    message: Message,
    reason: ReportReason,
) -> ApiResult<()> {
    let reporter = BiliReporter::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    reporter
        .report(&message, &reason)
        .await
        .map_err(ApiError::from)
}

/// 列出全部账号：每个账号都带登录状态与身份（昵称 / uid / 头像）。
///
/// 有凭据的账号由 `danmubox-bili` 逐个并发向 `nav` 求证——串行等 N 次的上游往返
/// 会让账号多的人肉眼可见地等，且单个账号求证失败只影响它自己那一行。
#[tauri::command]
async fn accounts_list(state: State<'_, AppState>) -> ApiResult<Vec<Account>> {
    state.auth.accounts().await.map_err(ApiError::from)
}

/// 切换当前账号（契约 §7：切换后**以新凭据重连**）。
///
/// 重连是必须的：WS 认证包里的 uid 取自连接建立时的账号，
/// 已有连接不会因为文件换了账号而自动换身份——不重连就会出现
/// 「界面显示新账号、连接其实还是旧账号」。
#[tauri::command]
async fn account_switch(state: State<'_, AppState>, name: String) -> ApiResult<SessionState> {
    let session = state
        .auth
        .switch_account(&name)
        .await
        .map_err(ApiError::from)?;
    reconnect_all(&state);
    Ok(session)
}

/// 删除一个账号（契约 §7）。不许删掉最后一个；删的若是当前账号，
/// 当前指向会切到剩下的第一个，因此同样需要重连。
#[tauri::command]
async fn account_remove(state: State<'_, AppState>, name: String) -> ApiResult<SessionState> {
    let before = state.store.active_name();
    let session = state
        .auth
        .remove_account(&name)
        .await
        .map_err(ApiError::from)?;
    if state.store.active_name() != before {
        reconnect_all(&state);
    }
    Ok(session)
}

/// 登出：清空该账号的凭据（缺省 = 当前账号），**保留账号条目**（契约 §7）。
///
/// 清空后那个账号仍列在 `accounts_list` 里，只是 `logged_in = false`——
/// 既能退回游客态，又留住这个账号的位置，之后可以再登录回来。
#[tauri::command]
async fn account_logout(
    state: State<'_, AppState>,
    name: Option<String>,
) -> ApiResult<SessionState> {
    let explicit_other = name
        .as_deref()
        .is_some_and(|name| name != state.store.active_name());
    let session = state
        .auth
        .logout(name.as_deref())
        .await
        .map_err(ApiError::from)?;
    // 登出的是别的账号时，当前连接没变，不需要重连。
    if !explicit_other {
        reconnect_all(&state);
    }
    Ok(session)
}

/// 扫码登录的第一步：取回二维码内容并在本地编成 SVG（离线，不联网渲染）。
#[derive(serde::Serialize)]
struct QrStart {
    /// 轮询用的票据。
    key: String,
    /// 二维码里实际编码的 URL（也一并返回，便于给用户一个「在浏览器打开」的退路）。
    url: String,
    /// 二维码本体：SVG 源码，界面自己包成 data URI 显示。
    svg: String,
}

/// 生成二维码：不带 `target` = 新增账号，带 = 给该账号重新登录。
///
/// 新增时**不需要用户先起名**——账号名在确认后按扫码得到的昵称生成（重名加后缀），
/// 这是这次账号管理重写的核心顺序调整。
#[tauri::command]
async fn account_qr_start(
    state: State<'_, AppState>,
    target: Option<String>,
) -> ApiResult<QrStart> {
    let challenge = state
        .auth
        .begin_qr(target.as_deref())
        .await
        .map_err(ApiError::from)?;
    let code = qrcode::QrCode::new(challenge.url.as_bytes()).map_err(|error| {
        ApiError::from(danmubox_core::Error::Upstream(format!(
            "二维码编码失败：{error}"
        )))
    })?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build();
    Ok(QrStart {
        key: challenge.key,
        url: challenge.url,
        svg,
    })
}

/// 扫码登录的轮询：状态 + **确认时**落盘后的那个账号。
///
/// 确认那一次凭据已经写进文件、账号已经存在，界面直接拿到账号即可；
/// 当前账号因此变了，各房间要以新凭据重连。
#[tauri::command]
async fn account_qr_poll(state: State<'_, AppState>, key: String) -> ApiResult<QrPoll> {
    let before = state.store.active_name();
    let poll = state.auth.poll_qr(&key).await.map_err(ApiError::from)?;
    if poll.state == QrState::Confirmed || state.store.active_name() != before {
        reconnect_all(&state);
    }
    Ok(poll)
}

/// 让所有已连接房间用当前凭据重连（切号 / 登出后调用）。
fn reconnect_all(state: &State<'_, AppState>) {
    let rooms = state.rooms.lock().expect("rooms poisoned");
    for runtime in rooms.runtimes.values() {
        runtime.reconnect();
    }
}

/// 举报理由清单：上游固定 7 条，官方客户端按文案反查 `reason_id` 后一并上报。
#[tauri::command]
async fn report_reasons(state: State<'_, AppState>) -> ApiResult<Vec<ReportReason>> {
    let reporter = BiliReporter::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    reporter.reasons().await.map_err(ApiError::from)
}

#[tauri::command]
async fn follow_list(state: State<'_, AppState>) -> ApiResult<Vec<FollowedRoom>> {
    let catalog = BiliFollow::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    catalog.followed().await.map_err(ApiError::from)
}

#[tauri::command]
async fn wallet_balance(state: State<'_, AppState>) -> ApiResult<i64> {
    let wallet = BiliWallet::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    wallet.balance().await.map_err(ApiError::from)
}

// ---------------------------------------------------------------- 事件转发

/// 把事件总线上的事件转发给前端（`docs/ipc.md` §4 的五个事件名）。
///
/// `rooms` 是已登记房间（`AppState.rooms` 的同一份）：开播状态那条**先落登记表再推界面**
/// （见下面 `Event::LiveStatus` 那一支）。
fn spawn_event_forwarder(app: tauri::AppHandle, bus: EventBus, rooms: Arc<Mutex<Rooms>>) {
    let mut receiver = bus.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(Event::Message(message)) => {
                    let _ = app.emit("danmubox://message", &message);
                }
                Ok(Event::Status(status)) => {
                    let _ = app.emit("danmubox://status", &status);
                }
                Ok(Event::RoomStats(stats)) => {
                    let _ = app.emit("danmubox://room_stats", &stats);
                }
                Ok(Event::Room(room)) => {
                    let _ = app.emit("danmubox://room", &room);
                }
                // `LIVE` / `PREPARING`（`docs/protocol.md` §10.7 的侧路）：房间的开播状态变了。
                // 两步的顺序是有意的 —— **先**把状态落进登记表，**再**把改后的整条 `Room` 推给界面：
                // 登记表是界面另一个事实来源（`rooms_list` 在开房间 / 加房间 / 换号时都会重拉），
                // 不落它就会出现「刚看到开播，点一下别的房间又变回未开播」。
                Ok(Event::LiveStatus(status)) => {
                    let room = {
                        let mut rooms = rooms.lock().expect("rooms poisoned");
                        rooms.meta.get_mut(&status.room_id).map(|room| {
                            room.live_status = status.live_status;
                            room.clone()
                        })
                    };
                    match room {
                        Some(room) => {
                            let _ = app.emit("danmubox://room", &room);
                        }
                        // 能连上的房间都登记过，走不到这里；真走到也只记一笔，不推半条假元信息。
                        None => tracing::debug!(
                            room_id = status.room_id,
                            "开播状态事件来自未登记的房间，忽略"
                        ),
                    }
                }
                Ok(Event::Session(session)) => {
                    let _ = app.emit("danmubox://session", &session);
                }
                Ok(Event::RoomClosed(room_id)) => {
                    let _ = app.emit(
                        "danmubox://status",
                        &danmubox_core::bus::StatusEvent {
                            room_id,
                            state: danmubox_core::ConnState::Disconnected,
                            detail: "会话已关闭".into(),
                        },
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(dropped)) => {
                    tracing::warn!(dropped, "事件转发落后，部分事件被丢弃");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

// ---------------------------------------------------------------- 一键诊断

/// `diagnose_start` 的返回值（`docs/ipc.md` §3）：采集窗口的两端。
#[derive(Serialize)]
pub struct DiagnoseStart {
    pub started_ms: i64,
    /// 窗口截止时刻：界面按它倒计时，到点自动收工。
    pub ends_ms: i64,
}

/// `diagnose_export` 的返回值（`docs/ipc.md` §3）。
#[derive(Serialize)]
pub struct DiagnoseExport {
    /// 给用户看的位置（Android 上是 `/sdcard/Download/<名字>`，桌面端是绝对路径）。
    pub path: String,
    pub name: String,
    pub bytes: usize,
    /// 报告里带了几条连接尝试、几行日志（界面拿它显示「导出了什么」）。
    pub attempts: usize,
    pub logs: usize,
    pub started_ms: Option<i64>,
    pub ends_ms: Option<i64>,
}

/// 报告里**不许出现**的数字：本机已知的房间号 / 短号 / 主播 uid。
///
/// 为什么按值抹而不是按键名认：房间号出现的形状不止一种 —— 日志里是 `room_id=…`
/// （键名能认出来），`getDanmuInfo` 的查询串是 `?id=…`（`id=` 不可能进键名白名单，
/// 别的接口也用它），错误文案里还可能是一个裸数字。把已知值交给脱敏层逐值抹，
/// 比再猜一套键名可靠（`danmubox_bili::diagnose::render_report` 的第二个参数）。
///
/// 0 不进名单：上游没给短号 / 主播 uid 时结构体里就是 0，放进去会把报告里所有的 0
/// 一起抹掉。
fn secret_numbers(rooms: &Rooms) -> Vec<i64> {
    let mut numbers: Vec<i64> = rooms
        .meta
        .values()
        .flat_map(|room| [room.room_id, room.short_id, room.anchor_uid])
        .filter(|value| *value > 0)
        .collect();
    numbers.sort_unstable();
    numbers.dedup();
    numbers
}

/// 开始一次诊断采集（`docs/ipc.md` §3）。同步命令：只写窗口起点与截止时刻，
/// 不碰 IO、不占 runtime，因此可以在主线程上直接调用。
#[tauri::command]
fn diagnose_start(state: State<'_, AppState>, engine: String) -> DiagnoseStart {
    *state.engine.lock().expect("engine poisoned") = engine;
    let window = danmubox_core::diagnose::shared()
        .begin_window(danmubox_core::now_ms(), danmubox_core::diagnose::WINDOW_MS);
    tracing::info!(
        started_ms = window.started_ms,
        ends_ms = window.ends_ms,
        "一键诊断：开始采集（不会自动发送任何数据）"
    );
    DiagnoseStart {
        started_ms: window.started_ms,
        ends_ms: window.ends_ms,
    }
}

/// 导出诊断报告并结束采集（`docs/ipc.md` §3）。
///
/// 一次调用**恰好产出一个文件**：文本在这一条命令里渲染完、脱敏完，然后由
/// `diagnose::write_report` 一次写成（桌面端直接写目标路径，Android 往 MediaStore
/// 插一条）。导出之后采集窗口立刻关闭并清空内存里的采集内容。
#[tauri::command]
async fn diagnose_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<DiagnoseExport> {
    let now = danmubox_core::now_ms();
    let diag = danmubox_core::diagnose::shared();
    let snapshot = diag.snapshot(now);
    let env = diagnose::shell_env(&app, &state.engine.lock().expect("engine poisoned"));
    let secret_numbers = {
        let rooms = state.rooms.lock().expect("rooms poisoned");
        secret_numbers(&rooms)
    };

    let text = danmubox_bili::diagnose::render_report(&snapshot, &env, &secret_numbers);
    let name = diagnose::file_name(now);
    let path = diagnose::write_report(&app, &name, &text)
        .await
        .map_err(|message| ApiError {
            code: "INTERNAL".to_string(),
            message,
        })?;
    // 文件已经落地，内存里那份没有留着的理由（含最近几次连接的事实）。
    diag.reset();
    tracing::info!(path = %path, bytes = text.len(), "一键诊断：报告已导出");

    Ok(DiagnoseExport {
        path,
        name,
        bytes: text.len(),
        attempts: snapshot.attempts.len(),
        logs: snapshot.logs.len(),
        started_ms: snapshot.window.map(|window| window.started_ms),
        ends_ms: snapshot.window.map(|window| window.ends_ms),
    })
}

/// 前端把 `console.error` / `console.warn` 与未捕获错误转发到这里，
/// 使 Rust 侧一份日志就能覆盖前后端（配合 `DANMUBOX_LOG=debug`）。
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "danmubox::ui", "{message}"),
        "warn" => tracing::warn!(target: "danmubox::ui", "{message}"),
        _ => tracing::debug!(target: "danmubox::ui", "{message}"),
    }
}

/// 注入到界面的控制台桥。页面每次加载都会 eval 一次，因此自带去重标记。
const CONSOLE_BRIDGE: &str = r#"
(function () {
  if (window.__danmuboxLogBridge) return;
  window.__danmuboxLogBridge = true;
  var send = function (level, message) {
    try {
      if (isDuplicate(level + '\u0000' + String(message).slice(0, 200))) return;
      window.__TAURI_INTERNALS__.invoke('frontend_log', {
        level: level,
        message: String(message).slice(0, 2000),
      });
    } catch (e) { /* 桥本身出错时不再递归上报 */ }
  };
  var stringify = function (value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  };
  // 去重：同一条告警 1 秒内只上报一次。
  // 必要性：Rust 侧日志会回推成 danmubox://log，界面日志面板随 setState 重渲染；
  // 若某条告警在每次渲染都会复现（如 React 的重复 key），不回推去重就会形成
  // 「渲染 → 告警 → 日志 → 重渲染」的反馈环，实测一次会话能刷出 30 万行日志。
  var recent = new Map();
  var isDuplicate = function (key) {
    var now = Date.now();
    var last = recent.get(key);
    if (last !== undefined && now - last < 1000) return true;
    recent.set(key, now);
    if (recent.size > 200) recent.clear();
    return false;
  };
  ['error', 'warn'].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () {
      send(level, Array.prototype.map.call(arguments, stringify).join(' '));
      original.apply(null, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    send('error', (e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason && (e.reason.stack || e.reason.message) || e.reason;
    send('error', 'unhandledrejection: ' + stringify(reason));
  });
})();
"#;

/// 把 `tracing` 的日志行桥接成 `danmubox://log` 事件（`docs/ipc.md` §4）。
mod log_bridge {
    /// 逐条上游原始载荷的日志 target（`docs/protocol.md` 附录 B.1）：**不进**诊断报告。
    const RAW_TARGET: &str = "danmubox::raw";
    use tokio::sync::broadcast;
    use tracing::field::{Field, Visit};
    use tracing_subscriber::layer::{Context, Layer};
    use tracing_subscriber::registry::LookupSpan;

    pub struct BusLogLayer {
        tx: broadcast::Sender<String>,
    }

    impl BusLogLayer {
        pub fn new(tx: broadcast::Sender<String>) -> Self {
            Self { tx }
        }
    }

    /// 一次事件里我们要的两样东西：给人读的文案，与判据所在的字段。
    ///
    /// 字段必须单独收（而不是并进文案）：诊断报告要的 `idle_ms` / `code` /
    /// `room_id` 这些量**只活在字段里**，message 文案里根本没有
    /// （`docs/operations.md` §2.9：报告要能回答「卡在哪一环」，靠的就是它们）。
    /// 界面上的日志面板仍旧只看文案，格式一字未变。
    #[derive(Default)]
    struct MessageVisitor {
        message: String,
        fields: Vec<String>,
    }

    impl MessageVisitor {
        /// 诊断报告里那一行：文案在前、字段在后（先读结论，再对数字）。
        fn line(&self) -> String {
            if self.fields.is_empty() {
                return self.message.clone();
            }
            format!("{} {}", self.message, self.fields.join(" "))
        }
    }

    impl Visit for MessageVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.message = format!("{value:?}");
            } else {
                // 整数 / 布尔没单独实现 `record_*` 时会落到这里，`{:?}` 打出来即可。
                self.fields.push(format!("{}={value:?}", field.name()));
            }
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.message = value.to_string();
            } else {
                self.fields.push(format!("{}={value}", field.name()));
            }
        }
    }

    impl<S> Layer<S> for BusLogLayer
    where
        S: tracing::Subscriber + for<'a> LookupSpan<'a>,
    {
        fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = MessageVisitor::default();
            event.record(&mut visitor);
            if visitor.message.is_empty() {
                return;
            }
            let level = event.metadata().level();
            let target = event.metadata().target();
            let _ = self.tx.send(format!("{level} {}", visitor.message));
            // 一键诊断另存一份：只在采集窗口内，且**不收** `danmubox::raw`。
            //
            // 挡掉 raw 的理由是脱敏，不是体积：那一条按设计打的是**逐条上游原始载荷**
            // （`docs/protocol.md` 附录 B.1），里面的 uid 与昵称是**位置**上的裸值，
            // 脱敏规则（只认「键名 + 分隔符 + 值」）对它无能为力 —— 报告是要发出去的。
            if target != RAW_TARGET {
                let diag = danmubox_core::diagnose::shared();
                let now = danmubox_core::now_ms();
                // 先看那个原子量：没在采集时连时钟都不取（日志行是热路径）。
                if diag.recording_at(now) {
                    diag.log_line(now, &level.to_string(), target, &visitor.line());
                }
            }
        }
    }
}

// ---------------------------------------------------------------- 入口

/// 移动端：把数据目录钉到应用私有目录（`docs/contract.md` §4）。
///
/// 必须在**任何**路径被读取之前执行：`ConfigStore::load` 与 `Prefs::load` 都经
/// `danmubox_core::paths` 解析目录，而那里的非 mac/win 分支落到
/// `$HOME/.local/share/danmubox`——在 Android 上那不是系统认的应用私有数据位置，
/// 进程 CWD 还不可写。真正的私有目录只有 Tauri 知道（`app_data_dir()`），
/// 所以由外壳在启动最早期把 `DANMUBOX_HOME` 注入进去，core 侧保持平台无关。
///
/// 回一个路径只为打日志；目录名不是凭据（`AGENT.md` §8 第 1 条禁的是凭据）。
#[cfg(mobile)]
fn pin_data_dir(app: &tauri::App) -> std::path::PathBuf {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("解析应用数据目录失败：{err}");
            std::process::exit(1);
        }
    };
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("创建应用数据目录失败：{err}");
        std::process::exit(1);
    }
    std::env::set_var("DANMUBOX_HOME", &dir);
    dir
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (log_tx, mut log_rx) = tokio::sync::broadcast::channel::<String>(256);

    {
        use tracing_subscriber::layer::SubscriberExt as _;
        use tracing_subscriber::util::SubscriberInitExt as _;
        let filter = tracing_subscriber::EnvFilter::try_from_env("DANMUBOX_LOG")
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
        // 桌面端总是被重定向到日志文件（或 PTY），ANSIC 颜色码只会污染文件、
        // 让 grep/解析失效，因此固定关闭。
        let fmt_layer = tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_ansi(false);
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .with(log_bridge::BusLogLayer::new(log_tx))
            .try_init();
    }

    let builder = tauri::Builder::default();
    // Android 的「用系统浏览器打开链接」没有系统命令可调，只能走平台 Intent，
    // 因此只在 Android 上挂官方 opener 插件（见 `open_url`）：桌面构建一字不变。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_opener::init());
    // 一键诊断在 Android 上要把报告写进**公共下载目录**，那只能走原生（见 `diagnose`）。
    #[cfg(target_os = "android")]
    let builder = builder.plugin(diagnose::android::plugin());

    builder
        // 白屏排查的入口：这里没有输出就说明 webview 根本没导航成功。
        .on_page_load(|webview, payload| {
            tracing::debug!(url = %payload.url(), "webview 页面加载");
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(CONSOLE_BRIDGE);
            }
        })
        .setup(move |app| {
            // 移动端：数据目录必须在**第一次读路径之前**钉死（桌面端走 core 的平台目录，
            // 因此这条分支在桌面端不存在，行为与从前完全一致）。
            #[cfg(mobile)]
            {
                let dir = pin_data_dir(app);
                tracing::debug!(dir = %dir.display(), "数据目录");
            }

            let store = match ConfigStore::load(config_path()) {
                Ok(store) => Arc::new(store),
                Err(err) => {
                    eprintln!("读取凭据文件失败：{err}");
                    std::process::exit(1);
                }
            };

            let state = match AppState::new(store) {
                Ok(state) => state,
                Err(err) => {
                    eprintln!("初始化鉴权失败：{err}");
                    std::process::exit(1);
                }
            };
            // 命令在 setup 之后才可能被调用，因此 `State<AppState>` 照旧可用。
            app.manage(state);

            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            spawn_event_forwarder(handle.clone(), state.bus.clone(), Arc::clone(&state.rooms));

            // 日志行 → danmubox://log
            tauri::async_runtime::spawn(async move {
                while let Ok(line) = log_rx.recv().await {
                    let _ = handle.emit("danmubox://log", line);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            session_status,
            accounts_list,
            account_switch,
            account_remove,
            account_logout,
            account_qr_start,
            account_qr_poll,
            rooms_list,
            rooms_refresh_status,
            rooms_add,
            rooms_remove,
            rooms_connect,
            rooms_disconnect,
            rooms_reconnect,
            history_query,
            room_session,
            chat_send,
            chat_report,
            report_reasons,
            emotes_list,
            emotes_owned,
            admin_mute,
            admin_unmute,
            admin_silent_list,
            admin_blacklist_list,
            admin_blacklist_add,
            admin_blacklist_del,
            admin_keywords_list,
            admin_keywords_add,
            admin_keywords_del,
            follow_list,
            wallet_balance,
            open_url,
            prefs_get,
            prefs_set,
            diagnose_start,
            diagnose_export,
            frontend_log
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmubox_core::bus::{Cancel, ConnState, MessageSink};
    use danmubox_core::ports::SendReport;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn report(outcome: SendOutcome, code: Option<i64>, message: Option<&str>) -> SendReport {
        SendReport {
            outcome,
            upstream_code: code,
            upstream_message: message.map(str::to_owned),
        }
    }

    #[test]
    fn success_carries_no_detail() {
        assert_eq!(
            send_detail(&report(SendOutcome::Ok, Some(0), Some("ok"))),
            None
        );
    }

    #[test]
    fn failure_shows_upstream_words_and_code_verbatim() {
        // 真实样本：房间 5440（登录态）发送被拒。
        let detail = send_detail(&report(
            SendOutcome::Failed,
            Some(10023),
            Some("发送失败，请先移除该用户黑名单"),
        ))
        .expect("失败必须给出原因");
        assert!(
            detail.contains("发送失败，请先移除该用户黑名单"),
            "{detail}"
        );
        assert!(detail.contains("10023"), "{detail}");
    }

    #[test]
    fn partial_upstream_answers_still_render_something() {
        assert_eq!(
            send_detail(&report(SendOutcome::Failed, Some(-400), None)).as_deref(),
            Some("code -400")
        );
        assert_eq!(
            send_detail(&report(SendOutcome::Failed, None, Some("被拦下"))).as_deref(),
            Some("被拦下")
        );
        assert_eq!(send_detail(&report(SendOutcome::Failed, None, None)), None);
    }

    #[test]
    fn swallowed_outcomes_also_explain_themselves() {
        // 被吞不是 ok，界面同样要给说法。
        assert!(send_detail(&report(SendOutcome::BlockedPlatform, Some(0), Some("f"))).is_some());
        assert!(send_detail(&report(SendOutcome::BlockedRoom, Some(0), Some("k"))).is_some());
    }

    /// 假适配器：只记「被叫起来连接了几次」，报一次已连接后挂起等取消。
    struct CountingLive {
        attempts: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl LiveSource for CountingLive {
        async fn recent(&self, _room_id: i64) -> danmubox_core::Result<Vec<Message>> {
            Ok(Vec::new())
        }

        async fn resolve_room(&self, _input: &str) -> danmubox_core::Result<Room> {
            Ok(Room::default())
        }

        // 这条票只测会话重建：开播状态给未开播即可。
        async fn live_status(&self, _room_id: i64) -> danmubox_core::Result<i32> {
            Ok(0)
        }

        async fn room_identity(&self, room_id: i64) -> danmubox_core::Result<RoomSession> {
            Ok(RoomSession {
                room_id,
                ..Default::default()
            })
        }

        async fn stream(
            &self,
            room_id: i64,
            sink: MessageSink,
            cancel: Cancel,
        ) -> danmubox_core::Result<()> {
            let nth = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
            sink.publish_status(room_id, ConnState::Connected, format!("第 {nth} 次连接"));
            cancel.cancelled().await;
            Ok(())
        }
    }

    async fn settle() {
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
    }

    #[tokio::test]
    async fn refresh_after_disconnect_reconnects_instead_of_failing() {
        // 房间号用公开测试房间，避免把任何真实房间号写进仓库（契约 §4.1）。
        const ROOM: i64 = 1;
        let bus = EventBus::new(BUS_CAPACITY);
        let counters = Arc::new(Counters::default());
        let attempts = Arc::new(AtomicUsize::new(0));
        let source: Arc<dyn LiveSource> = Arc::new(CountingLive {
            attempts: Arc::clone(&attempts),
        });
        let mut rooms = Rooms::default();
        rooms.meta.insert(
            ROOM,
            Room {
                room_id: ROOM,
                ..Default::default()
            },
        );

        // ① 进房间：建会话，适配器去连。
        spawn_runtime(
            &mut rooms,
            ROOM,
            BufferCaps::default(),
            bus.clone(),
            Arc::clone(&counters),
            Arc::clone(&source),
        )
        .unwrap();
        settle().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "进房间必须真的去连");

        // ② 断开连接：`rooms_disconnect` 的效果就是会话被摘掉、缓冲随之销毁。
        let runtime = rooms.runtimes.remove(&ROOM).expect("会话应该在");
        runtime.close().await.unwrap();
        assert!(!rooms.runtimes.contains_key(&ROOM));

        // ③ 刷新连接：会话没了也必须把连接拉回来（旧实现返回 `ROOM_NOT_FOUND`，
        //    界面上这颗键就是死的，用户只能退出房间再进来）。
        let mut events = bus.subscribe();
        refresh_room(
            &mut rooms,
            ROOM,
            BufferCaps::default(),
            bus.clone(),
            Arc::clone(&counters),
            || Ok(Arc::clone(&source)),
        )
        .expect("断连后刷新不得报错");
        settle().await;

        assert!(
            rooms.runtimes.contains_key(&ROOM),
            "刷新必须重新建起会话（否则房间永远停在断连态）"
        );
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "刷新必须真的再发起一次连接，而不是只把状态改回去"
        );

        // 状态不得停在断连：刷完之后总线上必须出现这条新连接的状态事件。
        let mut last_state = None;
        while let Ok(event) = events.try_recv() {
            if let Event::Status(status) = event {
                if status.room_id == ROOM {
                    last_state = Some(status.state);
                }
            }
        }
        assert_eq!(
            last_state,
            Some(ConnState::Connected),
            "刷新之后必须回到「已连接」这一档"
        );

        rooms
            .runtimes
            .remove(&ROOM)
            .expect("会话应该在")
            .close()
            .await
            .unwrap();
    }

    /// 回归（应用级 panic）：`rooms_reconnect` 是**同步** command，Tauri 把它跑在
    /// 主线程上——那里没有 Tokio runtime 上下文。「断连之后再点刷新」会当场新建
    /// 一次会话（`refresh_room` → `spawn_runtime` → `RoomRuntime::spawn`），只要这
    /// 条路径把「当前线程一定有 runtime」当成理所当然，应用就会在用户点「刷新连接」
    /// 那一刻 panic 退出，而不是把连接连回来。
    ///
    /// 所以这条测试**故意不**进 `#[tokio::test]`：它要的就是「当前线程没有 runtime」
    /// 这个真实处境。断言的是可观察结果——会话真的建起来了。
    #[test]
    fn spawning_session_without_ambient_runtime_must_not_panic() {
        // 房间号用公开测试房间，避免把任何真实房间号写进仓库（契约 §4.1）。
        const ROOM: i64 = 1;
        let bus = EventBus::new(BUS_CAPACITY);
        let counters = Arc::new(Counters::default());
        let source: Arc<dyn LiveSource> = Arc::new(CountingLive {
            attempts: Arc::new(AtomicUsize::new(0)),
        });
        let mut rooms = Rooms::default();
        rooms.meta.insert(
            ROOM,
            Room {
                room_id: ROOM,
                ..Default::default()
            },
        );

        spawn_runtime(
            &mut rooms,
            ROOM,
            BufferCaps::default(),
            bus,
            counters,
            source,
        )
        .expect("主线程（无 runtime 上下文）上刷新也必须能把会话建起来");

        assert!(
            rooms.runtimes.contains_key(&ROOM),
            "会话必须真的建起来，连接才可能回得来"
        );

        drop(rooms);
    }
}
