# B 站直播弹幕协议规格（danmubox）

> 定位：`danmubox-bili` 协议层（proto / ws）的实现依据，规定与 B 站直播弹幕长连接交互的二进制帧格式、认证与双心跳、业务命令归一化、发送侧被吞判定、重连状态机与风控边界。
> 读者：协议层与适配器实现者；排查「连不上 / 收不到弹幕 / 字段为空 / 频繁重连 / 发弹幕被吞」的维护者；需要理解消息来源与语义的 AI agent 使用者。
> 更新时机：头部布局、`op` / `protover` 语义、认证包或心跳包体、HTTP 心跳地址、`cmd` 与 `kind` 映射、发送判定规则、重连与节流参数发生任何变化时；附录 A 任一「待实测校准」项完成核对并回填结论后。

相关文档：[`contract.md`](contract.md)（唯一事实源：共享常量、领域模型、端口、IPC、偏好键）、[`auth.md`](auth.md)（登录、`buvid3`、WBI 签名、`getDanmuInfo`、扫码）、[`architecture.md`](architecture.md)（每房间 supervisor 与事件总线）、[`ipc.md`](ipc.md)（Tauri 命令与事件）、[`ui.md`](ui.md)（渲染、过滤、合并与虚拟列表）、[`testing.md`](testing.md)（帧 fixture 与回放测试）、[`REQUIREMENTS.md`](../REQUIREMENTS.md)（需求基线）。

---

## 1. 范围与术语

### 1.1 范围

| 纳入 | 不纳入 |
|---|---|
| 房间解析、WS 长连、认证、WS 心跳、HTTP 心跳、压缩解包、命令归一化、发送侧被吞归一化、会话内内存缓冲、重连与节流 | 直播视频流解码 |
| `protover=3`（brotli）主动请求；解码侧同时兼容 0 / 1 / 2 / 3 | 弹幕回看、导出、跨会话历史与任何本地持久化（`contract.md` §4.3 明确排除） |
| macOS / Windows / Android 三端共用的协议层 | iOS 端、折叠屏布局（后期 enhancement） |

### 1.2 术语

| 术语 | 含义 |
|---|---|
| `short_id` | 用户可见的短号（可为 0，表示该房间无短号） |
| 真实 `room_id` | 协议与领域模型统一使用的房间号（`i64`，见 `contract.md` §5） |
| `getRoomPlayInfo` | 短号 / URL → 真实 `room_id` 的 REST 接口；一次返回 `room_id` / `uid`（主播 UID）/ `live_status` |
| `getDanmuInfo` | 取得弹幕 WS 连接参数（`token`、`host_list`）的 REST 接口，需 `buvid3` 与 WBI 签名 |
| `token` | 认证包 `key` 字段的值；由服务端签发 |
| `host_list` | 弹幕 WS 候选节点列表，含主机名与端口 |
| `buvid3` | 匿名设备标识 Cookie，`getDanmuInfo` 的前置条件 |
| WBI 签名 | `getDanmuInfo` 请求所需的查询串签名，实现见 [`auth.md`](auth.md) |
| `cmd` | `op=5` 业务载荷中的命令名 |
| `kind` | 归一化后的六种消息类型之一（见 §10.0） |
| supervisor | 每房间一个的连接管理 task（见 [`architecture.md`](architecture.md)） |

---

## 2. 端到端连接时序

完整顺序：房间解析 → `getDanmuInfo` → WSS 握手 → `op=7` 认证 → `op=8` 且 `code=0` 后启动 WS / HTTP 心跳 → `op=5` 分发；任一步失败按 §13 退避重连。

### 2.1 连接前置步骤

| 步 | 输入 | 调用 | 产出 | 失败处理 |
|---|---|---|---|---|
| 1 | 用户输入的短号 / URL / 房间号 | 本地解析（提取数字路径段） | 候选 `short_id` 或 `room_id` | 无法解析 → `BAD_REQUEST` |
| 2 | 候选号 | `GET getRoomPlayInfo` | 真实 `room_id`、主播 `uid`、`live_status` | 房间不存在 → `ROOM_NOT_FOUND` |
| 3 | 真实 `room_id` | `GET getDanmuInfo`（需 `buvid3` + WBI） | `token`、`host_list` | 未登录可走游客参数；接口失败 → `UPSTREAM_ERROR` |
| 4 | `host_list` | 按顺序选取节点 | `wss://{host}/sub` | 全部节点失败 → `UPSTREAM_ERROR` |

> 主播 UID 由步骤 2 得到，用于派生主播徽标（`uid == Room.anchor_uid`），协议层不再单独请求。

---

## 3. 帧格式：16 字节大端头

### 3.1 包结构

所有 WS 帧（双向）均为「固定 16 字节头 + body」，整数一律**大端（network order）**。

| 偏移 | 长度 | 字段 | 类型 | 含义 |
|---|---|---|---|---|
| 0 | 4 | `packetLen` | u32 BE | 本包总字节数（含头），即 `headerLen + body.len()` |
| 4 | 2 | `headerLen` | u16 BE | 头长度，固定 `16` |
| 6 | 2 | `protover` | u16 BE | 载荷编码版本，见 §6 |
| 8 | 4 | `op` | u32 BE | 操作码，见 §5 |
| 12 | 4 | `seq` | u32 BE | 序列号；本地发送使用 `1`，接收值仅记日志、不参与解析 |
| 16 | — | `body` | bytes | 长度为 `packetLen - headerLen` |

### 3.2 解析护栏（本地实现约束）

以下均为本地护栏，不是上游承诺；数值变更只影响本地实现。

| 约束 | 取值 | 违反时的处理 |
|---|---|---|
| `headerLen` | 必须等于 `16` | 丢弃本包并计数 + `warn`；不拆分剩余字节 |
| `packetLen` 下限 | `>= headerLen` | 同上 |
| `packetLen` 上限 | `<= 剩余缓冲区长度` | 视为截断包，丢弃剩余全部字节 + `warn` |
| 单帧 `packetLen` 硬上限 | 16 MiB | 断开并进入重连流程，计入「异常帧」计数 |
| 解压后单包上限 | 16 MiB（`contract.md` §4 规范性） | 丢弃该子包 + `warn`（解压炸弹护栏） |
| 递归深度上限 | 4 层 | 丢弃该子包 + `warn` |
| 尾部残留 | `< 16` 字节 | `warn` 并忽略，不影响本次连接 |

---

## 4. 包头字段逐项说明

| 字段 | 说明 |
|---|---|
| `packetLen` | 唯一权威的长度来源；先读头再按长度切片，禁止依赖 WS 帧边界推断包边界 |
| body | 可能为空（如认证回应之外的保活帧），空 body 直接跳过，不视为错误 |

> `op`（§5）决定 body 的**用途与分发路径**，`protover`（§6）决定 body 的**编码与解码器**，两者互不混用；认证包与心跳包的**帧头** `protover` 固定为 `1`，认证包 **body 内**的 `protover` 字段固定为 `3`（同名不同物）。

---

## 5. `op` 语义表

| `op` | 名称 | 方向 | body 形态 | 处理 |
|---|---|---|---|---|
| `2` | 心跳 | 客户端 → 服务端 | 字面量字符串 `[object Object]` | 首包 60 秒内发出，收到 `op=3` 后重置为每 30 秒一次，见 §8.1 |
| `3` | 心跳回应 / 人气值 | 服务端 → 客户端 | 4 字节大端无符号整数（人气值） | 解析为整数，计数 + `debug` 日志，并作为「连接存活」信号重置 WS 心跳周期 |
| `5` | 业务消息 | 服务端 → 客户端 | 压缩子包拼接或 JSON（见 §6、§9） | 解包 → `cmd` 分发 → 归一化 → 广播 / 入会话缓冲 |
| `7` | 认证 | 客户端 → 服务端 | JSON 对象（见 §7） | 连接建立后立即发送一次 |
| `8` | 认证回应 | 服务端 → 客户端 | JSON 对象，含 `code` 字段 | `code=0` 视为成功；非 0 一律按认证失败处理（见 §13.3） |

> 未知 `op` 不得猜测语义：记 `warn`（含 `op` 原值、`packetLen`、`protover`）后丢弃该包。

---

## 6. `protover` 表与压缩协商

| `protover` | 编码 | 本期行为 |
|---|---|---|
| `0` | 明文 JSON（无压缩） | 直接按 UTF-8 JSON 解析 |
| `1` | 认证与心跳包的帧头版本 | 用于 `op=7` / `op=2` 的**帧头**；若出现在业务子包中，按整数 body 兼容处理，仅计数与日志 |
| `2` | zlib（deflate 容器） | 解码兼容路径；解压后可能仍是子包拼接（见 §9） |
| `3` | brotli | **本期认证包请求的编码**，默认路径；解压失败按 §9.3 处理 |

| 协商项 | 值 | 依据 |
|---|---|---|
| 认证包请求的 `protover` | `3` | `contract.md` §4 规范性常量 |
| 解码需兼容的取值 | `0` / `1` / `2` / `3` | `contract.md` §4 规范性常量 |
| 解压失败 | 丢弃该子包 + 计数，**不**断开连接 | 单包损坏不应升级为连接故障 |

> 解码实现必须同时具备 brotli 与 zlib 两条路径：认证协商为 3，但**子包**的 `protover` 可能为 0 / 1 / 2 / 3 中任意值（上游节点与滚动升级会造成混用），一律按子包自身取值分派。

---

## 7. 认证包（`op=7`）

### 7.1 body 精确格式

帧头 `protover=1`；body 为 JSON 对象（明文）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `uid` | number | 登录态为当前用户 UID；游客为 `0` |
| `roomid` | number | **真实** `room_id`（不是短号） |
| `protover` | number | 固定 `3` |
| `buvid` | string | `buvid3` 的值；游客模式亦需携带 |
| `platform` | string | 固定 `"web"` |
| `type` | number | 固定 `2` |
| `key` | string | `getDanmuInfo` 返回的 `token`；游客为 `""` |

示例（游客态，字段顺序不敏感）：

```json
{ "uid": 0, "roomid": 123456, "protover": 3, "buvid": "设备标识值", "platform": "web", "type": 2, "key": "" }
```

### 7.2 游客与登录形态

| 形态 | `uid` | `key` | 能力差异 |
|---|---|---|---|
| 游客 | `0` | `""` | 可收大部分弹幕 / 礼物 / SC；昵称可能掩码、UID 归一化为 `0` |
| 登录 | 真实 UID | `getDanmuInfo` 返回的 `token` | 完整字段、发送弹幕、粉丝牌信息完整 |

### 7.3 发送规则

| 发送规则 | 约定 |
|---|---|
| 发送时机 | WSS 打开后立即发送，不得等到收到首帧再发 |
| 发送次数 | 每条连接一次；重连后重新发送 |
| 认证超时 | 发送后 10 秒内未收到 `op=8` → 视为失败，走退避重连 |
| 重连后 | 必须重新调用 `getDanmuInfo` 取新 `token`，不复用旧 `token` |
| 日志 | `key` 一律以固定掩码输出，禁止写入原值 |

---

## 8. 心跳

danmubox 必须同时维持**两个**心跳：WS 心跳（`op=2`，保活 WS）与 HTTP 心跳（`webHeartBeat`，保活上游会话）。**只做其中一个会在一段时间后被上游断开**，这是实践中最常见的「连上了但几分钟后掉线」原因。

### 8.1 WS 心跳（`op=2`）

| 项 | 值 |
|---|---|
| body 形态 | 字面量字符串 `[object Object]`（15 字节 ASCII，不是 JSON 对象，也不是空 JSON） |
| 帧头 `protover` | `1`（body 不压缩） |
| `op` | `2` |
| `seq` | `1` |
| 首包时机 | 认证成功（`op=8` 且 `code=0`）后 **60 秒内必须发出** |
| 周期 | 常规 30 秒；**收到 `op=3` 回应后重置为 30 秒**计时 |
| 兼容 | 空 body 亦被上游接受，但**以 `[object Object]` 为规范实现** |
| 重连后 | 旧定时器必须取消，重新以认证成功为起点计时 |

```text
[object Object]
```

| 规则 | 说明 |
|---|---|
| 心跳不携带房间信息 | 房间由认证包确定，心跳仅保活 |
| 不在重连窗口补发 | 断线期间错过的节拍作废，不与新连接的首次心跳合并 |
| 僵死判定 | 连续 3 个心跳周期（90 秒）内未收到任何入站帧（`op=3` / `op=5` / `op=8`）→ 判定连接僵死，主动断开并重连 |
| 心跳失败不重试 | 发送失败等价于连接故障，直接进入退避流程，不重复 `op=2` |

### 8.2 HTTP 心跳（`webHeartBeat`）

| 项 | 值 |
|---|---|
| 方法 / 地址 | `GET https://live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat` |
| 参数 | `pf=web`，`hb=<base64("60|<真实room_id>|1|0")>` |
| 周期 | 每 60 秒一次 |
| 起点 | 认证成功后启动，与 WS 心跳各自独立计时 |
| 失败 | 单次失败重试下一次节拍；连续失败计入「HTTP 心跳失败」计数并告警；不因此主动断开 WS，但需在计数达阈值时提示连接可能被判死 |

`hb` 的构造（规范性）：

```text
hb = base64("60|" + 真实room_id + "|1|0")
```

| 参数段 | 含义 |
|---|---|
| `60` | 报活间隔秒数（与 60 秒周期一致） |
| 真实 `room_id` | 真实房间号（不是短号） |
| `1` | 固定值 |
| `0` | 固定值 |

---

## 9. `op=5` 处理流程与子包递归拆分

### 9.1 处理流程

1. 取 `op=5` 帧 body。
2. 按帧 `protover` 处理：`3` → brotli 解压；`2` → zlib 解压；`0` → 直接进入 JSON 解析；`1` → 按整数 body 兼容处理。解压结果为下一轮输入（可能仍是子包拼接）。
3. 按 16 字节头循环消费缓冲区，逐个切出子包。
4. 对每个子包按**其自身** `protover` 处理，规则同步骤 2（子包编码可能与父帧不同）。
5. 解析出的 JSON 若是单体对象，直接作为一条命令；若是数组，逐元素展开为多条命令。
6. 按 `cmd` 查 §10.0 映射表得到 `kind`；未知 `cmd` → `debug` 日志 + 丢弃并计数（不广播、不入缓冲）。
7. 命中映射 → 归一化为 `Message`（见 §10）→ 广播到 `core::bus` 并写入当前会话缓冲。

### 9.2 拆分伪代码

```text
fn handle_business(payload: &[u8], depth: usize) -> Vec<RawCmd>:
    if depth > 4: warn("nesting depth exceeded"); return []      // 递归深度护栏
    let (out, buf) = ([], payload)
    while buf.len() >= 16:
        (packet_len, header_len, protover) = be_u32(buf[0..4]), be_u16(buf[4..6]), be_u16(buf[6..8])
        if header_len != 16 or packet_len < header_len or packet_len > buf.len():
            warn("bad or truncated packet"); break               // 丢弃剩余字节，不断连
        body, buf = buf[header_len..packet_len], buf[packet_len..]
        match protover:
            3 => out.extend(inflate_and_recurse(brotli, body, depth))   // 失败 / 超 16 MiB → warn + 计数 + 跳过该子包
            2 => out.extend(inflate_and_recurse(zlib, body, depth))     // 同上
            0 => out.extend(parse_json_cmds(body))                      // 对象或数组 → 展开
            1 => count_int_body()                                       // 兼容路径：仅计数与日志
            _ => { warn("unsupported protover"); drop_and_count() }
    if buf.len() != 0: warn("trailing bytes ignored", buf.len())
    return out
```

### 9.3 解析健壮性清单

| 场景 | 处理 |
|---|---|
| brotli / zlib 解压抛错 | 丢弃该子包，按编码计入 `bad_brotli` / `bad_zlib`，连接继续 |
| 解压后为空 | 跳过，不计错 |
| JSON 解析失败 | 丢弃该命令，计入 `malformed` + `debug` 日志（含原始字节长度，不含敏感字段） |
| 同一帧内混合 `protover` 子包 | 按子包自身 `protover` 分别处理，不做统一假设 |
| `op=5` 帧 body 为明文单命令 | 等价于单子包路径，走同一函数 |

---

## 10. 命令目录

### 10.0 `cmd` → `kind` 映射（规范性）

| `cmd` | `kind` |
|---|---|
| `DANMU_MSG` | `danmaku` |
| `SEND_GIFT` | `gift` |
| `SUPER_CHAT_MESSAGE` / `SUPER_CHAT_MESSAGE_JP` | `superchat` |
| `INTERACT_WORD` / `INTERACT_WORD_V2` / `ENTRY_EFFECT` | `interact` |
| `GUARD_BUY` / `USER_TOAST_MSG` | `guard` |
| `LIVE` / `PREPARING` / `ROOM_CHANGE` / `CUT_OFF` / `ROOM_REAL_TIME_MESSAGE_UPDATE` / `WATCHED_CHANGE` / `LIKE_INFO_V3_CLICK` / `ONLINE_RANK_V2` / `NOTICE_MSG` / `STOP_LIVE_ROOM_LIST` | `system` |

本表之外的所有 `cmd` 一律不产生 `Message`：仅记录 `debug` 日志（命令名 + `room_id`）并丢弃。`kind` 取值集合恒为六种，新增 `cmd` 不得新增 `kind`。

### 10.1 `DANMU_MSG`（`kind=danmaku`）

语义：普通聊天弹幕，含文本、发送者、颜色、粉丝牌与勋章信息。

| 归一化字段 | 来源（已确定） | 说明 | 校准状态 |
|---|---|---|---|
| `content` | `info[1]` | 弹幕文本原文 | 已确定（契约） |
| `uid` | `info[0][15].user.uid` | 明文用户对象；游客态可能缺失 → 归一化为 `0` | 主体已确定；游客掩码待实测（A3） |
| `uname` | `info[0][15].user.base.name` | 明文用户对象昵称 | 同上 |
| `color` | 文本槽位内部颜色字段 | 十进制 RGB 整数；缺失 → `0` | 待实测校准（A2） |
| `medal_level` | 粉丝牌对象槽位 | 无粉丝牌 → `0` | 待实测校准（A4） |
| `medal_name` | 粉丝牌对象槽位 | 无粉丝牌 → `""` | 待实测校准（A4） |
| `guard_level` | 勋章槽位 | `0` 无 / `1` 总督 / `2` 提督 / `3` 舰长 | 待实测校准（A4） |
| `is_admin` | 房管标记槽位 | 发送者是否房管 | 待实测校准（A5） |
| `upstream_id` | 上游弹幕标识槽位 | 举报弹幕所需；来源待实测 | 待实测校准（A6） |
| `ts` | 载荷中的上游时间戳槽位 | 秒级值统一 ×1000 归一为 UTC 毫秒 | 待实测校准（A7） |
| `room_id` | 连接上下文 | 取真实 `room_id`，不信任载荷内房间字段 | 已确定（契约） |
| `amount` | — | 弹幕恒为 `0` | 已确定（契约） |

```json
{ "cmd": "DANMU_MSG", "info": [ "用户明文与颜色槽位", "文本", "用户编码信息", "粉丝牌", "等级与守护" ] }
```

> `info[1]` 与 `info[0][15].user` 的具体取值已由契约固定；`info` 的其余槽位在实测确认前，实现必须采用「按结构可解析性探测」的容错路径，不得硬编码猜测下标。

噪声过滤建议：

- 空文本或纯空白弹幕不进入会话缓冲，但计入「已收弹幕」计数。
- 屏蔽词 / 关键词过滤属于 UI 层规则（见 [`ui.md`](ui.md)），协议层不丢弃原文。

### 10.2 `SEND_GIFT`（`kind=gift`）

语义：礼物投放（含批量 / 连击）。

| 归一化字段 | 来源（语义槽位） | 说明 | 校准状态 |
|---|---|---|---|
| `content` | 礼物名称 + 数量的组合描述 | 面向展示的说明文本 | 待实测校准（A8） |
| `uid` / `uname` | 送礼用户槽位 | 与 `DANMU_MSG` 用户信息结构不一定同形 | 待实测校准（A8） |
| `amount` | 价格槽位（单价 × 数量，单位为金瓜子） | 无价字段时 `0`，不得猜测 | 待实测校准（A8） |
| 连击标识 | 礼物标识 + 连击数的字段组合 | 供会话内连击聚合（见 §12.3） | 待实测校准（A8） |
| `medal_level` / `medal_name` / `guard_level` | 送礼用户粉丝牌槽位 | 无则 `0` / `""` / `0` | 待实测校准（A4） |
| `ts` | 载荷时间戳槽位 | 归一化为 UTC 毫秒 | 待实测校准（A7） |

噪声过滤建议：

- 单次数量为 0 或礼物标识缺失的载荷视为无效，丢弃并计数。
- 「免费礼物 / 活动礼物」不做特殊丢弃，价格缺失时 `amount=0` 并保留。

### 10.3 `SUPER_CHAT_MESSAGE` / `SUPER_CHAT_MESSAGE_JP`（`kind=superchat`）

语义：醒目留言（SC）及其日文版命令变体。

| 归一化字段 | 来源（语义槽位） | 说明 | 校准状态 |
|---|---|---|---|
| `content` | SC 正文槽位 | 用户提交的留言文本 | 待实测校准（A9） |
| `amount` | 金额槽位 | 单位与人民币展示值的关系待核对 | 待实测校准（A9） |
| `uid` / `uname` | 发送者槽位 | 游客态可能缺失 | 待实测校准（A9） |
| 去重标识 | SC 自身的标识槽位 | 供会话内重复推送判别 | 待实测校准（A9） |
| `ts` | SC 起始时间槽位 | 归一化为 UTC 毫秒 | 待实测校准（A9） |
| `medal_level` / `medal_name` / `guard_level` | 发送者粉丝牌槽位 | 无则零值 | 待实测校准（A4） |

噪声过滤建议：

- 变体命令 `_JP` 与主命令语义等价，归一化到同一 `kind`，不做双份展示。

### 10.4 `INTERACT_WORD` / `INTERACT_WORD_V2` / `ENTRY_EFFECT`（`kind=interact`）

语义：进入直播间、关注、分享等互动提示，以及高价值用户进场特效。

| 归一化字段 | 来源（语义槽位） | 说明 | 校准状态 |
|---|---|---|---|
| `content` | 互动类型的描述文本 | 由 `msg_type`（或等价枚举）映射为中文描述 | 待实测校准（A10） |
| `uid` / `uname` | 触发用户槽位 | `INTERACT_WORD_V2` 需经 protobuf 解码后再取 | 待实测校准（A10、A11） |
| `medal_level` / `medal_name` / `guard_level` | 触发用户粉丝牌槽位 | 无则零值 | 待实测校准（A4） |
| `ts` | 载荷时间戳槽位 | 归一化为 UTC 毫秒 | 待实测校准（A7） |

#### `INTERACT_WORD_V2` 的 protobuf 载荷

`INTERACT_WORD_V2` 与 V1 不同：其载荷**不是 JSON，而是 protobuf**。业务包 JSON 中该命令携带 `data` 字段（base64 字符串），需先 base64 解码再按 protobuf 解析。Rust 侧使用 `prost` 生成/编译 schema 后解码，不得尝试按 JSON 直接解析。

字段表（字段名来自契约描述，具体 tag 号与嵌套定义须在真实抓包中核对，见 A11）：

| protobuf 字段 | 类型（待核对） | 含义 | 归一化去向 |
|---|---|---|---|
| `uid` | 整数 | 触发用户 UID | `Message.uid` |
| `uname` | 字符串 | 触发用户昵称 | `Message.uname` |
| `msg_type` | 枚举 / 整数 | 互动类型（进入 / 关注 / 分享等） | 映射为 `Message.content` 文案 |
| `roomid` | 整数 | 房间号；协议层不信任载荷内房间字段，仍以连接上下文为准 | 仅用于校验/日志 |
| `timestamp` | 整数 | 上游时间戳 | `Message.ts`（秒级 ×1000） |
| `medal_info` | 嵌套消息 | 触发用户粉丝牌信息 | `medal_level` / `medal_name` / `guard_level` |
| `user_info` | 嵌套消息 | 触发用户扩展信息 | 备用；昵称/头像优先取 `uname` |
| `activity_message` | 嵌套消息 | 活动相关附加信息 | 本期不进入归一化字段 |

处理约束：

- 解码失败（base64 非法 / protobuf 解析失败）→ 丢弃该命令，计入 `malformed`，连接继续。
- 未知 `msg_type` 一律使用「互动」+ 原始枚举数值，禁止臆造语义（见 §15.2）。
- V1（`INTERACT_WORD`，JSON）与 V2（protobuf）归一化到同一 `kind`，共用 `Message` 结构。

噪声过滤建议：

- 大批量进入会形成洪峰：UI 侧按类型合并与限流（见 [`ui.md`](ui.md)），协议层不丢弃（会话缓冲仍有价值）。
- `ENTRY_EFFECT` 仅对高价值用户触发，属于低频事件；与 `INTERACT_WORD` 不重复计数。

### 10.5 `DANMU_MSG_MIRROR`（非本房间镜像弹幕，默认丢弃）

语义：`DANMU_MSG_MIRROR` 是**非本房间的镜像弹幕**（上游为跨房间热度/联动推送的内容），不属于当前所观看的直播间。

| 项 | 约定 |
|---|---|
| 默认行为 | **丢弃**，不广播、不入会话缓冲 |
| 计数 | 计入 `mirror_dropped` 计数，供观测（见 §17.2） |
| 日志 | `debug` 级别记录 `room_id` 与来源房间标识（若有），不记录敏感字段 |
| 可配置性 | 本期不提供开关；将来若需要展示镜像弹幕，须先改 `contract.md` 再实现 |

### 10.6 `GUARD_BUY` / `USER_TOAST_MSG`（`kind=guard`）

语义：舰长 / 提督 / 总督的购买与开通播报。

| 归一化字段 | 来源（语义槽位） | 说明 | 校准状态 |
|---|---|---|---|
| `content` | 开通播报文本槽位 | 面向展示的描述 | 待实测校准（A13） |
| `guard_level` | 守护等级槽位 | `1` 总督 / `2` 提督 / `3` 舰长 | 待实测校准（A12） |
| `uid` / `uname` | 购买用户槽位 | `USER_TOAST_MSG` 可能只带昵称 | 待实测校准（A13） |
| `amount` | 价格 / 数量槽位（金瓜子） | 无法确证时 `0`，不得推算 | 待实测校准（A12） |
| `ts` | 载荷时间戳槽位 | 归一化为 UTC 毫秒 | 待实测校准（A7） |

噪声过滤建议：

- 同一笔购买可能同时触发 `GUARD_BUY` 与 `USER_TOAST_MSG`：在会话缓冲写入前按时间窗合并，避免双条播报（见 §12.3）。
- 续费 / 自动续费与首购不做区分，统一落 `guard`。

### 10.7 系统类命令（`kind=system`）

全部系统类命令共用归一化策略：`uid=0`、`uname=""`、`color=0`、`medal_level=0`、`medal_name=""`、`guard_level=0`、`amount=0`；`content` 为对事件的简短中文描述；`ts` 取收到时刻（载荷无时间戳时）或载荷时间戳（有且可解析时）。

| `cmd` | 语义 | `content` 来源 | 缓冲策略 |
|---|---|---|---|
| `LIVE` | 开播 | 固定文案 + 房间标题（若载荷携带） | 与 `PREPARING` 状态互斥，按最新状态覆盖，不逐条展示 |
| `PREPARING` | 下播 / 准备中 | 固定文案 | 同上；连续重复仅计一次状态变更 |
| `ROOM_CHANGE` | 房间信息变更（标题 / 分区 / 封面） | 变更后的标题或分区名 | 仅当房间内存态字段确实变化时写入并广播 |
| `CUT_OFF` | 直播间被切断 | 固定文案 | 写入缓冲；触发 UI 断流提示 |
| `ROOM_REAL_TIME_MESSAGE_UPDATE` | 关注数 / 粉丝数等实时计数更新 | 计数描述 | **高频**：仅更新房间内存计数，**不写入会话缓冲** |
| `WATCHED_CHANGE` | 看过人数变化 | 计数描述 | 同上：只更新计数，不入缓冲 |
| `LIKE_INFO_V3_CLICK` | 点赞信息更新 | 点赞计数描述 | 同上；高频时按时间窗节流广播 |
| `ONLINE_RANK_V2` | 高能榜 / 在线榜更新 | 榜单摘要 | 只更新内存态并驱动 UI 侧栏，不入缓冲 |
| `NOTICE_MSG` | 平台公告 / 房间公告 | 公告文本 | 去重后写入缓冲；与 `LIVE` / `PREPARING` 同房间同秒时合并展示 |
| `STOP_LIVE_ROOM_LIST` | 停播房间列表（全站广播） | 固定文案 + 房间数 | 与当前订阅房间无关的条目直接丢弃 |

### 10.8 未知 `cmd` 与载荷形态异常

| 情况 | 处理 |
|---|---|
| `cmd` 不在 §10.0 表内 | `debug` 日志（命令名、`room_id`）+ 丢弃；计入 `unknown_cmd` 计数 |
| 载荷缺少 `cmd` 字段 | 同上，计入 `malformed` 计数 |
| 载荷为数组 | 逐元素展开后按各元素自身 `cmd` 处理 |
| `data` 字段形态与预期不符（可为对象或数组） | 统一按「对象包装为单元素数组」处理 |
| 归一化必填字段缺失 | 使用零值填充并 `debug` 记录缺失字段名；不丢弃整条消息（计数类除外） |

---

## 11. 发送弹幕：`msg/send` 与 `SendOutcome` 归一化

### 11.1 请求

| 项 | 值 |
|---|---|
| 方法 / 地址 | `POST https://api.live.bilibili.com/msg/send` |
| 鉴权 | 登录态 Cookie（`SESSDATA` + `bili_jct`）与 WBI 签名，见 [`auth.md`](auth.md) |
| 关键参数 | `roomid`（真实房间号）、`msg`（文本）、`color`、`mode`、`csrf`（取 `bili_jct`） |
| 前置校验 | 未登录直接拒绝；同房间最小间隔 2s；相同内容 5s 内去重（见 §15.1） |

### 11.2 被吞判定（`msg` / `message` 字段）

上游 HTTP 返回 `code=0` 不等价于「弹幕已进入公开弹幕流」。存在被静默吞掉的情况，以响应里的 `msg` / `message` 字段判别：

| 响应字段值 | 含义 | 归一化结果 |
|---|---|---|
| `"f"` | 被**平台**风控吞掉 | `blocked_platform` |
| `"k"` | 被**直播间**（主播 / 房管）吞掉 | `blocked_room` |
| 其它正常值 | 已发出 | `ok`（除非命中下方错误码） |
| 非 0 `code` | 对应错误 | 见 §11.3 |

被吞时，**原内容会回显**在响应的 `data.mode_info.extra` 字段里，该字段是 **JSON 字符串**，解析后取其中的 `content`。据此可在 UI 上把「我发的这条被吞了」与被吞原因一起提示给用户。

```text
resp.code != 0                     → 按 §11.3 错误码归一化
resp.msg / resp.message == "f"     → blocked_platform
resp.msg / resp.message == "k"     → blocked_room
其余（code == 0 且无被吞标记）      → ok
被吞时：JSON.parse(resp.data.mode_info.extra).content 为被吞原文
```

### 11.3 归一化到 `SendOutcome`（规范性）

`SendOutcome` 取值与判定来源（`contract.md` §5）：

| 取值 | 含义 | 判定 |
|---|---|---|
| `ok` | 已发出且进入公开弹幕流 | 上游返回成功，且未命中 `"f"` / `"k"` |
| `blocked_platform` | 被平台风控吞掉 | 上游响应 `msg`/`message` == `"f"` |
| `blocked_room` | 被直播间（主播 / 房管）吞掉 | 上游响应 `msg`/`message` == `"k"` |
| `rate_limited` | 频率限制 | 上游对应错误码（具体 code 待实测，A17） |
| `medal_required` | 粉丝牌等级不足 | 上游对应错误码（具体 code 待实测，A17） |
| `muted` | 已被禁言 | 上游对应错误码（具体 code 待实测，A17） |
| `failed` | 其他失败 | 兜底，需带原始 code 与 message |

> `blocked_platform` / `blocked_room` 的判定规则来自一个可复现的社区实现；**阶段 1 必须用真实发送复核后写死**（见 A16 / A17）。在复核前，仅按上表字符判定，不得对具体 `code` 数值编造语义。

---

## 12. 分发与内存缓冲边界

### 12.1 分发链路

`op=5` 帧 → 递归拆子包 / 解压（§9）→ JSON 解析（`INTERACT_WORD_V2` 先 protobuf 解码）→ 按 `cmd` 查 §10.0 映射表 → 归一化为 `Message` → `core::bus` 广播 + 当前会话环形缓冲 → Tauri IPC 事件 `danmubox://message`。

### 12.2 会话内环形缓冲

| 项 | 约定 |
|---|---|
| 存储形态 | **纯内存**环形缓冲，随房内会话销毁（`contract.md` §4.3） |
| 生命周期 | = **一次房内会话**：进入某个直播间开始，离开该房间（返回房间列表、关闭房间或切走）即**销毁并清空**；再次进入同一房间是全新会话 |
| 容量 | 上限 5000 条（键 `history.buffer_rows`），超出丢最旧 |
| 进程退出 | 全部丢失，不做恢复 |
| 查询 | `history_query` 只查**当前会话**缓冲（`limit` / `after` / `before` / `kinds` / `uid` / `q`） |
| 计数类命令 | 永不写入缓冲（见 §10.7），仅更新房间内存态 |
| 序号 | 每条 `Message.local_id` 为会话内自增，仅供 UI key 与本地引用，进程重启重置 |

### 12.3 会话内聚合

| 场景 | 处理 |
|---|---|
| 上游重复推送同一条弹幕 | 不做跨会话去重；相同内容由 UI 相似合并处理 |
| 礼物连击 | 按「礼物标识 + 连击序号」在会话缓冲内聚合展示，避免刷屏 |
| `GUARD_BUY` 与 `USER_TOAST_MSG` 同笔 | 按时间窗合并为一条播报 |
| 重连 | 不清空已收缓冲（同一次会话），重连后继续追加 |

---

## 13. 重连状态机

### 13.1 状态机

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Resolving: rooms_connect(room)
    Resolving --> FetchingInfo: getRoomPlayInfo 成功
    Resolving --> Backoff: 房间不存在 / 上游错误
    FetchingInfo --> Connecting: getDanmuInfo 成功
    FetchingInfo --> Backoff: 接口失败 / 未登录且游客参数不可用
    Connecting --> Authenticating: WSS 打开
    Connecting --> Backoff: 握手失败 / TLS 错误 / 节点不可用
    Authenticating --> Live: op=8 且 code=0
    Authenticating --> AuthFailed: op=8 且 code≠0，或 10 秒超时
    AuthFailed --> Backoff: 未达失败上限
    AuthFailed --> Failed: 连续失败达上限
    Live --> Backoff: 主动断开 / 网络错误 / 90 秒无入站帧
    Live --> Resolving: rooms_reconnect（手动，见 §14）
    Backoff --> Resolving: 退避到期（重新解析与取连接参数）
    Failed --> Resolving: 人工 rooms_connect
    Live / Backoff / Failed --> Idle: rooms_disconnect
```

### 13.2 参数（规范性）

| 参数 | 值 | 说明 |
|---|---|---|
| 心跳参数 | 见 §8.1 / §8.2 | WS `op=2` 30 s（首包 60 s 内）、HTTP 心跳 60 s；僵死判定 90 s 无入站帧 |
| 退避序列 | 5s / 10s / 20s / 40s / 60s（封顶） | 指数退避，超出后保持 60s |
| 抖动 | ±20% | 实际等待 = 基准 ×(1 ± 0.2)，随机取值 |
| 重连前动作 | **必须**重新调用 `getDanmuInfo` | 不重用旧 `token` / 旧节点；房间信息若可能变化则一并重取 |
| 连接成功后退避复位 | 是 | 进入 `Live` 即把退避计数清零 |
| 认证失败上限 | 连续 3 次 | 达上限进入 `Failed`，停止自动重连 |
| 重连期间的心跳 | 取消定时器 | 断开即停，不在退避期发送；HTTP 心跳同样暂停 |

### 13.3 认证失败分支

| 步骤 | 动作 |
|---|---|
| 1 | 收到 `op=8`：解析 body，取 `code` 原值 |
| 2 | `code=0` → 进入 `Live`，启动 WS / HTTP 心跳定时器，复位退避计数 |
| 3 | `code≠0` → 记 `warn`：`code` 数值原值 + `op=8` 原始 body（脱敏）写入 `debug` 日志；**不得**为未知 code 编造含义 |
| 4 | 若为登录态且上游语义指向凭据失效 → 标记会话可能失效，通过 `danmubox://session` 事件通知前端 |
| 5 | 连续失败计数 +1；未达上限 → 进入 `Backoff`（按 §13.2 等待，重跑房间解析与 `getDanmuInfo`） |
| 6 | 连续失败达 3 次 → 进入 `Failed`：房间状态置为 error，发 `danmubox://room` 事件，等待人工 `rooms_connect` |

> 认证失败**不**降级为游客重连：静默降级会让用户以为已登录（发弹幕、完整字段）而实际不是。降级必须是显式用户选择。

### 13.4 重连期间的数据一致性

| 场景 | 处理 |
|---|---|
| 断线期间的弹幕 | 无法补收（协议不提供断点续传）；重连后重新开始接收 |
| 会话缓冲 | 自动重连**不清空**缓冲；重连后继续在**同一次会话**内追加（见 §12.2） |
| `LIVE` / `PREPARING` 状态 | 重连成功后以首帧或重取的房间信息重新校准 `live_status` |
| 观测 | 通过 `danmubox://status` 暴露重连次数与最近错误，供排障（见 [`ipc.md`](ipc.md)） |

---

## 14. 手动重连（`rooms_reconnect`）

对应 REQUIREMENTS.md「房间内『刷新』按钮：长连接卡住或推流暂时中断时手动重连」。

| 项 | 约定 |
|---|---|
| 触发 | 房间内「刷新」按钮 → IPC `rooms_reconnect`（见 [`ipc.md`](ipc.md) / [`ui.md`](ui.md)） |
| 语义 | **断开当前 WS 后立即重建连接**：跳过退避等待，直接重跑 `getDanmuInfo`（必要时重取房间信息）并重新认证 |
| 缓冲 | **不清空**已收缓冲；仍属同一次房内会话 |
| 定时器 | 旧 WS / HTTP 心跳定时器全部取消，按新连接重建 |
| 与自动重连的区别 | 自动重连遵守 5/10/20/40/60s 退避且连续认证失败 3 次后停止；手动重连跳过退避、且会重置自动重连的失败计数后重试 |
| 当前状态为 `Live` 时 | 幂等：先断开旧连接再按上表重建，不并发建立第二条 WS |
| 前置 | 需要有效凭据（游客亦可）；凭据失效时仍以 `Failed` 状态提示重登 |

---

## 15. 风控与限流

### 15.1 发送侧（弹幕）

| 规则 | 值 | 执行点 |
|---|---|---|
| 同房间最小发送间隔 | 2 s | `chat_send` 前置校验，违反 → `SendOutcome::rate_limited`（本地判定） |
| 相同内容去重窗口 | 5 s | 同上；窗口内重复内容直接拒绝，不发起上游请求 |
| 未登录发送 | 直接拒绝 | 返回未登录错误，不发起上游请求 |
| 上游明确限流 / 风控响应 | 不自动重试 | 按 §11.3 归一化后上报，提示用户等待 |
| 颜色 / 模式参数 | 仅透传合法值 | 非法值 → `BAD_REQUEST` |

> 上游返回的错误码在实测确认前，一律只做「认证类 / 限流类 / 其他」三类粗分（分类规则见 A15），不得对具体数值赋予编造含义。

### 15.2 异常 code 处理原则

| 原则 | 说明 |
|---|---|
| 不臆造语义 | 未在真实流量中确认的 `code`，只记录数值与原始 body，禁止在代码或文档中写「= 未登录」「= 被禁言」之类的解释 |
| 只做粗分类 | 分类依据必须是实测得到的证据；分类未知时归入「其他」，按「不可重试的一次性错误」处理 |
| 不绕过限流 | 不得通过多连接、多账号、缩短退避、并发重试等方式规避上游限流 |
| 记录证据 | 每个未确认 `code` 首次出现时，写出 `warn` 日志并保留脱敏后 body 片段，作为附录 A 校准输入 |

### 15.3 连接侧

| 规则 | 说明 |
|---|---|
| 单房间单连接 | 同一 `room_id` 同时只允许一条 WS；重复 `rooms_connect` 幂等 |
| 遵守退避 | 禁止在退避窗口内主动重试或「心跳探测」，手动重连（§14）除外 |
| 节点切换 | 同一节点连续失败 2 次后切换 `host_list` 下一项；全部失败回到首项并继续退避 |
| 并发上限 | 订阅房间数上限由偏好在 UI 侧约束；协议层不做硬限，但每房间独立 supervisor，避免相互阻塞 |
| 禁止行为 | 自动化刷弹幕、批量小号、抓取非公开接口数据 |

---

## 16. 安全红线（所有文档一致复述）

需求来源：REQUIREMENTS.md「cookie 弄个配置文件存进去」。凭据存**明文 `config.toml`**（权限 0600，手工可编辑），界面偏好存 `prefs.json`。

| 禁止 | 说明 |
|---|---|
| `SESSDATA` / `bili_jct` / `DedeUserID` 进入日志 | 包括 `debug` 级别、协议帧日志、崩溃上报 |
| 上述凭据进入前端明文 | IPC 载荷与事件不得携带凭据值 |
| 上述凭据进入仓库 | 任何文件、fixture、示例中不得出现真实值 |
| 认证包 `key` 原文入库 / 入日志 | 日志中一律固定掩码输出 |

| 允许 | 说明 |
|---|---|
| `debug` 日志记录 `buvid3` | 匿名设备标识，可轮换；仍不得与 Cookie 一并成组导出 |

---

## 17. 观测与流量采集

### 17.1 日志

| 项 | 约定 |
|---|---|
| 开关 | 环境变量 `DANMUBOX_LOG`，默认 `info`；协议帧级细节需 `debug` |
| `info` 级别内容 | 连接状态迁移、认证结果（仅 `code` 数值）、重连次数、异常计数汇总 |
| `debug` 级别内容 | 每帧方向、`op`、`protover`、`packetLen`、`seq`、解析出的 `cmd` 列表；解析失败原因 |
| 帧日志脱敏 | `key` 掩码；Cookie 永不出现；样本片段先剥离敏感键 |
| 输出 | 经 `danmubox://log` 事件与标准输出呈现（见 [`ipc.md`](ipc.md)）。协议帧日志与上游 `GET` / `POST` 请求互不复用该通道 |

### 17.2 计数

| 计数 | 含义 |
|---|---|
| `frames_rx` / `frames_tx` | 收 / 发帧总数 |
| `subpackets` | 拆分出的子包数 |
| `bad_brotli` / `bad_zlib` | brotli / zlib 解压失败次数 |
| `oversize_dropped` | 解压后超过 16 MiB 被丢弃的子包数 |
| `trailing_bytes` | 尾部残留字节帧数 |
| `mirror_dropped` | `DANMU_MSG_MIRROR` 丢弃数 |
| `unknown_cmd` | 未映射命令数 |
| `malformed` | JSON / protobuf 解析失败或缺少 `cmd` 数 |
| `reconnects` | 自动重连次数（手动重连另计） |
| `auth_failures` | 认证失败次数（含 `code` 分布计数） |
| `http_hb_failures` | HTTP 心跳失败次数 |

### 17.3 回放与 fixture

| 项 | 约定 |
|---|---|
| 录制 | `debug` 日志中的脱敏帧字节可导出为 fixture（单一 JSON 或二进制序列），用于离线回放 |
| 用途 | 协议层单元测试与回归（构造单包 / 嵌套包 / 截断包 / 坏 brotli / 坏 zlib），见 [`testing.md`](testing.md) |

---

## 附录 A：字段索引待实测校准表

本表是**唯一**允许承载「未实测事实」的位置。表中条目在阶段 1 完成核对前，实现中不得硬编码依赖具体下标 / 枚举值的解析路径；解析实现必须先采用「按结构可解析性探测」的容错路径，核对完成后回填结论并注明日期。采集一律以 `DANMUBOX_LOG=debug` 运行并抓取 debug 日志（方法见附录 B）。

| 编号 | 待核对对象 | 需要确认的内容 | 采集方法 | 核对动作 | 影响面 |
|---|---|---|---|---|---|
| A1 | `DANMU_MSG` 的 `info` 数组 | `info[1]` 为文本、`info[0][15].user` 为明文用户对象之外，其余槽位（颜色、粉丝牌、等级/守护）的确切下标与类型 | `DANMUBOX_LOG=debug` 抓帧，取原始 `op=5` body | 对同一房间连续 3 条弹幕比对原文与字段值，确认槽位后写入 §10.1 表 | 弹幕内容、UID、昵称提取 |
| A2 | `DANMU_MSG` 文本槽位内部 | 颜色字段的位置、是否为十进制 RGB、缺省值形态 | 同上 | 取彩色弹幕（含自定义色）与普通弹幕各 2 条对照 | `color` |
| A3 | `DANMU_MSG` 用户信息 | `info[0][15].user` 在游客态是否被掩码、`uid` 是否随之为 0、昵称是否脱敏 | 同上，另加一次游客模式连接对照 | 记录登录态与游客态各 3 条，确认掩码形态 | `uid`、`uname`、游客标识 |
| A4 | 粉丝牌 / 勋章结构（`medal_level` / `medal_name` / `guard_level`） | 粉丝牌对象的位置、等级与名称字段名；`guard_level` 与勋章守护等级是否为同一值 | 同上，需覆盖有牌 / 无牌 / 舰长 / 提督 / 总督样本 | 收集至少 5 类样本建立映射表 | `medal_level`、`medal_name`、`guard_level`（影响全部命令） |
| A5 | `Message.is_admin`（房管标记） | 发送者是否房管的判定字段名与取值形态（布尔 / 等级 / 位标志） | 同上，需一名房管账号发言样本 | 以已知房管与非房管各 3 条对照，确定判定式 | 房管徽标、`is_admin` |
| A6 | `Message.upstream_id`（举报所需标识） | 举报弹幕所需的上游标识位于哪个槽位（弹幕 id / 消息 id / 组合串） | 同上，抓取一条可被举报的弹幕原文 | 用该标识对目标弹幕发起一次举报并核对是否命中，确认取哪个槽位 | `chat_report`、`upstream_id` |
| A7 | 时间戳字段 | 各命令载荷中时间戳的字段名与单位（秒 / 毫秒）；缺失时是否可安全回退到本地时间 | 同上 | 与本地收帧时间比对，误差应在秒级以内；写入归一化规则 | `ts` 全命令 |
| A8 | `SEND_GIFT`（含金额与连击字段） | 礼物名称、数量、单价（金瓜子）字段名；礼物标识与连击数（去重聚合用）字段名；用户 UID / 昵称字段名 | 同上 | 连续触发单价礼物与连击礼物各一次，比对数值与连击字段 | `content`、`amount`、连击聚合 |
| A9 | `SUPER_CHAT_MESSAGE` / `_JP`（含金额与去重字段） | SC 标识、金额、正文、时长字段名；`_JP` 与主命令的载荷差异 | 同上，需真实 SC 样本 | 各取 1 条 SC，确认金额口径与去重标识 | `superchat` 全字段 |
| A10 | `INTERACT_WORD`（V1） | 互动类型枚举的字面值与取值集合（进入 / 关注 / 分享等） | 同上 | 按可触发的类型逐项采集，建立完整映射后再写描述文案 | `content` 文案 |
| A11 | `INTERACT_WORD_V2` 的 proto 字段名 | 上表 §10.4 所列 8 个字段的真实 tag 号、类型与嵌套结构；`msg_type` 枚举值与文案映射 | 同上，需一条 V2 进场样本与一条 V1 同场景样本 | base64 解码 `data` 后用 `prost` 试解，与 V1 对照确认字段名与语义 | `interact` 解析、`prost` schema |
| A12 | `GUARD_BUY` | 守护等级字段、数量与价格字段及单位（金瓜子 / 月） | 同上，需一次真实开通样本 | 记录数值并核对等级取值方向（1 总督 / 2 提督 / 3 舰长） | `guard_level`、`amount` |
| A13 | `USER_TOAST_MSG` | 播报文本、角色、数量字段；与 `GUARD_BUY` 的时间关系 | 同上 | 同一次开通同时记录两条命令，确认合并规则 | `guard` 会话内合并与文案 |
| A14 | `ENTRY_EFFECT` | 触发用户的 UID / 昵称 / 舰长等级字段位置 | 同上 | 以高价值账号进场触发，记录字段 | `interact` 归一化 |
| A15 | `op=8` 认证回应 | body 字段名、`code` 的实际取值集合与各分类归属 | 同上，另加「未登录 / 登录失效」两种状态各一次 | 记录全部出现过的 `code` 与对应状态，建立粗分类表 | §13.3、§15.2 |
| A16 | `msg/send` 被吞判定 | `msg` / `message` == `"f"` / `"k"` 的可复现性；`data.mode_info.extra` 的 `content` 回显形态 | 同上，用会触发风控的内容与在关闭公开弹幕的直播间各发一次 | 复核 `"f"` / `"k"` 判定后写死规则，记录 `extra` 的 JSON 形状 | §11.2、`SendOutcome` |
| A17 | `SendOutcome` 各错误码 | `rate_limited` / `medal_required` / `muted` / `failed` 各自对应的上游 `code` 与 message 文案 | 同上；需构造频率限制、粉丝牌不足、被禁言三类场景各一次 | 记录 `code` + message + 场景，建立归一化映射表 | §11.3、UI 失败提示 |
| A18 | `msg/send` 请求参数 | `color` / `mode` 的合法取值域与默认值（IPC 侧初值 0–16777215 / {1,4,5}） | 同上，用边界值与疑似模式值各发一次 | 确认合法域后回填本节与 [`ipc.md`](ipc.md) | 发送侧校验 |
| A19 | `host_list` 元素 | 节点字段名（主机、`wss_port` / `ws_port`）与地址拼接规则、节点顺序是否即优先级 | 同上，打印 `getDanmuInfo` 响应（脱敏） | 对每个节点实际建立一次连接验证可达性 | §2.1、§15.3 |
| A20 | 僵死判定与 HTTP 心跳必要性 | 上游在心跳停发 / 网络中断时是否主动关闭；90 秒阈值是否合适；缺失 HTTP 心跳时的判死时间 | 同上，做一次「只发 WS 心跳、不发 HTTP 心跳」与一次断网实验 | 观察断开行为，必要时调整阈值并更新 §8.2 / §13.2 | §8、§13.2 |
| A21 | 游客模式字段覆盖 | 游客态下具体哪些命令 / 字段缺失或被掩码 | 游客连接 + 同一房间登录连接对照 | 对同一时间窗的两份数据做字段差集 | §7.2、§10 各命令 |

---

## 附录 B：待实测校准的采集与核对流程

### B.1 采集步骤

1. 以 `DANMUBOX_LOG=debug` 启动应用（日志级别默认 `info`，`debug` 才会输出帧级细节）。
2. 加入目标房间并触发 `rooms_connect`，等待认证成功（`op=8` 且 `code=0`）。
3. 采样窗口 ≥10 分钟，且必须覆盖以下事件：普通弹幕、彩色弹幕、礼物（含连击）、SC、舰长开通、用户进入（含 V2）、直播开始或结束、系统公告、一次发送（含一次被吞）。
4. 从 `danmubox://log` 事件或标准输出拉取 debug 日志，日志条目含方向、`op`、`protover`、`cmd`、脱敏后的样本片段。
5. 用 `jq` 按 `cmd` 过滤出目标载荷，例如列出本次采集中出现的全部命令名与计数，确认待核对命令确实被覆盖。
6. 逐条对照附录 A 的编号，记录实测结论。
7. 若需二进制级标定（例如确认嵌套子包的层级或 protobuf tag），用 §9.2 的伪代码写一次性校验脚本，仅在本机临时使用，不进入仓库。

### B.2 核对动作与回填

| 动作 | 要求 |
|---|---|
| 结论回填 | 把附录 A 对应行从「待实测校准」改为实测结论，并在该行注明核对日期与样本数量 |
| 实现同步 | 回填后同步更新 §10 各命令的「来源」列与解析实现；两者不得长期不一致 |
| 证据留存 | 脱敏后的样本片段按 §17.3 转为 fixture，纳入 [`testing.md`](testing.md) 的回放测试 |
| 未覆盖项 | 若某条目在采样窗口内未出现（如从未触发舰长开通），保持「待实测校准」状态并在行内注明所需触发条件，不得以推测值填充 |

### B.3 禁止事项

| 禁止 | 说明 |
|---|---|
| 为未核对的下标 / 枚举值 / `code` 编造确定语义 | 包括代码常量、文档表格与注释 |
| 用「参考第三方实现」代替实测 | 第三方实现可作为解析容错设计的参考，但结论必须由本项目真实流量确认 |
| 保留未脱敏样本 | 任何采集产物入库或进 fixture 前必须移除凭据类字段（§16） |
