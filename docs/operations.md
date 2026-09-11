# 运行与运维

> 定位：danmubox 的日常启动停止、数据文件位置、凭据文件维护、故障排查与卸载清理。
> 读者：日常使用与排障的仓库所有者本人；需要读取应用数据目录的维护者。
> 更新时机：新增/更名环境变量、数据目录或文件名变化、新增 IPC 命令、新增卸载残留位置时必须同步本文。

---

## 1. 日常操作

### 1.1 启动与停止

| 平台 | 启动 | 停止 |
|---|---|---|
| macOS | 双击 `danmubox.app`；开发期 `npm run tauri dev` | 关闭窗口即退出（本期不做后台保活）；异常残留用活动监视器结束 `danmubox` |
| Windows | 开始菜单 / 桌面快捷方式，或运行安装目录下的 `danmubox.exe` | 关闭窗口即退出；异常残留用任务管理器结束 `danmubox.exe` |
| Android | 桌面图标，或 `adb shell monkey -p dev.kksk.danmubox -c android.intent.category.LAUNCHER 1` | 从最近任务划掉；彻底停止用「设置 → 应用 → danmubox → 强制停止」 |

应用为纯客户端形态，不启动任何本地网络服务：界面通过 Tauri IPC 与引擎通信，二者之间不需要任何访问凭据（契约 §7）。构建与产物见 `distribution.md`。

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
| stdout / stderr | 前台运行时直接可见 |
| 数据目录下的 `logs/` | 桌面端（GUI 启动时 stdout 不可见）；实际路径以 `app_info` 返回的数据目录为准 |
| `danmubox://log` | Tauri IPC 事件，供前端调试面板订阅（契约 §7） |

### 1.3 数据目录与文件位置（三端）

数据目录下只有凭据文件、偏好文件与桌面端日志；弹幕只在内存，不落盘（契约 §4.3）。

| 平台 | 数据目录 | 典型内容 |
|---|---|---|
| macOS | `~/Library/Application Support/danmubox/` | `config.toml`、`prefs.json`、`prefs.json.bak`、`logs/` |
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

### 1.4 凭据文件 `config.toml`：查看、权限与手工填 Cookie

需求直接来源：REQUIREMENTS.md「cookie 弄个配置文件存进去，默认扫码登录，如果本地有 cookie 则直接读取」。凭据以**明文 TOML** 存放，靠文件权限（`0600`）与「只在本机数据目录」约束，不加密（契约 §4.1）。

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

启动顺序：读文件 → 取 `active_profile` 指向的 profile，其 `sessdata` / `bili_jct` / `dede_user_id` 三者齐全且非空则直接进入登录态；否则走扫码（默认入口），扫码成功后原子写回该 profile。

#### 查看与权限确认

| 平台 | 查看内容 | 确认权限 | 修复权限 |
|---|---|---|---|
| macOS | `cat ~/Library/Application\ Support/danmubox/config.toml` | `ls -l` 应显示 `-rw-------`（只有属主可读写） | `chmod 600 ~/Library/Application\ Support/danmubox/config.toml` |
| Windows | 记事本打开 `%APPDATA%\danmubox\config.toml` | `icacls "%APPDATA%\danmubox\config.toml"` 应只见当前用户（SYSTEM / Administrators 可接受） | `icacls "%APPDATA%\danmubox\config.toml" /inheritance:r /grant:r "%USERNAME%":F` |
| Android | 无桌面式直接访问；文件位于应用私有目录，其他应用不可读 | 无需手工确认（应用私有目录即隔离边界） | 无需处理 |

安全提醒：`config.toml` 整文件等同账号控制权，**不要**贴进聊天、issue、日志或截图；排查时只看「哪个字段是否为空」，不要展示取值。

#### 手工填入 Cookie（相当于「手填 Cookie」入口）

本设计不另做导入界面，手填即**直接编辑该文件**：

1. 退出应用（避免写入竞争）。
2. 备份现有文件（复制为 `config.toml.bak`）。
3. 从浏览器 DevTools 的 Application → Cookies → `bilibili.com` 复制 `SESSDATA`、`bili_jct`、`DedeUserID`，填入 `active_profile` 指向的 `[profiles.<name>]` 的 `sessdata` / `bili_jct` / `dede_user_id`；其余字段可留空。
4. 确认文件权限为 `0600`（见上表）。
5. 重新启动应用：三项齐全即直接进入登录态，无需扫码。

登出（界面登出，对应 `session_logout`）会清空当前 profile 的凭据并回到游客态；`buvid3` 为设备标识，可从文件保留或重新获取。

### 1.5 偏好文件 `prefs.json`

界面偏好只存 `prefs.json`（不写进 `config.toml`），形态是**单层 JSON 对象**，键为契约 §8 的唯一权威清单（如 `ui.font_scale`、`ui.theme`、`ui.gift_panel_mode`、`filter.keywords`、`history.buffer_rows`）。只存被显式改过的键，缺失的键回落到默认值（契约 §4.2）。

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
| JSON 解析失败（损坏） | 按默认值启动，并把损坏副本保留为 `prefs.json.bak` |
| 正常写入 | 原子替换（临时文件 + rename），不会出现写一半的半成品文件 |

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
| 4 | `SESSDATA` 是否过期／失效 | 手填的凭据过期 → 重新扫码，或按 §1.4 更新 `config.toml` |
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

发弹幕返回 `SendOutcome`（契约 §5），必须先看它、再看界面表现；前端为乐观更新，失败会回滚并保留草稿，**不要**以「界面上出现过」判定发送成功。

| `SendOutcome` | 判定依据 | 含义与动作 |
|---|---|---|
| `ok` | 上游返回成功 | 已进入公开弹幕流；若直播间看不到，多为房间侧延迟或屏蔽，换账号/换视角复核 |
| `blocked_platform` | 上游响应 `msg` / `message` == `"f"` | 被平台风控/拦截吞掉，**不是**普通错误码；内容会回显在 `data.mode_info.extra`（JSON 字符串）的 `content` 字段。改写内容后重试，勿连点 |
| `blocked_room` | 上游响应 `msg` / `message` == `"k"` | 被直播间（主播/房管）吞掉；内容同样回显在 `data.mode_info.extra.content`。换房间验证，属房间侧设置 |
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
| 4 | 前端资源是否随包 | 打包遗漏或路径错误 → 重新构建前端后重新打 APK |
| 5 | 是否只在特定页面白屏 | 定位到具体组件；核心逻辑在 Rust，UI 属渐进增强（见 `architecture.md`） |
| 6 | 换设备是否复现 | 单设备复现 → 设备侧 WebView 环境问题 |

### 2.7 扫码不刷新

| 判定顺序 | 观察点 | 结论与动作 |
|---|---|---|
| 1 | `session_qr_start` 是否成功拿到二维码 | 失败 → 先解决网络 / 上游问题，读错误信息 |
| 2 | `session_qr_poll` 是否在持续轮询 | 前端未轮询 → 检查轮询定时器；建议间隔 2 秒，不得低于 1 秒 |
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
grep -niE 'sessdata|bili_jct|dede_user_id|dedeuserid|buvid3' <日志文件或 logs 目录>   # 命中即先替换再外发
```

提交仓库前：确认无 `config.toml`、无 keystore、无 `.p12`、无导出的 Cookie 文本。

---

## 4. 卸载与残留清理

卸载前务必确认：`config.toml` 含账号控制权凭据，删除或卸载即**永久丢失**，重装后需重新扫码或重新手填。

### 4.1 macOS

| # | 残留位置 | 清理方式 |
|---|---|---|
| 1 | `/Applications/danmubox.app` | 拖入废纸篓 |
| 2 | `~/Library/Application Support/danmubox/` | `rm -rf`（含 `config.toml`、`prefs.json`、`prefs.json.bak`、`logs/`） |
| 3 | 隔离属性 | 无需处理，随文件删除 |
| 4 | 登录项 / LaunchAgents | 本项目不注册，无需处理 |

### 4.2 Windows

| # | 残留位置 | 清理方式 |
|---|---|---|
| 1 | 程序本体 | 「设置 → 应用 → 已安装的应用 → danmubox → 卸载」 |
| 2 | `%APPDATA%\danmubox\` | 删除（含 `config.toml`、`prefs.json`、`prefs.json.bak`、`logs/`） |
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
| 4 | 重装可用 | 重新安装后能正常启动；因凭据已随文件删除，需重新扫码或按 §1.4 手填 |

---

## 附录 A：待实测校准（B 站线上行为）

下表各项为契约已采用的协议要点，其**具体取值与判据**必须用真实连接/发送复核后写死；在实测回填前不得当作既成事实引用。核对方法统一为：`DANMUBOX_LOG=debug` 启动 → 复现对应场景 → 读取日志 / `danmubox://log` 事件原文。

| # | 待测项 | 现状 | 核对方法 | 责任人动作 |
|---|---|---|---|---|
| 1 | 发弹幕被吞判据 | `msg`/`message` == `"f"` → `blocked_platform`，`"k"` → `blocked_room` | 用真实账号发送可触发拦截的内容，记录响应原文与 `data.mode_info.extra` | 复核后把判据与回显路径写死到 `danmubox-bili`，并同步 `protocol.md` |
| 2 | 房间解析接口 | `getRoomPlayInfo` 一次返回 `room_id` / `uid` / `live_status` | 用短号与完整 URL 各解析一次，对比字段 | 确认字段名与含义后回填 `protocol.md` |
| 3 | HTTP 心跳 | `live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat`，每 60s，`hb=base64("60|<真实room_id>|1|0")` | 抓包比对官方 web 客户端；缺心跳时观察是否被判死 | 实测确认端点、参数与周期 |
| 4 | WS 心跳 body | 字面量 `[object Object]`（`op=2`，帧头 `protover=1`） | 抓包比对官方 web 客户端 | 实测确认字面量拼写 |
| 5 | `DANMU_MSG` 取值路径 | 内容 `info[1]`；用户对象 `info[0][15].user`（`uid` / `base.name` / `base.face`） | 发送一条已知弹幕，在日志中查字段路径 | 确认后写死并同步 `protocol.md` |
| 6 | `INTERACT_WORD_V2` 载荷 | protobuf，从 `data` 字段 base64 解码 | 抓一条真实进入消息解码验证 | 确认 schema 字段后写死 |
| 7 | `upstream_id`（举报必需） | 来源未定 | 从真实弹幕包中定位可用于举报的标识字段 | 实测确认后回填契约 §5 与 `protocol.md` |

规则：**校准表里的数字必须来自实测**。表格空着是允许的（表示尚未测量），但不得填入推测值、不得编造具体数值。

---

## 5. 相关文档

| 文档 | 关联点 |
|---|---|
| [`contract.md`](contract.md) | 本地文件、常量、`SendOutcome`、IPC 命令、偏好键的唯一事实源 |
| [`auth.md`](auth.md) | 三种登录模式、扫码状态机、凭据字段与失效处理 |
| [`protocol.md`](protocol.md) | WS 包结构、心跳、重连、消息取值路径 |
| [`ipc.md`](ipc.md) | 前端命令与事件名、调试面板订阅 |
| [`ui.md`](ui.md) | 房间内「刷新」按钮、连接状态展示、发送失败回滚 |
| [`architecture.md`](architecture.md) | 进程拓扑、并发模型、可观测性 |
| [`distribution.md`](distribution.md) | 三端构建、安装、签名与自用更新 |
| [`testing.md`](testing.md) | 三端手工冒烟清单，用于验证排障动作是否生效 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本变更记录 |
