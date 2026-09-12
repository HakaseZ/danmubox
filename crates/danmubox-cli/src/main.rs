//! 弹幕框调试入口：脱离 UI 验证协议与适配器（`docs/roadmap.md`）。
//!
//! 凭据文件是三种登录模式的唯一落点：文件里没有可用凭据即为游客态。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use danmubox_bili::{BiliAuth, BiliEmotes, BiliFollow, BiliLive, BiliSender, BiliWallet};
use danmubox_core::ports::{
    AuthProvider, DanmakuSender, EmoteProvider, LiveSource, QrState, RoomCatalog, WalletProvider,
};
use danmubox_core::{
    config_path, prefs_path, ConfigStore, Event, EventBus, HistoryQuery, Prefs, RoomRuntime,
    RoomSession,
};
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
    /// 连接房间并打印事件（有凭据则用登录态，否则游客态）
    Watch {
        input: String,
        /// 观察时长（秒）
        #[arg(long, default_value_t = 60)]
        seconds: u64,
        /// 只打印汇总，不逐条打印消息
        #[arg(long, default_value_t = false)]
        quiet: bool,
    },
    /// 打印当前登录态（不含任何 Cookie 值）
    Session,
    /// 扫码登录：终端渲染二维码，轮询直至确认或超时
    Login {
        /// 超时时间（秒）
        #[arg(long, default_value_t = 180)]
        timeout: u64,
    },
    /// 登出：清空当前 profile 的凭据字段
    Logout,
    /// 发送一条弹幕（需登录）
    Send {
        /// 房间号 / 短号 / URL
        room: String,
        /// 弹幕内容
        text: String,
        /// 颜色（十进制 RGB，默认白色）
        #[arg(long)]
        color: Option<i64>,
        /// 以表情弹幕发送：给出表情的唯一键（`emotes` 子命令会打印）。给出后 `text` 仅用于日志。
        #[arg(long)]
        emote: Option<String>,
    },
    /// 列出凭据文件中的 profiles；`--use` 切换当前 profile
    Profiles {
        #[arg(long = "use")]
        use_profile: Option<String>,
    },
    /// 打印电池余额（需登录）
    Wallet,
    /// 打印关注的直播间（需登录）
    Follow,
    /// 打印房间可用的表情包（需登录）
    Emotes {
        /// 房间号 / 短号 / URL
        room: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let store = Arc::new(
        ConfigStore::load(config_path())
            .with_context(|| format!("读取 {} 失败", config_path().display()))?,
    );

    match Cli::parse().command {
        Command::Resolve { input } => resolve(&store, &input).await?,
        Command::Watch {
            input,
            seconds,
            quiet,
        } => watch(&store, input, seconds, quiet).await?,
        Command::Session => print_session(&store).await?,
        Command::Login { timeout } => login(&store, timeout).await?,
        Command::Logout => {
            let auth = BiliAuth::new(Arc::clone(&store))?;
            auth.logout().await?;
            println!(
                "# 已登出，{} 中当前 profile 的凭据已清空",
                store.active_name()
            );
            print_session(&store).await?;
        }
        Command::Profiles { use_profile } => profiles(&store, use_profile).await?,
        Command::Send {
            room,
            text,
            color,
            emote,
        } => send(&store, &room, &text, color, emote).await?,
        Command::Wallet => wallet(&store).await?,
        Command::Follow => follow(&store).await?,
        Command::Emotes { room } => emotes(&store, &room).await?,
    }
    Ok(())
}

async fn wallet(store: &Arc<ConfigStore>) -> Result<()> {
    let wallet = BiliWallet::new(Arc::clone(store))?;
    println!("# 电池余额：{}", wallet.balance().await.context("查询余额失败")?);
    Ok(())
}

async fn follow(store: &Arc<ConfigStore>) -> Result<()> {
    let catalog = BiliFollow::new(Arc::clone(store))?;
    let rooms = catalog.followed().await.context("拉取关注列表失败")?;
    println!("# 关注的直播间：{} 个", rooms.len());
    for room in &rooms {
        println!(
            "  room_id={:<10} live_status={} 分组={:?} {}",
            room.room_id, room.live_status, room.group_name, room.uname
        );
    }
    Ok(())
}

async fn emotes(store: &Arc<ConfigStore>, room: &str) -> Result<()> {
    let live = BiliLive::with_store(Arc::clone(store))?;
    let resolved = live.resolve_room(room).await?;
    let provider = BiliEmotes::new(Arc::clone(store))?;
    let session = RoomSession {
        room_id: resolved.room_id,
        ..Default::default()
    };
    let emotes = provider
        .emotes(resolved.room_id, &session)
        .await
        .context("拉取表情包失败")?;
    println!("# 房间 {} 可用表情：{} 个", resolved.room_id, emotes.len());
    let mut by_kind: std::collections::BTreeMap<String, Vec<&danmubox_core::Emote>> =
        std::collections::BTreeMap::new();
    for emote in &emotes {
        by_kind
            .entry(format!("{:?}", emote.package_kind))
            .or_default()
            .push(emote);
    }
    for (kind, items) in &by_kind {
        println!("  [{kind}] {} 个", items.len());
        for emote in items.iter().take(8) {
            println!("      {:<12} unique={:<22} {}", emote.text, emote.emoticon_unique, emote.url);
        }
    }
    Ok(())
}

async fn send(
    store: &Arc<ConfigStore>,
    room: &str,
    text: &str,
    color: Option<i64>,
    emote_unique: Option<String>,
) -> Result<()> {
    let live = BiliLive::with_store(Arc::clone(store))?;
    let resolved = live.resolve_room(room).await?;
    let sender = BiliSender::new(Arc::clone(store))?;
    // 表情弹幕：按唯一键在该房间的表情包里找出来，转成上游要求的 token。
    let token = match emote_unique {
        None => None,
        Some(unique) => {
            let provider = BiliEmotes::new(Arc::clone(store))?;
            let session = RoomSession {
                room_id: resolved.room_id,
                ..Default::default()
            };
            let list = provider
                .emotes(resolved.room_id, &session)
                .await
                .context("拉取表情包失败")?;
            let found = list
                .iter()
                .find(|e| e.emoticon_unique == unique || e.key == unique)
                .with_context(|| format!("该房间没有唯一键为 {unique} 的表情"))?;
            println!(
                "# 以表情弹幕发送：{}（唯一键 {}）",
                found.text, found.emoticon_unique
            );
            Some(danmubox_core::ports::EmoteToken {
                emoticon_unique: found.emoticon_unique.clone(),
                emoji: found.text.clone(),
                url: found.url.clone(),
                width: found.width,
                height: found.height,
                is_dynamic: found.is_dynamic,
                in_player_area: found.in_player_area,
                bulge_display: found.bulge_display,
            })
        }
    };

    let report = sender
        .send(resolved.room_id, text, color, None, token.as_ref())
        .await
        .context("发送失败")?;
    println!("# 房间 {} 发送结果：{:?}", resolved.room_id, report.outcome);
    // 成功时上游的 code=0 与原话没有信息量，只在非 ok 时打印。
    if report.outcome != danmubox_core::SendOutcome::Ok {
        if let Some(code) = report.upstream_code {
            println!(
                "# 上游 code={code} 原话：{}",
                report.upstream_message.as_deref().unwrap_or("（无）")
            );
        }
    }
    println!(
        "# 含义：{}",
        match report.outcome {
            danmubox_core::SendOutcome::Ok => "已发出并进入公开弹幕流",
            danmubox_core::SendOutcome::BlockedPlatform => "被平台风控吞掉（划线红线）",
            danmubox_core::SendOutcome::BlockedRoom => "被直播间吞掉（划线黄线）",
            danmubox_core::SendOutcome::RateLimited => "被限流",
            danmubox_core::SendOutcome::MedalRequired => "粉丝牌等级不足",
            danmubox_core::SendOutcome::Muted => "已被禁言",
            danmubox_core::SendOutcome::Failed => "失败，原始 code 见 debug 日志",
        }
    );
    Ok(())
}

async fn resolve(store: &Arc<ConfigStore>, input: &str) -> Result<()> {
    let live = BiliLive::with_store(Arc::clone(store))?;
    let room = live.resolve_room(input).await?;
    println!("{}", serde_json::to_string_pretty(&room)?);
    Ok(())
}

async fn watch(store: &Arc<ConfigStore>, input: String, seconds: u64, quiet: bool) -> Result<()> {
    let live = BiliLive::with_store(Arc::clone(store))?;
    let room = live.resolve_room(&input).await?;
    println!(
        "# 房间 {}（短号 {}）主播 uid={} 状态={} 标题={} 登录态={}",
        room.room_id,
        room.short_id,
        room.anchor_uid,
        room.live_status,
        room.title,
        store.is_logged_in()
    );

    let counters = live.counters();
    let bus = EventBus::default();
    let source: Arc<dyn LiveSource> = Arc::new(live);
    let prefs = Prefs::load(&prefs_path());
    let runtime = RoomRuntime::spawn(
        room.clone(),
        prefs.buffer_rows(),
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
                        // 表情弹幕标出来：这是核对「历史回填的表情」与「表情发送是否生效」的依据
                        // （见 docs/protocol.md 附录 A31 / A32）。
                        let flags = if message.is_history { "历史" } else { "" };
                        let emote = if message.emote_url.is_empty() {
                            String::new()
                        } else {
                            format!(" [表情 {}]", message.emote_url)
                        };
                        println!(
                            "[{}{}] uid={} {}: {}{}",
                            flags,
                            message.kind.as_str(),
                            message.uid,
                            message.uname,
                            message.content,
                            emote
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

fn session_json(state: &danmubox_core::ports::SessionState) -> Result<String> {
    Ok(serde_json::to_string_pretty(state)?)
}

async fn print_session(store: &Arc<ConfigStore>) -> Result<()> {
    let auth = BiliAuth::new(Arc::clone(store))?;
    let state = auth.session().await?;
    println!("{}", session_json(&state)?);
    println!("# 凭据文件：{}", config_path().display());
    Ok(())
}

async fn login(store: &Arc<ConfigStore>, timeout_secs: u64) -> Result<()> {
    let auth = BiliAuth::new(Arc::clone(store))?;
    if auth.session().await?.logged_in {
        println!("# 已是登录态，无需扫码；如需换号请先 `logout`");
        return print_session(store).await;
    }

    let challenge = auth.begin_qr().await.context("获取登录二维码失败")?;
    let code = qrcode::QrCode::new(challenge.url.as_bytes()).context("二维码编码失败")?;
    println!(
        "{}",
        code.render::<qrcode::render::unicode::Dense1x2>()
            .quiet_zone(true)
            .build()
    );
    println!("# 用 B 站客户端扫码；qrcode_key={}", challenge.key);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut last: Option<QrState> = None;
    loop {
        if tokio::time::Instant::now() >= deadline {
            println!("# 超时未确认（二维码可能已失效，可重跑本命令）");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let state = auth.poll_qr(&challenge.key).await?;
        if Some(state) != last {
            println!("# 扫码状态：{state:?}");
            last = Some(state);
        }
        match state {
            QrState::Confirmed => {
                println!("# 登录成功，凭据已写入 {}", config_path().display());
                return print_session(store).await;
            }
            QrState::Expired => {
                println!("# 二维码已失效，请重新运行 `login`");
                return Ok(());
            }
            QrState::Pending | QrState::Scanned => {}
        }
    }
}

async fn profiles(store: &Arc<ConfigStore>, use_profile: Option<String>) -> Result<()> {
    let auth = BiliAuth::new(Arc::clone(store))?;
    if let Some(name) = use_profile {
        let state = auth.switch_profile(&name).await?;
        println!("# 已切换到 profile `{name}`");
        println!("{}", session_json(&state)?);
        return Ok(());
    }
    let names = auth.profiles().await?;
    let active = store.active_name();
    for name in names {
        println!("{}{}", if name == active { "* " } else { "  " }, name);
    }
    println!("# 凭据文件：{}", config_path().display());
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
