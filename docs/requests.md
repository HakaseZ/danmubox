# 需求与 issue 归档（Requests & Issues Archive）

> **用途**：把「人与 agent 沟通过程中提出的需求」与仓库根 `issue` 的 20 条待办合成一份**可检索、可追溯**的台账：每条都有出处、有当前状态、有落点，供任何人回答「这件事到底做没做、凭什么说做了、没做的卡在哪」。
> **与其他文档的分工**：`REQUIREMENTS.md` 是项目作者手写的**需求基线**（做什么、不做什么）；[`docs/contract.md`](contract.md) 是**规范性契约**（怎么落地）；[`CHANGELOG.md`](../CHANGELOG.md) 是**已发生的变更流水**；[`docs/roadmap.md`](roadmap.md) 是**排期与待办**；本文只做**归档与追溯**，不重复上述任何一处的正文，只做交叉引用。
> **读者**：项目作者、参与实现的 AI 编码 agent、以及任何来核对「这条需求现在什么状态」的人。
>
> **维护方式（新增 / 变更 / 完成时怎么改本文）**
> 1. **新需求**：追加到 §1（产品需求）或 §2（工程与过程规矩）对应表格**末尾一行**；若它同时是 `issue` 里的条目，**不要另写一段**，只在 §3 该条上补一句互相引用。
> 2. **状态变化**：只改该行的「状态」列，并**立即补上「证据或落点」**（`文件:行号` / 提交 sha / 文档章节）。
> 3. **状态取值**：`已做` / `部分` / `未做` / `不做（原因）` / `等外部条件` / `待核`（证据不足，**不许猜**）。
> 4. **证据纪律**：未实测的事实不得写成已实测；只按文档或官方实现核对得到的，必须在证据栏写明「按文档核对，未实测」（出处：`AGENT.md` §8 第 7 条、`docs/testing.md` §3.3）。
> 5. **脱敏纪律**：本文**不得写入任何真实房间号**（唯二例外：公开测试房间 `1` / `room_id 5440`，见 `AGENT.md` §8 第 14 条与 `docs/contract.md` §4），也不得写入任何 uid / 昵称。
> 6. **只读**：仓库根 `issue` 由项目作者维护，本文只引用其编号，不复制、不修改。

---

## 1. 产品需求

> 来源缩写：`issue` = 仓库根 `issue` 文件（20 条，只读）；`CHANGELOG` = [`CHANGELOG.md`](../CHANGELOG.md)；`ui.md` = [`docs/ui.md`](ui.md)；`contract` = [`docs/contract.md`](contract.md)；`roadmap` = [`docs/roadmap.md`](roadmap.md)。

| # | 原话或要点 | 来源 | 状态 | 证据或落点 |
|---|---|---|---|---|
| P1 | 已登录用户没法切换，只能重登；凭证在后台，应能直接切换身份 | `issue` #1；`CHANGELOG`「账号管理重写：一行身份 + 账号管理对话框」 | 已做 | `ui.md` §2.2.1；提交 `ff16e55`（契约）、`87a1d00`（core/bili/cli）、`5d6c041`（界面）；`CHANGELOG` Added「账号管理重写」 |
| P2 | 加载后关注的直播要手动刷新，应自动出来（除非网络故障或没关注人） | `issue` #2；`CHANGELOG` Added「关注列表在会话就绪后自动拉取」 | 已做 | `REQUIREMENTS.md` §2.6；启动 / 登录态就绪 / 换号 / 扫码确认四条路径都自动拉；`contract` §7 `follow_list` |
| P3 | 房管功能没有界面？加黑名单、拦截词（屏蔽词） | `issue` #3；`CHANGELOG` Added「房管界面」「房管能力」 | 已做（写操作未实测） | `ui.md` §4.9；行右键菜单 + 房管面板（三块列表）；端口 `RoomAdmin`、IPC `admin_*`（`contract` §3/§7）；**屏蔽词增删已实测通过**，禁言 / 拉黑**未实测**（`docs/protocol.md` 附录 A36） |
| P4 | 历史 10 条前混入本地本人发言，仅保留历史记录 | `issue` #4；`CHANGELOG` Fixed（进场回填只取 `data.room`） | 已做 | `crates/danmubox-bili/src/history.rs`（只取 `data.room`，注释点名 `data.admin` 是根因）；`contract` §4.3；`docs/protocol.md` A30 |
| P5 | 历史与实时割裂，显示效果要一致，不提示「以上为历史记录」 | `issue` #5；`CHANGELOG` Fixed「历史与实时不再割裂」 | 已做 | `ui.md` §4.7（去掉 0.55 弱化与分界提示） |
| P6 | 参照官方优化粉丝牌 / 身份标识显示，加发言头像，加时间戳显示开关 | `issue` #6；`CHANGELOG` Added「发言用户头像」「时间戳显示开关」「粉丝牌用上游真彩色」 | 已做 | `ui.md` §4.1/§4.2；`Message.face`（`contract` §5）；偏好键 `ui.show_timestamp`（`contract` §8）；**曾因后端白名单缺键而失效**，由提交 `009d9e0` 修复（`prefs.rs` 补 SPECS、`docs/ipc.md` 同步） |
| P7 | 人气值没用（官方也没实现），改成房间观众数量 | `issue` #7；`CHANGELOG` Added「房间观众数（在线人数 + 累计看过）」 | 已做 | `REQUIREMENTS.md` §2.1；`Event::RoomStats` + 事件 `danmubox://room_stats`（`contract` §5/§7）；`docs/protocol.md` §10.7 |
| P8 | 参照 web 直播栏优化布局：筛选收进展开菜单；短语增删逻辑修正；更多动作收进右键；时间对齐；非通用表情放大；主站表情要能选；字号联动表情尺寸；面板展开不挡最新弹幕 | `issue` #8（8 个子项）；`CHANGELOG` Changed「房间页按一条纵向生长轴重排」等 | 已做（1 项为有意删除） | 筛选面板 `ui.md` §8.5；右键菜单 §4.5；短语右键增删改 §6.2；时间戳列对齐 §4.1；表情尺寸分级 §6.3；`emotes_owned` 接进面板；「最近发言」面板**整条链路删除**（`CHANGELOG`「删掉『最近发言』面板及其整条链路」，属有意） |
| P9 | 透明度功能非预期实现，先删了，放待办 | `issue` #9；`CHANGELOG` Removed「透明度功能（`ui.opacity`）」 | 已做（重做待办已登记） | `roadmap` §8.3（重做前先明确它作用在什么上）；`contract` §8 已无该键 |
| P10 | 互动（进场）消息加自动消失开关，只有常开才一直显示；系统通知默认关闭 | `issue` #10；`CHANGELOG` Added「两个消息显示开关」 | 已做 | 偏好键 `ui.interact_auto_hide`（默认 true）/ `ui.system_notice`（默认 false），`contract` §8；`ui.md` §4.8 |
| P11 | 关注的未开播也展示，按最后开播时间排序，分页 | `issue` #11；`CHANGELOG` Added「关注列表展示未开播房间、按最后开播时间排序、分页」 | 已做 | `contract` §5 新增 `live_start_at` / `online`；每页 30 条；`docs/protocol.md` A28 |
| P12 | 舰长标与本房间舰长不一致；其他房间的舰长也有舰长标 | `issue` #12；`CHANGELOG` Added「舰长标只看『本房间』的舰长身份」 | 已做 | `Message.guard_level` 取 `info[7]`；粉丝牌自身标记另开 `medal_guard_level`（`contract` §5）；`docs/protocol.md` A39 |
| P13 | @ 之后删掉文本里的 `@xxx` 再发送仍会 @；弹幕里看不到 @ 关系 | `issue` #13；`CHANGELOG` Fixed「@ 目标与文本框不再脱钩」、Added「弹幕里的『回复了谁』可见」 | 部分 | @ 目标从草稿派生（已做）；回复关系可见（`db-msg-reply`，已做）；**「纯 @」与「回复」在收包侧不可区分**（`docs/protocol.md` §11.6 / A40 未闭），界面统一渲染 `@昵称` |
| P14 | 主界面竖屏：第一排左 头像 + 主播名 / 右 直播状态；第二排左 直播标题 / 右 最后开播时间；不要房间号 | `issue` #14；`CHANGELOG` Changed「主界面房间列表与关注列表重排」；提交 `f8444ad` | 已做 | 一套 DOM + 两种 grid 模板，断点 520px，窄屏验证视口 360（窗口最小宽度）；`ui.md` §2.2 / §9.1 |
| P15 | 主界面宽屏：一排；左 头像·主播名·直播标题 / 右 直播状态·最后开播时间；不要房间号 | `issue` #15；`CHANGELOG` 同上；提交 `f8444ad` | 已做 | 宽屏 > 520px 一排；两处均不含房间号（冒烟 `followItemHidesRoomNumber` / `roomCardHidesRoomNumber` / `tabHidesRoomNumbers`） |
| P16 | 所有关注都要展示；直播中置顶；按最近观看降序 | `issue` #16；`CHANGELOG` Changed「#16 排序」 | 已做 | 排序链完整为「直播中置顶 → **最近观看降序**（新增偏好键 `ui.recent_watched`）→ 最后开播时间降序 → 人气 → 房间号」，`contract` §8 / `ui.md` §2.2 |
| P17 | 连接中的房间列表不展示房间号，仅展示「主播 · 直播间名」 | `issue` #17；`CHANGELOG` Changed「#17 连接的房间列表」；Fixed（真正的主播名） | 已做 | 先取错接口（`getRoomPlayInfo` 里根本没有 `anchor_info`/`title`）→ 改从 `getH5InfoByRoom` 取（`Room.anchor_uname`，`contract` §5）；回落口径 主播名 → 标题 → 「房间 <号>」，占位词已删；`ui.md` §2.2；`docs/protocol.md` A41；提交 `2e95a22` |
| P18 | 房间 tab 不展示房间号，展示主播名 | `issue` #18；`CHANGELOG` Changed「#18 房间标签条」；提交 `2e95a22` | 已做 | 标签名取主播名（取不到退回标题）；`App.tsx` tab 渲染；`ui.md` §2.3 |
| P19 | 短语删除颜文字部分 | `issue` #19；`CHANGELOG` Removed「短语面板删掉内置颜文字」 | 已做 | 删 `Composer.tsx` 的 `KAOMOJI` 常量与该行渲染；`ui.md` §6.2 同步；提交 `d6ba109`（worktree 内 `9db6e35`） |
| P20 | 表情界面仿官方：用 tab 不要用按钮；通用表情全部超出边框很丑 | `issue` #20；`CHANGELOG` Changed「表情面板重做：竖向 tab 轨道 + 表情完整落在格子里」 | 已做 | 左侧竖向 tab 轨道（`role=tablist` + roving tabindex + 方向键）；`<img>` 宽高由 CSS 显式给出 + `object-fit: contain`（溢出 24.9px → 0）；夹具由真实载荷 `smoke/fixtures/emotes.json` 派生；`ui.md` §6.3；提交 `f19de72`（worktree 内 `0375f44`） |
| P21 | 关注列表要能看到直播间标题；房间卡片标题要加悬停提示（免得被当成 bug） | 子代理票 `FollowTitle`（分支 `feat/ui-follow-title`）；`CHANGELOG` Added「关注列表带出直播间标题」 | 已做 | 先只读取证：`GetWebList` 条目里本来就有 `title`（同条目 `roomname` 是房间默认名），直接转发不另调接口；`FollowedRoom.title`（`contract` §5）；空串不渲染；房间卡片标题行加 `title="直播间标题（上游）"` |
| P22 | 用户名与正文都不吃上游自定义弹幕颜色（浅色主题下白字人名等于隐形、正文偏黄）；用户明确「不需要再改动」 | `CHANGELOG` Changed「弹幕自定义颜色整体不再消费」；提交 `4b33e87` | 已做 | 界面一处都不读 `Message.color`（`filtering.ts` 的 `cssColor` 删除），正文与昵称都用主题 token；被 @ 的名字仍按上游 `reply_uname_color` 上色；`ui.md` §4.1/§4.3 |
| P23 | 点选表情直接发送（去掉二次确认）；去掉表情面板搜索框；网格区高度 = 两行大表情，超出滚动 | 子代理票 `RowEmoteFix`（用户原话）；`CHANGELOG` 尚未有条目 | 未做（进行中） | 当前 main：`Composer.tsx:392-395` 仍是「搜索表情」输入框，`ui.md` §6.3「搜索」行仍在；三项改动在 `RowEmoteFix` 票（分支 `fix/row-emote-render`，worktree `danmubox-wt-rowemote`），**未合入 main** |
| P24 | 表情包弹幕渲染不能撑破行；正文要能在身份簇下方换行 | 子代理票 `RowEmoteFix`（用户原话）；`CHANGELOG` 尚未有条目 | 未做（进行中） | 同上，随 `RowEmoteFix` 落地；先取证 `/tmp/standalone.log` 两条真实弹幕记录 → 夹具（脱敏、不得含真实房间号）→ 断言「行内图尺寸 ≤ 行可用宽度、正文可换行、无横向溢出」 |
| P25 | 竖屏为默认形态：窗口默认 390×844，最小 360×480 | 用户原话；`CHANGELOG`「竖屏是默认形态」；提交 `ddf888b`；`docs/ui.md` §9.1 | 已做 | `apps/desktop/src-tauri/tauri.conf.json`：`width 390 / height 844 / minWidth 360 / minHeight 480`（窗口最小宽度由 720 放宽到 360 的提交为 `7a3d382`）；冒烟窄屏视口取 360 |
| P26 | 整体设计风格模仿 WhatsApp：**全应用一次换完**，深浅两套配色并**跟随系统**；只取设计语言（色板/圆角/间距/字体层级/顶栏与输入栏形态），**不照搬气泡结构**（弹幕是多人流水） | 用户 2026-09-12 对话（选「全应用一次换」+「深浅两套跟随系统」；无截图，按设计规则做） | 已做 | 令牌层补齐两套语义槽（`app.module.css` 的 `:root` / `:root[data-theme="light"]`，逐条标来源与对比度）、`index.css` 元素默认改胶囊 + `accent-color`；主题开关在筛选面板「显示」块（`db-pref-theme`，写回 `ui.theme`），并补系统外观变化的实时订阅与首帧前预设；「自己发的」用行级标记 `.rowOwn`（`MessageRow` 的 `myUid` 经 `MessageList` 透传）；**不照搬**气泡尾巴 / 已读回执 / 未读徽章布局，理由逐条写在 `docs/ui.md` §8.3。冒烟新增主题维度：`SMOKE_THEMES=dark,light` × 2 视口 × 2 引擎（Chromium / WebKit）**全部退出码 0**，每引擎 1330 项快照 / 40 张截图（两引擎共 80 张；原基线 629 项 / 20 张，新增断言 18 条 × 2 视口 × 2 主题）；两档实测对比度：深色正文 15.79:1 / 次级 6.10:1，浅色正文 14.58:1 / 次级 5.06:1。落点：`docs/ui.md` §8.3 / §9.2 / §15、`CHANGELOG` Unreleased Added；分支 `feat/whatsapp-restyle`，提交 `6b2b8f2` |

**产品需求小计：26 条**（已做 22 / 部分 1 / 未做 3）。

---

## 2. 工程与过程规矩

> 这些是「怎么做」的约束，多数已固化进 `AGENT.md` / `docs/ui.md` / `docs/testing.md`；未固化的在状态栏标明。

| # | 原话或要点 | 来源 | 状态 | 证据或落点 |
|---|---|---|---|---|
| E1 | 「不要乱操作」：清单外的动作（动账号、删 profile、重启应用、改配置）先问 | 对话内规矩（用户原话） | 待核（未固化成条文） | 最接近的固化条文是 `AGENT.md` §8 第 15/16 条（写操作只允许发生在公开测试房间 1 / 当次明确指定的房间；有价值内容一律不发）；对话中还有一次「先回答我的问题，待我确认后再修改」（`history://Main`）。**建议后续把「清单外动作先问」写进 `AGENT.md` §8** |
| E2 | 界面大活拆批交付，每票带时限 | 子代理票据体例（`history://MainListLayout`、`history://Kaomoji`、`history://RealAnchorName`、`history://EmotePanelOfficial`、`history://FollowTitle`、`history://WebKitVerify`、`history://RowEmoteFix` 的作业说明） | 已做（体例在跑） | 每张票都有 `# Target / # Change / # Acceptance`，并明写「时限 20 分钟」；共享文件的归属在派单时预先划清（`history://Kaomoji` / `history://MainListLayout` 收到的 `Main` IRC） |
| E3 | 重建攒批做，不为单个修复反复重启用户正在看的窗口 | 对话内规矩（用户原话） | 待核 | 未找到固化条文；可佐证的相关规矩是 `docs/ui.md` §15「同一台机上冒烟必须串行：一次只让一个浏览器跑」与「退出必收自己的浏览器」（避免打扰用户环境）。**建议后续写进 `AGENT.md` §9 或 `docs/operations.md`** |
| E4 | 可达面判据：① 视口边界（窗口最小 360）；② **渲染引擎**——Chromium 全绿说明不了 WKWebView | `AGENT.md` §9 DoD；`docs/ui.md` §15 | 已做 | `AGENT.md` §9 两条 bullet（「改动按视口 / 设备分叉 … 覆盖到可达面的边界值」，2026-09-12 教训：`minWidth` 曾钉死 720）；`docs/ui.md` §15「判据：视口是产品的可达面」（那一段即窗口 360 的来历）与「判据：渲染引擎同样是可达面」（`--engine webkit`） |
| E5 | 宿主引擎必须进验证链：冒烟两个引擎跑同一份场景、同一套断言 | `AGENT.md` §9；`docs/ui.md` §15；`CHANGELOG` Added「冒烟接上宿主的渲染引擎（WebKit）」 | 已做 | `node smoke/run-headless.mjs --engine webkit`（`apps/desktop/ui/smoke/run-headless.mjs`）；另有零构建差异的旁证链路 `apps/desktop/ui/smoke/wkwebview-host.swift`（系统 WKWebView，用法见 `docs/ui.md` §15） |
| E6 | 冒烟纪律：同一台机**串行**（并发会把 WebKit 渲染进程挤死并伪装成「某段必崩」）；退出必清理自启浏览器；**跑前先 `npm run build`**（否则拿到旧产物误报失败） | `docs/ui.md` §15；子代理票据（`history://WebKitVerify` / `history://FollowTitle` / `history://Kaomoji`） | 已做 | `docs/ui.md` §15 的「运行器自己不添乱」段（每步超时、退出必收自己的浏览器）与「同一台机上冒烟必须串行」段（崩溃重试 + 记账，重试上限 1 次且断言重跑）；`run-headless.mjs` 的启动前清理与 finally cleanup 由提交 `1de4c12` / `8837433` 落地 |
| E7 | **先抓真实载荷当夹具**再改代码；禁止手写 JSON 当夹具（「今天四次翻车的同一病根」：512 头像 / `ui.show_timestamp` / 未命名直播间 / 表情溢出） | `docs/ui.md` §6.3「取证口径」段、§15「夹具要能失败」段；`CHANGELOG` 多条；子代理票 `RealAnchorName` / `EmotePanelOfficial` / `FollowTitle` | 已做 | 仓库夹具：`apps/desktop/ui/smoke/fixtures/emotes.json`、`room-play-info.json`、`room-h5-info.json`（只读 GET 固化、脱敏不改结构）；`crates/danmubox-bili/src/http.rs` 的单测改为读夹具 |
| E8 | 测试边界：写操作只允许在公开测试房间 1（`room_id` 5440）或当次明确指定的房间，**一经指定不得更换**；失败即停不重试；真实私用房间号**不得写入任何文档、代码或提交信息** | `AGENT.md` §8 第 14/15/16 条；`contract` §4；`CHANGELOG` Calibration 段 | 已做 | `AGENT.md` §8 三条 + §9 DoD；`docs/testing.md` §8.3 脱敏要求与提交前检索复核 |
| E9 | 虚报禁令：未实测的事实必须标注「按文档核对，未实测」，与实测区分开 | `AGENT.md` §8 第 7 条；`docs/testing.md` §3.3；`CHANGELOG` 多处 | 已做 | 例：房管写操作按 A36「决定不验证」处理，实现只做参数拼装与原样透传；`docs/protocol.md` 附录 A 以「待实测校准」表承载 |
| E10 | 派单时划清共享文件归属（曾因 `smoke/room-page.mjs` 两边同时改而撞车） | `history://Kaomoji` / `history://MainListLayout` / `history://RealAnchorName` / `history://EmotePanelOfficial` 收到的 `Main` IRC；`history://WebKitVerify` 的冲突善后 | 已做 | IRC 明文划出「A 票负责 `ui.md` §6.2 / §4.1、CHANGELOG #19；B 票负责 §2.2、`contract.md`、`ipc.md`、CHANGELOG #14–#18、`smoke/fixtures/` 房间 json；C 票负责 §6.3 与表情 json」，并定「真冲突时小票让步」 |

**工程规矩小计：9 条**（已做 7 / 待核 2）。

---

## 3. `issue` 20 条对照

> 核对基线：`IssueAudit` 的逐条审计（2026-09-12，只读），**再按其后合入的整改更新**（列表重排 `f8444ad` / 主播名 `2e95a22` / 颜文字 `d6ba109` / 时间戳白名单 `009d9e0` / 表情面板 `f19de72`）。原文件见仓库根 `issue`（只读，未改）。

| 编号 | 状态 | 证据 | 备注 / 落点 |
|---|---|---|---|
| 1 账号切换 | 已做 | 账号管理对话框 + 一行身份；提交 `ff16e55` / `87a1d00` / `5d6c041` | 见 P1 |
| 2 关注自动加载 | 已做 | 启动 / 登录态就绪 / 换号 / 扫码确认四条路径都自动拉；`CHANGELOG` Added | 拉起顺序是「先拿登录态，再拉关注」，不是先拉关注 |
| 3 房管功能 | 已做 | `ui.md` §4.9；IPC `admin_*`（`contract` §7） | 屏蔽词增删**已实测通过**；禁言 / 拉黑**未实测**（上游 `100004 参数错误`，按纪律未换参重试）；A36 定「写操作不验证」 |
| 4 历史混入本人发言 | 已做 | `crates/danmubox-bili/src/history.rs` 只取 `data.room` | 病因是 `data.admin`（房管切片）被拼在前面 |
| 5 历史与实时一致 | 已做 | `ui.md` §4.7 | 去掉历史行弱化与分界文案 |
| 6 粉丝牌 / 身份 / 头像 / 时间戳开关 | 已做 | `ui.md` §4.1/§4.2；偏好键 `ui.show_timestamp`（`contract` §8） | 审计时曾发现**后端白名单漏键**导致开关存不下去，已由 `009d9e0` 修复（并把测试从「数个数」改成「读契约表逐键比对」） |
| 7 人气值 → 房间观众数 | 已做 | `Event::RoomStats` + `danmubox://room_stats`（`contract` §5/§7） | 在线人数 + 累计看过两个都显示 |
| 8 界面布局 8 项 | 已做（1 项有意删除） | `ui.md` §8.5 / §4.5 / §6.2 / §6.3 | 「最近发言」面板**整条链路删除**（与右键菜单重复），不是欠账 |
| 9 透明度先删 | 已做 | `CHANGELOG` Removed；`roadmap` §8.3 | 重做待办已登记 |
| 10 互动自动消失 / 系统通知默认关 | 已做 | 偏好键 `ui.interact_auto_hide` / `ui.system_notice`（`contract` §8）；`ui.md` §4.8 | 默认值 true / false |
| 11 未开播也展示 + 排序 + 分页 | 已做 | `contract` §5 `live_start_at` / `online`；`docs/protocol.md` A28 | 每页 30 条 |
| 12 舰长标只看本房间 | 已做 | `Message.guard_level` 取 `info[7]`；`docs/protocol.md` A39 | 粉丝牌自身标记另开 `medal_guard_level` |
| 13 @ 脱钩 / 弹幕里看不到 @ | 部分 | @ 目标从草稿派生（已做）；回复关系可见（`db-msg-reply`，已做） | 「纯 @」与「回复」在**收包侧不可区分**，`docs/protocol.md` §11.6 / A40 未闭；界面统一渲染 `@昵称` |
| 14 窄屏两排 + 不露房间号 | 已做 | 提交 `f8444ad`；`ui.md` §2.2 / §9.1 | 断点 520px，360 可达 |
| 15 宽屏一排 + 不露房间号 | 已做 | 提交 `f8444ad` | 同上 |
| 16 全量展示 + 置顶 + 最近观看降序 | 已做 | 新偏好键 `ui.recent_watched`（`contract` §8） | 审计时「最近观看」这一维不存在，已新增 |
| 17 房间列表不露房间号 + 主播·直播间名 | 已做 | `Room.anchor_uname`（`contract` §5）；`docs/protocol.md` A41；提交 `2e95a22` | 审计时未做，且需先补 `anchor_uname` 字段（动契约 + 后端） |
| 18 tab 显主播名 | 已做 | 提交 `2e95a22`；`ui.md` §2.3 | 同上（依赖 `anchor_uname`） |
| 19 短语删颜文字 | 已做 | 提交 `d6ba109`（worktree 内 `9db6e35`）；`CHANGELOG` Removed | 审计时未做 |
| 20 表情 tab + 不溢出 | 已做 | 提交 `f19de72`（worktree 内 `0375f44`）；`ui.md` §6.3 | 溢出 24.9px → 0；另有三条 UX 补充（点选即发 / 去搜索框 / 两行高度）在 `RowEmoteFix` 票进行中，见 P23 |

**issue 小计：20 条**（已做 19 / 部分 1 / 未做 0）。

---

## 4. 状态总览

| 部分 | 条数 | 已做 | 部分 | 未做（进行中） | 不做 / 待核 |
|---|---|---|---|---|---|
| §1 产品需求 | 26 | 22 | 1 | 3 | 0 |
| §2 工程与过程规矩 | 9 | 7 | 0 | 0 | 2（待核） |
| §3 `issue` 20 条 | 20 | 19 | 1 | 0 | 0 |
| **合计** | **55** | **48** | **2** | **3** | **2** |

> 待核两项（E1「清单外动作先问」、E3「重建攒批做」）是对话内规矩但尚未固化成仓库条文；证据栏给了最接近的已有条文与出处，并各留了一条落地建议。
