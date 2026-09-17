//! 一键诊断：连接可观测事实的采集器（`docs/operations.md` §2.9）。
//!
//! 定位：把「连上了却收不到弹幕」这类问题**卡在哪一环**需要的事实，在内存里记成
//! 有界的环，然后在用户点「导出」时一次性落成一个文件。本模块只管**采集**与
//! **快照的形态**，不认识任何上游词汇（`op=7` / `getDanmuInfo` 这类名字属于
//! `danmubox-bili`，由那边在渲染时贴上去）。
//!
//! 三条设计口径，都是为了「一次诊断只出一个文件、跑完不留残留」：
//!
//! - **常驻但不落盘**：连接尝试（[`Attempt`]）一直在记，环长 [`ATTEMPT_CAP`]；
//!   断连前后的那几次尝试因此都看得见，而不是「点了诊断才开始记，于是什么都没记到」。
//! - **窗口只影响日志**：日志行（[`Diagnoser::log_line`]）与未识别命令名单只在
//!   [`Diagnoser::begin_window`] 之后的窗口内收 —— 否则一次会话能攒出几十万行。
//!   窗口自带截止时刻，到点自动失效，因此界面不导出也不会留下「永远在采」的状态。
//! - **全部在内存**：没有临时文件、没有后台写盘。唯一的 IO 发生在导出那一刻，
//!   由外壳层（`apps/desktop`）做，见 [`DiagSnapshot`]。

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use crate::bus::{CounterSnapshot, Counters};

/// 一次诊断的采集窗口时长（`docs/contract.md` §4.4）。
///
/// 3 分钟的理由：「连上了却收不到弹幕」的判据是**入站静默**，而僵死护栏是 90 秒
/// （`docs/protocol.md` §8.1）；窗口短于它，一次僵死都还没轮到就已经结束，
/// 报告里只会有一条「还在连着」。3 分钟够跨过至少一轮僵死 + 一次退避重连。
pub const WINDOW_MS: i64 = 180_000;

/// 保留多少次连接尝试（环）。够覆盖「连续认证失败 3 次 + 换节点」的完整一轮。
const ATTEMPT_CAP: usize = 16;
/// 窗口内保留多少行日志（环）。实测 3 分钟正常会话是几十行（`info` 级）；
/// 开了 `DANMUBOX_LOG=debug` 时增长快，2000 行足以覆盖窗口内的关键路径，
/// 且单文件有上界（每行 [`LOG_TEXT_CAP`] 字节）。
const LOG_CAP: usize = 2000;
/// 单行日志的截断长度：一条超长的行（例如被 `Debug` 打出来的大对象）不该把整份报告撑爆。
const LOG_TEXT_CAP: usize = 4_000;
/// 未识别命令名单保留多少种名字；超出的只计数（[`DiagSnapshot::unknown_dropped`]）。
const UNKNOWN_CMD_CAP: usize = 32;

/// 采集窗口：`started_ms` 是点下「一键诊断」的时刻，`ends_ms` 是它的截止时刻。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub started_ms: i64,
    pub ends_ms: i64,
}

/// 一次连接尝试的可观测事实（时间一律 UTC 毫秒；未发生的阶段是 `None`）。
///
/// 「一次尝试」= 从取票据到连接结束的一个轮回，与 `danmubox-bili` 的重连循环
/// 一一对应；成功连上之后它会一直**进行中**（[`AttemptRecord::end_ms`] 为 `None`），
/// 因此「现在到底连没连上、静默多久了」在导出时是活的、不是快照里的旧值。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttemptRecord {
    /// 本次尝试开始（发起票据请求）的时刻。
    pub started_ms: i64,
    /// 票据请求返回的时刻；`None` = 还在路上或没走到这一步。
    pub ticket_ms: Option<i64>,
    /// 票据请求的 `code`（0 = 成功）。上游用非 0 表达各种拒绝。
    pub ticket_code: Option<i64>,
    /// 票据失败时的文案（含 `code` 与原因）。
    pub ticket_error: Option<String>,
    /// 选中的候选节点下标（`host_list` 里的序号，`docs/protocol.md` §15.3）。
    /// 一个都没接上时是**起始候选**的下标（§15.3：它同样算一次失败）。
    pub node_index: Option<usize>,
    /// 选中/起始候选的主机名；一个都没接上时为 `None`。
    pub node: Option<String>,
    /// 本轮里拨号失败的候选个数（每个候选一次拨号超时 / 被拒都算一个）。
    pub dial_failures: u64,
    /// WS 握手完成的时刻。
    pub dial_ms: Option<i64>,
    /// 认证包**发出**的时刻。
    pub auth_sent_ms: Option<i64>,
    /// 认证回应**到达**的时刻。
    pub auth_reply_ms: Option<i64>,
    /// 认证回应的 `code`（0 = 成功）。
    pub auth_code: Option<i64>,
    /// 首个入站帧（认证回应之外的任何帧都算）到达的时刻。
    pub first_inbound_ms: Option<i64>,
    /// 首条**业务**载荷到达的时刻 —— 「连上了却收不到弹幕」就看这一项有没有值。
    pub first_business_ms: Option<i64>,
    /// 最近一次入站帧的时刻；`None` = 至今没有任何入站帧。
    pub last_inbound_ms: Option<i64>,
    /// 认证通过之后的入站帧条数。「连上了却收不到弹幕」= 这一项长期不动。
    pub inbound_frames: u64,
    /// 业务载荷的条数（含被识别为「已知但无关」的那些）。
    pub business_frames: u64,
    /// 结束时刻；`None` = 进行中。
    pub end_ms: Option<i64>,
    /// 结束原因（人话，来自连接层；不含房间号与任何标识）。
    pub end_reason: Option<String>,
    /// 本次尝试是否认证成功过（决定「连续认证失败」是否清零）。
    pub verified: bool,
    /// 本次结束之后等待的退避时长（`next_backoff` 的结果）。
    pub backoff_ms: Option<u64>,
    /// 本次结束之后的**连续认证失败次数**。
    pub auth_failures_after: Option<u32>,
}

/// 窗口内的一行日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogLine {
    pub ts_ms: i64,
    /// `TRACE` / `DEBUG` / `INFO` / `WARN` / `ERROR`。
    pub level: String,
    /// `tracing` 的 target（`danmubox::ui` 一类）。
    pub target: String,
    /// 已格式化的一行（含字段）。
    pub text: String,
}

/// 采集到的一份快照：渲染报告所需的全部东西。
#[derive(Debug, Clone, Default)]
pub struct DiagSnapshot {
    /// 取快照的时刻。
    pub now_ms: i64,
    /// 本次采集窗口；`None` = 没在采集（用户直接导出）。
    pub window: Option<Window>,
    /// 连接尝试，按时间升序（最后一条可能是进行中的那一次）。
    pub attempts: Vec<AttemptRecord>,
    /// 窗口内的日志，按时间升序。
    pub logs: Vec<LogLine>,
    /// 因环满而丢掉的日志行数。
    pub logs_dropped: u64,
    /// 窗口内的未识别命令：`(cmd 名, 次数)`，按名字升序。
    pub unknown_cmds: Vec<(String, u64)>,
    /// 因名单超上限而**没记下名字**的种类数（这些命令的次数也不进总和，
    /// 因此 [`Self::unknown_cmd_total`] 是「名单覆盖到的次数」）。
    pub unknown_dropped: u64,
    /// 最近一次连接周期的协议计数（[`Diagnoser::note_counters`] 记下的那一个）。
    pub counters: Option<CounterSnapshot>,
}

impl DiagSnapshot {
    /// 窗口内未识别命令的总次数（名单里各项之和）。
    pub fn unknown_cmd_total(&self) -> u64 {
        self.unknown_cmds.iter().map(|(_, count)| count).sum()
    }

    /// 最近一次连接尝试（可能就是当前这条活着的连接）。
    pub fn last_attempt(&self) -> Option<&AttemptRecord> {
        self.attempts.last()
    }

    /// 当前是否有一条**认证成功且仍在进行**的连接。
    pub fn connected_now(&self) -> bool {
        self.last_attempt()
            .map(|attempt| attempt.verified && attempt.end_ms.is_none())
            .unwrap_or(false)
    }

    /// 距最近一次入站帧过了多久（毫秒）；没有任何入站帧时是 `None`。
    pub fn idle_ms(&self) -> Option<i64> {
        self.last_attempt()
            .and_then(|attempt| attempt.last_inbound_ms)
            .map(|at| self.now_ms - at)
    }

    /// 当前这条连接已经活了多久（毫秒）；没有活着的连接时是 `None`。
    pub fn uptime_ms(&self) -> Option<i64> {
        let attempt = self.last_attempt()?;
        attempt
            .end_ms
            .is_none()
            .then(|| self.now_ms - attempt.started_ms)
    }
}

/// 平台与版本信息（`docs/operations.md` §2.9 的「报告头」）。
///
/// 由外壳填：core 拿不到应用版本，也拿不到 webview 的引擎标识。
#[derive(Debug, Clone, Default)]
pub struct ShellEnv {
    /// `std::env::consts::OS`。
    pub os: String,
    /// `std::env::consts::ARCH`。
    pub arch: String,
    /// 应用版本（`tauri::AppHandle::package_info`）。
    pub app_version: String,
    /// 渲染引擎标识（前端 `navigator.userAgent`）：桌面端就是 WKWebView / WebView2，
    /// Android 就是系统 WebView 的版本 —— 白屏一类问题同时取决于它。
    pub engine: String,
    /// `DANMUBOX_LOG` 当前生效的值：决定窗口内收得到多少细节。
    pub log_level: String,
}

/// 采集器。进程内**只有一个**（[`shared`]）：界面上一键诊断是全局动作，
/// 同一时刻也只可能有一个窗口，做成进程级状态才与语义一致，也省掉把句柄
/// 一路穿到连接层（那里已经有三个带下去的句柄了）。
#[derive(Default)]
pub struct Diagnoser {
    inner: Mutex<Inner>,
    /// 采集**截止时刻**（UTC 毫秒；0 = 未采集）的无锁影子。
    ///
    /// 为什么要有它：日志行是热路径，未采集时必须**零成本**地挡掉（连锁都不取）。
    /// 它同时承载「窗口到点自动失效」这条语义：采集是自己过期的，不依赖界面
    /// 记得回来关（用户点了诊断又直接退出应用、或干脆没导出，都不会留下
    /// 「永远在采」的状态）。
    deadline_ms: AtomicI64,
}

#[derive(Default)]
struct Inner {
    window: Option<Window>,
    attempts: VecDeque<Arc<Attempt>>,
    logs: VecDeque<LogLine>,
    logs_dropped: u64,
    unknown_cmds: BTreeMap<String, u64>,
    unknown_dropped: u64,
    counters: Option<Arc<Counters>>,
}

/// 单次连接尝试的写入句柄。各阶段由连接层在事件发生处调用，
/// 每次调用只锁**这一次尝试**自己的记录，不会与别的房间或渲染互相挡。
#[derive(Debug)]
pub struct Attempt {
    record: Mutex<AttemptRecord>,
}

impl Attempt {
    fn edit(&self, change: impl FnOnce(&mut AttemptRecord)) {
        let mut record = self.record.lock().expect("diag attempt poisoned");
        change(&mut record);
    }

    /// 本次尝试的记录副本。
    pub fn record(&self) -> AttemptRecord {
        self.record.lock().expect("diag attempt poisoned").clone()
    }

    /// 票据请求成功返回（`code` 一并留下：非 0 也走这里，由渲染层解释）。
    pub fn ticket_ok(&self, at_ms: i64, code: i64) {
        self.edit(|record| {
            record.ticket_ms = Some(at_ms);
            record.ticket_code = Some(code);
        });
    }

    /// 票据请求失败（网络 / 解析 / 非 0 code，文案原样保留）。
    pub fn ticket_failed(&self, at_ms: i64, error: &str) {
        self.edit(|record| {
            record.ticket_ms = Some(at_ms);
            record.ticket_error = Some(error.to_string());
        });
    }

    /// 选中了候选节点（`host_list` 的下标 + 主机名；一个都没接上时 `host` 为 `None`）。
    pub fn node(&self, index: usize, host: Option<&str>) {
        self.edit(|record| {
            record.node_index = Some(index);
            record.node = host.map(str::to_string);
        });
    }

    /// 一个候选拨号失败（超时 / 被拒 / 构造请求失败）。
    pub fn dial_failed(&self) {
        self.edit(|record| record.dial_failures += 1);
    }

    /// WS 握手完成。
    pub fn dialed(&self, at_ms: i64) {
        self.edit(|record| record.dial_ms = Some(at_ms));
    }

    /// 认证包发出。
    pub fn auth_sent(&self, at_ms: i64) {
        self.edit(|record| record.auth_sent_ms = Some(at_ms));
    }

    /// 认证回应到达（`code` 缺失也记下「到了」这件事）。
    ///
    /// `code == 0` 同时把「认证成功过」立起来：连接还活着的时候没有任何收场事件，
    /// 「当前这条连接是通的」就只能靠这一刻记下的状态（`ended` 到那时才可能被调到）。
    pub fn auth_reply(&self, at_ms: i64, code: Option<i64>) {
        self.edit(|record| {
            record.auth_reply_ms = Some(at_ms);
            record.auth_code = code;
            if code == Some(0) {
                record.verified = true;
            }
        });
    }

    /// 收到一个入站帧：首个、最近一个与总数都在这里累。
    ///
    /// **每帧都调**（这是判「有没有在喂」的唯一依据），因此实现要便宜：
    /// 一次无竞争的 mutex + 三个字段赋值。
    pub fn inbound(&self, at_ms: i64) {
        self.edit(|record| {
            if record.first_inbound_ms.is_none() {
                record.first_inbound_ms = Some(at_ms);
            }
            record.last_inbound_ms = Some(at_ms);
            record.inbound_frames += 1;
        });
    }

    /// 收到一条**业务**载荷（解出来是业务 JSON 的那种，不是心跳 / 控制帧）。
    pub fn business(&self, at_ms: i64) {
        self.edit(|record| {
            if record.first_business_ms.is_none() {
                record.first_business_ms = Some(at_ms);
            }
            record.business_frames += 1;
        });
    }

    /// 本次尝试结束。
    pub fn ended(&self, at_ms: i64, reason: &str, verified: bool) {
        self.edit(|record| {
            record.end_ms = Some(at_ms);
            record.end_reason = Some(reason.to_string());
            record.verified = verified;
        });
    }

    /// 结束之后的退避时长与连续认证失败次数（重连历史的两个关键量）。
    pub fn backoff(&self, ms: u64, auth_failures_after: u32) {
        self.edit(|record| {
            record.backoff_ms = Some(ms);
            record.auth_failures_after = Some(auth_failures_after);
        });
    }
}

impl Diagnoser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开一个采集窗口并**清掉上一次的窗口产物**（日志环与未识别名单）：
    /// 一次诊断只对应一个文件，上一次的日志不该混进这一次。
    pub fn begin_window(&self, now_ms: i64, duration_ms: i64) -> Window {
        let window = Window {
            started_ms: now_ms,
            ends_ms: now_ms + duration_ms.max(1),
        };
        {
            let mut inner = self.inner.lock().expect("diag poisoned");
            inner.window = Some(window);
            inner.logs.clear();
            inner.logs_dropped = 0;
            inner.unknown_cmds.clear();
            inner.unknown_dropped = 0;
        }
        self.deadline_ms.store(window.ends_ms, Ordering::Relaxed);
        window
    }

    /// 当前窗口（若已过期则为 `None`，并顺手把采集关掉）。
    pub fn window(&self) -> Option<Window> {
        self.window_at(crate::now_ms())
    }

    /// [`Self::window`] 的显式时刻版（测试与需要确定性时刻的调用方用）。
    pub fn window_at(&self, now_ms: i64) -> Option<Window> {
        let window = self.inner.lock().expect("diag poisoned").window;
        match window {
            Some(window) if now_ms < window.ends_ms => Some(window),
            Some(_) => {
                self.close_window();
                None
            }
            None => None,
        }
    }

    /// 采集是否进行中。**热路径的门**：只读一个原子量，未采集时连锁都不取。
    pub fn recording_at(&self, now_ms: i64) -> bool {
        now_ms < self.deadline_ms.load(Ordering::Relaxed)
    }

    /// 关掉采集。窗口到点、或导出完成时调用。
    pub fn close_window(&self) {
        self.deadline_ms.store(0, Ordering::Relaxed);
        self.inner.lock().expect("diag poisoned").window = None;
    }

    /// 收一行日志。**只在窗口内收**；`danmubox::raw` 那类原始载荷由调用方挡掉
    /// （见 `apps/desktop` 的日志层：那是逐条上游载荷，脱敏规则对它无能为力）。
    pub fn log_line(&self, now_ms: i64, level: &str, target: &str, text: &str) {
        if !self.recording_at(now_ms) {
            return;
        }
        let line = LogLine {
            ts_ms: now_ms,
            level: level.to_string(),
            target: target.to_string(),
            text: truncate(text, LOG_TEXT_CAP),
        };
        let mut inner = self.inner.lock().expect("diag poisoned");
        if inner.logs.len() >= LOG_CAP {
            inner.logs.pop_front();
            inner.logs_dropped += 1;
        }
        inner.logs.push_back(line);
    }

    /// 开始一次连接尝试，返回它的写入句柄。
    pub fn begin_attempt(&self, now_ms: i64) -> Arc<Attempt> {
        let attempt = Arc::new(Attempt {
            record: Mutex::new(AttemptRecord {
                started_ms: now_ms,
                ..Default::default()
            }),
        });
        let mut inner = self.inner.lock().expect("diag poisoned");
        if inner.attempts.len() >= ATTEMPT_CAP {
            inner.attempts.pop_front();
        }
        inner.attempts.push_back(Arc::clone(&attempt));
        attempt
    }

    /// 记一条**窗口内**出现的未识别命令（名单 + 次数）。
    pub fn note_unknown_cmd(&self, now_ms: i64, cmd: &str) {
        if !self.recording_at(now_ms) {
            return;
        }
        let mut inner = self.inner.lock().expect("diag poisoned");
        if let Some(count) = inner.unknown_cmds.get_mut(cmd) {
            *count += 1;
            return;
        }
        if inner.unknown_cmds.len() >= UNKNOWN_CMD_CAP {
            inner.unknown_dropped += 1;
            return;
        }
        inner.unknown_cmds.insert(cmd.to_string(), 1);
    }

    /// 记下当前连接周期的协议计数器（连接层每建一次会话报一次，后报的顶掉前一个）。
    ///
    /// 为什么要「顶掉」而不是累加：`danmubox-bili` 每建一次会话就换一个 `Counters`
    /// 实例，报告里要的是**这一段连接**收了多少包、丢了多少，混进上一段就没法读了。
    pub fn note_counters(&self, counters: Arc<Counters>) {
        self.inner.lock().expect("diag poisoned").counters = Some(counters);
    }

    /// 取一份快照。不会清空任何东西（导出后再调 [`Self::reset`]）。
    ///
    /// `window` **按原样带出**，即使此刻已经过了 `ends_ms`：界面是在窗口到点那一刻
    /// 才来导出的，报告里若因此写着「未采集」，读的人会以为没采过。窗口是否还在收，
    /// 由 [`Diagnoser::recording_at`] 单独判。
    pub fn snapshot(&self, now_ms: i64) -> DiagSnapshot {
        let inner = self.inner.lock().expect("diag poisoned");
        DiagSnapshot {
            now_ms,
            window: inner.window,
            attempts: inner
                .attempts
                .iter()
                .map(|attempt| attempt.record())
                .collect(),
            logs: inner.logs.iter().cloned().collect(),
            logs_dropped: inner.logs_dropped,
            unknown_cmds: inner
                .unknown_cmds
                .iter()
                .map(|(cmd, count)| (cmd.clone(), *count))
                .collect(),
            unknown_dropped: inner.unknown_dropped,
            counters: inner.counters.as_ref().map(|counters| counters.snapshot()),
        }
    }

    /// 一次诊断收尾：关窗并清掉窗口产物与尝试环。
    ///
    /// 报告的字节已经在文件里了，内存里这份没有留着的理由 —— 它同时含
    /// 「最近几次连接」这类本不该长期驻留的信息。
    pub fn reset(&self) {
        self.deadline_ms.store(0, Ordering::Relaxed);
        let mut inner = self.inner.lock().expect("diag poisoned");
        inner.window = None;
        inner.logs.clear();
        inner.logs_dropped = 0;
        inner.unknown_cmds.clear();
        inner.unknown_dropped = 0;
        inner.attempts.clear();
    }
}

/// 进程级的唯一采集器。
pub fn shared() -> &'static Diagnoser {
    static SHARED: LazyLock<Diagnoser> = LazyLock::new(Diagnoser::new);
    &SHARED
}

fn truncate(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let mut end = cap;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（本行截断，原长 {} 字节）", &text[..end], text.len())
}

/// UTC 时刻的日历分解。**不做时区换算**（`docs/contract.md` §4：时间统一 UTC）：
/// 报告里的时刻与文件名都按 UTC 写，并且都带 `UTC` 字样，免得用户与自己的钟对不上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtcParts {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl UtcParts {
    /// `20260916-041234`：文件名用的紧凑戳。
    pub fn stamp(&self) -> String {
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }

    /// `2026-09-16 04:12:34 UTC`：报告里给人看的写法。
    pub fn human(&self) -> String {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

/// UTC 毫秒 → 日历分解（Howard Hinnant 的 `civil_from_days`，无依赖、无查表）。
pub fn utc_parts(ms: i64) -> UtcParts {
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    UtcParts {
        year: if month <= 2 { y + 1 } else { y },
        month,
        day,
        hour: (rest / 3_600_000) as u32,
        minute: (rest % 3_600_000 / 60_000) as u32,
        second: (rest % 60_000 / 1_000) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 采集窗口内的日志才收；窗口过期后自动停。
    #[test]
    fn log_lines_only_land_inside_the_window() {
        let diag = Diagnoser::new();
        diag.log_line(0, "INFO", "t", "窗口之前");
        assert!(
            diag.snapshot(1_000).logs.is_empty(),
            "没开窗口就一行都不该收"
        );

        let window = diag.begin_window(1_000, 1_000);
        assert_eq!(window.ends_ms, 2_000);
        diag.log_line(1_500, "INFO", "t", "窗口之内");
        assert_eq!(diag.snapshot(1_500).logs.len(), 1);

        // 到点之后：`window_at` 判定过期并关掉采集。
        assert!(diag.window_at(2_000).is_none());
        diag.log_line(2_500, "INFO", "t", "窗口之后");
        assert_eq!(diag.snapshot(2_500).logs.len(), 1, "过期后不许再收");
    }

    /// 开新窗口会丢掉上一次的日志与未识别名单（一次诊断一个文件）。
    #[test]
    fn a_new_window_starts_clean() {
        let diag = Diagnoser::new();
        diag.begin_window(0, 1_000);
        diag.log_line(500, "WARN", "t", "上一轮");
        diag.note_unknown_cmd(500, "WHATEVER");
        assert_eq!(
            diag.snapshot(0).unknown_cmds,
            vec![("WHATEVER".to_string(), 1)]
        );

        diag.begin_window(10_000, 1_000);
        let snapshot = diag.snapshot(10_000);
        assert!(snapshot.logs.is_empty());
        assert!(snapshot.unknown_cmds.is_empty());
    }

    /// 未识别命令只记窗口内的；名单有上限，超出的只计种类数。
    #[test]
    fn unknown_cmd_names_are_window_scoped_and_capped() {
        let diag = Diagnoser::new();
        diag.note_unknown_cmd(0, "BEFORE");
        diag.begin_window(0, 1_000);
        diag.note_unknown_cmd(500, "AAA");
        diag.note_unknown_cmd(500, "AAA");
        for index in 0..(UNKNOWN_CMD_CAP + 5) {
            diag.note_unknown_cmd(500, &format!("CMD{index}"));
        }
        let snapshot = diag.snapshot(0);
        assert_eq!(snapshot.unknown_cmds.len(), UNKNOWN_CMD_CAP);
        // AAA 与 CMD0..CMD(CAP-2) 占满名单，其余 6 种没记下名字。
        assert_eq!(snapshot.unknown_dropped, 6);
        assert_eq!(snapshot.unknown_cmd_total(), UNKNOWN_CMD_CAP as u64 + 1);
        assert!(!snapshot.unknown_cmds.iter().any(|(cmd, _)| cmd == "BEFORE"));
    }

    /// 尝试环与日志环都是有界的：满了丢最旧，且丢的行数要能报出来。
    #[test]
    fn rings_are_bounded_and_report_what_they_dropped() {
        let diag = Diagnoser::new();
        diag.begin_window(0, 10_000_000);
        for index in 0..(LOG_CAP + 7) {
            diag.log_line(0, "INFO", "t", &format!("第 {index} 行"));
        }
        let snapshot = diag.snapshot(0);
        assert_eq!(snapshot.logs.len(), LOG_CAP);
        assert_eq!(snapshot.logs_dropped, 7);
        assert_eq!(snapshot.logs.first().unwrap().text, "第 7 行");

        for _ in 0..(ATTEMPT_CAP + 3) {
            diag.begin_attempt(0);
        }
        assert_eq!(diag.snapshot(0).attempts.len(), ATTEMPT_CAP);
    }

    /// 一条连接从票据到首帧的各阶段都能落到记录里，且进行中的那条是「活着」的。
    #[test]
    fn attempt_records_every_stage() {
        let diag = Diagnoser::new();
        let attempt = diag.begin_attempt(1_000);
        attempt.ticket_ok(1_200, 0);
        attempt.node(2, Some("host.example"));
        attempt.dialed(1_500);
        attempt.auth_sent(1_510);
        attempt.auth_reply(1_600, Some(0));
        attempt.inbound(1_600);
        attempt.inbound(1_800);
        attempt.business(1_900);
        attempt.business(1_950);

        let snapshot = diag.snapshot(2_000);
        let record = snapshot.last_attempt().expect("记了一条");
        assert_eq!(record.ticket_ms, Some(1_200));
        assert_eq!(record.ticket_code, Some(0));
        assert_eq!(record.node_index, Some(2));
        assert_eq!(record.node.as_deref(), Some("host.example"));
        assert_eq!(record.dial_failures, 0);
        assert_eq!(record.first_inbound_ms, Some(1_600), "首帧只认第一次");
        assert_eq!(record.last_inbound_ms, Some(1_800));
        assert_eq!(record.inbound_frames, 2);
        assert_eq!(record.first_business_ms, Some(1_900));
        assert_eq!(record.business_frames, 2);
        assert_eq!(record.end_ms, None, "没结束 = 还在连着");

        // 进行中 + 认证过 → 视为「当前连着」，时长与静默都从快照时刻算。
        let mut connected = snapshot.clone();
        connected.attempts.last_mut().unwrap().verified = true;
        assert!(connected.connected_now());
        assert_eq!(connected.uptime_ms(), Some(1_000));
        assert_eq!(connected.idle_ms(), Some(200));

        attempt.ended(2_500, "僵死：距上次入站帧 90000ms", true);
        attempt.backoff(5_000, 0);
        let record = diag.snapshot(3_000).last_attempt().cloned().unwrap();
        assert_eq!(
            record.end_reason.as_deref(),
            Some("僵死：距上次入站帧 90000ms")
        );
        assert_eq!(record.backoff_ms, Some(5_000));
        assert!(!diag.snapshot(3_000).connected_now(), "结束了就不算连着");
    }

    /// 超长的一行会被截断，且截断点落在字符边界上（不许切出半个 UTF-8 字符）。
    #[test]
    fn overlong_log_lines_are_truncated_on_a_char_boundary() {
        let diag = Diagnoser::new();
        diag.begin_window(0, 1_000);
        diag.log_line(0, "INFO", "t", &"弹".repeat(LOG_TEXT_CAP));
        let line = diag.snapshot(0).logs.pop().unwrap();
        assert!(line.text.starts_with("弹"));
        assert!(line.text.contains("本行截断"));
        assert!(line.text.len() < LOG_TEXT_CAP + 64);
    }

    /// 导出收尾之后什么都不留（含尝试环）。
    #[test]
    fn reset_leaves_nothing_behind() {
        let diag = Diagnoser::new();
        diag.begin_window(0, 10_000);
        diag.log_line(0, "INFO", "t", "x");
        diag.begin_attempt(0);
        diag.reset();
        let snapshot = diag.snapshot(0);
        assert!(snapshot.window.is_none());
        assert!(snapshot.logs.is_empty());
        assert!(snapshot.attempts.is_empty());
        assert!(!diag.recording_at(0));
    }

    /// 协议计数：后报的顶掉前一个（报告只讲「这一段连接」）。
    #[test]
    fn the_latest_counter_snapshot_wins() {
        let diag = Diagnoser::new();
        assert!(diag.snapshot(0).counters.is_none());
        let first = Arc::new(Counters::default());
        Counters::bump(&first.unknown_cmd);
        diag.note_counters(Arc::clone(&first));
        assert_eq!(diag.snapshot(0).counters.unwrap().unknown_cmd, 1);

        diag.note_counters(Arc::new(Counters::default()));
        assert_eq!(diag.snapshot(0).counters.unwrap().unknown_cmd, 0);
    }

    /// UTC 日历分解照标准库之外的事实核对：epoch、闰年 2 月 29 日、整秒边界。
    #[test]
    fn utc_parts_match_known_instants() {
        assert_eq!(
            utc_parts(0),
            UtcParts {
                year: 1970,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0,
                second: 0
            }
        );
        assert_eq!(utc_parts(0).human(), "1970-01-01 00:00:00 UTC");
        assert_eq!(utc_parts(0).stamp(), "19700101-000000");
        // 2024-02-29 12:34:56 UTC（闰日；`date -u -r 1709210096` 同值）。
        assert_eq!(
            utc_parts(1_709_210_096_000).human(),
            "2024-02-29 12:34:56 UTC"
        );
        // 2026-09-16 04:12:34 UTC。
        assert_eq!(utc_parts(1_789_531_954_000).stamp(), "20260916-041234");
    }
}
