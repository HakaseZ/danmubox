//! 弹幕框调试入口：脱离 UI 验证协议与适配器（`docs/roadmap.md`）。
//!
//! 凭据文件是三种登录模式的唯一落点：文件里没有可用凭据即为游客态。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use danmubox_bili::{
    BiliAdmin, BiliAuth, BiliEmotes, BiliFollow, BiliLive, BiliSender, BiliWallet,
};
use danmubox_core::ports::{
    AuthProvider, DanmakuSender, EmoteProvider, LiveSource, QrState, RoomAdmin, RoomCatalog,
    WalletProvider,
};
use danmubox_core::{
    config_path, prefs_path, ConfigStore, Event, EventBus, HistoryQuery, Prefs, RoomRuntime,
    RoomSession,
};
use tokio::sync::broadcast::error::RecvError;

#[derive(Parser)]
#[command(name = "danmubox", about = "弹幕框调试入口", version)]
struct Cli {
    /// 覆盖凭据文件路径。指向一个不存在的文件即可跑游客态采集——
    /// 用于 A21（游客态字段覆盖）这类需要对照两种登录态的校准，不必动真实凭据。
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,
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
    /// 扫码登录：不带账号名 = 新增账号（确认后按昵称自动起名）；带 = 给该账号重新登录
    Login {
        /// 要重新登录的账号名；缺省则新增一个账号
        target: Option<String>,
        /// 超时时间（秒）
        #[arg(long, default_value_t = 180)]
        timeout: u64,
    },
    /// 登出：清空账号的凭据字段（账号条目保留，之后还能再登录回来）
    Logout {
        /// 账号名；缺省 = 当前账号
        target: Option<String>,
    },
    /// 发送一条弹幕（需登录）
    Send {
        /// 房间号 / 短号 / URL
        room: String,
        /// 弹幕内容
        text: String,
        /// 颜色（十进制 RGB，默认白色）
        #[arg(long)]
        color: Option<i64>,
        /// 弹幕类型（A18 校准用）：1 滚动 / 4 底部 / 5 顶部。不给则由上游取默认。
        #[arg(long)]
        mode: Option<i64>,
        /// 以表情弹幕发送：给出表情的唯一键（`emotes` 子命令会打印）。给出后 `text` 仅用于日志。
        #[arg(long)]
        emote: Option<String>,
    },
    /// 列出账号（含登录状态与身份）；`--use` 切换、`--create` 扫码新增、`--remove` 删除
    Accounts {
        #[arg(long = "use")]
        use_account: Option<String>,
        /// 新增账号：发起扫码，确认后按昵称自动起名（不必先起名再扫码）
        #[arg(long)]
        create: bool,
        /// 扫码新增的等待时长（秒）
        #[arg(long, default_value_t = 180)]
        timeout: u64,
        /// 删除一个账号（不许删掉最后一个）
        #[arg(long)]
        remove: Option<String>,
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
    /// 打印主站「我的表情」（`upower_` 家族；未登录时上游退化为免费表情包）
    EmotesOwned,
    /// 只读核对房管列表接口：禁言 / 黑名单 / 屏蔽词（需登录；非房管时打印上游错误码）
    AdminLists {
        /// 房间号 / 短号 / URL
        room: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let path = cli.config.clone().unwrap_or_else(config_path);
    let store = Arc::new(
        ConfigStore::load(path.clone()).with_context(|| format!("读取 {} 失败", path.display()))?,
    );

    match cli.command {
        Command::Resolve { input } => resolve(&store, &input).await?,
        Command::Watch {
            input,
            seconds,
            quiet,
        } => watch(&store, input, seconds, quiet).await?,
        Command::Session => print_session(&store).await?,
        Command::Login { target, timeout } => qr_login(&store, target.as_deref(), timeout).await?,
        Command::Logout { target } => logout(&store, target.as_deref()).await?,
        Command::Accounts {
            use_account,
            create,
            timeout,
            remove,
        } => {
            accounts(
                &store,
                AccountsArgs {
                    use_account,
                    create,
                    timeout,
                    remove,
                },
            )
            .await?
        }
        Command::Send {
            room,
            text,
            color,
            mode,
            emote,
        } => send(&store, &room, &text, color, mode, emote).await?,
        Command::Wallet => wallet(&store).await?,
        Command::Follow => follow(&store).await?,
        Command::Emotes { room } => emotes(&store, &room).await?,
        Command::EmotesOwned => emotes_owned(&store).await?,
        Command::AdminLists { room } => admin_lists(&store, &room).await?,
    }
    Ok(())
}

async fn wallet(store: &Arc<ConfigStore>) -> Result<()> {
    let wallet = BiliWallet::new(Arc::clone(store))?;
    println!(
        "# 电池余额：{}",
        wallet.balance().await.context("查询余额失败")?
    );
    Ok(())
}

async fn follow(store: &Arc<ConfigStore>) -> Result<()> {
    let catalog = BiliFollow::new(Arc::clone(store))?;
    let rooms = catalog.followed().await.context("拉取关注列表失败")?;
    println!("# 关注的直播间：{} 个", rooms.len());
    for room in &rooms {
        println!(
            "  room_id={:<10} live_status={} 开播时刻={} 在线={} 分组={:?} {}",
            room.room_id,
            room.live_status,
            room.live_start_at,
            room.online,
            room.group_name,
            room.uname
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
            println!(
                "      {:<12} unique={:<22} {}",
                emote.text, emote.emoticon_unique, emote.url
            );
        }
    }
    Ok(())
}

/// 主站「我的表情」：核对唯一键（`upower_` + text）与图片 url 尾段。
async fn emotes_owned(store: &Arc<ConfigStore>) -> Result<()> {
    let provider = BiliEmotes::new(Arc::clone(store))?;
    let emotes = provider.owned().await.context("拉取主站表情失败")?;
    println!("# 主站「我的表情」：{} 个", emotes.len());
    for emote in &emotes {
        let tail = emote.url.rsplit('/').next().unwrap_or("");
        println!(
            "  {:<24} unique={:<30} {}",
            emote.text, emote.emoticon_unique, tail
        );
    }
    Ok(())
}

/// 房管列表接口的只读核对：路径、参数与响应形状的实测入口。
async fn admin_lists(store: &Arc<ConfigStore>, room: &str) -> Result<()> {
    let live = BiliLive::with_store(Arc::clone(store))?;
    let resolved = live.resolve_room(room).await?;
    let admin = BiliAdmin::new(Arc::clone(store))?;
    println!("# 房管列表（房间 {}）", resolved.room_id);

    match admin.silent_list(resolved.room_id).await {
        Ok(list) => {
            println!("禁言名单 {} 条", list.len());
            for user in list {
                println!("  uid={} {} {}", user.uid, user.uname, user.face);
            }
        }
        Err(err) => println!("禁言名单失败：{err}"),
    }
    match admin.blacklist(resolved.room_id).await {
        Ok(list) => {
            println!("黑名单 {} 条", list.len());
            for user in list {
                println!("  uid={} {} {}", user.uid, user.uname, user.face);
            }
        }
        Err(err) => println!("黑名单失败：{err}"),
    }
    match admin.keywords(resolved.room_id).await {
        Ok(words) => println!("屏蔽词 {} 个：{}", words.len(), words.join(" / ")),
        Err(err) => println!("屏蔽词失败：{err}"),
    }
    Ok(())
}

async fn send(
    store: &Arc<ConfigStore>,
    room: &str,
    text: &str,
    color: Option<i64>,
    mode: Option<i64>,
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
        .send(resolved.room_id, text, color, mode, token.as_ref(), None)
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
                        let emote = match &message.emote {
                            Some(e) => format!(" [表情 {} {}]", e.emoticon_unique, e.url),
                            None => String::new(),
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
                Ok(Event::RoomStats(stats)) => {
                    if !quiet {
                        println!(
                            "# 观众数 room_id={} 在线={:?} 看过={:?}",
                            stats.room_id, stats.online, stats.watched
                        );
                    }
                }
                Ok(Event::Status(status)) => {
                    println!("# 状态 {:?} {}", status.state, status.detail);
                }
                Ok(Event::Session(session)) => {
                    if !quiet {
                        println!(
                            "# 本人身份 room_id={} 粉丝牌={} Lv{} 佩戴={} 大航海={} 房管={}",
                            session.room_id,
                            session.my_medal_name,
                            session.my_medal_level,
                            session.my_medal_worn,
                            session.my_guard_level,
                            session.is_admin
                        );
                    }
                }
                // 开播状态：`LIVE` / `PREPARING` 的侧路（`docs/protocol.md` §10.7）——
                // 与那两条 `system` 消息各走各的，这里单独打一行，方便命令行核对状态迁移。
                Ok(Event::LiveStatus(status)) => {
                    if !quiet {
                        println!(
                            "# 开播状态 room_id={} live_status={}",
                            status.room_id, status.live_status
                        );
                    }
                }
                Ok(Event::Room(_)) => {}
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
    println!("# 凭据文件：{}", store.path().display());
    Ok(())
}

/// 扫码登录：`target` 缺省 = 新增账号（先扫码后起名），给名字 = 给该账号重新登录。
async fn qr_login(store: &Arc<ConfigStore>, target: Option<&str>, timeout_secs: u64) -> Result<()> {
    let auth = BiliAuth::new(Arc::clone(store))?;
    let challenge = auth.begin_qr(target).await.context("获取登录二维码失败")?;
    let code = qrcode::QrCode::new(challenge.url.as_bytes()).context("二维码编码失败")?;
    println!(
        "{}",
        code.render::<qrcode::render::unicode::Dense1x2>()
            .quiet_zone(true)
            .build()
    );
    match target {
        Some(name) => println!("# 给账号 `{name}` 重新登录：用 B 站客户端扫码"),
        None => println!("# 新增账号：用 B 站客户端扫码，确认后按昵称自动起名"),
    }
    println!("# qrcode_key={}", challenge.key);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut last: Option<QrState> = None;
    loop {
        if tokio::time::Instant::now() >= deadline {
            println!("# 超时未确认（二维码可能已失效，可重跑本命令）");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        let poll = auth.poll_qr(&challenge.key).await?;
        if Some(poll.state) != last {
            println!("# 扫码状态：{:?}", poll.state);
            last = Some(poll.state);
        }
        match poll.state {
            QrState::Confirmed => {
                match poll.account {
                    Some(account) => println!(
                        "# 登录成功：账号 `{}`（昵称 {}，uid {}）已写入 {}",
                        account.name,
                        account.nickname,
                        account.uid,
                        store.path().display()
                    ),
                    // 确认却不带账号是契约外的情形：照实说，不假装成功。
                    None => println!("# 已确认，但后端没有返回账号"),
                }
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

async fn logout(store: &Arc<ConfigStore>, target: Option<&str>) -> Result<()> {
    let auth = BiliAuth::new(Arc::clone(store))?;
    let state = auth.logout(target).await?;
    let name = target.unwrap_or(&state.active_profile);
    println!("# 已登出账号 `{name}`（条目保留，凭据已清空，可再扫码登回来）");
    print_session(store).await
}

/// 账号表的打印：当前账号打星，逐行给出登录状态与身份。
async fn print_accounts(auth: &BiliAuth) -> Result<()> {
    let list = auth.accounts().await?;
    if list.is_empty() {
        println!("# 还没有任何账号：`accounts --create` 或 `login` 扫码新增一个");
        return Ok(());
    }
    println!("# 账号 {} 个（* = 当前）", list.len());
    for account in list {
        println!(
            "{} {:<16} {:<7} uid={:<12} {}",
            if account.active { "*" } else { " " },
            account.name,
            if account.logged_in {
                "已登录"
            } else {
                "未登录"
            },
            account.uid,
            account.nickname
        );
    }
    Ok(())
}

/// `accounts` 的参数：Action 之间互斥，因此先收成一个结构体再分发。
struct AccountsArgs {
    use_account: Option<String>,
    create: bool,
    timeout: u64,
    remove: Option<String>,
}

async fn accounts(store: &Arc<ConfigStore>, args: AccountsArgs) -> Result<()> {
    let auth = BiliAuth::new(Arc::clone(store))?;
    let actions = [
        args.create,
        args.remove.is_some(),
        args.use_account.is_some(),
    ]
    .iter()
    .filter(|flag| **flag)
    .count();
    if actions > 1 {
        anyhow::bail!("`--create` / `--remove` / `--use` 只能给一个");
    }

    // 新增账号没有「先起名」这一步：直接走扫码，名字在确认后由昵称派生。
    if args.create {
        return qr_login(store, None, args.timeout).await;
    }
    if let Some(name) = args.remove {
        let state = auth.remove_account(&name).await?;
        println!("# 已删除账号 `{name}`");
        println!("{}", session_json(&state)?);
        print_accounts(&auth).await?;
        return Ok(());
    }
    if let Some(name) = args.use_account {
        let state = auth.switch_account(&name).await?;
        println!("# 已切换到账号 `{name}`");
        println!("{}", session_json(&state)?);
        print_accounts(&auth).await?;
        return Ok(());
    }
    print_accounts(&auth).await?;
    println!("# 凭据文件：{}", store.path().display());
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
