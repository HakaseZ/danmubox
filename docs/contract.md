# danmubox 基线契约（规范性）

## 1. 项目标识

| 项 | 值 |
|---|---|
| 仓库/目录 | 仓库根 `danmubox/`（本机克隆路径任意，如 `~/Projects/danmubox`） |
| 英文名 / crate 前缀 | `danmubox` |
| 中文名 | 弹幕框 |
| bundle id | `dev.kksk.danmubox` |
| 定位 | ac站直播间弹幕客户端，自用不发布 |
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
| 后台保活 / 推送 | **桌面端**：前台运行（关窗即退出）；**Android 例外**：退到后台且仍有活跃房间连接时起一枚 `dataSync` 前台服务 + 常驻通知，回前台即停（`issue` 2609160959 #10；口径与限制见 [`operations.md`](operations.md) §2.8、验证边界见 [`testing.md`](testing.md) §10.5）。**推送**不做 |
| 应用商店发布 | 自用产物 |

## 3. 目录结构与依赖方向（规范性）

```
danmubox/
  Cargo.toml                # Rust workspace
  rust-toolchain.toml
  crates/
    danmubox-core/          # 领域模型 + 端口(trait) + 事件总线 + 会话编排 + 本地文件（禁止依赖 tauri；禁止依赖任何具体上游实现）
    danmubox-bili/          # ac站适配器：实现 core 的端口（协议/WS/鉴权/WBI/扫码/表情/举报/关注）
    danmubox-cli/           # 调试与校验入口（阶段 1 用于脱离 UI 验证协议与适配器）
  apps/
    desktop/                # Tauri 2 应用：src-tauri/ + ui/（React + TS + Vite）
```

依赖方向（规范性）：`danmubox-bili` → `danmubox-core`；`danmubox-cli` → `core` + `bili`；`apps/desktop/src-tauri` → `core` + `bili`。**`core` 不得依赖 `bili`，也不得依赖 `tauri`。**

**上游隔离（需求直接来源：REQUIREMENTS.md「ac站 API 不可控，可能有逆向需求，需要完全分离」）**

- `danmubox-core` 只定义**端口**（trait）与**领域模型**，不含任何 ac站 URL、字段下标、签名算法、protobuf 定义。
- 所有 ac站相关的 URL、字段名、下标、签名、二维码流程、protobuf schema 一律只出现在 `danmubox-bili`。
- 逆向或协议变更时，只改 `danmubox-bili`，`core` 与 `ui` 不动。

端口定义见 `crates/danmubox-core/src/ports.rs`。各端口职责：

| 端口 | 职责（方法名以 `ports.rs` 为准） |
|---|---|
| `AuthProvider` | 登录态、账号列表、扫码流程、账号切换 / 登出 / 删除、buvid3（`ports.rs:87`）。账号名规则 `[A-Za-z0-9_-]{1,32}`，两端空白收敛，非法 → `BAD_REQUEST`（`crates/danmubox-core/src/config.rs:139-165`）；删最后一个账号 → `BAD_REQUEST`、账号不存在 → `NOT_FOUND`（`config.rs:319-330`），删当前项则 `active_profile` 切到剩余条目（`config.rs:328-340`） |
| `LiveSource` | 房间解析、建立/断开连接、事件流；`room_identity(room_id) -> RoomSession`（本人在该房间的身份，取自官方进房接口；未登录返回全零身份而不报错）；`live_status(room_id) -> i32`（只读一次开播状态，**不做**昵称标题那一跳：列表页的定期刷新逐房间走它，§4）；`recent(room_id)` 取进场回填（§4.3）（`ports.rs:124-152`） |
| `DanmakuSender` | 发送弹幕（含被吞状态归一化）；返回 `SendReport`（见 §5）。`emote: Option<&EmoteToken>` 非空时发送**表情弹幕**；`reply: Option<&ReplyTarget>` 非空时带上 @ / 回复字段（见 `protocol.md` §11.6）（`ports.rs:213-227`） |
| `DanmakuReporter` | 举报弹幕；`reasons()` 取上游固定理由清单（官方客户端按文案反查 `reason_id` 后与文案一起上报）（`ports.rs:229-235`） |
| `EmoteProvider` | 按身份加载表情包库（`emotes(room_id, session)`）；`owned()` 取主站「我的表情」（未登录时为上游免费表情包）（`ports.rs:238-249`） |
| `RoomCatalog` | 关注列表（`followed()`；定义见 `ports.rs:288-291`） |
| `WalletProvider` | 电池余额（`ports.rs:294-296`） |
| `RoomAdmin` | 直播间管理：禁言/解除、黑名单增删查、屏蔽词增删查（`ports.rs:257-285`）。仅房管可用；上游非 0 code 原样带回、不赋语义 |

**架构约束**：`core` 的端口与事件总线**不得假设消费方是 UI**，新能力一律经端口暴露，不得直接写进 Tauri 命令层。本期不定义任何 MCP 工具、协议或端点。

## 4. 本地文件与常量（规范性）

| 常量 | 值 | 代码位置 |
|---|---|---|
| 日志级别 | 环境变量 `DANMUBOX_LOG`，默认 `info` | `apps/desktop/src-tauri/src/lib.rs:1232`；CLI 同口径 `crates/danmubox-cli/src/main.rs:619` |
| 数据目录 | macOS `~/Library/Application Support/danmubox`；Windows `%APPDATA%\danmubox`；其余平台 `$HOME/.local/share/danmubox`；`DANMUBOX_HOME` 覆盖以上全部 | `crates/danmubox-core/src/paths.rs:8-65` |
| Android 数据目录 | 外壳在启动最早期把 `DANMUBOX_HOME` 注入为 Tauri `app_data_dir()`（应用私有 dataDir 本身，不是其下的 `files/` 子目录）；`danmubox-core` 保持平台无关、不写死平台路径 | `apps/desktop/src-tauri/src/lib.rs:1208-1223` |
| 凭据文件 | `config.toml`，权限 **0600**，见 §4.1 | `crates/danmubox-core/src/config.rs:399-408` |
| 偏好文件 | `prefs.json`，见 §4.2 | `crates/danmubox-core/src/paths.rs:43` |
| 诊断导出文件 | `danmubox-diagnose-YYYYMMDD-HHMMSS.txt`（UTC）；桌面写主目录下的 `Downloads`（不存在则回退主目录），Android 经 MediaStore 写公共 `Download`；**一次诊断恰好一个文件**，见 §4.4 | `apps/desktop/src-tauri/src/diagnose.rs:13-17`；`crates/danmubox-core/src/paths.rs:32-45` |
| 消息内存缓冲 | 单次房内会话内**按 `kind` 分档**的内存缓冲（各档上限 = §8 的 `history.buffer_rows_*`，语义与分档规则见 §4.3），离开房间即销毁 | `crates/danmubox-core/src/session.rs:75-118`（`BufferCaps` / `lanes`） |
| WS 心跳 | 30 秒（op=2），周期固定；**认证成功（`op=8` 且 `code=0`）后立即发出首包**——60 秒是硬上界、不是等待时长（见 §6） | `crates/danmubox-bili/src/ws.rs:84`、`ws.rs:779-810` |
| HTTP 心跳 | 60 秒一次，见 §6 | `crates/danmubox-bili/src/ws.rs:40` |
| 重连退避 | 5s / 10s / 20s / 40s / 60s 封顶 | `crates/danmubox-bili/src/ws.rs:37-38`、`ws.rs:1085-1091` |
| 压缩协商 | `protover=3`（brotli）；解码需同时支持 0 / 1 / 2 / 3 | `crates/danmubox-bili/src/proto.rs:24-27` |
| 单包解压上限 | 16 MiB，超限丢弃并计数（防解压炸弹） | `crates/danmubox-bili/src/proto.rs:14` |
| 发弹幕节流 | 同房间最小间隔 2s；相同内容 5s 内去重 | `crates/danmubox-bili/src/send.rs:20`、`send.rs:22` |
| 列表页开播状态刷新 | **30 秒**，仅在**房间列表页可见**时进行 | `apps/desktop/ui/src/store.ts:528` |
| 列表页刷新失败退避 | 失败一次后按 `60 → 120 → 240` 秒翻倍、`240` 秒封顶（成功即复位；正常周期仍是 30 秒），上一拍没回来不发下一拍 | `apps/desktop/ui/src/store.ts:572-582` |
| 弹幕聚合窗口 | **5000 ms**（`AGGREGATE_WINDOW_MS`）；与**锚点**（这一行的第一条）比，**非滑动** | `apps/desktop/ui/src/aggregate.ts:22` |
| 弹幕聚合条数上限 | **999**（`AGGREGATE_MAX_COUNT`）；到顶即封口，由下一条开一行新的 | `apps/desktop/ui/src/aggregate.ts:30` |
| 弹幕聚合展示观众数 | **3**（`AGGREGATE_SENDERS_SHOWN`）；其余按「等 N 人」（N = 参与观众总数） | `apps/desktop/ui/src/aggregate.ts:38` |
| 弹幕聚合归一化 | `danmaku` 的正文：去首尾空白 → 连续空白并成一个空格 → 大小写不敏感；**表情弹幕**按 `emote.emoticon_unique`（图不同即不同条） | `apps/desktop/ui/src/aggregate.ts:56-66` |
| 时间表示 | 统一 UTC 毫秒，类型 `i64` | `crates/danmubox-core/src/lib.rs:31` |

**弹幕聚合的约束（issue 2609171849 第 7 条）**：

- **不同观众**在窗口内发的**同一条**弹幕折成一行，展示 `×N` 与「都是谁」（规则与展示见 [`ui.md`](ui.md) §8.4）。
- **至少要两位不同观众**才成立；同一个人的重复不算聚合。
- 只有 `danmaku` 参与；**本地乐观行**（`local_id < 0`）不参与；空正文不聚合（`aggregate.ts:56-66`）。
- **不改上游数据、不落盘、不加 IPC**：这是显示层的一条折叠规则，与 `MessageSink` 对「同一条被送两遍」的去重（`crates/danmubox-core/src/bus.rs:230-246`）互不相干；会话缓冲里仍是逐条原样。

**列表页开播状态刷新的约束**：

- 只在**房间列表页可见**时进行：`document.visibilityState` 不是 `visible` 就整拍跳过、一个请求都不发；进房间页即停。
- 进列表页时**立即拍一拍**，之后按 30 秒周期走；上一拍没回来不发下一拍。
- 与后台保活**无关**：轮询只由「列表页可见」驱动，不承担任何保活职责。

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

字段清单见 `crates/danmubox-core/src/config.rs:21-36`。

- 形态：**明文 TOML**。自用场景不加密，靠文件权限（0600）与"只在本机数据目录"约束。
- 启动顺序（规范性）：读文件 → 取 `active_profile` 指向的 profile，其 `sessdata` / `bili_jct` / `dede_user_id` 齐全且非空则直接进入登录态；否则走扫码（默认入口）→ 成功后原子写回该 profile（临时文件 + rename）。判定见 `config.rs:62-64`、`config.rs:382-393`。
- **多账号（规范性）**：同一文件用 `[profiles.<name>]` 承载多份凭据，`active_profile` 指定当前生效者。切换账号 = 改 `active_profile` + 以新凭据重建连接，**不复制多份文件**。
- 凭据文件是**明文 TOML**，用户可以自己编辑（`auth.md` §8.4）；但界面与 CLI **不提供**「手填 Cookie」的导入入口：登录方式只保留扫码与游客。
- **不得**在该文件中存放任何非凭据内容：界面偏好走 `prefs.json`。TOML 往返会丢注释与排版，程序每次改偏好都重写凭据文件是事故面。
- 安全红线（规范性，所有文档必须原样复述）：`SESSDATA`、`bili_jct`、`DedeUserID` **不得**进日志、不得进前端明文、不得进仓库、不得进崩溃上报。文档与脚本中的示例一律用占位值。
- **测试用的房间号与账号标识同样不得进 git**（提交信息与受版本控制的文件都算）；实测记录只写「某个在播房间」这类脱敏描述。测试后可复用的房间属于使用者的私产，不进仓库。
  - **例外（唯一）**：公开测试房间 `1`（哔哩哔哩直播官方直播间）允许写入文档。它的真实房间号由 `room_init` / `getRoomPlayInfo` 解析得到，写 `1` 即可。
  - 该房间的直播状态随官方轮播变化（可能是轮播或无弹幕），因此它适合做**连接、解析与发送**的冒烟测试，不适合当作稳定的弹幕采集源。
- **测试期间不得发送任何有价值内容**：礼物、醒目留言（SuperChat）、大航海等一律不发。发送测试只用纯文本弹幕。

### 4.2 偏好文件 `prefs.json`（规范性）

- 形态：单层 JSON 对象，键即 §8 的偏好键，值为该键的 JSON 值。
- 只存**被显式改过**的键；文件缺失或键缺失时回落到默认值。
- 加载时**未知键与非法的值一律忽略**（只记一条 debug，不逐键刷警告）：文件是应用自己写的，最常见的成因是「删掉某个偏好键之后留下的旧值」；**下一次落盘即清理**（写入时只写 §8 的键）。补丁路径（`prefs_set`）对未知键仍返回 `BAD_REQUEST` —— 那里的未知键属于代码写错，必须炸出来（见 `docs/operations.md` 的排障示例）。两侧口径见 `crates/danmubox-core/src/prefs.rs:381-384`（写）与 `prefs.rs:437-444`（读）。
- 写入必须原子替换；文件损坏时按默认值启动并保留损坏副本 `prefs.json.bak`（`prefs.rs:424-430`、`prefs.rs:462-483`）。
- `GET`/`SET` 语义见 §8。

### 4.3 消息本地保留（弹幕 / 礼物 / SC / 大航海 / 互动 / 系统；规范性）

- **不建数据库，不做回看，不做导出。**
- 缓冲的生命周期 = **一次房内会话**：从进入某个直播间开始，到离开该房间（返回房间列表、关闭房间或切走）结束。离开即**销毁并清空**；再次进入同一房间是全新的一次会话。
- 会话内保留**按 `kind` 分档**的内存缓冲（issue 2609171849 第 3 条）：每档各按自己的上限丢最旧，进程退出即丢。各档互不挤占。

  | 档 | `kind` | 偏好键（§8） | 默认上限 |
  |---|---|---|---|
  | 弹幕 | `danmaku` | `history.buffer_rows_danmaku` | 5000 |
  | 礼物 | `gift`（内部再按金额分三档，见下） | `history.buffer_rows_gift` | 2000 |
  | 醒目留言（SC） | `superchat` | `history.buffer_rows_superchat` | 500 |
  | 大航海 | `guard` | `history.buffer_rows_guard` | 200 |
  | 互动 / 进场 | `interact` | `history.buffer_rows_interact` | 300 |
  | 系统通知 | `system` | `history.buffer_rows_system` | 200 |

  各档上限只在**建立会话时**读一次；每档至少 1 条（`crates/danmubox-core/src/session.rs:104-118`）。

- **礼物按金额分级保留**（`Message.amount` 金瓜子，口径见 §5「金额单位」）：礼物档的额度再按 **10% / 40% / 50%** 切给低 / 中 / 高三档，**价值越高留得越多**。三档各自丢最旧。
  三档条数之和**恒等于**礼物档额度（取整的余数给高档）；每档至少 1 条（`session.rs:126`、`session.rs:155-160`）。

  | 档 | 判据（`amount`，金瓜子） | 默认条数（礼物档 2000 时） |
  |---|---|---|
  | 低 | `0 < amount ≤ 100`（≤ 0.1 元；门槛复用 §8 的「低价礼物」口径） | 200 |
  | 中 | `100 < amount ≤ 10000`（≤ 10 元） | 800 |
  | 高 | `amount > 10000`（> 10 元） | 1000 |
  | 上游没给价 | `amount <= 0` **不算低价**（§8 的既有口径）→ 进**中**档，不猜价也不当高档 | — |

  判据见 `session.rs:143-149`。档位是**本地保留策略**的取舍，**不对上游礼物价位作任何断言**：它只决定「同一条道里留多少条」。只有 `kind = "gift"` 参与分档；SC（金额以元计）与大航海各占自己那一档，不分档。

- 分档不改变可读内容：`history_query` 与界面看到的仍是**同一批消息、同一个到达顺序**（各档归并后按 `local_id` 升序，见 §5）。分档只决定「超出时先丢谁」。
- ac站只提供「进房间时最近若干条」的接口（`data.room`，上限 10 条，**不可翻页**，见 `protocol.md` 附录 A30），**不提供可翻页的历史回放**。跨会话历史只能本地落盘；本次会话的缓冲仍是内存。
- 唯一允许的用途是当前会话内在界面上向上回滚查看（`history_query` 只查当前会话缓冲）。
- **进场回填**：进入房间时先用 `LiveSource::recent` 取上游能给的「最近若干条」弹幕（`data.room`，上限 10 条，**不可翻页**，见 `protocol.md` 附录 A30），标记 `is_history` 后作为本次会话缓冲的**前缀**（先回填、再连接，因此顺序天然是历史在前）；每条回填已带 `upstream_id`，因此与实时弹幕一样可举报。
  上游同一响应里还有一个 `data.admin`（至多 10 条「只看房管」切片），**不采用**（`crates/danmubox-bili/src/history.rs:90-105`）。
- 回填**不经过 `MessageSink`**，因此不计入「收到的消息」等流量统计。
- 回填是**尽力而为**：上游可能返回空或失败（`protocol.md` 附录 A30），此时与从前一样从空列表开始——**不得报错、不得重试风暴、不得因此延迟连接**（实现侧有 2 秒上限，`crates/danmubox-bili/src/ws.rs:181`）。
- 长连接卡住或推流中断时，用房间内的「刷新」按钮触发**手动重连**（`rooms_reconnect`）；重连不恢复旧缓冲，仍属同一次会话，已收到的消息保留。
  会话已被「断开连接」（`rooms_disconnect`）结束之后再点「刷新」= **重新建立一次会话**（等价于重新进房，缓冲从空开始）——这条键在断连之后不能变成死键。
- 输入草稿只存在**会话内内存**中：**按「身份 × 房间」各留一份**（键 `${identityKey}:${roomId}`，`apps/desktop/ui/src/components/Composer.tsx:39`、`Composer.tsx:167`），切号即换键、不继承上一身份的草稿；不落盘、不写 `prefs.json`（REQUIREMENTS.md §2.2）。**没有**「最近发送记录」这类东西：全链路不存在该面板与数据。
- 若将来需要跨会话历史，方案是**追加式 JSONL 文件**（按天分片），不引入数据库；届时另立决策记录（进 `CHANGELOG.md` 的归档区）。
- **不引入数据库**（决策沿革见 `CHANGELOG.md` 的「撤销本地数据库与落库」条目）：落库相关的字段与机制（`dedup_key`、`raw` 保留、`user_version` 迁移、索引、WAL、单写者 actor、保留天数、行数上限清理）不存在，文档与代码中不得出现。

### 4.4 一键诊断的导出文件（规范性）

需求直接来源：用户 2026-09-16 追加（非 `REQUIREMENTS.md` 原文）——「连上了却收不到弹幕」这条问题要能闭环，得让用户把连接诊断**交得出来**；同一条口径也把 `docs/testing.md` §10.5 那条遗留（Android 侧没有可打开的业务日志入口）一并解决。

- **一次诊断恰好一个文件**：文件名 `danmubox-diagnose-YYYYMMDD-HHMMSS.txt`，时间取 **UTC**（与报告头一致，全仓不引入本地时区换算）。
- **位置**：macOS / Windows / Linux 写**用户主目录下的 `Downloads`**（该目录不存在时回退到主目录）；Android 经 **MediaStore** 写**公共 `Download`**（API 29+ 不需要运行时权限；本应用声明的权限见 §2 的 Android 保活例外，共四枚：`INTERNET` / `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC` / `POST_NOTIFICATIONS`，权威清单是 `apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml`）。
  **不写**应用私有目录、不写这两个位置之外的任何地方；跑完不留临时文件。
- **采集窗口固定 180 秒**（`crates/danmubox-core/src/diagnose.rs:29`；可提前结束）；窗口内收集连接事实与日志行，窗口到点或提前结束时导出。
- **文件必须可安全发给别人**：凭据 / uid / 昵称按 §4.1 的安全红线与 `crates/danmubox-bili/src/redact.rs` 的口径抹成 `***`；
  **房间号也抹掉**——日志里房间号是刻意保留的排障主键，这份要外发的文件不是（`operations.md` §3；`apps/desktop/src-tauri/src/lib.rs:977-989`）。
- **导出后立即清空**内存里的采集内容（含最近几次连接的事实）。
- 与 §4.3 **不冲突**：§4.3 禁的是**弹幕内容**的落库 / 回看 / 导出；该文件不含弹幕原文（`danmubox::raw` 那条逐条原始载荷的 debug 日志不进文件，`apps/desktop/src-tauri/src/lib.rs:1110-1112`），只有连接事实与脱敏后的日志行。

## 5. 领域模型（规范性）

`kind` 取值只有六种：`danmaku` | `gift` | `superchat` | `interact` | `guard` | `system`（`crates/danmubox-core/src/model.rs:5-38`）。

`Message`（`model.rs:67`，JSON 侧 snake_case）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `local_id` | u64 | 会话内自增序号，由 `MessageSink` 分配（`0` 仅表示「尚未分配」，出现在界面即缺陷）；仅用于 UI key 与本地引用，进程重启后重置。**事件与 `history_query` 两条路径必须给出同一个号**（`crates/danmubox-core/src/bus.rs:205-248`） |
| `room_id` | i64 | 真实房间号 |
| `kind` | string | 见上 |
| `ts` | i64 | UTC 毫秒 |
| `uid` | i64 | 发送者 UID，游客/未知为 0 |
| `uname` | string | 昵称 |
| `content` | string | 文本内容（礼物/SC 为描述文本） |
| `color` | i64 | 弹幕颜色十进制 RGB |
| `medal_level` | i64 | 发送者粉丝牌等级，0 无 |
| `medal_name` | string | 发送者粉丝牌名 |
| `medal_lit` | bool | 这块粉丝牌**亮着**吗（上游 `user.medal.is_light`，1 = 亮）。**界面只在为真时画牌**——官方前端的弹幕行渲染分支就是这么判的（`protocol.md` A43）。**字段缺失按 `true`**（`model.rs:58`） |
| `guard_level` | i64 | 发送者**在本房间**的大航海等级：0 无 / 1 总督 / 2 提督 / 3 舰长（实时取 `info[7]`、历史取顶层 `guard_level`，两者同义）。**本房间的舰长标只认它**（`protocol.md` A39） |
| `medal_guard_level` | i64 | 发送者**粉丝牌自身**的舰长标记（上游 `user.medal.guard_level`）——那是**牌子所属房间**的身份，只用于牌面样式，**不得**拿来画本房间的舰长标 |
| `is_admin` | bool | 发送者是否房管（REQUIREMENTS.md 需求） |
| `is_history` | bool | 是否来自进场回填（§4.3）；实时推送恒为 `false` |
| `amount` | i64 | 金额：**礼物与大航海是金瓜子数，SC 是元**，非交易类为 `0`。界面展示一律按**元**（换算见 §5「金额单位」）。**大航海取实付**：同一笔开通上游发两条载荷，只有播报（`USER_TOAST_MSG.price`）是实付、购买事件的 `price` 是标价**不计**，且两载荷只出一条（`protocol.md` §10.6 / §12.3） |
| `combo_id` | string | 礼物连击标识（上游 `batch_combo_id`，见 `protocol.md` §10.2）；非连击类消息为空串，同一次连击的每条礼物共用它，界面据此聚合，折叠规则见 `ui.md` §8.4 |
| `emote` | object \| null | 表情弹幕的**整份**表情信息（`EmoteRef`，见下）；非表情弹幕为 `null`。两种来源都算「表情弹幕」：① `info[0][13]` 是对象（`dm_type=1`，图在槽位里）；② **正文整条恰好是一个文字表情 token**（`[dog]` 这类，图在 `extra.emots[正文]` 里，见 `protocol.md` §10.1.x / A42）。正文里夹着别的字时**不设**本字段（本字段是「整条画图」语义，设了会吞掉正文）。存整份而非只存图片地址：渲染要用它 |
| `reply_to_uid` | i64 | 被回复者的 uid；`0` 表示这条不是回复（上游把它塞在 `info[0][15].extra` 这个 JSON 字符串里，历史条目另有其路径） |
| `reply_to_uname` | string | 被回复者昵称；非回复为空串 |
| `reply_type_enum` | i64 | 上游回复类型枚举（实时 `extra.reply_type_enum`，历史 `reply.reply_type_enum`）。官方枚举 `{0: NO_REPLY, 1: NORMAL_REPLY, 2: MATCH_REPLY}`，但实测只有 `0`/`1` 出现、且与 `reply_mid` 是否非 0 完全同构——**不得**用它区分「纯 @」与「回复」（`protocol.md` A40） |
| `show_reply` | bool | 上游 `show_reply`。实测在**所有**样本（含毫无回复关系的）里都是 `true`，不是判别式，仅供渲染与校准 |
| `reply_uname_color` | string | 被 @ 者名字的颜色；无关系时为空串 |
| `face` | string | 发言者头像 URL：弹幕（含历史条目）取 `info[0][15].user.base.face`；SC 取 `data.uinfo.base.face`；礼物 V2 取 pb 顶层 `face`（`protocol.md` §10.2）；互动/进场取 pb `UserInfo.base.face` 或 JSON `data.uinfo.base.face`（`protocol.md` §10.4）。**没有可靠来源的一律留空串**（V1 礼物与大航海即如此，见 `protocol.md` §10.2 / §10.6），界面对空串自行降级 |
| `medal_color_start` | string | 粉丝牌起始色（上游 `user.medal.v2_medal_color_start`），带 alpha 的 CSS 十六进制串（如 `#3FB4F699`）；无牌/缺失为空串（`protocol.md` A37） |
| `medal_color_end` | string | 同上（`v2_medal_color_end`） |
| `medal_color_border` | string | 同上（`v2_medal_color_border`） |
| `medal_color_text` | string | 同上（`v2_medal_color_text`）。**空串不是颜色**，界面必须自备兜底色，不得拿黑色顶替 |
| `upstream_id` | string | **上游弹幕标识，举报必需**（`protocol.md` §10.1：`info[0][15].extra` 的 `id_str`，36 位十六进制串；`crates/danmubox-bili/src/report.rs:13`） |

**金额单位（规范性）**：`amount` 的**上游取值口径**按 kind 分两种 —— 礼物与大航海是**金瓜子**、SC 是**元**（依据见 `protocol.md` §10.2 / §10.3 / §10.6 的字段表与附录 A8 / A9 / A12）。
**界面展示一律是元**：SC 原值即元、不再换算；礼物与大航海按 **`元 = 金瓜子 / 1000`** 换算（`apps/desktop/ui/src/filtering.ts:366-371`，`COINS_PER_YUAN = 1000`）。
整数元不显示小数、非整数保留必要小数（金瓜子 ÷ 1000 最多三位，故小数位上限定为 3）：`138000` → `138 元`、`100` → `0.1 元`（`ui.md` §5.3）。
**不得**把 `price` 当电池数：金瓜子与电池另有比值 **1 电池 = 100 金瓜子 = 0.1 元**（即 1 元 = 10 电池；与 `protocol.md` A29 实测的 `电池 = gold / 100` 一致），按电池换算会差 10 倍。

**大航海的取值口径（字段级依据见 `protocol.md` §10.6）**：同一笔开通上游会发 `GUARD_BUY`（购买事件，`price` = **标价**：舰长 198 元）与 `USER_TOAST_MSG`（播报，`price` = **实付**：舰长 138 / 168 元）两条载荷。`amount` 取**播报的实付**，标价不计；两条合并成一条播报（`protocol.md` §10.6 / §12.3），因此同一笔在界面统计里只算一次。只有购买事件、窗口内没等到播报时 `amount = 0`（不拿标价冒充实付）。

**界面自造的行（乐观渲染）**：发送弹幕时界面会**先**在列表末尾插一条自己的行，它带三个**只在界面内存里存在**的东西：`local_id` 取**负数**（真实 `local_id` 恒为正，因此永不碰撞）、UI 专用字段 `send_state`（`unconfirmed` / `rejected` 两档，缺省 = 正常行，包括刚插入、还在等回执的那条）与 `send_reason`（被拒时那句话）。它们**不在本契约内**：后端不产生、不解析、`history_query` 也不会返回。
上游回播到达时那一行**不被换掉**：字段换成上游那条、**`local_id` 的负号照旧保留**（React key 不变 ⇒ DOM 节点不重建、看不出回播），`send_state` 只在发送没成时才存在（`docs/ui.md` §4.4）。

**收包侧区分不了「纯 @」与「回复」**：收包载荷里**没有任何指回被回复弹幕的 id**（`extra` 的键已全量枚举，发送侧用的 `replay_dmid` 在收包侧**不存在**）。因此「这条回复了哪条弹幕」在客户端**无法恢复**；界面一律渲染 `回复 @昵称`。**能准确区分的只有我们自己发出的那条**：发送时 `reply.dmid` 非空 = 回复某条、为空 = 纯 @（`crates/danmubox-core/src/ports.rs:205-211`）。

**徽标（REQUIREMENTS.md 需求）**：主播 = `uid == Room.anchor_uid` 派生（`model.rs:264`）；房管 = `Message.is_admin`；大航海 = `Message.guard_level`（`1` 总督 / `2` 提督 / `3` 舰长）。`is_anchor` 不设独立字段——能推导就不存。

**舰长标的分层**：只认 `guard_level`（本房间）。粉丝牌上那个 `medal_guard_level` 属于**牌子所属房间**——它是为牌面样式准备的，用它画舰长标会让「戴着别的房间舰长牌的人」在本房间也亮出舰长标。

`SendOutcome`（发弹幕结果，`model.rs:209`）：

| 取值 | 含义 | 判定 |
|---|---|---|
| `ok` | 已发出且进入公开弹幕流 | 上游返回成功 |
| `blocked_platform` | 被平台吞（界面写「**全局屏蔽词**」） | 上游响应 `msg`/`message` == `"f"` |
| `blocked_room` | 被本直播间吞（界面写「**房间屏蔽词**」） | 上游响应 `msg`/`message` == `"k"` |
| `rate_limited` | 频率限制 | 上游对应错误码 |
| `medal_required` | 粉丝牌等级不足 | 上游对应错误码 |
| `muted` | 已被禁言 | 上游对应错误码 |
| `failed` | 其他失败 | 兜底，需带原始 code 与 message |

`SendReport`（发送结果的规范性形状，`ports.rs:161`；`chat_send` 与端口共用）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `outcome` | `SendOutcome` | 归一化结论，§5 `SendOutcome` 七取一 |
| `upstream_code` | `number \| null` | 上游 `code` 原样，**不翻译**；本地节流拦下时为 `null`（没发请求） |
| `upstream_message` | `string \| null` | 上游 `msg` / `message` 原话，**不改写** |

**纪律**：`SendOutcome` 只表达**已经敢下结论**的取值；一切未知 code 进 `failed`，其原始 `code` 与 `message` 通过 `SendReport` 一路带到界面（REQUIREMENTS.md §2.2 要求给出禁言 / 频率 / 粉丝牌等原因）。码表映射见 `protocol.md` 附录 A17。

`blocked_platform` / `blocked_room` 的判定规则来自一个可复现的社区实现（见 `protocol.md` 发送章节），阶段 1 必须用真实发送复核后写死。
界面称呼：`blocked_platform` → 「发送失败 · **全局屏蔽词**」、`blocked_room` → 「发送失败 · **房间屏蔽词**」。上游只给 `f` / `k` 一个标记，**「是哪一份词库」是界面替它说清的**（一个是平台的词库、一个是主播 / 房管在本直播间配的那张表）；上游成因本身仍未完全闭环（`protocol.md` A16）。

`RoomStats`（**房间观众数**，会话级、不落盘、不入缓冲，`crates/danmubox-core/src/bus.rs:34`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_id` | i64 | 房间号 |
| `online` | Option&lt;i64&gt; | 在线人数（`ONLINE_RANK_COUNT` 的 `online_count`，协议 §10.7）；上游未给过为 `null` |
| `watched` | Option&lt;i64&gt; | 累计看过（`WATCHED_CHANGE` 的 `num`，协议 §10.7）；上游未给过为 `null` |

两个数各自随不同命令到达，因此两侧都可缺省；界面保留上一次的值，不用 0 顶替。人气值（`POPULARITY_CHANGE` / `op=3`）**不再展示**。

`RoomSession`（**本人在该房间的身份**，会话级、不落盘，`model.rs:272`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_id` | i64 | 房间号 |
| `my_medal_level` | i64 | 我在**该直播间**的粉丝牌等级，0 表示无牌 |
| `my_medal_name` | string | 我在该直播间的粉丝牌名 |
| `my_medal_worn` | bool | 我**是否佩戴着**这块牌（上游 `data.medal.is_weared`）。与 `my_medal_level` 是两回事：**持有 ≠ 佩戴**，界面只在为真时画；字段缺失按**没戴**（`protocol.md` A43、`ui.md` §4.4） |
| `my_guard_level` | i64 | 我在该直播间的大航海等级 |
| `is_admin` | bool | 我在该直播间是否房管 |
| `danmaku_length` | u32 | **本房间的弹幕字数上限**（上游 `getInfoByUser` 的 `data.property.danmu.length`，即官方前端读的 `danmaku_length`）。实测当前账号 × 8 个房间都是 **40**，上游缺该字段时官方前端的缺省是 **20**（`protocol.md` A44）。界面据此**截断输入并显示 `已用/上限`**，不再自己写死数字。**`0` = 尚未取到身份**（会话刚建立 / 游客 / 上游失败）——界面按缺省 20 处理，不是「一个字都不许发」 |

与 `Message.medal_level` 区分：后者是**发送者**的牌，前者是**我**在这个房间的牌。表情包库可用范围取决于这套身份。

`Account`（账号，规范性，`ports.rs:63`）：`name`（具名凭据标识，即 `config.toml` 的 profile 名）/ `nickname` / `uid` / `face` / `logged_in` / `active`。**游客态不是账号**——没有凭据就没有条目；`logged_in=false` 表示该账号存在但凭据已清（或已失效），它仍是可切回的槽位。

`locked`（**我**现在能不能用这个表情；`true` = 无权限，界面应**置灰而不是隐藏**，`model.rs:340`）：由上游**表情级 `perm == 0`** 派生（`protocol.md` A26 补充之三：同一房间两个身份不同的账号拿到**完全相同**的 68 个表情，只有舰长专属那批的 `perm` 随身份 0↔1；包级 `pkg_perm`/`unlock_*` 对判定无用）。**字段缺失按可用处理**——置灰是提示不是闸门，真正的拦截在上游发送侧。主站「我的表情」无此概念，恒为 `false`。

`Emote`（表情，规范性，`model.rs:313`）：`key` / `emoticon_unique`（上游唯一键，发送表情弹幕时 `msg` 传它）/ `width` / `height` / `is_dynamic` / `in_player_area` / `bulge_display` / `package_kind`（`common` / `room` / `medal` / `guard` / `owned`；`owned` = 主站「我的表情」中用户拥有的包，见 `protocol.md` A35；`room` = UP 主大表情与房间专属表情。**没有 `admin`**——房管没有表情分类，见 `protocol.md` A26）/ `text` / `url` / `room_id`（房间专属时非 0）。

`EmoteRef`（弹幕携带的表情，规范性，`model.rs:221`）：`emoticon_unique` / `url`（已规范化）/ `width` / `height` / `is_dynamic` / `in_player_area` / `bulge_display`。

> 为什么存整份而不只存图片地址：**弹幕行里的表情要按原图信息渲染** —— 盒子取哪一档由 `bulge_display` 与 `width / height` 的长宽比定（`ui.md` §4.1）；只留一个 URL 就没法给出正确的盒子。

`SilentUser` / `BlacklistedUser`（房管列表条目，规范性，`model.rs:368`、`model.rs:376`）：`uid` / `uname` / `face`。禁言名单与黑名单各一套——前者是「本直播间禁言」，后者是「拉黑（自动解除关系并禁止互动）」。

`ReportReason`（举报理由，规范性，`model.rs:235`）：`id` / `reason`。取自上游 `dMReport/ForReason`，界面只让用户从清单里选。

`Room`（房间元信息，规范性，`model.rs:242`；`rooms_list` 返回的 `RoomView` 是它加上连接态，`apps/desktop/src-tauri/src/lib.rs:101`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `room_id` | i64 | 真实房间号（短号 / URL 已由 `getRoomPlayInfo` 解析） |
| `short_id` | i64 | 上游短号；无比为 0 |
| `anchor_uid` | i64 | 主播 UID，用于派生「主播」徽标（`uid == Room.anchor_uid`） |
| `anchor_uname` | string | **主播昵称**（上游 `getH5InfoByRoom` 的 `data.anchor_info.base_info.uname`；`getRoomPlayInfo` 的响应里**没有**这个键）。界面用它**代替房间号**展示房间。空串 = 上游没给，界面回落到 `title`、再回落到「房间 <真实 room_id>」，**不渲染空、不渲染占位词**（口径见 `docs/ui.md` §2.2） |
| `title` | string | 直播间标题（上游 `getH5InfoByRoom` 的 `data.room_info.title`，与 `FollowedRoom.title` 同义）；空串 = 上游没给 |
| `live_status` | i32 | 0 未开播 / 1 直播中 / 2 轮播 |

`FollowedRoom`（关注列表，规范性，`model.rs:345`）：`room_id` / `uname` / `face` / `title` / `live_status`（0 未开播 / 1 直播中 / 2 轮播）/ `group_name` / `live_start_at` / `online`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | String | **直播间标题**（上游 `GetWebList` 的 `title`；与房间模型 `Room.title` 同义）。空串 = 上游未给，界面不渲染该元素 |
| `live_start_at` | i64 | **最后/本次开播的起始时间**（上游 `liveTime`，Unix 秒；0 = 未知）。命名刻意避开上游另一个字段 `live_time`（那个是**已开播秒数**，与 `liveTime` 相加等于当前时间）。**只有直播侧 `GetWebList` 给这个量**，而它只返回在播房间；未开播条目走批量房间接口，那里 `live_time` 在未开播时为 0，因此**未开播条目的 `live_start_at` 恒为 0**——排序里这一档落回 `online` / 房间号（`protocol.md` A28） |
| `online` | i64 | 人气/在线数（上游 `online`；缺失 = 0） |

**`RoomCatalog::followed()` 的取数口径**：列表 = **全部关注里「有直播间」的那些**（在播 + 未开播）。
直播侧 `GetWebList` **只返回在播房间**，因此未开播那一份必须另取：① 主站关注关系 `relation/followings` 拿全量关注的 uid；② 直播 `room/v1/Room/get_status_info_by_uids` 按 uid 批量取直播间（含未开播）。**没有直播间的关注不产生列表项**。在播条目优先用 `GetWebList` 的那一份（它带 `liveTime`）。取证见 `docs/protocol.md` A28。

**展示排序**（`apps/desktop/ui/src/filtering.ts:151-170`）：`live_status == 1` 置顶（REQUIREMENTS.md 需求）→ **最近观看降序**（数据是 `ui.recent_watched`，没看过的不计入该档、排在看过的之后）→ `live_start_at` 降序 → `online` 降序 → `room_id` 升序。**未开播的也要列出**，因此不只展示直播中的房间。

## 6. ac站协议要点（规范性）

- 包结构：16 字节大端头 `packetLen:u32 | headerLen:u16(=16) | protover:u16 | op:u32 | seq:u32`。
- **protover 是载荷编码版本**：`0` 裸 JSON / `1` 认证与心跳包的帧头版本 / `2` zlib / `3` brotli。请求固定用 `3`。（`crates/danmubox-bili/src/proto.rs:24-27`）
- **op 才是包类型**：`2` 心跳 / `3` 心跳回应（人气值）/ `5` 业务消息 / `7` 认证 / `8` 认证成功（`proto.rs:18-22`）。
  官方产物里还有一个 `24` = SocketAck（客户端→服务端，body `{msg_id, cmd, p_msg_type}`）与 HTTP 侧同类回执 `POST /xlive/open-interface/v1/dm/message_ack`，**本仓均未实现**；取证与限定见 `protocol.md` §5 / §11.7 / 附录 A47。
- 认证包（op=7，帧头 `protover=1`）：body JSON `{ "uid", "roomid", "protover": 3, "buvid", "platform": "web", "type": 2, "key" }`；游客 `uid=0`、`key=""`。
  官方 web 客户端的认证包另有 `support_ack` / `queue_uuid` / `scene` 三个字段，**本仓不发送**（现状记录，非规范要求）；限定见 `protocol.md` §7.1。
- WS 心跳包（op=2，帧头 `protover=1`）：body 为字面量 `[object Object]`（`crates/danmubox-bili/src/ws.rs:173`）。
  **首包时机**：认证成功（`op=8` 且 `code=0`）后在同一次回调内**立即**发出（不是等 60 秒；§4 的 60 秒是上界），随后每 30 秒一次——见 `protocol.md` §8.1。
- **HTTP 心跳（易漏，务必实现）**：每 60 秒 `GET https://live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat`，参数 `pf=web` 与 `hb=base64("60|<真实room_id>|1|0")`（`crates/danmubox-bili/src/http.rs:522-524`）。缺它连接会被上游判死。
- `op=5` 的 body 解压后可能仍是「多个 16 字节头子包」的拼接，必须循环按头拆分直到消费完；子包 protover 可能再次为 2 或 3（`proto.rs:110-140`）。
- `op=3` 的 body 为 4 字节大端无符号整数，即人气值。
- **`INTERACT_WORD_V2` 的载荷是 protobuf**，不是 JSON：base64 在 **`data.pb`** 字段里（不是 `data` 本身），Rust 侧用 `prost` 解码（`crates/danmubox-bili/src/cmd.rs:573-578`、`crates/danmubox-bili/src/pb.rs:1-3`）。
- `DANMU_MSG` 关键取值：内容在 `info[1]`；明文用户对象在 `info[0][15].user`（`uid`、`base.name`、`base.face`）（`crates/danmubox-bili/src/cmd.rs:220-235`）。
- `DANMU_MSG_MIRROR` 是非本房间的镜像弹幕，默认丢弃并计数。
- 短号/URL → 真实 `room_id`：使用 `getRoomPlayInfo`，一次拿到 `room_id` / `uid` / `live_status`。
  **同一个端点也是列表页定期刷新的取数口**（§4 的 30 秒那一拍：按真实 `room_id` 只读一次，不做 `getH5InfoByRoom` 那一跳）——它游客同样成立，且给的就是 `live_status` 本身。
- **开播 / 下播的实时来源是长连接里的 `LIVE` / `PREPARING`**（协议 §10.7 的系统类命令），归一化取值固定为 `LIVE` → `live_status = 1`、`PREPARING` → `live_status = 0`（`2` 轮播**不**由它们推出）。这两条命令到达时，房间的 `live_status` **立刻**落到界面上（房间头状态点 / 房间标签页圆点 / 列表卡片 / 关注列表里那一条），见 §7 的 `danmubox://room`（`crates/danmubox-bili/src/cmd.rs:21-30`）。
- 主播昵称与直播间标题另取 `getH5InfoByRoom`（`data.anchor_info.base_info.uname` / `data.room_info.title`）——`getRoomPlayInfo` **不返回**这两个字段。这一跳失败不阻断登记房间：两个字段留空，界面按 `docs/ui.md` §2.2 回落。
- 认证回应 `code=0` 为成功；非 0 一律视为认证失败并按退避重连，**不得**在未知 code 上编造含义（`crates/danmubox-bili/src/ws.rs:731-741`）。

## 7. Tauri IPC（规范性）

Frontend → Rust 命令（`invoke`）。命令名与 `apps/desktop/src-tauri/src/lib.rs` 的 `generate_handler!`（`lib.rs:1302`）一一对应；签名、载荷类型与错误码见 [`ipc.md`](ipc.md) §3。

| 命令 | 用途 |
|---|---|
| `app_info` | 版本、数据目录、凭据文件路径、当前是否登录；前端挂载后调的第一条命令 |
| `session_status` | 登录态（脱敏，不含任何 Cookie 值），含当前 `active_profile` |
| `accounts_list` | 列出全部账号（游客态不是账号：没有凭据就没有条目）；有凭据者并发向 `nav` 求证，单个失败只影响它那一行 |
| `account_switch` | 切换当前账号，并以新凭据**重建各房间连接** |
| `account_remove` | 删除账号条目；**不许删最后一个**；删的是当前项时当前指向切到剩下的条目并重连 |
| `account_logout` | 清掉该账号（缺省 = 当前账号）的凭据；**账号条目保留**、`logged_in=false`，即退回游客态。登出别的账号时不重连 |
| `account_qr_start` | 扫码第一步：取二维码内容并在**本地离线**编成 SVG。不带 `target` = **新增账号**（扫完按昵称命名、重名加后缀，**不覆盖任何已有凭据**）；带 = 给该账号**重新登录**（**覆盖**其凭据，界面须二次确认） |
| `account_qr_poll` | 扫码轮询：状态 + **确认时**已落盘并设为当前（`active=true`）的那个账号；确认后各房间以新凭据重连 |
| `rooms_list` | 已登记房间：`RoomView`（= §5 `Room` + 连接态 + 当前会话缓冲条数） |
| `rooms_refresh_status` | **定期刷新已登记房间的开播状态**（列表页那 30 秒一拍，§4）：按真实 `room_id` 逐个只读上游一次，把最新的 `live_status` 落到登记表并返回最新的 `RoomView` 列表。**只动 `live_status`**（标题 / 昵称另有来源）；单个房间失败只跳过它，**全部失败才报错**（前端据此退避）（`lib.rs:254-280`） |
| `rooms_add` | 解析房间号 / 短号 / URL 并登记；**不建立连接** |
| `rooms_remove` | 移除房间；有会话则先关闭（会话缓冲随会话销毁） |
| `rooms_connect` | 建立房内会话。**幂等**：已有会话时原样返回，同一房间不得并存两份连接 |
| `rooms_disconnect` | 断开并关闭会话；缓冲随之销毁 |
| `rooms_reconnect` | 房间内「刷新」：会话还在（连接中 / 退避中 / 已连接）→ 原地重连，**不清缓冲**，仍属同一次会话；会话已不在（点过断开，或移除后又加回）→ 当场重建一次会话，等价重新进房、缓冲从空开始（两档口径见 §4.3） |
| `history_query` | 查**当前房内会话**的缓冲（`limit` / `after` / `before` / `kinds` / `uid` / `q`）；无会话返回空数组 |
| `room_session` | 该房间**当前会话**里的本人身份（`RoomSession`）。无活跃会话（未连接 / 已关闭）→ 返回全零身份而**不报错**；身份在会话建立时并发取一次并缓存，同时经 `danmubox://session` 推送。界面据此决定房管入口是否出现（`is_admin` 不为 `true` 时该入口不渲染，`ui.md` §4.9） |
| `chat_send` | 发弹幕（`color` / `emote` / `reply` 可选；`emote` 非空即表情弹幕，`protocol.md` §11.4）。返回 `ChatSendResult { room_id, content, outcome, detail? }`（`lib.rs:118`）：`outcome` 是 §5 `SendOutcome` 归一化结论，`detail` 是上游 `message` + `code` 拼的一行、仅 `outcome != ok` 时出现。**界面不等这条命令才画**——返回只用于校验与修正，乐观渲染与对账见 [`ipc.md`](ipc.md) §7 |
| `chat_report` | 举报一条弹幕，理由取自 `report_reasons` 的清单 |
| `report_reasons` | 举报理由清单（每次向上游 `dMReport/ForReason` 现取，条数以上游为准） |
| `emotes_list` | 按**真实会话身份**加载表情包库（上游据此下发可用包；传零身份会缺粉丝牌与大航海那几包） |
| `emotes_owned` | 主站「我的表情」（`package_kind` 为 `owned`，唯一键 = `"upower_" + 表情 text`，`crates/danmubox-bili/src/emote.rs:67-69`）；未登录时上游退化为免费表情包 |
| `admin_mute` | 禁言（`hour`：`-1` 永久 / `0` 本场 / 其余为小时数）；仅房管成立，上游非 0 code 原样带回、不赋语义 |
| `admin_unmute` | 解除禁言 |
| `admin_silent_list` | 直播间禁言名单（`SilentUser[]`）——房管功能做完整所需，官方面板也有这一栏 |
| `admin_blacklist_list` | 直播间黑名单列表 |
| `admin_blacklist_add` | 加入直播间黑名单 |
| `admin_blacklist_del` | 移出直播间黑名单 |
| `admin_keywords_list` | 直播间屏蔽词列表 |
| `admin_keywords_add` | 添加屏蔽词 |
| `admin_keywords_del` | 删除屏蔽词 |
| `follow_list` | 关注列表（**每次实时拉取**，不设单独的刷新命令；取数口径见 §5） |
| `wallet_balance` | 电池余额 |
| `open_url` | 用系统浏览器打开链接（点昵称跳用户主页）；仅接受 `http(s)`。平台支持：macOS / Windows / Linux 各一条系统命令；**Android 经平台 Intent**（官方 `tauri-plugin-opener`，只在 Android 目标声明、由 Rust 侧调用、不进 capability）；iOS 等其余平台显式返回不支持（`lib.rs:496-540`） |
| `prefs_get` | 读偏好生效值全集（默认值已合并，见 §8） |
| `prefs_set` | 写偏好补丁；未知键或非法值 → `BAD_REQUEST`，成功返回合并后的生效值全集 |
| `diagnose_start` | 一键诊断：开始采集连接诊断（窗口 180 秒，见 §4.4）。同步命令：只写窗口的起止时刻，不碰 IO |
| `diagnose_export` | 一键诊断：渲染并写出**恰好一个**报告文件（§4.4 的位置与命名）、结束采集并清空采集内容。返回 `{ path, name, bytes, attempts, logs, started_ms, ends_ms }`：`path` 是给用户看的位置（桌面端绝对路径、Android 为 `/sdcard/Download/…`）（`lib.rs:956`） |
| `frontend_log` | 前端控制台桥上报：`level` 为 `error` / `warn`（其余按 debug），`target = "danmubox::ui"`。页面 `console.error` / `console.warn` 与未捕获错误经它并入 Rust 侧同一份日志；同一告警 1 秒内只上报一次，防「渲染 → 告警 → 日志 → 重渲染」反馈环（`DANMUBOX_LOG` 见 §4） |

Rust → Frontend 事件（`lib.rs:488`、`lib.rs:888-930`、`lib.rs:1297`）：`danmubox://message` `danmubox://room` `danmubox://session` `danmubox://status` `danmubox://send` `danmubox://room_stats` `danmubox://log`。

`danmubox://session` 的载荷是 §5 的 `RoomSession`（房内身份，带 `is_admin`）——**登录态不经这个事件**，它由 `session_status` 命令现取（脱敏对象，带 `logged_in`）；事件与命令的分工见 [`ipc.md`](ipc.md) §4。

`danmubox://room_stats` 的载荷是 §5 的 `RoomStats`（在线人数 / 累计看过，两侧可缺省）。

`danmubox://room` 的载荷是 §5 的 `Room`：**发布点是长连接里的 `LIVE` / `PREPARING`**（§6）——到达时先把登记表里那个房间的 `live_status` 改掉，再把改后的整条 `Room` 推给界面。界面把它合并进房间（`rooms`）与关注列表（`followed`）里同号的那一条，因此房间头状态点 / 房间标签页圆点 / 列表卡片 / 关注行同时跟着变，**不需要重连、不需要手动刷新**。它仍**不承载连接态**——连接态只走 `danmubox://status`。

IPC 载荷即 §5 的 snake_case 结构，前端 store 内部转 camelCase。

## 8. 偏好键（规范性）

存于 `prefs.json`（§4.2）。**这是唯一权威清单**，其它文档引用时不得改名。键名、类型、默认值与取值域的唯一权威实现是 `crates/danmubox-core/src/prefs.rs` 的 `SPECS`（`prefs.rs:103-282`）；下表逐条对应。

| 键 | 类型 | 默认值 | 取值域 | 含义 |
|---|---|---|---|---|
| `ui.font_scale` | number | `1.0` | 0.8–2.0 | 聊天区字号缩放 |
| `ui.theme` | string | `"system"` | `system` / `dark` / `light` | 主题 |
| `ui.auto_scroll` | boolean | `true` | — | 是否自动跟随最新 |
| `ui.pause_on_hover` | boolean | `true` | — | 鼠标悬停暂停自动滚动 |
| `ui.gift_in_danmaku` | boolean | `true` | — | 弹幕流里是否包含礼物 / SC / 大航海（`false` = 它们不出现在弹幕流里） |
| `ui.gift_panel` | boolean | `true` | — | 是否显示独立礼物栏（`false` = 不渲染礼物栏） |
| `ui.gift_pane_on_top` | boolean | `false` | — | 礼物栏与弹幕区**上下分区**的顺序：`false` = 弹幕在上、礼物在下（默认，与改前一致）；`true` = 礼物在上。分区、分割条与长按换位见 [`ui.md`](ui.md) §5.4 |
| `ui.gift_pane_ratio` | number | `0.35` | 0.10–0.90 | 礼物栏占**共享分区**高度的份额；与它在上面还是下面**无关**（换位不改比例）。落到像素时再被两栏的最小高度夹一次（礼物栏 ≥ 它的折叠头、弹幕区 ≥ 3 行），因此存的是**指针意图**——同一窗口尺寸下重开必然得到同一画面 |
| `ui.gift_collapse_cheap` | boolean | `false` | — | 把单个价值 ≤ 0.1 元（= 100 金瓜子）的礼物合并成**一条**（`false` = 默认，一条一行不变）。**两个区域都生效**：弹幕区与礼物栏**各折一次**（同一份判据、同一种桶形状）；SC / 大航海不在其列。折叠是**纯派生**——原始消息一条不动，关掉即逐条复原。门槛、落点判据与合并行的形状见 [`ui.md`](ui.md) §5.3「低价礼物桶」 |
| `ui.gift_exclude_cheap_stats` | boolean | `false` | — | 把 ≤ 0.1 元的礼物从**折叠汇总 / 统计**里剔除（`false` = 默认，统计与展示一致）。**只改统计**：这些礼物作为消息的展示（礼物栏条目、弹幕区的行）不受影响。统计面只有**礼物栏折叠头**那一处（弹幕区没有统计面）——这张键**出现在哪就管到哪**，见 [`ui.md`](ui.md) §5.3「剔除的口径」 |
| `ui.interact_auto_hide` | boolean | `true` | — | 互动/进场消息显示一会儿后自动消失（`false` = 常驻）。消失**只是显示层不画**（判据 `ts + INTERACT_AUTO_HIDE_MS`，`apps/desktop/ui/src/types.ts:583`）：消息仍留在会话缓冲里（§4.3），关掉这枚键先前消失的那些行**原样回来**——「自动消失」不许丢内容，见 [`ui.md`](ui.md) §4.8 |
| `ui.show_timestamp` | boolean | `false` | — | 弹幕前是否显示时间戳 |
| `composer.phrases` | string[] | `[]` | — | 自定义短语（REQUIREMENTS.md §2.2）；短语面板唯一的内容来源，点一下插入输入框 |
| `filter.uids` | integer[] | `[]` | — | 用户 UID 过滤列表 |
| `filter.kinds` | string[] | 五种（六种 kind 去掉 `system`） | 六种 kind 的子集 | 参与展示的消息类型白名单。系统类消息（开播 / 下播 / 标题变更 / 公告）没有单独的开关：勾上「系统」就看、取消就不看（见 §9） |
| `filter.medal_level_min` | integer | `0` | 0–60 | 粉丝牌最低等级 |
| `history.buffer_rows_danmaku` | integer | `5000` | 100–100000 | **弹幕档**上限（每房间、每次会话） |
| `history.buffer_rows_gift` | integer | `2000` | 100–100000 | **礼物档**上限；档内再按金额切低 10% / 中 40% / 高 50%（§4.3） |
| `history.buffer_rows_superchat` | integer | `500` | 100–100000 | **SC 档**上限 |
| `history.buffer_rows_guard` | integer | `200` | 100–100000 | **大航海档**上限 |
| `history.buffer_rows_interact` | integer | `300` | 100–100000 | **互动 / 进场档**上限（刻意小于弹幕档） |
| `history.buffer_rows_system` | integer | `200` | 100–100000 | **系统通知档**上限（刻意小于弹幕档） |
| `ui.recent_watched` | object | `{}` | — | 各房间最近一次打开的时刻：键 = 房间号（十进制字符串），值 = UTC 毫秒。关注列表按它**降序**排；没打开过的房间不在其中，排序时排在看过的之后 |

`ui.recent_watched` 由界面在**打开房间**时写入（不是手改的开关），但界面状态一律只落 `prefs.json`，不进 `config.toml`（后者只放凭据，§4.1）。

读写语义（对 `prefs_get` / `prefs_set` 生效）：读返回全部键的**生效值**（默认值已合并）；写接受部分键值补丁，未知键或非法值报 `BAD_REQUEST`，成功返回合并后的生效值全集。

三枚**已删除的存量键**在 `load` 时被物化进新形态，旧键本身当未知键忽略、下次落盘即从文件里消失；**文件里已显式写出新键的那一枚以文件为准**（迁移只补新形态没说的那部分）。这三枚**不在 §8 的键表内、不是偏好键**：`prefs_set` 写它们一律 `BAD_REQUEST`，它们只作为 `load` 的迁移输入存在（登记见 `crates/danmubox-core/src/prefs.rs` 的 `LEGACY_KEYS`，`prefs.rs:77`）。

- `ui.system_notice`（旧键，布尔）→ `filter.kinds`：`false` → 去掉 `system`；`true` → 保证含 `system`。非布尔值按未知键忽略（`prefs.rs:492-527`）。
- `ui.gift_panel_mode`（旧键，`merged` / `separate`）→ `separate` → `ui.gift_in_danmaku=false` + `ui.gift_panel=true`；`merged` → `ui.gift_in_danmaku=true` + `ui.gift_panel=false`。非这两个取值按非法值忽略（`prefs.rs:528-558`）。
- `history.buffer_rows`（旧键，整数）→ `history.buffer_rows_danmaku`（旧键表达的是「缓冲区留多少条」，弹幕是那个缓冲里的主流量）；取值超出 100–100000 时按坏值忽略（`prefs.rs:559-585`）。

`filter.kinds` 默认不含 `system`，因此系统类消息（开播 / 下播 / 标题变更 / 公告）**默认不显示**——这是 REQUIREMENTS.md §2.1 的原意，落在白名单的默认值上（`prefs.rs:48-52`）。「消息类型 → 系统」是这件事的**唯一门**：界面侧不存在单独的「系统通知」开关。

`ui.gift_in_danmaku` / `ui.gift_panel` 对应 REQUIREMENTS.md §2.7「礼物栏显示方式改成两个选项：1. 弹幕包含礼物 2. 独立礼物栏，默认都有」：两者**互相独立**（旧键 `ui.gift_panel_mode` 的 `merged` / `separate` 是一个二选一的门，表达不了「都显示」或「都不显示」）。礼物栏自身的结构与统计口径见 [`ui.md`](ui.md) §5。

`ui.gift_pane_on_top` / `ui.gift_pane_ratio` 是**礼物栏与弹幕区共享一块上下分区**时的两枚键（issue #8）：顺序与份额**持久化**，重开应用保持；两者都只在 `ui.gift_panel` 为真时有意义（关掉那一枚时共享区域退化为弹幕区全高，分割条不渲染）。取值域与非法值口径与其他键一致：写入非法值 `BAD_REQUEST`、文件里的非法值按未知键忽略并回落默认值（§4.2）。

`ui.gift_collapse_cheap` / `ui.gift_exclude_cheap_stats` 是**低价礼物**的两枚开关（issue 2609162056 第 3、4 条；**对两个区域都生效**的口径见下，issue 2609171849 第 5 条）：

| 项 | 口径 |
|---|---|
| 门槛 | **单个价值 ≤ 0.1 元**（`ui.md` 与界面一律按元口径；按 §5「金额单位」的 1 元 = 1000 金瓜子，即 `amount ≤ 100` 金瓜子）。礼物 / SC / 大航海的 `amount` 金瓜子口径见 §5（`apps/desktop/ui/src/filtering.ts:376-392`） |
| 上游没给价（`amount <= 0`） | **不算低价**：§5 的既有口径里 `amount <= 0` 表示上游没给价（不得猜价，界面也不画金额格）。两枚开关因此都不碰它——不然「不知道多少钱」会被当成「0.1 元以下」处理 |
| 只管礼物 | 只有 `kind = "gift"` 参与判定；SC 与大航海不受这两枚键影响（订单形态与价位都不同，SC 最低 30 元、舰长 138 元） |
| **两个区域** | 「两个区域」= **弹幕区**与**礼物栏**（共享上下分区的两栏；礼物类消息按 `ui.gift_in_danmaku` / `ui.gift_panel` 落进这两栏，默认两处都有）。折叠在**两处各生效一次**；剔除统计的**统计面只有礼物栏折叠头那一处**（弹幕区没有统计面，因此这枚键在那一栏什么都不改——不编造第二处统计）。两处共用同一枚 `isCheapGift` 判据与同一个桶实现（`filtering.collapseCheapGiftRows` / `giftStatRows`） |
| **不丢内容（硬口径）** | 剔除 / 折叠 / 隐藏（`ui.gift_panel`、`ui.gift_in_danmaku`）/ 自动消失（`ui.interact_auto_hide`）**全部是显示层的派生**：原始消息始终留在会话缓冲里（只受 §4.3 的上限约束），这些开关**不得**让任何一条提前消失。把开关关回去，两处各自恢复到原样——顺序、数量、金额都要与开之前逐项相同 |
| 两枚互相独立 | 折叠只改两处的分组形状，剔除只改统计口径；四种组合都有确定行为（`ui.md` §8.5） |
| 默认都是 `false` | **默认行为与改前逐字一致**：多数人的现有效果不该被这两条辅助开关改变；要用的自己勾 |

## 9. 需求溯源（规范性）

每条 REQUIREMENTS.md 需求必须能找到承载它的规范章节；新增的约定必须能追到 REQUIREMENTS.md；无法追溯的条款不得保留。

| REQUIREMENTS.md 小节 | 契约内承载位置 |
|---|---|
| §2.1 看弹幕 | §5（`Message` 全字段、`RoomStats`）、§6（`LIVE` / `PREPARING` → `live_status`；昵称与标题取自 `getH5InfoByRoom`）、§7 `rooms_refresh_status` / `danmubox://room` / `danmubox://room_stats`、§8 `filter.kinds` / `ui.interact_auto_hide` / `ui.show_timestamp`；进场回填与显示一致性见 §4.3、§5 `is_history`；跨观众聚合见 §4 的三条常量 |
| §2.2 发弹幕 | §3 `DanmakuSender` / `WalletProvider` / `EmoteProvider`、§5 `Emote` / `EmoteRef` / `SendOutcome` / `RoomSession.danmaku_length`、§7 `chat_send` / `emotes_list` / `emotes_owned` / `wallet_balance`、§8 `composer.phrases`；输入草稿见 §4.3 |
| §2.3 身份与徽标 | §5 徽标说明 / `guard_level` / `medal_guard_level` / `RoomSession.my_medal_level` / `Message.face`、§7 `open_url`、§8 `ui.show_timestamp` |
| §2.4 举报 | §3 `DanmakuReporter`（含 `reasons()`）、§5 `upstream_id`、§7 `chat_report` / `report_reasons` |
| §2.5 登录与账号 | §4.1、§5 `Account`、§7 `session_status` / `accounts_list` / `account_switch` / `account_remove` / `account_logout` / `account_qr_start` / `account_qr_poll` |
| §2.6 房间与关注 | §5 `Room` / `FollowedRoom` / `RoomCatalog::followed()` 取数口径与展示排序、§7 `rooms_add` / `rooms_remove` / `rooms_reconnect` / `follow_list`、§8 `ui.recent_watched` |
| §2.7 礼物 | §5 `amount` / `combo_id` / 「金额单位」（含大航海取实付）、§8 `ui.gift_in_danmaku` / `ui.gift_panel` / `ui.gift_pane_on_top` / `ui.gift_pane_ratio` / `ui.gift_collapse_cheap` / `ui.gift_exclude_cheap_stats`（含「不丢内容（硬口径）」）、§4.3 礼物三档 |
| §2.8 展示与过滤 | §8 `ui.theme` / `ui.font_scale` / `ui.show_timestamp` / `filter.uids` / `filter.kinds` / `filter.medal_level_min`；`Message.face` 见 §5；筛选面板标题等纯视觉项落 `ui.md` 与组件层 |
| §2.9 数据 | §4.3（会话生命周期、六档上限、礼物三档）、§8 六枚 `history.buffer_rows_*` |
| §2.10 房管 | §3 `RoomAdmin`、§5 `SilentUser` / `BlacklistedUser` / `RoomSession.is_admin`、§7 `admin_*` |
| §2.11 界面与布局 | 契约内只承载共享约定：§8 `ui.gift_pane_on_top` / `ui.gift_pane_ratio`（共享分区、分割条、长按换位）、§5 `Room.anchor_uname`（不露房间号）；其余在 `ui.md` 与组件层 |
| §2.12 连接、保活与诊断 | §2（Android 保活例外）、§4 `DANMUBOX_LOG`、§4.4 与 §7 `diagnose_start` / `diagnose_export`、§6（心跳、重连退避与认证失败口径） |
| §2.13 已删除 | §8 键表不含透明度键与 `filter.keywords*`；§4.1 无「手填 Cookie」导入入口；§4.3 无「最近发送记录」；`composer.phrases` 只承载用户自建短语 |
| §3 架构约束 | §3 依赖方向、上游隔离、端口表 |
| §4 非目标 | §2 本期范围、§4.3（不建库 / 不回看 / 不导出）、§3（MCP 架构兼容约束） |
| §5 参考与外部输入 | §1（bundle id） |

非 REQUIREMENTS.md 原文、由用户追加并落在本契约的约定：进场回填最近弹幕（§4.3）、跨观众弹幕聚合（§4）、一键诊断导出（§4.4）、Android 保活例外（§2）、前端日志桥（§7 `frontend_log`）。
