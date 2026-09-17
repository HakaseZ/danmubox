# danmubox（弹幕框）

> 定位：B 站直播间弹幕客户端（自用不发布），面向三端的聊天框式弹幕工具。
> 读者：项目作者本人，以及被指派参与本仓库编码的 AI agent。
> 更新时机：项目边界、技术栈、目录结构、文档清单或对外声明发生变化时。

## 1. 项目定位

| 项 | 值 |
|---|---|
| 中文名 | 弹幕框 |
| 英文名 / crate 前缀 | `danmubox` |
| 仓库 | <https://github.com/HakaseZ/danmubox>（源码公开；**应用产物**仍自用、不上架 —— 见 §2.2 与 §10） |
| bundle id | `dev.kksk.danmubox` |
| 形态 | 桌面 + 移动客户端（Tauri 2 外壳 + Rust 引擎 + React/TS 前端） |
| 定位 | B 站直播间弹幕客户端，自用不发布 |
| 分发 | 自用，不发布 |
| 技术栈 | Tauri 2 + Rust（`danmubox-core` + `danmubox-bili`）+ React/TS 前端 |

「弹幕框」复刻的是 B 站官方直播间的**聊天框**：一个按时间流动的文本消息列表。
项目不做视频播放，界面里没有播放器，只有侧边聊天框式的消息流与房间管理。

需求基线由用户手写、保存在 [`REQUIREMENTS.md`](REQUIREMENTS.md)；把它翻译成工程约定的**规范性契约**是
[`docs/contract.md`](docs/contract.md)。两者与本文冲突时，以契约文档为准。

## 2. 边界：做什么、不做什么

### 2.1 做

- 房间号 / 短号 / URL 解析为真实 `room_id`（一次拿到 `room_id` / `uid` / `live_status`）
- WebSocket 长连接收弹幕，心跳（WS 30s + HTTP 60s）、自动重连（5/10/20/40/60s 退避）、压缩解包（`protover` 0/1/2/3）
- 归一化为六种 `kind`：`danmaku` / `gift` / `superchat` / `interact` / `guard` / `system`
- 发弹幕（含被吞状态归一化）与举报弹幕
- 表情包库（按身份加载）、身份徽标（主播 / 房管 / 总督 / 提督 / 舰长）
- 礼物栏（独立礼物栏或与弹幕混合）、电池余额
- 关注列表（直播中置顶）、多房间标签页、虚拟列表、自动滚动、过滤与关键词告警
- 登录：扫码（唯一入口，手机 B 站 App 扫码）与游客态；凭据文件 `config.toml` 仍可手工编辑，但没有导入界面
- 单次房内会话的内存弹幕缓冲（上限 5000 条）+ 房间内「刷新」手动重连

### 2.2 不做（本期明确排除）

| 排除项 | 说明 |
|---|---|
| 本地数据库 | 不建库、不落盘 |
| 弹幕回看与导出 | 不做回看、不做导出 |
| AI 原生接口 | 需求置空，本期不实现；只保留「后期接入 MCP」的架构兼容能力（`core` 的端口与事件总线不得假设消费方是 UI） |
| 词云 | 非核心功能，列入下期 |
| 视频流解码 | 不拉流、不解码、不播放视频，只消费弹幕协议 |
| iOS 端、Fold8 / 折叠屏适配 | 后期 enhancement，本期不纳入（折叠屏的可行性研究已完成，见 [`docs/foldable.md`](docs/foldable.md)，**未实现**） |
| 推送 | **不做**：后台保活已用 Android **前台服务**实现（退到后台且还有活跃房间连接时起一枚常驻通知，回到前台即停，见 [`docs/operations.md`](docs/operations.md) §2.8），但**不接 FCM、不建自建推送**，也不做开机自启、定时唤醒、账户同步这类保活手段 |
| 应用商店发布 | 自用产物，不签名公证、不上架 |
| 系统级悬浮弹幕层 | 只做窗口内聊天框 UI，不做桌面悬浮层 |

## 3. 当前状态

截至 2026-09-15：

| 项 | 状态 |
|---|---|
| 技术选型 | 已完成（结论见 `docs/decisions/`，9 篇 ADR） |
| 文档基线 | 已完成：需求 [`REQUIREMENTS.md`](REQUIREMENTS.md)、契约 [`docs/contract.md`](docs/contract.md)、协议与实测校准 [`docs/protocol.md`](docs/protocol.md)，另有架构 / IPC / UI / 登录 / 运维 / 测试 / 路线图各一篇（索引见 §7） |
| 代码 | 约 11300 行（Rust + TS/TSX）：`danmubox-core`（领域模型 / 端口 / 总线 / 会话缓冲 / 偏好 / 凭据）、`danmubox-bili`（协议 / WS / 鉴权 / WBI / HTTP）、`danmubox-cli`（采集与校准入口）、`apps/desktop`（Tauri 2 + React 19 + Zustand + 虚拟滚动） |
| 阶段进度 | **阶段 1–4 已退出**；阶段 5 macOS 完成，Android 出包 / 装机 / 启动这一档完成（真机与登录、收发弹幕等链路**未实测**，见 [`docs/operations.md`](docs/operations.md) §5.3），Windows 未完成（见 [`docs/roadmap.md`](docs/roadmap.md) §2.2） |
| 功能面 | 游客态与登录态收弹幕；发弹幕（纯文本 / 表情 / @回复 / 快捷短语）；进场历史回填；礼物（V1+V2、连击聚合、金额统计与排行）；SuperChat；大航海播报；举报（理由清单来自上游）；关注列表与分组；电池余额；多房间标签页；多账号切换与**界面内扫码登录**；房管面板；过滤与 13 项偏好（唯一权威清单见 [`docs/contract.md`](docs/contract.md) §8） |
| 构建与测试 | `cargo test --workspace` **153 通过**；`cargo clippy --workspace --all-targets -- -D warnings` **零告警**；前端 `npx tsc -b` 通过 |
| 桌面端产物 | 可出**独立可执行文件**（前端已内嵌，**不再需要 dev server**）：`cd apps/desktop && ./ui/node_modules/.bin/tauri build --no-bundle` → `target/release/danmubox-desktop` |
| 移动端产物 | 可出 **APK**（工具链全在仓库内，见 §8 与 [`docs/operations.md`](docs/operations.md) §5.3）：`. scripts/android-env.sh` + `cd apps/desktop && CI=true ./ui/node_modules/.bin/tauri android build --apk --ci` → `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`（实测 52 MB / 四个 ABI）。**已验**：装进 Android 模拟器（android-35）启动成功、冷启动 TotalTime 1013ms、进公开测试房间 `1` 连接成功、数据目录与 `prefs.json` 落在应用私有目录；**未验**：真机、扫码登录、发弹幕、收弹幕（3.5 分钟内未观测到弹幕） |

实测校准的进展与仍缺样本的项，统一记在 [`docs/protocol.md`](docs/protocol.md) 附录 A；待办清单见 [`docs/roadmap.md`](docs/roadmap.md) §8。

## 4. 目标平台

| 平台 | 本期 | 说明 |
|---|---|---|
| macOS | 是 | 主开发平台，桌面端一等目标 |
| Windows | 是 | 桌面端目标，依赖 WebView2 运行时 |
| Android | 是 | 移动端目标，Tauri 2 移动端构建；工具链全在仓库内（`.android-env/`，[`docs/operations.md`](docs/operations.md) §5.4），已出包并装进模拟器启动（同上 §5.3）——真机与登录 / 收发弹幕链路**未实测** |
| iOS | 否 | 后期 enhancement |
| Linux | 否 | 未列入目标 |

## 5. 架构总览

四层单向依赖：`danmubox-bili`（唯一接触 B 站的适配器）→ `danmubox-core`（领域模型 + 端口 + 事件总线 + 会话编排 + 本地文件）；
消费面 `danmubox-cli` 与 `apps/desktop/src-tauri` 同时依赖 core 与 bili。
**`core` 不得依赖 `bili`，也不得依赖 `tauri`；逆向或协议变更只改 `bili`。**

分层职责、crate 依赖图、端口（8 个 trait）与并发模型的规范性定义见 [`docs/architecture.md`](docs/architecture.md) §1–§4 与 [`docs/contract.md`](docs/contract.md) §3。

## 6. 目录结构

```text
danmubox/
  crates/{danmubox-core,danmubox-bili,danmubox-cli}/
  apps/desktop/               # Tauri 2 应用：src-tauri/（含入库的 gen/android/ 工程）+ ui/（React + TS + Vite）
  scripts/                    # 仓库内工具链：android-env.sh（bootstrap / source / clean，见 §8 与 operations.md §5）
  docs/                       # 文档（索引见 §7）
  REQUIREMENTS.md             # 需求基线（用户手写）
  README.md  AGENT.md  CHANGELOG.md
```

各 crate 的模块划分见 [`docs/architecture.md`](docs/architecture.md) §2；目录与依赖方向的规范性定义见 [`AGENT.md`](AGENT.md) §2 与 [`docs/contract.md`](docs/contract.md) §3。

## 7. 文档索引

| 文档 | 内容 | 主要读者 |
|---|---|---|
| [`docs/contract.md`](docs/contract.md) | **规范性契约（唯一事实源）**：命名、共享常量、领域模型、端口边界、IPC 命令名、本地文件契约、偏好键、写作要求 | 全体；写代码前必读 |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | 需求基线（用户手写），契约由它翻译而来 | 全体 |
| [`docs/architecture.md`](docs/architecture.md) | 分层、crate 依赖图、core/bili 模块划分、并发模型、会话编排、去重与取消树 | 实现者 |
| [`docs/protocol.md`](docs/protocol.md) | B 站弹幕协议：包头、op、protover、认证与心跳包（WS + HTTP）、子包拆分、重连状态机；**附录 A 是全仓唯一的「待实测校准」表** | 实现者 |
| [`docs/auth.md`](docs/auth.md) | 三种登录模式、buvid3、WBI 签名、扫码状态机、`config.toml` 凭据读写 | 实现者 |
| [`docs/ipc.md`](docs/ipc.md) | Tauri IPC 命令签名与事件、载荷类型、前端 store、乐观发送与订阅生命周期 | 前端实现者 |
| [`docs/ui.md`](docs/ui.md) | 信息架构、布局线框、虚拟列表、滚动与过滤规则、六种 kind 渲染、礼物栏与徽标 | 前端实现者 |
| [`docs/testing.md`](docs/testing.md) | 测试金字塔、协议 fixture、回放、端口契约、三端冒烟 | 实现者 |
| [`docs/operations.md`](docs/operations.md) | 日常操作、故障排查决策树、脱敏规则、卸载与残留清理、**三端构建与分发** | 作者 |
| [`docs/roadmap.md`](docs/roadmap.md) | 当前阶段状态、下期 backlog（等样本 / 待拍板 / 更远期）、风险 | 作者、agent |
| [`docs/foldable.md`](docs/foldable.md) | 折叠屏（Galaxy Z Fold8）适配的**可行性研究**：结论「需改造」、要动多少、怎么验；**未实现** | 作者、agent |
| [`docs/requests.md`](docs/requests.md) | 需求与 issue 归档台账：对话中提出的需求 + 仓库根 `issue` 的逐条对照（状态 / 证据 / 落点） | 作者、agent |
| [`docs/decisions/README.md`](docs/decisions/README.md) | ADR 索引与模板 | 作者、agent |
| [`docs/decisions/0001-tauri-over-flutter.md`](docs/decisions/0001-tauri-over-flutter.md) | 选型：范围收敛到三端后 Tauri 胜出 | 作者 |
| [`docs/decisions/0002-rust-core-shared-surfaces.md`](docs/decisions/0002-rust-core-shared-surfaces.md) | core 无 UI 依赖，端口化后由各消费面共享 | 实现者 |
| [`docs/decisions/0003-protover3.md`](docs/decisions/0003-protover3.md) | 连接协商 `protover=3`（brotli），解码兼容 0/1/2/3 | 实现者 |
| [`docs/decisions/0004-upstream-isolation.md`](docs/decisions/0004-upstream-isolation.md) | B 站实现全部隔离在 `danmubox-bili`，core 只留端口 | 实现者 |
| [`docs/decisions/0005-no-local-database.md`](docs/decisions/0005-no-local-database.md) | 不建库不落盘，弹幕仅保留单次房内会话的内存缓冲 | 实现者 |
| [`docs/decisions/0006-room-supervisor-tasks.md`](docs/decisions/0006-room-supervisor-tasks.md) | 每房间一个 supervisor task + broadcast | 实现者 |
| [`docs/decisions/0007-credential-file.md`](docs/decisions/0007-credential-file.md) | 凭据存明文 `config.toml`（0600），不进日志 / 前端 / 仓库 | 实现者 |
| [`docs/decisions/0008-frontend-stack.md`](docs/decisions/0008-frontend-stack.md) | React + TS + Vite + TanStack Virtual + Zustand + CSS Modules | 前端实现者 |
| [`docs/decisions/0009-in-repo-android-toolchain.md`](docs/decisions/0009-in-repo-android-toolchain.md) | Android 工具链装进仓库内 `.android-env/`（`scripts/android-env.sh`），不用 Android Studio + 全局 SDK | 作者、agent |

## 8. 开发命令

四个 Rust crate（`core` / `bili` / `cli` / `desktop`）与前端均已可编译运行；下表中除标注外均为**已实测可用**的命令。

| 用途 | 命令 | 说明 |
|---|---|---|
| 工作区编译检查 | `cargo check --workspace` | 全 crate 检查 |
| 全量测试 | `cargo test --workspace` | 单元 + 集成 |
| core 单 crate 测试 | `cargo test -p danmubox-core` | 领域模型、端口、会话缓冲、偏好 |
| bili 单 crate 测试 | `cargo test -p danmubox-bili` | 协议解包、WBI、命令归一化、protobuf |
| 格式检查 | `cargo fmt --all -- --check` | rustfmt；**存量不通过**（HEAD 上有 59 处 / 14 文件的差异，宿主 rustc 1.88.0 与项目内 1.98.1 结果相同），见 [`AGENT.md`](AGENT.md) §9 备注 |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` | warning 视为错误 |
| 解析房间 | `cargo run -p danmubox-cli -- resolve <房间号/短号/URL>` | 打印房间元信息 |
| 看弹幕 | `cargo run -p danmubox-cli -- watch <房间> --seconds 60` | 有凭据走登录态，否则游客态；`--quiet` 只看汇总 |
| 抓原始载荷 | `DANMUBOX_LOG=debug cargo run -p danmubox-cli -- watch <房间>` | 字段实测校准的采集入口（`docs/protocol.md` 附录 B） |
| 登录态 | `cargo run -p danmubox-cli -- session` | 只输出状态与当前账号名，不含 Cookie 值 |
| 扫码登录 / 新增账号 | `cargo run -p danmubox-cli -- login [账号名]` | 终端渲染二维码，轮询至确认；不带账号名 = 新增账号（确认后按昵称自动起名），带 = 给该账号重新登录 |
| 登出 | `cargo run -p danmubox-cli -- logout [账号名]` | 清空该账号（缺省 = 当前账号）的凭据；账号条目保留 |
| 账号管理 | `cargo run -p danmubox-cli -- accounts [--use <名字>\|--create\|--remove <名字>]` | 不带参数列出账号（登录状态 + 昵称 / uid）；`--create` 扫码新增；`--use` / `--remove` 切换 / 删除 |
| 发弹幕 | `cargo run -p danmubox-cli -- send <房间> "内容"` | 需登录；返回 `SendOutcome`（被吞/限流/失败）；`--emote <唯一键>` 发表情弹幕 |
| 电池 / 关注 / 表情 / 房管（CLI） | `cargo run -p danmubox-cli -- wallet`、`follow`、`emotes <房间>`、`emotes-owned`、`admin-lists <房间>` | 逐项核对上游能力的只读入口；`admin-lists` 需房管身份 |
| 全局参数 | `--config <路径>` | 以上任何子命令都接受，用于指定另一份 `config.toml`（调试 / 多环境并存） |
| 桌面端（独立产物） | `cd apps/desktop && ./ui/node_modules/.bin/tauri build --no-bundle` | **推荐**：产出 `target/release/danmubox-desktop`，前端已内嵌，双击即用 |
| 桌面端（开发热更新） | `npm --prefix apps/desktop/ui run dev` + `cargo run -p danmubox-desktop` | 仅开发时用；须先起 dev server，否则窗口空白（见 `docs/operations.md` §1.1） |
| Android 环境（导入） | `. scripts/android-env.sh` | **必须 source**（直接执行无效）；导出 `JAVA_HOME` / `ANDROID_HOME` / `NDK_HOME` / `RUSTUP_HOME` / `CARGO_HOME` / `GRADLE_USER_HOME` 等，全部指向仓库内 `.android-env/`（见 `docs/operations.md` §5.4） |
| Android 工具链安装 / 清除 | `scripts/android-env.sh bootstrap`、`scripts/android-env.sh clean` | `bootstrap` 从零安装（可重复执行，已装好的跳过）；`clean` 停 gradle daemon 与 adb server 后删除整个 `.android-env`（**签名材料不在其中**，见 `docs/operations.md` §5.7、§5.12） |
| Android 出包（通用 APK） | `. scripts/android-env.sh && cd apps/desktop && CI=true ./ui/node_modules/.bin/tauri android build --apk --ci` | 产物 `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`（实测 52 MB，含四个 ABI） |
| Android 出包（分 ABI） | 同上再加 `--split-per-abi` | 产物落在同目录的 `apk/<abi>/release/app-<abi>-release.apk`，`<abi>` ∈ `arm64` / `arm` / `x86` / `x86_64` |
| Android 装机 | `adb install -r <APK>` | 用 `.android-env/sdk/platform-tools/adb`；未签名包装不进设备（见 `docs/operations.md` §5.7） |

数据目录可用环境变量 `DANMUBOX_HOME` 覆盖（调试与多环境并存时用）。

## 9. 数据与隐私声明

| 项 | 说明 |
|---|---|
| 网络出口 | 仅连接 B 站直播相关域名（WS 长连与 REST 接口） |
| 凭据文件 | `config.toml`，**明文 TOML**，权限 **0600**，位于本机数据目录；可直接手工编辑（界面与 CLI 都不提供 Cookie 导入入口） |
| 偏好文件 | `prefs.json`，只存被显式改过的界面偏好，不含任何凭据 |
| 消息缓冲 | 仅内存、**按消息类型分档**的环形缓冲（弹幕 5000 / 礼物 2000 / SC 500 / 大航海 200 / 互动 300 / 系统 200，各由 `history.buffer_rows_*` 覆盖；礼物档内部再按金额分级）；生命周期 = 一次房内会话，离开房间即销毁清空，重进是新会话 |
| 数据目录 | macOS `~/Library/Application Support/danmubox`；Windows `%APPDATA%\danmubox`；Android **应用私有目录**——由外壳在启动最早期把 `DANMUBOX_HOME` 注入为 Tauri `app_data_dir()`（应用私有 dataDir 本身，**不是**其下的 `files/` 子目录；实测模拟器 android-35 上为 `/data/user/0/dev.kksk.danmubox`），core 侧保持平台无关、不写死平台路径 |
| 是否落盘 | 常规运行只写 `config.toml` 与 `prefs.json`；无数据库、无历史文件、无弹幕导出。**唯一例外**是你主动点过「一键诊断」之后的那个报告文件：桌面端落在 `~/Downloads/danmubox-diagnose-<UTC 时间戳>.txt`，Android 经 MediaStore 落在公共 `Download` 目录 —— 一次诊断只有一个文件、内容已脱敏（凭据 / uid / 昵称 / 房间号都是 `***`），想删随时删（`docs/operations.md` §2.9） |
| 遥测 | 无。不上报崩溃、不埋点、不回传任何使用数据 |

安全红线：`SESSDATA`、`bili_jct`、`DedeUserID` **不得**出现在日志、前端明文、仓库、崩溃上报中；
凭据在本机以明文存储，使用者需自行保护数据目录。

## 10. 非官方声明与免责

- 本项目是**非官方**第三方客户端，与哔哩哔哩（B 站）及其关联公司**无任何隶属、合作或背书关系**。
- 「B 站」「哔哩哔哩」「bilibili」等名称与商标归其权利人所有，本项目仅作描述性使用。
- 本项目自用、不发布、不商用、不提供任何形式的服务；使用者需自行遵守 B 站用户协议与当地法律法规。
- 协议实现依据公开可见的客户端行为整理，B 站可能随时调整协议；因此产生的功能失效由使用者自行承担。
- 账号安全由使用者自负：凭据以明文存放在本机数据目录，请勿在不可信环境中放置或共享该文件。
- 本项目按「现状」提供，不附带任何明示或暗示的担保。
