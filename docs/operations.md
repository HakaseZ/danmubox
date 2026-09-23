# 运行与运维

## 1. 日常操作

### 1.1 启动与停止

| 平台 | 启动 | 停止 |
|---|---|---|
| macOS | 双击 `danmubox.app`（产出见 §1.6 / §5.3）；开发期两种运行方式见下 | 关闭窗口即退出（桌面端不做后台保活；Android 是例外，见 §2.8）；异常残留用活动监视器结束 `danmubox-desktop` |
| Windows | 开始菜单 / 桌面快捷方式，或运行安装目录下的 `danmubox.exe` | 关闭窗口即退出；异常残留用任务管理器结束 `danmubox.exe` |
| Android | 桌面图标，或 `adb shell monkey -p dev.kksk.danmubox -c android.intent.category.LAUNCHER 1` | 从最近任务划掉；彻底停止用「设置 → 应用 → danmubox → 强制停止」 |

应用为纯客户端形态，不启动任何本地网络服务：界面通过 Tauri IPC 与引擎通信，二者之间不需要任何访问凭据（`contract.md` §7）。三端打包与产物见 §5。

#### 桌面端运行方式（依赖 Vite dev server）

裸 `cargo run` / `cargo build` 产出的二进制**不加载内嵌前端**，而是走 `tauri.conf.json` 的 `build.devUrl`（`http://localhost:5173`）——判据是 `tauri` crate 的 `build.rs`：`dev = !custom-protocol`（仓库 `Cargo.toml` 未声明该 feature；`tauri build` 的产物加载 `tauri://localhost`，见 §1.6）。因此用裸 cargo 起应用**必须先起 Vite dev server**，否则窗口空白且不报错（只有 `webview 页面加载` 日志缺失）。

```bash
# 终端 1：前端 dev server（保持运行）
npm --prefix apps/desktop/ui run dev

# 终端 2：桌面端
cargo run -p danmubox-desktop
```

判断界面有没有真正加载（需要 `DANMUBOX_LOG=debug`）：

```bash
DANMUBOX_LOG=debug cargo run -p danmubox-desktop
# 正常应出现：webview 页面加载 url=http://localhost:5173/  →  IPC app_info
# 只看到 "web content process terminated" 而没有页面加载 → dev server 没起或端口不对
```

单独 `cargo build --release` **不会**产生可独立运行的产物：它同样走 `devUrl`，没有 dev server 时窗口全白，日志里既无 `webview 页面加载` 也无任何 IPC（A/B 记录见 `../AGENT.md` §9）。要独立产物见 §1.6，三端打安装包见 §5。

### 1.2 日志级别 `DANMUBOX_LOG`

| 级别 | 用途 |
|---|---|
| `error` | 只看致命错误 |
| `warn` | 错误 + 可恢复异常（重连、上游非 0 返回） |
| `info`（默认） | 连接生命周期、房间增删、登录状态变化 |
| `debug` | 协议收发包、解包、认证与会话细节；排障首选 |
| `trace` | 逐包逐字段，量极大，仅短时间开启 |

| 平台 | 设置方式 |
|---|---|
| macOS / Linux shell | `DANMUBOX_LOG=debug danmubox` 或 `export DANMUBOX_LOG=debug` 后从该终端启动 |
| Windows PowerShell | `$env:DANMUBOX_LOG="debug"; .\danmubox.exe` |
| Windows cmd | `set DANMUBOX_LOG=debug` 后启动 |
| Android | 移动端无 shell 环境变量注入路径，`DANMUBOX_LOG` 不适用；排障用 `adb logcat -s danmubox` 读取默认 `info` 级输出 |

日志出口：

| 出口 | 说明 |
|---|---|
| stdout / stderr | 前台运行时直接可见；桌面端 GUI 启动时 stdout 不可见，用下方重定向办法 |
| `danmubox://log` | Tauri IPC 事件，供前端调试面板订阅（`ipc.md` §4） |

桌面端**不写日志文件**：`apps/desktop/src-tauri/src/lib.rs` 的 `fmt_layer` 固定写 stderr（`.with_writer(std::io::stderr)`、`.with_ansi(false)`），需要留存时用下方重定向。

#### 桌面端调试日志落到文件

```bash
mkdir -p target/logs
DANMUBOX_LOG=debug cargo run -p danmubox-desktop 2>&1 | tee -a target/logs/app.log
```

日志**全量**覆盖前后端：Rust 侧 `tracing` 输出 + 界面里的 JS 错误。控制台桥在 `apps/desktop/src-tauri/src/lib.rs`（常量 `CONSOLE_BRIDGE` + 命令 `frontend_log`）：

| 环节 | 口径 |
|---|---|
| 注入 | 页面每次 `PageLoadEvent::Finished` 后 `webview.eval(CONSOLE_BRIDGE)` |
| 拦截 | 脚本改写 `console.error` / `console.warn`，并监听 `window` 的 `error` 与 `unhandledrejection` |
| 上报 | 脚本**直接**调 `window.__TAURI_INTERNALS__.invoke('frontend_log', { level, message })`（不经 `@tauri-apps/api`） |
| 落点 | `frontend_log` 按 level 写进 `tracing` 的 `danmubox::ui` target（`error` / `warn`，其余落 `debug`） |
| 限流 | `message` 截断到 **2000 字符**（去重键取前 200 字符）；同一条告警 **1s 内只上报一次**——防「渲染 → 告警 → 日志回推 → 重渲染」的反馈环 |

判断界面是否真的加载、是否出现异常循环：

| 日志 | 含义 |
|---|---|
| `webview 页面加载 url=...` | 页面真的导航了；**没有这条就是白屏**（多半是 dev server 没起） |
| `IPC app_info` | React 已挂载且 IPC 通了；正常是 2 次（StrictMode 双挂载） |
| `IPC xxx` 在短时间内反复出现 | 前端出现自激循环，是卡死的典型信号 |
| `ERROR danmubox::ui: ...` | 界面里的 JS 错误原文 |

`target/` 已在 `.gitignore` 中，日志不会被提交。

### 1.3 数据目录与文件位置（三端）

数据目录只放两类文件：凭据 `config.toml` 与偏好 `prefs.json`（含备份）。弹幕只在内存，不落盘（`contract.md` §4.3）。应用不往数据目录之外写任何文件。

| 平台 | 数据目录 | 典型内容 |
|---|---|---|
| macOS | `~/Library/Application Support/danmubox/` | `config.toml`、`prefs.json`、`prefs.json.bak` |
| Windows | `%APPDATA%\danmubox\` | 同上 |
| Android | 应用私有目录（绝对路径随系统与用户而异，以 `app_info` 返回值为准）；由外壳在启动最早期把 `DANMUBOX_HOME` 注入为 Tauri `app_data_dir()`，即应用私有 dataDir 本身、**不是**其下的 `files/` 子目录 | `config.toml`、`prefs.json`、`prefs.json.bak` |

- 数据目录本身**不含**弹幕内容：弹幕只在内存环形缓冲中保留（`contract.md` §4.3）。
- 查看实际数据目录：调用 `app_info`（返回版本、数据目录、构建信息；不含任何凭据值）。
- Android 上定位数据目录：

```bash
adb logcat -s danmubox                                          # 启动时打印数据目录
adb shell dumpsys package dev.kksk.danmubox | grep -i dataDir   # 辅助确认
```

不要在文档或脚本里硬编码 Android 的 `/data/data/...` 路径：设备用户、系统版本与分区方案都会影响实际位置。

### 1.4 凭据文件 `config.toml`：位置、权限与损坏处置

凭据以**明文 TOML** 存放，靠文件权限（`0600`）与「只在本机数据目录」约束，不加密（`contract.md` §4.1；需求 §2.5）。

文件形态（示例值全部为空串；多账号用 `[profiles.<name>]` 承载，`active_profile` 指定当前生效者）：

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
```

启动顺序：读文件 → 取 `active_profile` 指向的账号，其 `sessdata` / `bili_jct` / `dede_user_id` 三者齐全且非空则直接进入登录态；否则走扫码（唯一登录入口），扫码成功后原子写回目标账号（新增账号先按昵称起名，见 `auth.md` §8.4）。

#### 查看与权限确认

| 平台 | 查看内容 | 确认权限 | 修复权限 |
|---|---|---|---|
| macOS | `cat ~/Library/Application\ Support/danmubox/config.toml` | `ls -l` 应显示 `-rw-------`（只有属主可读写） | `chmod 600 ~/Library/Application\ Support/danmubox/config.toml` |
| Windows | 记事本打开 `%APPDATA%\danmubox\config.toml` | `icacls "%APPDATA%\danmubox\config.toml"` 应只见当前用户（SYSTEM / Administrators 可接受） | `icacls "%APPDATA%\danmubox\config.toml" /inheritance:r /grant:r "%USERNAME%":F` |
| Android | 无桌面式直接访问；文件位于应用私有目录，其他应用不可读 | 无需手工确认（应用私有目录即隔离边界） | 无需处理 |

安全提醒：`config.toml` 整文件等同账号控制权，**不要**贴进聊天、issue、日志或截图；排查时只看「哪个字段是否为空」，不要展示取值。

#### 损坏与重置（没有手工编辑路径）

界面与 CLI **没有**粘贴 Cookie 的入口（`contract.md` §4.1；需求 §2.5、§2.13），凭据文件由程序写回。

| 情形 | 行为 |
|---|---|
| `config.toml` **解析失败** | **删掉重建为空文件**（不备份），以**游客态**继续启动；界面表现为未登录，重新扫码即可恢复 |
| 读取 / 权限 / IO 失败 | 照旧报 `INTERNAL` 并终止启动（这几种失败无法自愈） |
| 文件不存在 | 按空配置处理，游客态启动 |

因此**不存在**「手工改文件修凭据」这条路：凭据失效就重新扫码（`auth.md` §8.4）。

#### 命令行入口

`danmubox-cli` 的账号相关子命令：

| 用途 | 命令 |
|---|---|
| 查看登录态 | `danmubox session`（只输出状态与当前账号名，**不含任何 Cookie 值**） |
| 查看账号列表 | `danmubox accounts`（当前账号打星；逐行给登录状态、昵称与 uid） |
| 扫码登录 / 新增账号 | `danmubox login [账号名]`（终端直接渲染二维码；不带账号名 = 新增账号，确认后按昵称自动起名；`--timeout` 可调） |
| 登出 | `danmubox logout [账号名]`（缺省 = 当前账号；只清凭据，条目保留） |
| 切换 / 删除账号 | `danmubox accounts --use <名字>`、`danmubox accounts --remove <名字>` |

界面与 CLI 的账号入口都只保留扫码与登出（需求 §2.5、§2.13）。

数据目录默认取平台路径（`paths::data_dir`）；调试或多环境并存时可用环境变量 `DANMUBOX_HOME` 覆盖，例如 `DANMUBOX_HOME=/tmp/db danmubox session`。

### 1.5 偏好文件 `prefs.json`

界面偏好只存 `prefs.json`（不写进 `config.toml`），形态是**单层 JSON 对象**，键为 `contract.md` §8 的唯一权威清单（如 `ui.font_scale`、`ui.theme`、`ui.gift_in_danmaku`、`ui.gift_panel`、`filter.kinds`、`history.buffer_rows_danmaku`）。只存被显式改过的键，缺失的键回落到默认值（`contract.md` §4.2）。

```json
{
  "ui.theme": "dark",
  "ui.gift_in_danmaku": false,
  "ui.gift_panel": true,
  "history.buffer_rows_danmaku": 8000,
  "history.buffer_rows_interact": 300
}
```

| 操作 | 方法 |
|---|---|
| 查看 | 直接打开数据目录下的 `prefs.json`（`cat` / 记事本） |
| 修改 | 优先用界面（走 `prefs_set`）；手工编辑时先退出应用，改完保存为合法 JSON |
| 重置 | 退出应用后删除 `prefs.json` 与 `prefs.json.bak`，下次启动全部回落默认值 |

| 情况 | 行为 |
|---|---|
| 文件缺失 | 按默认值启动 |
| 单键缺失 | 该键取默认值，其余键照常生效 |
| 未知键或非法值 | 键清单以 `contract.md` §8 为准，清单外或类型/范围不符的键不参与生效值合成；建议只通过界面修改 |
| 已删除键的残留 | `ui.system_notice` 已删除（门并进 `filter.kinds` 白名单）：读文件时按它的值物化进 `filter.kinds`（`false` → 去掉 `system`；`true` → 补上），该键本身随即失效，下次写入后从文件里消失。`ui.gift_panel_mode` 同理已删除、由 `ui.gift_in_danmaku` / `ui.gift_panel` 两枚开关取代：读文件时按旧值物化（`separate` → `false` / `true`；`merged` → `true` / `false`），文件里已显式写了新键的那一枚以文件为准。其余已删除键（如 `filter.keywords*`）只是被忽略 |
| JSON 解析失败（损坏） | 按默认值启动，并把损坏副本保留为 `prefs.json.bak` |
| 正常写入 | 原子替换（临时文件 + rename），不会出现写一半的半成品文件 |

### 1.6 独立产物（不依赖 dev server）

```bash
# 仅需一次：安装 Tauri CLI（注意绕开 ~/.npm 里 root 所有的缓存目录）
npm --prefix apps/desktop/ui i -D @tauri-apps/cli --cache /tmp/npm-cache-danmubox
# 构建（`beforeBuildCommand` 会自动先构建前端；产物落在 target/release）
cd apps/desktop && ./ui/node_modules/.bin/tauri build --no-bundle
```

产物是 `<repo>/target/release/danmubox-desktop`（约 13 MB），**前端已内嵌**：日志里页面加载的 URL 是 `tauri://localhost` 而不是 `http://localhost:5173`，因此不需要再起 Vite，双击即可运行。

`tauri.conf.json` 当前 `bundle.active=false`（图标已由共享的 `bundle.icon` 提供：`icons/icon.png` / `icons/icon.ico` / `icons/icon.icns`），所以这一步不产出 `.app` / `.dmg` / APK；要出安装包**不用**改这一项：macOS 的 `.dmg` 直接加 `--bundles dmg` 即可（`--bundles` 覆盖 `bundle.active`）。三端步骤与产物见 §5.3，`icon` 口径见 §5.3「图标与 `bundle.icon` 的口径」。

## 2. 故障排查决策树

### 2.1 总览

排障顺序固定为：**登录状态 → 连接状态 → 业务行为**。先确认界面上的登录态与房间连接状态，再进对应小节（认证与扫码见 2.2 / 2.7，连接见 2.3 / 2.5，发送见 2.4，Android 白屏见 2.6）；需要细节时开启 `DANMUBOX_LOG=debug` 复现一次，读日志与 `danmubox://log` 事件。Android 上「退到后台之后」的行为（前台服务保活、那枚常驻通知、电池优化白名单）见 2.8；后台能挂多久、丢弹幕与切网断连的判定见 2.9。

### 2.2 认证失败

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 登录态（`session_status` / 界面） | 显示未登录 → 先扫码；凭据文件由程序管理，没有手工改文件这条路（§1.4） |
| 2 | 认证回应是否 `code=0` | `code=0` 为成功；非 0 一律视为认证失败，按重连退避处理，日志保留原始 code，**不得**在未知 code 上编造含义 |
| 3 | 是否游客模式 | 游客 `uid=0`、`key=""` 属预期；游客能力受限（昵称掩码、字段缺失），不代表故障 |
| 4 | `SESSDATA` 是否过期／失效 | 凭据过期 → 重新扫码（凭据文件由程序管理、损坏即重建，§1.4） |
| 5 | WBI 签名相关报错 | 说明签名实现或系统时间异常；先校准系统时间，再查 `auth.md` 的签名步骤 |
| 6 | 换房间是否同样失败 | 全房间失败 → 账号级问题；单房间失败 → 房间级问题（房间号、权限、风控） |

### 2.3 连不上 WS

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 房间连接状态（界面房间头 / `danmubox://status` 事件） | 未发起连接 → 触发 `rooms_connect`；已连接 → 问题在收包不在连接 |
| 2 | `room_id` 是否为真实房间号 | 短号 / URL 必须先经 `getRoomPlayInfo` 解析为真实 `room_id`；解析失败说明房间输入不合法 → 重新添加房间 |
| 3 | 日志是否出现 `getDanmuInfo` 失败 | 该接口需 `buvid3` 与 WBI 签名，未登录时易失败 → 见 2.2 |
| 4 | 是否出现认证回应 `op=8` 且 `code != 0` | 认证未通过，按重连退避处理；记录原始 code，见 2.2 |
| 5 | 是否反复重连且间隔递增 | 退避为 5s / 10s / 20s / 40s / 60s 封顶（`contract.md` §4），属预期行为；持续不成功则查网络与上游可用性 |
| 6 | 网络环境 | 代理 / 防火墙 / 公司网络拦截 WebSocket → 换网络验证 |
| 7 | 全部正常仍无消息 | 房间可能未开播（`live_status=0`）→ 换一个正在直播的房间交叉验证 |

### 2.4 弹幕发送失败

发弹幕返回 `SendOutcome`（`contract.md` §5），必须先看它、再看界面表现。前端是**乐观渲染**：点下发送就已经把你那条画在列表里了，因此**不要**以「界面上出现过」判定发送成功 —— 判定只看 `SendOutcome`。没发出去的那条会**留在列表里标成被拒**（正文划线 + 行尾写上游给的原因，`ui.md` §4.4），草稿保留可改再发。

| `SendOutcome` | 判定依据 | 含义与动作 |
|---|---|---|
| `ok` | 上游返回成功 | 已进入公开弹幕流；若直播间看不到，多为房间侧延迟或屏蔽，换账号/换视角复核 |
| `blocked_platform` | 上游响应 `msg` / `message` == `"f"` | 命中平台那份**全局屏蔽词**（界面文案「发送失败 · 全局屏蔽词」），**不是**普通错误码；内容会回显在 `data.mode_info.extra`（JSON 字符串）的 `content` 字段。改写内容后重试，勿连点 |
| `blocked_room` | 上游响应 `msg` / `message` == `"k"` | 命中本直播间的**房间屏蔽词**（主播 / 房管配的那张表，即房管面板第三块；界面文案「发送失败 · 房间屏蔽词」）；内容同样回显在 `data.mode_info.extra.content`。换房间验证，属房间侧设置 |
| `rate_limited` | 上游对应错误码 | 频率限制：同房间最小间隔 2s，相同内容 5s 内去重。等待后重试，不自动重发 |
| `medal_required` | 上游对应错误码 | 粉丝牌等级不足：需先在本房间达到要求等级 |
| `muted` | 上游对应错误码 | 已被禁言（全局或直播间）：等待解禁或换账号，重试无用 |
| `failed` | 兜底 | 其他失败，带原始 code 与 message，读原文再判断 |

区分要点：

- `blocked_platform` / `blocked_room` 是「上游看似成功、实际被吞」，判据是响应 `msg` / `message` 的字面量 `f` / `k`，不能只看顶层 `code`。
- `rate_limited` / `medal_required` / `muted` 走的是上游错误码路径，语义互斥；禁言与等级不足都是**重试无用**，只有频率限制值得等待后重试。
- 内容本身（空白、超长、含被平台拦截词）也会落进 `blocked_platform`，先改写内容再判断是否为风控。

### 2.5 连接卡住或推流中断（房间内「刷新」）

现象：房间仍显示已连接，心跳未断开，但弹幕长时间不再到达；或主播推流暂时中断后又恢复。

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 | 点击房间内的「刷新」按钮 | 触发 IPC `rooms_reconnect`，手动发起一次重连（`contract.md` §7） |
| 2 | 观察是否恢复收弹幕 | 重连会重新走 `getDanmuInfo` 换取新的连接地址与认证参数 |
| 3 | 确认缓冲未被清空 | `rooms_reconnect` **不清空**已收缓冲，仍属同一次房内会话；已渲染的行保留 |
| 4 | 仍无消息 | 检查是否未开播（`live_status=0`）或上游不可用 → 换房间 / 换网络交叉验证 |

说明：自动重连退避（5s / 10s / 20s / 40s / 60s）只在检测到连接断开时触发；「连接还在、就是不推数据」这类卡住状态检测不到，因此提供手动重连入口。

### 2.6 Android WebView 白屏

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | `adb logcat` 是否有进程启动输出 | 无输出 → 应用闪退，先解决崩溃 |
| 2 | 启动日志与 `danmubox://log` 事件是否正常 | 正常 → 问题在前端渲染，不在引擎 |
| 3 | Android System WebView 组件版本 | 过旧或已禁用 → 在系统应用管理中更新 / 启用「Android System WebView」 |
| 4 | 前端资源是否随包 | 打包遗漏或路径错误 → 重新构建前端后重新打 APK（见 §5.3） |
| 5 | 是否只在特定页面白屏 | 定位到具体组件；核心逻辑在 Rust，UI 属渐进增强（见 `architecture.md`） |
| 6 | 换设备是否复现 | 单设备复现 → 设备侧 WebView 环境问题 |

### 2.7 扫码不刷新

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | `account_qr_start` 是否成功拿到二维码 | 失败 → 先解决网络 / 上游问题，读错误信息 |
| 2 | `account_qr_poll` 是否在持续轮询 | 前端未轮询 → 检查轮询定时器；建议间隔 2 秒，不得低于 1 秒 |
| 3 | 二维码是否过期 | 过期后必须重新生成二维码，不能继续轮询旧 key |
| 4 | `data.code` 语义 | 已知状态按 `auth.md` 的状态机处理；**未知码归入「其他 → 按未确认处理」**，继续轮询，不要猜含义 |
| 5 | 扫码成功后会话是否刷新 | 成功后登录态应变为已登录——界面重拉 `session_status` 即为已登录（`danmubox://session` 只推房内身份，`contract.md` §7） |
| 6 | 手机与电脑的端 | 在 Android 端扫码是「同机扫屏」，请用另一台设备显示二维码或截图后扫码 |

### 2.8 Android 退到后台就不再收弹幕 / 那枚「正在接收弹幕」通知

**先把两件事分开**——它们经常被当成一件事：

| 环节 | 谁会把它掐掉 | 本项目的对策 |
|---|---|---|
| 进程被系统回收 / 冻结 | 内存压力下的 low-memory killer、App Standby | **前台服务** |
| 网络被掐 | Doze（屏幕关、设备静止、未充电） | **只能靠电池优化白名单**（见下），前台服务管不了 |

**是什么**：`gen/android/app/src/main/java/dev/kksk/danmubox/KeepAliveService.kt` —— 一个**只做一件事**的前台服务：挂一枚常驻通知，把本进程的优先级顶到「前台服务」档，让系统在后台/内存紧张时优先回收别的进程。它**不轮询、不上报、不持唤醒锁、不碰网络**：弹幕连接本来就跑在**本进程的 Rust 侧**（tokio），被系统限流的只有 WebView 的定时器与渲染，所以这里没有任何需要替 Rust 侧做的事。

**什么时候起、什么时候停**（全在 `MainActivity`）：

| 时机 | 动作 | 锚点 |
|---|---|---|
| 退到后台（`onStop`，HOME / 切到别的应用）**且页面答「还有活跃连接」** | 起 | `MainActivity.onStop` → `askPageForActiveConnection()` → `KeepAliveService.start()` |
| 回到前台（`onStart`，点通知 / 点图标 / 从最近任务切回） | 停，通知同时消失 | `MainActivity.onStart` → `KeepAliveService.stop()` |
| 应用内退出（根页面按返回 → `finish()`） | **不起**（`isFinishing` 早退） | `MainActivity.onStop` |
| 把任务从最近任务里划掉（`onTaskRemoved`） | **停**，不留通知 | `KeepAliveService.onTaskRemoved` |

- 「有没有活跃连接」是问页面（`window.__danmuboxHasActiveConnection()`，与返回手势同一套 JS 桥，见 `apps/desktop/ui/src/keepalive.ts`）——判据复用界面已有连接状态（`connected` / `connecting`，退避重连中也算「活跃」），外壳不自己造状态。**没开过房间就不会有通知**。
- 服务返回 `START_NOT_STICKY`：进程被系统杀掉后不自动重来。
- 通知渠道 `danmubox-keepalive`、通知 id 1、文案 `正在接收弹幕` / `点按回到应用`（`gen/android/app/src/main/res/values/strings.xml` 的 `keepalive_notification_*`）。文案静态，**不含房间号 / 昵称 / 账号 / 弹幕内容**（通知栏是锁屏可见面，见 §3）。

**怎么关掉它**（三条路，任选）：

1. 点通知回到应用 —— 回到前台即停；
2. 通知抽屉下拉到底的「正在运行的应用」（Task Manager，Android 13+）→ 对应的 Stop 按钮 —— 这条路会停掉**整个应用**；
3. 系统设置 → 应用 → danmubox → 强行停止。

通知本身是 `ongoing`（划不掉）——但 Android 14 起系统允许用户直接划掉**前台服务**的通知（划掉只是通知消失，服务照跑），这一档由系统决定、不由应用决定。

**会不会耗电**：前台服务本身几乎不额外耗电——它不做事、不唤醒 CPU；真正的开销是那条本来就存在的 WS 长连与心跳（回到前台也一样耗）。它的作用只是「让系统别把这进程回收掉」。

**要不要开电池优化白名单**（设置 → 电池 → 电池优化 → 找到 danmubox → 不优化）：

- **前台服务并不豁免 Doze**。屏幕关掉、设备静止、未充电进入 Doze 后，系统暂停应用的网络访问，长连接会断；断开后靠已有重连退避（5/10/20/40/60s，见 §2.3）恢复，能接上的窗口很窄。
- 把应用加进白名单（官方叫「部分豁免」）之后，Doze 与 App Standby 期间**仍可用网络、可持 partial wake lock**——这才是「关屏也要一直收」真正的开关。
- 所以：只在「切出去一会儿再回来」用，可以不开；要**关屏持续收**，就得开。
- 本应用**不会**弹窗要这个权限（官方那张「可接受用途」表里即时通讯类明确不推荐用 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 直接要）——需要时自己去设置里加。

**通知权限（Android 13 / API 33 起）**：常驻通知要 `POST_NOTIFICATIONS`，它是**运行时**权限，冷启动时问一次（`MainActivity.requestNotificationPermission`；拒过一次就不再自动弹，免得每次启动都被弹窗堵住）。**拒绝不影响保活**：前台服务照起、进程照顶前台档，只是**通知抽屉里看不到那条通知**（系统行为：这类通知会退回「正在运行的应用」里显示），用户照样能在那里停掉它。

**6 小时额度（Android 15 / API 35 起，且 targetSdk ≥ 35；本项目 `targetSdk 36`）**：`dataSync` 这个前台服务类型每 24 小时只有 **6 小时**总额度。到点系统回调 `KeepAliveService.onTimeout()`，代码里立刻 `stopSelf()`——**不这么做进程会被系统以 `RemoteServiceException` 崩掉**。额度用尽后**再起**服务会被拒（`ForegroundServiceStartNotAllowedException`；`KeepAliveService.start()` 接住、只记一条 logcat，表现为「这次不保活」，不崩）；用户把应用带回前台会重置计时。

**厂商 ROM**：以上都是 AOSP 行为。国产 ROM（MIUI / EMUI / ColorOS / OriginOS 等）另有自己的后台管理，可能忽略前台服务、锁屏后清理、或要求单独开「自启动 / 后台运行」白名单——**真机未验证**（`testing.md` §10.5 的口径；待验项见 `roadmap.md` §2）。

**已实测的结论**（本地 AVD，android-35 / arm64-v8a / 带签名 release 包；命令与原始读数归 `../CHANGELOG.md` 归档区）：

| 场景 | 结论 |
|---|---|
| 退到后台 ≈200 秒 | 进程在、前台服务在（`uidState: FGS`）、常驻通知在；保活前的旧包同一档到 443 的连接归零 |
| 点常驻通知回前台 | 服务与通知都消失、pid 不变 |
| 连续两轮「HOME → 回前台」 | 无累积、无重复启动 |
| 没有任何房间时按 HOME、开着房间但根页面按返回退出 | 都**不起**服务、无通知、logcat 无 keepalive 行 |
| 通知权限冷启动 | 正常弹系统弹窗，点 Allow 后 `granted=true` |
| 把 6 小时额度缩到 60 秒（`FGS_INTRODUCE_TIME_LIMITS`） | `onTimeout()` → 自停是**优雅收工**：`RemoteServiceException` / `FATAL EXCEPTION` 均 0 次 |

**边界**：这条 A/B 证到的是「进程不被冻结到连重连都做不了」，**不是**「连接永远不断」（同一档拉到 7 分钟后 WS 那条仍会掉）；模拟器区分不出真机省电 / 内存压力下的收益。

**排查**：

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 通知抽屉里有没有「正在接收弹幕」 | 没有 → 先看 2、3；有 → 保活已在工作 |
| 2 | `adb shell dumpsys activity services dev.kksk.danmubox` | 没有 `KeepAliveService` → 退到后台那一刻**是否真有活跃连接**（没房间、刚断线都不会起），以及 `adb logcat -s danmubox-keepalive` 里有没有 `系统不允许在此时启动前台服务`（= 后台起前台服务被拒 / 6 小时额度用尽） |
| 3 | `adb shell dumpsys notification --noredact \| grep -i danmubox` | 渠道 `danmubox-keepalive` 在、通知不在 → 十有八九是 `POST_NOTIFICATIONS` 没给 |
| 4 | 通知在、但长连接断了 | 不是保活的问题，是 Doze 掐了网络 → 加电池优化白名单 |
| 5 | 连接反复重连 | 退避属预期（§2.3）；持续不成功查网络与上游可用性（`protocol.md` §13） |
| 6 | 后台/切网之后「丢了一段弹幕」、恢复要多久 | 见 §2.9 |

### 2.9 后台能不能挂 7×24 / 安卓后台丢弹幕 / 切网断连

**结论**：三端都**不能承诺 7×24**（Android 最弱：那枚前台服务只保「进程」、不保「网络」）；后台丢弹幕丢的不是某一条，而是**一次断连的整个窗口**，而客户端**没有任何补拉机制**能把它找回来；切网后恢复最坏约 2 分钟量级。

| 症状 | 判定 | 动作 | 锚点 |
|---|---|---|---|
| 想「挂 7×24」 | 三端都不保证 | 桌面端「开着窗口一直放」是可行用法，但「一条都不断」不能承诺——上游本身会常态轮换断开（`protocol.md` A24）；Android 侧除 §2.8 的电池优化白名单与 6 小时额度外，真机收益未验证 | `protocol.md` A24；§2.8 |
| 安卓退到后台再回前台，「最新的一部分弹幕看不到」 | 丢的是断连窗口**整段**，且永久丢 | 先按 §2.8 的排查表确认服务与通知是否在；丢的时刻见下一条 | 根因 L2（没有补拉）：`crates/danmubox-core/src/session.rs:263-272`、`:283-305` |
| 想知道「什么时候丢的」 | 丢的时刻 = 断连时刻 | 只看日志：`距上次入站帧已 …ms（阈值 90000ms），判定连接僵死` 或 `连接中断，准备重连`（Android 用 `adb logcat -s danmubox`，桌面端见 §1.2 的落文件办法）；不看界面表现 | `crates/danmubox-bili/src/ws.rs` 的 `inbound_stale`；`protocol.md` §8.1 |
| 回前台后多久恢复 | 判死最坏 90 秒 + 一次退避 5–60 秒 + 票据/握手/认证，**没有「立刻重连」这一档** | 要更快只有手动「刷新」（`rooms_reconnect`，§2.5） | `ws.rs:81`（90s）、`:845` / `:858`（退避、封顶 60s）、`:47`（候选拨号 10s）、`crates/danmubox-bili/src/http.rs:197-203`（票据 15s） |
| 切网后断连、恢复慢 | 确认会断：客户端没有网络变化感知，也没有 TCP keepalive，心跳 `op=2` 写进内核缓冲照样算「发送成功」 | 判死只能靠「入站静默」：对端 RST / close 是秒级，半开最坏 90 秒；恢复时长 = 判死 ≤90s + 退避 5–60s（±20% 抖动）+ 票据 ≤15s + 拨号 ≤10s/候选 + 认证 ≤10s | `ws.rs` 的心跳任务只看写端返回；`ws.rs` 三条读侧收场 |
| 反复重连几次后**彻底不再自动重连** | 连续 3 次「认证超时」（拨号成功但 10 秒内没有 `op=8`）即停自动重连 | 界面停在「连续 3 次认证失败，已停止自动重连；手动刷新可重置」→ 点「刷新」；取票据失败 / 拨号失败**不计入**这个计数 | `ws.rs` 的认证超时计数；单测 `auth_timeout_is_a_failure_and_backs_off` |
| 房间看着「已连接」却再也不进来弹幕（点过「断开连接」再点「刷新」之后） | 会话被**重建**（不是重连）：新 `MessageSink` 的 `local_id` 从 1 重来，界面那条单调判定把每一条新弹幕都丢掉 | **返回列表再进房**即恢复（`openRoom` 会用 `history_query` 整批覆盖）；本条为代码判定，未在设备上复现该操作序列 | `crates/danmubox-core/src/bus.rs` 的编号起点；`crates/danmubox-core/src/session.rs` 的重连路径；`apps/desktop/src-tauri/src/lib.rs` 的会话重建；`apps/desktop/ui/src/store.ts` 的单调判定与 `history_query` 覆盖 |

**为什么补不回来**（根因三层，缺一不可）：

| 层 | 事实 | 锚点 |
|---|---|---|
| L1 连接确实会掉 | 退到后台约 7 分钟后那条 WS 已经不在了（同刻设备上别的应用仍持有到 443 的连接，说明不是设备断网）；上游本身也常态轮换断开 | §2.8 的实测结论；`protocol.md` A24 |
| L2 **掉了以后没有补拉**（根因所在） | 进场回填 `LiveSource::recent` **只在会话开始时调一次**；在那之后的重连只是重新 `stream()`，不再取任何历史 | `crates/danmubox-core/src/session.rs:263-272`（回填在 `loop` 之前）、`:283-305`（重连只换子取消信号再 `stream`） |
| L3 回前台**没有「立刻重连」这一档** | 判死靠 90 秒入站静默，判死后还要等一次退避（5–60 秒，带 ±20% 抖动），再接票据 + 握手 + 认证 | `ws.rs` 的 `inbound_stale` 与退避 |

上游也没有可翻页的回放：`dM/gethistory` 只给最近 **10 条**（`data.room`）且**不可翻页**（`protocol.md` A30），游客态全空——协议层面就补不上；而现在的重连路径连这 10 条都不捞。

**会丢与不会丢**（逐环节判定，排除项一并列出）：

| 环节 | 判定 | 锚点 |
|---|---|---|
| WS 断连窗口内的推送、重连之后的「漏帧」 | **会丢**，且永久（上游不给回放） | L2 |
| 本地内存缓冲上限 / 广播总线 / 前端显示上限 | **不会**丢「最新」——超限丢的是**最旧**，方向与「最新一段看不到」相反 | `session.rs` 的 `push` → `pop_front`；`bus.rs` 的广播槽；`apps/desktop/ui/src/store.ts` 的显示上限 |
| 去重 / 合并 | **不会**吞新内容（只挡「同一条的第二份」） | `bus.rs` 的指纹窗口 |
| 同一次会话内的重连 | **不会**丢（`local_id` 跨重连连续不回退） | `session.rs:283-306`（复用同一 `MessageSink`）；单测 `reconnect_keeps_the_session_numbering_monotonic` |
| 事件转发到界面时丢事件 | 落后只记一笔 `Lagged`，丢的是**旧**事件；界面重进房间会用 `history_query` 整批覆盖——但界面自己**不会**在回前台时重拉 | `apps/desktop/src-tauri/src/lib.rs` 的 `Lagged`；`store.ts` 的 `history_query` 覆盖 |
| 安卓把进程冻结 / 回收 | 前台服务覆盖这一档（覆盖不了网络被掐） | §2.8 |
| 认证失败上限 | 停自动重连，需人工「刷新」 | `ws.rs` 的认证超时计数；单测 `auth_timeout_is_a_failure_and_backs_off` |

**未验项**（别当结论用）：真机（尤其国产 ROM）退到后台期间到底还在不在收弹幕、白名单能否整夜收、macOS 最小化 / 被遮挡时 App Nap 是否拖慢 tokio 计时器、真机切网是否真连出 3 次认证超时、webview 后台被节流时 Rust→JS 事件是否积压。前两项见 `testing.md` §10.5，待办清单见 `roadmap.md` §2。

**怎么把它变成实测**：按 `testing.md` 的 A-5 / A-9 走 —— HOME 之前先 `adb shell ss -tnp | grep :01BB` 记下那条 WS，退到后台后每 30 秒采一次同一命令（`ss` 输出为空即那条长连已经不在了），回到前台后用另一台设备比对该窗口的弹幕：对不上即后台确实没在收（A-9 的 ② 给的是同一判据的另一条路径）。

## 3. 日志与敏感信息脱敏规则

安全红线（`contract.md` §4.1 原文，必须原样遵守）：

> `SESSDATA`、`bili_jct`、`DedeUserID` **不得**进日志、不得进前端明文、不得进仓库、不得进崩溃上报。

工程约定（在红线之上补充的执行细则）：

| 对象 | 规则 |
|---|---|
| `SESSDATA` / `bili_jct` | 永不打印明文；日志里只允许出现「已设置 / 未设置」这类布尔事实 |
| `DedeUserID` | 属可识别标识，日志中以掩码或长度描述代替 |
| 用户标识（`vmid` / `uid` / `uids[]` / `mid` / `reply_mid` / `anchor_id` / `tuid`） | 与 `DedeUserID` 同口径：日志、错误文案里一律以 `***` 代替。`vmid` **就是**自身的 `DedeUserID`，`uids[]` 是关注的人——实测二者会随请求 URL 一起进 `debug` 日志（`x/relation/followings?vmid=…`、`Room/get_status_info_by_uids?uids[]=…`）。脱敏后仍看得出「哪个接口、哪个房间、第几页、这一批几个值」 |
| 昵称 / 用户名（`uname` / `nickname`） | 与 uid 同口径：以 `***` 代替（上游把请求原样回显时才有值可抹） |
| 房间号 / 短号 | 日志里**不**脱敏：公开信息，且是排障主键；但要意识到「房间 ↔ 主播」本身是公开可查的关联。**无例外**：脱敏只按这张表执行，不因外发对象另加一档 |
| `config.toml` | 整文件视同凭据，不截图、不外发、不进仓库 |
| `Cookie` 请求头 | 打印请求时必须整体省略该头，不允许「截断显示前 6 位」这种折衷 |
| 二维码 key | 短时有效但视同凭据：分享日志前先替换 |
| `buvid3` / `buvid4` | 设备标识，与账号凭据同时出现可被关联；日志中以掩码或长度描述代替 |
| 弹幕内容 | 属用户数据，默认不进 `debug` 日志；需要时临时开启更高级别并按脱敏后外发 |

实现方式（改规则只改这一处）：键名表与替换逻辑在 `crates/danmubox-bili/src/redact.rs`，只改写「键名 + 分隔符 + 值」三种成分齐全的地方（上游原话 `CSRF 校验失败` 这类不带分隔符的文本保持原样）。出口只有两个，都在 `crates/danmubox-bili/src/http.rs`：`log_request`（所有 `GET` / `POST` 的 URL 日志）与 `upstream`（上游错误文案——`reqwest::Error` 的 `Display` 会把完整 URL 拼进去）。回显上游 `message` 的几处（`admin` / `send` / `report`）调的是同一个函数。占位符固定 `***`，不用短哈希。

> `danmubox::raw`（`protocol.md` 附录 B.1）是唯一的例外：它按设计打印**原始业务载荷**，供协议字段校准用，里面自然带得到发言人的 uid 与昵称。核对字段时用它，分享日志前必须先按上面的规则表处理；只想看普通调试信息时别把这个 target 打开。

分享日志前的自查命令：

```bash
grep -niE 'sessdata|bili_jct|dede_user_id|dedeuserid|buvid3|vmid=|uids%5[Bb]%5[Dd]|anchor_id|tuid=' <日志文件或日志目录>   # 命中即先替换再外发
```

脱敏是否生效（**空输出 = 没有明文标识**）：

```bash
grep -nE '(vmid|uid|anchor_id|tuid)=[0-9]' <日志文件>   # 值为 *** 的行不会命中
```

提交仓库前：确认无 `config.toml`、无 keystore、无 `.p12`、无导出的 Cookie 文本。

## 4. 卸载与残留清理

卸载前务必确认：`config.toml` 含账号控制权凭据，删除或卸载即**永久丢失**，重装后需重新扫码（§1.4）。

### 4.1 macOS

| # | 残留位置 | 清理方式 |
|---|---|---|
| 1 | `/Applications/danmubox.app` | 拖入废纸篓 |
| 2 | `~/Library/Application Support/danmubox/` | `rm -rf`（含 `config.toml`、`prefs.json`、`prefs.json.bak`） |
| 3 | 隔离属性 | 无需处理，随文件删除 |
| 4 | 登录项 / LaunchAgents | 本项目不注册，无需处理 |

### 4.2 Windows

| # | 残留位置 | 清理方式 |
|---|---|---|
| 1 | 程序本体 | 「设置 → 应用 → 已安装的应用 → danmubox → 卸载」 |
| 2 | `%APPDATA%\danmubox\` | 删除（含 `config.toml`、`prefs.json`、`prefs.json.bak`） |
| 3 | WebView2 用户数据目录 | 位于 `%LOCALAPPDATA%\` 下的应用目录，具体目录名以生成的 exe / 包标识为准；删除后下次启动重建 |
| 4 | 卸载残留的安装目录 | 若卸载后仍有空目录，手工删除 |

### 4.3 Android

| # | 残留位置 | 清理方式 |
|---|---|---|
| 1 | 应用本体 | 长按图标卸载，或 `adb uninstall dev.kksk.danmubox` |
| 2 | 应用私有数据 | 随卸载自动清除（含 `config.toml`、`prefs.json`）；只想清数据不卸载 → 「设置 → 应用 → danmubox → 存储 → 清除数据」 |
| 3 | 开发机上的签名材料 | **不要删除**：`apps/desktop/src-tauri/gen/android/keystore.jks` 与同目录的 `keystore.properties`。两者被 `gen/android/.gitignore`（`*.jks` / `keystore.properties`）忽略，且**不在 `.android-env/` 内**，所以 `scripts/android-env.sh clean` 删不到它们；清工具链时**别手工把它们一起删掉**，丢了只能卸载重装（§5.7、§5.12） |
| 4 | 设备上的安装包 | 手工删除此前 `adb push` / 传输的 APK |

### 4.4 卸载检查清单

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 无进程残留 | 三端均无 `danmubox` 进程 |
| 2 | 无数据目录残留 | §1.3 列出的路径均已清理 |
| 3 | 凭据文件已删 | `config.toml` 不再存在（含备份副本） |
| 4 | 重装可用 | 重新安装后能正常启动；因凭据已随文件删除，需重新扫码（凭据文件由程序管理，§1.4） |

## 5. 构建与分发

### 5.1 范围与前提

| 项 | 约定 |
|---|---|
| 分发范围 | **自用，不对外分发**：产物只装自己的设备 |
| 目标平台 | macOS / Windows / Android（iOS 与折叠屏适配为后期 enhancement，本期不实现，见 `REQUIREMENTS.md` §4） |
| 不做 | 自动更新、推送分发（后台保活在 Android 是例外，见 §2.8） |
| 包标识 bundle id | `dev.kksk.danmubox`，三端统一（`contract.md` §1） |
| 前端产物 | `apps/desktop/ui/` 由 Vite 构建并内嵌进 Tauri 应用（React + TS，见 `architecture.md`） |
| 引擎 | `danmubox-core`（Rust），薄封装见 `architecture.md` |

### 5.2 `<target-dir>` 的定义

Rust 产物目录在 workspace 下由 Cargo 决定，以下统一用 `<target-dir>` 表示，避免硬编码：

| 场景 | `<target-dir>` |
|---|---|
| workspace 统一 target（默认，`target-dir` 未覆盖） | `<repo>/target` |
| `apps/desktop/src-tauri` 使用独立 target 目录 | `<repo>/apps/desktop/src-tauri/target` |
| 显式指定平台 target 时 | 上述目录下的 `<triple>/release/...` |

默认情形下 §1.6 的独立产物落在 `<repo>/target/release/danmubox-desktop`。

`<version>`：§5.2–§5.13 产物名里的版本段，一律取 `apps/desktop/src-tauri/tauri.conf.json` 的 `version`（唯一事实源，见 §5.8；与 workspace `Cargo.toml` 的 `[workspace.package] version` 同步）。当前值是 `0.2.0`，因此 macOS 安装镜像与 Windows 两个安装器的名字分别是 `danmubox_0.2.0_<arch>.dmg`、`danmubox_0.2.0_x64-setup.exe`、`danmubox_0.2.0_x64_en-US.msi`；**提版本号后这些名字随之改变，以实际构建为准**（Android 通用包的本机产物路径为 `app-universal-release.apk`，名字里不含版本段，见 §5.3 的 Android 段）。

### 5.3 三端构建步骤与产物

#### macOS

```bash
cd apps/desktop && ./ui/node_modules/.bin/tauri build --bundles dmg
```

| 产物 | 路径 |
|---|---|
| 独立可执行（前端已内嵌，约 13 MB） | `<target-dir>/release/danmubox-desktop` |
| 安装镜像 | `<target-dir>/release/bundle/dmg/danmubox_<version>_<arch>.dmg`（`<version>` 见 §5.2） |

- `<arch>` 由构建机架构决定（Apple Silicon 为 `aarch64`，Intel 为 `x64`）。
- 交叉架构：在 Apple Silicon 上追加 `--target x86_64-apple-darwin`，产物落在 `<target-dir>/x86_64-apple-darwin/release/bundle/` 下。
- 要单独出 `.app` 用 `--bundles app`；本地运行不需要 DMG，可直接从 `.dmg` 拖出 `.app`，或用 §1.1 的开发期运行方式。
- `.dmg` 本身**不签名**，但里面的 `.app` 做 ad-hoc **整包**签名（口径与实测读数见 §5.5）。

#### Windows

开发机是 macOS，**本机出不了 Windows 包**（`x86_64-pc-windows-msvc` 要 Windows 上的 MSVC 工具链；交叉到 `-gnu` 是另一条路，本仓库不采用），因此 Windows 产物**只有 CI 一条出口**：`artifacts-windows` job（`windows-latest`，触发口径见 §5.13）。下面是那条 job 里逐字在跑的命令：

```bash
cd apps/desktop && ./ui/node_modules/.bin/tauri build --bundles nsis,msi
```

| 产物 | 路径 |
|---|---|
| 独立可执行（免安装） | `<target-dir>/release/danmubox-desktop.exe` |
| NSIS 安装器 | `<target-dir>/release/bundle/nsis/danmubox_<version>_x64-setup.exe` |
| WiX MSI | `<target-dir>/release/bundle/msi/danmubox_<version>_x64_en-US.msi` |

- **`--bundles` 不能省**：`tauri.conf.json` 里 `bundle.active = false`，而 tauri-cli 只在 `config.bundle.active || 命令行给了 --bundles` 时才进打包阶段，所以光写 `tauri build` 一个安装器都不出。
- **`.ico` 是必需的，由共享的 `bundle.icon` 提供**：① 编译期 `tauri-build` 生成 Windows 资源（winres）时找不到 `.ico` 就中断编译；② 打包期 MSI（WiX）要求 `bundle.icon` 列表里能找到 `.ico`（tauri-cli 把 bundler 的 `windows.iconPath` 置成空 PathBuf，只能回落到这个列表，空列表报 `Couldn't find a .ico icon`）。`apps/desktop/src-tauri/icons/icon.ico`（16…256）已入库并被 `tauri.conf.json` 的 `bundle.icon` 列着，因此那条命令**不再需要** `--config` 覆盖（口径见 §5.3「图标与 `bundle.icon` 的口径」）。
- NSIS 那条路径不读 `bundle.icon`：它的安装器图标只看可选的 `nsis.installerIcon`（本仓库没设 ⇒ 用 NSIS 自己的默认图标）。
- 两个安装器文件名里的 `<version>` 段随版本号变化（§5.2 / §5.8），**以实际构建为准**。
- `--target x86_64-pc-windows-msvc` 是显式指 64 位（在 x86_64 的 Windows 上本就是默认）。`.msi` **只能在 Windows 上构建**（WiX 仅支持 Windows）。
- 装机与运行**未验**：三个产物都只在 runner 上生成过，**没有在任何真 Windows 上装过 / 启动过**；首次安装后能否从「应用和功能」正常卸载（§4.2）、安装器是否需要联网装 WebView2、SmartScreen 行为见 §5.6 与 `testing.md` §10.3 的 W-1~W-4。产物未做代码签名（§5.6）。
- 自用只保留 NSIS 安装器与免安装 exe，MSI 留一份作备用安装路径。

#### 图标与 `bundle.icon` 的口径

**口径：三端共享 `tauri.conf.json` 里的一份 `bundle.icon`，不再按端覆盖。** 当前值是 `["icons/icon.png", "icons/icon.ico", "icons/icon.icns"]`（三枚，`apps/desktop/src-tauri/tauri.conf.json:30`）。

源图入库为 `apps/desktop/src-tauri/icons/icon-source.png`（1254×1254）；`icons/` 下其余图标文件（`32x32.png` / `64x64.png` / `128x128.png` / `128x128@2x.png` / `icon.png`(512) / `icon.ico`(16…256) / `icon.icns`(16…1024) 与 Windows Store 那 9 张）由 `tauri icon` 从它生成。仓库根那张 `icon.png` 仍是 untracked、未入库，也不参与构建。

| 端 | 读什么 | 说明 |
|---|---|---|
| macOS | `icons/icon.icns` | 出 `.app` / `.dmg` 时用它写 `Contents/Resources/` 与 `Info.plist` 的 `CFBundleIconFile`（`.dmg` 的卷图标同源）。只列 `icons/icon.png` 时 tauri 会拿最大的那张现生成 icns，`Contents/Resources/` 里只剩两档、Dock 的 1024 档会糊；三枚一起列上即整份 16→1024 原样拷入 |
| Windows | `icons/icon.ico` | 打包期 MSI（WiX）要求 `bundle.icon` 里能找到 `.ico`（列表为空直接报错），见上一节那条。**NSIS 那条不读 `bundle.icon`**：只看可选的 `nsis.installerIcon`，本仓库没设 ⇒ 用 NSIS 默认图标 |
| Android | `gen/android/app/src/main/res/mipmap-*/` | 本次按 `mipmap-mdpi` / `-hdpi` / `-xhdpi` / `-xxhdpi` / `-xxxhdpi` **逐档同尺寸替换** `ic_launcher` / `ic_launcher_round` / `ic_launcher_foreground`；自适应图标那套 `mipmap-anydpi-v26/` 与 `values/ic_launcher_background.xml` **已删除**（回到改动前的资源形态）。`AndroidManifest.xml` 的 `android:icon="@mipmap/ic_launcher"` 指的就是这些已入库的 png，`tauri android build` 只重生成 wry 那几个文件与 `tauri.properties` / `tauri.build.gradle.kts`，不碰它们 |

- Windows 那条 CI 命令里原来的 `--config '{"bundle":{"icon":["icons/icon.ico"]}}'` **已删除**（`ci.yml:384`）——图标不再按端覆盖。
- 前端 favicon：`apps/desktop/ui/public/favicon.svg` 已删，改为同目录的 `favicon-32x32.png` + `apple-touch-icon.png`（`ui/index.html` 两条 `<link>`）。
- **未验**：改成共享 `bundle.icon` 之后 **Windows job 尚未真跑**（改动前那一次真跑见 §5.13「本地验证到什么程度」；本次只在本机核过 `bundle.icon` 三枚与那条命令已无 `--config`）。

#### Android

每个新 shell 先 source 一次项目内工具链（前置条件与体积见 §5.4，清除与重建见 §5.12）：

```bash
. scripts/android-env.sh     # 导出 JAVA_HOME / ANDROID_HOME / NDK_HOME / RUSTUP_HOME / CARGO_HOME / GRADLE_USER_HOME / PATH
cd apps/desktop
CI=true ./ui/node_modules/.bin/tauri android build --apk --ci                  # 通用包：一个 APK 含四个 ABI
CI=true ./ui/node_modules/.bin/tauri android build --apk --split-per-abi --ci  # 按 ABI 分包
```

- **`gen/android` 工程已入库**（`apps/desktop/src-tauri/gen/android/**`，受版本控制 44 个文件，属长期维护的源码），因此**不要再跑 `tauri android init`**：它会覆盖本仓库对模板的四处改（见下表）。
- `CI=true` 与 `--ci` 一起用，让 Tauri CLI 走非交互路径。
- **干净克隆可以直接构建**：`TauriActivity.kt` 与 `app/proguard-tauri.pro` **已入库**（`app/.gitignore` 对这两个路径写了 `!` 例外，其余 `generated/` 内容仍被忽略）——`tauri android build` 只会（重新）生成 `app/src/main/java/…/generated/` 里 **wry** 那几个文件与 `app/tauri.properties` / `app/tauri.build.gradle.kts`，少了上面两份，干净检出里 Gradle 会以 `e: …MainActivity.kt: Unresolved reference: TauriActivity` 失败。升 tauri 版本时 `build.rs` 会覆盖它们，按 diff 提交即可。
- `tauri android dev -- --device <serial>`（真机热重载）**未实测**，本仓库暂不写具体用法。

| 产物 | 路径 |
|---|---|
| 通用 APK（四个 ABI） | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| 分 ABI APK | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release.apk`，`<abi>` ∈ `arm64` / `arm` / `x86` / `x86_64`（**不是** `armeabi-v7a` 这一族 Rust triple 名） |

- 没有 `keystore.properties` 时走未签名构建，产物名在 `-release` 之后再带一段 `-unsigned`（AGP 命名规则）。**未签名的包装不进设备**：`adb install` 报 `INSTALL_PARSE_FAILED_NO_CERTIFICATES`。签名材料与由来见 §5.7。
- 自用装机只装 APK（不生成 AAB）。默认构建包含官方支持的四个 ABI；`--split-per-abi` 只改产物粒度，不改编译目标是否已装。

**本仓库对上游模板的四处改**（重跑 `tauri android init` 会覆盖，需照下表重新打）：

| 位置 | 上游模板 | 本仓库 |
|---|---|---|
| `gen/android/buildSrc/src/main/java/dev/kksk/danmubox/kotlin/BuildTask.kt` | `node tauri android android-studio-script` | 直接调 `ui/node_modules/@tauri-apps/cli/tauri.js`，找不到 CLI 时显式报错（模板那条按相对 workingDir 解析 `tauri`，本仓前端工程在 `apps/desktop/ui`、`apps/desktop` 下没有 `package.json`，原样必然报 `Cannot find module`） |
| `gen/android/app/build.gradle.kts` | **没有** signingConfig | 自建 `signingConfigs.release`，读 `gen/android/keystore.properties`；文件缺失即退回无签名（§5.7） |
| `gen/android/app/src/main/java/dev/kksk/danmubox/MainActivity.kt` | 只调 `enableEdgeToEdge()` | 从原生收 `WindowInsets`（系统栏含 ime）换算成 CSS 变量 `--safe-top` / `--safe-bottom` 下发给页面；`AndroidManifest.xml` 的 `MainActivity` 配 `android:windowSoftInputMode="adjustNothing"`（软键盘避让只由页面自补内边距，见 `ui.md` §9.3）。**WebView 里拿不到系统栏高度**（`env(safe-area-inset-*)` 只报刘海），不补这一步顶栏会压进状态栏带、输入区会压进手势栏 |
| `gen/android/app/src/main/AndroidManifest.xml` + 新增的 `…/dev/kksk/danmubox/KeepAliveService.kt`（`MainActivity` 里配套的 `onStart` / `onStop` 钩子也属这一组） | 权限只有 `INTERNET`，没有任何 `<service>` | 权限**四枚**：`INTERNET`（模板原有）+ `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC` / `POST_NOTIFICATIONS`；加 `<service android:name=".KeepAliveService" android:foregroundServiceType="dataSync" android:exported="false" />`；退到后台且有活跃连接时起、回到前台即停（完整行为见 §2.8） |

**已验**：模拟器 android-35 上可出包、可安装、可启动；`aapt2 dump badging` 读到 package `dev.kksk.danmubox`、minSdk 24、targetSdk / compileSdk 36，带签名包 `apksigner verify` 为 `Verifies`（v2 签名）。读数留档见 `../CHANGELOG.md` 归档区。

### 5.4 工具链前置条件（对照 Tauri 官方 Prerequisites）

Tauri 官方把依赖分为「系统依赖 + Rust + 移动端附加依赖」三类。下表逐项对齐，**桌面端与移动端要求不同，不要互推**。

| 组件 | 适用平台 | 安装方式 | 必需的判定依据 |
|---|---|---|---|
| Rust（rustup） | 三端 | `curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf \| sh` | 官方把 Rust 列为通用必需项；版本由 `rust-toolchain.toml` 固定 |
| Node.js LTS | 三端（前端构建 + Tauri CLI） | nodejs.org 下载 LTS | 前端为 React + Vite，需 Node 构建工具链 |
| Xcode Command Line Tools | macOS 桌面 | `xcode-select --install` | 官方明确：**仅开发桌面目标时用 CLT 即可**，无需完整 Xcode |
| Visual Studio C++ Build Tools | Windows | 安装器勾选「Desktop development with C++」 | 官方列为 Windows 开发必需项 |
| WebView2 Runtime | Windows（开发机 + 目标机） | Evergreen Bootstrapper | 官方：Tauri 用 Edge WebView2 渲染，开发与运行都需要 |
| VBSCRIPT 可选功能 | Windows（仅打 MSI 时） | 设置 → 应用 → 可选功能 → 更多 Windows 功能 → 勾选 VBSCRIPT | 官方：缺它时 `light.exe` 报错 |
| **Android 工具链（本仓库口径）** | Android | 首次 `scripts/android-env.sh bootstrap`；之后每个新 shell `. scripts/android-env.sh` | **不再需要 Android Studio，也不再需要全局 `ANDROID_HOME` / `JAVA_HOME` / `NDK_HOME`**：官方那套「Android Studio + SDK Manager + 全局环境变量 + `rustup target add`」整体被仓库内的 `.android-env/` 取代 |
| Tauri CLI | 三端 | 前端脚本内 `@tauri-apps/cli`（`./ui/node_modules/.bin/tauri`） | 仓库不额外要求全局安装 `cargo-tauri` |

要点：

- **macOS 桌面只需 Xcode CLT**（本期不做 iOS 端）。
- **Windows 目标机需要 WebView2 运行时**。Windows 10/11 较新版本通常已预装；缺失时按 §5.6 处理。
- **Android 的四个 ABI target 与 NDK 缺一不可**；`--split-per-abi` 只影响打包粒度，不影响编译目标是否已安装。
- Windows 端在**本机**仍缺 `x86_64-pc-windows-msvc`（或 `-gnu`）target 与对应工具链（macOS 无法交叉编译；`windows-latest` 自带）。出包已绕开这一缺口：走 CI 的 `artifacts-windows`（§5.13）。

#### Android：仓库内工具链 `.android-env/`（`scripts/android-env.sh`）

```bash
. scripts/android-env.sh            # 导出环境（必须 source；直接执行无效）
scripts/android-env.sh bootstrap    # 从零安装，可重复执行（已装好的跳过）
scripts/android-env.sh clean        # 停 gradle daemon / adb server 后删除整个 .android-env
scripts/android-env.sh help         # 用法
```

装进 `.android-env/`（**仓库内**，已由根 `.gitignore` 忽略）的东西：

| 目录 / 内容 | 说明 |
|---|---|
| `jdk17/`、`jdk21/` | Temurin JDK 17 与 21；`JAVA_HOME` 默认指 `jdk17`，`ANDROID_JDK=21` 切到 `jdk21` |
| `sdk/` | 清单是 `scripts/android-env.sh` 的 `DANMUBOX_SDK_PACKAGES`：`platform-tools`、`platforms/android-35`、`build-tools/35.0.0`、`ndk/27.0.12077973`、`emulator`；另外按 `DANMUBOX_SYSTEM_IMAGE_CANDIDATES` 的候选表探测，装上第一个可用的 `system-images`（`android-34` / `android-35` 的 `google_apis` 或 `default` + `arm64-v8a`）。**`DANMUBOX_SDK_PACKAGES` 里没有 `platforms/android-36`**，而 `app/build.gradle.kts` 的 `compileSdk = 36`：缺它时构建会失败，需另行 `sdkmanager` 装上（CI 里显式装，见 §5.13） |
| `rustup/` + `cargo/` | 项目内 rustup / cargo：`DANMUBOX_RUST_TOOLCHAIN=stable`（`--profile minimal` + rustfmt + clippy），含四个 android target（`aarch64-linux-android` / `armv7-linux-androideabi` / `i686-linux-android` / `x86_64-linux-android`） |
| `gradle-home/` | `GRADLE_USER_HOME`，内含 `org.gradle.daemon=false` |
| `android-user/` | `ANDROID_USER_HOME` / `ANDROID_AVD_HOME`（AVD 也建在这里） |
| `npm-cache/`、`tmp/` | `npm_config_cache` 与 `TMPDIR` |

总计约 **14 GB**。导出的环境变量：

| 变量 | 取值 |
|---|---|
| `JAVA_HOME` | `.android-env/jdk17`（`ANDROID_JDK=21` → `jdk21`）；同批导出 `DANMUBOX_JDK_VERSION` |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | `.android-env/sdk` |
| `NDK_HOME` / `ANDROID_NDK_HOME` | `.android-env/sdk/ndk/<版本>` |
| `GRADLE_USER_HOME` / `RUSTUP_HOME` / `CARGO_HOME` | `.android-env/gradle-home`、`/rustup`、`/cargo` |
| `ANDROID_USER_HOME` / `ANDROID_AVD_HOME` | `.android-env/android-user`（AVD 在其下 `avd/`） |
| `npm_config_cache` / `TMPDIR` | `.android-env/npm-cache`、`.android-env/tmp` |
| `DANMUBOX_ROOT` / `DANMUBOX_ANDROID_ENV_ROOT` | 仓库根、`.android-env` 绝对路径（脚本自身定位用；可用 `DANMUBOX_ROOT=/path/to/danmubox` 覆盖） |
| `PATH` | 前置 `.android-env` 下各 `bin`（`cargo/bin`、`jdk/bin`、`cmdline-tools/latest/bin`、`platform-tools`、`emulator`、NDK prebuilt `bin`）；重复 source 不叠加 |

**宿主侧不装任何东西**：`~/.gradle`、`~/Library/Android` 都不存在也不会被创建（唯一的宿主足迹见 §5.12）。

### 5.5 macOS 本地运行与签名策略

自用不发布，因此**不购买 Apple Developer 账号、不做公证（notarization）**。签名分两档，只有第一档是「整包签名」：

| 档 | 怎么来 | 产物读数（`codesign -dv --verbose=4`） | 能否直接启动 |
|---|---|---|---|
| ad-hoc **整包**签名（本仓库采用） | `tauri.conf.json` 的 `bundle.macOS.signingIdentity = "-"`（`apps/desktop/src-tauri/tauri.conf.json:32`）—— 声明式一条路，**不需要**额外的 `codesign` 步骤 | 构建日志两处 `Signing with identity "-"`（先 Mach-O、再 `.app`）；`Identifier=dev.kksk.danmubox`、`CodeDirectory flags=0x10002(adhoc,runtime)`、`Info.plist entries=14`、`Sealed Resources version=2 rules=13 files=1`；`codesign --verify --deep --strict` **rc=0**；`spctl -a -vv -t exec` → `rejected` **rc=3**（预期：ad-hoc，无 Developer ID、无公证） | 可以 |
| 只有可执行文件的**链接器 ad-hoc 签名**（不配 `signingIdentity` 时的形态） | `tauri build` 不再额外签名，只有链接器在 Mach-O 上盖的那一枚；bundle 无封条 | `CodeDirectory flags=0x20002(adhoc,linker-signed)`、`Info.plist=not bound`、`Sealed Resources=none`、`Identifier=danmubox_desktop-<hash>`；`codesign --verify --deep --strict` **rc=1**（`code has no resources but signature indicates they must be present`）——**在没有 quarantine 的情况下就已如此** | **不能**：系统把这一档显示成「已损坏，无法打开」 |

因此「不配 `signingIdentity` 时 Tauri 会做 ad-hoc 签名」这句话**不成立**：不配它拿到的只是链接器签名、bundle 没有封条；`bundle.macOS.signingIdentity = "-"` 才是 ad-hoc 整包签名，也是 `.app` 能启动的前提（Apple Silicon 上尤其明显）。

`dmg` 本身不签名，但里面的 `.app` 做 ad-hoc 整包签名。往返实测：`tauri build --bundles dmg` 出 `target/release/bundle/dmg/danmubox_0.2.0_aarch64.dmg`（8.3 MB），`hdiutil verify` rc=0，挂载后里面的 `.app` 读数与上表第一档一致。

**CI 产物这一档**（从浏览器下载后拖进 `/Applications` 的那条路）：

| 办法 | 操作 |
|---|---|
| 走系统设置 | 系统设置 → 隐私与安全性 → 找到被拦的那一条 → 「仍要打开」 |
| 命令行去隔离属性 | `xattr -dr com.apple.quarantine /Applications/danmubox.app` |

从浏览器下载的产物会被 `com.apple.quarantine` 打上隔离属性（未公证的必然结果），首次打开被 Gatekeeper 拦下，上面两条任选其一。**不买 Apple Developer 账号 = 不做公证，跨机器首次打开必然要这一步**（本机自己构建、没经过浏览器的那份不受影响）。

验证命令：

```bash
codesign -dv --verbose=4 /path/danmubox.app            # Identifier / CodeDirectory flags / Sealed Resources
codesign --verify --deep --strict /path/danmubox.app   # ad-hoc 整包签名应为 rc=0
spctl -a -vv -t exec /path/danmubox.app                # ad-hoc 必然 rejected（rc=3），属预期
xattr -l /path/danmubox.app                            # 查看隔离属性
```

- **证书与密钥不进仓库**：签名材料一律留在本机钥匙串，禁止写入仓库或文档。

### 5.6 Windows SmartScreen 与 WebView2

未签名的安装器从浏览器下载后被打上 Mark-of-the-Web，首次运行触发 SmartScreen「Windows 已保护你的电脑」。自用不发布，**不购买 OV / EV 证书**，产物保持未签名。

| 场景 | 处理方式 |
|---|---|
| 自用本机构建、本机运行 | 从本机构建目录直接运行，**不经过浏览器下载**，通常不触发；若触发，走下一行 |
| 已经出现警告 | 点「更多信息」→「仍要运行」 |
| 拷贝到另一台自用机器 | 先解除文件锁定：文件属性 → 勾选「解除锁定」，或 PowerShell `Unblock-File .\danmubox_<version>_x64-setup.exe`（`<version>` 见 §5.2），再运行安装器 |

- 官方明确：签名只是减少警告的手段，**不是运行的必要条件**——只要愿意忽略 SmartScreen 警告，未签名也可运行。
- 安装器默认在缺少 WebView2 时下载 WebView2 Bootstrapper（需要联网）。若目标机常年离线，可改为随包内嵌安装器，代价是安装器体积显著增大（体积量级见 §5.10）。
- 打包 MSI 报 `failed to run light.exe` 时，检查 §5.4 表中的 VBSCRIPT 可选功能。

### 5.7 Android APK 安装

签名材料（keystore 与口令）**只存本机**，不进仓库、不进日志、不进文档（安全红线见 §3）。**同一 `dev.kksk.danmubox` 的后续安装必须使用同一签名**，否则无法覆盖安装、只能先卸载（卸载会清数据，且 `config.toml` 凭据一并丢失，见 §4）。

自用 release 签名材料放在 gradle 工程根，**两个文件都在 `apps/desktop/src-tauri/gen/android/`**：

| 文件 | 内容 | 状态 |
|---|---|---|
| `keystore.jks` | 自用 keystore | 被 `gen/android/.gitignore`（`*.jks`）忽略，**不入库** |
| `keystore.properties` | 键 `storeFile` / `storePassword` / `keyAlias` / `keyPassword`（`storeFile` 相对 `gen/android/` 解析，`app/build.gradle.kts` 的 `signingConfigs.release` 读它） | 同上，**不入库** |

- **这两个文件不在 `.android-env/` 内**，所以 `scripts/android-env.sh clean`（§5.12）删不到它们；反过来说，清工具链时**别手工把它们一起删掉**。
- **丢了会怎样**：换一份新 keystore 就等于换了签名 → 设备上已装的那个同名应用**装不上**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），只能先卸载（连带清掉 `config.toml` 凭据，重装后要重新扫码）。两者都在 `.gitignore` 里，**仓库没有任何备份来源**，请自行异地留存。
- **缺 `keystore.properties` 不阻塞出包**：`signingConfigs.release` 只在文件存在时创建，release 变为无签名（产物名带 `-unsigned`）。这种包装不进设备。
- **CI 出的包用的是另一份一次性签名**（现场 `keytool` 生成，随 run 消失），因此装过本机包的设备要先卸载；见 §5.13。

```bash
adb devices                                  # 确认设备已授权
adb install -r app-universal-release.apk     # 覆盖安装，保留应用数据
```

| 情况 | 处置 |
|---|---|
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | 装的是**未签名**包（没有 `keystore.properties` 的那次构建）→ 按 §5.7 的签名材料表确认在位后重新出包 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名与已装版本不一致 → 先 `adb uninstall dev.kksk.danmubox`（会清数据）再安装 |
| `INSTALL_FAILED_OLDER_SDK` | 设备 Android 版本低于最低支持版本 → 提高设备系统或调整 `minSdkVersion` 后重建 |
| 手机上提示「不允许安装未知应用」 | 在「安装未知应用」权限中允许 USB 安装来源 |
| 不想用 USB | 把 APK 传到手机后用文件管理器安装（同样需要未知来源权限） |
| 只装单一 ABI | `adb install -r` 前确认 APK 的 ABI 与设备匹配（此处指 arm64 / x86_64） |

### 5.8 版本号策略

| 项 | 规则 |
|---|---|
| 版本格式 | SemVer `MAJOR.MINOR.PATCH`，当前版本 **`0.2.0`**（`apps/desktop/src-tauri/tauri.conf.json` 的 `version`；workspace `Cargo.toml` 的 `[workspace.package] version` 与之同步，四个 crate 用 `version.workspace = true` 继承） |
| 单一事实源 | Tauri 配置中的 `version` 为准，三端产物名由它派生（`<version>`，见 §5.2）。**提版本号是「两处同改」**：`tauri.conf.json` 的 `version` + workspace `Cargo.toml` 的 `[workspace.package] version`，改完跑一次 `cargo check --workspace` 让 `Cargo.lock` 重生成 |
| bundle id | `dev.kksk.danmubox`，三端一致；**一旦装机后不再更改**，否则 Android 无法覆盖安装、数据目录也会错位 |
| Android versionCode | 采用官方派生规则 `major*1000000 + minor*1000 + patch`；需要连续递增时在 `bundle.android.versionCode` 显式指定 |
| 预发布 | 自用不做预发布通道；`0.x` 期间 minor 变更允许破坏兼容 |
| 文档同步 | 每次发版更新 `../CHANGELOG.md`；影响安装 / 数据目录 / 命令的改动同时更新 §5 与 §1。发版全程的操作步骤见 §5.13 的「发一版的操作步骤」 |
| 本地文件兼容 | 无迁移；升级不影响 `config.toml` 与 `prefs.json`，弹幕缓冲是内存态、退出即丢（`contract.md` §4.3） |

### 5.9 自用更新方式

不做自动更新（不引入 updater 插件、不搭更新服务器）。升级即用新产物覆盖安装。

| 平台 | 更新步骤 | 数据是否保留 |
|---|---|---|
| macOS | 退出应用 → 用新 `danmubox.app` 整体替换旧应用 → 重新启动 | 保留（数据在 `~/Library/Application Support/danmubox/`，不在 .app 内） |
| Windows | 退出应用 → 运行新安装器覆盖安装 | 保留（数据在 `%APPDATA%\danmubox\`） |
| Android | `adb install -r <新 APK>` | 保留（同包名 + 同签名）；换签名或降 versionCode 会失败 |

回滚方式：保留上一版产物（安装器 / APK / .app），直接覆盖回去。无迁移，回滚不涉及数据格式转换；但若升级时应用重写过 `config.toml` / `prefs.json`，回滚后以当前文件为准。

### 5.10 产物体积与内存目标（量级，非精确值）

只给量级与来源，不写具体数字；目的是给实现阶段一个可比的锚点。

| 指标 | 预期量级 | 依据 |
|---|---|---|
| 应用本体（不含内嵌 WebView2 安装器） | 10¹ MB | Tauri 的定位是「小包体」；sidecar 方案会把包体推回 40MB+，抵消 Tauri 的体积优势（否决理由见 `../CHANGELOG.md` 归档区） |
| Windows 安装器额外体积 | 0 / ~1.8MB / ~127MB / ~180MB 四档 | Tauri 官方 `webviewInstallMode` 对照表给出的增量：`downloadBootstrapper` 0 / `embedBootstrapper` ~1.8MB / `offlineInstaller` ~127MB / `fixedVersion` ~180MB |
| 常驻内存 | 10² MB | 结构上由「WebView 渲染进程 + Rust 引擎」构成，其中 WebView 通常是大头；消息仅在内存环形缓冲内保存（按类型分档，六档之和默认 8200 条/房间，见 `contract.md` §4.3），不是主要占用 |

参考来源：Tauri 2 官方文档的 Prerequisites、macOS Application Bundle、Windows Installer（WebView2 安装模式与体积对照）、Android 打包（versionCode 派生规则与产物路径）。

量级只是锚点；实测值与当时的构建配置（release、是否 `--split-per-abi` / `--target`）归 `../CHANGELOG.md` 归档区（上游侧待校准项归 `protocol.md` 附录 A）。采样命令：

```bash
# 体积
du -sh <target-dir>/release/bundle/macos/danmubox.app
ls -lh <target-dir>/release/bundle/dmg/*.dmg
ls -lh apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
# 常驻内存（在「单房间、持续收弹幕」状态下采样，记录房间数与消息速率）
ps -o rss= -p <pid>                                  # macOS：活动监视器亦可
adb shell dumpsys meminfo dev.kksk.danmubox          # Android
# 冷启动到首屏：至少三次取范围，不写单次值
time <启动命令>                                       # Android 用 adb shell am start -W dev.kksk.danmubox
```

### 5.11 出包前检查清单（自用，一次性）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 版本号一致 | Tauri 配置、`../CHANGELOG.md`、产物文件名三者一致 |
| 2 | 包标识一致 | 三端均为 `dev.kksk.danmubox` |
| 3 | 三端均可启动 | macOS 双击 / Windows 安装后启动 / Android 安装后启动 |
| 4 | 核心链路可用 | 按 `testing.md` 的三端手工冒烟清单逐条执行 |
| 5 | 本地文件就位 | 数据目录出现 `config.toml`（权限 `0600`）与 `prefs.json`；应用为纯客户端形态，不启动任何本地服务（见 §1） |
| 6 | 无敏感信息外泄 | 产物目录、日志、崩溃输出中不含 `SESSDATA` / `bili_jct` / `DedeUserID` 明文（见 §3）；仓库中无签名材料、`.p12`、Cookie、`config.toml` |
| 7 | 卸载可用 | 按 §4 能清干净残留 |

### 5.12 Android 工具链的无痕清除与重建

`.android-env/`（§5.4 那套，约 14 GB）整个在仓库内、且已在根 `.gitignore` 里，因此**删掉它就等于把这台机器上的 Android 工具链卸干净**：

```bash
scripts/android-env.sh clean     # 停后台进程 → 打印各目录占用 → 删除整个 .android-env
```

`clean` 逐条做的事：

| # | 动作 | 说明 |
|---|---|---|
| 1 | 停 gradle daemon | 若 `apps/desktop/src-tauri/gen/android/gradlew` 可执行，跑 `./gradlew --stop`；失败只告警不中断 |
| 2 | 停 adb server | 若 `.android-env/sdk/platform-tools/adb` 在，跑 `adb kill-server` |
| 3 | 打印删除前占用 | `du -sh` 总量 + 每个子目录一行的分解 |
| 4 | `rm -rf .android-env` | 整包删除，并打印释放量 |
| 5 | 提示 | 本 shell 里之前导出的 `JAVA_HOME` / `ANDROID_HOME` / `PATH` 已失效，需要时重新 `bootstrap` + `. scripts/android-env.sh` |

**删完还剩什么**：

| 位置 | 是否还在 | 说明 |
|---|---|---|
| `apps/desktop/src-tauri/gen/android/keystore.jks`、`keystore.properties` | **在** | 不在 `.android-env/` 内；**别手工连带删掉**（丢了要卸载重装，见 §5.7、§4.3） |
| `apps/desktop/src-tauri/gen/android/**` 其余部分 | 在 | 是要入库的工程源码，与工具链无关 |
| 宿主侧 `~/.gradle`、`~/Library/Android`、`~/.rustup`、`~/.cargo` | 不存在 | 脚本从不写这些位置；`clean` 前后都一样 |
| 宿主 rustup/cargo 的索引元数据 | 几 KB | 唯一的宿主足迹：宿主自身那份 `cargo`（非项目内那份）跑过本 workspace 时留下的索引元数据，与 `clean` 无关，清不清都行 |
| 宿主侧模拟器 / Java 的小文件 | 在 | 跑过模拟器与 Gradle 之后，宿主 `$HOME` 下会出现几个几 KB 的再生文件（它们不看 `ANDROID_USER_HOME`）：`~/.emulator_console_auth_token`、`~/.hawtjni/`（jansi 解包）、`~/.android/emu-last-feature-flags.protobuf`、`~/.android/emu-update-last-check.ini`、`~/.android/modem-nv-ram-<端口>`。`clean` 不碰它们（不在 `.android-env/` 内），不用模拟器时手工收一下：`rm -rf ~/.hawtjni ~/.emulator_console_auth_token ~/.android/emu-* ~/.android/modem-nv-ram-*` |

**要重装**：一条命令重建（可重复执行，已装好的会跳过），再 source 一次即可继续出包：

```bash
scripts/android-env.sh bootstrap   # 重新装 JDK / SDK / NDK / emulator / rustup + 四个 android target
. scripts/android-env.sh
cd apps/desktop && CI=true ./ui/node_modules/.bin/tauri android build --apk --ci
```

代价：`bootstrap` 要重新下载数 GB（JDK、SDK、NDK、system-image、rustup 工具链），耗时以网络为准；**签名材料与 `gen/android` 不受影响**，重装后同一台设备仍可覆盖安装。

### 5.13 发版与产物（GitHub Actions CI，`.github/workflows/ci.yml`）

**发版口径**：三端产物**由 CI 出**（不在本机「发布」）；触发只有两种 —— 手动 `workflow_dispatch`，或推一个 `v*` tag。

| job | `runs-on` | 做什么（命令逐字来自 `ci.yml`） | 触发 |
|---|---|---|---|
| `check` | `macos-14` | `rustup component add rustfmt clippy` → `npm ci` → `npm run lint`（= `oxlint --deny-warnings`，**告警即失败**）→ `npm run build`（= `tsc -b && vite build`）→ `cargo fmt --all -- --check`（**提交门**，无 `continue-on-error`）→ `cargo clippy --workspace --all-targets -- -D warnings` → `cargo test --workspace` | push 到 `main`、任何 `pull_request`、手动 `workflow_dispatch`；**推 `v*` tag 也会触发**（该 job 无 `if`） |
| `artifacts` | `macos-14` | `tauri build --bundles dmg` → **挂载 dmg、对里面的 `.app` 自校验**（`hdiutil attach` → 打印 `codesign -dv --verbose=4` → `codesign --verify --deep --strict` 失败即 job 失败 → `spctl -a -vv -t exec … \|\| true` 只记录 → `hdiutil detach`）→ 上传 `danmubox-macos-dmg`（`target/release/bundle/dmg/*.dmg`） | `workflow_dispatch` 或 `refs/tags/v*` |
| `artifacts-android` | `ubuntu-latest` | 四个 ABI `rustup target add` → JDK 17（temurin）→ 自取 cmdline-tools（**linux** 包 `16111833`；**不用** `android-actions/setup-android@v3`，它会去装上游已下架的 `tools` 包）→ `sdkmanager` 装 `platform-tools` / `platforms/android-36` / `build-tools/35.0.0` / `ndk/27.0.12077973` → 导出 `NDK_HOME` / `ANDROID_NDK_HOME` 与四个 target 的 linker / ar / ranlib 配置（prebuilt 目录**按宿主探测**）→ `npm ci` → `keytool` 生成一次性 release 签名材料 → `tauri android build --apk --ci` → 上传 `danmubox-android-apk`（`apk/*/release/*.apk`） | 同 `artifacts` |
| `artifacts-windows` | `windows-latest` | `npm ci` → `tauri build --bundles nsis,msi`（`shell: bash`，`ci.yml:384`；原先那条 `--config '{"bundle":{"icon":["icons/icon.ico"]}}'` 已删）→ 上传 `danmubox-windows`（免安装 `.exe` + NSIS 安装器 + MSI） | 同 `artifacts`（仅手动与 `v*` tag） |

- `concurrency`：`group: ${{ github.workflow }}-${{ github.ref }}`、`cancel-in-progress: true` —— 同一个 ref 上的新一轮推送取消上一轮未完成的运行。
- `permissions: contents: read`（工作流级）。
- 三个产物 job 都显式钉 `CARGO_TARGET_DIR: ${{ github.workspace }}/target`；`check` 用默认 target 目录。
- `artifacts` 的自校验为什么必须挂在 **dmg 上**验：`--bundles dmg` 出包后会清掉 `target/release/bundle/macos/` 下那个 `.app` 中间产物（只剩 dmg），而用户拿到的也正是 dmg 里那一份。脚本位置 `.github/workflows/ci.yml:141-159`，判据是 `codesign --verify --deep --strict` 必须 rc=0；`spctl` 的输出只打印留档（ad-hoc 必然 `rejected`，见 §5.5）。
- **未验**：`artifacts` 的这段自校验脚本**并入 CI 之后尚未真跑**；本机逐字跑过同一段 `run:` 脚本、rc=0。
- **未验**：`artifacts-windows` 去掉 `--config` 之后**这条 job 尚未真跑**（改动前那一次真跑见本节「本地验证到什么程度」）。

缓存：

| job | 缓存 | 不缓存 |
|---|---|---|
| `check` | `~/.cargo/registry`、`~/.cargo/git`、`target/`（键含 `Cargo.lock` 哈希） | — |
| `artifacts` | `~/.cargo/registry`、`~/.cargo/git` | `target`（release 产物远超缓存收益）、Gradle |
| `artifacts-android` | 同上（只 registry） | `target`（四个 ABI 的 release 产物同理）、Gradle |
| `artifacts-windows` | `~/.cargo/registry`、`~/.cargo/git`、`target/` | — |
| 四个 job 共用 | `actions/setup-node` 内建的 npm 缓存（`apps/desktop/ui/package-lock.json`，node 22） | — |

#### 发一版的操作步骤

以 `0.2.0` 为例，一次发版就是下面五步 —— 前三步在开发分支上做完，第 4 步才触发 CI：

| # | 动作 | 落点 / 命令 | 要点 |
|---|---|---|---|
| 1 | 把 `[Unreleased]` 收成一个版本 | `../CHANGELOG.md`：整段收进 `## [x.y.z] - YYYY-MM-DD`，`[Unreleased]` 留空（只留占位一行） | 同一个版本内每个 `###` 小节**只出现一次** |
| 2 | 提版本号 | `apps/desktop/src-tauri/tauri.conf.json` 的 `version` + workspace `Cargo.toml` 的 `[workspace.package] version` | **两处必须同一次改**（四个 crate 用 `version.workspace = true` 继承）。改完跑一次 `cargo check --workspace` 让 `Cargo.lock` 重生成并确认不破编译；产物名里的 `<version>` 随之改变（§5.2 / §5.8） |
| 3 | 合并到 `main` | `git checkout main && git merge --no-ff <开发分支>` → push | 合并前先 `git status` 看索引（`../AGENT.md` §3）；`check` job 会在这次 push 上跑一遍 |
| 4 | 打 tag | `git tag -a vx.y.z -m "…" && git push origin vx.y.z` | **tag 才是出包开关**：三条产物 job 的 `if` 是 `github.event_name == 'workflow_dispatch' \|\| startsWith(github.ref, 'refs/tags/v')`，tag 名必须以 `v` 开头 |
| 5 | 取产物 | Actions → 该 run → 页面底部 **Artifacts**：`danmubox-macos-dmg` / `danmubox-android-apk` / `danmubox-windows` | 产物保留期用仓库默认（公开仓库 90 天），要长期留存就自己下下来 —— §5.9 的回滚靠留着上一版产物 |

- **也可以只手动出包不发版**：Actions → `CI` → **Run workflow**（选分支）直接触发三条出包 job，不用 tag、不改 `CHANGELOG`。日常自用构建走这条。
- **CI 只把文件挂到 run 的 Artifacts 区**，不发布到任何应用市场 / 包仓库。
- **版本号不要回退**：Android 的 `versionCode` 由版本号派生（`major*1000000 + minor*1000 + patch`），降版本号要卸载重装、会清数据（§5.7 / §5.9）。
- **未验**：第 4 步「打 `v*` tag 触发」这条路**至今没有真跑过** —— CI 的出包实测都是 `workflow_dispatch` 触发的。本条按 `ci.yml` 的 `if` 条件写出，**不是实测**。

#### 手动触发与取产物

网页：仓库 → **Actions** → 左侧 `CI` → **Run workflow**（选分支）→ 跑完后在该 run 页面底部的 **Artifacts** 区下载：

| 产物名 | 内容 | 在仓库里的来源路径 |
|---|---|---|
| `danmubox-macos-dmg` | `danmubox_<version>_aarch64.dmg`（`<version>` 见 §5.2，以实际构建为准） | `target/release/bundle/dmg/*.dmg` |
| `danmubox-android-apk` | `app-universal-release.apk`（四个 ABI 的通用包） | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/*/release/*.apk` |
| `danmubox-windows` | 三个文件：`danmubox-desktop.exe`（免安装）+ `danmubox_<version>_x64-setup.exe`（NSIS 安装器）+ `danmubox_<version>_x64_en-US.msi` | `target/release/danmubox-desktop.exe`、`target/release/bundle/nsis/*.exe`、`target/release/bundle/msi/*.msi` |

产物保留期用仓库默认（公开仓库 90 天），过期即失效，要长期留存就自己下下来。

#### 在本机出同样两个产物（macOS / Android）

就是 §5.3 里那两条命令（CI 用的也是它们）。**Windows 不在这一节**：本机是 macOS，出不了 Windows 包，它的产物只在 CI 的 `artifacts-windows` job 上生成。

```bash
# ① macOS .dmg（bundle.active=false 靠 --bundles 覆盖；图标与签名都由共享的 tauri.conf.json 提供，见 §5.3 / §5.5）
cd apps/desktop && ./ui/node_modules/.bin/tauri build --bundles dmg
#    产物：<repo>/target/release/bundle/dmg/danmubox_<version>_aarch64.dmg（<version> 见 §5.2）

# ② Android 已签名 release APK（先 source 一次项目内工具链，见 §5.4）
. scripts/android-env.sh
cd apps/desktop && CI=true ./ui/node_modules/.bin/tauri android build --apk --ci
#    产物：apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

两条都要先装前端依赖（`tauri` CLI 与前端构建都在 `apps/desktop/ui/node_modules` 里）：`npm --prefix apps/desktop/ui install`（CI 里用 `npm ci`）。

#### 签名口径差异（Android：**CI 产物与本地产物签名不同**）

- 本机的签名材料是 `gen/android/keystore.jks` + `keystore.properties`（自用私钥，已被 gitignore，**绝不入库、绝不进 CI**，见 §5.7）。
- CI 上不用也不该用这份私钥：`artifacts-android` job 用 `keytool -genkeypair` **现场生成一次性 keystore**（写进 `keystore.properties` 的四个键；口令由 `github.run_id` / `run_attempt` 派生，只活在本次 run 里，run 结束即消失），因此 CI 的 APK 签名**有效但与本机不同**。
- 后果：**设备上已装过本机包时，CI 包装不上**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）—— 先 `adb uninstall dev.kksk.danmubox` 再装（卸载会清数据，`config.toml` 凭据要重新扫码，见 §4.3 与 §5.7）。
- macOS 侧**没有这个差异**：CI 与本机读的是同一份 `bundle.macOS.signingIdentity = "-"`，两侧都是 ad-hoc **整包**签名（都不公证，跨机器首次打开都要过 §5.5「CI 产物这一档」那一步）。
- CI 里的 `keytool` 与 `sdkmanager` 只出现在 run 步骤的 shell 里，工作流文件中不含任何口令明文。

#### 冒烟不在 CI 里跑

`apps/desktop/ui/smoke/run-headless.mjs` 的两引擎冒烟**没有**纳入 CI（刻意取舍，不是漏项；它不需要真实网络与真实直播间——自己 `npm run build` 出 `dist`，页内注入 `__TAURI_INTERNALS__` 替身、假 IPC 与夹具样本，见 `testing.md` §9.2）。因此冒烟仍在**本机 / 主流程**跑：

```bash
cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs                    # Chromium
cd apps/desktop/ui && node smoke/run-headless.mjs --engine webkit                    # 宿主引擎（macOS = WKWebView）
```

#### 本地验证到什么程度（如实口径）

| 项 | 状态 |
|---|---|
| `npm ci` / `npm run lint` / `npm run build` / 三条 Rust 命令 / `tauri build --bundles dmg` | **本机实测过** |
| `tauri android build --apk --ci` | 本机干净 worktree 上真跑完过（rc=0，四个 ABI 全部编出）；那份 worktree 没有本地 keystore，所以是**未签名**产物 |
| macOS 产物的 `codesign` 自校验 | **本机实测过**（ad-hoc 整包签名：`codesign --verify --deep --strict` rc=0、`spctl` rejected rc=3；读数见 §5.5）；**未验**：同一段脚本并入 CI 之后没有真跑过 |
| Android 工具链在 runner 上安装 | **已真跑**（自取 cmdline-tools 的方案取自首次真跑暴露的失败，见 §5.13 的 `artifacts-android` 行） |
| Android 产物在 `ubuntu-latest` 上出 | **已真跑**（run `35307480216`，四条 job 全绿，产物为已签名通用包） |
| Windows 产物 | **已真跑出包**（run `35213437486`，三个产物上传；那一次还在用 `--config` 覆盖图标）；**未验**：改成共享 `bundle.icon`、去掉 `--config` 之后尚未真跑；真机安装 / 启动 / 卸载、WebView2 是否需联网、SmartScreen 也未验 —— 即 `testing.md` §10.3 的 W-1~W-4 |
| CI 工作流本身 | **已真跑**：`check` 在 PR 与 push 上多次 success；三条产物 job 均手动触发成功（各自最新改动是否已复跑，见上面几行的未验标注）；`v*` tag 触发**未真跑**（见 §5.13「发一版的操作步骤」的未验条） |

逐轮读数与耗时留档见 `../CHANGELOG.md` 归档区。
