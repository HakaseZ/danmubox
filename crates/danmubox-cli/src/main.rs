//! 弹幕框调试入口：脱离 UI 验证协议与适配器（`docs/roadmap.md` 阶段 1）。
//!
//! 阶段 1 只用游客模式，因此本入口不需要任何凭据。
//! 字段实测校准靠 `DANMUBOX_LOG=debug` 打印的原始载荷（`docs/protocol.md` 附录 B）。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use danmubox_bili::BiliLive;
use danmubox_core::ports::LiveSource;
use danmubox_core::{Event, EventBus, HistoryQuery, Prefs, RoomRuntime};
use tokio::sync::broadcast::error::RecvError;

#[derive(Parser)]
#[command(name = "danmubox", about = "弹幕框调试入口", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 解析房间号 / 短号 / URL，打印房间元信息
    Resolve { input: String },
    /// 以游客模式连接房间并打印事件（阶段 1 的验收入口）
    Watch {
        input: String,
        /// 观察时长（秒）
        #[arg(long, default_value_t = 60)]
        seconds: u64,
        /// 只打印汇总，不逐条打印消息
        #[arg(long, default_value_t = false)]
        quiet: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    match Cli::parse().command {
        Command::Resolve { input } => {
            let live = BiliLive::new().context("初始化适配器失败")?;
            let room = live.resolve_room(&input).await?;
            println!("{}", serde_json::to_string_pretty(&room)?);
        }
        Command::Watch {
            input,
            seconds,
            quiet,
        } => watch(input, seconds, quiet).await?,
    }
    Ok(())
}

async fn watch(input: String, seconds: u64, quiet: bool) -> Result<()> {
    let live = BiliLive::new().context("初始化适配器失败")?;
    let room = live.resolve_room(&input).await?;
    println!(
        "# 房间 {}（短号 {}）主播 uid={} 状态={} 标题={}",
        room.room_id, room.short_id, room.anchor_uid, room.live_status, room.title
    );

    let counters = live.counters();
    let bus = EventBus::default();
    let source: Arc<dyn LiveSource> = Arc::new(live);
    let runtime = RoomRuntime::spawn(
        room.clone(),
        Prefs::new().buffer_rows(),
        bus.clone(),
        counters.clone(),
        source,
    );
    let mut events = bus.subscribe();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            _ = tokio::signal::ctrl_c() => {
                println!("# 收到中断，结束观察");
                break;
            }
            received = events.recv() => match received {
                Ok(Event::Message(message)) => {
                    if !quiet {
                        println!(
                            "[{}] uid={} {}: {}",
                            message.kind.as_str(),
                            message.uid,
                            message.uname,
                            message.content
                        );
                    }
                }
                Ok(Event::Status(status)) => {
                    println!("# 状态 {:?} {}", status.state, status.detail);
                }
                Ok(Event::Session(_)) | Ok(Event::Room(_)) => {}
                Ok(Event::RoomClosed(id)) => {
                    println!("# 房间 {id} 会话关闭");
                    break;
                }
                Err(RecvError::Lagged(dropped)) => {
                    println!("# 事件订阅落后，丢弃 {dropped} 条");
                }
                Err(RecvError::Closed) => break,
            },
        }
    }

    // 会话缓冲证据（S1-AC10 的运行时侧）。
    let in_session = runtime.query(&HistoryQuery {
        limit: 0,
        ..Default::default()
    });
    let danmaku = in_session
        .iter()
        .filter(|m| m.kind == danmubox_core::MessageKind::Danmaku)
        .count();
    println!(
        "# 本次会话缓冲 {} 条（其中 danmaku {} 条），上限 {}",
        in_session.len(),
        danmaku,
        runtime.cap()
    );
    println!("# 计数 {:?}", counters.snapshot());

    runtime.close().await?;
    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_env("DANMUBOX_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .init();
}
