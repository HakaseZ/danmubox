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
（唯一会写到数据目录之外的，是你主动点过「一键诊断」之后的那个报告文件 —— 它落在下载目录，见 §2.9；数据目录本身不因此多出任何东西。）

| 平台 | 数据目录 | 典型内容 |
|---|---|---|
| macOS | `~/Library/Application Support/danmubox/` | `config.toml`、`prefs.json`、`prefs.json.bak` |
| Windows | `%APPDATA%\danmubox\` | 同上 |
| Android | 应用私有目录（绝对路径随系统与用户而异，以 `app_info` 返回值为准）；由外壳在启动最早期把 `DANMUBOX_HOME` 注入为 Tauri `app_data_dir()`，即应用私有 dataDir 本身、**不是**其下的 `files/` 子目录（实测模拟器 android-35 上为 `/data/user/0/dev.kksk.danmubox`） | `config.toml`、`prefs.json`、`prefs.json.bak` |

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

`tauri.conf.json` 当前 `bundle.active=false` 且 `icon` 为空，所以这一步不产出 `.app` / `.dmg` / APK；
要出安装包**不用**改这两项：macOS 的 `.dmg` 直接加 `--bundles dmg` 即可（`--bundles` 覆盖 `bundle.active`，
`icon: []` 也不拦 macOS 出包 —— 2026-09-16 实测），三端步骤与产物见 §5.3。

---

## 2. 故障排查决策树

### 2.1 总览

排障顺序固定为：**登录状态 → 连接状态 → 业务行为**。先确认界面上的登录态与房间连接状态，再进对应小节（认证与扫码见 2.2 / 2.7，连接见 2.3 / 2.5，发送见 2.4，Android 白屏见 2.6）；需要细节时开启 `DANMUBOX_LOG=debug` 复现一次，读日志与 `danmubox://log` 事件。Android 上「退到后台之后」的行为（前台服务保活、那枚常驻通知、电池优化白名单）单独一篇：见 2.8。

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

### 2.8 Android 退到后台就不再收弹幕 / 那枚「正在接收弹幕」通知

**先把两件事分开**——它们经常被当成一件事：

| 环节 | 谁会把它掐掉 | 本项目的对策 |
|---|---|---|
| 进程被系统回收 / 冻结 | 内存压力下的 low-memory killer、App Standby | **前台服务**（本节） |
| 网络被掐 | Doze（屏幕关、设备静止、未充电） | **只能靠电池优化白名单**（见下），前台服务管不了 |

**是什么**：`gen/android/app/src/main/java/dev/kksk/danmubox/KeepAliveService.kt` —— 一个**只做一件事**的前台服务：挂一枚常驻通知，把本进程的优先级顶到「前台服务」档，让系统在后台/内存紧张时优先回收别的进程。它**不轮询、不上报、不持唤醒锁、不碰网络**：弹幕连接本来就跑在**本进程的 Rust 侧**（tokio），被系统限流的只有 WebView 的定时器与渲染，所以这里没有任何需要替 Rust 侧做的事。

**什么时候起、什么时候停**（全在 `MainActivity`）：

| 时机 | 动作 |
|---|---|
| 退到后台（`onStop`，HOME / 切到别的应用）**且页面答「还有活跃连接」** | 起 |
| 回到前台（`onStart`，点通知 / 点图标 / 从最近任务切回） | 停，通知同时消失 |
| 应用内退出（根页面按返回 → `finish()`），`isFinishing` | **不起** |
| 把任务从最近任务里划掉，`onTaskRemoved` | **停**，不留通知 |

「有没有活跃连接」是问页面（`window.__danmuboxHasActiveConnection()`，与返回手势同一套 JS 桥，见 `ui/src/keepalive.ts`）——判据复用界面已有连接状态，外壳不自己造状态。**没开过房间就不会有通知**。

**怎么关掉它**（三条路，任选）：

1. 点通知回到应用 —— 回到前台即停；
2. 通知抽屉下拉到底的「正在运行的应用」（Task Manager，Android 13+）→ 对应的 Stop 按钮 —— 这条路会停掉**整个应用**；
3. 系统设置 → 应用 → danmubox → 强行停止。

通知本身是 `ongoing`（划不掉）——但 Android 14 起系统允许用户直接划掉**前台服务**的通知（划掉只是通知消失，服务照跑），这一档由系统决定、不由应用决定。

**会不会耗电**：前台服务本身几乎不额外耗电——它不做事、不唤醒 CPU；真正的开销是那条本来就存在的 WS 长连与心跳（回到前台也一样耗）。它的作用只是「让系统别把这进程回收掉」。

**要不要开电池优化白名单**（设置 → 电池 → 电池优化 → 找到 danmubox → 不优化）：

- **前台服务并不豁免 Doze**。屏幕关掉、设备静止、未充电进入 Doze 后，系统暂停应用的网络访问，长连接会断；断开后靠已有重连退避（5/10/20/40/60s 退避，见 §2.3）恢复，能接上的窗口很窄。
- 把应用加进白名单（官方叫「部分豁免」）之后，Doze 与 App Standby 期间**仍可用网络、可持 partial wake lock**——这才是「关屏也要一直收」真正的开关。
- 所以：只在「切出去一会儿再回来」用，可以不开；要**关屏持续收**，就得开。
- 本应用**不会**弹窗要这个权限（官方那张「可接受用途」表里即时通讯类明确不推荐用 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` 直接要）——需要时自己去设置里加。

**通知权限（Android 13 / API 33 起）**：常驻通知要 `POST_NOTIFICATIONS`，它是**运行时**权限，冷启动时问一次（拒过一次就不再自动弹，免得每次启动都被弹窗堵住）。**拒绝不影响保活**：前台服务照起、进程照顶前台档，只是**通知抽屉里看不到那条通知**（系统行为：这类通知会退回「正在运行的应用」里显示），用户照样能在那里停掉它。

**6 小时额度（Android 15 / API 35 起，且 targetSdk ≥ 35）**：`dataSync` 这个前台服务类型每 24 小时只有 **6 小时**总额度（本项目 `targetSdk 36`，落在这一档）。到点系统回调 `Service.onTimeout()`，代码里立刻 `stopSelf()`——**不这么做进程会被系统以 `RemoteServiceException` 崩掉**。额度用尽后**再起**服务会被拒（`ForegroundServiceStartNotAllowedException`；代码里接住、只记一条 logcat，表现为「这次不保活」，不崩）；用户把应用带回前台会重置计时。自用场景下一次蹲播够用。

**厂商 ROM**：以上都是 AOSP 行为。国产 ROM（MIUI / EMUI / ColorOS / OriginOS 等）另有自己的后台管理，可能忽略前台服务、锁屏后清理、或要求单独开「自启动 / 后台运行」白名单——**真机待确认**，见 §9 的卸载检查清单与 [`testing.md`](testing.md) §10.5。

**实测（2026-09-16，本地 AVD `danmubox_verify`：android-35 / API 35 / arm64-v8a，包 `dev.kksk.danmubox`，targetSdk 36，**带签名的 release 包**）**：命令与原始输出全部落在 `.android-env/verify/ka-*.txt|png`（`ka-old-*` = 保活前的包，`ka-new-*` = 本提交的包；**该目录随 `scripts/android-env.sh clean` 一起删**）。

A/B —— 同一个房间（公开测试房间 `1`）、同一台 AVD，都取「按 HOME 之后 ≈200 秒」这一档：

| 检查 | 旧包（保活前） | 新包（本次） |
|---|---|---|
| `pidof dev.kksk.danmubox` | HOME 前 3455 → 200 s 后 **3455（进程活着）** | HOME 前 3898 → 200 s 后 **3898** |
| 到 443 的 ESTABLISHED | HOME 前 3 条 → 200 s 后 **0 条** | HOME 前 4 条 → 200 s 后 **2 条**（其中一条是后台期间新建的，见下） |
| 前台服务 | 无（这个包里没有） | `ServiceRecord{…dev.kksk.danmubox/.KeepAliveService}`、`isForeground=true foregroundId=1 types=0x00000001`、`uidState: FGS` |
| 常驻通知 | 无 | `NotificationRecord(… pkg=dev.kksk.danmubox id=1 … channel=danmubox-keepalive … flags=ONGOING_EVENT\|NO_CLEAR\|FOREGROUND_SERVICE)`；`android.title=正在接收弹幕` / `android.text=点按回到应用`；通知抽屉的「静默」组里可见（截图 `ka-new-13-shade.png`） |
| logcat | —— | 全程只有 2 行：`danmubox-keepalive: 前台服务已启动` / `…已停止`，`FATAL EXCEPTION` 0 |

**这条 A/B 说明了什么、没说明什么（不要过度解读）**：旧包 200 秒后一条连接都不剩，而同一时刻设备上**别的应用**仍持有到 443 的 ESTABLISHED（`ka-old-21-all-device-conn.txt`），所以不是设备断网 —— 旧包那边的进程虽然还在，但已经**不再做事**（冻结/被丢弃）。新包同一档仍有 2 条连接、且那条 WS 在后台期间换过端口（`A038/A028` 消失、`D518 → CA5C0D70` 出现在 12:45）说明**进程确实在跑**（还能发起新连接）。但把窗口拉长到 7.2 分钟（`ka-new-22-after-7min.txt`）后，WS 那条已经掉了、只剩一条 HTTPS 长连 —— **前台服务保住的是「进程不被冻结到连重连都做不了」，不是「连接永远不断」**。模拟器上区分不出真机省电/内存压力下的收益，见 [`testing.md`](testing.md) §10.5。

**起停与两档不该起（同一台 AVD）**：

| 场景 | 结果 |
|---|---|
| 点常驻通知回前台（真点了通知，`input tap` 到 `正在接收弹幕` 上） | 回 `MainActivity`、**pid 不变**（3898）、`KeepAliveService` 消失、通知记录 0 条、logcat 多一行「前台服务已停止」 |
| 连续两轮「HOME → 回前台」 | 每轮都是「HOME 后：服务 1 个 + 通知 1 条 → 回前台后：0 + 0」，pid 始终 4472，**没有累积、没有重复启动**（`ka-new-70-cycle.txt`） |
| **没有任何房间**时按 HOME | **不起服务**、无通知、logcat 无 keepalive 行（`ka-new-61-A10-noroom.txt`；截图确认当时确实是空态） |
| 开着房间但在**根页面按返回**退出应用 | 应用退出（`pidof` 空）、**无服务、无通知**、logcat 无 keepalive 行（`ka-new-50-A10-backexit.txt`） |

**通知权限的冷启动路径也实测过**：`pm revoke` + 清 `user-set`/`user-fixed`（等价于全新安装）后冷启动，系统弹窗「Allow danmubox to send you notifications?」出现（`ka-new-80-perm-dialog.xml`），点 Allow 后 `granted=true`，logcat `danmubox-main: 已获得通知权限`。

**Android 15 的 6 小时额度也实测过**（用官方给的测试开关，见 [`about/versions/15/behavior-changes-15`](https://developer.android.com/about/versions/15/behavior-changes-15#datasync-timeout)）：`am compat enable FGS_INTRODUCE_TIME_LIMITS dev.kksk.danmubox` + `device_config put activity_manager data_sync_fgs_timeout_duration 60000`（把 6 小时缩成 60 秒），退到后台后 —— 服务 12:52:58 起、12:53:58 系统回调 `Service.onTimeout()`，代码里那条自停日志与「前台服务已停止」紧接着打出（相隔 8 ms），服务与通知都收干净、进程仍在；**`RemoteServiceException` / `did not stop within` 0 次、`FATAL EXCEPTION` 0 次**（`ka-new-90-ontimeout.txt`）。即：额度耗尽这一刻是**优雅收工**，不是崩溃。（测完已 `device_config delete` + `am compat disable` 复位。）

**排查**：

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 通知抽屉里有没有「正在接收弹幕」 | 没有 → 先看 2、3；有 → 保活已在工作 |
| 2 | `adb shell dumpsys activity services dev.kksk.danmubox` | 没有 `KeepAliveService` → 退到后台那一刻**是否真有活跃连接**（没房间、刚断线都不会起），以及 `adb logcat -s danmubox-keepalive` 里有没有「系统不允许在此时启动前台服务」（= 后台起前台服务被拒 / 6 小时额度用尽） |
| 3 | `adb shell dumpsys notification --noredact \| grep -i danmubox` | 渠道 `danmubox-keepalive` 在、通知不在 → 十有八九是 `POST_NOTIFICATIONS` 没给（见上） |
| 4 | 通知在、但长连接断了 | 不是保活的问题，是 Doze 掐了网络 → 加电池优化白名单（见上） |
| 5 | 连接反复重连 | 见 2.3 与 [`protocol.md`](protocol.md)：退避属预期，持续不成功查网络与上游 |

### 2.9 一键诊断：让用户导出一份诊断文件

「连上了却收不到弹幕」这条问题的定位链很长（票据 → 认证 → 首帧 → 之后有没有持续的业务载荷 → 退避重连），
只能靠用户交出来的材料判断。房间头 `⋯` 菜单里的**一键诊断**就是这条出口
（实现口径 `contract.md` §4.4、界面 `ui.md` §3.6、IPC §7 `diagnose_start` / `diagnose_export`）。

**怎么让用户做**（三步，可以直接照抄给用户）：

1. 进那个出问题的房间（采集的是**这个进程的连接**，入口因此放在房间页）；
2. 点房间头 `⋯` →「一键诊断」——**采集 3 分钟**，界面有倒计时，也可以点「提前结束并导出」；
3. 把导出的文件发过来：桌面端在 `~/Downloads/danmubox-diagnose-<UTC 时间戳>.txt`；
   Android 在公共下载目录 `/sdcard/Download/danmubox-diagnose-<UTC 时间戳>.txt`，文件名相同。
   面板上的「复制路径」能拿到完整路径 —— 一次诊断**只产生这一个文件**。

采集中与采集后都不需要用户做别的事：**应用不会自动发送任何数据**（本仓无遥测），
文件也只落在本机；发给谁由用户决定。文件已按 §3 的口径脱敏，可直接外发。

文件里有什么（`contract.md` §4.4 的清单）：每一次连接尝试的每一环（票据 `getDanmuInfo` 的 `code` 与耗时 /
候选节点下标 / WS 握手 / 认证包 `op=7` 发出的时刻 / 认证回应 `op=8` 是否到达与延迟 / 首个入站帧 /
首条业务载荷 / 结束原因 / 退避与连续认证失败次数）、协议计数（收包 / 各类丢弃 / 未识别命令）、
未识别命令名单、采集窗口内的日志行（带字段）、以及平台与版本信息（OS、应用版本、渲染引擎）。

**读法**（判定顺序与 §2.1 一致，都先看机器可判定的量，再看界面表现）：

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | 票据那一行的 `code` 非 0 | 上游连票据都不给：`-352` 是签名 / 风控（`auth.md` §9.1），其余 code 原样看文案，别猜含义（§2.2） |
| 2 | 认证回应一行写着「**未到达**」 | 卡在认证：同一段里看「本轮有 N 个候选没接上」，属候选节点连通性问题 |
| 3 | 认证成功（`code=0`）但「首条业务载荷」一直是空的、且「距最近一次入站帧」还在涨 | **正是本条要闭环的那一档**：连接是通的、上游没往下发。再看窗口内日志有没有 `上游 HTTP 心跳失败` / `同一节点连续失败…切换` / `认证回应 code 非 0` |
| 4 | 窗口内有 `距上次入站帧已 …ms（阈值 90000ms），判定连接僵死` | 僵死护栏按预期工作（`protocol.md` §8.1）：属上游静默，不是本地卡住 |
| 5 | 一条连接尝试都没有 | 诊断期间没连过房间（先确认房间页的连接态，再看 §2.3） |
| 6 | 文件里出现 `***` | 那是脱敏（凭据 / uid / 昵称 / **房间号**，见 §3），不是数据缺失；要定位具体房间让用户自己说 |

**抹的范围**（2026-09-21 按首次实测复盘后的口径）：按「本机已知的房间号 / 短号 / 主播 uid」**逐值**抹，
但只抹**看起来是标识**的位置 —— 键值对形态（`room_id=5440` / `?id=5440`，一位数字也抹）与**两位以上**的
独立数字。时间（`13:55:01`）、版本（`0.1.0`）、计数（`共 1 次记录`）、从开始算起的偏移（`+1.56 s` / `+619 ms`）
与一位数序号（`[1]` / `host_list[0]`）**一律原样保留**：它们正是这份报告存在的理由。
首次实测（公开测试房间 `1`，它的短号就是 `1`）曾被一刀切抹成 `应用版本：0.***.0` / `13:55:***` / `共 *** 次记录`，
那份报告没法读；规则与回归用例见 `crates/danmubox-bili/src/redact.rs` 的 `mask_numbers` 与
`export_redaction_keeps_times_versions_and_counts`。

**Android 上这枚入口同时补上了 [`testing.md`](testing.md) §10.5 那条遗留**（「设备上没有可打开的业务日志入口」）：
以前在设备上只能 `adb logcat` 看系统日志，现在是应用自己的业务日志（报告里「采集窗口内的日志」那一节）
随报告一起落到公共下载目录，用户可以自己打开、自己决定发不发。

---

## 3. 日志与敏感信息脱敏规则

安全红线（契约 §4.1 原文，必须原样遵守）：

> `SESSDATA`、`bili_jct`、`DedeUserID` **不得**进日志、不得进前端明文、不得进仓库、不得进崩溃上报。

工程约定（在红线之上补充的执行细则）：

| 对象 | 规则 |
|---|---|
| `SESSDATA` / `bili_jct` | 永不打印明文；日志里只允许出现「已设置 / 未设置」这类布尔事实 |
| `DedeUserID` | 属可识别标识，日志中以掩码或长度描述代替 |
| 用户标识（`vmid` / `uid` / `uids[]` / `mid` / `reply_mid` / `anchor_id` / `tuid`） | 与 `DedeUserID` 同口径：日志、错误文案里一律以 `***` 代替。`vmid` **就是**自身的 `DedeUserID`，`uids[]` 是关注的人——实测二者会随请求 URL 一起进 `debug` 日志（`x/relation/followings?vmid=…`、`Room/get_status_info_by_uids?uids[]=…`）。脱敏后仍看得出「哪个接口、哪个房间、第几页、这一批几个值」 |
| 昵称 / 用户名（`uname` / `nickname`） | 与 uid 同口径：以 `***` 代替（上游把请求原样回显时才有值可抹） |
| 房间号 / 短号 | 日志里**不**脱敏：公开信息，且是排障主键；但要意识到「房间 ↔ 主播」本身是公开可查的关联。**唯一例外是一键诊断导出的文件**（§2.9）：那份是要发给别人的，房间号也抹成 `***` |
| `config.toml` | 整文件视同凭据，不截图、不外发、不进仓库 |
| `Cookie` 请求头 | 打印请求时必须整体省略该头，不允许「截断显示前 6 位」这种折衷 |
| 二维码 key | 短时有效但视同凭据：分享日志前先替换 |
| `buvid3` / `buvid4` | 设备标识，与账号凭据同时出现可被关联；日志中以掩码或长度描述代替 |
| 弹幕内容 | 属用户数据，默认不进 `debug` 日志；需要时临时开启更高级别并按脱敏后外发 |

实现方式（改规则只改这一处）：键名表与替换逻辑在 `crates/danmubox-bili/src/redact.rs`，只改写「键名 + 分隔符 + 值」三种成分齐全的地方（上游原话 `CSRF 校验失败` 这类不带分隔符的文本保持原样）。出口只有两个，都在 `crates/danmubox-bili/src/http.rs`：`log_request`（所有 `GET` / `POST` 的 URL 日志）与 `upstream`（上游错误文案——`reqwest::Error` 的 `Display` 会把完整 URL 拼进去）。回显上游 `message` 的几处（`admin` / `send` / `report`）调的是同一个函数。占位符固定 `***`，不用短哈希：uid 只有 10 位数，短哈希能被离线暴力反推，「看起来脱敏」挡不住人。

一键诊断**导出的文件**走同一处规则、但更严一档：`redact.rs` 的 `redact_for_export` 在整份报告文本上先跑一遍上面的日志口径，
再抹**房间号**的键名形态（`room_id=` / `roomid=` / `room=`）与「本机已知的房间号 / 短号 / 主播 uid」的**裸数字**
（`getDanmuInfo` 的查询串是 `?id=…`，`id=` 认不出是不是房间号，因此按值抹）。导出链路因此只有这一个出口，
与日志共用同一张键名表。

> `danmubox::raw`（`docs/protocol.md` 附录 B.1）是唯一的例外：它按设计打印**原始业务载荷**，供协议字段校准用，里面自然带得到发言人的 uid 与昵称。核对字段时用它，分享日志前必须先按上表处理；只想看普通调试信息时别把这个 target 打开。

分享日志前的自查命令：

```bash
grep -niE 'sessdata|bili_jct|dede_user_id|dedeuserid|buvid3|vmid=|uids%5[Bb]%5[Dd]|anchor_id|tuid=' <日志文件或日志目录>   # 命中即先替换再外发
```

脱敏是否生效（**空输出 = 没有明文标识**）：

```bash
grep -nE '(vmid|uid|anchor_id|tuid)=[0-9]' <日志文件>   # 值为 *** 的行不会命中
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
| 3 | 公共下载目录里的诊断文件 | **只有你主动点过「一键诊断」才会有**：`/sdcard/Download/danmubox-diagnose-*.txt`（§2.9）。想留就留，不想留直接删；应用不往别处写，也不写应用私有目录 |
| 4 | 开发机上的签名材料 | **不要删除**（保留以便日后覆盖安装）；它不在手机上，属开发机资产。位置：`apps/desktop/src-tauri/gen/android/keystore.jks` 与同目录的 `keystore.properties`——两者被 `gen/android/.gitignore` 忽略，且**不在 `.android-env/` 内**，所以 `scripts/android-env.sh clean` 删不到它们；反过来说，清工具链时**别手工把它们一起删掉**，丢了只能靠卸载重装再回到同一签名。详见 §5.7 与 §5.12 |
| 5 | 设备上的安装包 | 手工删除此前 `adb push` / 传输的 APK |

### 4.4 卸载检查清单

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 无进程残留 | 三端均无 `danmubox` 进程 |
| 2 | 无数据目录残留 | §1.3 列出的路径均已清理 |
| 3 | 凭据文件已删 | `config.toml` 不再存在（含备份副本） |
| 4 | 重装可用 | 重新安装后能正常启动；因凭据已随文件删除，需重新扫码（或按 §1.4 手工编辑凭据文件） |
| 5 | 诊断文件（只有你导出过才有） | 桌面端 `~/Downloads/danmubox-diagnose-*.txt`、Android `/sdcard/Download/danmubox-diagnose-*.txt`：是**用户自己的产物**，不随卸载删除，要清就手工删 |

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
| 目标平台 | macOS / Windows / Android（iOS 与折叠屏适配为后期 enhancement；折叠屏的可行性研究见 [`foldable.md`](foldable.md)，**本次不实现**） |
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

日常出包命令与产物见 §1.6（独立可执行文件，前端已内嵌）。需要 `.dmg` 时**不用改 `tauri.conf.json`**：
`--bundles` 会覆盖 `bundle.active=false`，`icon: []` 也不拦 macOS 出包（2026-09-16 实测，命令与产物如下）：

```bash
cd apps/desktop && ./ui/node_modules/.bin/tauri build --bundles dmg
```

| 产物 | 路径 |
|---|---|
| 独立可执行（实测） | `<target-dir>/release/danmubox-desktop`（前端已内嵌，约 13 MB） |
| 安装镜像（实测 5,147,340 字节） | `<target-dir>/release/bundle/dmg/danmubox_0.1.0_<arch>.dmg` |

- `<arch>` 由构建机架构决定（Apple Silicon 为 `aarch64`，Intel 为 `x64`）。
- 交叉架构可在 Apple Silicon 上追加 `--target x86_64-apple-darwin`，产物落在 `<target-dir>/x86_64-apple-darwin/release/bundle/` 下。
- 本地运行不需要 DMG，直接从 `.dmg` 里拖出 `.app`，或用 §1.1 的开发期运行方式；要单独出 `.app` 用 `--bundles app`（本轮未实测）。
- `.dmg` **不做 Apple 签名与公证**，口径见 §5.5（拷到另一台自用 Mac 时按那一节处理 Gatekeeper）。

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

每个新 shell 先 source 一次项目内工具链（前置条件与体积见 §5.4，清除与重建见 §5.12）：

```bash
. scripts/android-env.sh     # 导出 JAVA_HOME / ANDROID_HOME / NDK_HOME / RUSTUP_HOME / CARGO_HOME / GRADLE_USER_HOME / PATH
cd apps/desktop
CI=true ./ui/node_modules/.bin/tauri android build --apk --ci                  # 通用包：一个 APK 含四个 ABI
CI=true ./ui/node_modules/.bin/tauri android build --apk --split-per-abi --ci  # 按 ABI 分包
```

- **`gen/android` 工程已入库**（`apps/desktop/src-tauri/gen/android/**`，43 个文件，属长期维护的源码），因此**不要再跑 `tauri android init`**：它会覆盖本仓库对模板的四处改（见下表）。
- `CI=true` 与 `--ci` 一起用，让 Tauri CLI 走非交互路径。
- **干净克隆可以直接构建**（2026-09-16 起）：`TauriActivity.kt` 与 `app/proguard-tauri.pro` **已入库**（`app/.gitignore` 对这两个路径写了 `!` 例外，其余 `generated/` 内容仍被忽略）。背景：`tauri android build` 只会（重新）生成 `app/src/main/java/…/generated/` 里 **wry** 那几个文件（`WryActivity.kt` 等）与 `app/tauri.properties` / `app/tauri.build.gradle.kts`；这两份则由 `tauri` crate 的 `build.rs` 从它的 `mobile/android-codegen/` 生成（把 `{{package}}` / `$PACKAGE` 替换成本包名），而 `app/.gitignore` 原先把 `generated/` 整个忽略 —— 于是新 worktree 与 CI 的干净检出里 Gradle 会以 `e: …MainActivity.kt: Unresolved reference: TauriActivity`（连带一串「overrides nothing」）失败（本仓实测连续两轮）。同版本 tauri 下这两份内容稳定，入库后干净检出不再需要任何手工补文件步骤；将来升 tauri 版本时 build.rs 会覆盖它们，按 diff 提交即可。
- `tauri android dev -- --device <serial>`（真机热重载）**未实测**，本仓库暂不写具体用法。

| 产物 | 路径 |
|---|---|
| 通用 APK（实测 52 MB，四个 ABI） | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| 分 ABI APK | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/<abi>/release/app-<abi>-release.apk`，`<abi>` ∈ `arm64` / `arm` / `x86` / `x86_64`（**不是** `armeabi-v7a` 这一族 Rust triple 名） |

- 没有 `keystore.properties` 时走未签名构建，产物名在 `-release` 之后再带一段 `-unsigned`（AGP 命名规则；本轮**未实测**这条路径）。**未签名的包装不进设备**：`adb install` 报 `INSTALL_PARSE_FAILED_NO_CERTIFICATES`。签名材料与由来见 §5.7。
- 自用装机只装 APK（不生成 AAB）。
- 默认构建包含官方支持的四个 ABI；`--split-per-abi` 只改产物粒度，不改编译目标是否已装。

**本仓库对上游模板的四处改**（重跑 `tauri android init` 会覆盖，需照下表重新打）：

| 位置 | 上游模板 | 本仓库 | 为什么 |
|---|---|---|---|
| `apps/desktop/src-tauri/gen/android/buildSrc/src/main/java/dev/kksk/danmubox/kotlin/BuildTask.kt` | `node tauri android android-studio-script` | 直接调 `ui/node_modules/@tauri-apps/cli/tauri.js`；找不到 CLI 时显式报错 | 模板那条把 `tauri` 当**相对 workingDir 的路径**交给 node 解析，只有 app 根目录是 npm 工程时才成立。本仓前端工程在 `apps/desktop/ui`、`apps/desktop` 下没有 `package.json`，模板原样必然报 `Cannot find module '<…>/src-tauri/tauri'`（2026-09-15 实测） |
| `apps/desktop/src-tauri/gen/android/app/build.gradle.kts` | **没有** signingConfig | 自建 `signingConfigs.release`，读 `gen/android/keystore.properties`；文件缺失即退回无签名 | 自用 release 包要能覆盖安装，见 §5.7 |
| `apps/desktop/src-tauri/gen/android/app/src/main/java/dev/kksk/danmubox/MainActivity.kt` | 只调 `enableEdgeToEdge()` | 从原生收 `WindowInsets`（系统栏含 ime）换算成 CSS 变量 `--safe-top` / `--safe-bottom` 下发给页面 | Tauri 的 Android 外壳是 edge-to-edge，而 **WebView 里拿不到系统栏高度**：`env(safe-area-inset-*)` 只报刘海（实测 top=129 / bottom=0 设备像素，同一次实测状态栏 128、手势栏 63）。不补这一步，顶栏会压进状态栏带、输入区会压进手势栏；见下方「已修」条目的实测数字 |
| `apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml` + 新增的 `…/dev/kksk/danmubox/KeepAliveService.kt`（`MainActivity` 里配套的 `onStart` / `onStop` 钩子也属这一组） | 权限只有 `INTERNET`，没有任何 `<service>` | 加 `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC` / `POST_NOTIFICATIONS` 三枚权限与 `<service android:name=".KeepAliveService" android:foregroundServiceType="dataSync" android:exported="false" />`；退到后台且有活跃连接时起、回到前台即停 | 后台保活：进程不被系统回收这一环。完整行为（怎么关、耗电、电池优化白名单、Android 15 的 6 小时额度）见 §2.8 |

实测（2026-09-15，模拟器 android-35）：Gradle 8.14.3 / AGP 8.11.0 / Kotlin 1.9.25；`aapt2 dump badging` 读到 package `dev.kksk.danmubox`、versionCode 1000、versionName 0.1.0、minSdk 24、targetSdk / compileSdk 36、`INTERNET` 权限在；带签名包 `apksigner verify` 为 `Verifies`（v2 签名）。

**已修（2026-09-15，提交 `32dcefc`）**：targetSdk 36 强制 edge-to-edge 带来的遮挡。改前实测：状态栏占 y=0..128、手势栏占 y=2337..2400，顶栏整条落在状态栏带里（标题文本 y=68..116、右上主题按钮 y=74..114，与系统电池图标重叠），房间页输入区压在手势栏下（白底画到 y=2399）。改后（同一 AVD）：顶栏文本 y=196..244、主题按钮 y=202..242、房间页顶栏底 0 → 128、房间页标题 52..88 → 180..216、输入区白底止于 2338，`am start -W` COLD `TotalTime` 515ms、logcat 无 FATAL。**动的是页面排版而不是窗口**：应用窗口修复前后都是 `[0,0][1080,2400]`，系统栏本身也没变（状态栏仍是 `[0,0][1080,128]`、手势栏仍是 `[0,2337][1080,2400]`）。做法与拒绝「给 WebView 设 padding」的理由见上表第三行与 `MainActivity.kt` 的注释。inset 里含 ime：**小列表页的键盘已验**（内容止于键盘上沿、无 pan 双位移），**登录态下房间页输入区 + 键盘的组合未验**（房间页输入框未登录时禁用，见 [`testing.md`](testing.md) §10.5）。

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
| **Android 工具链（本仓库口径）** | Android | 首次 `scripts/android-env.sh bootstrap`；之后每个新 shell `. scripts/android-env.sh` | **不再需要 Android Studio，也不再需要全局 `ANDROID_HOME` / `JAVA_HOME` / `NDK_HOME`**：官方那套「Android Studio + SDK Manager + 全局环境变量 + `rustup target add`」整体被仓库内的 `.android-env/` 取代（清单见下），宿主侧零安装 |
| Tauri CLI | 三端 | 前端脚本内 `@tauri-apps/cli`（`./ui/node_modules/.bin/tauri`） | 仓库不额外要求全局安装 `cargo-tauri` |

要点：

- **macOS 桌面只需 Xcode CLT**（本期不做 iOS 端）。
- **Windows 目标机需要 WebView2 运行时**。Windows 10/11 较新版本通常已预装；缺失时按 §5.6 处理。
- **Android 的四个 ABI target 与 NDK 缺一不可**；`--split-per-abi` 只影响打包粒度，不影响编译目标是否已安装。
- **Android 不再需要 Android Studio，也不需要全局 `ANDROID_HOME` / `JAVA_HOME` / `NDK_HOME`**：工具链全在仓库内，见下。

#### Android：仓库内工具链 `.android-env/`（`scripts/android-env.sh`）

```bash
. scripts/android-env.sh            # 导出环境（必须 source；直接执行无效）
scripts/android-env.sh bootstrap    # 从零安装，可重复执行（已装好的跳过）
scripts/android-env.sh clean        # 停 gradle daemon / adb server 后删除整个 .android-env
scripts/android-env.sh help         # 用法
```

装进 `.android-env/`（**仓库内**，已由根 `.gitignore` 忽略）的东西（2026-09-15 实测）：

| 目录 / 内容 | 说明 |
|---|---|
| `jdk17/`（309 MB） | Temurin JDK **17.0.20.1**，`JAVA_HOME` 默认指它 |
| `jdk21/`（336 MB） | Temurin JDK **21.0.12.1** 备选；`ANDROID_JDK=21` 切过去 |
| `sdk/`（8.0 GB） | `build-tools;35.0.0`、`cmdline-tools;latest 23.0.0`、`emulator;37.1.11`、`ndk;27.0.12077973`、`platform-tools;37.0.1`、`platforms;android-35`、`platforms;android-36`、`system-images;android-35;google_apis;arm64-v8a` |
| `rustup/`（993 MB）+ `cargo/`（269 MB） | 项目内 rustup / cargo：rustc 与 cargo **1.98.1**，含四个 android target（`aarch64-linux-android` / `armv7-linux-androideabi` / `i686-linux-android` / `x86_64-linux-android`） |
| `gradle-home/`（1.8 GB） | `GRADLE_USER_HOME`，内含 `org.gradle.daemon=false` |
| `android-user/`（2.0 GB） | `ANDROID_USER_HOME` / `ANDROID_AVD_HOME`（AVD 也建在这里） |
| `npm-cache/`、`tmp/` | `npm_config_cache` 与 `TMPDIR` |

总计约 **14 GB**。导出的环境变量：`JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`NDK_HOME`、`ANDROID_NDK_HOME`、`GRADLE_USER_HOME`、`RUSTUP_HOME`、`CARGO_HOME`、`ANDROID_USER_HOME`、`ANDROID_AVD_HOME`、`npm_config_cache`、`TMPDIR`，并把 `.android-env` 下各 `bin` 前置进 `PATH`（重复 source 不叠加）。**宿主侧不装任何东西**：`~/.gradle`、`~/Library/Android` 都不存在也不会被创建；唯一的宿主足迹是宿主 `cargo` 跑过本 workspace 时留下的几 KB 索引元数据（见 §5.12）。

#### Windows 前置条件（当前缺口）

Windows 端属独立工程，开工前先补齐（2026-09-12 本机核查）：

| 端 | 缺 | 已有 |
|---|---|---|
| Windows | `x86_64-pc-windows-msvc`（或 `-gnu`）target 与对应的链接器 / 工具链（macOS 无法交叉编译） | — |

Android 端这段缺口已在 2026-09-15 关闭：工具链由 `scripts/android-env.sh bootstrap` 装进仓库，出包、装进模拟器与启动均已实测（§5.3）。

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

自用 release 签名材料放在 gradle 工程根，**两个文件都在 `apps/desktop/src-tauri/gen/android/`**：

| 文件 | 内容 | 状态 |
|---|---|---|
| `keystore.jks` | 自用 keystore | 被 `gen/android/.gitignore`（`*.jks`）忽略，**不入库** |
| `keystore.properties` | 键 `storeFile` / `storePassword` / `keyAlias` / `keyPassword`（`storeFile` 相对 `gen/android/` 解析） | 同上，**不入库** |

- **这两个文件不在 `.android-env/` 内**，所以 `scripts/android-env.sh clean`（§5.12）删不到它们；反过来说，清工具链时**别手工把它们一起删掉**。
- **丢了会怎样**：换一份新 keystore 就等于换了签名 → 设备上已装的那个同名应用**装不上**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`），只能先卸载（连带清掉 `config.toml` 凭据，重装后要重新扫码）。两者都在 `.gitignore` 里，**仓库没有任何备份来源**，请自行异地留存。
- **缺 `keystore.properties` 不阻塞出包**：`app/build.gradle.kts` 的 `signingConfigs.release` 只在文件存在时创建，release 变为无签名（产物名带 `-unsigned`）。这种包装不进设备。
- **CI 出的包用的是另一份一次性签名**（现场 `keytool` 生成，随 run 消失），因此装过本机包的设备要先卸载；见 §5.13。

```bash
adb devices                                  # 确认设备已授权
adb install -r app-universal-release.apk     # 覆盖安装，保留应用数据
```

| 情况 | 处置 |
|---|---|
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | 装的是**未签名**包（没有 `keystore.properties` 的那次构建）→ 按上表确认签名材料在位后重新出包 |
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

### 5.12 Android 工具链的无痕清除与重建

`.android-env/`（§5.4 那套，约 14 GB）整个在仓库内、且已在根 `.gitignore` 里，因此**删掉它就等于把这台机器上的 Android 工具链卸干净**。不想留了、要给磁盘腾地方、或要换一套干净环境时：

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

**删完还剩什么**（2026-09-15 实测）：

| 位置 | 是否还在 | 说明 |
|---|---|---|
| `apps/desktop/src-tauri/gen/android/keystore.jks`、`keystore.properties` | **在** | 不在 `.android-env/` 内；**别手工连带删掉**（丢了要卸载重装，见 §5.7、§4.3） |
| `apps/desktop/src-tauri/gen/android/**` 其余部分 | 在 | 是要入库的工程源码，与工具链无关 |
| 宿主侧 `~/.gradle`、`~/Library/Android`、`~/.rustup`、`~/.cargo` | 不存在 | 脚本从不写这些位置；`clean` 前后都一样 |
| 宿主 rustup/cargo 的索引元数据 | 几 KB | 唯一的宿主足迹：宿主自身那份 `cargo`（非项目内那份）跑过本 workspace 时留下的索引元数据，与 `clean` 无关，清不清都行 |
| 宿主侧模拟器 / Java 的小文件 | **本次已清理** | 跑过模拟器与 Gradle 之后，宿主 `$HOME` 下仍会出现几个几 KB 的再生文件（它们不看 `ANDROID_USER_HOME`）：`~/.emulator_console_auth_token`、`~/.hawtjni/`（jansi 解包）、`~/.android/emu-last-feature-flags.protobuf`、`~/.android/emu-update-last-check.ini`、`~/.android/modem-nv-ram-<端口>`。`clean` 不碰它们（不在 `.android-env/` 内），不用模拟器时手工收一下即可：`rm -rf ~/.hawtjni ~/.emulator_console_auth_token ~/.android/emu-* ~/.android/modem-nv-ram-*`。2026-09-15 本轮已按此清干净，`~/.android` 只剩原有的 `adbkey` / `adbkey.pub` |
| 当前 shell 里已导出的 `JAVA_HOME` / `ANDROID_HOME` / `PATH` | 已失效 | `clean` 会提示：本 shell 之前 source 出来的那份变量指向已删除的目录，要重新 `bootstrap` + `. scripts/android-env.sh` |

**要重装**：一条命令重建（可重复执行，已装好的会跳过），再 source 一次即可继续出包：

```bash
scripts/android-env.sh bootstrap   # 重新装 JDK / SDK / NDK / emulator / rustup + 四个 android target
. scripts/android-env.sh
cd apps/desktop && CI=true ./ui/node_modules/.bin/tauri android build --apk --ci
```

代价：`bootstrap` 要重新下载数 GB（JDK、SDK、NDK、system-image、rustup 工具链），耗时以网络为准；**签名材料与 `gen/android` 不受影响**，重装后同一台设备仍可覆盖安装。

### 5.13 GitHub Actions CI（`.github/workflows/ci.yml`）

仓库只有这一套 CI，两个 job，都跑在 **`macos-14`（Apple Silicon）** 上：与开发机同平台 —— `check` 不必在 Linux 上另补 WebKitGTK 那一套系统依赖，命令与 [`../AGENT.md`](../AGENT.md) §3 的本机口径完全一致；`artifacts` 产出的也就天然是 arm64 产物。

| job | 做什么 | 触发 |
|---|---|---|
| `check` | `rustup component add rustfmt clippy` → `npm ci` → `npm run build`（= `tsc -b && vite build`）→ `cargo fmt --all -- --check`（**存量不通过，仅报告不拦**，见 [`../AGENT.md`](../AGENT.md) §9）→ `cargo clippy --workspace --all-targets -- -D warnings` → `cargo test --workspace` | push 到 `main`、任何 `pull_request`、手动 `workflow_dispatch` |
| `artifacts` | 出**两个**产物并上传：① macOS `tauri build --bundles dmg` → `.dmg`；② Android `tauri android build --apk --ci` → **已签名的** release APK | 仅 `workflow_dispatch` 与 `v*` tag（每次 push 都出包太贵） |

缓存：`check` 缓存 `~/.cargo/registry`、`~/.cargo/git` 与 `target/`（键含 `Cargo.lock` 哈希）；两个 job 都用 `actions/setup-node` 内建的 npm 缓存（`apps/desktop/ui/package-lock.json`）。`artifacts` **不缓存** Gradle 与 release `target`：Gradle 依赖缓存近 GB 级、恢复比重新下载还慢，release `target` 还要乘上四个 ABI，收益为负；该 job 本来就只在手动 / 打 tag 时跑。

#### 手动触发与取产物

网页：仓库 → **Actions** → 左侧 `CI` → **Run workflow**（选分支）→ 跑完后在该 run 页面底部的 **Artifacts** 区下载：

| 产物名 | 内容 | 在仓库里的来源路径 |
|---|---|---|
| `danmubox-macos-dmg` | `danmubox_0.1.0_aarch64.dmg` | `target/release/bundle/dmg/*.dmg` |
| `danmubox-android-apk` | `app-universal-release.apk`（四个 ABI 的通用包） | `apps/desktop/src-tauri/gen/android/app/build/outputs/apk/*/release/*.apk` |

产物保留期用仓库默认（公开仓库 90 天），过期即失效，要长期留存就自己下下来。

#### 在本机出同样两个产物

就是 §5.3 里那两条命令（CI 用的也是它们）：

```bash
# ① macOS .dmg（bundle.active=false 靠 --bundles 覆盖；不需要应用图标）
cd apps/desktop && ./ui/node_modules/.bin/tauri build --bundles dmg
#    产物：<repo>/target/release/bundle/dmg/danmubox_0.1.0_aarch64.dmg

# ② Android 已签名 release APK（先 source 一次项目内工具链，见 §5.4）
. scripts/android-env.sh
cd apps/desktop && CI=true ./ui/node_modules/.bin/tauri android build --apk --ci
#    产物：apps/desktop/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

两条都要先装前端依赖（`tauri` CLI 与前端构建都在 `apps/desktop/ui/node_modules` 里）：`npm --prefix apps/desktop/ui install`（CI 里用 `npm ci`）。

#### 签名口径差异（**CI 产物与本地产物签名不同**）

- 本机的签名材料是 `gen/android/keystore.jks` + `keystore.properties`（自用私钥，已被 gitignore，**绝不入库、绝不进 CI**，见 §5.7）。
- CI 上不用也不该用这份私钥：`artifacts` job 用 `keytool -genkeypair` **现场生成一次性 keystore**（写进 `keystore.properties` 的四个键；口令由 `github.run_id` / `run_attempt` 派生，只活在本次 run 里，run 结束即消失），因此 CI 的 APK 签名**有效但与本机不同**。
- 后果：**设备上已装过本机包时，CI 包装不上**（`INSTALL_FAILED_UPDATE_INCOMPATIBLE`）—— 先 `adb uninstall dev.kksk.danmubox` 再装（卸载会清数据，`config.toml` 凭据要重新扫码，见 §4.3 与 §5.7）。
- macOS 的 `.dmg` 不做 Apple 签名与公证，与 §5.5 的本机口径一致。
- CI 里的 `keytool` 与 `sdkmanager` 只出现在 *run 步骤的 shell 里*，工作流文件中不含任何口令明文。

#### 冒烟不在 CI 里跑

`apps/desktop/ui/smoke/run-headless.mjs` 的两引擎冒烟**没有**纳入 CI —— 这是刻意的取舍，不是漏项。先排除一条常见误解：**它不需要真实网络，也不需要真实直播间**（自己 `npm run build` 出 `dist`，页内注入 `__TAURI_INTERNALS__` 替身、假 IPC 与夹具样本，`ui.md` §15）。不纳入的理由是另外三条：

1. **成本**：验证矩阵是 **2 引擎 × 2 视口 × 2 主题**。Chromium 那一路要一台 Chrome for Testing，WebKit 那一路要 `npx playwright install webkit`（数百 MB 的浏览器产物）；再算上宿主机侧旁证链路的 `swift smoke/wkwebview-host.swift`。每个 PR 都跑这一套不划算。
2. **稳定性**：WebKit 无头在内存紧张时会崩（`page.evaluate: Target crashed`），而且**看起来像「某一段场景必崩」**——脚本自己的注释就记着这个假象（重试上限 1 次，两次都崩才报失败）。它在本机是有兜底的临时现象，放进 CI 就变成随机红，反而掩盖真问题。宿主机侧那条旁证链还有个硬限制：**没有显示会话时 rAF 不持续产帧**，「跟随最新 / 虚拟列表窗口」一类断言会假失败。
3. **它验的是集成后的那棵树**：[`../AGENT.md`](../AGENT.md) §9 与 [`ui.md`](ui.md) §15 已经把口径定死——全量无头冒烟由**主流程在集成收尾时统一跑一次**，在分支 / PR 上跑结果不可比，也不该由 CI 代替。

所以冒烟仍在**本机 / 主流程**跑（命令与门槛见 [`ui.md`](ui.md) §15、[`testing.md`](testing.md) §9.2 与 §10）：`cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs`（Chromium）与 `node smoke/run-headless.mjs --engine webkit`（宿主引擎）两遍。

#### 本地验证到什么程度（如实口径）

| 项 | 状态 |
|---|---|
| `npm ci` / `npm run build` / 三条 Rust 命令 / `tauri build --bundles dmg` | **本机实测过**，产物路径即上文与 §5.3（`cargo fmt` 的不通过属存量，见 [`../AGENT.md`](../AGENT.md) §9） |
| `tauri android build --apk --ci` | **本机干净 worktree 上真跑完过**（rc=0；`npm ci` 22 秒 + 构建，合计 381 秒；四个 ABI 全部编出，产物 `…/apk/universal/release/app-universal-release-unsigned.apk`）。那份 worktree 没有本地 keystore，所以是**未签名**产物；CI 里先造一次性 `keystore.properties`，产物名是 `app-universal-release.apk`（上传用的是 `*/release/*.apk` 通配，两种命名都覆盖） |
| Android 工具链在 **runner 上**的安装（`setup-java`＋`setup-android`＋`sdkmanager` 装 `platform-tools` / `platforms;android-36` / `build-tools;35.0.0` / `ndk;27.0.12077973`，再写 NDK 链接器 `config.toml`） | **未在 runner 上验证**：它是本机 `scripts/android-env.sh` 的等价改写（版本号、包名、linker 路径都取自该脚本与本机实测），但 GitHub runner 的 `sdkmanager` 版本与包名写法（`;` / `/` 两种形式一一对应，见脚本注释）只能等第一次真跑才见分晓 —— 工作流里因此写了「先 `;` 后 `/`」的兜底重试 |
| CI 工作流本身 | 从未在本仓库真实运行过（本轮只做了 YAML 可解析 + 每条命令的本机等价核对） |

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
