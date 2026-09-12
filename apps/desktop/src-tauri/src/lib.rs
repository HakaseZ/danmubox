//! 弹幕框桌面端：Tauri 2 外壳与 IPC 命令层（`docs/ipc.md` 的实现侧）。
//!
//! 本 crate 只做三件事：把 `danmubox-core` 的端口与引擎挂到 IPC 上、
//! 把事件总线转发给前端、把错误映射成契约 §7 的错误模型。
//! **不包含任何 B 站协议知识**（那属于 `danmubox-bili`）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use danmubox_bili::{
    BiliAuth, BiliEmotes, BiliFollow, BiliLive, BiliReporter, BiliSender, BiliWallet,
};
use danmubox_core::ports::{
    AuthProvider, DanmakuReporter, DanmakuSender, EmoteProvider, LiveSource, RoomCatalog,
    SessionState, WalletProvider,
};
use danmubox_core::{
    config_path, data_dir, prefs_path, ConfigStore, Counters, Emote, Event, EventBus, FollowedRoom,
    HistoryQuery, Message, MessageKind, Prefs, ReportReason, Room, RoomRuntime, RoomSession,
    SendOutcome,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

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
    bus: EventBus,
    counters: Arc<Counters>,
    prefs: Mutex<Prefs>,
    rooms: Mutex<Rooms>,
}

impl AppState {
    pub fn new(store: Arc<ConfigStore>) -> Self {
        let prefs = Prefs::load(&prefs_path());
        Self {
            store,
            bus: EventBus::new(BUS_CAPACITY),
            counters: Arc::new(Counters::default()),
            prefs: Mutex::new(prefs),
            rooms: Mutex::new(Rooms::default()),
        }
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
    let auth = BiliAuth::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    auth.session().await.map_err(ApiError::from)
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
    let buffer_rows = state.prefs.lock().expect("prefs poisoned").buffer_rows();

    // **存在性检查与插入必须在同一把锁内完成**：界面在 StrictMode 下会并发触发连接，
    // 若分两次加锁，两个调用都会通过检查并各自 `spawn` 一个运行时——于是同一个房间
    // 会有两套会话缓冲，两套都从 `local_id = 1` 开始回填，界面收到重复 id
    // （表现为 React 报「two children with the same key, 1」且刷满日志）。
    // `RoomRuntime::spawn` 是同步的（内部只起任务），因此在锁内构造是安全的。
    let mut rooms = state.rooms.lock().expect("rooms poisoned");
    if rooms.runtimes.contains_key(&room_id) {
        return Ok(());
    }
    let Some(room) = rooms.meta.get(&room_id).cloned() else {
        return Err(ApiError::from(danmubox_core::Error::RoomNotFound(
            format!("房间 {room_id} 未登记"),
        )));
    };
    let runtime = RoomRuntime::spawn(
        room,
        buffer_rows,
        state.bus.clone(),
        Arc::clone(&state.counters),
        source,
    );
    rooms.runtimes.insert(room_id, runtime);
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
    let rooms = state.rooms.lock().expect("rooms poisoned");
    let runtime = rooms.runtimes.get(&room_id).ok_or_else(|| ApiError {
        code: "ROOM_NOT_FOUND".into(),
        message: format!("房间 {room_id} 尚未连接"),
    })?;
    runtime.reconnect();
    Ok(())
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
        .send(room_id, &content, color, None, emote.as_ref(), reply.as_ref())
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
/// 刻意不引入 `tauri-plugin-opener`：桌面三端各一条系统命令就够，
/// 少一个依赖、少一份 capability 配置。Android 端目前没有可用路径，
/// 明确返回不支持而不是静默失败（`docs/roadmap.md` 的交付形态里 Android 尚未开工）。
#[tauri::command]
fn open_url(url: String) -> ApiResult<()> {
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
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
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

#[tauri::command]
async fn emotes_list(state: State<'_, AppState>, room_id: i64) -> ApiResult<Vec<Emote>> {
    let provider = BiliEmotes::new(Arc::clone(&state.store)).map_err(ApiError::from)?;
    // 我在该房间的身份（粉丝牌 / 大航海 / 房管）尚未采集，先按零身份请求；
    // 上游若已按身份下发可用包，这不影响结果。身份采集见 docs/protocol.md 的待实测项。
    let session = RoomSession {
        room_id,
        ..Default::default()
    };
    provider
        .emotes(room_id, &session)
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
fn spawn_event_forwarder(app: tauri::AppHandle, bus: EventBus) {
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
                Ok(Event::Popularity { room_id, value }) => {
                    let _ = app.emit(
                        "danmubox://popularity",
                        &serde_json::json!({ "room_id": room_id, "value": value }),
                    );
                }
                Ok(Event::Room(room)) => {
                    let _ = app.emit("danmubox://room", &room);
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

    #[derive(Default)]
    struct MessageVisitor(String);

    impl Visit for MessageVisitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            if field.name() == "message" {
                self.0 = format!("{value:?}");
            }
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.0 = value.to_string();
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
            if visitor.0.is_empty() {
                return;
            }
            let line = format!("{} {}", event.metadata().level(), visitor.0);
            let _ = self.tx.send(line);
        }
    }
}

// ---------------------------------------------------------------- 入口

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

    let store = match ConfigStore::load(config_path()) {
        Ok(store) => Arc::new(store),
        Err(err) => {
            eprintln!("读取凭据文件失败：{err}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .manage(AppState::new(store))
        // 白屏排查的入口：这里没有输出就说明 webview 根本没导航成功。
        .on_page_load(|webview, payload| {
            tracing::debug!(url = %payload.url(), "webview 页面加载");
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(CONSOLE_BRIDGE);
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            spawn_event_forwarder(handle.clone(), state.bus.clone());

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
            rooms_list,
            rooms_add,
            rooms_remove,
            rooms_connect,
            rooms_disconnect,
            rooms_reconnect,
            history_query,
            chat_send,
            chat_report,
            report_reasons,
            emotes_list,
            follow_list,
            wallet_balance,
            open_url,
            prefs_get,
            prefs_set,
            frontend_log
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmubox_core::ports::SendReport;

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
        assert!(detail.contains("发送失败，请先移除该用户黑名单"), "{detail}");
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
}
