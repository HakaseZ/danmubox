# 运行与运维

> 定位：danmubox 的日常启动停止、数据文件位置、凭据文件维护、故障排查、三端构建分发与卸载清理。
> 读者：日常使用与排障的仓库所有者本人；需要读取应用数据目录或在本机出包的维护者。
> 更新时机：新增/更名环境变量、数据目录或文件名变化、新增 IPC 命令、新增卸载残留位置、新增目标平台或打包步骤时必须同步本文。

---

## 1. 日常操作

### 1.1 启动与停止

| 平台 | 启动 | 停止 |
|---|---|---|
| macOS | 双击 `danmubox.app`（需按 §5.3 先出包）；开发期见下方两种运行方式 | 关闭窗口即退出（本期不做后台保活）；异常残留用活动监视器结束 `danmubox-desktop` |
| Windows | 开始菜单 / 桌面快捷方式，或运行安装目录下的 `danmubox.exe` | 关闭窗口即退出；异常残留用任务管理器结束 `danmubox.exe` |
| Android | 桌面图标，或 `adb shell monkey -p dev.kksk.danmubox -c android.intent.category.LAUNCHER 1` | 从最近任务划掉；彻底停止用「设置 → 应用 → danmubox → 强制停止」 |

应用为纯客户端形态，不启动任何本地网络服务：界面通过 Tauri IPC 与引擎通信，二者之间不需要任何访问凭据（契约 §7）。三端打包与产物见 §5。

#### 桌面端运行方式（2026-09-11 实测）

**当前 `tauri.conf.json` 里配置了 `devUrl`，因此 debug 与 release 构建都会从 `http://localhost:5173` 加载界面**——
也就是说**必须先起 Vite dev server**，否则窗口是空白的（且不会有任何报错，只有 `webview 页面加载` 日志缺失）。

```bash
# 终端 1：前端 dev server（保持运行）
npm --prefix apps/desktop/ui run dev

# 终端 2：桌面端
cargo run -p danmubox-desktop
```

判断界面有没有真正加载，看这条日志（需要 `DANMUBOX_LOG=debug`）：

```bash
DANMUBOX_LOG=debug cargo run -p danmubox-desktop
# 正常应出现：webview 页面加载 url=http://localhost:5173/  →  IPC app_info
# 只看到 "web content process terminated" 而没有页面加载 → dev server 没起或端口不对
```

要得到**不依赖 dev server 的独立产物**见 §1.6；三端打安装包见 §5。单独 `cargo build --release` **不会**产生可独立运行的产物——它加载不出前端（窗口全白，日志里既无 `webview 页面加载` 也无任何 IPC）；实测 A/B 记录与门槛见 `../AGENT.md` §9。

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

桌面端不写日志文件（`apps/desktop/src-tauri/src/lib.rs` 的 `fmt_layer` 固定写 stderr），需要留存时用下方重定向。

#### 桌面端调试日志落到文件（推荐）

排查界面问题时，把日志写成文件比在应用里翻日志面板方便：

```bash
mkdir -p target/logs
DANMUBOX_LOG=debug cargo run -p danmubox-desktop 2>&1 | tee -a target/logs/app.log
```

日志**全量**覆盖前后端：Rust 侧的 `tracing` 输出，加上界面里的 JS 错误。桥接由 `apps/desktop/src-tauri/src/lib.rs` 实现：

- 页面每次 `PageLoadEvent::Finished` 后，Rust 侧执行 `webview.eval(CONSOLE_BRIDGE)` 注入桥接脚本；
- 脚本改写 `console.error` / `console.warn`，并监听 `window` 的 `error` 与 `unhandledrejection`；
- 命中后由脚本**直接**调 `window.__TAURI_INTERNALS__.invoke('frontend_log', { level, message })`（不经 `@tauri-apps/api`）；
- Rust 侧 `frontend_log` 命令按 level 写进 `tracing` 的 `danmubox::ui` target（`error` / `warn`，其余落 `debug`）。

脚本自带两条限流：`message` 截断到 **2000 字符**（去重键取前 200 字符）；同一条告警 **1s 内只上报一次**——防止「渲染 → 告警 → 日志回推 → 重渲染」的反馈环。

判断界面是否真的加载、以及是否出现异常循环，看这几条：

| 日志 | 含义 |
|---|---|
| `webview 页面加载 url=...` | 页面真的导航了；**没有这条就是白屏**（多半是 dev server 没起） |
| `IPC app_info` | React 已挂载且 IPC 通了；正常是 2 次（StrictMode 双挂载） |
| `IPC xxx` 在短时间内反复出现 | 前端出现自激循环，是卡死的典型信号 |
| `ERROR danmubox::ui: ...` | 界面里的 JS 错误原文 |

`target/` 已在 `.gitignore` 中，日志不会被提交。

### 1.3 数据目录与文件位置（三端）

数据目录下只有凭据文件与偏好文件；弹幕只在内存，不落盘（契约 §4.3）。

| 平台 | 数据目录 | 典型内容 |
|---|---|---|
| macOS | `~/Library/Application Support/danmubox/` | `config.toml`、`prefs.json`、`prefs.json.bak` |
| Windows | `%APPDATA%\danmubox\` | 同上 |
| Android | 应用私有目录（绝对路径随系统与用户而异，以 `app_info` 返回值为准） | `config.toml`、`prefs.json`、`prefs.json.bak` |

- 数据目录本身**不含**弹幕内容：弹幕只在内存环形缓冲中保留（契约 §4.3）。
- 查看实际数据目录：调用 `app_info`（返回版本、数据目录、构建信息；不含任何凭据值）。
- Android 上定位数据目录：

```bash
adb logcat -s danmubox                              # 启动时打印数据目录
adb shell dumpsys package dev.kksk.danmubox | grep -i dataDir   # 辅助确认
```

不要在文档或脚本里硬编码 Android 的 `/data/data/...` 路径：设备用户、系统版本与分区方案都会影响实际位置。

### 1.4 凭据文件 `config.toml`：查看、权限与手工编辑

凭据以**明文 TOML** 存放，靠文件权限（`0600`）与「只在本机数据目录」约束，不加密（契约 §4.1；需求来源与本取舍的完整论证见 [`decisions/0007-credential-file.md`](decisions/0007-credential-file.md)）。

文件形态（示例值全部为空串；多账号用 `[profiles.<name>]` 承载，`active_profile` 指定当前生效者，契约 §4.1）：

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

启动顺序：读文件 → 取 `active_profile` 指向的账号，其 `sessdata` / `bili_jct` / `dede_user_id` 三者齐全且非空则直接进入登录态；否则走扫码（默认入口），扫码成功后原子写回目标账号（新增账号先按昵称起名，见 `auth.md` §8.4）。

#### 查看与权限确认

| 平台 | 查看内容 | 确认权限 | 修复权限 |
|---|---|---|---|
| macOS | `cat ~/Library/Application\ Support/danmubox/config.toml` | `ls -l` 应显示 `-rw-------`（只有属主可读写） | `chmod 600 ~/Library/Application\ Support/danmubox/config.toml` |
| Windows | 记事本打开 `%APPDATA%\danmubox\config.toml` | `icacls "%APPDATA%\danmubox\config.toml"` 应只见当前用户（SYSTEM / Administrators 可接受） | `icacls "%APPDATA%\danmubox\config.toml" /inheritance:r /grant:r "%USERNAME%":F` |
| Android | 无桌面式直接访问；文件位于应用私有目录，其他应用不可读 | 无需手工确认（应用私有目录即隔离边界） | 无需处理 |

安全提醒：`config.toml` 整文件等同账号控制权，**不要**贴进聊天、issue、日志或截图；排查时只看「哪个字段是否为空」，不要展示取值。

#### 手工编辑凭据（排障兜底）

界面与 CLI **没有**粘贴 Cookie 的入口（用户 2026-09-13：登录方式只保留扫码与游客）。
要换掉某份凭据只能编辑这个文件：

1. 退出应用（避免写入竞争）。
2. 备份现有文件（复制为 `config.toml.bak`）。
3. 从浏览器 DevTools 的 Application → Cookies → `bilibili.com` 复制 `SESSDATA`、`bili_jct`、`DedeUserID`，填入 `active_profile` 指向的 `[profiles.<name>]` 的 `sessdata` / `bili_jct` / `dede_user_id`；其余字段可留空。
4. 确认文件权限为 `0600`（见上表）。
5. 重新启动应用：三项齐全即直接进入登录态，无需扫码。

注意这里没有落盘前的护栏：凭据是否有效要到启动复核（或下一次 `nav` 调用）才知道，
填错就是启动后仍显示未登录（`auth.md` §8.4）。

登出（界面登出，对应 `account_logout`）会清空当前账号的**账号级**凭据并回到游客态：**账号条目保留**（列表里显示为未登录，可再登录回来），`buvid3` / `buvid4` 为设备标识一并保留。

#### 命令行入口

`danmubox-cli` 的账号相关子命令（能力交付的阶段史见 [`../CHANGELOG.md`](../CHANGELOG.md)）：

| 用途 | 命令 |
|---|---|
| 查看登录态 | `danmubox session`（只输出状态与当前账号名，**不含任何 Cookie 值**） |
| 查看账号列表 | `danmubox accounts`（当前账号打星；逐行给登录状态、昵称与 uid） |
| 扫码登录 / 新增账号 | `danmubox login [账号名]`（终端直接渲染二维码；不带账号名 = 新增账号，确认后按昵称自动起名；`--timeout` 可调） |
| 登出 | `danmubox logout [账号名]`（缺省 = 当前账号；只清凭据，条目保留） |
| 切换 / 删除账号 | `danmubox accounts --use <名字>`、`danmubox accounts --remove <名字>` |

界面与 CLI 的账号入口都只保留扫码与登出：没有「粘贴 Cookie」这一类命令（用户 2026-09-13 移除，见 `auth.md` §8.4）。

数据目录默认取平台路径（`paths::data_dir`）；调试或多环境并存时可用环境变量 `DANMUBOX_HOME` 覆盖，例如 `DANMUBOX_HOME=/tmp/db danmubox session`。

### 1.5 偏好文件 `prefs.json`

界面偏好只存 `prefs.json`（不写进 `config.toml`），形态是**单层 JSON 对象**，键为契约 §8 的唯一权威清单（如 `ui.font_scale`、`ui.theme`、`ui.gift_in_danmaku`、`ui.gift_panel`、`filter.kinds`、`history.buffer_rows`）。只存被显式改过的键，缺失的键回落到默认值（契约 §4.2）。

```json
{
  "ui.theme": "dark",
  "ui.gift_in_danmaku": false,
  "ui.gift_panel": true,
  "history.buffer_rows": 8000
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
| 未知键或非法值 | 键清单以契约 §8 为准，清单外或类型/范围不符的键不参与生效值合成；建议只通过界面修改 |
| 已删除键的残留 | `ui.system_notice` 已删除（开关并进 `filter.kinds` 白名单，契约 §8）：读文件时按它的值把结果物化进 `filter.kinds`（`false` → 去掉 `system`；`true` → 补上），该键本身随即失效，下次写入后从文件里消失。`ui.gift_panel_mode` 同理已删除、由 `ui.gift_in_danmaku` / `ui.gift_panel` 两枚开关取代：读文件时按旧值物化（`separate` → `false` / `true`；`merged` → `true` / `false`），文件里已显式写了新键的那一枚以文件为准。其余已删除键（如 `filter.keywords*`）只是被忽略 |
| JSON 解析失败（损坏） | 按默认值启动，并把损坏副本保留为 `prefs.json.bak` |
| 正常写入 | 原子替换（临时文件 + rename），不会出现写一半的半成品文件 |

### 1.6 独立产物（不依赖 dev server）

```bash
# 仅需一次：安装 Tauri CLI（注意绕开 ~/.npm 里 root 所有的缓存目录）
npm --prefix apps/desktop/ui i -D @tauri-apps/cli --cache /tmp/npm-cache-danmubox
# 构建（`beforeBuildCommand` 会自动先构建前端；产物落在 target/release）
cd apps/desktop && ./ui/node_modules/.bin/tauri build --no-bundle
```

产物是 `target/release/danmubox-desktop`（约 13 MB，实测），**前端已内嵌**：
日志里页面加载的 URL 是 `tauri://localhost` 而不是 `http://localhost:5173`，
因此不需要再起 Vite，双击即可运行。

`tauri.conf.json` 当前 `bundle.active=false` 且 `icon` 为空，所以这一步不产出 `.app` / `.msi` / APK；
要出安装包先补应用图标并打开 `bundle.active`，三端步骤与产物见 §5.3。

---

## 2. 故障排查决策树

### 2.1 总览

排障顺序固定为：**登录状态 → 连接状态 → 业务行为**。先确认界面上的登录态与房间连接状态，再进对应小节（认证与扫码见 2.2 / 2.7，连接见 2.3 / 2.5，发送见 2.4，Android 白屏见 2.6）；需要细节时开启 `DANMUBOX_LOG=debug` 复现一次，读日志与 `danmubox://log` 事件。

### 2.2 认证失败

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 登录态（`session_status` / 界面） | 显示未登录 → 先扫码，或按 §1.4 编辑 `config.toml` 后重启 |
| 2 | 认证回应是否 `code=0` | `code=0` 为成功；非 0 一律视为认证失败，按重连退避处理，日志保留原始 code，**不得**在未知 code 上编造含义 |
| 3 | 是否游客模式 | 游客 `uid=0`、`key=""` 属预期；游客能力受限（昵称掩码、字段缺失），不代表故障 |
| 4 | `SESSDATA` 是否过期／失效 | 凭据过期（含手工编辑进去的那份）→ 重新扫码，或按 §1.4 更新 `config.toml` |
| 5 | WBI 签名相关报错 | 说明签名实现或系统时间异常；先校准系统时间，再查 `auth.md` 的签名步骤 |
| 6 | 换房间是否同样失败 | 全房间失败 → 账号级问题；单房间失败 → 房间级问题（房间号、权限、风控） |

### 2.3 连不上 WS

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 房间连接状态（界面房间头 / `danmubox://room` 事件） | 未发起连接 → 触发 `rooms_connect`；已连接 → 问题在收包不在连接 |
| 2 | `room_id` 是否为真实房间号 | 短号 / URL 必须先经 `getRoomPlayInfo` 解析为真实 `room_id`；解析失败说明房间输入不合法 → 重新添加房间 |
| 3 | 日志是否出现 `getDanmuInfo` 失败 | 该接口需 `buvid3` 与 WBI 签名，未登录时易失败 → 见 2.2 |
| 4 | 是否出现认证回应 `op=8` 且 `code != 0` | 认证未通过，按重连退避处理；记录原始 code，见 2.2 |
| 5 | 是否反复重连且间隔递增 | 退避为 5s / 10s / 20s / 40s / 60s 封顶，属预期行为；持续不成功则查网络与上游可用性 |
| 6 | 网络环境 | 代理 / 防火墙 / 公司网络拦截 WebSocket → 换网络验证 |
| 7 | 全部正常仍无消息 | 房间可能未开播（`live_status=0`）→ 换一个正在直播的房间交叉验证 |

### 2.4 弹幕发送失败

发弹幕返回 `SendOutcome`（契约 §5），必须先看它、再看界面表现。前端是**乐观渲染**：点下发送就已经把你那条画在列表里了，因此**不要**以「界面上出现过」判定发送成功 —— 判定只看 `SendOutcome`。没发出去的那条会**留在列表里标成被拒**（正文划线 + 行尾写上游给的原因，`docs/ui.md` §4.4），草稿保留可改再发。

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
| 1 | 点击房间内的「刷新」按钮 | 触发 IPC `rooms_reconnect`，手动发起一次重连（契约 §7） |
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
| 5 | 扫码成功后会话是否刷新 | 成功后登录态应变为已登录，界面应收到 `danmubox://session` 事件 |
| 6 | 手机与电脑的端 | 在 Android 端扫码是「同机扫屏」，请用另一台设备显示二维码或截图后扫码 |

---

## 3. 日志与敏感信息脱敏规则

安全红线（契约 §4.1 原文，必须原样遵守）：

> `SESSDATA`、`bili_jct`、`DedeUserID` **不得**进日志、不得进前端明文、不得进仓库、不得进崩溃上报。

工程约定（在红线之上补充的执行细则）：

| 对象 | 规则 |
|---|---|
| `SESSDATA` / `bili_jct` | 永不打印明文；日志里只允许出现「已设置 / 未设置」这类布尔事实 |
| `DedeUserID` | 属可识别标识，日志中以掩码或长度描述代替 |
| `config.toml` | 整文件视同凭据，不截图、不外发、不进仓库 |
| `Cookie` 请求头 | 打印请求时必须整体省略该头，不允许「截断显示前 6 位」这种折衷 |
| 二维码 key | 短时有效但视同凭据：分享日志前先替换 |
| `buvid3` / `buvid4` | 设备标识，与账号凭据同时出现可被关联；日志中以掩码或长度描述代替 |
| 弹幕内容 | 属用户数据，默认不进 `debug` 日志；需要时临时开启更高级别并按脱敏后外发 |

分享日志前的自查命令：

```bash
grep -niE 'sessdata|bili_jct|dede_user_id|dedeuserid|buvid3' <日志文件或日志目录>   # 命中即先替换再外发
```

提交仓库前：确认无 `config.toml`、无 keystore、无 `.p12`、无导出的 Cookie 文本。

---

## 4. 卸载与残留清理

卸载前务必确认：`config.toml` 含账号控制权凭据，删除或卸载即**永久丢失**，重装后需重新扫码（或手工编辑凭据文件，§1.4）。

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
| 3 | 外部存储残留 | 本项目不写共享存储；若发现相关目录，手工删除 |
| 4 | 开发机上的签名材料 | **不要删除**（保留以便日后覆盖安装）；它不在手机上，属开发机资产 |
| 5 | 设备上的安装包 | 手工删除此前 `adb push` / 传输的 APK |

### 4.4 卸载检查清单

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 无进程残留 | 三端均无 `danmubox` 进程 |
| 2 | 无数据目录残留 | §1.3 列出的路径均已清理 |
| 3 | 凭据文件已删 | `config.toml` 不再存在（含备份副本） |
| 4 | 重装可用 | 重新安装后能正常启动；因凭据已随文件删除，需重新扫码（或按 §1.4 手工编辑凭据文件） |

---

## 5. 构建与分发

> 定位：danmubox 在 macOS / Windows / Android 三端的构建、签名、打包、安装与自用更新方式。
> 读者：在本机执行构建 / 重新打包 / 装机的开发者（通常是仓库所有者本人）。
> 更新时机：新增目标平台、更换包标识或版本策略、新增签名或安装步骤、产物路径变化时必须同步本节。

> 通用构建 / 测试 / lint 命令见 [`../README.md`](../README.md) §8 与 [`../AGENT.md`](../AGENT.md) §3；本节只写三端打包、产物与安装。

### 5.1 范围与前提

| 项 | 约定 |
|---|---|
| 分发范围 | **自用，不对外分发**：产物只装自己的设备 |
| 目标平台 | macOS / Windows / Android（iOS 与折叠屏适配为后期 enhancement） |
| 不做 | 自动更新、后台保活（契约 §2） |
| 包标识 bundle id | `dev.kksk.danmubox`，三端统一（契约 §1） |
| 前端产物 | `apps/desktop/ui/` 由 Vite 构建并内嵌进 Tauri 应用（React + TS，见 `architecture.md`） |
| 引擎 | `danmubox-core`（Rust），薄封装见 `architecture.md` |

### 5.2 `<target-dir>` 的定义

Rust 产物目录在 workspace 下由 Cargo 决定，本节统一用 `<target-dir>` 表示，避免硬编码：

| 场景 | `<target-dir>` |
|---|---|
| workspace 统一 target（默认，`target-dir` 未覆盖） | `<repo>/target` |
| `apps/desktop/src-tauri` 使用独立 target 目录 | `<repo>/apps/desktop/src-tauri/target` |
| 显式指定平台 target 时 | 上述目录下的 `<triple>/release/...` |

本期实测走的是默认情形：§1.6 的独立产物落在 `<repo>/target/release/danmubox-desktop`。

### 5.3 三端构建步骤与产物

#### macOS

日常出包命令与产物见 §1.6（独立可执行文件，前端已内嵌）。需要 `.app` / `.dmg` 时：先补应用图标并打开 `bundle.active`，再执行

```bash
cd apps/desktop && ./ui/node_modules/.bin/tauri build --bundles app,dmg
```

| 产物 | 路径 |
|---|---|
| 独立可执行（实测） | `<target-dir>/release/danmubox-desktop`（前端已内嵌，约 13 MB） |
| 应用包（需先补图标） | `<target-dir>/release/bundle/macos/danmubox.app` |
| 安装镜像（需先补图标） | `<target-dir>/release/bundle/dmg/danmubox_0.1.0_<arch>.dmg` |

- `<arch>` 由构建机架构决定（Apple Silicon 为 `aarch64`，Intel 为 `x64`）。
- 交叉架构可在 Apple Silicon 上追加 `--target x86_64-apple-darwin`，产物落在 `<target-dir>/x86_64-apple-darwin/release/bundle/` 下。
- 本地运行不需要 DMG，直接双击 `danmubox.app`，或用 §1.1 的开发期运行方式。

#### Windows

```bash
cd apps/desktop && ./ui/node_modules/.bin/tauri build                       # 默认同时产出 msi 与 nsis
cd apps/desktop && ./ui/node_modules/.bin/tauri build --target x86_64-pc-windows-msvc   # 显式 64 位
```

| 产物 | 路径 |
|---|---|
| WiX MSI | `<target-dir>/release/bundle/msi/danmubox_0.1.0_x64_en-US.msi` |
| NSIS 安装器 | `<target-dir>/release/bundle/nsis/danmubox_0.1.0_x64-setup.exe` |

- `.msi` **只能在 Windows 上构建**（WiX 仅支持 Windows）；NSIS 可在其他平台交叉构建，但属「最后手段」，本仓库不采用。
- 自用只保留 NSIS 安装器与免安装可执行文件即可；MSI 留一份作为备用安装路径。
- 首次安装后从「应用和功能」可正常卸载（见 §4）。

#### Android

```bash
cd apps/desktop && ./ui/node_modules/.bin/tauri android init     # 首次生成 gen/android 工程，只跑一次
cd apps/desktop && ./ui/node_modules/.bin/tauri android build --apk
cd apps/desktop && ./ui/node_modules/.bin/tauri android build --apk --split-per-abi
cd apps/desktop && ./ui/node_modules/.bin/tauri dev -- --device <serial>   # 真机热重载调试
```

| 产物 | 路径 |
|---|---|
| 通用 APK | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| 分 ABI APK | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release.apk` |

- 自用装机只装 APK（不生成 AAB）。
- 默认构建包含官方支持的四个 ABI；自用设备通常只需 `arm64`，可用 `--target aarch64` 缩短构建时间。
- 最低 Android 版本由 Tauri 决定（官方当前为 Android 7.0 / SDK 24），需要提高时在 `bundle.android.minSdkVersion` 配置。

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
| Android Studio | Android | developer.android.com/studio | 官方移动端第一步 |
| Android SDK 组件 | Android | SDK Manager 安装 Android SDK Platform / Platform-Tools / Build-Tools / Command-line Tools | 官方逐项列出 |
| NDK (Side by side) | Android | SDK Manager 安装 | 官方逐项列出 |
| `JAVA_HOME` | Android | 指向 Android Studio 自带 JBR，如 `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` | 官方要求显式设置 |
| `ANDROID_HOME` / `NDK_HOME` | Android | `export ANDROID_HOME="$HOME/Library/Android/sdk"`；`NDK_HOME="$ANDROID_HOME/ndk/<版本>"` | 官方要求显式设置 |
| rustup 四个 Android ABI target | Android | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` | 官方列出的四个目标，缺一则对应 ABI 构建失败 |
| Tauri CLI | 三端 | 前端脚本内 `@tauri-apps/cli`（`./ui/node_modules/.bin/tauri`） | 仓库不额外要求全局安装 `cargo-tauri` |

要点：

- **macOS 桌面只需 Xcode CLT**（本期不做 iOS 端）。
- **Windows 目标机需要 WebView2 运行时**。Windows 10/11 较新版本通常已预装；缺失时按 §5.6 处理。
- **Android 的四个 ABI target 与 NDK 缺一不可**；`--split-per-abi` 只影响打包粒度，不影响编译目标是否已安装。

#### Android 与 Windows 前置条件（当前缺口）

两端都属独立工程，开工前先补齐（2026-09-12 本机核查；缺口登记见 [`../CHANGELOG.md`](../CHANGELOG.md) 阶段 5 与 [`roadmap.md`](roadmap.md) §2.2）：

| 端 | 缺 | 已有 |
|---|---|---|
| Android | Android SDK（`sdkmanager`，`ANDROID_HOME` 未设置）、Android NDK（`ANDROID_NDK_HOME` 未设置）、Gradle、Rust 的 Android target（`aarch64-linux-android` 等；当前只装了 `aarch64-apple-darwin`） | `adb`、`java`/`javac` |
| Windows | `x86_64-pc-windows-msvc`（或 `-gnu`）target 与对应的链接器 / 工具链（macOS 无法交叉编译） | — |

### 5.5 macOS 本地运行与签名策略

自用不发布，因此**不购买 Apple Developer 账号、不做公证（notarization）**：公证需要 Apple 账号凭据（`APPLE_ID` / `APPLE_API_KEY` 等），自用场景不引入该依赖。

| 场景 | 做法 | 结果 |
|---|---|---|
| 本机构建本机运行 | 不配置 `signingIdentity`，Tauri 做 ad-hoc 签名（等价 `codesign -s -`） | 可直接启动；Apple Silicon 上 ad-hoc 签名是二进制可执行的前提 |
| 拷到另一台自己的 Mac | 用「右键 → 打开」或系统设置 → 隐私与安全性 → 仍要打开；也可 `xattr -dr com.apple.quarantine /path/danmubox.app` | Gatekeeper 首次拦截后可正常运行 |

验证命令：

```bash
codesign -dv --verbose=4 /path/danmubox.app   # 确认为 adhoc 签名
spctl -a -vv /path/danmubox.app               # 查看 Gatekeeper 评估结果
xattr -l /path/danmubox.app                   # 查看隔离属性
```

- **证书与密钥不进仓库**：签名材料一律留在本机钥匙串，禁止写入仓库或文档。

### 5.6 Windows SmartScreen 与 WebView2

未签名的安装器从浏览器下载后被打上 Mark-of-the-Web，首次运行触发 SmartScreen「Windows 已保护你的电脑」。自用不发布，**不购买 OV / EV 证书**（都需付费与身份材料，EV 另有硬件令牌要求），产物保持未签名。

| 场景 | 处理方式 |
|---|---|
| 自用本机构建、本机运行 | 从本机构建目录直接运行，**不经过浏览器下载**，通常不触发；若触发，走下一行 |
| 已经出现警告 | 点「更多信息」→「仍要运行」 |
| 拷贝到另一台自用机器 | 先解除文件锁定：文件属性 → 勾选「解除锁定」，或 PowerShell `Unblock-File .\danmubox_0.1.0_x64-setup.exe`，再运行安装器 |

- 官方明确：签名只是减少警告的手段，**不是运行的必要条件**——只要愿意忽略 SmartScreen 警告，未签名也可运行。
- 安装器默认在缺少 WebView2 时下载 WebView2 Bootstrapper（需要联网）。若目标机常年离线，可改为随包内嵌安装器，代价是安装器体积显著增大（体积量级见 §5.10）。
- 打包 MSI 报 `failed to run light.exe` 时，检查 §5.4 表中的 VBSCRIPT 可选功能。

### 5.7 Android APK 安装

签名材料（keystore 与口令）**只存本机**，不进仓库、不进日志、不进文档（安全红线见 §3）。**同一 `dev.kksk.danmubox` 的后续安装必须使用同一签名**，否则无法覆盖安装、只能先卸载（卸载会清数据，且 `config.toml` 凭据一并丢失，见 §4）。

```bash
adb devices                                  # 确认设备已授权
adb install -r app-universal-release.apk     # 覆盖安装，保留应用数据
```

| 情况 | 处置 |
|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名与已装版本不一致 → 先 `adb uninstall dev.kksk.danmubox`（会清数据）再安装 |
| `INSTALL_FAILED_OLDER_SDK` | 设备 Android 版本低于最低支持版本 → 提高设备系统或调整 `minSdkVersion` 后重建 |
| 手机上提示「不允许安装未知应用」 | 在「安装未知应用」权限中允许 USB 安装来源 |
| 不想用 USB | 把 APK 传到手机后用文件管理器安装（同样需要未知来源权限） |
| 只装单一 ABI | `adb install -r` 前确认 APK 的 ABI 与设备匹配（此处指 arm64 / x86_64） |

### 5.8 版本号策略

| 项 | 规则 |
|---|---|
| 版本格式 | SemVer `MAJOR.MINOR.PATCH`，当前基线 `0.1.0`（`apps/desktop/src-tauri/tauri.conf.json` 的 `version`；记录见 `../CHANGELOG.md`） |
| 单一事实源 | Tauri 配置中的 `version` 为准，三端产物名由它派生 |
| bundle id | `dev.kksk.danmubox`，三端一致；**一旦装机后不再更改**，否则 Android 无法覆盖安装、数据目录也会错位 |
| Android versionCode | 采用官方派生规则 `major*1000000 + minor*1000 + patch`；需要连续递增时在 `bundle.android.versionCode` 显式指定 |
| 预发布 | 自用不做预发布通道；`0.x` 期间 minor 变更允许破坏兼容 |
| 文档同步 | 每次发版更新 `../CHANGELOG.md`；影响安装 / 数据目录 / 命令的改动同时更新本节与 §1 |
| 本地文件兼容 | 无迁移；升级不影响 `config.toml` 与 `prefs.json`，弹幕缓冲是内存态、退出即丢（契约 §4.3） |

### 5.9 自用更新方式

不做自动更新：不引入 updater 插件、不搭更新服务器——自用单机，后端发布通道本身是额外维护面。升级即用新产物覆盖安装。

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
| 应用本体（不含内嵌 WebView2 安装器） | 10¹ MB | Tauri 的定位是「小包体」；sidecar 方案已在 [`decisions/0001-tauri-over-flutter.md`](decisions/0001-tauri-over-flutter.md) 否决——它会把包体推回 40MB+，抵消 Tauri 的体积优势 |
| Windows 安装器额外体积 | 0 / ~1.8MB / ~127MB / ~180MB 四档 | Tauri 官方 `webviewInstallMode` 对照表给出的增量：`downloadBootstrapper` 0 / `embedBootstrapper` ~1.8MB / `offlineInstaller` ~127MB / `fixedVersion` ~180MB |
| 常驻内存 | 10² MB | 结构上由「WebView 渲染进程 + Rust 引擎」构成，其中 WebView 通常是大头；弹幕仅在内存环形缓冲内保存（`history.buffer_rows` 默认 5000 条），不是主要占用 |

参考来源（官方文档，核对日期 2026-09-11）：Tauri 2 Prerequisites、macOS Application Bundle、Windows Installer（WebView2 安装模式与体积对照）、Android 打包（versionCode 派生规则与产物路径）。

量级只是锚点，实测值与当时的构建配置（release、是否 `--split-per-abi` / `--target`）登记到文末指针所指的唯一校准表。采样命令：

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

---

## 6. 相关文档

| 文档 | 关联点 |
|---|---|
| [`contract.md`](contract.md) | 本地文件、常量、`SendOutcome`、IPC 命令、偏好键的唯一事实源 |
| [`auth.md`](auth.md) | 三种登录模式、扫码状态机、凭据字段与失效处理 |
| [`protocol.md`](protocol.md) | WS 包结构、心跳、重连、消息取值路径；唯一「待实测校准」表 |
| [`ipc.md`](ipc.md) | 前端命令与事件名、调试面板订阅 |
| [`ui.md`](ui.md) | 房间内「刷新」按钮、连接状态展示、发送失败回滚 |
| [`architecture.md`](architecture.md) | 进程拓扑、并发模型、可观测性 |
| [`testing.md`](testing.md) | 三端手工冒烟清单，用于验证排障动作与出包检查是否生效 |
| [`decisions/0001-tauri-over-flutter.md`](decisions/0001-tauri-over-flutter.md) | 桌面框架选型与包体取舍 |
| [`../README.md`](../README.md) | 项目定位、三端目标、通用开发命令（§8） |
| [`../AGENT.md`](../AGENT.md) | 构建 / 测试 / lint 命令与仓库作业规范 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本变更记录 |

---

> 唯一「待实测校准」表在 [`protocol.md`](protocol.md) 附录 A；本文不再自建。
