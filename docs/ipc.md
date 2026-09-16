# danmubox Tauri IPC 契约

> 定位：前端与 Rust 引擎之间唯一的命令/事件契约——命令签名、载荷类型、事件集合、Zustand store 形状与乐观发送规则。
> 读者：写 React/TS 前端的开发者、在 `apps/desktop/src-tauri` 增加命令的 Rust 开发者、需要判断「一处改动要同步几个文件」的 AI 编码 agent。
> 更新时机：新增/删除/改名的命令或事件、改动任何载荷字段、改动 store 形状或乐观发送规则时，必须同步修改本文。
> 与其他文档的分工：命令名清单与常量在 `contract.md`（§7 / §5 / §8）；端口与并发、取消树、退避在 `architecture.md`；协议与 `cmd → kind` 在 `protocol.md`；界面规格与冒烟断言在 `ui.md`。本文不复制它们的正文。

---

## 1. 运行模式

只有一种运行模式：页面运行在 Tauri WebView 中，命令走 `invoke("命令名", 参数)`，事件走 `listen("danmubox://事件名", handler)`。

`vite dev` 下 WebView 内 `@tauri-apps/api` 同样可用，前端的数据路径只有 `invoke` / `listen` 这一条（唯一例外见 §6 的控制台桥）。

约束（规范性）：命令名与事件名的集合是**封闭**的，与 `contract.md` §7 逐条一致（命令清单见 §3、事件清单见 §4）；新增面必须同时改 `contract.md` §7、本文与实现，不允许前端私自定义字符串。

> 「手填 Cookie」不再有对应命令（用户 2026-09-13：登录方式只保留扫码与游客，界面 / CLI 的 Cookie 入口已从全链路移除）。要改凭据只能直接编辑 `config.toml`（`contract.md` §4.1、`auth.md` §8.4）。

> 后期想法（本期不实现）：接入 MCP，让 Agent 直接消费弹幕数据。因此 IPC 只是 core 的一个消费面，core 的端口与事件总线不得假设消费方是 UI；新增能力先落 core 端口，再决定是否暴露成命令。

## 2. 调用约定

| 项 | 约定 |
|---|---|
| 命令注册 | 全部集中在 `apps/desktop/src-tauri/src/lib.rs` 的 `tauri::generate_handler![…]`；命令函数也在该文件（没有 `commands.rs`） |
| 命令名 | `snake_case`，与 `contract.md` §7 字面一致 |
| 参数名 | Rust 侧 `snake_case`；Tauri 2 把参数名转成 **camelCase** 暴露给 JS，因此前端 `invoke` 传 `roomId`、`query`、`patch`、`upstreamId` 等 camelCase 键 |
| 同步/异步 | 39 条命令：29 条 `async fn`，10 条同步 `fn`——`app_info` / `rooms_list` / `rooms_reconnect` / `history_query` / `room_session` / `open_url` / `prefs_get` / `prefs_set` / `diagnose_start` / `frontend_log`。同步命令跑在**主线程**上，任何需要 Tokio runtime 的动作都必须显式取句柄（`tauri::async_runtime::handle()`），不得用 `Handle::current()` |
| 成功返回 | §3 签名表「返回」列的 JSON 值；`void` = 无返回体 |
| 失败返回 | `invoke` reject，值为 `ApiError`：`{ "code": string, "message": string }`（`lib.rs`）。前端按 `code` 分支；`message` 是给人看的文案（Rust `Display` 或上游原文），**不得**解析它做逻辑，也没有 `detail` 这类嵌套字段 |
| 错误码 | `code` 取自 `core::error::Error::code()`，共八个（下表）；错误对象的集合以本文为准 |
| 时间 | 统一 UTC 毫秒、`i64`；JS 侧为 `number` |
| 载荷字段 | `snake_case`（`apps/desktop/ui/src/types.ts` 与后端同形）；**store 里存的就是同一份 `Message`**，不做 camelCase 转换（见 §5） |
| 偏好键 | `contract.md` §8 的字面键名（如 `ui.font_scale`），两边都不改名，store 内也用字面键 |
| 凭据 | 任何命令的返回都不含 `sessdata` / `bili_jct` / `dede_user_id`；`session_status` 只返回状态位 |

错误码（分类见 `contract.md` §7；前端按 code 分支）：

| code | 触发场景 | 前端处理 |
|---|---|---|
| `BAD_REQUEST` | 参数缺失/非法（`input` 解析不出房间号、`query.kinds` 有未知 kind、`prefs_set` 未知键或非法值、`open_url` 非 http(s)、举报理由或 `upstream_id` 为空） | 不重试，就地提示 |
| `UNAUTHORIZED` | 凭据无效/过期（由 core 归一化） | 不重试，引导重新登录 |
| `NOT_FOUND` | 资源不存在（非房间类，如已消费的扫码 `key`、账号名不存在） | 不重试 |
| `ROOM_NOT_FOUND` | 房间号无法解析，或不在已添加列表 | 不重试 |
| `NOT_LOGGED_IN` | 游客模式调用需登录的动作 | 不重试，引导扫码登录 |
| `RATE_LIMITED` | 本地发弹幕节流命中（同房间 2s、相同内容 5s，`contract.md` §4）；原因在 `message` 里 | 不自动重发 |
| `UPSTREAM_ERROR` | 上游接口非预期响应或结构不符；`message` 携带上游原文 | 幂等读请求不自动重试；写请求不自动重试 |
| `INTERNAL` | 本地未预期错误（本地文件 IO、序列化、任务 panic） | 不重试，记录日志 |

## 3. 命令签名表

38 条，与 `generate_handler!` 逐条对应；除表中注明的同步命令外均为 `async fn`。所有命令都接收 `State<'_, AppState>`（下表省略）。「错误」列是实现里可能出现的错误码（由 `core::Error` 归一化映射）；前端只按 `code` 分支。

| 命令 | 参数 | 返回 | 错误 | 说明 |
|---|---|---|---|---|
| `app_info` | 无 | `AppInfo` | — | 版本、数据目录、`config.toml` 路径、是否登录；不含任何凭据。同步命令 |
| `session_status` | 无 | `SessionState` | `INTERNAL` | 未登录时 `logged_in=false`、`uid=0`、`nickname=""`；`active_profile` 是当前生效的 profile 名 |
| `accounts_list` | 无 | `Account[]` | `INTERNAL` | 列出全部账号：`Account { name, nickname, uid, face, logged_in, active }`；游客态不是账号，没有凭据就没有条目 |
| `account_qr_start` | `target: Option<String>` | `QrStart { key, url, svg }` | `BAD_REQUEST` `INTERNAL` | 不带 `target` = **新增账号**（确认后按昵称自动命名，**不覆盖任何已有凭据**）；带 = 给该账号**重新登录**（**覆盖**其凭据，界面必须二次确认并写明覆盖哪个账号）。二维码由后端离线渲染成 SVG，`target` 由界面侧补记、后端不认这个字段 |
| `account_qr_poll` | `key: String` | `QrPoll { state, account }` | `INTERNAL` | `state` ∈ `pending` / `scanned` / `confirmed` / `expired`；确认那一次凭据已落盘、账号已存在，`account` 非空；未确认时 `account` 为 `null` |
| `account_switch` | `name: String` | `SessionState` | `BAD_REQUEST` `NOT_FOUND` `INTERNAL` | 切换当前账号并以新凭据重建各房间连接 |
| `account_logout` | `name: Option<String>` | `SessionState` | `NOT_FOUND` `INTERNAL` | 清掉该账号（缺省 = 当前）的凭据；条目保留、`logged_in=false`（退回游客态） |
| `account_remove` | `name: String` | `SessionState` | `BAD_REQUEST` `NOT_FOUND` `INTERNAL` | 删除账号；不许删最后一个；删当前项自动切走 |
| `rooms_list` | 无 | `RoomView[]` | — | 已登记房间 + 当前连接状态 + 当前会话缓冲条数。同步命令 |
| `rooms_refresh_status` | 无 | `RoomView[]` | `UPSTREAM_ERROR` `INTERNAL` | **定期刷新已登记房间的开播状态**（列表页那 30 秒一拍，`contract.md` §4）：逐个房间只读上游一次 `getRoomPlayInfo`（游客同样成立），把最新的 `live_status` 落进登记表，返回同一份 `RoomView[]` 形状（前端按与 `rooms_list` 相同的口径落地）。**只动 `live_status`**，不碰标题 / 昵称 / 连接态。逐个房间**并发**取，单个失败只记日志并跳过它；**一个都没成功**（且有房间要问）→ `UPSTREAM_ERROR`（前端据此退避，断网时不会每 30 秒打一次）。没有已登记房间时不发任何请求，直接返回空数组 |
| `rooms_add` | `input: String` | `RoomView` | `BAD_REQUEST` `UPSTREAM_ERROR` `INTERNAL` | `input` 为短号/URL/房间号；解析不出即 `BAD_REQUEST`。只登记，不建连 |
| `rooms_remove` | `room_id: i64` | `void` | `INTERNAL` | 移除并断连、取消 supervisor，同时**结束会话并销毁缓冲** |
| `rooms_connect` | `room_id: i64` | `void` | `ROOM_NOT_FOUND` `UPSTREAM_ERROR` `INTERNAL` | 建立会话：创建 supervisor、创建会话缓冲、开始收包。幂等：已连接时直接 `Ok`。**连接态不在返回值里**——看 `danmubox://status` 或重拉 `rooms_list` |
| `rooms_disconnect` | `room_id: i64` | `void` | — | 断开并**结束会话、清空缓冲**。幂等：未连接时也 `Ok` |
| `rooms_reconnect` | `room_id: i64` | `void` | `ROOM_NOT_FOUND` `UPSTREAM_ERROR` `INTERNAL` | 房间内「刷新」：会话还在（连接中/退避中/已连接）→ 只终止当前连接并立即重连，**不清空缓冲、不结束会话**；会话已结束（断连过、或房间被移除后又加回来）→ **重建一次会话**（全新会话、缓冲从空开始，等价重新进房），因此断连之后这颗键不是死键。同步命令 |
| `history_query` | `room_id: i64, query: HistoryQueryDto` | `Message[]`（snake_case，按 `ts` 升序） | `BAD_REQUEST` | 只查**当前房内会话缓冲**（`contract.md` §4.3）；无活跃会话（缓冲已销毁）时返回空数组，不报错。`query` 字段：`limit`（缺省 500）、`after`、`before`、`kinds`、`uid`、`q`（未知 kind → `BAD_REQUEST`）。不跨会话、不回放、不导出。同步命令 |
| `chat_send` | `room_id: i64, content: String, color: Option<i64>, emote: Option<EmoteToken>, reply: Option<ReplyTarget>` | `ChatSendResult` | `BAD_REQUEST` `NOT_LOGGED_IN` `RATE_LIMITED` `UPSTREAM_ERROR` `INTERNAL` | 发弹幕。`emote` 非空 = **表情弹幕**（`emoticon_unique` + 尺寸等整份信息，此时 `content` 只用于日志与节流判重）；`reply` = @ 或回复某条（`mid` + `uname`，回复某条时带 `dmid` = 被回复弹幕的 `upstream_id`）。`color` 缺省 16777215，**原样透传不做范围校验**；上游 `mode=1`（普通弹幕）由实现内部固定，**不作为参数暴露**。**唯一要避免的是 `color=0`**（上游参数层直接拒绝）。本地节流命中 → `RATE_LIMITED`（不发起请求）；已发出的请求结果一律经 `SendOutcome` 返回，被吞不重发 |
| `chat_report` | `message: Message, reason: ReportReason` | `void` | `BAD_REQUEST` `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 举报一条弹幕。`message` 取列表里那一条（实现读它的 `upstream_id` / `uid` / `content`；**`upstream_id` 必需**，为空 → `BAD_REQUEST`）；`reason` 来自 `report_reasons`（同时上报文案与 `id`）。前端签名见 `apps/desktop/ui/src/ipc.ts` 的 `chatReport(message, reason)` |
| `report_reasons` | 无 | `ReportReason[]` | `UPSTREAM_ERROR` `INTERNAL` | 举报理由清单：请求上游 `dMReport/ForReason` 并解析 `data.data[]`，每项 `ReportReason { id, reason }`。**条数由上游决定**，不是本地硬编码清单；不要求登录 |
| `emotes_list` | `room_id: i64` | `Emote[]` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 按**真实会话身份**（取自会话缓存）加载表情包库：无牌/有牌/房管/大航海看到的面板不同；无活跃会话时退回零身份。`Emote.locked` 由上游 `perm` 派生，`true` = 当前身份用不了（界面置灰，不隐藏） |
| `room_session` | `room_id: i64` | `RoomSession` | — | 该房间**当前会话**里的本人身份（`is_admin` / `my_guard_level` / `my_medal_level` / `my_medal_name` / `my_medal_worn` / `danmaku_length`）。无活跃会话 → 全零身份而**不报错**；界面据此决定房管入口**是否出现**（`is_admin` 不为 `true` 时该入口不渲染；拿不到身份即按无权限处理，不靠试错，`ui.md` §4.9）与**输入区的字数上限**（`danmaku_length` 实测 = 40，缺省回落 20；`0` = 还没取到）。同步命令 |
| `emotes_owned` | 无 | `Emote[]` | `UPSTREAM_ERROR` `INTERNAL` | 主站「我的表情」：用户**拥有**的表情包（`upower_` 家族）。`package_kind="owned"`、`room_id=0`、唯一键 = `"upower_" + 表情 text`；未登录时上游退化为免费表情包，因此**不报** `NOT_LOGGED_IN` |
| `admin_mute` | `room_id: i64, uid: i64, hour: i64, msg: Option<String>` | `void` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 禁言：`hour` 为 `-1` 永久 / `0` 本场直播 / 其余为小时数。仅房管可用；**非 0 code 原样带回**（不赋语义），非房管时通常得到上游的权限错误码 |
| `admin_unmute` | `room_id: i64, uid: i64` | `void` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 解除禁言 |
| `admin_silent_list` | `room_id: i64` | `SilentUser[]` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 当前禁言名单（只读）。`SilentUser { uid, uname, face }` |
| `admin_blacklist_list` | `room_id: i64` | `BlacklistedUser[]` | `NOT_LOGGED_IN` `ROOM_NOT_FOUND` `UPSTREAM_ERROR` `INTERNAL` | 黑名单（只读）。内部把 `roomId` 解析成主播 uid 后按 `anchor_id` 寻址——上游这个接口不吃房间号 |
| `admin_blacklist_add` | `room_id: i64, uid: i64` | `void` | `NOT_LOGGED_IN` `ROOM_NOT_FOUND` `UPSTREAM_ERROR` `INTERNAL` | 加入黑名单（拉黑会解除关系并禁止互动，比禁言重） |
| `admin_blacklist_del` | `room_id: i64, uid: i64` | `void` | `NOT_LOGGED_IN` `ROOM_NOT_FOUND` `UPSTREAM_ERROR` `INTERNAL` | 移出黑名单 |
| `admin_keywords_list` | `room_id: i64` | `string[]` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 直播间屏蔽词（只读） |
| `admin_keywords_add` | `room_id: i64, words: String` | `void` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 添加屏蔽词；上游一次只收一个 `keyword`，多词由实现逐个调用 |
| `admin_keywords_del` | `room_id: i64, word: String` | `void` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 删除屏蔽词 |
| `follow_list` | 无 | `FollowedRoom[]` | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 关注列表；交给界面前按 `live_status == 1` 置顶（`contract.md` §5），完整展示排序见 `ui.md` §2.2 |
| `wallet_balance` | 无 | `number`（Rust `i64`） | `NOT_LOGGED_IN` `UPSTREAM_ERROR` `INTERNAL` | 电池余额（整数）：上游 `data.gold`（金瓜子）按 `gold / 100` 换算成电池；`gold` 缺失或不可解析 → `UPSTREAM_ERROR`。没有包裹类型（口径与端点见 `protocol.md` 附录 A29） |
| `open_url` | `url: String` | `void` | `BAD_REQUEST` `UPSTREAM_ERROR` | 用系统默认浏览器打开链接（点昵称跳用户主页）。**只放行 `http://` / `https://`**，否则 `BAD_REQUEST`；未能启动浏览器（含当前平台没有实现）→ `UPSTREAM_ERROR`。同步命令。平台实现：macOS `open` / Windows `cmd /C start` / Linux `xdg-open` 各一条系统命令；**Android 走官方 `tauri-plugin-opener`（平台 Intent）**——插件只在 Android 目标声明（`[target.'cfg(target_os = "android")'.dependencies]`，桌面构建依赖图与产物一字不变），由 **Rust 侧**调用、**不进 capability**（`capabilities/default.json` 不需要 `opener:*` 权限）；iOS 等其余平台仍是显式 `Unsupported`（不静默失败） |
| `prefs_get` | 无 | `PrefsSnapshot`（`contract.md` §8 全部 18 键的**生效值**） | `INTERNAL` | 未写入过的键返回 `contract.md` §8 默认值。同步命令 |
| `prefs_set` | `patch: Partial<PrefsSnapshot>` | `PrefsSnapshot`（合并后的生效值**全集**） | `BAD_REQUEST` `INTERNAL` | 未知键或非法值 → `BAD_REQUEST`，整批拒绝；成功返回与 `prefs_get` 同形。同步命令 |
| `diagnose_start` | `engine: String` | `DiagnoseStart` | — | 一键诊断：开始采集连接诊断（`contract.md` §4.4）。`engine` 是渲染引擎标识（前端传 `navigator.userAgent`：内核版本只有页面知道，报告头要用它）。窗口固定 180 秒，界面按 `ends_ms` 倒计时、到点自动收工。采集中**不发送任何数据**（本仓无遥测）。同步命令：只写窗口起止时刻，不碰 IO |
| `diagnose_export` | 无 | `DiagnoseExport` | `INTERNAL` | 一键诊断：渲染并写出**恰好一个**报告文件（`contract.md` §4.4 的位置与命名）、结束采集并清空采集内容。`INTERNAL` 只在写文件失败时出现（目录不可写 / MediaStore 拒绝），`message` 带本地路径与原话。前端由 `diagnose_start` 的界面在窗口到点或用户点「提前结束」时调用 |
| `frontend_log` | `level: String, message: String` | `void` | — | **前端 → 后端的内部命令**，不是给业务代码用的：控制台桥把 `console.error` / `console.warn` 与未捕获错误转发过来，写进 `tracing` 日志（`target = "danmubox::ui"`，`level` ∈ `error` / `warn`，其它值降级为 debug）。同步命令，永不失败。详见 §4.1 |

`prefs_set` 接受部分补丁（只提交要改的键），返回合并后的全量生效值。

### 3.1 载荷类型

```ts
type MessageKind = "danmaku" | "gift" | "superchat" | "interact" | "guard" | "system";

// 命令与事件携带的原始形态：contract.md §5 的 Message，snake_case
type Message = {
  local_id: number;      // 会话内自增序号，仅用于 UI key 与本地引用；进程重启后重置
  room_id: number;       // 真实房间号
  kind: MessageKind;
  ts: number;            // UTC 毫秒
  uid: number;           // 游客/未知为 0
  uname: string;
  face: string;          // 发言者头像 URL；各命令的来源见 contract §5；取不到为空串（前端自行降级）
  content: string;
  color: number;         // 十进制 RGB；界面不吃它做配色
  medal_level: number;   // 发送者粉丝牌等级，0 无
  medal_name: string;
  medal_lit: boolean;          // 这块牌**亮着**吗（上游 user.medal.is_light）；界面只在为真时画牌（contract §5、protocol A43）
  medal_color_start: string;   // 粉丝牌配色：带 alpha 的 CSS 十六进制串；空串不是颜色
  medal_color_end: string;
  medal_color_border: string;
  medal_color_text: string;
  guard_level: number;         // 发送者在本房间的大航海：0 无 / 1 总督 / 2 提督 / 3 舰长
  medal_guard_level: number;   // 粉丝牌自身所属房间的舰长标记；只用于牌面样式，不画舰长标
  is_admin: boolean;           // 发送者是否房管
  is_history: boolean;         // 是否来自进场回填；实时推送恒为 false
  amount: number;              // 金额：礼物与大航海是金瓜子、SC 是元；界面一律按元展示（金瓜子 ÷1000，contract §5）
  combo_id: string;            // 礼物连击标识（上游 batch_combo_id），非连击为空串
  emote: EmoteRef | null;      // 表情弹幕的整份表情信息；非表情为 null
  reply_to_uid: number;        // 被回复者 uid；0 = 不是回复
  reply_to_uname: string;      // 被回复者昵称；非回复为空串
  reply_type_enum: number;     // 上游回复枚举（0 无关系 / 1 有关系）；不区分「@」与「回复某条」
  show_reply: boolean;         // 上游 show_reply，实测恒为 true，不作为判别式
  reply_uname_color: string;   // 被 @ 者名字的颜色；无关系为空串
  upstream_id: string;         // 上游弹幕标识，举报必需
};

type EmoteRef = {
  emoticon_unique: string;  // 上游唯一键
  url: string;
  width: number;
  height: number;
  is_dynamic: boolean;
  in_player_area: boolean;
  bulge_display: boolean;
};

// chat_send 的 emote 参数：发**表情弹幕**时携带的整份表情信息
// （官方发送载荷 msg=emoticon_unique、dm_type=1、emoticonOptions=…，见 protocol.md §11.4）
type EmoteToken = {
  emoticon_unique: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
  is_dynamic: boolean;
  in_player_area: boolean;
  bulge_display: boolean;
};

// chat_send 的 reply 参数：@ 某人与回复某条（protocol.md §11.6）
type ReplyTarget = {
  mid: number;       // 被 @ 者 uid
  uname: string;
  dmid: string;      // 被回复弹幕的 Message.upstream_id；仅 @ 时为空串
};

// history_query 的 query 参数
type HistoryQueryDto = {
  limit?: number;        // 缺省 500
  after?: number;
  before?: number;
  kinds?: MessageKind[];
  uid?: number;
  q?: string;
};

// contract.md §5 的封闭集合
type SendOutcome =
  | "ok"                // 已发出且进入公开弹幕流
  | "blocked_platform"  // 被平台风控吞掉
  | "blocked_room"      // 被直播间吞掉
  | "rate_limited"      // 上游频率限制
  | "medal_required"    // 粉丝牌等级不足
  | "muted"             // 已被禁言
  | "failed";           // 兜底，具体原因在 detail 里

// chat_send 的返回，也是 danmubox://send 的载荷
type ChatSendResult = {
  room_id: number;
  content: string;
  outcome: SendOutcome;
  detail?: string | null;   // 上游 msg 原话 + code 拼成的一行；outcome="ok" 时不出现
};

type SessionState = {         // session_status / account_* 的返回
  logged_in: boolean;
  uid: number;                // 未登录为 0
  nickname: string;           // 未登录为空串
  active_profile: string;     // config.toml 中当前生效的 profile 名
};

// accounts_list 的返回：每个账号一份具名凭据（config.toml 的 [profiles.<name>]）
type Account = { name: string; nickname: string; uid: number; face: string; logged_in: boolean; active: boolean };

// account_qr_start 的返回：二维码由后端离线渲染成 SVG，前端包成 data URI 显示
type QrStart = { key: string; url: string; svg: string };

type QrState = "pending" | "scanned" | "confirmed" | "expired";

type QrPoll = {
  state: QrState;                // 归一化状态（状态码语义表由 auth.md 拥有）
  account: Account | null;       // state="confirmed" 时非空
};

type RoomView = {
  room_id: number;
  short_id: number;
  anchor_uid: number;
  anchor_uname: string;          // 主播昵称；空串 = 上游未给，界面回落 title →「房间 <号>」
  title: string;
  live_status: number;           // 0 未开播 / 1 直播中 / 2 轮播
  connected: boolean;
  buffered: number;              // 当前会话缓冲条数，无会话为 0
};

// danmubox://room 的载荷：RoomView 去掉连接态与缓冲条数
type Room = Omit<RoomView, "connected" | "buffered">;

// 我在该房间的身份（表情包可用范围与徽标判定依据），会话级、不落盘
type RoomSession = {
  room_id: number;
  my_medal_level: number;
  my_medal_name: string;
  my_medal_worn: boolean;      // 我**是否佩戴着**这块牌（上游 data.medal.is_weared）；持有 ≠ 佩戴（contract §5、protocol A43）
  my_guard_level: number;
  is_admin: boolean;
  danmaku_length: number;      // 本房间的弹幕字数上限（上游 data.property.danmu.length；实测 40、缺省 20，protocol A44）。
                              // 0 = 尚未取到身份 —— 界面按缺省 20 处理，不当成「一个字都不许发」
};

type EmotePackage = "common" | "owned" | "room" | "medal" | "guard";

type Emote = {
  key: string;
  package_kind: EmotePackage;    // owned = 主站「我的表情」（contract.md §5）
  emoticon_unique: string;       // 发表情弹幕时上游要的就是它
  text: string;
  url: string;
  width: number;
  height: number;
  is_dynamic: boolean;
  in_player_area: boolean;
  bulge_display: boolean;
  room_id: number;               // 房间专属时非 0，主站表情为 0
  locked: boolean;               // true = 当前身份用不了，界面置灰
};

type FollowedRoom = {
  room_id: number;
  uname: string;
  face: string;
  title: string;                 // 直播间标题；空串 = 上游未给
  live_status: number;
  group_name: string;
  live_start_at: number;         // 本场开播时刻（Unix 秒）；0 = 未知
  online: number;                // 人气 / 在线数；缺失 = 0
};

// 房管只读列表条目（禁言名单与黑名单同形）
type SilentUser = { uid: number; uname: string; face: string };
type BlacklistedUser = SilentUser;

type RoomStats = {
  room_id: number;
  online: number | null;   // 在线人数，未给过为 null
  watched: number | null;  // 累计看过，未给过为 null
};

type ReportReason = { id: number; reason: string };

type PrefsSnapshot = {            // contract.md §8 的 18 键全量，键名即契约字面
  "ui.font_scale": number; "ui.theme": "system" | "dark" | "light";
  "ui.auto_scroll": boolean; "ui.pause_on_hover": boolean;
  "ui.gift_in_danmaku": boolean;      // 弹幕流里是否包含礼物 / SC / 大航海（默认 true）
  "ui.gift_panel": boolean;           // 是否显示独立礼物栏（默认 true）
  "ui.gift_pane_on_top": boolean;     // 礼物栏是否在共享分区的上半（默认 false = 礼物在下）
  "ui.gift_pane_ratio": number;       // 礼物栏占共享分区高度的份额（默认 0.35，范围 0.10–0.90）
  "ui.gift_collapse_cheap": boolean;  // 礼物栏里把 ≤0.1 元的礼物合并成一条（默认 false）
  "ui.gift_exclude_cheap_stats": boolean; // 把 ≤0.1 元的礼物从折叠汇总 / 统计里剔除（默认 false）
  "ui.interact_auto_hide": boolean;   // 互动/进场消息显示一会儿后自动消失（默认 true）
  "ui.show_timestamp": boolean;       // 弹幕前显示时间戳（默认 false）
  "composer.phrases": string[];
  "filter.uids": number[];
  "filter.kinds": MessageKind[];      // 默认不含 "system"（系统类消息默认不显示）
  "filter.medal_level_min": number;
  "history.buffer_rows": number;
  "ui.recent_watched": Record<string, number>;  // 房间号 → 最近一次打开的时刻（UTC 毫秒）
};

type AppInfo = {
  version: string;      // CARGO_PKG_VERSION
  data_dir: string;
  config_path: string;  // config.toml 的完整路径
  logged_in: boolean;
};

// 一键诊断（contract.md §4.4）。时间都是 UTC 毫秒。
type DiagnoseStart = {
  started_ms: number;   // 采集窗口起点
  ends_ms: number;      // 窗口截止时刻（界面按它倒计时）
};

type DiagnoseExport = {
  path: string;         // 给用户看的位置：桌面端绝对路径；Android 为 /sdcard/Download/…
  name: string;         // 文件名（danmubox-diagnose-YYYYMMDD-HHMMSS.txt）
  bytes: number;        // 报告字节数
  attempts: number;     // 报告里带了几条连接尝试
  logs: number;         // 报告里带了几行窗口内日志
  started_ms: number | null;  // 本次采集窗口的起止（直接导出时为 null）
  ends_ms: number | null;
};
```

### 3.2 待实测校准

> 唯一「待实测校准」表在 [`protocol.md`](protocol.md) 附录 A；本文不再自建。

## 4. 事件表

后端 → 前端共 **7 个**事件名。前端由 `subscribeEvents` 统一 `listen`（`apps/desktop/ui/src/ipc.ts`），只订阅传入的 handler 对应的事件；返回的取消订阅函数必须保存（见 §8）。

| 事件名 | 载荷（snake_case） | 触发时机 | 频率控制 |
|---|---|---|---|
| `danmubox://message` | `Message` | 每归一化一条消息；同时写入该房间会话缓冲 | 不节流；前端按帧合批渲染 |
| `danmubox://room` | `Room` | 长连接里 `LIVE` / `PREPARING` 到达（`protocol.md` §10.7）：先把登记表里该房间的 `live_status` 改掉，再把改后的**整条** `Room` 推给界面（`LIVE` → `1`、`PREPARING` → `0`，见 `contract.md` §6）。界面据此合并 `rooms` 与 `followed` 里同号的那一条 —— 房间头状态点 / 标签页圆点 / 列表卡片 / 关注行同时变，不需要重连或手动刷新。载荷不含连接态——连接态走 `danmubox://status`（总线上推的是 `Event::LiveStatus` 这条小载荷，**桌面外壳**补齐整条 `Room` 后再推给界面；总线上的 `Event::Room` 因此仍无生产者） | 事件驱动（一条连接生命周期内至多几次） |
| `danmubox://session` | `RoomSession` | 会话建立后本人房内身份取到时推一次；取不到则只记日志、不推 | 事件驱动 |
| `danmubox://status` | `StatusEvent` | 连接状态变化；会话关闭（`RoomClosed`）也以 `disconnected` 形态从这里推出 | 事件驱动 |
| `danmubox://send` | `ChatSendResult` | 每次 `chat_send` 得到结果（**与命令返回值同构**，同一份对象再发一次） | 事件驱动 |
| `danmubox://room_stats` | `RoomStats` | 房间观众数变化（在线人数 / 累计看过，两侧可缺省；`contract.md` §5） | 事件驱动，不进会话缓冲 |
| `danmubox://log` | `string` | `tracing` 日志行经桥接层推出，格式为 `"<LEVEL> <message>"` | 事件驱动；前端日志切片上限 200 行（§8） |

```ts
type ConnState = "connecting" | "connected" | "disconnected" | "error";

type StatusEvent = {
  room_id: number;
  state: ConnState;
  detail: string;   // 人类可读补充；认证失败时只放原始 code，不赋语义
};

type RoomStats = {   // 与 §3.1 同名，事件即它本身
  room_id: number;
  online: number | null;
  watched: number | null;
};
```

**`ConnState` 仍是这四个取值**：`protocol.md` §13.1 的终态 `Failed` **不新增取值**——§13.3 步骤 6 明写「房间状态置为 error」。连续 3 次认证失败后自动重连**停止**，这个终态同样报 `"error"`，`detail` 里带「已停止自动重连；手动刷新可重置」。前端要区分「退避重连中」与「已停止自动重连」时读 `detail`；若要单独呈现一档，得先在 `protocol.md` §13、本节与 `ui.md` §3.3 一起加取值。

**`danmubox://session` 的判别规则**：这个事件名上目前只推一种载荷——房内身份 `RoomSession`（`Event::Session`，会话建立时向总线发一次）。但前端必须按**判别字段**分派，而不是假定载荷种类：有 `logged_in`（boolean）→ 登录态 `SessionState`；有 `is_admin`（boolean）→ 房内身份 `RoomSession`。分派写错（例如把身份当登录态）会把 `session.logged_in` 覆盖成 `undefined`，界面随即误判成游客态。

### 4.1 控制台桥（前端 → 后端的内部命令）

`frontend_log` 不是事件，是**前端 → 后端**的命令；它不由业务组件调用，而由 Rust 注入的脚本调用。

| 项 | 内容 |
|---|---|
| 注入 | `CONSOLE_BRIDGE` 常量（`lib.rs`）在页面加载完成（`PageLoadEvent::Finished`）后由 Rust `eval` 注入 WebView；每次加载都注入一次，脚本自带去重标记防重复挂钩 |
| 调用方式 | 脚本直接调原生 `window.__TAURI_INTERNALS__.invoke('frontend_log', { level, message })`——这是 §6「前端不出现 `invoke` 字面量」的唯一例外，它不承载业务数据 |
| 捕获范围 | `console.error` / `console.warn`（转调原函数，不吞日志）、`window` 的 `error` 事件、`unhandledrejection` |
| `level` | 只取 `error` / `warn`；Rust 侧分别映射为 `tracing::error!` / `tracing::warn!`，其它值降级为 debug |
| `target` | `"danmubox::ui"`——Rust 侧一份日志即可覆盖前后端 |
| 截断 | `message` 截到 **2000 字符**；去重键另取 `level + "\0" + message` 的前 **200 字符** |
| 去重 | 同一条告警 **1000ms** 内只上报一次；去重表超过 200 条即清空 |

去重的必要性：Rust 侧日志会回推成 `danmubox://log`，界面日志面板随之重渲染；若某条告警每次渲染都复现（如 React 的重复 key），不回推去重就会形成「渲染 → 告警 → 日志 → 重渲染」的反馈环。

## 5. Zustand store 形状

单一 store（`create<AppStore>`，无切片拆分）。**store 里存的就是 §3.1 的载荷对象**（snake_case），不做 camelCase 转写；本地实现细节只有两个 UI 专用字段（`send_state` / `send_reason`）。

```ts
type AppStore = {
  // 会话与账号
  info?: AppInfo;
  session?: SessionState;
  accounts: Account[];
  qr: QrStart | null;              // 界面另外补记 target（QrStart 不含它）
  qrState: QrState | null;
  qrError: string | null;

  // 房间（列表只在内存中，进程重启为空）
  rooms: RoomView[];
  activeRoomId?: number;
  status: Record<number, { state: ConnState; detail: string }>;

  // 弹幕：只有「当前房间」一份，随一次房内会话生死（离开 / 切房即清空）
  messages: Message[];             // 显示上限 2000 条，见 §8
  seeding: boolean;                // 首屏历史回填进行中
  lastSend?: ChatSendResult;       // **只属于当前房间**：切房即清、非当前房间的结果不落（§8）
  roomStats: Record<number, { online?: number; watched?: number }>;

  // 表情、关注、钱包、身份
  emotes: Emote[];
  ownedEmotes: Emote[];            // 主站「我的表情」
  ownedLoaded: boolean;
  ownedError?: string;
  followed: FollowedRoom[];
  balance?: number;                // 电池余额（整数；`wallet_balance` 的返回）；换人即作废（§8）
  roomIdentities: Record<number, RoomSession>;   // 按房间缓存，**会话结束**即删（切房保留，§8）

  // 房管（会话级）
  adminSilent: SilentUser[];
  adminBlacklist: BlacklistedUser[];
  adminKeywords: string[];
  adminErrors: { silent?: string; blacklist?: string; keywords?: string };
  adminBusy: boolean;

  // 偏好、日志、提示
  prefs?: PrefsSnapshot;           // 字面键，见 §3.1
  logs: string[];                  // 上限 200 行
  error?: string; notice?: string;
};
```

本地乐观行（§7）的形态：

```ts
type SendState = "unconfirmed" | "rejected";   // Message.send_state（另有 Message.send_reason）

// 本地行 = 完整 Message + 负数 local_id（-1、-2、…，见 store.ts 的 insertPending）
// 真实 local_id 由后端按会话单调分配、恒为正，两者永不碰撞；**回播命中时也不换号**
// （换成上游的号 = 换 React key = 重建节点，就不是「看不出回播」了）。
// send_state **缺省 = 普通行**：既包括回播把字段换进来的那条，也包括刚插入、还在等回执的本地行
// ——后者必须与「别的客户端看到的我」**渲染逐项相同**，不许表达「发送中」。
// 两档：unconfirmed（8s 没等到回播 / IPC 出错，行尾「未确认」）、
// rejected（上游明确拒绝：正文划线，行尾写 send_reason —— 与浮片同一句）。
```

| store 动作 | 调用 | 说明 |
|---|---|---|
| `bootstrap()` | `app_info` + `session_status` + `rooms_list` + `prefs_get` + `accounts_list`（并行） | 启动入口：先铺数据，再 `subscribeEvents` 订阅事件（§8） |
| `refreshIdentity()` / `loadAccounts()` / `applySession(session)` | `session_status` / `accounts_list` | 登录态或账号变化后的统一善后；**不吃** `account_*` 的返回值，以重拉结果为准。并发换人时以**最后点击的那一代**为准（身份世代，见 §8） |
| `switchAccount(name)` / `removeAccount(name)` / `logoutAccount(name?)` / `startAccountQr(target?)` / `pollAccountQr()` / `cancelAccountQr()` | `account_switch` / `account_remove` / `account_logout` / `account_qr_start` / `account_qr_poll` | 账号族；成功后按新会话重拉房间与关注。**换人时先清掉上一个身份的界面切片**（房间与房内缓冲、身份快照、房管三块、表情库、余额等，见 §8）。取号在命令之前：晚到的旧续作直接放弃（§8） |
| `addRoom(input)` | `rooms_add` | 成功后重拉 `rooms_list` 并 `openRoom` |
| `openRoom(roomId)` | `history_query`（`limit: 0`）+ `rooms_connect` | 开一次新房内会话：清空 `messages`、房管三块与 `lastSend`，回填历史，再建连；同时记 `ui.recent_watched`。历史落地前复核 `activeRoomId` 仍是它（§8）；**该房间的身份快照保留**（切房不结束会话） |
| `closeRoom()` | — | 关标签：清空 `messages` / 房管数据，删该房间 `roomIdentities` |
| `removeRoom(roomId)` | `rooms_remove` | 移除并断连；若是当前房间则与 `closeRoom` 同款清理 |
| `connect(roomId)` / `disconnect(roomId)` / `refresh(roomId)` | `rooms_connect` / `rooms_disconnect` / `rooms_reconnect` | 三个都只 `invoke` 再重拉 `rooms_list`——连接态以重拉结果为准，快照按序号复核（§8）。`disconnect` 另按「离开房间」口径删该房间 `roomIdentities` 与房管三块 |
| `send(roomId, content, emote?, reply?)` | `chat_send` | 乐观渲染 + 回执校验，见 §7；结果只登记在当前房间（§8） |
| `report(message, reason)` | `chat_report` | 与命令同参：整条 `Message` + `ReportReason` |
| `loadReportReasons()` | `report_reasons` | 首次拉取后缓存；失败不覆盖已有清单 |
| `loadEmotes(roomId)` / `loadOwnedEmotes(retryFailedOnly?)` | `emotes_list` / `emotes_owned` | 由 `RoomView` 的 effect 在登录态就绪时触发；主站表情成功一次后不再重复拉。房间表情落地前复核 `activeRoomId`（§8） |
| `loadFollowed()` | `follow_list` | 会话就绪后与登录/换号后各自动调用一次；返回后按 `ui.md` §2.2 的排序链渲染。**返回是否成功**（`boolean`）供列表页轮询判退避；失败仍进全局错误条，不静默 |
| `startListStatusPolling()` | `rooms_refresh_status`（+ 登录时的 `follow_list`） | 列表页的开播状态轮询（`contract.md` §4）：返回**停止函数**，进房间页或卸载即停。进入列表页立即一拍，之后每 30 秒一拍；`document.visibilityState` 不是 `visible` 就整拍跳过（不发请求）；下一拍只在上一拍落地后才排（**不重叠**）；失败按 30 → 60 → 120 → 240 秒封顶退避、成功复位。落 `rooms` 走与 `rooms_list` 同一个**快照序号护栏**（§8） |
| `loadBalance()` | `wallet_balance` | 状态栏展示；进入房间时刷新；换人即作废（§8） |
| `loadRoomIdentity(roomId)` | `room_session` | 进房取一次快照；之后靠 `danmubox://session` 更新。落地前复核身份世代（§8） |
| `loadAdmin(roomId)` | `admin_silent_list` / `admin_blacklist_list` / `admin_keywords_list` | 三块各自失败各自留痕，一块挂了不清空另外两块；落地前复核 `activeRoomId` 仍是它（§8） |
| `runAdmin(roomId, action)` | `admin_mute` / `admin_unmute` / `admin_blacklist_add` / `admin_blacklist_del` / `admin_keywords_add` / `admin_keywords_del` | 一次一个写操作；成功后就地重读三块，`adminBusy` 期间禁用按钮 |
| `updatePrefs(patch)` | `prefs_set` | 用返回的全量生效值覆盖 `prefs` |
| `openProfile(uid)` | `open_url` | 点昵称跳用户主页 |
| `dismissError()` / `setNotice(notice?)` | — | 错误条 / 浮动提示的本地开关 |

## 6. 客户端封装

唯一 IO 边界是 `apps/desktop/ui/src/ipc.ts`：业务组件只 import 一个与 §3 同名、同参、同返回的客户端接口（`api`），不出现 `invoke` / `listen` 字面量；事件订阅统一为 `subscribeEvents(handlers): Promise<UnlistenFn>`，返回取消订阅函数。命令失败时由 `call()` 把命令名与错误码打到控制台（经 §4.1 的桥进入 Rust 日志）；`describeError` 把 `ApiError` 转成展示文案。

```ts
type EventHandlers = {
  onMessage?(m: Message): void;
  onStatus?(e: StatusEvent): void;
  onRoomStats?(e: RoomStats): void;
  onRoom?(r: Room): void;
  onSession?(s: SessionState): void;      // 按判别字段分派后才会命中
  onRoomSession?(s: RoomSession): void;   // 同上
  onSend?(e: ChatSendResult): void;
  onLog?(line: string): void;
};
```

**唯一例外**：控制台桥注入脚本（`CONSOLE_BRIDGE`，§4.1）直接调原生 `invoke`，它不承载业务数据，也不经过 `api`。

## 7. 发弹幕的乐观更新与失败回滚

`chat_send` 是本项目唯一「本地状态先于服务端确认」的命令：点下发送**立刻**在列表末尾渲染一条本地行，
再发请求；上游返回只做校验，不作为展示前置。判据是三条（`ui.md` §4.4）：**发出去的 = 我用别的客户端
看到的样子**、**看不出中间有回播**、**被 ban 的那条留着划线并写原因**。

```mermaid
sequenceDiagram
  participant C as Composer 组件
  participant S as store.messages
  participant A as api.chatSend
  C->>S: insertPending：完整 Message（含头像与牌面配色）+ 负数 local_id，不设 send_state
  C->>A: chat_send(roomId, content, emote?, reply?)
  A-->>C: ChatSendResult（或 IPC 错误对象）
  alt outcome = ok
    C->>S: 不动；等上游回播把权威字段换进同一行（local_id 照旧 ⇒ 节点不重建）
  else outcome != ok
    C->>S: markPendingRejected：send_state = "rejected" + send_reason（正文划线）
  else 传输层异常
    C->>S: 错误条 + markPendingUnconfirmed：send_state = "unconfirmed"
  end
  S-->>S: 8s 内没等到回播 → send_state = "unconfirmed"
```

| 规则 | 内容 |
|---|---|
| 挂载位置 | `messages` 尾部插入一条**完整 `Message`**：`local_id` 取负数（`-1`、`-2`、…，`pendingSeq` 自增）；身份字段取自 `session`（昵称 / uid）、当前生效账号（`face`）与 `roomIdentities[roomId]`（大航海 / 房管），**粉丝牌只在 `my_medal_worn` 为真时才算数**（持有 ≠ 佩戴，`protocol.md` A43）、**牌面真彩色取自本人上一条上游行**（`room_session` 不带它），`upstream_id=""`。**刻意不设 `send_state`** |
| 对账 | 上游回播到达时按 `matchPending` 判定：`uid` 相同 + 正文逐字相同（两侧都带 `emote` 时再比 `emoticon_unique`）+ `ts` 之差 ≤ `SEND_MATCH_WINDOW_MS`（**60000ms**）。参与范围 = 本地行（负数）且未判 `rejected`、且没被对上过（`echoedLocals` 侧表，行上一个字段都不写）；命中多条取列表里最靠前的一条。命中后**原位把字段换成上游那条、`local_id` 照抄本地那个负数**——净条数不变，React key 不变 ⇒ DOM 节点不重建 |
| 幂等 | 本地行与真实行的 `local_id` 永不碰撞（负数 vs 恒正），`onMessage` 的单调判定也不受影响；回播命中**不换号**，所以那条永远留在负数一侧（这也是 `echoedLocals` 必须存在的原因） |
| 超时兜底 | 插入时排一个 `SEND_CONFIRM_TIMEOUT_MS`（**8000ms**）的定时器：到点仍无 `send_state` → 置 `"unconfirmed"`（不删行，也不再假装它「发送中」）。只改仍无状态的那条 |
| `ok` | 命令返回 `outcome="ok"` 不动本地行；换字段完全交给上游回播（`danmubox://message`）。若回播先到，命中对账即已换好 |
| 被拒（`blocked_platform` / `blocked_room` / `rate_limited` / `medal_required` / `muted` / `failed`） | 一律 `outcome != "ok"` → 本地行置 `"rejected"`，`send_reason` = `sendOutcomeText(outcome, detail)`（**与浮片同一句**）：正文划线，行尾显示该句。行**不删**，草稿**保留**（用户 2026-09-13：「那行消失我希望能得到保留，划线并标注一下被 ban 的原因，便于我对照修改」） |
| 传输层异常 / IPC 错误（含本地节流 `RATE_LIMITED`） | `chat_send` reject → 错误条展示 `describeError`，本地行置 `"unconfirmed"`（**结果未知**：这条可能已经上屏，因此不划线、不判被拒）。重试由用户再次发送完成（新的一次乐观行） |
| 失败行渲染 | `"rejected"` → 正文划线（`.rejectedText`）+ 行尾写 `send_reason`；`"unconfirmed"` → 行尾「未确认」。**两档都不弱化整行**（要读得清）；其余行（含刚插入的本地行、回播换过字段的那条）**与「别的客户端看到的我」渲染逐项相同**——没有「发送中」这一档 |
| 草稿 | 只有 `ok` 清空草稿（并收起回复 / @ / 面板）；其余一律保留，便于重试或照着行上划掉的那条改写（`ui.md` §6.5.1） |
| 本地节流 | 发送前由 core 检查同房间 2s 最小间隔与相同内容 5s 去重（`contract.md` §4），命中则不发请求、直接 reject `RATE_LIMITED` |
| 生命周期 | 草稿**不在 store 里**：它是 `Composer` 模块级的 `Map`，键为 `${identityKey}:${roomId}`（游客 `guest`、登录为 uid），即**每个「身份 × 房间」各留一份**（正文 + 回复目标 + @ 目标）；退出组件不丢，进程重载即散，不落盘（状态形状见上，`AppStore` 里没有草稿字段）。切房间 / 切号时**先存旧键、再取新键**，面板类状态（面板 / 分组 tab / 右键菜单 / 改短语 / 浮片）一律重置。本地行随 `messages` 在一次房内会话内生死（离开 / 切房即清空），`echoedLocals` 侧表同时清空 |
| 安全 | 草稿内容不写入 `prefs.json`、不上报；日志只记 `content_len` 与 `outcome`（见 `architecture.md` §9.2） |

两档标记都必须与普通行可区分，且整行保持可读（不弱化）；样式 token 与文案表由 `ui.md` §4.4 / §6.5 定义。

## 8. 订阅生命周期与内存回收

| 阶段 | 动作 |
|---|---|
| 应用启动 | `bootstrap`：并行 `app_info` + `session_status` + `rooms_list` + `prefs_get` + `accounts_list`，再 `subscribeEvents` 订阅 §4 的 7 个事件名（每类 handler 可选） |
| 进入房间 | `openRoom`：清空 `messages` / 房管三块 / `lastSend`（**不删**该房间的身份快照）→ `history_query`（`limit: 0`）回填（落地前复核 `activeRoomId` 仍是它）→ `rooms_connect`；`seeding` 由**当下一代**收尾；`RoomView` 渲染时按登录态触发 `loadEmotes` / `loadOwnedEmotes` / `loadRoomIdentity` / `loadBalance` |
| 切换房间 | 只切 `activeRoomId` 并清掉上一间的 `messages` 与发送浮片；事件继续到达，非激活房间的弹幕直接丢弃（`onMessage` 判 `room_id`）。该房间的**身份快照保留**（切房不结束会话）、晚到的旧回包按目标复核后丢弃（见下表）。**界面本地状态同时重置**：`RoomView` 收起弹出面板 / 房管面板 / 菜单 / 举报条 / 房管确认条并清掉 @·回复目标，`MessageList` 随 `key` 重建、滚动与跟随回到初始；只有输入草稿按房间各留一份（`ui.md` §2.3、§6.5.1） |
| 切号（`account_switch` / 登出当前账号 / 删掉当前账号 / 扫码确认新账号） | 先清掉上一个身份的界面切片（`rooms` / `activeRoomId` / `messages` / `roomIdentities` / 房管三块 / `emotes` / `ownedEmotes` / `ownedLoaded` / `ownedError` / `balance` / `seeding` / `lastSend`）与所有房间定时器，再按新会话重拉 `rooms_list` 与 `follow_list`；core 侧各房间以新凭据重建连接（契约 §7 `account_switch`）。并发切号以**最后点击的那一代**为准（身份世代，见下表）。草稿按「身份 + 房间」分键，切号后不恢复（`ui.md` §2.2.1） |
| 离开房间（关标签 / 移除房间 / 断开连接） | 关标签 / 移除房间：清空 `messages`、清掉互动与发送定时器、删该房间 `roomIdentities`、清空房管三块。**断开连接**：同样删该房间 `roomIdentities` 与当前房间的房管三块（断开即这次会话结束，身份不再成立），但 `messages` 与本地待确认行的侧表不动 —— 重连时按 `(kind, uid, 正文, ts)` 去重（`alreadyListed`）。core 侧缓冲随会话结束销毁 |
| 手动重连 | 不触碰 store 切片；`rooms_reconnect` 后重拉 `rooms_list` 取连接态（快照按序号复核）。会话已被「断开连接」结束时 core 当场**重建**一次会话，身份随之重取并经 `danmubox://session` 覆盖（`session.rs`） |
| 应用卸载 / HMR | `bootstrap` 每次订阅前先 `unsubscribe?.()`；订阅函数由模块级变量持有，**不允许匿名 `listen` 后丢弃句柄**（热重载后会重复监听） |

### 8.1 乱序落地的复核（异步回包 vs 界面现状）

界面上的 `messages` / 房间列表 / 身份 / 表情库 / 房管三块都是**全局单份**，而读命令的回包可能晚于用户的下一次操作（切房、换人）。因此每个异步落地都要在写之前复核「这次结果属于的那一代 / 那个目标」是否还是当下的：

| 落地的东西 | 复核什么 | 不复核会怎样（审计 P65–P73） |
|---|---|---|
| `openRoom` 的 `history_query` 结果与 `seeding` 收尾 | `activeRoomId === roomId` | 连点 A→B 时 A 的历史整批写进 `messages`，B 的列表被换成 A 的；`seeding` 也被提前撤掉 |
| 每次 `rooms_list` 重拉（`connect` / `disconnect` / `refresh` / `addRoom` / `removeRoom` / `applySession`） | **快照序号**：发起时取号，落地时丢掉已被更新快照越过的那些（失败的请求不占号） | 晚到的旧快照把「已连接 / 会话条数」指回旧值，要等下一次事件才纠正 |
| 换人链路（`switchAccount` / `removeAccount` / `logoutAccount` / `pollAccountQr`）与 `refreshIdentity` / `applySession` | **身份世代**：换人时递增；取号在**命令之前**（按点击顺序，不按回包顺序） | 并发切号以后到的响应为准，账号列表的「当前」不是最后点击的那个 |
| `loadRoomIdentity` 的 `room_session` 结果 | 身份世代 | 晚到的旧凭据身份写进 `roomIdentities`，房管入口按上一个账号放行 |
| `loadEmotes` / `loadAdmin` 的结果 | `activeRoomId === roomId` | `emotes` 与房管三块是全局单份，写进去就是拿 A 的身份与名单渲染 B |
| `send` 的返回值与 `danmubox://send` 事件 | `ChatSendResult.room_id === activeRoomId` | B 的输入区弹 A 那条的失败浮片；`lastSend` 因此只在发出它的房间还在前台时才登记，切房即清 |

世代号与快照序号都是 `store.ts` 的**模块级计数器**（`identityEpoch` / `roomsSeq`）：不进 store 形状、不影响渲染，只在落地那一刻做一次比较。身份快照（`roomIdentities`）的生命周期因此是「一次房内会话」：**切房保留**（房间没断，切回来还是同一次会话），关标签 / 移除房间 / 断开连接 / 换人各自删它，换人另由世代号挡住旧凭据的回包。

内存边界：

| 项 | 上限 | 超出行为 |
|---|---|---|
| core 会话缓冲（权威，`history.buffer_rows`） | 见 `contract.md` §8 | 丢最旧；前端显示上限只影响渲染侧 |
| 前端 `messages` | `CLIENT_MESSAGE_CAP` = 2000 条 | 丢最旧 |
| 前端 `logs` | `LOG_CAP` = 200 行 | 丢最旧 |
| `emotes` / `ownedEmotes` | 无独立上限 | 随房间 / 会话变化整体替换；换人即清空（同 `ownedLoaded` / `ownedError` / `balance`） |
| 非激活房间 | 只丢弃弹幕事件 | 切回时按 `history_query` 重取（一次房内会话一份 `messages`） |

## 9. 新增一个 IPC 命令需要同步改哪些文件

以下路径均为当前实现路径（不再是规划路径）。

| # | 文件 | 改什么 | 是否必须 |
|---|---|---|---|
| 1 | `contract.md` §7 | 在命令清单里加入新命令名 | 必须（否则命令集合不闭合） |
| 2 | `crates/danmubox-core/src/ports.rs` | 若需要新引擎能力，先加端口方法（core 内部其余模块见 `architecture.md`） | 视命令而定 |
| 3 | `crates/danmubox-bili/src/**` | 实现对应端口（B 站侧请求与归一化只落在这里） | 视命令而定 |
| 4 | `apps/desktop/src-tauri/src/lib.rs` | 新增 `#[tauri::command]` 函数（参数与返回值按本文 §3 的类型，`ApiError` 从 `core::Error` 映射） | 必须 |
| 5 | `apps/desktop/src-tauri/src/lib.rs` | 把新命令加进 `tauri::generate_handler![…]` 注册表 | 必须 |
| 6 | `apps/desktop/ui/src/ipc.ts` | 在 `api` 上加方法；需要错误进日志的用 `call()`，写操作用裸 `invoke` | 必须 |
| 7 | `apps/desktop/ui/src/types.ts` | 请求/响应的 TypeScript 类型（保持 snake_case） | 必须 |
| 8 | `apps/desktop/ui/src/store.ts` | 对应的 store 动作与字段 | 视命令而定 |
| 9 | `ipc.md`（本文） | 命令签名表、载荷类型、store 动作表 | 必须 |
| 10 | `AGENT.md` | 「新增 IPC 命令」操作清单若与本表不一致则同步 | 必须 |

自检清单（提交前逐条确认）：

1. 命令名与 `contract.md` §7 字面一致，事件名未越出 §4 的七个；参数名前端 camelCase、Rust snake_case。
2. 错误只用 §2 的八个码，reject 值是 `{ code, message }`，`message` 不参与前端逻辑。
3. 新命令进了 `generate_handler!`；同步命令里不得用 `Handle::current()`。
4. 返回载荷不含凭据；载荷中的 `Message` 字段与 `contract.md` §5 完全一致，`kind` 不越出六种。
5. 若命令涉及历史，只读当前会话缓冲，不得引入跨会话查询或导出。

---

相关文档：`architecture.md`（分层、端口/适配器与并发模型）、`ui.md`（渲染与交互、虚拟列表、样式 token）、`auth.md`（扫码状态机与凭据）、`protocol.md`（协议与 `cmd → kind`、唯一校准表）、`contract.md`（文档基线契约）、`roadmap.md`（未开工项）、`testing.md`（测试与冒烟）、`decisions/0008-frontend-stack.md`（前端栈与状态管理）、`../AGENT.md`（作业规范与操作清单）、`../README.md`。
