# 需求与 issue 归档（Requests & Issues Archive）

> **用途**：把「人与 agent 沟通过程中提出的需求」与仓库根 `issue` 的 20 条待办合成一份**可检索、可追溯**的台账：每条都有出处、有当前状态、有落点，供任何人回答「这件事到底做没做、凭什么说做了、没做的卡在哪」。
> **与其他文档的分工**：`REQUIREMENTS.md` 是项目作者手写的**需求基线**（做什么、不做什么）；[`docs/contract.md`](contract.md) 是**规范性契约**（怎么落地）；[`CHANGELOG.md`](../CHANGELOG.md) 是**已发生的变更流水**；[`docs/roadmap.md`](roadmap.md) 是**排期与待办**；本文只做**归档与追溯**，不重复上述任何一处的正文，只做交叉引用。
> **读者**：项目作者、参与实现的 AI 编码 agent、以及任何来核对「这条需求现在什么状态」的人。
>
> **维护方式（新增 / 变更 / 完成时怎么改本文）**
> 1. **新需求**：追加到 §1（产品需求）或 §2（工程与过程规矩）对应表格**末尾一行**；若它同时是 `issue` 里的条目，**不要另写一段**，只在 §3 该条上补一句互相引用。
> 2. **状态变化**：只改该行的「状态」列，并**立即补上「证据或落点」**（`文件:行号` / 提交 sha / 文档章节）。**同一次改动里重算**该节小计与 §4 表 —— 三处计数必须自洽（提交 `1014b02` 就是为修「三行小计与 §4 表不一致」单独补的一票，别再让它发生）。
> 3. **状态取值**：`已做` / `部分` / `未做` / `不做（原因）` / `等外部条件` / `待核`（证据不足，**不许猜**）。限定语只许可两种且必须写明：`已做（待用户复测）`（冒烟 / 实机验过，用户尚未复看）、「按文档核对，未实测」。
> 4. **证据纪律**：未实测的事实不得写成已实测；只按文档或官方实现核对得到的，必须在证据栏写明「按文档核对，未实测」（出处：`AGENT.md` §8 第 7 条、`docs/testing.md` §3.3）。
> 5. **脱敏纪律**：本文**不得写入任何真实房间号**（唯二例外：公开测试房间 `1` / `room_id 5440`，见 `AGENT.md` §8 第 14 条与 `docs/contract.md` §4），也不得写入任何 uid / 昵称。
> 6. **只读**：仓库根 `issue` 由项目作者维护，本文只引用其编号，不复制、不修改。
> 7. **「进行中」的票落地时必须回改**：某条需求写着「未做（进行中：…）」而它的票已合入 main 时，把该行改成「已做」并在证据栏补上**票的提交 sha**（本轮 `P23` / `P24` 就是「落地了但台账还写着进行中」的实例，见 §1 两行）；反向也成立 —— 票只在 worktree / 分支里、**未合入 main** 时，状态写「未做（进行中）」，证据栏必须写出分支与 worktree 名。

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
| P11 | 关注的未开播也展示，按最后开播时间排序，分页 | `issue` #11；`CHANGELOG` Added「关注列表展示未开播房间、按最后开播时间排序、分页」 | **部分**（2026-09-13 之前：**未开播的一个都没展示到**；现已修） | **事实**：直播侧 `GetWebList` **只返回在播房间**（实测关注 90 人 / 在播 0 人 → `list=[]` + `not_living_num=90`），此前 `followed()` 只吃这一个端点，因此主界面永远看不到未开播的关注——用户 2026-09-13 报的正是这条（台账原记「已做」是**被手造夹具骗了**：冒烟当时用「离线甲 / 离线乙」手写条目）。**现已补齐**：主站关注关系 + 直播批量房间接口两步取全量（实机 0 → 70 条，另一账号 0 → 4 条，全部未开播）；冒烟换成真实派生夹具并断言未开播项第 1 页可见、翻页到底一条不少。**仍未闭环**：未开播条目的「最后开播时间」上游两个端点都不给（`live_time` 未开播时为 0），这一档排序落回 `online` / 房间号。取证：提交 `4f9e2a7`；`docs/protocol.md` A28 修正；`docs/contract.md` §5；`docs/ui.md` §2.2/§15；`CHANGELOG` Fixed（2026-09-13） |
| P12 | 舰长标与本房间舰长不一致；其他房间的舰长也有舰长标 | `issue` #12；`CHANGELOG` Added「舰长标只看『本房间』的舰长身份」 | 已做 | `Message.guard_level` 取 `info[7]`；粉丝牌自身标记另开 `medal_guard_level`（`contract` §5）；`docs/protocol.md` A39 |
| P13 | @ 之后删掉文本里的 `@xxx` 再发送仍会 @；弹幕里看不到 @ 关系 | `issue` #13；`CHANGELOG` Fixed「@ 目标与文本框不再脱钩」、Added「弹幕里的『回复了谁』可见」 | 部分 | @ 目标从草稿派生（已做）；**身份牌后那枚回复标记 2026-09-13 已删除**（用户：与正文里的 @ 重复），改为**正文内 `@昵称` 就地高亮**（见 P37①）——因此「回复关系可见」不再是独立标记这一路，只有正文自带 @ 时才可见；**「纯 @」与「回复」在收包侧不可区分**（`docs/protocol.md` §11.6 / A40 未闭） |
| P14 | 主界面竖屏：第一排左 头像 + 主播名 / 右 直播状态；第二排左 直播标题 / 右 最后开播时间；不要房间号 | `issue` #14；`CHANGELOG` Changed「主界面房间列表与关注列表重排」；提交 `f8444ad` | 已做 | 一套 DOM + 两种 grid 模板，断点 520px，窄屏验证视口 360（窗口最小宽度）；`ui.md` §2.2 / §9.1 |
| P15 | 主界面宽屏：一排；左 头像·主播名·直播标题 / 右 直播状态·最后开播时间；不要房间号 | `issue` #15；`CHANGELOG` 同上；提交 `f8444ad` | 已做 | 宽屏 > 520px 一排；两处均不含房间号（冒烟 `followItemHidesRoomNumber` / `roomCardHidesRoomNumber` / `tabHidesRoomNumbers`） |
| P16 | 所有关注都要展示；直播中置顶；按最近观看降序 | `issue` #16；`CHANGELOG` Changed「#16 排序」 | 已做（「所有关注都要展示」这一半 2026-09-13 才成立，见 P11） | **事实**：排序链完整为「直播中置顶 → **最近观看降序**（新增偏好键 `ui.recent_watched`）→ 最后开播时间降序 → 人气 → 房间号」，`contract` §8 / `ui.md` §2.2。**但直到 2026-09-13 之前，「所有关注都要展示」实际只能拿到在播的那些**（上游 `GetWebList` 只给在播房间），现已由 P11 的两步取法补齐（提交 `4f9e2a7`；实机 0 → 70 条） |
| P17 | 连接中的房间列表不展示房间号，仅展示「主播 · 直播间名」 | `issue` #17；`CHANGELOG` Changed「#17 连接的房间列表」；Fixed（真正的主播名） | 已做 | 先取错接口（`getRoomPlayInfo` 里根本没有 `anchor_info`/`title`）→ 改从 `getH5InfoByRoom` 取（`Room.anchor_uname`，`contract` §5）；回落口径 主播名 → 标题 → 「房间 <号>」，占位词已删；`ui.md` §2.2；`docs/protocol.md` A41；提交 `2e95a22` |
| P18 | 房间 tab 不展示房间号，展示主播名 | `issue` #18；`CHANGELOG` Changed「#18 房间标签条」；提交 `2e95a22` | 已做 | 标签名取主播名（取不到退回标题）；`App.tsx` tab 渲染；`ui.md` §2.3 |
| P19 | 短语删除颜文字部分 | `issue` #19；`CHANGELOG` Removed「短语面板删掉内置颜文字」 | 已做 | 删 `Composer.tsx` 的 `KAOMOJI` 常量与该行渲染；`ui.md` §6.2 同步；提交 `d6ba109`（worktree 内 `9db6e35`） |
| P20 | 表情界面仿官方：用 tab 不要用按钮；通用表情全部超出边框很丑 | `issue` #20；`CHANGELOG` Changed「表情面板重做：竖向 tab 轨道 + 表情完整落在格子里」 | 已做 | 左侧竖向 tab 轨道（`role=tablist` + roving tabindex + 方向键）；`<img>` 宽高由 CSS 显式给出 + `object-fit: contain`（溢出 24.9px → 0）；夹具由真实载荷 `smoke/fixtures/emotes.json` 派生；`ui.md` §6.3；提交 `f19de72`（worktree 内 `0375f44`） |
| P21 | 关注列表要能看到直播间标题；房间卡片标题要加悬停提示（免得被当成 bug） | 子代理票 `FollowTitle`（分支 `feat/ui-follow-title`）；`CHANGELOG` Added「关注列表带出直播间标题」 | 已做 | 先只读取证：`GetWebList` 条目里本来就有 `title`（同条目 `roomname` 是房间默认名），直接转发不另调接口（**2026-09-13 修正口径见 P11**：该端点只给在播条目；未开播条目的 `title` 来自批量房间接口的同名字段，同义）；`FollowedRoom.title`（`contract` §5）；空串不渲染；房间卡片标题行加 `title="直播间标题（上游）"` |
| P22 | 用户名与正文都不吃上游自定义弹幕颜色（浅色主题下白字人名等于隐形、正文偏黄）；用户明确「不需要再改动」 | `CHANGELOG` Changed「弹幕自定义颜色整体不再消费」；提交 `4b33e87` | 已做 | 界面一处都不读 `Message.color`（`filtering.ts` 的 `cssColor` 删除），正文与昵称都用主题 token；被 @ 的名字按上游 `reply_uname_color` 上色这一路**已于 2026-09-13 作废**（那枚 @ 标记被删，正文内 `@昵称` 的高亮取身份牌字符色 `--badge-fg`，见 P37①；`reply_uname_color` 仍留在契约 §5，界面不再消费）；`ui.md` §4.1/§4.3 |
| P23 | 点选表情直接发送（去掉二次确认）；去掉表情面板搜索框；网格区高度 = 两行大表情，超出滚动 | 子代理票 `RowEmoteFix`（用户原话）；`CHANGELOG` Changed「表情面板：点选即发送、去掉搜索框、网格区固定两行大表情」 | 已做（高度口径 2026-09-12 改为「按当前那一组的格子算两行」，见 P28） | 提交 `cc39eda`（worktree 内 `ca85d72`）：点一格**立刻**发 `chat_send`（带该表情的 `emoticon_unique`，不再插草稿、不再点发送；冒烟 `ownedEmoteSentOnClick` / `ownedEmoteNoSecondStep`）；`emoteQuery` 状态、按名字过滤那一层、`.panelSearch` 与「没有匹配的表情」空态整条删除，面板内 `input` 数为 0（`panelNoSearch`）；`--emote-grid-h` 定高 + 超出滚动（`panelEmoteGridTwoBigRows` / `panelEmoteGridScrollable`）；`ui.md` §6.3 同步 |
| P24 | 表情包弹幕渲染不能撑破行；正文要能在身份簇下方换行 | 子代理票 `RowEmoteFix`（用户原话）；`CHANGELOG` Fixed「弹幕行里的表情图不再按原图尺寸渲染」、「弹幕行改成『身份在上、正文在下』的上下两行」 | 已做（两引擎冒烟实测，待用户复测；通用横条 2026-09-13 改走宽盒，见 P37⑦） | 两段各自落地：① 行内表情宽高由 CSS 给死（见方）+ `object-fit: contain`（`rowInlineEmoteBoxSquare`：同一档里 200×60 与 162×162 必须渲染成同一个盒；改前 200×60 那条按原图比例算出 23.1px 高 / **77px** 宽）——提交 `cc39eda`（worktree 内 `ca85d72`）；② 正文改到身份簇下方、拿到整行宽度（`layoutHangIndentAligned` / `fixtureTextBodyKeepsHalfViewport` / `fixtureTextNoOverflow` / `fixtureAsciiNoOverflow`）——提交 `8195b0d`（worktree 内 `85b13d4`），详见 P32。夹具是 `/tmp/standalone.log` 的真实弹幕记录派生的 `smoke/fixtures/danmaku-rows.json`（脱敏：昵称 / 牌名 / 主播名等长掩码、uid / 哈希打码、CDN 只脱敏哈希段、`emoticon_unique` 的房间号段不入库）；`ui.md` §4.1 / §15（「弹幕行夹具」一行） |
| P25 | 竖屏为默认形态：窗口默认 390×844，最小 360×480 | 用户原话；`CHANGELOG`「竖屏是默认形态」；提交 `ddf888b`；`docs/ui.md` §9.1 | 已做 | `apps/desktop/src-tauri/tauri.conf.json`：`width 390 / height 844 / minWidth 360 / minHeight 480`（窗口最小宽度由 720 放宽到 360 的提交为 `7a3d382`）；冒烟窄屏视口取 360 |
| P26 | 整体设计风格模仿 WhatsApp：**全应用一次换完**，深浅两套配色并**跟随系统**；只取设计语言（色板/圆角/间距/字体层级/顶栏与输入栏形态），**不照搬气泡结构**（弹幕是多人流水） | 用户 2026-09-12 对话（选「全应用一次换」+「深浅两套跟随系统」；无截图，按设计规则做） | 已做 | 令牌层补齐两套语义槽（`app.module.css` 的 `:root` / `:root[data-theme="light"]`，逐条标来源与对比度）、`index.css` 元素默认改胶囊 + `accent-color`；主题开关在筛选面板「显示」块（`db-pref-theme`，写回 `ui.theme`），并补系统外观变化的实时订阅与首帧前预设；**不照搬**气泡尾巴 / 已读回执 / 未读徽章布局（用户口径，理由见 §8.3） |
| P27 | 房间页头部重构：去掉「已连接 / verified」；状态点改**三态——红 = 下播 / 绿 = 开播 / 橙 = 未连接**（用户 2026-09-13 更正口径；点本身也缩小一档，热区不缩）；返回键改**圆形左箭头**，顶栏的圆形控件只剩它与「⋯」——**电池不做圆形**（与「⋯」**不同形状**）；**电池移到输入区、发送按钮左侧**，顶栏腾出的位置给「**当前在线 / 看过**」两个数值；**直播间标题在状态点右侧、同一排，放不下就循环滚动**（**不再另起一排**）；强化视觉效果（参考图 `打开哔哩哔哩继续观看.png`，仓库根，**未入库**） | 用户 2026-09-12 对话（含参考截图）+ 2026-09-13 验收时的四条更正（①电池不做圆形且在发送按钮左侧 ②顶栏给在线/看过两个值 ③标题在状态点右侧、放不下循环滚动 ④点色红/绿/橙三态） | 已做（待用户复测） | 落点见对应组件与 `app.module.css`；深/浅两套都要成立；`docs/ui.md` §3.1 / §6.4 / §9 / §15；提交 `6b63ece`（初版：两排 + 圆形控件 + 直播状态点）→ `ed7f2c6`（2026-09-13 四条更正：标题回到状态点右侧并循环滚动、电池非圆形且移到发送按钮左侧、顶栏腾给「在线 / 看过」、状态点红/绿/橙三态并缩小一档）；`CHANGELOG` Changed 四条（房间头回到一排 / 状态点三态 / 状态点缩小一档 / 电池移出顶栏）；两引擎各 4 档冒烟退出码 0 |
| P28 | 表情面板：去掉顶部「表情」标题与「关闭」按钮；左侧 tab 轨道**自身可上下滚动**；**高度降到 2 排表情格**（用户 2026-09-12 指出前两版都没理解此需求） | 用户 2026-09-12 对话（含参考截图）；`CHANGELOG` Changed「表情面板降到两行表情格」 | 已做（待用户复测；网格高度口径 2026-09-13 由「两行」再改为「三行大表情格、两组同高」，见 P37②） | 提交 `6b63ece`（worktree 内 `5019171`）：面板顶上不再渲染标题与「关闭」（收起靠再点「表情」或点面板与输入区之外，`Composer.tsx` 注释与 `ui.md` §6.3「关面板」行同步）；左侧轨道与网格**同高并各自滚**（`panelEmoteRailScrollable` / `panelEmoteRailKeepsGridWidth`，`scrollbar-gutter: stable` 保证不挤窄网格）；网格高 = 2 × 当前那一组的格子高 + 一道行距（`panelEmoteGridTwoCommonRows` / `panelEmoteGridTwoBigRows` / `panelEmoteHeightIsTwoRows` / `narrow_panelEmoteGridOverflows`），宽屏面板整块 257 → 84.3px；`ui.md` §6.3 / §9.1 |
| P29 | 主页不显示弹幕页的 tab 条（与「已连接房间」功能重复） | 用户 2026-09-12 对话（含参考截图）；`CHANGELOG` Changed「主页不再渲染弹幕页的标签条」 | 已做（待用户复测） | 提交 `6b63ece`（worktree 内 `5019171`）：标签条只在房间页里渲染（`db-room-tabs`），主页不留空容器（`App.tsx`）；冒烟按「标签条只在该在的地方」断言；`ui.md` §2.1 / §2.3 |
| P30 | 主页「不对称」实为**高度**问题：**高度缩到出现滚动条之后，元素右侧回缩**（原描述「右边距比左边宽」系误判，用户亲自更正） | 用户 2026-09-12 对话（含更正）；`CHANGELOG` Changed「恢复 macOS 原生覆盖式滚动条」 | 已做（待用户复测） | 提交 `6b63ece`（worktree 内 `5019171`）：根因是 `index.css` 给滚动条写了 `::-webkit-scrollbar` 一族样式 —— WebKit 因此把 macOS 原生的**覆盖式**滚动条换成**占宽**的经典条，内容右侧被吃掉一条（同一个根因还有「窗口右边缘拖不动」）；删掉那族样式，`.listPage` 加 `scrollbar-gutter: stable both-edges`（左右对称且有没有滚动条都不跳）、`.scroller` 加 `scrollbar-gutter: stable`；修法与改前/改后左右距离数字见该票报告；`ui.md` §9.2（滚动条段；冒烟 `listPageRightEdgeStable` / `listPageMarginsSymmetric`） |
| P31 | 发送失败不要在页面最下方出常驻提示；改为**浮动提示 + 渐隐消失**，且提示期间**不得遮挡或阻断弹幕区的滚动** | 用户 2026-09-12 对话；`CHANGELOG` Changed「发送失败的提示改成浮动提示」 | 已做（待用户复测） | 提交 `6b63ece` 落地、`0d7c53b` 收尾（文案不再重复「发送失败」前缀 + 与列表留一道间距）：失败改写 `.toast`（`db-toast`，`role="status"`），排在弹幕列表与输入区**之间**、与列表矩形**不相交**（`sendFailToastClearsList` / `sendFailToastAboveComposer`）、`pointer-events: none`（`sendFailToastPassive`，不挡滚动与点击）、出现 → 停留 → 淡出全在 CSS 动画里，`SEND_TOAST_MS`（2600ms）同时决定动画时长与摘除时机（`sendFailToastGone`），连续失败复用同一个元素重新计时；最下方只留「未登录」静态说明（`sendFailNoBottomHint`）；`ui.md` §6.5 / §6.5.1 |

| P32 | 弹幕行改「上下两行式」：头像 / 用户名 + 身份牌 / 正文**另起一行**——原实现是「身份簇 ｜ 正文」左右两列，正文被挤到只剩一小条。用户原话：「长文本弹幕自动换行还是没有实现好」 | 用户 2026-09-13 对话（原话）；`CHANGELOG` Fixed「弹幕行改成『身份在上、正文在下』的上下两行」；提交 `8195b0d` | 已做（两引擎冒烟实测，待用户复测） | 根因**不是**折行没生效，而是**正文没有它该有的宽度**（窄屏 360 下正文只有 165.1px / 占视口 45.9%，同一段折 4 行）。改后正文拿到整行宽度：窄屏 **305.8px**（80.0%，同一段 **2 行**）、宽屏 1385.8px（96.2%），**每一行左边界都与首行一致**（悬挂缩进由结构给出，不靠 `padding-left` / 负 `text-indent`）。⚠ 正文块必须 `display: flow-root`（不是 `block`）：块级大表情带 `-1.05px` 的负 `margin-block`，普通块会与它**边距折叠**、整个正文块上提 1.05px 骑到身份行上（冒烟实测 bodyTop 比身份行底边高 1.1px）。随两列排法一起删掉 `--identity-max-w`（宽屏 14em / 窄屏 10em）与 `grid-template-columns`；虚拟列表 `estimateSize` 26 → 58。冒烟 `fixtureTextBodyKeepsHalfViewport` / `layoutHangIndentAligned` / `fixtureBodyOnSecondRow` / `fixtureAsciiNoOverflow` / `fixtureBodyAlignedWithName`；`ui.md` §4.1 |
| P33 | 弹幕样式按用户给的参考图实现：行内顺序改「**用户名 → 身份牌**」、身份牌改**长方形**、行距加宽（不放分隔线、不加气泡） | 用户 2026-09-13 原话「弹幕样式也没有按照我给的参考图来实现」；参考图 `打开哔哩哔哩继续观看.png`（仓库根，**未入库**）；提交 `8195b0d` | 已做（待用户复测） | `CHANGELOG` Fixed（同 P32 那一条）：行内顺序按参考图改成「用户名 → 身份牌」（牌在名字**右侧**）、身份牌 `border-radius: 0.55em → 0.25em`（长方形；2026-09-13 再调大到 **0.45em**，见 P37⑥）、行间留白 `--sp-1 → --sp-2`；时间戳开关与右键菜单不动；`ui.md` §4.1（「身份牌在昵称右侧」「间距只有 --sp-1」两行）/ §4.2 |
| P34 | 头像要比身份簇**稍高一点**（原话「太小了看不清」），且**不得把身份牌一起带大** | 用户 2026-09-13 原话；`CHANGELOG` Fixed「头像放大到『比身份簇稍高』，并与身份牌解耦」；提交 `8195b0d` | 已做（两引擎冒烟实测，待用户复测） | 头像 `--avatar` 由 0.9 × 行盒改成 **1.25 × 行盒**（18.9 → 26.25px），身份行（用户名 + 牌那一行）仍是 1 × 行盒（21px），因此头像比身份簇高约 25%；对齐口径从「垂直居中于首行盒」改成**顶部与身份行对齐**（参考图口径）。⚠ 身份牌 `--badge-h` 从「= `var(--avatar)`」拆成独立的 **0.9 × 行盒**，否则一放大头像牌会跟着变大（用户明确不要）。行外头像（共用 `Avatar` 组件的 `:root` `--avatar: 1.35em`）未动。冒烟 `rowScaleCoherent`（1.25 / 0.9 / 1.1 × 行盒）/ `rowAvatarTallerThanIdentity` / `rowBadgeNotFollowingAvatar` / `layoutAvatarTopAlignedWithIdentity` / `rowScaleFollowsFontSlider`（0.85 / 1 / 1.6 三档字号）；`ui.md` §4.1 / §4.2 |
| P35 | 开播状态标**缩小**（P27 头部重构的更正之一；两轮各缩一档） | 用户 2026-09-13 原话「开播状态标稍微缩小一点」+「并且要改小一点」；`CHANGELOG` Changed「状态点缩小一档」+「用户验收后的八条精调（2026-09-13 第 2 批）」第 5 条；提交 `ed7f2c6`（12 → 10px）、`c65c388`（10 → 8px，见 P37⑤） | 已做（待用户复测） | 看得见的点 **12 → 10 → 8px**（令牌 `--live-dot`，画在 `::after` 上），元素盒仍是 `--sp-3` 12px、**热区 / 悬停面不跟着缩**（不用 padding 撑热区：背景会铺满 padding 区、圆角一夹就变成一颗更大的圆）；开播档的同色柔光也跟着点走（视觉占位 18 → 16px）；**三态映射两轮都没改过**（本轮用户以为没按要求来，实测证明映射本来就是那一套，见 P37⑤ 的事实纠偏）；`ui.md` §3.1 / §9.1 |
| P36 | 展开表情面板后**切 tab 不再把面板关掉**（真 bug） | 用户 2026-09-13 原话「表情包现在还是有 bug，展开表情包面板后切换 tab，面板就自动关闭了」；`CHANGELOG` Fixed「展开表情面板后切换 tab 不再把面板关掉」；提交 `ed7f2c6` | 已做（两引擎冒烟实测，待用户复测） | 根因：本批新加的「点输入区外面收起面板」（`pointerdown` 捕获阶段）把**面板内部**的按下也当成了外面 —— 面板与输入区是**兄弟**节点，真鼠标点 tab 先发 `pointerdown`、面板当场卸载，tab 自然切不动。判据收窄成「面板与输入区**之外**」：输入区、展开中的面板、面板自己弹出的右键菜单三块都算「里面」，点弹幕列表等外面照旧收。冒烟 `panelSurvivesTabSwitch`（面板还在 + 选中的组确实换了）/ `panelStaysOnInsidePress` / `panelClosesOnChatPress`，复现补了一次**真实的 `pointerdown`**（`.click()` 只发 click 事件、绕过那条监听，正是它当初漏测的原因）；`ui.md` §6.3「关面板」行 |

| P37 | 用户验收后**逐条提的八条精调**（2026-09-13 第 2 批）：① 身份牌后那枚「回复 @某人」标记与正文里的 @ 重复 → **删掉标记**、改为**正文内 `@昵称` 就地高亮**（配色取身份牌字符色）；② 表情面板网格 **2 行 → 3 行**（**按大表情那一档固定**高度，通用组同高）；③ 电池图标**横向 → 竖向**（原话「看着像电量标，容易造成误会」）；④ 返回与 `⋯` 的描边粗细不一致 → **折中到 1.5px / 1.5px**（`⋯` 改画矢量三点，不再靠字体字形）；⑤ 状态点**再改小一档**（可见 12 → 10 → **8px**，热区仍 12px）；⑥ 身份牌**圆角变大**（0.25em → **0.45em**）；⑦ **行内通用表情偏小**（200×60 被塞进见方盒，可见高度只剩 6.9px）→ 改走**宽盒 77 × 23.1px**；⑧ 展开表情面板后**切 tab 不再把面板关掉**（真 bug，修在 P36） | 用户 2026-09-13 验收对话（逐条）；`CHANGELOG` Changed「用户验收后的八条精调（2026-09-13 第 2 批）」8 条；提交 `c65c388`（父 `111ca00`） | 已做（待用户复测） | ① 正文里的 `@昵称` 套 `.mention`（`data-testid="db-msg-mention"`，名字正则取到空白 / 句读为止），字符色 `--badge-fg`、底取身份牌那道强调色渐变；`db-msg-reply` / `db-msg-reply-name` 与那枚牌子**整格删除**（冒烟 `mentionHighlighted` / `mentionColorMatchesBadge` / `mentionWorksWithoutReply` / `mentionHighlightedWithoutUpstreamColor` / `mentionBodyTextIntact`）；② `--emote-grid-h = 3 × --emote-row-h-big + 2 × --sp-1`，两组同高、`.pickerBig` 的「按组算高」删除（实测网格 152.1px、面板整块 169.1px 宽 / 177.1px 窄；`panelEmoteGridThreeBigRows` / `panelEmoteGridSameHeightForBothGroups` / `panelEmoteHeightIsGridPlusPadding`）；③ 机身 `10 × 16` 竖矩形 + 顶部极柱，图标盒仍 1.1em（`batteryIconShape`）；④ 两枚图标都是矢量、粗细都是 1.5px（改前 2px vs 字形墨迹 1px；`iconWeightsCompromised` / `iconWeightsMatch`）；⑤ **事实纠偏（不是映射变更）**：用户说「状态标没有按照我的要求来」，实测把三态各走一遍（连接态断开 → 橙；`connected` + `live_status` 非 1 → 红；`connected` + `live_status == 1` → 绿）证明**映射本来就是用户要的那一套**（橙 = 断连 / 红 = 已连接·未开播（含轮播）/ 绿 = 已连接·开播），本轮**只改大小**（10 → 8px）并**新增三条断言把三态钉住**（`liveDotStateMapping` 逐状态比对令牌 / `liveDotStatesDistinct` 三色互不相同 / `liveDotRestoredAfterStates` 三态走完回到真实态）；⑥ 0.45em（`badgeRadiusGrew` / `badgeRadiusRatio`；尺寸与配色不变）；⑦ 通用横条走 `.contentEmoteWide` 宽盒 = 高 `--emote` 23.1px、宽 = 10/3 × 高 = 77px（`rowInlineEmoteWideBox` / `rowInlineEmoteTallerThanText` / `rowInlineEmoteFitsRow`）；⑧ 见 P36（判据收窄为「面板与输入区之外」，`ed7f2c6` 修，本批未再改动）；文档：`ui.md` §3.1 / §4.1 / §4.2 / §4.3 / §6.3 / §6.4 / §9.1 |
| P38 | 弹幕里的**文字表情整族丢失**：用户报「表情包【dog】渲染不出来」——界面把 `[dog]` 当普通文本画成字面量。根因是上游对文字表情走 `info[0][15].extra.emots`（键 = 正文 token）这条路，而解析只看 `info[0][13]` | 用户 2026-09-13 原话；`CHANGELOG` Fixed「弹幕里的文字表情（`[dog]` 这类）不再整族丢掉」；提交 `b0e2524` | **部分**（整条 = token 的 341 条已修；token 夹句中的 855 条**仍未做**） | **规模**（2026-09-12 全天 49294 条真实 `DANMU_MSG`）：带 `extra.emots` 的 **1196 条**（`info[0][13]` **全是**空槽位 `"{}"`）、槽位 13 是对象的 **4043 条**（`emots` **全为空**），**两类零重叠**；`[dog]` 命中 **349 条**。根因：`cmd.rs` 只看槽位 13 → `Message.emote` 恒 `null` → 界面按非表情弹幕原样画正文（前端渲染这一环实测正常：注入 `emote` 非空的 `Message` 产出 `<img>` 23.1×23.1px、真图加载）。**已修**：正文**整条恰好是一个 token** 时填 `Message.emote`（与 `history.rs` A32 同一口径，避免整条画图吞掉用户的话；共 **341 条**，其中 `[dog]` 整条 **36 条**）→ 照表情弹幕画图；槽位 13 优先于 `emots`。**未做**：token **夹在句中**的 **855 条**仍按原文显示（`Message.emote` 是「整条画图」语义，行内替换要改前端渲染，本轮没做——`docs/ui.md` §4.1 已记为缺口）。口径 `docs/protocol.md` §10.1.x / 附录 A42、`docs/contract.md` §5；夹具 `smoke/fixtures/danmaku-rows.json` 的 `emots`（整条）与 `emots-inline`（夹句中）两条**完整原始记录**（脱敏）；验证：`cargo test --workspace` 197 passed、clippy 干净、两引擎冒烟各 1772 项 / 44 张退出码 0 |
| P39 | **「从收到的弹幕里学表情、补进表情面板」整条机制去掉**（学来的表情本来就发不出去） | 用户 2026-09-13 原话「那确实就是学来的根本发不了嘛，直接把这个去掉，不需要学来表情包」；`CHANGELOG` Removed「『从收到的弹幕里学表情、补进表情面板』整条机制删除」 | 已做（两引擎冒烟实测，待用户复测） | 删 `filtering.collectSeenEmotes` 与它的整条管线：`App.tsx` 的 `seenEmotes` 计算与透传、`RoomView.tsx` / `Composer.tsx` 的 prop、`Composer.tsx` 的合并层（`allEmotes` → `panelEmotes`，只剩接口那一份）。**事实依据**：① 学来的那一族是跨房间的 `room_<房间号>_<id>`，发送必被上游拒 `code=10203`（连房间属本账号自己也一样）；② 弹幕里的表情渲染消费的是后端 `Message.emote`（`EmoteRef`），与本机制无关 —— 因此是纯删除，渲染未动。面板从此只显示上游下发的表情（`ui.md` §4.4/§6.3、`contract.md` §5）。冒烟：删掉只为它存在的 `panelLearnedEmoteListed`，`panelUnlockedEmoteNotDimmed` 的条数 11 → **10**（真实的上游条数） |

**产品需求小计：39 条**（已做 36 / 部分 3 / 未做 0）。

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

| E11 | **提交时必须跑 `cargo clippy --workspace --all-targets -- -D warnings`**（零告警）——跨语言交付门槛：Rust 侧 clippy + 前端 `tsc -b && vite build` 两条都得过 | 用户 2026-09-13 对话（工程规矩，要求新增一条台账）；`AGENT.md` §3 命令表 / §4 Rust 风格 / §9 DoD | 已做（已固化成条文） | `AGENT.md` §3「Lint」行、§4「Lint 必须零告警」、§9 DoD 第 3 项；前端侧同表「前端类型检查 + 构建」= `npm --prefix apps/desktop/ui run build`（`tsc -b && vite build`）；本轮实证：`ccaf49e` 就是为消掉一条 clippy 告警（`doc_lazy_continuation`，`crates/danmubox-bili/src/follow.rs` 的文档注释缩进）单独补的提交，说明这道门确实在卡 |

**工程规矩小计：11 条**（已做 9 / 待核 2）。

---

## 3. `issue` 20 条对照

> 核对基线：`IssueAudit` 的逐条审计（2026-09-12，只读），**再按其后合入的整改更新**（列表重排 `f8444ad` / 主播名 `2e95a22` / 颜文字 `d6ba109` / 时间戳白名单 `009d9e0` / 表情面板 `f19de72` / 未开播补齐 `4f9e2a7` / 弹幕行两行式 `8195b0d` / 房间头与表情面板的验收更正 `ed7f2c6` / 验收后八条精调 `c65c388`（涉及第 13、20 条的两处：回复标记删除、面板高度三行））。原文件见仓库根 `issue`（只读，未改）。

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
| 11 未开播也展示 + 排序 + 分页 | 部分（2026-09-13 修正） | **原审计结论不成立**：上游 `GetWebList` 只给在播房间（关注 90 人 / 在播 0 人 → `list=[]` + `not_living_num=90`），未开播的一个都没进过列表；已改为「主站关注关系 + 直播批量房间接口」两步取全量（实机 0 → 70 条，另一账号 0 → 4 条）；提交 `4f9e2a7`；`docs/protocol.md` A28 修正、`CHANGELOG` Fixed | 每页 30 条；**仍未闭环**：未开播条目拿不到「最后开播时间」（上游不给，`live_time` 为 0），该档排序落回 `online` / 房间号；见 P11 |
| 12 舰长标只看本房间 | 已做 | `Message.guard_level` 取 `info[7]`；`docs/protocol.md` A39 | 粉丝牌自身标记另开 `medal_guard_level` |
| 13 @ 脱钩 / 弹幕里看不到 @ | 部分 | @ 目标从草稿派生（已做）；**回复标记（`db-msg-reply`）2026-09-13 已按用户要求删除**（与正文 @ 重复），改为正文内 `@昵称` 就地高亮（提交 `c65c388`，见 P37①） | 「纯 @」与「回复」在**收包侧不可区分**，`docs/protocol.md` §11.6 / A40 未闭 |
| 14 窄屏两排 + 不露房间号 | 已做 | 提交 `f8444ad`；`ui.md` §2.2 / §9.1 | 断点 520px，360 可达 |
| 15 宽屏一排 + 不露房间号 | 已做 | 提交 `f8444ad` | 同上 |
| 16 全量展示 + 置顶 + 最近观看降序 | 已做（「全量展示」2026-09-13 才成立） | 新偏好键 `ui.recent_watched`（`contract` §8）；全量展示由 P11 的两步取法补齐 | 审计时「最近观看」这一维不存在，已新增；「全量展示」此前实际只有在播那些，见 P11 |
| 17 房间列表不露房间号 + 主播·直播间名 | 已做 | `Room.anchor_uname`（`contract` §5）；`docs/protocol.md` A41；提交 `2e95a22` | 审计时未做，且需先补 `anchor_uname` 字段（动契约 + 后端） |
| 18 tab 显主播名 | 已做 | 提交 `2e95a22`；`ui.md` §2.3 | 同上（依赖 `anchor_uname`） |
| 19 短语删颜文字 | 已做 | 提交 `d6ba109`（worktree 内 `9db6e35`）；`CHANGELOG` Removed | 审计时未做 |
| 20 表情 tab + 不溢出 | 已做 | 提交 `f19de72`（worktree 内 `0375f44`）；`ui.md` §6.3 | 溢出 24.9px → 0；另有三条 UX 补充（点选即发 / 去搜索框 / 网格高度）**已落地**（提交 `cc39eda`，两引擎各 629 项快照全绿），见 P23；网格高度口径其后两改（两行 → 三行大表情格），见 P28 / P37② |

**issue 小计：20 条**（已做 18 / 部分 2 / 未做 0）。

---

## 4. 状态总览

| 部分 | 条数 | 已做 | 部分 | 未做 | 不做 / 待核 |
|---|---|---|---|---|---|
| §1 产品需求 | 39 | 36 | 3 | 0 | 0 |
| §2 工程与过程规矩 | 11 | 9 | 0 | 0 | 2（待核） |
| §3 `issue` 20 条 | 20 | 18 | 2 | 0 | 0 |
| **合计** | **70** | **63** | **5** | **0** | **2** |

> 计数口径：每节「条数」= 该表实际行数；每行之和 = 条数、每列之和 = 合计（`39 + 11 + 20 = 70`；`36 + 9 + 18 = 63`；`3 + 0 + 2 = 5`；待核 `0 + 2 + 0 = 2`；未做 `0 + 0 + 0 = 0`）。**「未做」一列现已归零**：`P23` / `P24` 随 `cc39eda` / `8195b0d` 落地，原先的「未做（进行中）」是它们落地前写的。本轮新增 `P37`（八条精调，已做）与 `P38`（文字表情整族丢失，**部分** —— 整条的 341 条已修、夹句中的 855 条未做），因此 §1 由 36 → 38、已做 34 → 35、部分 2 → 3。再新增 `P39`（学来的表情机制整条删除，已做），因此 §1 38 → 39、已做 35 → 36、合计 69 → 70 / 62 → 63。
> 待核两项（E1「清单外动作先问」、E3「重建攒批做」）是对话内规矩但尚未固化成仓库条文；证据栏给了最接近的已有条文与出处，并各留了一条落地建议。
