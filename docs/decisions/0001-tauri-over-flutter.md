# ADR 0001：采用 Tauri 2 而非 Flutter 作为客户端外壳

> 定位：记录本项目客户端外壳框架的最终选型结论、三条硬理由、反向条件与被否决的折中方案。
> 读者：项目作者、后续接手者，以及任何想重新讨论「要不要换 Flutter」的人。
> 更新时机：目标平台集合发生变化（例如把 iOS 重新纳入本期范围）、上游隔离需求被撤销、或 Rust 侧工具链出现无法绕过的阻塞。

| 项 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-09-11 |
| 决策者 | 项目作者 |
| 影响面 | `apps/desktop/`、`crates/danmubox-core/`、`crates/danmubox-bili/`、`crates/danmubox-cli/`、三端构建流程 |
| 相关文档 | [`../contract.md`](../contract.md) §3、[`0002-rust-core-shared-surfaces.md`](0002-rust-core-shared-surfaces.md)、[`0004-upstream-isolation.md`](0004-upstream-isolation.md)、[`0008-frontend-stack.md`](0008-frontend-stack.md)、[`../distribution.md`](../distribution.md) |

## Context

选型不是一次拍板，而是随需求边界变化逐步收敛（原始讨论已归档，不参与实现）：

| 阶段 | 需求变化 | 当时的倾向 |
|---|---|---|
| 一 | 以为需要后台保活 | Flutter（iOS 后台保活、原生推送、长列表性能） |
| 二 | 明确不需要后台保活、不需要推送 | PWA 重回首选（四端一套代码、iOS 自用零签名） |
| 三 | 需要登录态、WBI 签名、发弹幕，即需要直连 B 站 REST | PWA 被排除（浏览器同源策略，必须服务端中转） |
| 四 | 接口清单里曾列入「AI 原生接口」，要求无 CORS 的本地通道 | 该条本轮已从需求中置空，但「原生进程 + 无 CORS」的结论保留 |
| 五 | iOS 端与 Fold8 / 折叠屏移出本期范围 | Flutter 的相对优势收窄，决策落在 Tauri |

关键约束集合：

- 目标平台只有 **macOS / Windows / Android**；iOS 与折叠屏适配是后期 enhancement，本期不做，且二者只增加外壳与布局，不改动引擎与协议层。
- 需求明确要求「B 站 API 不可控，可能有逆向需求，这部分代码必须完全分离，后续修改不影响核心业务」（REQUIREMENTS.md）。这意味着引擎必须能被切成「领域逻辑」与「上游适配器」两层，并由编译期边界强制。
- 引擎除 UI 外还要被 `danmubox-cli` 这个调试与校验入口复用（见 [`0002-rust-core-shared-surfaces.md`](0002-rust-core-shared-surfaces.md)）。
- 自用不发布，不需要应用商店签名流程；不需要后台保活；没有本地数据库（见 [`0005-no-local-database.md`](0005-no-local-database.md)）。
- 性能不构成决策依据：本期负载只是一个文本列表，峰值数十条每秒，两个框架都不是瓶颈。

阶段五之后，Flutter 最强的两项卖点（iOS 一等公民、四端像素一致）不再计入评分，只剩 Android 单端的成熟度优势，而本期主战场是桌面端。

## Decision

采用 **Tauri 2 + Rust 引擎 + Web 前端（React/TS）**。引擎与适配器实现于 `crates/danmubox-core` 与 `crates/danmubox-bili`，外壳实现于 `apps/desktop`。

三条硬理由：

1. **iOS 出局后 Flutter 的优势收窄。** 目标收敛为 macOS / Windows / Android，桌面两端两者都能打，Android 是唯一存在差距的平台；「iOS 一等公民 + 四端像素一致」不再计入，Flutter 的差异化优势被大幅削掉，而代价（Dart 全栈、包体、内存）仍在。
2. **聊天框是富文本流，HTML/CSS 的表达力与迭代速度优于 Widget 树。** 昵称、粉丝牌、弹幕颜色、SC 卡片、emoji 混排是一屏内的密集富文本排版，用 HTML/CSS 改写快、表达力强；Flutter 的 Widget 布局代码量大，样式细节（字号、透明度、合并相似）的每次调整成本更高。
3. **Rust 单引擎承载端口 / 适配器隔离。** 上游隔离要在「编译器不让你越界」的层面落实：`danmubox-core` 只定义端口（trait）与领域模型，`danmubox-bili` 是唯一允许出现 B 站 URL、字段下标、签名、protobuf 的 crate，依赖方向 `bili → core` 由 workspace 编译期强制（见 [`0004-upstream-isolation.md`](0004-upstream-isolation.md)）。同一份引擎同时供 UI 与 CLI 消费，不需要为第二个消费面重写协议层。

配套结论（同属本决策范围）：

- 协议编解码用 `tokio-tungstenite` + `brotli` + `zlib` + `serde`，压缩协商见 [`0003-protover3.md`](0003-protover3.md)。
- 不引入本地 HTTP 服务；脱离 UI 的调试与校验走 `danmubox-cli`。
- 反向条件：**完全不想碰 Rust → 选 Flutter**。此时需接受：上游隔离没有 crate 级强制力、brotli 需自行补齐或降级压缩、包体更大、Android 之外的工具链更重。
- 性能不作为选型权重，任何「Flutter 渲染更平滑」之类的论点在本期不构成推翻理由。

## Consequences

### 正面

- 端口 / 适配器边界由 crate 依赖方向强制，逆向改动被限制在 `danmubox-bili` 内（正面服务于 REQUIREMENTS.md 的隔离需求）。
- UI 与 CLI 两个消费面共享同一份 Rust 引擎，协议、鉴权、归一化只实现一次。
- 引擎不依赖窗口即可运行，核心逻辑可在 headless 环境与测试中被直接驱动。
- 包体与内存占用更小；macOS 侧开发依赖只需 Xcode CLT（对比 Flutter 需完整 Xcode）。
- 前端用 HTML/CSS，聊天框样式迭代快，样式细节实现成本低。

### 负面

- 作者必须写 Rust；学习成本与编译等待都真实存在。
- Android 端 Tauri 2 移动端较新，渲染依赖 System WebView，需逐设备验证；构建需要 rustup 四 ABI + NDK + `JAVA_HOME` 全套工具链。
- Windows 目标机需 WebView2 运行时（现代 Windows 通常自带，老机器需要处理）。
- 多了一层 Rust ↔ JS 的 IPC 边界，载荷必须两端对齐（见 [`../ipc.md`](../ipc.md)）。

### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| Android WebView 差异 | 不同厂商 WebView 版本行为不一致，可能影响渲染表现 | 核心逻辑全部放 Rust；UI 渐进增强；Android 端纳入手工冒烟清单 |
| 工具链碎片化 | 三端各自需要额外前置依赖，环境搭建成本高 | 在 [`../distribution.md`](../distribution.md) 中固化前置条件与版本要求 |
| 协议变更 | B 站可能调整弹幕协议 | 协议层独立成 `danmubox-bili`，改动不外溢（见 [`0004-upstream-isolation.md`](0004-upstream-isolation.md)） |

补充：选型阶段曾把「AI 原生接口 / MCP 生态」列为一条独立理由。该需求**本轮已置空**——AI 与 MCP 本期不做任何实现，只要求架构保持兼容：`core` 的端口与事件总线不得假设消费方是 UI，新能力一律经端口暴露（见 [`0002-rust-core-shared-surfaces.md`](0002-rust-core-shared-surfaces.md)）。因此它不再构成本决策的理由，也不得作为任何实现的依据。

## Alternatives considered

### 1. Flutter 3（Dart 全栈）

否决理由：iOS 出局后其最大优势不再计入；上游隔离没有 crate 级的编译期强制手段；富文本聊天框的 HTML/CSS 迭代速度优势不可得；包体与内存更大。

重新启用的条件：作者明确放弃 Rust（反向条件成立），或需要在 iOS 上做一等公民体验且愿意接受 Dart 全栈，同时愿意自行承担上游隔离的纪律成本。

### 2. PWA（纯 Web，浏览器 / 主屏安装）

否决理由：B 站 REST 接口受 CORS 限制，登录态、WBI 签名、发弹幕都必须服务端中转；纯静态托管无法绕过（除本机开关关闭安全策略，不适合分发）。阶段三即被排除。

重新启用的条件：只保留游客模式、不做登录与发弹幕、不需要任何非浏览器本地能力时，PWA 仍是四端成本最低的方案。

### 3. Tauri + Python / Node sidecar（Rust 只做胶水）

否决理由：sidecar 复用 `bilibili-api-python` 等成熟协议库看似省事，但会把包体推回 40MB+，抵消 Tauri 的体积优势；并且多出一层跨进程生命周期管理（进程拉起、崩溃重启、stdio 协议、打包进各端）。更重要的是，上游适配代码被放到进程外的脚本里，`core` 与适配器之间就只剩约定没有边界，与 REQUIREMENTS.md 的隔离要求相悖。既然核心用 Rust 写没有不可逾越的障碍，就没有理由付出以上代价。

重新启用的条件：Rust 侧出现无法绕过的协议实现阻塞（例如某个必需的签名算法只有 Python 实现且无法移植），且该阻塞无法通过单点 FFI 解决。

### 4. React Native + Expo / Capacitor + Web

否决理由：两者都是「移动端一套 + 桌面另起一壳」的混合结构，桌面端最终仍要落到 Tauri 或 Electron，等于同时维护两套外壳与工具链；Electron 的包体劣势比 Tauri 更明显。本期三端中桌面占两席，这类方案的复杂度收益比最差。

重新启用的条件：需求重心从桌面转向移动端，且需要热更新能力。
