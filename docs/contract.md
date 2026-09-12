# danmubox 文档基线契约（规范性）

> 定位：本项目全部共享约定（命名、共享常量、领域模型、端口边界、IPC 与本地文件契约、写作要求）的唯一权威来源。
> 读者：所有实现者与 AI 编码 agent；动手写代码前必须先把本文读完。
> 更新时机：任何共享常量、模型、接口或数据结构变更，必须先改本文，再改代码与派生文档。

> 本文件是唯一事实源。文中标注「规范性」的内容只能原样引用，不得改名、不得改语义；
> 其它文档中出现的「基线契约 §x」均指本文件。
> **需求基线是 [`REQUIREMENTS.md`](../REQUIREMENTS.md)**（用户手写，随时可能修改）；本文负责把 REQUIREMENTS.md 翻译成工程约定。
> 选型背景与技术决策见 `docs/decisions/`；历史讨论已归档到 `docs/.archive/`（不进 git，不参与实现）。

---

## 1. 项目标识

| 项 | 值 |
|---|---|
| 仓库/目录 | `/Users/zack/Projects/danmubox` |
| 英文名 / crate 前缀 | `danmubox` |
| 中文名 | 弹幕框 |
| bundle id | `dev.kksk.danmubox` |
| 定位 | B 站直播间弹幕客户端，自用不发布 |
| 技术栈 | Tauri 2 + Rust 引擎 + React/TS 前端 |

## 2. 本期范围

**做**：macOS / Windows / Android 三端的弹幕客户端——看弹幕、发弹幕、表情包、举报、关注列表、礼物栏、身份徽标（主播 / 房管 / 总督 / 提督 / 舰长）、过滤与样式、房间内手动重连。

**不做（本期明确排除）**：

| 项 | 说明 |
|---|---|
| iOS 端、Fold8 / 折叠屏 | 后期 enhancement，本期不做 |
| **本地数据库** | 不建库、不落盘，见 §4.3 |
| **弹幕回看与导出** | 不做，见 §4.3 |
| **词云** | 非核心功能，列入下期 |
| **AI 原生接口** | 需求置空，本期不实现；只保留「后期接入 MCP」的架构兼容能力，见 §3 |
| 视频流解码 | 只消费弹幕协议 |
| 后台保活 / 推送 | 前台运行 |
| 应用商店发布 | 自用产物 |

## 3. 目录结构与依赖方向（规范性）

```
danmubox/
  Cargo.toml                # Rust workspace
  rust-toolchain.toml
  crates/
    danmubox-core/          # 领域模型 + 端口(trait) + 事件总线 + 会话编排 + 本地文件（禁止依赖 tauri；禁止依赖任何具体上游实现）
    danmubox-bili/          # B 站适配器：实现 core 的端口（协议/WS/鉴权/WBI/扫码/表情/举报/关注）
    danmubox-cli/           # 调试与校验入口（阶段 1 用于脱离 UI 验证协议与适配器）
  apps/
    desktop/                # Tauri 2 应用：src-tauri/ + ui/（React + TS + Vite）
  docs/
    contract.md             # 本文件
    decisions/              # ADR
  REQUIREMENTS.md           # 需求基线（用户手写）
  README.md
  AGENT.md
  CHANGELOG.md
```

依赖方向（规范性）：`danmubox-bili` → `danmubox-core`；`danmubox-cli` → `core` + `bili`；`apps/desktop/src-tauri` → `core` + `bili`。**`core` 不得依赖 `bili`，也不得依赖 `tauri`。**

**上游隔离（需求直接来源：REQUIREMENTS.md「B 站 API 不可控，可能有逆向需求，需要完全分离」）**

- `danmubox-core` 只定义**端口**（trait）与**领域模型**，不含任何 B 站 URL、字段下标、签名算法、protobuf 定义。
- 所有 B 站相关的 URL、字段名、下标、签名、二维码流程、protobuf schema 一律只出现在 `danmubox-bili`。
- 逆向或协议变更时，只改 `danmubox-bili`，`core` 与 `ui` 不动。

| 端口 | 职责 |
|---|---|
| `AuthProvider` | 登录态、凭据读写、扫码流程、buvid3；`create_profile(name)`（新建空 profile 并设为当前，名字 `[A-Za-z0-9_-]{1,32}`，非法/重名 → `BAD_REQUEST`，不覆盖已有）、`remove_profile(name)`（不许删最后一个 → `BAD_REQUEST`；不存在 → `NOT_FOUND`；删当前项则当前指向切到剩下的条目） |
| `LiveSource` | 房间解析、建立/断开连接、事件流；`room_identity(room_id) -> RoomSession`（本人在该房间的身份，取自官方进房接口；未登录返回全零身份而不报错） |
| `DanmakuSender` | 发送弹幕（含被吞状态归一化）；返回 `SendReport`（见 §5）。`emote: Option<&EmoteToken>` 非空时发送**表情弹幕**；`reply: Option<&ReplyTarget>` 非空时带上 @ / 回复字段（见 `protocol.md` §11.6） |
| `DanmakuReporter` | 举报弹幕；`reasons()` 取上游固定理由清单（官方客户端按文案反查 `reason_id` 后与文案一起上报） |
| `EmoteProvider` | 按身份加载表情包库；`owned()` 取主站「我的表情」（未登录时为上游免费表情包） |
| `RoomCatalog` | 关注列表、直播状态、房间元信息 |
| `WalletProvider` | 电池余额 |
| `RoomAdmin` | 直播间管理：禁言/解除、黑名单增删查、屏蔽词增删查。仅房管可用；上游非 0 code 原样带回、不赋语义 |

> **后期想法（本期不实现）**：接入 MCP，让 Agent 直接消费弹幕数据。为此刻意保持架构兼容——core 的端口与事件总线**不得假设消费方是 UI**，新能力一律经端口暴露，不得直接写进 Tauri 命令层。本期不定义任何 MCP 工具、协议或端点。

## 4. 本地文件与常量（规范性）

| 常量 | 值 |
|---|---|
| 日志级别 | 环境变量 `DANMUBOX_LOG`，默认 `info` |
| 数据目录 | macOS `~/Library/Application Support/danmubox`；Windows `%APPDATA%\danmubox`；Android 应用私有目录 |
| 凭据文件 | `config.toml`，权限 **0600**，见 §4.1 |
| 偏好文件 | `prefs.json`，见 §4.2 |
| 弹幕内存缓冲 | 单次房内会话内 5000 条环形缓冲，离开房间即销毁，见 §4.3 |
| WS 心跳 | 30 秒（op=2）；连接后首包 60 秒内发出，收到 op=3 回应后重置为 30 秒 |
| HTTP 心跳 | 60 秒一次，见 §6 |
| 重连退避 | 5s / 10s / 20s / 40s / 60s 封顶 |
| 压缩协商 | `protover=3`（brotli）；解码需同时支持 0 / 1 / 2 / 3 |
| 单包解压上限 | 16 MiB，超限丢弃并计数（防解压炸弹） |
| 发弹幕节流 | 同房间最小间隔 2s；相同内容 5s 内去重 |
| 时间表示 | 统一 UTC 毫秒，类型 `i64` |

### 4.1 凭据文件 `config.toml`（规范性）

需求直接来源：REQUIREMENTS.md「cookie 弄个配置文件存进去，默认扫码登录，如果本地有 cookie 则直接读取」。

```toml
active_profile = "default"

[profiles.default]
sessdata = ""
bili_jct = ""
dede_user_id = ""
dede_user_id_ck_md5 = ""
buvid3 = ""
buvid4 = ""
sid = ""

[profiles.work]
# 同上七个字段，用于多账号
sessdata = ""
```

- 形态：**明文 TOML**。自用场景不加密，靠文件权限（0600）与"只在本机数据目录"约束。
- 启动顺序（规范性）：读文件 → 取 `active_profile` 指向的 profile，其 `sessdata` / `bili_jct` / `dede_user_id` 齐全且非空则直接进入登录态；否则走扫码（默认入口）→ 成功后原子写回该 profile（临时文件 + rename）。
- **多账号（规范性）**：同一文件用 `[profiles.<name>]` 承载多份凭据，`active_profile` 指定当前生效者。切换账号 = 改 `active_profile` + 以新凭据重建连接，**不复制多份文件**。
- 「手填 Cookie」在本设计中即**直接编辑该文件**，不另做导入界面。
- **不得**在该文件中存放任何非凭据内容：界面偏好走 `prefs.json`。原因是 TOML 往返会丢注释与排版，程序每次改偏好都重写凭据文件是事故面。
- 安全红线（规范性，所有文档必须原样复述）：`SESSDATA`、`bili_jct`、`DedeUserID` **不得**进日志、不得进前端明文、不得进仓库、不得进崩溃上报。文档与脚本中的示例一律用占位值。
- **测试用的房间号与账号标识同样不得进 git**（提交信息与受版本控制的文件都算）；实测记录只写「某个在播房间」这类脱敏描述。测试后可复用的房间属于使用者的私产，不进仓库。
  - **例外（唯一）**：公开测试房间 `1`（哔哩哔哩直播官方直播间）允许写入文档。它的真实房间号由 `room_init` / `getRoomPlayInfo` 解析得到，写 `1` 即可。
  - 该房间的直播状态随官方轮播变化（可能是轮播或无弹幕），因此它适合做**连接、解析与发送**的冒烟测试，不适合当作稳定的弹幕采集源。
- **测试期间不得发送任何有价值内容**：礼物、醒目留言（SuperChat）、大航海等一律不发。发送测试只用纯文本弹幕。

### 4.2 偏好文件 `prefs.json`（规范性）

- 形态：单层 JSON 对象，键即 §8 的偏好键，值为该键的 JSON 值。
- 只存**被显式改过**的键；文件缺失或键缺失时回落到默认值。
- 写入必须原子替换；文件损坏时按默认值启动并保留损坏副本 `prefs.json.bak`。
- `GET`/`SET` 语义见 §8。

### 4.3 弹幕本地保留（规范性）

- **不建数据库，不做回看，不做导出。**
- 缓冲的生命周期 = **一次房内会话**：从进入某个直播间开始，到离开该房间（返回房间列表、关闭房间或切走）结束。离开即**销毁并清空**；再次进入同一房间是全新的一次会话。
- 会话内保留上限 5000 条的环形缓冲（容量由 `history.buffer_rows` 覆盖），超出丢最旧。进程退出即丢。
- B 站只提供「进房间时最近若干条」的接口（`data.room`，上限 10 条，**不可翻页**，见 `protocol.md` 附录 A30），**不提供可翻页的历史回放**。因此跨会话历史只能本地落盘，而本次会话的缓冲仍是内存——这是一个已接受的产品取舍。
- 唯一允许的用途是当前会话内在界面上向上回滚查看（`history_query` 只查当前会话缓冲）。
- **进场回填**：进入房间时先用 `LiveSource::recent` 取上游能给的「最近若干条」弹幕（`data.room`，上限 10 条，**不可翻页**，见 `protocol.md` 附录 A30），
  标记 `is_history` 后作为本次会话缓冲的**前缀**（先回填、再连接，因此顺序天然是历史在前）；
  每条回填已带 `upstream_id`，因此与实时弹幕一样可举报。
  上游同一响应里还有一个 `data.admin`（至多 10 条「只看房管」切片），**不采用**：它是同一窗口的房管子集，
  与 `data.room` 大量重合且时间整体更早，拼在前缀里会表现为「我自己的发言铺在历史之前」（2026-09-12 实测，见 A30）。
- 回填**不经过 `MessageSink`**，因此不计入「收到的消息」等流量统计。
- 回填是**尽力而为**：上游可能返回空或失败（A30），此时与从前一样从空列表开始——**不得报错、不得重试风暴、不得因此延迟连接**（实现侧有 2 秒上限）。
- 长连接卡住或推流中断时，用房间内的「刷新」按钮触发**手动重连**（`rooms_reconnect`）；重连不恢复旧缓冲，仍属同一次会话，已收到的消息保留。
- 输入草稿与「最近发送记录」同样只存在**会话内内存**中：不落盘、不写 `prefs.json`（REQUIREMENTS.md §2.2）。
- 若将来需要跨会话历史，方案是**追加式 JSONL 文件**（按天分片），不引入数据库；届时另立 ADR。
- 落库概念相关的字段与机制（`dedup_key`、`raw` 保留、`user_version` 迁移、索引、WAL、单写者 actor、保留天数、行数上限清理）**全部不存在**，文档与代码中不得出现。

## 5. 领域模型（规范性）

`kind` 取值只有六种：`danmaku` | `gift` | `superchat` | `interact` | `guard` | `system`。

`Message`（Rust 侧，JSON 侧 snake_case）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `local_id` | u64 | 会话内自增序号，由 `MessageSink` 分配（`0` 仅表示「尚未分配」，出现在界面即缺陷）；仅用于 UI key 与本地引用，进程重启后重置。**事件与 `history_query` 两条路径必须给出同一个号** |
| `room_id` | i64 | 真实房间号 |
| `kind` | string | 见上 |
| `ts` | i64 | UTC 毫秒 |
| `uid` | i64 | 发送者 UID，游客/未知为 0 |
| `uname` | string | 昵称 |
| `content` | string | 文本内容（礼物/SC 为描述文本） |
| `color` | i64 | 弹幕颜色十进制 RGB |
| `medal_level` | i64 | 发送者粉丝牌等级，0 无 |
| `medal_name` | string | 发送者粉丝牌名 |
| `guard_level` | i64 | 0 无 / 1 总督 / 2 提督 / 3 舰长 |
| `is_admin` | bool | 发送者是否房管（REQUIREMENTS.md 需求） |
| `is_history` | bool | 是否来自进场回填（§4.3）；实时推送恒为 `false` |
| `amount` | i64 | 礼物金瓜子或 SC 金额，非交易类为 0 |
| `emote` | object \| null | 表情弹幕的**整份**表情信息（`EmoteRef`，见下）；非表情弹幕为 `null`。存整份而非只存图片地址，是为了让界面能把它**再发出去** |
| `face` | string | 发言者头像 URL（`info[0][15].user.base.face`，历史条目同层）；取不到为空串，界面自行降级 |
| `medal_color_start` | string | 粉丝牌起始色（上游 `user.medal.v2_medal_color_start`），带 alpha 的 CSS 十六进制串（如 `#3FB4F699`）；无牌/缺失为空串 |
| `medal_color_end` | string | 同上（`v2_medal_color_end`） |
| `medal_color_border` | string | 同上（`v2_medal_color_border`） |
| `medal_color_text` | string | 同上（`v2_medal_color_text`）。**空串不是颜色**，界面必须自备兜底色，不得拿黑色顶替 |
| `upstream_id` | string | **上游弹幕标识，举报必需**（来源待实测，见 `protocol.md` 附录） |

> **徽标（REQUIREMENTS.md 需求）**：主播 = `uid == Room.anchor_uid` 派生；房管 = `Message.is_admin`；大航海 = `Message.guard_level`（`1` 总督 / `2` 提督 / `3` 舰长）。`is_anchor` 不设独立字段——能推导就不存。

`SendOutcome`（发弹幕结果，规范性）：

| 取值 | 含义 | 判定 |
|---|---|---|
| `ok` | 已发出且进入公开弹幕流 | 上游返回成功 |
| `blocked_platform` | 被平台风控吞掉 | 上游响应 `msg`/`message` == `"f"` |
| `blocked_room` | 被直播间（主播/房管）吞掉 | 上游响应 `msg`/`message` == `"k"` |
| `rate_limited` | 频率限制 | 上游对应错误码 |
| `medal_required` | 粉丝牌等级不足 | 上游对应错误码 |
| `muted` | 已被禁言 | 上游对应错误码 |
| `failed` | 其他失败 | 兜底，需带原始 code 与 message |

`SendReport`（发送结果的规范性形状，`chat_send` 与端口共用）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `outcome` | `SendOutcome` | 归一化结论，上表七取一 |
| `upstream_code` | `number | null` | 上游 `code` 原样，**不翻译**；本地节流拦下时为 `null`（没发请求） |
| `upstream_message` | `string | null` | 上游 `msg` / `message` 原话，**不改写** |

> 纪律：`SendOutcome` 只表达**已经敢下结论**的取值；一切未知 code 进 `failed`，其原始 `code` 与 `message` 通过 `SendReport` 一路带到界面（`REQUIREMENTS.md` §2.3 要求给出禁言 / 频率 / 粉丝牌等原因）。码表映射见 `protocol.md` 附录 A17。

> `blocked_platform` / `blocked_room` 的判定规则来自一个可复现的社区实现（见 `protocol.md` 发送章节），阶段 1 必须用真实发送复核后写死。

`RoomStats`（**房间观众数**，会话级、不落盘、不入缓冲，规范性）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_id` | i64 | 房间号 |
| `online` | Option&lt;i64&gt; | 在线人数（`ONLINE_RANK_COUNT` 的 `online_count`，协议 §10.7）；上游未给过为 `null` |
| `watched` | Option&lt;i64&gt; | 累计看过（`WATCHED_CHANGE` 的 `num`，协议 §10.7）；上游未给过为 `null` |

> 两个数各自随不同命令到达，因此两侧都可缺省；界面保留上一次的值，不用 0 顶替。
> 人气值（`POPULARITY_CHANGE` / `op=3`）**不再展示**（用户 2026-09-12 反馈：那个参数官方也没实现）。

`RoomSession`（**本人在该房间的身份**，会话级、不落盘，规范性）：
| 字段 | 类型 | 说明 |
|---|---|---|
| `room_id` | i64 | 房间号 |
| `my_medal_level` | i64 | 我在**该直播间**的粉丝牌等级，0 表示无牌 |
| `my_medal_name` | string | 我在该直播间的粉丝牌名 |
| `my_guard_level` | i64 | 我在该直播间的大航海等级 |
| `is_admin` | bool | 我在该直播间是否房管 |

> 与 `Message.medal_level` 区分：后者是**发送者**的牌，前者是**我**在这个房间的牌。表情包库可用范围取决于这套身份。

`Emote`（表情，规范性）：`key` / `emoticon_unique`（上游唯一键，发送表情弹幕时 `msg` 传它）/ `width` / `height` / `is_dynamic` / `in_player_area` / `bulge_display` / `package_kind`（`common` / `room` / `medal` / `guard` / `owned`；`owned` = 主站「我的表情」中用户拥有的包，见 `protocol.md` A35；`room` = UP 主大表情与房间专属表情。**没有 `admin`**——房管没有表情分类，见 `protocol.md` A26）/ `text` / `url` / `room_id`（房间专属时非 0）。

`EmoteRef`（弹幕携带的表情，规范性）：`emoticon_unique` / `url`（已规范化）/ `width` / `height` / `is_dynamic` / `in_player_area` / `bulge_display`。

> 为什么存整份而不只存图片地址：上游有些表情家族（`upower_` 的 UP 主专属表情）**不在直播表情接口里**，
> 只能从收到的弹幕学到。存全了，界面才能把它们补进选择器、让用户**再发出去**（`protocol.md` A35）。

`SilentUser` / `BlacklistedUser`（房管列表条目，规范性）：`uid` / `uname` / `face`。禁言名单与黑名单各一套——前者是「本直播间禁言」，后者是「拉黑（自动解除关系并禁止互动）」。

`ReportReason`（举报理由，规范性）：`id` / `reason`。取自上游 `dMReport/ForReason`，界面只让用户从清单里选。

`FollowedRoom`（关注列表，规范性）：`room_id` / `uname` / `face` / `live_status`（0 未开播 / 1 直播中 / 2 轮播）/ `group_name` / `live_start_at` / `online`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `live_start_at` | i64 | **最后/本次开播的起始时间**（上游 `liveTime`，Unix 秒；0 = 未知）。命名刻意避开上游另一个字段 `live_time`（那个是**已开播秒数**，与 `liveTime` 相加等于当前时间——靠这个关系确认了 `liveTime` 的语义，见 2026-09-12 实测）。 |
| `online` | i64 | 人气/在线数（上游 `online`；缺失 = 0） |

**展示排序**：`live_status == 1` 置顶（REQUIREMENTS.md 需求）；同一档内按 `live_start_at` 降序。用户 2026-09-12 追加要求：**未开播的也要列出**，因此不再只展示直播中的房间。

## 6. B 站协议要点（规范性）

- 包结构：16 字节大端头 `packetLen:u32 | headerLen:u16(=16) | protover:u16 | op:u32 | seq:u32`。
- **protover 是载荷编码版本**：`0` 裸 JSON / `1` 认证与心跳包的帧头版本 / `2` zlib / `3` brotli。请求固定用 `3`。
- **op 才是包类型**：`2` 心跳 / `3` 心跳回应（人气值）/ `5` 业务消息 / `7` 认证 / `8` 认证成功。
- 认证包（op=7，帧头 `protover=1`）：body JSON `{ "uid", "roomid", "protover": 3, "buvid", "platform": "web", "type": 2, "key" }`；游客 `uid=0`、`key=""`。
- WS 心跳包（op=2，帧头 `protover=1`）：body 为字面量 `[object Object]`。（参考实现中 Go 侧发空 body 亦稳定；以 Python 侧与官方 web 客户端行为为准。）
- **HTTP 心跳（易漏，务必实现）**：每 60 秒 `GET https://live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat`，参数 `pf=web` 与 `hb=base64("60|<真实room_id>|1|0")`。缺它连接会被上游判死。
- `op=5` 的 body 解压后可能仍是「多个 16 字节头子包」的拼接，必须循环按头拆分直到消费完；子包 protover 可能再次为 2 或 3。
- `op=3` 的 body 为 4 字节大端无符号整数，即人气值。
- **`INTERACT_WORD_V2` 的载荷是 protobuf**，不是 JSON（Rust 侧用 `prost` 从 `data` 字段 base64 解码）。
- `DANMU_MSG` 关键取值：内容在 `info[1]`；明文用户对象在 `info[0][15].user`（`uid`、`base.name`、`base.face`）。
- `DANMU_MSG_MIRROR` 是非本房间的镜像弹幕，默认丢弃并计数。
- 短号/URL → 真实 `room_id`：使用 `getRoomPlayInfo`，一次拿到 `room_id` / `uid` / `live_status`。
- 认证回应 `code=0` 为成功；非 0 一律视为认证失败并按退避重连，**不得**在未知 code 上编造含义。

## 7. Tauri IPC（规范性）

Frontend → Rust 命令（`invoke`）：

| 命令 | 用途 |
|---|---|
| `session_status` | 登录态（不含 Cookie 值），含当前 `active_profile` |
| `session_qr_start` / `session_qr_poll` | 扫码登录 |
| `emotes_owned` | 主站「我的表情」（用户拥有的表情包）；`package_kind` 为 `owned`，唯一键 = `"upower_" + 表情 text` |
| `room_session` | 返回该房间**当前会话**里的本人身份（`RoomSession`）。房间无活跃会话（未连接/已关闭）→ 返回该 room 的全零身份而**不报错**（与 `history_query` 同风格）。身份在会话建立时并发取一次并缓存，同时经既有 `danmubox://session` 事件推送 |
| `admin_mute` / `admin_unmute` | 禁言 / 解除（`room_id`、`uid`、`hour`：`-1` 永久、`0` 本场） |
| `admin_blacklist_list` / `_add` / `_del` | 直播间黑名单（列表 / 加入 / 移除） |
| `admin_keywords_list` / `_add` / `_del` | 直播间屏蔽词（列表 / 添加 / 删除） |
| `admin_silent_list` | 禁言名单（`SilentUser[]`）——房管功能做完整所需，官方面板也有这一栏 |
| `session_logout` | 登出并清空 `config.toml` 中当前 profile 的凭据 |
| `profiles_list` / `profiles_switch` | 列出配置文件中的 profiles、切换当前 profile 并以新凭据重连 |
| `profiles_create` | 新建 profile 并设为当前（非法/重名 → `BAD_REQUEST`，不覆盖已有） |
| `profiles_remove` | 删除 profile（不许删最后一个；不存在 → `NOT_FOUND`；删当前项自动切换） |
| `rooms_list` / `rooms_add` / `rooms_remove` | 房间增删查 |
| `rooms_connect` / `rooms_disconnect` | 连接控制 |
| `rooms_reconnect` | 手动重连（房间内「刷新」按钮），用于长连接卡住或推流中断 |
| `history_query` | 查询**当前房内会话**的缓冲（`limit` / `after` / `before` / `kinds` / `uid` / `q`） |
| `chat_send` | 发弹幕（可带 `emote` 与 `reply`）——`emote` 非空时按表情弹幕发送（`docs/protocol.md` §11.4），返回 `ChatSendResult { room_id, content, outcome, detail? }`。`detail` 是上游 `message` + `code` 拼成的一行，仅在 `outcome != ok` 时出现 |
| `chat_report` | 举报弹幕，理由取自上一步的清单（`{id, reason}`） |
| `report_reasons` | 举报理由清单（上游固定 7 条） |
| `open_url` | 用系统浏览器打开链接（点昵称跳用户主页）；仅接受 `http(s)` |
| `emotes_list` | 按**真实会话身份**加载表情包库（上游据此下发可用包；此前传零身份，会缺粉丝牌与大航海那几包） |
| `follow_list` | 关注列表（**每次实时拉取**，不设单独的刷新命令） |
| `wallet_balance` | 电池余额 |
| `prefs_get` / `prefs_set` | 偏好读写 |
| `app_info` | 版本、数据目录、构建信息 |

Rust → Frontend 事件：`danmubox://message` `danmubox://room` `danmubox://session` `danmubox://status` `danmubox://send` `danmubox://room_stats` `danmubox://log`。

`danmubox://room_stats` 的载荷是 §5 的 `RoomStats`（在线人数 / 累计看过，两侧可缺省）。

IPC 载荷即 §5 的 snake_case 结构，前端 store 内部转 camelCase。

## 8. 偏好键（规范性）

存于 `prefs.json`（§4.2）。**这是唯一权威清单**，其它文档引用时不得改名：

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `ui.font_scale` | number | `1.0` | 聊天区字号缩放，范围 0.8–2.0 |
| `ui.theme` | string | `"system"` | `system` / `dark` / `light` |
| `ui.auto_scroll` | boolean | `true` | 是否自动跟随最新 |
| `ui.pause_on_hover` | boolean | `true` | 鼠标悬停暂停自动滚动 |
| `ui.merge_similar` | boolean | `true` | 是否合并相似消息 |
| `ui.merge_window_ms` | integer | `8000` | 相似消息合并窗口 |
| `ui.gift_panel_mode` | string | `"merged"` | `merged`（礼物混在弹幕栏）/ `separate`（独立礼物栏） |
| `ui.interact_auto_hide` | boolean | `true` | 互动/进场消息显示一会儿后自动消失（`false` = 常驻） |
| `ui.system_notice` | boolean | `false` | 是否显示系统通知（开播 / 下播 / 标题变更 / 公告） |
| `ui.show_timestamp` | boolean | `false` | 弹幕前是否显示时间戳（用户 2026-09-12 反馈：要可开关） |
| `composer.phrases` | string[] | `[]` | 自定义短语（需求 §2.2）；点一下插入输入框。颜文字是内置常量，不占用偏好键 |
| `filter.keywords` | string[] | `[]` | 关键词列表 |
| `filter.keywords_mode` | string | `"hide"` | `hide` 命中隐藏 / `only` 仅显示命中 |
| `filter.keywords_alert` | boolean | `false` | 命中关键词时高亮并提示音 |
| `filter.uids` | integer[] | `[]` | 用户 UID 过滤列表 |
| `filter.kinds` | string[] | 六种 kind 全集 | 参与展示的消息类型白名单 |
| `filter.medal_level_min` | integer | `0` | 粉丝牌最低等级 |
| `history.buffer_rows` | integer | `5000` | 每房间内存缓冲条数上限 |

`ui.gift_panel_mode` 对应 REQUIREMENTS.md「可以配置独立一个礼物栏或者礼物混合在弹幕栏中」。

读写语义（对 `prefs_get` / `prefs_set` 生效）：读返回全部键的**生效值**（默认值已合并）；写接受部分键值补丁，未知键或非法值报 `BAD_REQUEST`，成功返回合并后的生效值全集。

## 9. 需求溯源（规范性）

每条 REQUIREMENTS.md 需求必须能找到承载它的规范章节；反过来，本文新增的约定必须能追到 REQUIREMENTS.md。无法追溯的条款不得留在本文。

| REQUIREMENTS.md 需求 | 承载位置 |
|---|---|
| 看弹幕 / 发弹幕 | §5、§6 |
| 按用户身份加载表情包库 | §3 `EmoteProvider`、§5 `Emote` / `RoomSession`、§7 `emotes_list` |
| 举报弹幕（同官方行为） | §3 `DanmakuReporter`、§5 `upstream_id`、§7 `chat_report` |
| 上游代码完全分离 | §3 端口与依赖方向 |
| cookie 配置文件 / 默认扫码 / 有则直读 | §4.1 |
| 房管身份 | §5 `is_admin` |
| 本房间粉丝牌等级 | §5 `RoomSession.my_medal_level` |
| 礼物事件 / 独立礼物栏或混合 | §8 `ui.gift_panel_mode` |
| 关注列表 + 直播中置顶 | §5 `FollowedRoom`、§7 `follow_list` |
| 发言失败原因（全局/直播间禁言、等级、频率） | §5 `SendOutcome` |
| 电池余额 | §3 `WalletProvider`、§7 `wallet_balance` |
| 徽标（主播 / 房管 / 大航海） | §5 徽标说明 |
| 房间内手动刷新 / 重连 | §4.3、§7 `rooms_reconnect`、`ui.md` |
| 单次会话内保留弹幕 | §4.3 |
| 进场回填最近弹幕（用户 2026-09-12 追加，非 REQUIREMENTS.md 原文） | §3 `LiveSource::recent`、§4.3、§5 `is_history`、`ui.md` §4.7 |
| 词云 | 下期非核心条目，见 `roadmap.md` |
| 深色模式 / 字号 | §8 `ui.theme` / `ui.font_scale` |
| 透明度（原 `ui.opacity`） | **已删除**（用户 2026-09-12 反馈：实现方式非预期），待办见 `roadmap.md` |
| 房间观众数（在线人数 / 累计看过） | §5 `RoomStats`、§7 `danmubox://room_stats` |
| 互动消息自动消失 / 系统通知开关 | §8 `ui.interact_auto_hide` / `ui.system_notice` |
| 关注列表自动加载 | §3 `RoomCatalog`、§7 `follow_list`、`ui.md` §2.2 |
| 时间戳显示开关 / 用户头像 / 粉丝牌与身份标识（#6） | §5 `Message.face`、§8 `ui.show_timestamp`、`ui.md` |
| 主站「我的表情」可发送（#8） | §5 `Emote.package_kind=owned`、§7 `emotes_owned` |
| 房管功能：禁言 / 黑名单 / 屏蔽词（#3） | §7 `admin_*`、`protocol.md` A36 |
| 过滤与合并相似 | §8 `filter.*` / `ui.merge_*` |
| 多房间标签页 | `ui.md` |
| 多账号（单文件多 profiles） | §4.1、§7 `profiles_list` / `profiles_switch` |
| 草稿与最近发送记录（会话内） | §4.3 |
| bundle id 变更 | §1 |
| **已从需求中移除** | 本地数据库、跨会话历史、弹幕回看、导出、AI 原生接口、AI 日报、免打扰时段、提示音、快捷键、多房间未读静音、断线补齐、开播提示、按 uid 只看某人、谢谢礼物模板 |

## 10. 写作要求（强制）

1. 正文中文，标识符/技术名词保留英文。
2. 文件开头三行引言块：定位 / 读者 / 更新时机。
3. 表格优先于长段落；接口、字段、常量必须用表格或代码块。
4. **禁止**出现 `TODO`、`待补充`、`占位`、`XXX` 之类空壳。
   - 对 B 站未实测的事实用「待实测校准」表格承载，写明核对方法与责任人动作，不得凭空编造具体数值。
5. **禁止**创建源码或构建文件（`.rs` `.ts` `.tsx` `.toml` `.json` `.lock`）。只写 Markdown。
6. 只写自己负责的文件，不得修改他人文件。
7. 不执行 git 操作，不运行构建、测试、格式化、lint。
8. 引用其他文档用相对路径。
9. **收敛优先**：文档只保留四类内容——① 当前需求与规范性契约；② 技术决策（ADR）；③ 为构建、验证、交付所必需的流程；④ B 站侧的待实测校准项。已撤销的方案、未被要求的增强、为尚不存在的代码写的实现细节，一律移出仓库：有历史价值的进 `docs/.archive/`（不进 git），其余直接删除。

## 11. 文档清单

| 文件 | 状态 |
|---|---|
| `REQUIREMENTS.md` | 需求基线（用户手写） |
| `README.md` / `AGENT.md` / `CHANGELOG.md` | 本期 |
| `docs/contract.md` | 本文件（规范性契约） |
| `docs/protocol.md` / `auth.md` / `architecture.md` / `ipc.md` / `ui.md` | 本期 |
| `docs/roadmap.md` / `testing.md` / `distribution.md` / `operations.md` | 本期 |
| `docs/decisions/*` | 本期 |
| `docs/.archive/` | **不进 git**；仅存放已撤销方案与历史讨论，不参与实现，引用它一律视为无效 |

已从仓库移除（不归档、不重建）：`docs/data-model.md`（无数据库）、`docs/api.md`（无 HTTP API）。
