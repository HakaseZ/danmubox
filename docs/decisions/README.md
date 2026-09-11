# 架构决策记录（ADR）

> 定位：记录 danmubox 开发期已经定案、且影响面横跨多个模块或 crates 的技术决策及其理由。
> 读者：项目作者、参与协作的 AI 编码 agent、后续接手维护者。
> 更新时机：新增决策时追加编号文件并更新本索引；已有决策被推翻时新增一篇 superseded 记录并在两篇中互相标注，禁止直接改写历史记录。

## 什么是 ADR

ADR（Architecture Decision Record）只回答三个问题：**当时面对什么约束、选择了什么、代价是什么**。它不替代规范性文档：

| 文档 | 回答的问题 | 位置 |
|---|---|---|
| ADR | 为什么这样定案，当时否决了什么 | 本目录 |
| 基线契约 | 命名、共享常量、领域模型、端口边界、IPC 与本地文件契约的唯一事实源 | [`../contract.md`](../contract.md) |
| 架构文档 | 系统如何分层、如何并发运行 | [`../architecture.md`](../architecture.md) |
| 接口文档 | IPC 命令与事件、字段的精确契约 | [`../ipc.md`](../ipc.md) |

## 索引

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](0001-tauri-over-flutter.md) | 采用 Tauri 2 而非 Flutter 作为客户端外壳 | Accepted | 2026-09-11 |
| [0002](0002-rust-core-shared-surfaces.md) | `danmubox-core` 不依赖 UI，能力一律经端口暴露 | Accepted | 2026-09-11 |
| [0003](0003-protover3.md) | 弹幕连接固定协商 `protover=3`（brotli），解码兼容 0/1/2/3 | Accepted | 2026-09-11 |
| [0004](0004-upstream-isolation.md) | B 站相关实现全部收敛在 `danmubox-bili`，`core` 只定义端口与领域模型 | Accepted | 2026-09-11 |
| [0005](0005-no-local-database.md) | 不建本地数据库：弹幕只保留在内存环形缓冲，生命周期为一次房内会话 | Accepted | 2026-09-11 |
| [0006](0006-room-supervisor-tasks.md) | 每个房间一个 supervisor task，事件经 broadcast 广播 | Accepted | 2026-09-11 |
| [0007](0007-credential-file.md) | 凭据存明文 `config.toml`（0600），偏好另存 `prefs.json` | Accepted | 2026-09-11 |
| [0008](0008-frontend-stack.md) | 前端采用 React + TS + Vite + TanStack Virtual + Zustand + CSS Modules | Accepted | 2026-09-11 |

编号分配规则：全部决策落在此表，编号连续，不跳号、不复用已删除编号。状态取值只有 `Accepted` / `Superseded by NNNN` / `Deprecated`（本期全部为 `Accepted`）。本目录曾于需求基线确定时整体重整，编号不跳号。

## 与规范性基线的关系

以下内容由 [`../contract.md`](../contract.md) 规定，属规范性常量与契约，ADR **只解释理由、不改写取值**。任何取值变更必须同时改契约、改本文档与全部引用方：

| 主题 | 规范位置 | 相关 ADR |
|---|---|---|
| 依赖方向与端口边界 | `contract.md` §3 | 0002、0004 |
| 共享常量（心跳、退避、节流、压缩、单包上限、时间表示） | `contract.md` §4 | 0003、0004、0005、0006 |
| 本地文件与凭据 / 偏好 | `contract.md` §4.1、§4.2 | 0007 |
| 弹幕内存缓冲与生命周期 | `contract.md` §4.3 | 0005、0006 |
| 消息模型与 `cmd` → `kind` 映射 | `contract.md` §5、[`../protocol.md`](../protocol.md) | 0003、0004、0006 |
| 协议要点（包头、`op`、`protover`、认证包 / 心跳包 body） | `contract.md` §6、[`../protocol.md`](../protocol.md) | 0003、0006 |
| IPC 命令与事件 | `contract.md` §7、[`../ipc.md`](../ipc.md) | 0002、0008 |
| 偏好键 | `contract.md` §8 | 0008 |
| 前端栈与状态管理 | [`../ui.md`](../ui.md)、[`../ipc.md`](../ipc.md) | 0008 |

依赖方向（规范性）：`danmubox-bili` → `danmubox-core`；`danmubox-cli` → `core` + `bili`；`apps/desktop/src-tauri` → `core` + `bili`。**`core` 不得依赖 `bili`，也不得依赖 `tauri`。**

安全红线（规范性，本节必须复述）：`SESSDATA`、`bili_jct`、`DedeUserID` **不得**出现在日志、前端明文、仓库、崩溃上报中；文档与脚本中的示例一律使用占位值。

## ADR 模板

新增决策时复制以下骨架，文件名 `NNNN-kebab-case-标题.md`，编号取索引表下一个未占用值。

````markdown
# ADR NNNN：决策标题（一句话陈述选择了什么）

> 定位：一句话说明本记录覆盖的决策范围。
> 读者：谁需要读这篇。
> 更新时机：什么变化会让这篇需要修订或推翻。

| 项 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | YYYY-MM-DD |
| 决策者 | 项目作者 |
| 影响面 | 受影响的 crate / 文档 / 平台 |
| 相关文档 | 相对路径链接 |

## Context

当时的约束、需求边界、已排除的选项、以及触发本次决策的外部事实。
只写可验证的事实，不写未实测的 B 站行为数值；未实测项收敛到「待实测校准」表。

## Decision

选择的具体做法。涉及常量、字段、接口时用表格给出确切取值，并与规范性契约保持一致。

## Consequences

### 正面

### 负面

### 风险

## Alternatives considered

至少两条被否决的选项，逐条写明否决理由与重新启用的条件。
````

写完新 ADR 后必须做三件事：把新行加入上面的索引表；在相关文档中用相对路径互相链接；确认未与 [`../contract.md`](../contract.md) 的规范取值冲突。
