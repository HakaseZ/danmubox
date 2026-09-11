# B 站直播弹幕框 — 技术选型讨论汇总

> 目标：复现 B 站官方直播间聊天框功能（不解码视频），自用不发布，不需要后台保活，需要登录（游客 / 手填 Cookie / 扫码，扫码为默认），并具备“原生 AI 兼容性”（Agent 可直接调取接口、读取弹幕历史）。
>
> **当前选型范围**：macOS / Windows / 安卓 三端。
> **后期 enhancement（不纳入本期选型）**：iOS 端（含免费 Apple ID 自签）、Fold8 / 折叠屏适配。二者仅增加外壳与布局，不改动引擎与协议层，见 §11。

---

## 1. 需求边界

### 1.1 功能清单

**基础（弹幕协议层）**
- 房间号/短链 → 真实 `room_id` 解析
- WebSocket 长连 + 心跳（每 30s，op=2）+ 自动重连
- `DANMU_MSG` 弹幕：内容、用户、粉丝牌、勋章、颜色
- `INTERACT_WORD` 进入/互动提示
- `SEND_GIFT` 礼物
- `SUPER_CHAT_MESSAGE` / `SUPER_CHAT_MESSAGE_JP` 醒目留言
- 协议：头部 16 字节 + body（proto / zlib / brotli）

**交互（UI 层）**
- 虚拟列表滚动、自动滚动、暂停
- 过滤：关键词、用户、消息类型
- 样式：字号、透明度、合并相似
- 多房间标签页
- 历史记录 / 导出

**登录（三模式）**
1. 游客（不登录，可收大部分弹幕，部分字段被掩码）
2. 手填 Cookie（SESSDATA / bili_jct / DedeUserID / buvid3）
3. 扫码登录（默认入口，本地中转 B 站 passport）

**AI 原生接口**
- 本地 HTTP API：读取弹幕历史、查询状态、发送弹幕、实时流（SSE）
- Agent / 调试工具可直接调用，返回结构化 JSON

### 1.2 非目标
- 不解码直播视频流
- 不需要后台保活 / 推送（前台运行即可）
- 不发布到 App Store / 各应用市场
- 不做系统级悬浮弹幕层（只做侧边聊天框 UI）

---

## 2. 前端框架选型演进

### 2.1 候选对比

| 方案 | 四端能力 | 分发 | 适合场景 |
|---|---|---|---|
| **Flutter** | 一套 Dart 出 iOS/安卓/mac/Win，自绘 UI 一致 | 各端打包签名 | 重体验、一致 UI、原生能力 |
| **React Native + Expo** | 移动端 RN，桌面单独 Tauri/Electron | 移动 Expo，桌面另打 | React 团队、要热更 |
| **Capacitor + Web** | Web 代码 + 原生壳 | iOS/安卓 Capacitor，桌面 Tauri/Electron | 已有 Web 产品快速出端 |
| **PWA** | 浏览器/主屏幕，四端通吃 | 部署 HTTPS，加到主屏 | 轻量、免安装、免签名 |
| **.NET MAUI / KMP** | 多端但侧重不同 | 原生打包 | 特定技术栈 |

### 2.2 关键结论变化

**第一阶段（以为要后台）** → 倾向 Flutter：iOS 后台保活、原生推送、长列表性能。

**第二阶段（明确不需要后台）** → PWA 重回首选：
- 浏览器 WebSocket 可完整实现 B 站弹幕协议（16 字节头 + zlib/brotli 解压）
- 虚拟列表够用，官方聊天框也只是一屏
- 四端一套代码，iOS 自用零签名
- 更新只改服务端

**第三阶段（要登录 + 直连 B 站 API）** → **PWA 被排除**：
- B 站 REST 接口受浏览器 CORS 限制，必须服务端中转
- 纯静态 CF/GH Pages 无法绕过（除本机关安全开关，不适合分发）
- 登录态、WBI 签名、发弹幕都需要后端代理

**第四阶段（要 AI 原生接口 + 无 CORS）** → **Tauri 或 Flutter**：
- 两者都是原生应用，无浏览器同源策略
- 可内嵌本地 HTTP server 供 Agent 调用
- PWA 的“网页安全模型”成为障碍

**第五阶段（iOS 与 Fold8 移出范围）** → **Flutter 的相对优势收窄**：
- Flutter 最强项（iOS 一等公民、四端像素一致）不再计入
- 目标只剩 macOS / Windows / 安卓，其中桌面端两者都能打，Android 是唯一有差距的平台
- 决策收敛到三个问题：引擎语言栈（Rust / Dart）、生态（MCP + 协议库）、包体与工具链

### 2.3 最终二选一：Tauri vs Flutter

| 维度 | Tauri 2 | Flutter 3 |
|---|---|---|
| 引擎语言 | Rust 核心 + Web 前端 | 纯 Dart |
| 弹幕协议 | `tokio-tungstenite` + `flate2` + `serde`，生态齐全 | `dart:io` WebSocket + `ZLibDecoder`，protover=2 原生够用 |
| brotli | Rust `brotli` crate 现成 | pub `brotli` 已停更（0.6.0，SDK `<3.0.0`，Dart 3 不可用）→ 需 FFI，或只请求 zlib |
| 无 CORS 通道 | `tauri-plugin-http` / reqwest，经 IPC | `dart:io` HttpClient，原生不受同源策略约束 |
| 本地 AI API | `axum` + SSE，与引擎同一 crate | `shelf` + SSE，与引擎同一 package |
| MCP | 官方 Rust SDK `rmcp` 成熟 | 无官方 Dart SDK，需手写 stdio / HTTP |
| CLI 复用 | Rust core → 增加 bin 即可，天然共享 | 纯 Dart core → `dart compile exe`，同样可共享（须保持无 Flutter 依赖） |
| Android 成熟度 | Tauri 2 移动端较新，渲染用 System WebView | Android 端最成熟 |
| Android 工具链 | rustup 四 ABI + NDK + `JAVA_HOME` | 仅 Android Studio / SDK / JDK |
| macOS 开发依赖 | 桌面端仅需 Xcode CLT | 需完整 Xcode |
| Windows | 开发需 VS C++ Build Tools；目标机需 WebView2 运行时 | 开发需 VS C++ Build Tools；产物自包含 |
| 包体 / 内存 | 小 / 低 | 大 / 高 |
| UI 迭代 | HTML/CSS，聊天框表达力强、改得快 | Widget，布局代码量大但一致性好 |
| 学习成本 | 学 Rust | 学 Dart |

**结论：倾向 Tauri**（三条硬理由）：

1. iOS 出局后，Flutter 最大优势（iOS 一等公民、四端像素一致）不再计入，只剩 Android 单端优势，而本期主战场是桌面。
2. “AI 原生”是一等需求：Rust 侧有官方 MCP SDK（`rmcp`）；`bili-core` 单个 crate 可同时供给 Tauri UI、CLI、MCP Server、axum HTTP 四个面，Flutter 侧需手写补齐。
3. 聊天框是富文本流（昵称/勋章/颜色/SC 卡片/emoji），HTML/CSS 的表达力与迭代速度优于 Flutter Widget。

**反向条件：完全不想碰 Rust → 选 Flutter**。代价是 MCP 手写、brotli 无可用包（只能 protover=2 或 FFI）、包体更大、Android 之外的工具链更重。

**性能不构成决策依据**：本期负载只是一个文本列表，峰值数十条/秒，两框架都不是瓶颈；Danmaku 渲染性能不作为选型权重。

**已否决的折中方案**：Tauri + Python/Node sidecar，复用 `bilibili-api-python` 等成熟协议库，Rust 只做胶水。否决原因：sidecar 会把包体推回 40MB+，抵消 Tauri 的体积优势，且多一层跨进程生命周期管理；不如核心直接写 Rust。

---

## 3. B 站弹幕协议要点

### 3.1 连接流程

```
短号/URL → 真实 room_id（room_init）
   ↓
getDanmuInfo（wss 地址 + token，需 WBI 签名 + buvid3）
   ↓
WebSocket 连接 wss://broadcastlv.chat.bilibili.com/sub
   ↓
发送认证包（op=7，roomid/protover/platform/type/key）
   ↓
启动心跳定时器（op=2，每 30s）
   ↓
接收业务包（op=5，可能 zlib/brotli 压缩）
   ↓
按 cmd 分发：DANMU_MSG / SEND_GIFT / SUPER_CHAT / INTERACT_WORD
```

### 3.2 数据包结构（16 字节大端头）

| 偏移 | 长度 | 含义 |
|---|---|---|
| 0 | 4 | packetLen（总字节数） |
| 4 | 2 | headerLen（固定 16） |
| 6 | 2 | protover（0=JSON / 2=zlib / 3=brotli） |
| 8 | 4 | op（2=心跳 / 3=人气 / 5=业务 / 7=认证 / 8=认证回） |
| 12 | 4 | seq（通常 1） |

body 可能包含多个子包，需递归按 16 字节头拆分。

### 3.3 游客 vs 登录

| 模式 | 连接方式 | 能力 | 限制 |
|---|---|---|---|
| 游客 | 通用 sub 地址 + 空 key，protover=2 | 收大部分弹幕/礼物/SC | 用户名掩码、UID=0、可能限流 |
| 登录 | 带 SESSDATA 调 getDanmuInfo 拿 token | 完整字段、发弹幕、粉丝牌 | 需 Cookie / 扫码 |

**protover 建议**：优先 2（zlib），浏览器用 `pako.inflate`；避开 brotli 兼容问题（尤其老 iOS Safari）。

---

## 4. 登录方案设计

### 4.1 三种模式

#### 游客（无登录）
- 直连 WS，认证包 key 留空
- 适合只看弹幕、不发言、不在乎昵称真实度

#### 手填 Cookie（备选）
- 用户从浏览器 DevTools 复制 `SESSDATA` / `bili_jct` / `DedeUserID` / `buvid3`
- 存本地安全存储（Rust keyring / Flutter secure_storage）
- **绝不**进前端明文、仓库、服务端日志

#### 扫码登录（默认）
- 应用调 B 站二维码生成接口 → 显示二维码
- 轮询扫码状态 → 用户确认后回写 Cookie
- **无状态中转**：Cookie 只存用户浏览器/本机，中转层不持久化

### 4.2 为什么需要中转

- 浏览器同源策略：CF/GH Pages 前端无法直接 fetch B 站 REST（CORS）
- WebSocket 例外：不受 CORS 预检，游客弹幕可直连
- 中转方案：CF Pages Functions / Worker（无状态）或本机代理（Vite proxy / Node / Python）

### 4.3 无状态中转原则

```
浏览器 ──(携带 Cookie 的请求头)──> Worker/代理 ──(服务端请求)──> B 站 API
                                  ↓
                            不存任何用户凭证，用完即丢
```

- Worker 每次从请求头临时取 Cookie，转发后丢弃
- 不维护 session、不存数据库
- 天然适配 CF Workers 无状态模型
- 扫码流程的 `qrcode_key`、Cookie 全部由浏览器持有

### 4.4 开发者绕过 CORS 的限制

- 本机可用 `--disable-web-security`（仅调试，安全风险大）
- Vite proxy / 本机 Node 代理（开发期推荐，不碰浏览器安全）
- **不可用于分发**：iOS Safari / 安卓 Chrome 无法为用户关闭安全检查

---

## 5. 分发与部署

### 5.1 PWA 分发（已排除，仅作对比）

- 公网/内网域名 + HTTPS → 浏览器安装/加到主屏
- iOS Safari：分享 → 添加到主屏幕（无自动安装横幅）
- 安卓 Chrome：自动安装提示
- Win/Mac：Chrome/Edge 装为独立应用
- **致命问题**：登录/发弹幕需 REST 中转，失去纯静态优势

### 5.2 CF Pages / GH Pages（托管静态资源）

| 项 | CF Pages | GH Pages |
|---|---|---|
| 构建 | 绑定 Git / wrangler | 推 gh-pages 分支 |
| HTTPS | 自动 | 自动 |
| 国内访问 | 较快 | 偶慢 |
| Functions/代理 | Pages Functions / Worker | 无（纯静态） |

游客弹幕（纯 WS）可完全静态部署；登录/发弹幕需 CF Worker 代理 getDanmuInfo/WBI/发弹幕。

### 5.3 原生应用分发（Tauri / Flutter）

| 平台 | 要求 | 自用签名 |
|---|---|---|
| macOS | 开发本机运行；分发需 Developer ID + 公证 | 开发签名可跑 |
| Windows | 需 Visual Studio C++ 工作负载 | 无签名 → SmartScreen 警告 |
| 安卓 | USB 装 APK | 免费，无开发者费 |
| iOS（后期 enhancement） | Mac + Xcode；免费 Apple ID 个人团队自签 | 见 §11 |

### 5.4 iOS 无付费账号限制（后期 enhancement，见 §11）

> 本节内容本期不实施，保留备查。

- 免费 Apple ID 可真机调试、模拟器运行
- 描述文件通常 **7 天到期**，需重签（Xcode Run / 侧载工具）
- 个人团队设备数有限
- 不能 TestFlight / App Store / APNs 推送
- 需开开发者模式 + 信任描述文件
- 侧载工具：AltStore / Sideloadly / SideStore（仍受 7 天限制）
- **不推荐**企业签 / 超级签 / 第三方“永久签”

---

## 6. AI 原生接口设计

### 6.1 本地 HTTP API（通用方案）

应用内启动 HTTP server，绑定 `127.0.0.1`，AI Agent 通过 HTTP 调用。

**推荐接口**

```
GET  /api/status                   当前连接状态、房间号、弹幕计数
GET  /api/rooms/{roomId}/history   弹幕历史（limit / after / types 过滤）
GET  /api/rooms/{roomId}/stream    SSE 实时弹幕流
POST /api/chat/send                发送弹幕（需登录）
GET  /api/cookie                   登录状态（不返回完整 Cookie）
GET  /api/logs                     调试日志
```

> **本节为选型期原文存档，本期未采纳**：本地 HTTP API、SSE 与 MCP 在需求基线中已置空，本期不实现、也不留占位契约（见 [`contract.md`](contract.md) §2、§4.3）。弹幕只保留单次房内会话的内存缓冲，不落盘、不回看、不导出；登录态由凭据文件与 `session_status` 承载，不存在独立的登录状态端点。实现与引用一律以 [`contract.md`](contract.md) 与 [`protocol.md`](protocol.md) 为准。

- 加 Bearer token 鉴权（本地生成，打印到终端）
- 返回 JSON，结构化
- SSE 用于实时流

### 6.2 Tauri 实现

- Rust 用 `axum` / `tokio` 起本地服务
- 弹幕历史存 SQLite（`rusqlite` / `sqlx`）
- WS 客户端 / 解包 / WBI / 扫码全部在 Rust，HTTP 层直接复用
- 可额外提供 CLI 命令（`biliroom --get-history`）
- MCP：Rust MCP 库成熟，可包装成标准 AI 工具

### 6.3 Flutter 实现

- Dart 用 `shelf` / `dart_frog` / `dart:io` 起本地服务
- 历史存 `drift` / `sqlite3`
- UI 与 API 共享同一数据层（Stream / Repository）
- 移动端绑定 `127.0.0.1`；电脑访问手机需 `adb reverse` 或同网段
- MCP 生态较弱，可先提供 OpenAPI 文档

### 6.4 弹幕历史存储

```sql
CREATE TABLE danmaku (
  room_id    INTEGER,
  uid        INTEGER,
  username   TEXT,
  content    TEXT,
  timestamp  INTEGER,
  type       TEXT,   -- danmaku / gift / sc / interact
  color      INTEGER,
  fans_medal TEXT
);
```

AI 可灵活按房间、时间、类型过滤查询。

---

## 7. iOS“小程序”澄清（后期 enhancement，见 §11）

- **App Clips（轻 App）**：iOS 14+，完整 App 的子部分，扫码/NFC/链接秒开，体积很小，依附主 App，支持 Apple Pay。不是通用小程序框架。
- **WidgetKit 小组件**：桌面/通知中心小部件，不能做完整聊天。
- **iMessage App**：信息内嵌功能，非通用。

**结论**：做流式聊天主产品还是得有完整 App，App Clips 只做轻量入口。

---

## 8. 推荐落地路线

### 阶段 1：桌面验证（优先）
- Tauri：Rust WS 弹幕核心 + SQLite + axum API + React 虚拟列表
- 或 Flutter：Dart WS 核心 + drift + shelf API + ListView
- 先跑通游客模式 + 协议解码

### 阶段 2：登录层
- 手填 Cookie 本地存（自用最快）
- 扫码登录走本地中转（默认入口）

### 阶段 3：三端编译
- macOS / Windows：直接 build
- 安卓：USB 装 APK
- iOS / Fold8：移入 §11 enhancement 排期，不阻塞本期

### 阶段 4：AI 接口完善
- 定义 REST + SSE 接口
- 提供 OpenAPI 文档
- 按需升级为 MCP Server

---

## 9. 现成参考（协议层）

- Python：`bilibili-api-python`、`bilibili-danmaku`
- Node：`bilibive`、`blive-message-listener`
- Go：`bilibili-live-go`
- Dart/Flutter：社区弹幕包（参考协议部分）

> 主要参考其**协议编解码 + 心跳逻辑**，UI 自行实现。

---

## 10. 风险与注意事项

| 风险 | 说明 | 应对 |
|---|---|---|
| CORS | 浏览器限制跨域 REST | Rust/原生后端中转 |
| WBI 签名 | getDanmuInfo 需签名 + buvid3 | 后端计算，前端不透传算法 |
| Cookie 泄露 | SESSDATA = 账号控制权 | 只存本机、不进日志、HTTPS |
| 7 天重签 | iOS 免费自签限制（后期 enhancement） | 见 §11；Xcode Run / AltStore 自动续签 |
| 协议变更 | B 站可能调整弹幕协议 | 抽象协议层，便于替换 |
| WebView 差异 | Tauri 移动端兼容 | 核心逻辑放 Rust，UI 渐进增强 |
| 包体大小 | Flutter 较大 | Tauri 更轻（若接受 Rust） |

---

## 11. 后期 Enhancement（本期不纳入选型）

| 项 | 内容 | 触发条件 |
|---|---|---|
| iOS 端 | 复用同一引擎补 iOS 构建；免费 Apple ID 自签（7 天重签）或侧载工具 | 桌面 / 安卓稳定后 |
| Fold8 / 折叠屏 | 展开 / 折叠态布局、双栏（房间列表 + 聊天）、铰链区域避让 | 有折叠屏设备且主流程跑通 |

两项均只增加外壳与布局适配，不改动协议层与引擎 API，因此不影响 §2.3 的 Tauri / Flutter 结论。若最终选 Tauri，iOS 端需额外引入 CocoaPods；若选 Flutter，则直接开 iOS target。

---

*本文汇总自技术选型讨论，聚焦需求边界、协议、登录、分发、AI 接口与最终二选一。iOS 端与 Fold8 折叠屏适配列为后期 enhancement，见 §11。*
