# Changelog

本文件记录 danmubox（弹幕框）的所有显著变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
日期统一为 `YYYY-MM-DD`。

> 定位：项目的对外可见变更流水，按版本倒序排列。
> 读者：项目作者本人，以及被指派参与本仓库的 AI agent。
> 更新时机：任何对外可见的行为、契约、文档基线或发布策略发生变化时；随改动同一次提交写入 `Unreleased`。

## 版本策略（自用不发布）

| 项 | 约定 |
|---|---|
| 发布形式 | 自用构建，不发布到 App Store / 应用市场 / 任何包仓库 |
| 版本号 | 仍按 SemVer 递增，用于标记自己的构建与排查问题 |
| `0.x.y` 期间 | IPC、端口、领域模型与本地文件契约均可破坏性变更，破坏性变更在 `Changed` 段明确标注 |
| `1.0.0` 触发条件 | 三端主流程稳定，端口与 IPC 契约冻结 |
| Pre-release | 需要区分试构建时用 `-alpha.N` / `-beta.N` 后缀 |
| Git tag | 版本号前加 `v`，例如 `v0.1.0`；不打 tag 的构建视为开发快照 |
| 变更记录粒度 | 用户可观察的行为与契约变化；纯内部重命名不单独成条 |
| 与文档的关系 | 契约文档（`docs/`）的基线变化必须在此留下条目 |

## [Unreleased]

### Added

- 确立需求基线 [`REQUIREMENTS.md`](REQUIREMENTS.md)（用户手写），并产出规范性契约 [`docs/contract.md`](docs/contract.md)
  （唯一事实源）：命名、共享常量、领域模型、端口边界、IPC 与本地文件契约、偏好键、写作要求。
- 产出并按新基线重写派生文档集：`docs/protocol.md`、`docs/auth.md`、`docs/architecture.md`、
  `docs/ipc.md`、`docs/ui.md`、`docs/testing.md`、`docs/distribution.md`、`docs/operations.md`、
  `docs/roadmap.md`，以及 ADR 集 `docs/decisions/`（0001–0008，含索引与模板）。
- 明确本期范围：macOS / Windows / Android 三端；iOS 与 Fold8 / 折叠屏适配列为后期 enhancement。
- 新增能力面：表情包库（按身份加载）、举报弹幕、关注列表（直播中置顶）、电池余额、
  礼物栏双模式（`ui.gift_panel_mode`）、身份徽标（主播 / 房管 / 总督 / 提督 / 舰长）、
  房间内「刷新」触发的手动重连。
- 新增连接要求：`protover=3`（brotli）协商，解码兼容 `0` / `1` / `2` / `3`；
  每 60 秒一次的 HTTP 心跳；单包解压上限 16 MiB；重连退避 5 / 10 / 20 / 40 / 60 秒封顶。

### Changed

- 需求来源变更：基线由选型讨论原文改为 [`REQUIREMENTS.md`](REQUIREMENTS.md)；`docs/selection.md` 仅作选型背景，
  其中的数据库设计、HTTP API、SSE 与 MCP 章节本期均未采纳。
- 撤销本地数据库与落库：不建库、不落盘，无去重键、无迁移、无索引、无保留策略；
  弹幕改为**单次房内会话的内存环形缓冲**（上限 5000 条），离开房间即销毁，重进是新会话。
- 撤销本地 HTTP API、SSE 与 MCP 实现，不再引入本地监听端口与进程级访问令牌。
- 撤销弹幕回看与导出（CSV / JSON / Markdown）。
- 凭据存储由系统密钥环改为**明文 `config.toml`**（权限 0600，可直接手工编辑，
  「手填 Cookie」即编辑该文件）；界面偏好独立存 `prefs.json`，两类数据不混放。
- 领域模型调整：`kind` 保持六种取值；举报所需的 `upstream_id` 进入消息模型；
  主播徽标由 `Room.anchor_uid` 派生，不再单独存字段。
- `INTERACT_WORD_V2` 载荷按 protobuf 处理（`danmubox-bili` 侧用 `prost` 解码）；
  `DANMU_MSG_MIRROR` 默认丢弃并计数。
- bundle id 由 `dev.zack.danmubox` 改为 `dev.kksk.danmubox`。

### Removed

- 删除数据库中台与本地 HTTP API 两份专项文档（对应章节本期未采纳），
  其适用契约并入 `docs/contract.md` 与架构文档；全部指向它们的链接已改指契约文档。
- 删除本地 HTTP 服务的决策记录（不再提供 API 实现）。
- 否决 Tauri + Python/Node sidecar 折中方案：会推高包体并引入额外的跨进程生命周期管理。
- 排除纯静态 PWA 方案：B 站 REST 接口受 CORS 限制，登录、签名与发弹幕都需要本地引擎。

## [0.1.0] - 2026-09-11

初始版本。本版本**仅包含文档基线**，不含任何源码、构建配置或可运行产物：
`crates/` 与 `apps/` 尚未创建，仓库内不存在 `.rs` / `.ts` / `.tsx` / `.toml` / `.json` 文件。

### Added

- 项目立项：B 站直播间弹幕客户端，自用不发布。
- 文档基线与规范性契约（内容同 `Unreleased` 段所列各项）。

### Notes

- 本版本不可构建、不可运行；所有构建命令与产物路径均为规划值。
- 文档集已按需求基线 [`REQUIREMENTS.md`](REQUIREMENTS.md) 校正；被撤销的方案与变更见 `Unreleased` 段。
- 对 B 站未实测的协议字段统一以「待实测校准」表格承载，标注核对方法，不编造数值。
