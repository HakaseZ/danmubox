//! 一键诊断报告的渲染（`docs/operations.md` §2.9）。
//!
//! 为什么渲染在 `danmubox-bili` 而不是外壳层：
//!
//! - 报告里要点出**上游的环节名**（`getDanmuInfo`、`op=7` / `op=8`、候选节点），
//!   那是 B 站协议词汇，只允许出现在本 crate（`AGENT.md` §2 的上游隔离）；
//! - 文件必须**可安全外发**，而脱敏的唯一出口在本 crate 的 `redact`。
//!
//! 因此边界是：`danmubox-core` 采事实（不认识上游词汇），本模块贴标签 + 一次脱敏，
//! `apps/desktop` 只负责把这段字节落到对的目录里。

use danmubox_core::diagnose::{AttemptRecord, DiagSnapshot, ShellEnv, UtcParts};

/// 把快照渲染成一份完整报告（已脱敏，可直接写文件）。
///
/// `secret_numbers` 是**本机已知的房间号 / 短号 / 主播 uid**：它们在日志里可能以
/// `id=5440` 这种形态出现（`getDanmuInfo` 的查询串就是这个形状），键名白名单盖不住，
/// 因此按「这些数字一律不许出现在文件里」逐值抹掉 —— 比再猜一套键名可靠。
pub fn render_report(snapshot: &DiagSnapshot, env: &ShellEnv, secret_numbers: &[i64]) -> String {
    let mut out = String::with_capacity(4096);
    out.push_str("danmubox 连接诊断报告\n");
    out.push_str("====================\n\n");
    header(&mut out, snapshot, env);
    summary(&mut out, snapshot);
    attempts(&mut out, snapshot);
    counters(&mut out, snapshot);
    logs(&mut out, snapshot);
    closing(&mut out);
    crate::redact::redact_for_export(&out, secret_numbers)
}

fn header(out: &mut String, snapshot: &DiagSnapshot, env: &ShellEnv) {
    out.push_str(&format!("生成时间：{}\n", human(snapshot.now_ms)));
    match snapshot.window {
        Some(window) => out.push_str(&format!(
            "采集窗口：{} → {}（共 {}）\n",
            human(window.started_ms),
            human(window.ends_ms),
            duration(window.ends_ms - window.started_ms)
        )),
        None => out.push_str("采集窗口：未采集（直接导出的当前状态）\n"),
    }
    out.push_str(&format!(
        "平台：{} / {}    应用版本：{}\n",
        blank(&env.os),
        blank(&env.arch),
        blank(&env.app_version)
    ));
    out.push_str(&format!("渲染引擎：{}\n", blank(&env.engine)));
    out.push_str(&format!(
        "日志级别：DANMUBOX_LOG={}\n",
        blank(&env.log_level)
    ));
    out.push('\n');
    out.push_str(
        "本文件由 danmubox 在本机生成，只包含连接诊断信息，应用不会自动发送任何数据。\n\
         已按仓库脱敏口径处理：凭据、uid、昵称、房间号一律写成 ***，可直接发给别人。\n\
         时间一律 UTC（与文件名一致）。\n\n",
    );
}

fn summary(out: &mut String, snapshot: &DiagSnapshot) {
    out.push_str("一、结论速览\n------------\n");
    match snapshot.last_attempt() {
        Some(attempt) if snapshot.connected_now() => {
            out.push_str(&format!(
                "当前连接：已认证成功，已持续 {}\n",
                duration(snapshot.uptime_ms().unwrap_or(0))
            ));
            match snapshot.idle_ms() {
                Some(idle) => out.push_str(&format!(
                    "距最近一次入站帧：{}（本次尝试累计入站 {} 帧 / 业务载荷 {} 条）\n",
                    duration(idle),
                    attempt.inbound_frames,
                    attempt.business_frames
                )),
                None => out.push_str(
                    "距最近一次入站帧：**一个入站帧都还没收到**（认证通了但没有数据回来）\n",
                ),
            }
            if attempt.business_frames == 0 {
                out.push_str(
                    "→ 认证成功却没有任何业务载荷：看第二节「首条业务载荷」是不是还是空的，\n\
                     以及第五节「日志」里有没有 HTTP 心跳失败 / 节点反复轮换。\n",
                );
            }
        }
        Some(attempt) if attempt.end_ms.is_none() => {
            out.push_str(&format!(
                "当前连接：正在建连（认证尚未成功），已过 {}\n",
                duration(snapshot.uptime_ms().unwrap_or(0))
            ));
            out.push_str(&format!(
                "  票据：{}；认证回应：{}\n",
                ticket(attempt),
                if attempt.auth_reply_ms.is_some() {
                    "已到达（见下）"
                } else {
                    "**未到达**"
                }
            ));
        }
        Some(attempt) => out.push_str(&format!(
            "当前连接：没有活着的连接。最近一次尝试结束于 {}（{}）\n",
            attempt
                .end_ms
                .map(human)
                .unwrap_or_else(|| "未记录".to_string()),
            attempt.end_reason.as_deref().unwrap_or("未记录原因")
        )),
        None => out.push_str("当前连接：本次进程里没有记录到任何连接尝试（还没进过房间）\n"),
    }
    out.push_str(&format!(
        "连接尝试：共 {} 次记录\n",
        snapshot.attempts.len()
    ));
    out.push_str(&format!(
        "未识别命令：本次采集期间 {} 种 / {} 次{}\n",
        snapshot.unknown_cmds.len(),
        snapshot.unknown_cmd_total(),
        if snapshot.unknown_dropped > 0 {
            format!(
                "（另有 {} 种超出名单上限，只计数）",
                snapshot.unknown_dropped
            )
        } else {
            String::new()
        }
    ));
    if !snapshot.unknown_cmds.is_empty() {
        let names = snapshot
            .unknown_cmds
            .iter()
            .map(|(cmd, count)| format!("{cmd}×{count}"))
            .collect::<Vec<_>>()
            .join("、");
        out.push_str(&format!("  名单：{names}\n"));
    }
    out.push('\n');
}

fn attempts(out: &mut String, snapshot: &DiagSnapshot) {
    out.push_str("二、连接尝试与重连历史（按时间升序）\n------------------------------------\n");
    if snapshot.attempts.is_empty() {
        out.push_str("（无）\n\n");
        return;
    }
    let last = snapshot.attempts.len().saturating_sub(1);
    for (index, attempt) in snapshot.attempts.iter().enumerate() {
        let live = attempt.end_ms.is_none();
        out.push_str(&format!(
            "[{}] 开始 {}{}\n",
            index + 1,
            human(attempt.started_ms),
            if live { "（进行中）" } else { "" }
        ));
        out.push_str(&format!("    票据（getDanmuInfo）：{}\n", ticket(attempt)));
        out.push_str(&format!(
            "    候选节点：{}{}\n",
            node(attempt),
            if attempt.dial_failures > 0 {
                format!("（本轮有 {} 个候选没接上）", attempt.dial_failures)
            } else {
                String::new()
            }
        ));
        out.push_str(&format!(
            "    认证包（op=7）发出：{}    认证回应（op=8）：{}\n",
            stage(attempt, attempt.auth_sent_ms),
            match (attempt.auth_sent_ms, attempt.auth_reply_ms) {
                (Some(sent), Some(reply)) => format!(
                    "{} 到达（延迟 {}），code={}",
                    delta(sent, reply),
                    duration(reply - sent),
                    attempt
                        .auth_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "未知".to_string())
                ),
                _ => "**未到达**".to_string(),
            }
        ));
        out.push_str(&format!(
            "    首个入站帧：{}    首条业务载荷：{}\n",
            stage(attempt, attempt.first_inbound_ms),
            stage(attempt, attempt.first_business_ms)
        ));
        out.push_str(&format!(
            "    入站帧 {} 条 / 业务载荷 {} 条；最近一次入站：{}\n",
            attempt.inbound_frames,
            attempt.business_frames,
            match attempt.last_inbound_ms {
                Some(at) => format!("{}（距开始 {}）", human(at), delta(attempt.started_ms, at)),
                None => "从未收到".to_string(),
            }
        ));
        out.push_str(&format!(
            "    结束：{}\n",
            match attempt.end_ms {
                Some(end) => format!(
                    "{}（{}），本次存活 {}",
                    attempt.end_reason.as_deref().unwrap_or("（未记录）"),
                    human(end),
                    duration(end - attempt.started_ms)
                ),
                None => "还在进行中".to_string(),
            }
        ));
        if let Some(backoff) = attempt.backoff_ms {
            out.push_str(&format!(
                "    在途/等待：退避 {}，连续认证失败 {} 次\n",
                duration(backoff as i64),
                attempt
                    .auth_failures_after
                    .map(|failures| failures.to_string())
                    .unwrap_or_else(|| "?".to_string())
            ));
        }
        if index == last {
            out.push_str("    —— 上面这一条就是当前这条连接。\n");
        }
        out.push('\n');
    }
}

fn counters(out: &mut String, snapshot: &DiagSnapshot) {
    out.push_str("三、协议计数（自最近一次建立会话起，即当前这一个连接周期）\n--------------------------------------------------------\n");
    match &snapshot.counters {
        Some(counters) => {
            out.push_str(&format!(
                "收包 {packets}    解析出的消息 {messages}    计数类更新 {counter_updates}\n",
                packets = counters.packets,
                messages = counters.messages,
                counter_updates = counters.counter_updates
            ));
            out.push_str(&format!(
                "未识别命令 {unknown}    镜像弹幕丢弃 {mirrored}    解压失败 {decompress}    超上限丢弃 {oversize}    结构损坏丢弃 {malformed}\n",
                unknown = counters.unknown_cmd,
                mirrored = counters.mirrored_dropped,
                decompress = counters.decompress_errors,
                oversize = counters.oversize_dropped,
                malformed = counters.malformed_dropped
            ));
            out.push_str(&format!(
                "上游 HTTP 心跳失败 {heartbeat} 次\n",
                heartbeat = counters.heartbeat_failures
            ));
            out.push_str(
                "（`messages` 只数实时弹幕，不含进场回填；`packets` 是解出包头的入站包数。）\n",
            );
        }
        None => out.push_str("（这个进程还没有建立过连接）\n"),
    }
    out.push('\n');
}

fn logs(out: &mut String, snapshot: &DiagSnapshot) {
    out.push_str(&format!(
        "四、采集窗口内的日志（{} 行{})\n--------------------------------\n",
        snapshot.logs.len(),
        if snapshot.logs_dropped > 0 {
            format!("，另有 {} 行因上限被丢弃", snapshot.logs_dropped)
        } else {
            String::new()
        }
    ));
    if snapshot.logs.is_empty() {
        out.push_str(
            "（窗口内没有任何日志：可能是刚开采集，或这 3 分钟里连接风平浪静。）\n\
             注意 `danmubox::raw`（逐条上游原始载荷）**不进**本文件 —— 那是弹幕原文\n\
             与用户数据，脱敏规则对它无能为力，需要它请在本机开 `DANMUBOX_LOG=debug`\n\
             自己看（`docs/protocol.md` 附录 B.1）。\n",
        );
        out.push('\n');
        return;
    }
    for line in &snapshot.logs {
        out.push_str(&format!(
            "{} {:<5} [{}] {}\n",
            clock(line.ts_ms),
            line.level,
            line.target,
            line.text
        ));
    }
    out.push('\n');
}

fn closing(out: &mut String) {
    out.push_str(
        "五、怎么读这份文件\n------------------\n\
         · 「票据 → 握手 → 认证包 → 认证回应 → 首帧 → 首条业务载荷」六步里，\n\
           卡在哪一步、那一步花了多久，就是「卡在哪一环」。\n\
         · 认证成功（code=0）但首条业务载荷一直没有、距上次入站帧还在涨：\n\
           连接是通的、上游没往下发（本仓库无遥测，这条只能靠本文件判断）。\n\
         · 连续认证失败 3 次会停止自动重连（`docs/protocol.md` §13.2），\n\
           界面上那颗「刷新连接」可以重置计数。\n\
         · 本文件不含弹幕原文、礼物记录或任何凭据；它只描述连接本身。\n",
    );
}

// ---------------------------------------------------------------- 小工具

/// `2026-09-16 04:12:34 UTC`。
fn human(ms: i64) -> String {
    danmubox_core::diagnose::utc_parts(ms).human()
}

/// `04:12:34.567`：日志行用（同一天内的相对顺序一眼可读）。
fn clock(ms: i64) -> String {
    let parts: UtcParts = danmubox_core::diagnose::utc_parts(ms);
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        parts.hour,
        parts.minute,
        parts.second,
        ms.rem_euclid(1_000)
    )
}

/// 人话时长：不足 1 秒用毫秒，1 分钟以内用秒，再长用分秒。
fn duration(ms: i64) -> String {
    let ms = ms.max(0);
    if ms < 1_000 {
        return format!("{ms} ms");
    }
    if ms < 60_000 {
        return format!("{:.2} s", ms as f64 / 1_000.0);
    }
    format!(
        "{} 分 {:.0} 秒",
        ms / 60_000,
        (ms % 60_000) as f64 / 1_000.0
    )
}

/// 从尝试开始到某个阶段的耗时（阶段没发生就是 `未到达`）。
fn stage(attempt: &AttemptRecord, at: Option<i64>) -> String {
    match at {
        Some(at) => format!("{}（距开始 {}）", human(at), delta(attempt.started_ms, at)),
        None => "**未到达**".to_string(),
    }
}

/// 某个时刻相对开始时刻的偏移。
fn delta(from: i64, to: i64) -> String {
    format!("+{}", duration(to - from))
}

/// 票据这一步的结论。
fn ticket(attempt: &AttemptRecord) -> String {
    if let Some(error) = attempt.ticket_error.as_deref() {
        return format!("失败：{error}（{}）", took(attempt));
    }
    match attempt.ticket_code {
        Some(code) => format!(
            "code={code}{}（{}）",
            if code == 0 {
                ""
            } else {
                " ← 非 0 即被上游拒绝"
            },
            took(attempt)
        ),
        None => "未完成".to_string(),
    }
}

/// 票据这一步花了多久。
fn took(attempt: &AttemptRecord) -> String {
    match attempt.ticket_ms {
        Some(at) => format!("耗时 {}", duration(at - attempt.started_ms)),
        None => "未返回".to_string(),
    }
}

/// 选中的候选节点。
fn node(attempt: &AttemptRecord) -> String {
    match (attempt.node_index, attempt.node.as_deref()) {
        (Some(index), Some(host)) => format!("host_list[{index}] {host}"),
        (Some(index), None) => format!("host_list[{index}] 起，本轮全部没接上"),
        _ => "尚未选到".to_string(),
    }
}

/// 空的平台字段写成 `?`，免得报告里出现「平台： / 」这种断头句。
fn blank(value: &str) -> String {
    if value.trim().is_empty() {
        "?".to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use danmubox_core::diagnose::{Diagnoser, WINDOW_MS};

    fn env() -> ShellEnv {
        ShellEnv {
            os: "macos".into(),
            arch: "aarch64".into(),
            app_version: "0.1.0".into(),
            engine: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15".into(),
            log_level: "info".into(),
        }
    }

    /// 报告要覆盖「卡在哪一环」的每一项：票据 code、认证包/回应时刻、首帧、静默、
    /// 重连历史（原因 / 退避 / 节点下标）、连续失败次数、未识别命令、连接时长、平台版本。
    #[test]
    fn a_full_attempt_shows_every_stage() {
        let diag = Diagnoser::new();
        diag.begin_window(1_000_000, WINDOW_MS);
        let attempt = diag.begin_attempt(1_000_000);
        attempt.ticket_ok(1_000_200, 0);
        attempt.node(2, Some("a1.example"));
        attempt.dialed(1_000_320);
        attempt.auth_sent(1_000_322);
        attempt.auth_reply(1_000_651, Some(0));
        attempt.inbound(1_000_651);
        attempt.inbound(1_030_000);
        attempt.business(1_031_000);
        attempt.ended(
            1_372_400,
            "僵死：距上次入站帧 90000ms（阈值 90000ms）",
            true,
        );
        attempt.backoff(5_000, 0);
        diag.note_unknown_cmd(1_100_000, "NEW_CMD");

        let report = render_report(&diag.snapshot(1_400_000), &env(), &[5440]);

        for needle in [
            "danmubox 连接诊断报告",
            "平台：macos / aarch64    应用版本：0.1.0",
            "渲染引擎：Mozilla/5.0",
            "日志级别：DANMUBOX_LOG=info",
            "票据（getDanmuInfo）：code=0（耗时 200 ms）",
            "候选节点：host_list[2] a1.example",
            "认证包（op=7）发出：",
            "认证回应（op=8）：+329 ms 到达（延迟 329 ms），code=0",
            "首个入站帧：",
            "首条业务载荷：",
            "入站帧 2 条 / 业务载荷 1 条",
            "僵死：距上次入站帧 90000ms（阈值 90000ms）",
            "退避 5.00 s，连续认证失败 0 次",
            "未识别命令：本次采集期间 1 种 / 1 次",
            "名单：NEW_CMD×1",
            "应用不会自动发送任何数据",
        ] {
            assert!(
                report.contains(needle),
                "报告里缺少「{needle}」：\n{report}"
            );
        }
    }

    /// 「连上了却收不到弹幕」的那一档：认证通了、入站帧一个没有 —— 结论速览与
    /// 分阶段行都必须把这件事说穿，而不是留一堆空值。
    #[test]
    fn a_verified_but_silent_connection_says_so() {
        let diag = Diagnoser::new();
        let attempt = diag.begin_attempt(5_000_000);
        attempt.ticket_ok(5_000_100, 0);
        attempt.node(0, Some("a1.example"));
        attempt.auth_sent(5_000_200);
        attempt.auth_reply(5_000_500, Some(0));

        let report = render_report(&diag.snapshot(5_090_000), &env(), &[]);

        assert!(report.contains("已认证成功，已持续"), "{report}");
        assert!(
            report.contains("一个入站帧都还没收到"),
            "静默那一档要说穿：{report}"
        );
        assert!(
            report.contains("认证成功却没有任何业务载荷"),
            "要给出下一步看哪里：{report}"
        );
        assert!(report.contains("首个入站帧：**未到达**"), "{report}");
    }

    /// 票据被上游拒绝（`getDanmuInfo` 非 0）时，报告要把 code 与文案一起给出来。
    #[test]
    fn a_rejected_ticket_keeps_the_upstream_code() {
        let diag = Diagnoser::new();
        let attempt = diag.begin_attempt(9_000_000);
        attempt.ticket_failed(9_000_400, "code=-352");
        attempt.ended(
            9_000_400,
            "getDanmuInfo 失败: getDanmuInfo code=-352",
            false,
        );

        let report = render_report(&diag.snapshot(9_001_000), &env(), &[]);

        assert!(
            report.contains("票据（getDanmuInfo）：失败：code=-352"),
            "{report}"
        );
        assert!(
            report.contains("code=-352「") || report.contains("code=-352"),
            "{report}"
        );
        assert!(report.contains("认证包（op=7）发出：**未到达**") || report.contains("**未到达**"));
    }

    /// 窗口内的日志进文件，`danmubox::raw` 那种原始载荷由调用方挡在外面（这里只验行渲染）。
    #[test]
    fn window_logs_are_rendered_with_level_and_target() {
        let diag = Diagnoser::new();
        diag.begin_window(0, WINDOW_MS);
        diag.log_line(
            1_500,
            "WARN",
            "danmubox_bili::ws",
            "距上次入站帧已 90001ms（阈值 90000ms），判定连接僵死",
        );

        let report = render_report(&diag.snapshot(2_000), &env(), &[]);

        assert!(
            report.contains("00:00:01.500 WARN  [danmubox_bili::ws]"),
            "{report}"
        );
        assert!(report.contains("判定连接僵死"), "{report}");
    }

    /// **可安全外发的硬要求**：凭据 / uid / 昵称 / 房间号一个都不许留在文件里，
    /// 包括日志里 `id=5440` 这种没有键名白名单的形状（按本机已知的房间号逐值抹）。
    #[test]
    fn the_report_never_carries_credentials_or_identifiers() {
        let diag = Diagnoser::new();
        diag.begin_window(0, WINDOW_MS);
        diag.log_line(
            1_000,
            "DEBUG",
            "danmubox_bili::http",
            "GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=5440&type=0&wts=1",
        );
        diag.log_line(
            1_100,
            "WARN",
            "danmubox_bili::http",
            "上游返回 DedeUserID=7654321; SESSDATA=deadbeef&bili_jct=cafe; uname=某主播",
        );
        diag.log_line(
            1_200,
            "INFO",
            "danmubox::ui",
            "房间 5440 的弹幕已连接，+1.56 s 后收到首条",
        );

        let report = render_report(&diag.snapshot(2_000), &env(), &[5440]);

        for secret in [
            "7654321",
            "deadbeef",
            "cafe",
            "某主播",
            "5440",
            "DedeUserID=7",
        ] {
            assert!(
                !report.contains(secret),
                "「{secret}」不该出现在报告里：\n{report}"
            );
        }
        assert!(report.contains("id=***"), "房间号要变成占位符：\n{report}");
        assert!(report.contains("SESSDATA=***"));
        assert!(report.contains("uname=***"));

        // 同一条路径的**反面**：报告存在的理由（时间戳含秒 / 应用版本 / 计数 / 时长）
        // 一个都不许被抹 —— 公开测试房间 `1` 的短号就是 `1`，早先的实现把
        // `0.1.0`、`13:55:01`、`共 1 次`、`+1.56 s` 全抹成了 `***`（2026-09-16 实测复盘）。
        let thin = render_report(&diag.snapshot(2_000), &env(), &[1]);
        for keep in ["应用版本：0.1.0", "00:00:01.000", "+1.56 s"] {
            assert!(thin.contains(keep), "「{keep}」必须原样保留：\n{thin}");
        }
    }

    /// 时长与时刻的写法本身也要对（不足 1 秒 / 1 分钟以内 / 更长）。
    #[test]
    fn durations_read_like_human_text() {
        assert_eq!(duration(-5), "0 ms");
        assert_eq!(duration(213), "213 ms");
        assert_eq!(duration(1_020), "1.02 s");
        assert_eq!(duration(90_000), "1 分 30 秒");
        assert_eq!(clock(1_500), "00:00:01.500");
        assert_eq!(human(0), "1970-01-01 00:00:00 UTC");
    }
}
