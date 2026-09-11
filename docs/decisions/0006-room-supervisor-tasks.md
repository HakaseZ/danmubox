# ADR 0006：每个房间一个 supervisor task，事件经 broadcast 广播

> 定位：确定多房间并发连接的运行模型：任务粒度、事件分发通道、背压取向与手动重连语义。
> 读者：实现并发层、事件总线、房间会话与重连逻辑的开发者与 AI agent。
> 更新时机：需要改变房间并发模型（例如改为共享连接）、会话生命周期定义变化、或背压策略被实测证明不适用时。

| 项 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-09-11 |
| 决策者 | 项目作者 |
| 影响面 | `crates/danmubox-core/`（会话编排、事件总线）、`crates/danmubox-bili/`（连接与解包）、`docs/architecture.md`、多房间行为 |
| 相关文档 | [`../contract.md`](../contract.md) §4、§5、§6、§7、[`../architecture.md`](../architecture.md)、[`0003-protover3.md`](0003-protover3.md)、[`0004-upstream-isolation.md`](0004-upstream-isolation.md)、[`0005-no-local-database.md`](0005-no-local-database.md)、[`../ipc.md`](../ipc.md)、[`../protocol.md`](../protocol.md) |

## Context

客户端需要同时连接多个直播间，并让每个房间独立地完成一整套生命周期动作：

| 阶段 | 动作 |
|---|---|
| 建连准备 | 短号 / URL → 真实 `room_id`：使用 `getRoomPlayInfo`，一次拿到 `room_id` / `uid` / `live_status` |
| 连接 | WebSocket 建连 → 发送认证包（`op=7`，帧头 `protover=1`，body 声明 `protover=3`）→ 等待认证回应（`op=8`，`code=0` 为成功） |
| 保活（WS） | 心跳 `op=2`，帧头 `protover=1`，body 为字面量 `[object Object]`；连接后首包须在 60 秒内发出，收到 `op=3` 回应后重置为 30 秒周期 |
| 保活（HTTP） | 每 60 秒 `GET https://live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat`，参数 `pf=web` 与 `hb=base64("60|<真实room_id>|1|0")`；缺它连接会被上游判死 |
| 收包 | `op=5` 业务消息，可能是 zlib / brotli 压缩；解压后可能仍是多子包拼接，需递归拆分（见 [`0003-protover3.md`](0003-protover3.md)） |
| 归一化 | 按 `cmd` 映射为六种 `kind`，产出统一 `Message`；`INTERACT_WORD_V2` 载荷是 protobuf，`DANMU_MSG_MIRROR` 默认丢弃并计数 |
| 异常 | 认证回应非 0 一律视为认证失败，按退避重连；**不得**在未知 `code` 上编造含义 |
| 自动重连 | 退避 5s / 10s / 20s / 40s / 60s 封顶；重连前重新解析房间并重新取认证材料 |
| 手动重连 | 房间内「刷新」按钮 → IPC `rooms_reconnect`，用于长连接卡住或推流中断 |

关键事实：不同房间的认证材料（`token` 与 `host_list`）各自独立，认证包也必须携带各自的 `roomid` 与 `key`；因此「一个连接覆盖多个房间」在协议层并不成立。

消费侧有多个：UI（可能同时订阅多个房间）与 CLI，将来可能再加别的消费面。它们以不同速率消费同一份事件流；本期没有落库写入路径（见 [`0005-no-local-database.md`](0005-no-local-database.md)）。

## Decision

**每个已连接房间对应一个独立的 supervisor task，持有该房间从建连到重连的完整状态；归一化后的事件通过 `tokio::sync::broadcast` 广播给所有订阅者。**

| 决策点 | 取值 |
|---|---|
| 任务粒度 | 每房间一个 supervisor task（解析房间、连接、认证、双心跳、收包、解包、归一化、发布） |
| 房间隔离 | 任一房间的失败（认证失败、网络中断、解析异常）只影响该房间的 task，不影响其他房间与进程 |
| 消息分发 | `broadcast` 通道；每个房间一条通道，订阅者按房间订阅 |
| 会话缓冲 | 归一化后的 `Message` 写入该房间的内存环形缓冲（上限 5000 条，随会话销毁）；**不落盘**，见 [`0005-no-local-database.md`](0005-no-local-database.md) |
| 缓冲归属 | 缓冲属会话；supervisor 是「每房间状态」的唯一所有者，不跨任务共享 |
| 慢消费者 | 不阻塞 supervisor：订阅者落后时收到 `Lagged` 并自行跳帧追赶，丢弃的是该订阅者自己的历史，不是全局事件 |
| 通道容量 | 有界，容量作为实现常量固定；具体取值见 [`../architecture.md`](../architecture.md) |
| 手动重连 | `rooms_reconnect` 投递给**同一 supervisor**，跳过退避立即重建连接；**不清空**已收缓冲（仍属同一次会话） |
| 停止语义 | 房间 disconnect / 离开房间 / 应用退出时显式取消 task；取消后必须释放连接与两个心跳定时器 |
| 状态回传 | 连接状态变化（连接中 / 已连接 / 重连中 / 已断开）作为独立事件发布，供 UI 与 IPC 使用 |

`Message` 字段形状（`local_id` / `room_id` / `kind` / `ts` / `uid` / `uname` / `content` / `color` / `medal_level` / `medal_name` / `guard_level` / `is_admin` / `amount` / `upstream_id`）是规范性的（[`../contract.md`](../contract.md) §5），supervisor 只做映射，不做裁剪或改名；`ts` 统一为 UTC 毫秒 `i64`。

`cmd` → `kind` 映射（本节为规范实现的摘要，取值以契约 §5 与 [`../protocol.md`](../protocol.md) 为准）：

| `cmd` | `kind` |
|---|---|
| `DANMU_MSG` | `danmaku` |
| `SEND_GIFT` | `gift` |
| `SUPER_CHAT_MESSAGE` / `SUPER_CHAT_MESSAGE_JP` | `superchat` |
| `INTERACT_WORD` / `INTERACT_WORD_V2` / `ENTRY_EFFECT` | `interact` |
| `GUARD_BUY` / `USER_TOAST_MSG` | `guard` |
| 生命周期类（`LIVE` / `PREPARING` / `ROOM_CHANGE` / `CUT_OFF` / `ROOM_REAL_TIME_MESSAGE_UPDATE` / `WATCHED_CHANGE` / `ONLINE_RANK_V2` / `NOTICE_MSG` 等） | `system` |
| `DANMU_MSG_MIRROR` | 丢弃并计数（非本房间的镜像弹幕） |

上游字段的取用与归一化只允许出现在 `danmubox-bili`（见 [`0004-upstream-isolation.md`](0004-upstream-isolation.md)）。

## Consequences

### 正面

- 房间之间完全隔离：一个房间被风控限流或断开，不影响其他房间的观看。
- supervisor 是「每房间状态」的唯一所有者：重连退避计数、两个心跳定时器、认证材料都无需跨任务共享，不存在状态竞争。
- 订阅者模型天然适配多消费面：UI 与 CLI 各自订阅，互不等待；将来新增消费面不需要改 supervisor。
- 取消语义清晰：disconnect 即取消 task，资源回收路径唯一。
- 手动重连与自动重连走同一条代码路径，只是前者跳过退避，行为可预期。
- 与协议事实一致：各房间的认证材料本就独立，任务模型不需要为共享做让步。

### 负面

- N 个房间 = N 条 WebSocket 连接、N 组定时器与 N 条 broadcast 通道，资源占用随房间数线性增长（自用场景房间数很小，可接受）。
- 每个订阅者要自行处理 `Lagged`（UI 需要知道「我丢过帧」并据此提示或重新查询当前会话缓冲）。
- 广播通道是单向的，需要双向交互的操作（发弹幕、手动重连）不能走该通道，必须通过 `core` 暴露的独立接口。
- 双心跳（WS + HTTP）意味着每个房间有两组定时器与两倍的心跳相关失败模式，需要分别处理与观测。

### 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| task 泄漏 | 房间被移除但 task 未取消，连接与定时器残留 | disconnect / 离开房间 / remove 走同一条取消路径；退出时统一关闭序列 |
| 订阅者永久落后 | 订阅者处理过慢，长期只收到 `Lagged` | 慢消费者自行跳帧；UI 以当前会话缓冲为准重新查询 |
| 重连风暴 | 大量房间同时断线，退避对齐导致同时重连 | 退避 5/10/20/40/60s 封顶；重连前重新解析房间并取认证材料，天然错开 |
| 手动重连被误当会话切换 | 实现时把 `rooms_reconnect` 接到「重建会话」，导致缓冲被清空 | 契约与本文均规定重连不清空缓冲；纳入回归用例 |
| 未知认证 code 被误判 | 把未知 `code` 当作成功或编造含义，导致静默失效 | 规范硬性规定：非 0 一律视为失败并按退避处理，未知 `code` 只记录不解释 |
| 漏掉 HTTP 心跳 | 只发 WS 心跳，连接被上游判死且表现为「莫名频繁重连」 | 两条心跳都写在契约常量里；连接生命周期用例覆盖；日志区分两类心跳 |
| 上游协议变更 | 新 `cmd` 出现导致消息被丢弃 | 未映射 `cmd` 记日志并丢弃，不静默崩溃；字段与命令名变更只改 `danmubox-bili`（见 [`0004-upstream-isolation.md`](0004-upstream-isolation.md)） |

## Alternatives considered

### 1. 单条 WebSocket 连接承载多个房间

否决理由：与协议事实冲突——认证包绑定单一 `roomid` 与 `key`，每个房间的认证材料也是各自发放的。强行共享意味着要为每个房间维护逻辑通道并处理跨房间的退避与重连，复杂度上升而收益（少几条连接）在本项目规模下毫无意义。

重新启用的条件：上游提供官方多房间订阅能力，且实测确认可用（属「待实测校准」事项，见 [`../protocol.md`](../protocol.md) 附录）。

### 2. 按职责拆分多个任务（连接任务 + 心跳任务 + 解析任务各一）

否决理由：把一个房间的状态切碎到多个任务之间，就必须共享认证材料、退避计数、连接句柄与心跳定时器，等于用锁和通道重新引入竞争；错误处理也会分裂（谁负责触发重连？）。单一 supervisor 让「每房间状态」有唯一所有者，代码路径更短且更容易推理。

重新启用的条件：单个房间的处理负载高到必须并行化解析（当前负载数十条/秒，不成立）。

### 3. 按需连接：打开某房间才连接，关闭即断开

否决理由：本期连接控制是显式的 `rooms_connect` / `rooms_disconnect`；若把长连接绑定到视图层的标签切换，会把「连接生命周期」与「会话生命周期」耦合在一起，用户切走再切回时连接与会话边界容易不一致。当前选择「已添加的房间按显式指令保持连接」。

重新启用的条件：房间数增长到连接资源成为真实问题；届时改为按订阅者引用计数懒连接，但必须重新定义会话边界并同步契约 §4.3。

### 4. 使用 OS 线程（`std::thread`）而非异步 task

否决理由：每房间一个线程在移动端（Android）开销明显，且线程无法高效地与广播通道、定时器共存；异步运行时的定时与取消语义更契合「双心跳 + 退避 + 多订阅者」这套需求。

重新启用的条件：出现异步运行时无法覆盖的阻塞式依赖。

### 5. 用 `mpsc` 点对点分发替代 `broadcast`

否决理由：订阅者数量与生命周期是动态的（UI 可能关闭某个房间的标签页），点对点通道要求 `core` 维护订阅者名单并在断开时清理，等于手工实现一遍广播；`broadcast` 的 `Lagged` 语义还顺带给出了「慢消费者自行跳帧」这一我们想要的背压行为。

重新启用的条件：需要精确的逐条投递确认（当前不需要）。
