# 登录与鉴权

> 定位：danmubox 与 B 站之间的身份、凭据、签名与失效处理规范，是 `core` 的 `AuthProvider` 端口、`danmubox-bili` 的鉴权实现及所有上层消费面的唯一权威说明。
> 读者：实现 `danmubox-bili` 鉴权/协议适配的 Rust 工程师、接 `session_*` IPC 的前端作者、审阅凭据落盘方式与安全红线的评审者。
> 更新时机：B 站登录接口或扫码状态码变更、WBI 签名算法或置换表变更、Cookie 字段集合变更、`config.toml` 字段或权限约定变更、安全红线调整时。

---

## 1. 范围与模块边界

本文件只管鉴权面：WS 包结构与认证包二进制格式、心跳与重连见 `protocol.md`；房间解析与消息归一化见 `protocol.md`；IPC 命令签名与事件载荷见 `ipc.md`；界面渲染见 `ui.md`。

### 1.1 职责划分（规范性）

| 层 | 职责 | 禁止 |
|---|---|---|
| `danmubox-core` 端口 `AuthProvider` | 定义登录态、凭据读写、扫码流程、`buvid3` 的 trait 与领域模型（§8.6 的脱敏对象） | 出现任何 B 站 URL、字段下标、签名算法；依赖 `tauri` 或 UI |
| `danmubox-bili`（`AuthProvider` 实现） | 实现扫码、WBI 签名、`getDanmuInfo`、`buvid3`、凭据字段语义；**所有 B 站 URL、字段名、签名只在此出现** | 依赖 `tauri`；把凭据写入日志 |
| `danmubox-core` 本地文件层 | `config.toml` / `prefs.json` 的读写、原子替换、权限（契约 §4） | 解释 B 站字段的协议语义 |
| `danmubox-cli` / `apps/desktop/src-tauri` | 经 `AuthProvider` 驱动登录，向前暴露**脱敏后**的状态 | 自行读 `config.toml` 拼 Cookie；自行实现签名 |
| 前端（React/TS） | 渲染二维码、展示登录态、触发命令 | 接触任何 Cookie 值、参与签名计算 |

> **后期想法（本期不实现）**：接入 MCP，让 Agent 直接消费弹幕数据。架构上保持兼容——`core` 的端口与事件总线不得假设消费方是 UI。

### 1.2 一次登录请求的调用链

```
前端 / CLI
      │  invoke session_qr_start
      ▼
core::AuthProvider（端口）──► danmubox-bili 的实现
      │                          └─ passport 扫码接口（generate）
      │                            返回 { qrcode_key, url }
      │  invoke session_qr_poll
      ▼
danmubox-bili::auth ──► passport 扫码接口（poll）
      │                    └─ 成功时响应 Set-Cookie 带回凭据集
      │  凭据 ──► 原子写回 config.toml 中 active_profile 指向的 profile（§8.3）
      ▼
danmubox-bili::auth ──► nav（取 img_key / sub_key）──► WBI 签名（§4）
      │
      ▼
getDanmuInfo（Cookie + wts + w_rid）──► { token, host_list }（§5）
      │
      ▼
WS wss://{host}:{wss_port}/sub ──► op=7 认证包（key=token, buvid=buvid3, protover=3）
```

`getDanmuInfo` 与认证包字段的对应关系见 §5.4；认证包的二进制格式见 `protocol.md`。

---

## 2. 三种登录模式

三种模式互斥，任一时刻只有一套生效凭据，落盘位置是 `config.toml` 中 `active_profile` 指向的那份 profile（契约 §4.1）；切换模式等于覆盖写回该 profile。**扫码是默认入口**（契约 §2、§4.1）。

| 维度 | 游客 `anonymous` | 手填 Cookie `cookie` | 扫码 `qrcode` |
|---|---|---|---|
| 默认性 | 未登录时的回退态 | 备选（排障与快速恢复） | **默认入口** |
| 用户动作 | 无 | 直接编辑 `config.toml`（§8.4） | 手机 B 站 App 扫一次码并确认 |
| 本地凭据 | 仅 `buvid3` / `buvid4`（非账号凭据） | 当前 profile 的全套字段 | 当前 profile 的全套字段 |
| 收弹幕 | 可收大部分 `danmaku` / `gift` / `superchat` / `interact` / `guard` / `system` | 完整 | 完整 |
| 昵称与 UID | 部分被掩码，`uid` 常为 0，`uname` 可能为掩码串 | 完整 | 完整 |
| 粉丝牌字段 | 可能缺失（`medal_level` / `medal_name` 为空值） | 完整 | 完整 |
| 发弹幕 | 不可（上游返回未登录错误） | 可（`bili_jct` 提供 `csrf`） | 可 |
| 被限流概率 | 较高 | 低 | 低 |
| 凭据有效期 | 不适用（`buvid3` 长期有效） | 取决于所填 `SESSDATA` 的剩余寿命 | 由服务端下发，本地无权威过期时间 |
| 泄露风险 | 无账号风险 | 取决于用户怎样保存/传递该文件 | 最低（凭据不经人手） |
| 适用场景 | 只看弹幕、不发言、快速试用 | 跳过扫码；扫码不可用时的兜底 | 日常使用 |
| `mode` 取值 | `anonymous` | `cookie` | `qrcode` |

### 2.1 模式选择的实现规则（规范性）

1. 启动时 `config.toml` 缺失、或 `active_profile` 指向的 profile 凭据不全 → `mode = "anonymous"`、`logged_in = false`，用已有的 `buvid3` 走游客链路（§8.2）。
2. 用户点击登录 → 默认进入扫码流程；`cookie` 模式只能由用户直接编辑文件产生，**不提供**导入界面或导入命令。
3. 扫码成功后 `mode = "qrcode"`；启动时读到齐全凭据则 `mode = "cookie"`。
4. 登出（`session_logout`）只清空 `active_profile` 指向 profile 的账号凭据并回到 `anonymous`，其它 profile 不受影响；`buvid3` / `buvid4` 是否一并清除见 §3.3。
5. 切换账号（`profiles_switch`）= 改 `active_profile` + 以新凭据重建连接，**不复制多份文件**（契约 §4.1）；切换后按新 profile 的凭据重新判定 `mode` 与 `logged_in`。
6. `mode` 是**来源标记**，不是能力开关：能力判定只看当前 profile 的凭据是否齐全（`SESSDATA` + `bili_jct` 同时存在才允许发弹幕，§7）。

---

## 3. `buvid3`：设备标识的获取与位置

### 3.1 获取流程

| 项 | 值 |
|---|---|
| 接口 | `GET https://api.bilibili.com/x/frontend/finger/spi` |
| 请求头 | 常规 `User-Agent`；无需登录、无需签名 |
| 响应字段 | `data.b_3` → `buvid3`；`data.b_4` → `buvid4` |
| 实测结果（2026-09-11） | `code = 0`，`message = "ok"`，`data.b_3` / `data.b_4` 均为字符串 |
| 调用时机 | 进程启动时惰性获取（首次需要构造带 Cookie 的请求时）；失败则按退避重试，不阻塞启动 |

### 3.2 在请求链中的位置

`buvid3` 是**设备级**标识，与账号无关，因此它是唯一在游客模式下也携带的 Cookie。它出现在三处：

| 位置 | 形式 | 说明 |
|---|---|---|
| 上游 REST 请求头 | `Cookie: buvid3=<值>; buvid4=<值>` | 作用于 `live.bilibili.com` 等接口，供风控识别设备 |
| WS 认证包 body | `"buvid": "<buvid3 值>"` | 契约 §6 认证包的 `buvid` 字段，游客与登录态都必须填 |
| 本地持久化 | `config.toml` 当前 profile 的 `buvid3` / `buvid4` 字段 | 见 §3.3；不使用偏好文件 |

注意：`buvid3` **不是** WBI 签名的输入，也不进入 `w_rid` 计算（签名输入见 §4.1）。它只在请求头与认证包里出现。

### 3.3 持久化与生命周期

- `buvid3` / `buvid4` 首次获取后写入 `active_profile` 指向 profile 的对应字段（契约 §4.1 字段表），后续进程复用，避免每次启动都换设备指纹（频繁变更会触发风控重新评估）。
- 登出**不清除** `buvid3` / `buvid4`：它们不绑定账号，清除反而使设备指纹抖动。
- 敏感级别：低（无账号绑定），但与 `SESSDATA` 同时出现时二者可被关联到同一设备，因此仍不得进入日志。

---

## 4. WBI 签名

`getDanmuInfo` 等 `live.bilibili.com` 接口受 WBI 风控保护，未携带合法签名时上游返回 `code = -352`。签名计算全部在 `danmubox-bili` 内完成，前端不感知算法。

### 4.1 输入

| 输入 | 来源 | 说明 |
|---|---|---|
| `img_key` | `nav` 响应 `data.wbi_img.img_url` 的 basename（去目录、去扩展名） | 实测当日值形如 32 位十六进制字符串 |
| `sub_key` | `nav` 响应 `data.wbi_img.sub_url` 的 basename | 同上 |
| `wts` | 本地生成的**秒级** Unix 时间戳 | 必须参与排序与签名 |
| 参与签名的 query | 本次请求除 `w_rid` 外的全部业务参数 | 例如 `getDanmuInfo` 的 `id`、`type` |
| 混入密钥 `mixin_key` | 由 `img_key` + `sub_key` 经置换表导出，见 §4.5 | 不随请求变化，随 key 轮换 |

`nav` 接口无需登录也无需签名；即使未登录（响应 `code = -101`、「账号未登录」），`data.wbi_img` 依然返回（实测确认）。

### 4.2 取 key

| 项 | 值 |
|---|---|
| 接口 | `GET https://api.bilibili.com/x/web-interface/nav` |
| 路径 | `data.wbi_img.img_url`、`data.wbi_img.sub_url` |
| basename 规则 | 取最后一个 `/` 之后、去掉最后一个 `.` 及其后缀的片段 |
| 实测样例（2026-09-11） | `img_url` → `https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png`，`img_key = 7cd084941338484aae1ad9425b84077c` |
| 长度 | `img_key` 与 `sub_key` 各 32 字符，拼接后 64 字符 |

### 4.3 按日缓存的必要性

`img_key` / `sub_key` 由服务端**按自然日轮换**。若进程跨日运行仍复用旧 key，签名会整体失效，所有受 WBI 保护的接口开始返回 `-352`——表现为「弹幕看着正常但每隔一阵拉不到 `getDanmuInfo`」。因此：

1. 缓存结构为 `{ img_key, sub_key, mixin_key, fetched_at_day }`，`fetched_at_day` 为 UTC+8 的日期。
2. 命中条件：`fetched_at_day == 今天`；否则重新调 `nav`。
3. 兜底：任何受保护请求返回 `-352` 时，强制刷新 key 并**重试一次**；仍为 `-352` 则向上报 `UPSTREAM_ERROR`，不得无限重试。
4. 缓存仅存于内存，不落盘（key 无长期价值，落盘只是多一处可泄漏面）。

### 4.4 签名步骤

1. 取 `img_key` 与 `sub_key`（§4.2）。
2. 拼接 `raw = img_key + sub_key`（64 字符）。
3. 按置换表重排：`mixin_key = (''.join(raw[i] for i in MIXIN_KEY_TAB))[:32]`——先按 `MIXIN_KEY_TAB` 取字符，再截断到 32 位。
4. 组装参与签名的参数集合 `P`：本次请求的全部 query 参数，外加 `wts`（秒级）。**`w_rid` 本身不参与**。
5. 值清洗：把 `P` 中每个值里的 `!` `'` `(` `)` `*` 五个字符删掉。
6. 排序并编码：按参数名字典序升序排列，做 `application/x-www-form-urlencoded` 编码，得到 `query`。
7. 计算 `w_rid = md5(query + mixin_key)`，十六进制小写。
8. 用 `query + "&w_rid=" + w_rid` 作为最终 query 发起请求。

`MD5` 在此处是协议要求的摘要，不用于任何安全用途，注释中应写明以免被误当加密算法替换。

### 4.5 混入密钥置换表

下表为 64 个下标（0-based），指向 `raw` 的位置。**该表已于 2026-09-11 通过真实请求实测确认**（核验方法见 §4.7），非推测值：

| 行 | 下标（每行 8 个） |
|---|---|
| 0 | 46, 47, 18, 2, 53, 8, 23, 32 |
| 1 | 15, 50, 10, 31, 58, 3, 45, 35 |
| 2 | 27, 43, 5, 49, 33, 9, 42, 19 |
| 3 | 29, 28, 14, 39, 12, 38, 41, 13 |
| 4 | 37, 48, 7, 16, 24, 55, 40, 61 |
| 5 | 26, 17, 0, 1, 60, 51, 30, 4 |
| 6 | 22, 25, 54, 21, 56, 59, 6, 63 |
| 7 | 57, 62, 11, 36, 20, 34, 44, 52 |

实现约束：该表 MUST NOT 被散落在多处，MUST 只在 `danmubox-bili` 的 WBI 模块中定义一次；表内容变更属于协议变更，必须同步改本文与 `../CHANGELOG.md`。

### 4.6 失败症状与排查

| 症状 | 含义 | 处理 |
|---|---|---|
| `code = -352`、`message = "-352"` | 风控校验失败：key 过期、置换表不符、值清洗遗漏、参数漏签 | 刷新 key 重试一次；仍失败按 §4.7 复核算法 |
| `code = -352` 且**所有**受保护接口同时失败 | 几乎一定是 key 轮换或算法变更 | 先刷新 key，再复核置换表 |
| 游客正常、登录后失败 | 与签名无关，方向应转向凭据/Cookie，见 §10 | 检查 `SESSDATA` 是否失效 |

### 4.7 算法自检（可复现的核对方法）

判断「置换表是否仍然有效」只需两步，无需分析流量：

1. 取当日 `nav` 的 `img_key` / `sub_key`，用本文公式算出 `mixin_key`。
2. 对 `GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=1&type=0` 加上 `wts` 与 `w_rid` 发起请求，携带 `buvid3`。

判据：正确算法返回 `code = 0` 且 `data.host_list` 非空；把 `mixin_key` 换成 `raw[:32]` 或空串则返回 `code = -352`。2026-09-11 实测结果正是如此（正确 → `0`，错误 → `-352`），故 §4.5 的表成立。若某天「正确表」也开始返回 `-352`，即算法或表已变更，需按同一方法重新校准。

---

## 5. `getDanmuInfo`

在 WBI 签名与 `buvid3` 就绪后调用，换取弹幕服务端的 WS 地址与认证 token。契约 §6 规定：需要 `buvid3` Cookie 与 WBI 签名。

### 5.1 请求

| 项 | 值 |
|---|---|
| 方法/URL | `GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo` |
| `id` | 真实房间号（非短号）。短号/URL 经 `getRoomPlayInfo` 一次解析出 `room_id` / `uid` / `live_status`（契约 §6） |
| `type` | `0` |
| `wts` | 秒级时间戳，见 §4.4 |
| `w_rid` | WBI 签名 |
| 请求头 | `Cookie: buvid3=...; buvid4=...`（登录态再附凭据集）；`Referer: https://live.bilibili.com/` |

### 5.2 响应字段

实测样例（2026-09-11，`id=1` 与两个其他房间）：

| 字段 | 类型 | 实测/说明 |
|---|---|---|
| `code` | int | `0` 为成功 |
| `data.token` | string | WS 认证包的 `key`；实测长度 244–252 字符，**长度随服务端策略变化，代码中不得断言长度** |
| `data.host_list` | array | 实测 6 项；不得假定固定条数 |
| `data.host_list[].host` | string | 形如 `bd-bj-live-comet-07.chat.bilibili.com` |
| `data.host_list[].port` | int | 实测 `2243` |
| `data.host_list[].ws_port` | int | 实测 `2244` |
| `data.host_list[].wss_port` | int | 实测 `2245` |
| `data.group` | string | 实测 `live` |
| `data.business_id` | int | 实测 `0` |
| `data.refresh_rate` | int | 实测 `100` |
| `data.refresh_row_factor` | float | 实测 `0.125` |
| `data.max_delay` | int | 实测 `5000` |
| `message` | string | 成功为 `OK` |

端口数值、`max_delay` 等均为**当日实测值**，属服务端可调项，实现 MUST 从 `host_list` 读取而不得硬编码；若上游字段缺失则跳过该 host 而非使用默认端口。

### 5.3 与服务端下发 wss 地址的关系

- 连接地址由 `host_list` 拼出：`wss://{host}:{wss_port}/sub`。本项目固定走 `wss`（TLS），不使用 `ws_port`。
- 本期请求 `protover=3`（brotli）；解码需同时支持 `0` / `1` / `2` / `3`（契约 §4、`protocol.md`）。
- 按 `host_list` 顺序尝试；某 host 连接失败（TCP/TLS 握手失败或认证失败）则换下一个。
- 重连**必须重新调用 `getDanmuInfo`**，不得复用旧 `token` 与旧 `host_list`；退避序列 `5s / 10s / 20s / 40s / 60s` 封顶（契约 §4）。
- `host_list` 为空或请求失败 → 按 `UPSTREAM_ERROR` 上抛，不进入连接循环。

### 5.4 与认证包的对应

| 认证包字段（契约 §6） | 取值来源 |
|---|---|
| `uid` | 登录态为 `DedeUserID`，游客为 `0` |
| `roomid` | 真实房间号 |
| `protover` | 固定 `3` |
| `buvid` | §3 获取的 `buvid3` |
| `platform` | 固定 `"web"` |
| `type` | 固定 `2` |
| `key` | `data.token`；游客为 `""` |

认证回应 `code = 0` 为成功；非 0 一律视为认证失败并按重连退避处理，**不得**在未知 code 上编造含义（契约 §6）。

---

## 6. 扫码登录状态机

扫码是默认入口（§2）：本地生成二维码 → 前端渲染 → 按固定间隔轮询 → 成功时由响应 `Set-Cookie` 下发凭据并回写当前 profile。

### 6.1 状态机

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Generating: session_qr_start
    Generating --> Waiting: 拿到 qrcode_key + url，开始轮询
    Generating --> Failed: 生成失败（UPSTREAM_ERROR）
    Waiting --> Waiting: data.code 未识别 / 86101 未扫码 / 86090 已扫码待确认
    Waiting --> Confirmed: 响应 Set-Cookie 同时含 SESSDATA 与 bili_jct
    Waiting --> Expired: data.code = 86038
    Waiting --> Expired: 本地轮询超时（超过本地看门狗上限）
    Confirmed --> [*]: 凭据原子写回 config.toml 的当前 profile，mode = qrcode
    Expired --> Idle: 用户点击刷新，重新生成
    Failed --> Idle: 展示错误并可重试
```

### 6.2 步骤与端点

| 步骤 | IPC | 上游 | 说明 |
|---|---|---|---|
| 生成 | `session_qr_start` | `GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate` | 实测返回 `code = 0`，`data.qrcode_key`、`data.url`（二维码内容为 `account.bilibili.com` 域名下的链接） |
| 渲染 | 无 | 无 | 前端把 `url` 字符串渲染为二维码图形，**本地渲染**，不得上传到第三方二维码服务 |
| 轮询 | `session_qr_poll(key)` | `GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll` | 上游响应有两层 code：外层 `code = 0` 表示请求本身成功，`data.code` 才是扫码状态 |
| 完成 | 同上 | 同上 | 成功响应通过 `Set-Cookie` 下发凭据集，同时 `data.url` 携带跨域登录链接 |

轮询间隔建议 2 秒（不得低于 1 秒）；前端持续展示「等待扫码 / 已扫码，请在手机上确认」的提示。

### 6.3 `data.code` 语义表

| `data.code` | 语义 | 处置 | 依据 |
|---|---|---|---|
| `86101` | 未扫码 | 继续轮询 | **实测确认**（2026-09-11） |
| `86038` | 二维码已失效 | 终止轮询，置 `expired`，提示刷新 | **实测确认**（2026-09-11，用无效 `qrcode_key` 复现） |
| `86090` | 已扫码待确认（契约采用） | 按「未确认」处理：继续轮询，可提示「已扫码」 | 待实测校准，见 §13 |
| `0` | 成功（契约采用） | 不作为主判据，见下 | 待实测校准，见 §13 |
| 其他任意值 | 未确认 | **视为未确认，继续轮询**，记 `debug` 日志（只记数值与 `message`，不记 Cookie），不改语义 | 本规范 |

**成功判定的设计取舍**：成功的主判据是「轮询响应的 `Set-Cookie` 中同时出现 `SESSDATA` 与 `bili_jct`」，`data.code == 0` 仅作副判据。理由有两条：(1) 主判据直接对应用户可见结果——能拿到凭据才算登录成功；(2) 未知或变更后的数字码不会导致登录卡死在 `pending`——只要凭据真的下发了，状态机必然推进。仅当两判据都缺席时才停留在轮询态。

**看门狗**：`qrcode_key` 有服务端生命周期，且长度未知（见 §13）。因此除 `86038` 这一显式失效信号外，本地再加一道看门狗：自生成起超过本地上限仍未成功或未失效，则主动作废本次会话、置 `expired`、提示刷新，不继续空转轮询。上限为本地策略值而非上游常量。

### 6.4 与本地接口的状态映射

| 状态机状态 | `session_qr_poll` 归一化 `status` | `danmubox://session` 事件 |
|---|---|---|
| Waiting（含 86101 / 86090 / 未知码） | `pending` | 不推送（避免轮询期刷屏） |
| Confirmed | `confirmed` | 推送一次，载荷为 §8.6 的脱敏对象，绝不含 Cookie 值 |
| Expired（86038 或看门狗） | `expired` | 推送一次，载荷同上 |
| Generating 失败 | 由 IPC 错误模型返回 `UPSTREAM_ERROR` | 推送 `danmubox://log` |

`status` 的 `confirmed` 只由 §6.3 的主判据产生；`expired` 只由 `86038` 或看门狗产生。命令签名与载荷形状见 `ipc.md`。

---

## 7. Cookie 字段与用途

下表为 danmubox 关心的字段集合。所有值只在 `danmubox-bili` 与 `core` 的本地文件层内可见；对外（IPC / 日志）一律不可见。表左列是 B 站 Cookie 名，`config.toml` 中的对应键见 §8.1。

| 字段 | 用途 | 是否必需 | 敏感级别 | 缺失后果 |
|---|---|---|---|---|
| `SESSDATA` | 登录态的唯一主凭据，等价账号控制权；决定服务端认不认这个「我」 | 必需（登录态） | **最高** | 退化为游客：字段掩码、不可发言 |
| `bili_jct` | CSRF token，所有写操作（发弹幕、举报、关注等）都要用它填充 `csrf` 字段 | 必需（要写操作） | **高** | 可读不可写；请求返回未登录/校验失败 |
| `DedeUserID` | 当前登录用户的 UID | 必需（登录态） | 中 | 无法判定「哪条弹幕是我发的」，WS 认证包 `uid` 只能填 0，关注列表无法确定 vmid |
| `DedeUserID__ckMd5` | `DedeUserID` 的配套校验值，服务端在部分接口要求与 `DedeUserID` 成对出现 | 建议保留 | 中 | 部分接口校验不通过；单独看无独立语义 |
| `buvid3` | 设备指纹，风控标识；与账号无关 | 必需（含游客） | 低 | 风控评估不稳；WS 认证包 `buvid` 无法填 |
| `buvid4` | 与 `buvid3` 配对的设备标识 | 建议保留 | 低 | 风控评估降级 |
| `sid` | 会话标识，由登录响应下发 | 建议保留 | **高** | 部分会话级校验失败 |

补充说明：

- 敏感级别为「最高 / 高」的字段一旦泄露即等同账号被他人控制或可被代为操作，受 §12 红线约束；`SESSDATA` 与 `bili_jct` 的**同时存在**是「可写操作」的充要条件（§2.1 第 6 条）。
- 完整 `Set-Cookie` 字段集合可能随上游调整（见 §13），实现应**宽容接受**：出现未识别字段不报错、也不因此拒绝登录；未识别字段在内存凭据集中原样透传，而写回磁盘的键以契约 §4.1 的字段表为准。

---

## 8. 凭据文件 `config.toml`

需求直接来源：REQUIREMENTS.md「cookie 弄个配置文件存进去，默认扫码登录，如果本地有 cookie 则直接读取」。规范性定义见契约 §4.1。

### 8.1 字段表（契约 §4.1）

文件为**明文 TOML**，位于应用数据目录（契约 §4：macOS `~/Library/Application Support/danmubox`、Windows `%APPDATA%\danmubox`、Android 应用私有目录），权限 **0600**。自用场景不加密，靠文件权限与「只在本机数据目录」约束。

**多账号（规范性，契约 §4.1）**：同一文件用 `[profiles.<name>]` 承载多份凭据，`active_profile` 指定当前生效者；切换账号只改 `active_profile`，**不复制多份文件**（§2.1 第 5 条）。

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

| TOML 键 | 对应 Cookie | 类型 | 必需条件 | 说明 |
|---|---|---|---|---|
| `sessdata` | `SESSDATA` | string | 登录必需 | 登录主凭据 |
| `bili_jct` | `bili_jct` | string | 写操作必需 | `csrf` 来源，见 §11.1 |
| `dede_user_id` | `DedeUserID` | string | 登录必需 | 当前 UID；WS 认证包 `uid` 与关注列表 vmid 来源 |
| `dede_user_id_ck_md5` | `DedeUserID__ckMd5` | string | 建议 | 与 `dede_user_id` 成对使用 |
| `buvid3` | `buvid3` | string | 含游客必需 | 设备标识，见 §3 |
| `buvid4` | `buvid4` | string | 建议 | 设备标识配对项 |
| `sid` | `sid` | string | 建议 | 会话标识 |

- 实现 MUST NOT 在该文件中存放任何非凭据内容；界面偏好一律走 `prefs.json`（契约 §4.2、§8.5）。
- 写入权限：POSIX 平台创建目录 0700、文件 0600；Windows 位于用户私有数据目录，依赖该目录 ACL，实现 MUST NOT 放宽 ACL。

### 8.2 启动顺序（规范性）

1. 读取 `config.toml`（契约 §4.1），取 `active_profile` 指向的 profile。文件缺失、`active_profile` 缺失或解析失败 → 以空值继续，不报错，按游客链路启动；解析失败时保留损坏副本 `config.toml.bak` 供排查（不得在日志中输出其内容）。
2. 校验该 profile 的 `sessdata` / `bili_jct` / `dede_user_id` 三者是否**齐全且非空白**。
3. 齐全 → 直接进入登录态，`mode = "cookie"`，不触发扫码；启动后异步调用 `nav` 复核（`code = -101` 则按 §10 失效处理）。
4. 不齐全 → `mode = "anonymous"`，登录入口为扫码（默认）。
5. 扫码成功后原子写回，进入 `mode = "qrcode"`（§8.3）。
6. 本期只在进程启动时读取该文件一次，运行中不监听文件变化；手工编辑后需重启应用生效。

### 8.3 原子写回

- 写入 MUST 原子：在同目录写临时文件 → `fsync` → `rename` 覆盖目标，避免半套凭据或损坏文件。
- 写入 MUST 同时设置/校正权限（§8.1）。
- 写回的目标恒为 `active_profile` 指向的 profile；字段集为本次登录获得的完整凭据集，`buvid3` / `buvid4` 若已存在则保留（§3.3）。
- 登出清空该 profile 的账号凭据字段（`sessdata` / `bili_jct` / `dede_user_id` / `dede_user_id_ck_md5` / `sid`），保留 `buvid3` / `buvid4`，其它 profile 不动；清空同样走原子写回。

### 8.4 手填 Cookie

「手填 Cookie」在本设计中**即直接编辑 `config.toml` 文件**：用户从浏览器导出 `SESSDATA` / `bili_jct` / `DedeUserID` 等值填进对应键，保存后重启应用。danmubox **不提供** Cookie 导入界面，也**不提供**导入命令——不存在一条把用户粘贴的字符串经前端传给 Rust 的链路，从结构上消除了粘贴内容进入前端缓冲、剪贴板历史与输入法缓存的风险。

校验走 §8.2 的 `nav` 复核：`code = -101` 说明凭据无效或已过期，退回 `anonymous` 并提示重新登录，不得留下半套凭据的「已登录」假象。

### 8.5 与 `prefs.json` 分家的理由

契约 §4.1 规定 `config.toml` 只放凭据、界面偏好一律走 `prefs.json`（契约 §4.2）。因此：账号凭据 → `config.toml`（低频写、用户可编辑、手填 Cookie 不被程序覆盖）；界面偏好 → `prefs.json`（高频写、程序管理）；两者互不包含对方内容。完整论证与被否方案见 `decisions/0007-credential-file.md`。

### 8.6 前端可见的脱敏对象（规范性）

`session_status` / `danmubox://session` 返回的对象形状如下，其中**没有任何 Cookie 字段**，也不含长度、前缀、哈希等可用于侧信道推断的衍生信息：

| 字段 | 类型 | 说明 |
|---|---|---|
| `active_profile` | string | 当前生效的 profile 名（契约 §4.1、§7） |
| `mode` | string | `anonymous` / `cookie` / `qrcode` |
| `logged_in` | bool | 是否持有可用凭据 |
| `uid` | i64 | 未登录为 0 |
| `uname` | string | 未登录为空串 |
| `expires_at` | i64 \| null | 凭据的**本地预估**失效时刻（UTC 毫秒）；上游不下发权威有效期，`null` 表示未知，由失效信号驱动 |

该对象由 `AuthProvider` 端口产出，所有上层（IPC / CLI / 未来的 Agent 通道）只能拿到这一形状。

---

## 9. 新能力面的鉴权前提

本节只定义本节三块能力的**凭据与身份前提**；上游端点、字段名与返回结构由 `protocol.md` 承载（端点均未经实测，登记在各小节的「待实测校准」表）。三块能力的主键与身份字段遵循契约 §5。

### 9.1 表情包库（按身份加载）

- 端口：`EmoteProvider`（契约 §3）；IPC `emotes_list`（契约 §7）。
- 凭据前提：携带登录态 Cookie（`SESSDATA`）；游客不保证可用（上游是否放行待实测）。房间专属包必须携带真实 `room_id`。
- 身份判定（本地，源自 `RoomSession`，契约 §5）：**不发额外鉴权请求**，由房间内身份直接决定可加载的包范围。

| 包类型 `package_kind` | 身份条件（本地判定） | 说明 |
|---|---|---|
| `common` | 无房间身份要求（登录态即可） | 通用包 |
| `medal` | `RoomSession.my_medal_level > 0` | 我在**该房间**有粉丝牌 |
| `guard` | `RoomSession.my_guard_level ∈ {1, 2, 3}` | 我在该房间是大航海（1 总督 / 2 提督 / 3 舰长） |
| `admin` | `RoomSession.is_admin == true` | 我在该房间是房管 |

- 主播（`uid == Room.anchor_uid` 派生，契约 §5）不产生独立包类型；是否另有主播专属包待实测（见下表），实现按上表四类推进。
- 身份变化（进房解析、收到身份变更）后 MUST 重新加载，不得缓存跨身份的表情库。

**待实测校准（表情包库）**

| 项 | 现状 | 核对方法与步骤 |
|---|---|---|
| 上游端点与鉴权方式 | 候选为 `live.bilibili.com` 的直播间表情接口；未经实测，路径与参数不得写死 | 登录态下用 `DANMUBOX_LOG=debug` 抓一次真实加载，记录完整 URL、query、请求头与响应 `code` |
| 响应包结构字段名 | 未知；本地 `Emote` 是契约 §5 的归一化形状，不假定上游字段名 | 抓取响应，记录每个包的类别字段、表情 key、文本与图片 URL 的字段路径 |
| 游客是否可加载 `common` | 未知 | 清空凭据后重复加载，记录是否返回未登录错误 |
| 粉丝牌 / 大航海 / 房管包的判定依据 | 上游可能另有「本房间身份」接口；本地先用 `RoomSession` 判定 | 在有牌、有舰、房管三种账号下各加载一次，比对返回包集合是否与身份一致 |
| 是否存在主播专属包 | 未知 | 主播账号在自房间内加载一次，记录是否出现 `common`/`medal`/`guard`/`admin` 之外的类别 |

### 9.2 举报弹幕

- 端口：`DanmakuReporter`（契约 §3）；IPC `chat_report`（契约 §7）。
- 凭据前提：**必须登录**，且举报是写操作，请求体必须携带 `csrf = bili_jct`（§11.1 的同一凭据；`bili_jct` 缺失时不得发起请求）。
- 目标定位：以 `Message.upstream_id` 标识被举报弹幕（契约 §5：上游弹幕标识，举报必需）。`upstream_id` 为空时本地拒绝（`BAD_REQUEST`），不得用 `content` 或 `local_id` 替代——`local_id` 只是会话内自增序号。
- 上下文：必须携带该弹幕所属真实 `room_id`；举报理由/分类为上游枚举（值域待实测，见下表），本地只做透传与校验，不自定义语义。
- 结果处理：只回报成功/失败与（可选）上游 `code` / `message`；不把举报人身份或理由回显到弹幕区；不因举报失败自动重试（避免对同一目标重复提交）。

**待实测校准（举报弹幕）**

| 项 | 现状 | 核对方法与步骤 |
|---|---|---|
| 上游举报端点与请求字段 | 候选为直播弹幕举报接口；路径、方法、字段名均未实测，不得写死 | 登录态下举报一条自测弹幕，`DANMUBOX_LOG=debug` 抓取完整请求（URL、body、请求头） |
| 举报理由/分类枚举 | 未知；界面选项必须以实测枚举为准，不得编造 | 抓取官方 web 端举报提交请求，记录分类字段的取值集合 |
| `csrf` 的字段名与位置 | 推测为表单体字段（与发弹幕一致）；需确认是否存在 `csrf_token` 并存字段 | 对比官方请求的 body 与 query，确认字段名、是否放 query（放 query 一律禁止，§12） |
| 成功与失败判定 | 未知 `code` 语义 | 分别制造一次成功与一次重复举报，记录 `code` / `message` 与频次限制行为 |
| 是否存在举报频次限制 | 未知 | 连续举报多次，记录首次被拒的阈值与提示 |

### 9.3 关注列表与电池余额

- 端口：`RoomCatalog`（关注列表 / 直播状态）与 `WalletProvider`（电池余额）（契约 §3）；IPC `follow_list` / `wallet_balance`（契约 §7）。
- 关注列表凭据前提：**必须登录**（`SESSDATA`）；`DedeUserID` 是「查谁的关注」的 vmid 来源（上游是否要求显式 vmid 待实测）。只读，**不需要** `csrf`。
- 关注列表展示（领域形状见契约 §5）：`live_status == 1` 置顶（REQUIREMENTS.md 需求），同组内其余按 `group_name` 分组展示。
- 电池余额凭据前提：**必须登录**；只读，不需要 `csrf`；本地以整数表示余额，单位与口径待实测。
- 缓存与刷新：关注列表/直播状态只在 `follow_list` 触发时拉取，不得以轮询压上游；余额在每次进入礼物相关界面时按需拉取，不做后台轮询。

**待实测校准（关注列表与电池余额）**

| 项 | 现状 | 核对方法与步骤 |
|---|---|---|
| 关注列表上游端点与分页 | 候选为关注关系接口；路径、分页参数、是否随 `SESSDATA` 自动识别 vmid 均未实测 | 登录态下抓取一次完整关注列表，记录端点、分页字段与总数字段 |
| `live_status` 的来源 | 未知：可能随关注列表返回，也可能需另调直播状态接口 | 对比同一批关注在开播/停播时的响应，确认 `live_status` 出现在哪个响应中 |
| `group_name`（关注分组）字段 | 未知 | 抓取带分组的账号响应，记录分组字段名与多分组呈现方式 |
| 电池余额端点与字段 | 候选为直播钱包接口；路径与字段名未实测 | 登录态下抓取余额，记录端点、返回字段名与单位（电池 vs 金瓜子） |
| 余额是否需 `csrf` | 预期只读不需要；需确认 | 抓取官方请求，确认 body/query 中无 `csrf` 字段 |

---

## 10. 登录态过期检测与失效处理

### 10.1 触发重新登录的信号

| 信号 | 来源 | 上游表现（实测/契约） | 处置 |
|---|---|---|---|
| 账号未登录 | `nav` | `code = -101`、`message = "账号未登录"`（实测） | 判定凭据失效，清空 `config.toml` 当前 profile 的账号字段，`mode → anonymous` |
| 发弹幕被拒 | 发送接口 | `code = -101`（实测，未带凭据时） | 判定失效；若本地凭据仍在，触发一次 `nav` 复核后再决定 |
| WBI 风控失败 | 任意受保护接口 | `code = -352` | **不是**登录失效：先刷新 WBI key 重试一次（§4.3），仍失败才按上游故障处理 |
| WS 认证回应非 0 | 认证回应包 | 契约 §6：非 0 一律视为认证失败 | 按重连退避处理；重连前重取 `getDanmuInfo`；连续多轮失败后做一次 `nav` 复核以区分「token 问题」与「账号失效」 |
| 本地凭据缺失但 `mode != anonymous` | 本地一致性检查（启动复核或 `nav` 复核时） | 当前 profile 被外部清空或改写 | 置 `anonymous`，推送 `danmubox://session` |
| 发弹幕被限流 | 发送接口 | 频次类错误 | 按 `rate_limited` 处理，**不**触发重新登录，见 §11 |
| 启动时文件解析失败 | 本地文件层 | `config.toml` 损坏 | 以游客态启动并保留 `config.toml.bak`，提示用户手工修复；不清除原文件 |

判定原则：**区分「凭据失效」与「上游/风控故障」**。只有明确的凭据类信号（`-101`、认证回应持续非 0）才清凭据并要求重新登录；`-352`、网络错误、5xx 一律不得清除凭据，否则一次服务端抖动就会把用户登出。

### 10.2 失效后的行为

1. 清空 `config.toml` 当前 profile 的账号凭据字段（保留 `buvid3` / `buvid4`），走原子写回（§8.3）。
2. 本地状态置 `mode = "anonymous"`、`logged_in = false`；保留弹幕连接可继续以游客身份接收（能收且字段降级），**不**强制断开 WS。
3. 推送 `danmubox://session`，前端展示「登录已失效，请重新登录」并提供一键回到扫码入口。
4. 正在发送的弹幕：失败并向用户显示原因；不做自动重发（避免用户不可见的重复发言）。
5. 失效事件记入结构化日志时只记「哪个信号触发的」（如 `session_invalidated reason=nav_-101`），不记任何凭据内容。

### 10.3 `expires_at` 的处理

上游不下发权威的凭据有效期，因此本地不做过期倒计时驱动登出。`expires_at` 若为 `null` 即表示未知；若实现选择在上次成功校验时刻加一个保守窗口作为提示值，该值只能用于 UI 提示（如「很久没校验过了」），MUST NOT 用于主动清除凭据或阻断请求。

---

## 11. 发弹幕：`csrf`、节流与被吞判定

### 11.1 `csrf` 来源

`csrf` 字段取自当前 profile 的 `bili_jct`（§7、§8.1）。发送请求在表单体中同时填 `csrf` 与 `csrf_token` 为同一值（上游两种字段名并存，同时填以兼容）。**严禁**把 `bili_jct` 写到请求 URL 的 query 中——query 会进日志、进浏览器历史、进代理记录。

### 11.2 节流参数（契约 §4，规范性）

| 参数 | 值 |
|---|---|
| 同房间最小发送间隔 | 2 秒 |
| 相同内容去重窗口 | 5 秒 |

实现规则：

1. 节流在本地按房间维度独立计时（不同房间互不影响）。
2. 命中节流时不发请求，直接返回 `rate_limited`，并在 UI 给出可操作的提示。
3. 去重窗口以「内容字符串归一化后比较」为准；命中去重同样返回 `rate_limited`，不得静默丢弃——静默丢弃会让用户以为发出去了。
4. 节流是本地保护，减少触发上游风控的概率；即便本地放行，上游仍可能限流，此时按 §10.1 的「限流不触发重新登录」处理。
5. 未登录（无 `bili_jct`）时直接返回 `NOT_LOGGED_IN`，不发起上游请求。

### 11.3 被吞判定与 `SendOutcome`

发弹幕的成功不能只看外层 `code`：上游可能在业务响应里以 `msg` / `message` 回一个「吞掉」标记，弹幕并未进入公开流。判定依据来自一个可复现的社区实现（契约 §5），**阶段 1 必须用真实发送复核后写死**。

| 上游响应特征 | `SendOutcome`（契约 §5） | 用户可见文案（建议） |
|---|---|---|
| 正常成功 | `ok` | 无（正常入列） |
| 业务响应 `msg`/`message` == `"f"` | `blocked_platform` | 「弹幕被平台风控拦截，未公开显示」 |
| 业务响应 `msg`/`message` == `"k"` | `blocked_room` | 「弹幕被本直播间拦截，未公开显示」 |
| 上游频次类错误码 | `rate_limited` | 「发送太频繁，请稍后再试」 |
| 粉丝牌等级不足错误码 | `medal_required` | 「粉丝牌等级不足，无法发言」 |
| 已禁言错误码 | `muted` | 「你已被禁言（全局或本直播间）」 |
| 其他失败 | `failed` | 「发送失败」+ 原始 `code` / `message`（不含凭据） |

补充规则：

- 被吞时上游外层 `code` 通常仍为成功值，因此**必须**检查 `msg` / `message` 的业务标记，不能只看外层 `code` 判成功。
- 被吞弹幕的正文回显在 `data.mode_info.extra`（JSON 字符串）的 `content` 字段；本地可用它确认被吞的正是本次内容，但**不得**据此自动重发。
- `blocked_platform` / `blocked_room` 的确切 `msg` / `message` 取值与判定顺序列入 §13 待实测，核对前不得作为稳定契约扩展到其他字段。
- `rate_limited` / `medal_required` / `muted` / `failed` 对应的具体上游错误码未列出（契约 §5，待实测），实现 MUST 归一化到上表取值并保留原始 `code` / `message` 供排障。

---

## 12. 安全红线

以下条目为规范性约束，与契约 §4 的表述一致，任何文档、注释、实现都不得放宽：

1. `SESSDATA`、`bili_jct`、`DedeUserID` **不得**出现在日志、前端明文、仓库、崩溃上报中。
2. 任何日志（含 `DANMUBOX_LOG=debug` 全量调试模式）在输出请求/响应时，必须对 `Cookie`、`Set-Cookie`、`Authorization` 三个头整体做替换，而不是只替换其中的值——只替换值会漏掉字段名组合带来的推断空间。
3. 崩溃上报与错误信息中不得内嵌请求头或响应头原文；`UPSTREAM_ERROR` 的 `detail` 只允许放上游 `code` / `message` / 请求路径，不得放 Cookie。
4. 凭据不得进入前端：`session_status`、`danmubox://session` 一律返回 §8.6 的脱敏对象，绝不返回任何 Cookie 值或其长度、前缀、哈希。
5. 凭据不得进入仓库：不得写入任何 fixture、测试样例或文档示例；测试中的凭据一律使用明显的伪造值。
6. `config.toml` 只存在于本机应用数据目录，权限 MUST 为 0600（Windows 为等价的用户私有 ACL）；不得把该文件路径或内容交给任何远程服务。
7. 凭据只经 HTTPS / WSS 传输；本项目不提供任何供外部读取凭据的本地服务（无本地监听端口、无 token 文件），凭据只在本进程内使用。
8. 二维码内容（`data.url`）只做本地渲染，不得提交给任何第三方二维码生成服务，否则等同于把登录凭证转发给第三方。
9. 手填 Cookie 即用户直接编辑 `config.toml`（§8.4）：danmubox 不接收粘贴内容，因此不存在前端输入框、剪贴板或输入法缓存路径；文档与截图中的示例一律用明显的伪造值，禁止贴出真实值。
10. 提供「登出」时，必须真正清空 `config.toml` 当前 profile 的账号凭据字段（§8.3），而不是仅把内存状态置为未登录。
11. 凭据相关代码的任何改动都必须在变更说明中显式声明是否影响上述任一条；不影响也需说明。

---

## 13. 待实测校准

下表承载**无法在开发期确定、且不应当被猜测**的上游事实。实现不得依赖其中的猜测值；核对方法：以 `DANMUBOX_LOG=debug` 启动并复现对应场景，抓取请求/响应（记录字段名与 code，**不记 Cookie 值**），必要时回放录制流量（见 `testing.md`），然后回填本表。

| 项 | 现状 | 核对方法 |
|---|---|---|
| 扫码成功时 `data.code` 的具体数值 | 契约采用 `0`，未经真实扫码确认；因此实现以 `Set-Cookie` 为主判据（§6.3） | 本人用手机 B 站 App 扫描一次并确认，记录轮询响应中 `data.code` 与外层 `code`，回填本表 |
| 「已扫码待确认」状态码 `86090` | 契约采用，未经确认真实扫码路径 | 同上流程，在扫码后、确认前观察一次响应 |
| `data.code = 86101` / `86038` | **已实测确认**（2026-09-11） | 无需再核；如上游调整则复核 |
| `qrcode_key` 的服务端有效期 | 未知；本地看门狗上限为自定策略值（§6.3） | 生成二维码后不扫码，持续轮询直到出现 `86038`，记录耗时 |
| 完整 `Set-Cookie` 字段集合 | 已知核心 7 个字段（§7），是否还有额外字段未知 | 真实扫码成功后记录响应 `Set-Cookie` 的全部字段名（**只记字段名，不记值**），回填本表 |
| `img_key` / `sub_key` 的轮换周期 | 按自然日缓存（§4.3），未经跨越两日的实测确认 | 连续两天在固定时刻记录 `nav` 的 `img_url` / `sub_url`，比对是否变化，确认轮换时刻 |
| WBI 值清洗字符集 `! ' ( ) *` | 按现有算法实现；本地用含这些字符的关键词做对照请求未能产生差异（`code` 均为 `0`），故未独立确认 | 构造一个值中确含这些字符的**受保护**接口请求，对比清洗与不清洗的 `code`，确认清洗是否为服务端必需 |
| `getDanmuInfo` 是否强校验 `buvid3` | 契约 §6 要求携带；实测中不带该 Cookie 也曾返回 `code = 0`，说明校验强度随策略波动 | 在多个不同房间与不同网络下不带 `buvid3` 重复请求，统计失败率；无论结果如何，实现 MUST 始终携带 |
| `host_list` 的典型条数与端口号 | 实测 6 项、`port=2243` / `ws_port=2244` / `wss_port=2245`，属服务端可调值 | 定期采样 `host_list`；实现从响应读取，不得硬编码 |
| `data.token` 长度 | 实测 244–252 字符，非稳定契约 | 无需专门核对；实现不得断言长度 |
| WS 认证回应中除 `code = 0` 之外的取值语义 | 无**权威**语义表，契约 §6 明确禁止编造 | 只有在复现到具体非 0 `code` 时，记录「code + 当时的 Cookie 状态 + 网络状态」到本文与 `protocol.md`，并标注为观察值而非规范值 |
| 发弹幕被吞标记 `"f"` / `"k"` | 来自可复现的社区实现（契约 §5），**未经本项目真实发送确认** | 用真实账号在有房管/无房管的房间各发一条并观察业务响应 `msg`/`message` 与 `data.mode_info.extra`，回填 §11.3 |
| `rate_limited` / `medal_required` / `muted` / `failed` 的上游错误码 | 契约 §5 未列出具体码值 | 分别制造限流、无牌发言、被禁言、其他失败各一次，记录 `code` / `message` 并回填 §11.3 |
| 表情包库、举报、关注列表、电池余额的端点与字段 | 见 §9.1 / §9.2 / §9.3 各小节的「待实测校准」表 | 按各表步骤执行并回填；端点与字段以实测为准，不写入正式约定 |

---

## 14. 相关文档

- `contract.md`：唯一事实源；`config.toml`（§4.1）、`prefs.json`（§4.2）、`SendOutcome`（§5）、协议要点（§6）、IPC 命令（§7）、安全红线的总纲。
- `protocol.md`：WS 帧格式、认证包 / 心跳包精确格式、命令目录、重连状态机、发送与风控（含 `upstream_id` 与举报相关字段的实测记录）。
- `ipc.md`：`session_status` / `session_qr_start` / `session_qr_poll` / `session_logout` / `profiles_list` / `profiles_switch` / `chat_send` / `chat_report` / `emotes_list` / `follow_list` / `wallet_balance` 的签名与 `danmubox://session` 载荷。
- `architecture.md`：`AuthProvider` 端口的实现位置、`core` / `bili` 的依赖方向与并发模型。
- `ui.md`：登录界面、扫码状态展示、关注列表与礼物栏的身份徽标渲染。
- `operations.md`：凭据相关故障的排查决策树与日志脱敏规则。
- `testing.md`：B 站侧事实的录制、回放与待实测校准流程。
- `roadmap.md`：下期条目与非核心功能的归属。
- `../REQUIREMENTS.md`：需求基线（用户手写）。
- `../README.md`：项目边界与非官方声明。
