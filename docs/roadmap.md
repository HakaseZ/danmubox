# 开发路线图（Roadmap）

## 1. 当前状态

阶段依赖：1 游客与协议解码 → 2 登录层 → 3 交互层 / 4 关注与钱包（阶段 2 退出后并行推进）→ 5 三端编译（需 3、4 同时就绪）。取值一律以 [`contract.md`](contract.md) 为准（§4 常量表）。

| 阶段 | 状态 |
|---|---|
| 1 游客与协议解码 | 已退出 |
| 2 登录层 | 已退出 |
| 3 交互层 | 已退出 |
| 4 关注与钱包 | 已退出 |
| 5 三端编译 | 部分完成：macOS 完成；Android 出包 / 装机 / 启动完成（真机、扫码登录、发弹幕、收弹幕未实测）；Windows CI 出包完成（未装机、未在真 Windows 上运行） |

各阶段的交付物、验收标准与退出记录（含日期、读数、提交与产物路径）见 [`../CHANGELOG.md`](../CHANGELOG.md)；三端产物与出包步骤见 [`operations.md`](operations.md) §5.3 / §5.13。

上游未实测的事实一律保持「未验证」标注，不按命名或其它文档推定为已知；校准项与核对方法集中在 [`protocol.md`](protocol.md) 附录 A。

## 2. 下期 backlog（不阻塞已退出阶段的退出条件）

### 2.1 等上游样本或外部条件（结论回填 `protocol.md` 附录 A）

| 项 | 说明 | 前置 | 溯源 |
|---|---|---|---|
| 连线礼物映射 | `UNIVERSAL_EVENT_GIFT(_V2)` → 礼物条目 | 活动期（PK / 连麦）房间的真实载荷；采样方法与归类判据见 `protocol.md` 附录 A（A22）与附录 B | REQUIREMENTS §2.1 |
| `SEND_GIFT`（V1）字段 | V1 礼物的真实字段 | 一条 V1 样本（老客户端或特殊场景才发）；`protocol.md` A8 | REQUIREMENTS §2.1 |
| 未开播条目的排序依据 | 未开播条目取不到开播时间，该档落回 `online` → 房间号 | 上游两个端点都不给未开播条目的开播时间（`liveTime` 为 0 / 缺失）；`protocol.md` A28；排序链 `apps/desktop/ui/src/filtering.ts:147`（`live_start_at` → `online` → `room_id`） | REQUIREMENTS §2.6（P11 未闭环） |
| 部分账号连自己的直播间收不到消息 | 三条护栏已落地：认证 `op=7` 后 10s 无 `op=8` 记一次认证失败、90s 无入站帧判僵死、连续 3 次失败停 `Failed` 等人工重连 | 「受影响的账号 + 可复现房间」（只读即可）；根因核对方法 `protocol.md` A46，护栏见 §13.2 | REQUIREMENTS §2.12（P109 未闭环） |
| 后台长挂与安卓丢弹幕 | 7×24 长挂能力、后台唤回后丢弹幕的区间与成因 | 真机长挂对照；`protocol.md` A47、§13.2 | REQUIREMENTS §2.12 |
| Android 诊断报告写公共下载目录 | 模拟器一档已闭环；真机、多外部存储卷、API 24–28 未验 | 一台真机 / 低版本设备；`protocol.md` A48 | REQUIREMENTS §2.12 |
| 举报接口的官方 web 对照 | A27 已实测「跑通」（日志观察、`code=0`）；缺的是**与官方 web 的逐字一致**与**错误码集合** | **只读对照**：用浏览器打开官方直播间，在 DevTools 里看官方前端举报时的**请求形状**（端点 / 表单字段 / 头），与 `crates/danmubox-bili/src/report.rs` 逐字对照。**不做写操作**（故意触发错误码会招风控，且与「写操作不验证」口径冲突）| REQUIREMENTS §2.4 |

### 2.2 待拍板

| 项 | 说明 | 前置 | 溯源 |
|---|---|---|---|
| Android 端剩余验收 | 真机实测：扫码登录、发弹幕 / 举报 / 房管等写操作、收弹幕、登录态下房间输入区 + 软键盘、四个分 ABI 包的安装、系统栏避让的三键导航与挖孔形态、厂商 ROM 后台管理下的保活收益 | 一台真机；[`testing.md`](testing.md) §10.5「必须真机」表、[`operations.md`](operations.md) §5.3 | REQUIREMENTS §1 |
| Windows 端装机与运行 | CI 出包已完成；本机是 macOS，产物未在任何真 Windows 上装过 / 启动过 | 一台带 WebView2 的真 Windows，按 [`testing.md`](testing.md) §10.3 的 W-1~W-4 走一遍 | REQUIREMENTS §1 |
| 「自用不发布」的措辞 | `REQUIREMENTS.md` §1 写「自用不发布」；仓库已发布为 GitHub 公开库 | 用户拍板：改为「源码公开、产物自用不上架」，或维持原句 | REQUIREMENTS §1 |
| 需求来源口径 | 基线只合并了 `issue` 来源；用户对话中提出的同级需求（P21–P52 / P91–P101 / P123）未在基线立条，出处清单见 [`../CHANGELOG.md`](../CHANGELOG.md) 归档区 | 用户拍板：并入 [`REQUIREMENTS.md`](../REQUIREMENTS.md) 对应 §2.x，或维持「只收 `issue` 来源」的口径 | — |
| `frontend_log` 的溯源 | [`contract.md`](contract.md) §9 溯源表有该行，基线无对应需求 | 用户拍板：基线补一条，或契约标注「非基线原文」 | — |

### 2.3 更远期

| 项 | 说明 | 前置 | 溯源 |
|---|---|---|---|
| 词云 | 基于当前会话缓冲的关键词云 | 非下期核心；按需另立条目 | REQUIREMENTS §4 |
| 透明度功能（需重新设计实现方式） | 原 `ui.opacity`（整表不透明度滑杆）实现方式非预期，已删除（连带偏好键与控件）；重做前先定它作用在什么上（列表容器 / 单条 / 背景） | 用户提出重做意向；届时先改 [`contract.md`](contract.md) §8 再加回键 | REQUIREMENTS §2.13 |
| AI 接入 MCP | 后期想法：接入 MCP，让 Agent 直接消费弹幕数据 | 本期不排期；不定义任何工具、协议或端点。架构约束：`core` 的端口与事件总线不得假设消费方是 UI（[`AGENT.md`](../AGENT.md) §2、§7.3） | REQUIREMENTS §4 |
| iOS 端 | 复用同一 `core` 与 IPC 契约，只新增外壳与构建目标 | 阶段 5 退出且桌面 / 安卓主流程无阻塞性缺陷 | REQUIREMENTS §4 |
| Fold8 / 折叠屏 | 展开 / 折叠态布局、双栏（房间列表 + 聊天）、铰链避让；可行性研究已完成，未实现 | 拿到折叠屏真机且 Android 主流程已跑通；研究结论、目标机型与验证路径见 [`../CHANGELOG.md`](../CHANGELOG.md) 归档区 | REQUIREMENTS §4 |
| 弹幕行内文字表情替换 | token 夹在句中的仍按原文显示；正文整条即 token 的已画图（`crates/danmubox-bili/src/cmd.rs:373`） | 需在前端正文里做行内替换；`protocol.md` A42；缺口登记 [`ui.md`](ui.md) §4.1 | REQUIREMENTS §2.1（P38 部分） |
| 代码注释里过期的需求章节指针 | `prefs.rs` / `Avatar.tsx` 等处的「需求 §2.x」指向旧编号 | 逐处校正（清单见 `.android-env/tmp/requirements-audit.md` A5） | — |
| 两条对话内规矩固化 | 「清单外动作先问」「重建攒批做」尚未固化成条文 | 写入 [`AGENT.md`](../AGENT.md) §9 或 [`operations.md`](operations.md) | — |
| 退出应用时的 `FORTIFY: pthread_mutex_lock called on a destroyed mutex` | **未修**：成因未查（疑似 Rust 侧 teardown 阶段仍被触碰的已销毁锁）；证据为 3 份退出日志各命中一次（`back-logcat.txt:899-905`、`logcat-v2.txt:1500-1506`、`v2-repro-backexit.log:341-347`），其后进程 `exited cleanly (0)`。**不得写成「零 crash」** | 需可复现的优雅退出路径与成因定位；登记处 [`testing.md`](testing.md) §10.5 遗留登记表 | — |

backlog 各项不阻塞已退出阶段的退出条件；启动时各自作为独立阶段登记交付物与验收标准后再实施。

## 3. 风险与缓解

| 风险 | 触发信号 | 缓解动作 |
|---|---|---|
| 协议字段未实测 / 上游协议变更（字段下标、protobuf、被吞判定、举报 / 表情 / 关注 / 钱包端点） | `protocol.md` 附录 A 的条目无结论；事件流出现未识别 `cmd`、解码失败计数上升 | 结论一律取自实测样本，未实测不硬编码（`protocol.md` 附录 A 是唯一承载处）；ac站细节全部隔离在 `danmubox-bili`（[`AGENT.md`](../AGENT.md) §2、§8 第 3 条）；未识别 `cmd` 计入 `unknown_cmd` 并继续（`crates/danmubox-bili/src/cmd.rs:185`、`crates/danmubox-core/src/bus.rs:121`） |
| 连接层：风控 / 限流、认证失败、上游主动断连 | 连接建立后立刻断开、连接频繁被拒、认证回应非 0 `code` | 按 5 / 10 / 20 / 40 / 60s 退避重连，健康会话回落起点（`crates/danmubox-bili/src/ws.rs:37`、`:933`、`:1027`）；非 0 `code` 只记原值、不编造含义（[`contract.md`](contract.md) §5 `SendOutcome`）；凭据失效时引导重新登录 |
| 凭据泄露（明文 `config.toml`） | 日志、前端明文、仓库或崩溃上报中出现真实值 | 权限 0600、只在本机数据目录（`crates/danmubox-core/src/config.rs:381`、`:417`）；凭据不进日志 / 前端明文 / 仓库 / 崩溃上报（[`AGENT.md`](../AGENT.md) §8 第 1 条） |
| 解压炸弹 | 单包解压后体积异常 | 单包解压上限 16 MiB，超限丢弃并计数（`crates/danmubox-bili/src/proto.rs:14`、`:196`） |
| Tauri Android WebView 渲染差异 | 安卓上布局溢出、滚动异常、虚拟列表失效 | 核心逻辑全部放 Rust（[`AGENT.md`](../AGENT.md) §2）；UI 做渐进增强；三端手工冒烟清单覆盖布局与滚动（[`testing.md`](testing.md) §10） |
| 文档与实现漂移（含跨文档指针指向已不存在的章节） | 契约常量被修改而派生文档未更新；指针打不开或指向空章节 | 改常量必须同步契约与派生文档（[`AGENT.md`](../AGENT.md) §6 表、§9 DoD）；过期指针清单见 `.android-env/tmp/requirements-audit.md` A5 |

风险不阻塞已退出阶段的退出条件；处置口径以 [`contract.md`](contract.md) 与 [`protocol.md`](protocol.md) 对应章节为准。
