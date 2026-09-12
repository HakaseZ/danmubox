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

### Changed

- **账号管理重写：IPC 由 `profiles_*` 改为 `account_*`，并且「每个账号的登录状态与身份」成为接口的一等公民**
  （需求 §2.5）。旧实现把「profile」这个**存储概念**直接漏进界面，于是有两处说不通：单账号时账号下拉看起来是坏的；
  新增账号必须先起名再扫码——名字本来是给存储起的，用户凭什么在扫码前就知道该叫什么。这次改成：
  - `accounts_list` 返回 `Account[]`（`name` / `nickname` / `uid` / `face` / `logged_in` / `active`）。**界面从此看得见
    「谁登录了、uid 多少、头像是谁」**：有凭据的账号逐个向 `nav` 求证（凭据失效才算未登录，网络错误**不改**登录态），
    求证**并发发起**（实测：4 个账号一次 106–144ms，比单个账号的冷启动请求还快；串行会随账号数线性增长），
    且单个账号求证失败只影响它自己那一行。
  - `account_qr_start(target?)`：不带 `target` = **新增账号**，带 = 给该账号**重新登录**；**先扫码后起名**，
    确认后按扫码得到的昵称生成账号名（昵称里的中文会被清掉，全清空则落 `uid<uid>`，重名加 `-2` 后缀），
    落盘并设为当前账号。`account_qr_poll(key)` 在确认那一次直接返回落盘后的 `Account`。
  - `account_login_cookie(cookie, name?)`：手填 Cookie（需求 §2.5 的三种方式之一）有了程序入口——校验
    `SESSDATA` / `bili_jct` / `DedeUserID` 三要素（缺一即 `BAD_REQUEST` 并点名缺谁），归一化成与扫码同形的凭据，
    **落盘前先向 `nav` 求证**，免得界面出现一个「显示已登录、其实连不上」的账号（S2-AC5 的同一类坑）。
  - `account_switch(name)` / `account_logout(name?)` / `account_remove(name)`：登出只清**账号级**凭据、
    **保留账号条目**（`logged_in = false`——退回游客态但槽位还在，可再登录回来，`buvid3` / `buvid4` 也保留）；
    删除保留两条护栏（不许删最后一个、删当前项自动切走）。
  - 旧的 `profiles_list` / `profiles_switch` / `profiles_create` / `profiles_remove` / `session_logout` /
    `session_qr_start` / `session_qr_poll` **一律删除，不留别名**；扫码统一走 `account_qr_*`。
  - CLI 同步改名并重排语义：`accounts`（列表带登录状态与身份、`--use` / `--remove` / `--create` 扫码新增 /
    `--cookie -` 从 stdin 手填）、`login [账号名]`（缺省 = 新增账号，给名字 = 重新登录）、`logout [账号名]`；
    旧的 `profiles` 子命令与其 `--create <名字>`（先起名后扫码）一并删除。

### Added

- **账号管理重做：一行身份 + 账号管理对话框**（issue #14；IPC 见 `docs/contract.md` §7 的 `accounts_list` /
  `account_*`，交互见 `docs/ui.md` §2.2.1）。房间列表页的账号区从「下拉 + 删除该账号 + 起名 + 新建并扫码 +
  扫码 + 登出」一堆内联控件，改成**一行当前身份**（头像 + 昵称 + `uid`，未登录显示「游客态」）加一个
  「账号」按钮：**切换不再做成下拉**——只有一个账号时下拉里就一项，会被读成「切换功能坏了」（用户原话
  「切换身份的功能好像没法选」）。对话框里一行一个账号，露出**昵称 + uid + 账号名**与三种状态
  （`已登录 · 当前` / `已登录` / `未登录`），操作是切换 / 重新登录 / 退出登录 / 删除：
  - **「＋ 添加账号」是默认入口，永远不覆盖任何凭据**：点了直接出二维码（`account_qr_start()` 不带
    `target`），**不需要用户先起名字**，扫完由后端按昵称自动命名并落盘；列表随即多一行且标为当前。
  - **覆盖路径单独且有确认**：给已有账号「重新登录」（`account_qr_start(target)`）先出二次确认条，
    写明「会用新凭据**覆盖**该账号（账号名）现有的凭据，原凭据无法恢复」；二维码面板上另有一行同样
    口径的警示。此前「扫码登录」的语义就是覆盖当前凭据，用户拿它登新号时把原账号的凭据顶掉了——
    「添加」与「重新登录」现在是两个动作，长得也不一样。
  - 三种登录方式都在对话框里可达：扫码（默认）、**手填 Cookie**（折叠的高级入口，密码型输入框，值只进
    一次 `account_login_cookie` 调用、不回显、不落状态）、游客（退出登录即清凭据，条目保留可重登）。
  - 删除/退出登录都二次确认且说明后果；**只剩一个账号时禁止删除**；删当前账号由后端自动切走，界面随后
    重拉 `session_status` / `accounts_list` / `rooms_list` / `follow_list`，并把「当前」标记刷新——
    换号后不会留着上一个人的关注列表。
  - 用 `accounts_list` 取代「自己数 `config.toml` 里的名字」：每个账号的登录状态与身份由后端给出，
    界面不再猜。旧 `profiles_*` / `session_qr_*` / `session_logout` 调用全部删除，不留别名。
  - 无头冒烟新增 30 余条 `account*` 断言（单账号也有添加入口、无下拉、添加不带 `target`、二维码渲染出
    `img`、轮询到 `confirmed` 后多一行且标为当前、重新登录未确认前不发命令、删除当前后自动切走、
    退出登录回游客态）与三张截图（`danmubox-ui-account-area.png` / `-account.png` / `-account-qr.png`）。

- **弹幕里的「回复了谁」可见**（issue #13b 的界面侧，契约 §5 `Message.reply_to_uid` / `reply_to_uname`）：
  昵称之后、正文之前显示「回复 @昵称」弱化小标（`db-msg-reply`，定宽截断 `14em`、完整名字在
  `title`），非回复（`reply_to_uid == 0` 或昵称为空串）不渲染这一格；它不占正文列，因此不影响
  正文折行与时间戳 / 昵称的纵向对齐。引擎已把回复关系带出来（见下面「弹幕的回复关系不再丢失」），
  此前界面拿到了也没地方用，用户只能凭正文猜某条是不是回复。
- **主站「我的表情」接进表情面板**（issue #8）：`emotes_owned` 拉回来的包成为选择器的
  「我的表情」分组（排在「通用」之后），与 `emotes_list` 的按房间包同属**接口侧**——
  同一个 `emoticon_unique` 只保留接口给的那条，从弹幕学到的那些只补漏。加载时机是
  「进房间且会话就绪后拉一次」（与房间无关，成功一次即不再请求），面板打开时若**上次失败**
  再试一次并给出可重试提示；失败只写在面板里，**不阻塞输入框**。发送预览同样吃这份合并结果：
  没有它，草稿里的 `[表情名]` 会静默地显示成纯文字，用户以为表情没渲染。
  实测（本机登录态）：该账号主站表情 20 个，`upower_[Kirikosama_吃瓜]` 在列；点它发送时
  `chat_send` 带的是 `emote.emoticon_unique = "upower_[Kirikosama_吃瓜]"`，适配器据此把上游
  `msg` 填成同一个唯一键（`crates/danmubox-bili/src/send.rs`）。
- **房管界面**（issue #3，端口与 IPC 见 §Added 的「房管能力」）：行右键菜单对某个人给出
  「禁言…」「拉黑」「解除禁言」，权限前置取自 `room_session` 的 `RoomSession.is_admin`——
  **不是房管就置灰并写明原因**，不退化成「点了再看上游权限错误码」；另加一个**房管面板**
  （房间头 `⋯` 菜单开合），三块列表：禁言名单 / 黑名单 / 屏蔽词，各带增删。**无权限也允许打开**
  面板看上游原样回应，三块各自的错误按 `code` + `message` 原样展示。
  所有写操作（禁言 / 解除 / 拉黑 / 移出 / 增删屏蔽词）一律**二次确认**，文案说清对象与时长
  （禁言时长五档：本场直播 / 永久 / 1 / 6 / 24 小时，对应 `admin_mute` 的 `hour`）。
- **粉丝牌用上游真彩色**（契约 §5 `medal_color_start` / `_end` / `_border` / `_text`）：牌面
  45° 渐变、描边与文字色优先取真彩色；**空串不是颜色**，任一为空时回退到按牌名派生的色相
  （本地兜底，同一主播固定），描边与文字色各自回退到 CSS 默认。

### Fixed

- **@ 目标与文本框不再脱钩**（issue #13a）：`@某人` 之后把文本里的 `@昵称` 删掉再发送，过去
  仍会带上 `reply_mid` / `reply_uname`——文本里看不见的 at 就这样发出去了。现在 @ 目标
  **从草稿文本派生**（不另存一份目标状态）：文本里没有这个 token 就不带目标，两者不可能不一致；
  条件成立时输入区上方显示「将 @昵称 · 删掉文本里的 @昵称 即取消」，显示的与发出去的永远一致。
  「回复」是显式的引用条（可见、可取消），不依赖文本，照旧带 `replay_dmid`；两者同时存在时回复优先。
- **弹幕列表在内容不足视口时不再贴顶，改为贴底**（直播弹幕自下往上读，官方聊天栏同样贴底）。
  实现用「滚动容器 flex 列 + 内层虚拟高度块 `margin-top: auto`」——不用 `justify-content: flex-end`，
  后者会把超长内容的顶部顶出可滚动区间、滚不回去。实测：滚动容器底边与末行底边之差由
  `506px` 变为 `8px`（= 容器 `padding-bottom`）；跟随滚动与「回到最新」的锚定未受影响。
- **头像列永远占位，昵称 / 时间戳 / 正文三列纵向对齐**（用户 #8「时间要对齐（宽度一致）」）：
  `face` 为空的行过去不渲染头像，导致整行左移，与有头像的行差一个列宽。现在头像列始终占位
  （空容器，宽 `1.35em`），实测三行昵称左边缘由 `44.9 / 36.5 / 26.0` 变为 `44.9 / 44.9 / 44.9`。
  占位元素不带 `db-msg-avatar`，因此「没头像」与「头像加载失败（首字符占位）」仍可区分。

### Changed

- **大航海槽只认 `guard_level`**（issue #12 的界面侧）：`medal_guard_level` 是牌子**所属房间**的
  身份，界面不拿它兜底画舰长标；引擎已把取数改成发送者在本房间的 `guard_level`（见下条）。
  冒烟用两条断言把这条口径钉住：戴着他房间的舰长牌（`medal_guard_level = 3`、`guard_level = 0`）
  不亮舰长标，本房间舰长（`guard_level = 3`）亮。`medal_guard_level` 留给牌面样式，但界面
  **暂不做**视觉区分——官方对它的具体画法没有实测依据，现有牌面（真彩色 + 等级格）已够辨识。

### Added

- **舰长标只看「本房间」的舰长身份**（issue #12）：`Message.guard_level` 改为取弹幕的
  `info[7]`（发送者**在本房间**的大航海等级）。此前拿粉丝牌上的 `guard_level` 兜底，
  于是「戴着他房间舰长牌」的人也被画上了本房间的舰长标；`user.guard` 实测恒为 `null`，
  不能当来源。粉丝牌**自身**的舰长标记另开 `Message.medal_guard_level`（官方只用它
  给牌面做样式区分）。协议依据 `docs/protocol.md` 附录 A39。
- **弹幕的回复关系不再丢失**（issue #13）：`Message` 新增 `reply_to_uid` / `reply_to_uname`
  （`reply_mid == 0` 即不是回复）。实时侧取 `info[0][15].extra` 这个 JSON 字符串里的
  `reply_mid` / `reply_uname`（与举报标识 `id_str` 同源）；进场回填的历史条目取顶层
  `reply` 对象。`docs/protocol.md` §11.6 原先写的「收包侧在 `DANMU_MSG` 的 `reply` 对象」
  据此更正。协议依据附录 A40。
- **本人在房间的身份可查**（契约 §7 `room_session`、§3 `LiveSource::room_identity`）：
  进房时取一次本人粉丝牌 / 大航海 / 是否房管（官方进房接口 `getInfoByUser`），
  既可以直接读，也经既有 `danmubox://session` 事件推送——房管菜单的可见性由此有了
  确定答案，不再退化成「先放行、点一次再看上游报错」。无活跃会话时返回该房间的
  全零身份而**不报错**（与 `history_query` 同风格），界面按无权限渲染。
  顺带 `emotes_list` 不再传零身份，表情包按真实身份加载。协议依据 `docs/protocol.md` 附录 A38。
- **粉丝牌配色**（契约 §5 `Message.medal_color_start` / `_end` / `_border` / `_text`）：
  实时弹幕与进场回填都带出上游 `user.medal.v2_medal_color_*`——官方前端的
  `getMedalHtml` 用的就是这一组，取值是带 alpha 的 CSS 十六进制串（实测
  `#3FB4F699` / `#FFFFFF`）。同层另有十进制的 `color*` 旧字段，**不是**这一组。
  缺失为空串（空串不是颜色，界面自备兜底色）。协议依据 `docs/protocol.md` 附录 A37。
- **多账号入口**（需求 §2.2）：IPC 新增 `profiles_create` / `profiles_remove`——新建一个 profile
  并设为当前（凭据先留空，随后扫码 / 手填），以及删除一个 profile。不许删掉最后一个；
  删的若是当前项，当前指向自动切到剩下的条目。名字只允许 `[A-Za-z0-9_-]`、长度 ≤ 32，
  非法或重复一律 `BAD_REQUEST` 且**不覆盖**已有凭据。此前「切换身份」的入口一直不可用，
  根因是没有新增账号的路径，而不是切换本身。
- **消息带发言者头像**（契约 §5 `Message.face`）：实时弹幕取 `info[0][15].user.base.face`，
  进场回填的历史条目取 `user.base.face`，缺失为空串。
- **主站「我的表情」**（`EmoteProvider::owned`，IPC `emotes_owned`）：取
  `GET api.bilibili.com/x/emote/user/panel/web?business=reply`，把主站拥有的表情包
  （`upower_` 家族）补进表情选择器——这一族不在直播表情接口里，只能从这里取。
  包在 `data.packages[]`、表情在包的 **`emote[]`**（不是直播那套 `emoticons`）；
  唯一键按 `upower_` + 表情 `text` 拼装；包分类新增 `owned`。未登录时上游退化为免费表情包。
  协议依据 `docs/protocol.md` 附录 A35 结案。
- **房管能力**（端口 `RoomAdmin`，IPC `admin_silent_list` / `admin_mute` / `admin_unmute` /
  `admin_blacklist_list` / `admin_blacklist_add` / `admin_blacklist_del` / `admin_keywords_list` /
  `admin_keywords_add` / `admin_keywords_del`）：禁言名单、禁言 / 解除、黑名单增删查、屏蔽词增删查。
  **只读三个列表接口已用真实登录态实测**（禁言 `POST …/v1/banned/GetSilentUserList`、
  屏蔽词 `POST …/v1/banned/GetShieldKeywordList`、黑名单
  `GET …/xlive/app-ucenter/v2/xbanned/banned/GetBlackList`——注意黑名单在 `app-ucenter`
  且按主播 uid 寻址）；写操作的参数与响应**未实测**，按官方前端实现核对，见附录 A36。
  随后又在一个本账号有房管的房间复核：禁言名单每页固定 10 条、该房间实测 481 条 / 49 页
  （翻页上限因此放宽，避免静默截断），黑名单条目字段是 `uid` / `name`（**不是**禁言那套
  `tuid` / `tname`），实现据此修正。
- **关注列表新增开播时刻与在线人数**（契约 §5）：`live_start_at`（上游 `liveTime`，Unix 秒）
  与 `online`；注意上游另有一个 `live_time` 是「已开播秒数」，两者语义不同，实现只取前者。
- **CLI 新增 `emotes-owned` 与 `admin-lists` 两个核对入口**；`follow` 子命令打印新字段。

- **房间观众数（在线人数 + 累计看过）**：引擎把 `ONLINE_RANK_COUNT` 的 `online_count` 与
  `WATCHED_CHANGE` 的 `num` 冒泡成 `Event::RoomStats`（契约 §5 新增模型、§7 新增事件
  `danmubox://room_stats`），房间头两个都显示。人气值不再展示（用户反馈：那个参数官方客户端也没实现）；
  `POPULARITY_CHANGE` 与 `op=3` 仍计入计数、只落 `debug` 日志。协议依据 `docs/protocol.md` §10.7 / A22 补充。
  实测：某在播房间 50 秒内收到在线 `41→42`、累计看过 `421`，`unknown_cmd` 为 0
  （此前 `ONLINE_RANK_COUNT` 未归类，会污染这个计数器）。
- **两个消息显示开关**（契约 §8）：
  `ui.interact_auto_hide`（默认 `true`）——互动/进场消息显示 8 秒后淡出并从列表移除，关掉则常驻；
  `ui.system_notice`（默认 `false`）——系统通知（开播 / 下播 / 标题变更 / 公告）默认不渲染。
- **关注列表在会话就绪后自动拉取**（需求 §2.6）：启动、扫码登录完成、切换账号后各自动调用一次
  `follow_list`，不再需要用户手动点「刷新」；失败仍走既有错误提示并保留「刷新」按钮。

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
- **阶段 1 交付（首个可运行代码）**：Rust workspace + 三个 crate——`danmubox-core`（领域模型、7 个端口、
  事件总线、会话环形缓冲、偏好文件）、`danmubox-bili`（帧解析与 brotli/zlib 解包、WBI 签名、
  `getRoomPlayInfo` / `getDanmuInfo` / 上游 HTTP 心跳、WS 认证与双心跳、命令归一化、protobuf `INTERACT_WORD_V2`）、
  `danmubox-cli`（`resolve` / `watch` 两个子命令）。
- 字段实测校准落地：`DANMU_MSG` 的颜色 `info[0][3]`、毫秒时间戳 `info[0][4]`、粉丝牌
  `info[0][15].user.medal`、举报标识 `info[0][15].extra.id_str`；`INTERACT_WORD_V2` 的载荷位于
  `data.pb`；`ENTRY_EFFECT` 昵称位于 `data.uinfo.base.name`。结论已回填 `docs/protocol.md`。
- **阶段 2 交付（登录层）**：`danmubox-core` 新增 `ConfigStore`（明文 `config.toml`，权限 `0600`，
  临时文件 + rename 原子替换，多 profile + `active_profile`）与平台数据目录解析；
  `danmubox-bili` 新增 `BiliAuth`（实现 `AuthProvider`：扫码生成与轮询、凭据回写、登出、账号切换），
  `danmubox-bili` 的 HTTP 客户端改为按当前 profile 实时取 Cookie；
  `danmubox-cli` 新增 `session` / `login`（终端渲染二维码）/ `logout` / `profiles` 子命令。
- 凭据值遮蔽：`Profile` 与 `AppConfig` 的 `Debug` 均为手写实现，只输出字段名与 profile 名。
- **进场回填最近弹幕**：进入房间时先用 `LiveSource::recent` 铺一批上游能给的最近弹幕
  （`data.room`，上限 10 条，**不可翻页**），与官方客户端行为一致；带 `is_history` 标记。
  回填先于连接，顺序天然为历史在前（按 `ts` 升序）；不经过 `MessageSink`，不计入流量统计。
  取不到时与从前一样从空列表开始（2 秒上限），不报错、不重试、不延迟连接。
  协议依据 `docs/protocol.md` 附录 A30；`data.admin` 为何不采用见同处 A30 补充。
- **发送失败的原因直达界面**：`SendOutcome::Failed` 原先无载荷，上游的 `code` 与原话只进日志，
  界面永远是「发送失败」。新增 `SendReport { outcome, upstream_code, upstream_message }`
  （契约 §5），`chat_send` 返回 `detail` 字段带上游原话与 code，界面拼接显示，
  例如「发送失败 · 发送失败，请先移除该用户黑名单（code 10023）」。
- CLI 新增 `wallet` / `follow` / `emotes` 三个子命令，作为电池余额、关注列表、表情包库三个
  适配器的验证入口。
- **阶段 3 进行中（发弹幕路径）**：`danmubox-bili` 新增 `BiliSender`（实现 `DanmakuSender`）——
  本地节流（同房间 2s、相同内容 5s，命中时不发请求且不延长窗口）、WBI 签名后的表单 POST、
  以及 `SendOutcome` 归一化（`"f"` / `"k"` 被吞判定与被吞原文回显解析）；
  未实测的错误码一律归为 `failed` 并保留原始 code，不猜测语义。
  `danmubox-cli` 新增 `send` 子命令。请求形态登记为待实测项 A25。

### Added

- **CLI 新增 `--config <路径>`**：指向一个空文件即可跑游客态采集，用于 A21 这类需要两种登录态对照的校准，
  不必动真实凭据。

### Added

- **界面内扫码登录**（此前只有 CLI 能扫）。后端在本地把上游给的 URL 编成 SVG（复用 CLI 已有的
  `qrcode` 依赖），界面显示 + 2 秒轮询；不引任何第三方在线二维码服务。已登录时也能扫——
  即「重新登录」，覆盖当前 profile 的凭据，正是凭据失效时的正路。
  上游链路用**临时配置文件**验证过（打印出真实二维码），全程未碰真实凭据。

### Fixed

- **历史回填前面那一屏「我自己的发言」的根因**：`gethistory` 的 `data.admin`
  （至多 10 条「只看房管」切片）被拼在 `data.room`（房间最近 10 条）**之前**。
  请求者本人是房管时，那一份几乎全是**请求者自己**最近的发言，而且时间整体更早——
  实测某房间 10 条里 9 条是本人，两条数组另有 4 条完全重合（同一 `id_str`）。
  于是界面上就是「最近 10 条历史之前先铺一屏我的发言」＋重复条目，看起来像「本地发送记录混进了历史」。
  处置：`map_history` **只取 `data.room`** 并按 `ts` 升序回填（契约 §4.3、`protocol.md` A30 补充）。
  非房管房间实测 `data.admin` 为空数组，不受影响。
- **改任意偏好都会撤销「互动消息自动消失」的定时器**（无头冒烟发现）：`updatePrefs` 原先无条件
  `clearInteractTimers()`，于是拨一下「系统通知」就让列表里的互动消息永久留下。现在只有
  `ui.interact_auto_hide` 本身变化才动定时器。同一次冒烟覆盖：头部同显在线/看过且无人气值、
  系统消息默认不渲染而开关打开后出现、互动行默认 8 秒后被摘除而关掉则常驻、历史行与实时行
  opacity 相等且无分界文案（脚本见 `apps/desktop/ui/smoke/room-page.mjs`）。
- **历史与实时不再割裂**：去掉历史行的弱化样式（0.55 不透明度）与「以上为进场前的最新弹幕」分界提示，
  两者现在同一套配色 / 字号 / 间距 / 时间戳（`docs/ui.md` §4.7）。

- **删掉凭空造出的「房管」表情分类**。项目所有者确认：**房管没有表情分类**。
  这与两条证据一致——官方前端的表情权限判定 `emoticonDanmakuPermCheck` 只有「粉丝团」与
  「1/2/3 总督/提督/舰长」两个分支，无房管；扫 5 个公开房间也只见通用与房间专属表情。
  房管身份**只体现为弹幕徽标**（`info[2][2]` → `Message.is_admin`，见 A5）。
  处置：删除 `EmotePackage::Admin`、分类器里的房管分支、「房管」分组标签，
  并更正 `REQUIREMENTS.md` §2.2 里同样写错的「（通用 / 粉丝牌 / 大航海 / 房管）」一句。
  万一上游真发来名字含「房管」的包，按房间专属归类，不为其单开一类。

### Calibration

- **房管写操作首次用真实房管权限实测**（用户明确授权，只在一个有权限的房间内、且只以自己为目标）：
  **屏蔽词加/删已跑通** —— `AddShieldKeyword` → 读列表确认在 → `DelShieldKeyword` → 读列表确认没了，
  四步都 `code=0`，房间状态回到初始。顺带修掉一个真缺陷：`keyword_list` 的**条目是对象**
  （`{is_anchor, keyword, name, uid}`，词在 `keyword`、`name`/`uid` 是添加者）而不是字符串，
  原先按字符串解会把**非空**列表静默解析成空列表（界面上就是「明明配了屏蔽词却一片空白」）。
  **自禁言未通过**：`AddSilentUser`（自己、`hour=0`）被上游回 `100004 参数错误`，
  按纪律未换参数重试，故「禁言 / 解除」仍属未调通；`AddBlack` / `DelBlack` 一个请求都没发
  （用户明确排除）。协议依据 `docs/protocol.md` 附录 A36。

- **A36 写操作决定不验证（去查这件事的人不必再提）**：房管写操作（禁言 / 黑名单 / 屏蔽词增删）只有路径验证（空表单 `-111` CSRF）。曾有人提议用「只以自己为目标、`hour=0`」的方式实测，用户明确答复**不验**——任何验法都会动真实状态，用户选择接受未标注。判断标准由此固定：写操作在真机首次使用前一律按「按官方实现核对，未实测」对待，实现只做参数拼装与原样透传。

- **房管功能（issue #3）的接口位置全部找到**（从官方前端产物抠出，标注为「按官方实现核对」）：
  禁言 `AddSilentUser` / `DelSilentUser` / `GetSilentUserList`（社区文档只覆盖前两者）、
  直播间整体禁言档位 `RoomSilent` / `GetRoomSilent`、
  拉黑三件套 `v2/xbanned/banned/AddBlack` / `DelBlack` / `GetBlackList`、
  屏蔽词 `GetShieldKeywordList`（增删只见到 `BlockWords` 标识）。
  除禁言外参数细节未实测，实施时逐个用真实请求核对。


- **A35 结案：`upower_` 那一族的来源找到了**。它是主站「我的表情」面板——
  `GET https://api.bilibili.com/x/emote/user/panel/web?business=reply`（Cookie 认证），
  返回**用户名下拥有**的表情包（充电 / UP 主专属那类）。实测包「Kirikosama」20 个表情，
  表情 `text` 即完整名字 `[Kirikosama_吃瓜]`，图片 url 尾段与实测收到的那条完全一致
  → 唯一键 = `upower_` + `text`（主站表情对象没有 `emoticon_unique`，需自行拼装）。
  此前只能「从收到的弹幕里学」，现在可以整包列出。（`business=live` 返回 `-400`，只支持 reply/dynamic。）
- **房管接口的位置也定了**：禁言三件套在社区文档 `docs/live/silent_user_manage.md`
  （`AddSilentUser` / `GetSilentUserList` / `del_room_block_user`），均需 `csrf` = Cookie 的 `bili_jct`。

- **`unknown_cmd` 计数器被已知命令污染**：`ONLINE_RANK_V3`（protobuf 高能榜）在一次 40 秒观察里出现 43 条，
  却落进「未处理命令」计数——那个计数器是用来发现真的没归类过的命令的。连同
  `PLAYURL_RELOAD` / `PLAYURL_RELOAD_MASTER`（载荷只有 `room_id`/`playurl`/`reload_option`）一起归入
  「已知且无关」，判据是**载荷**而非命令名（`docs/protocol.md` 附录 A22）。
- 顺带更正文档里一处过时结论：`ONLINE_RANK_COUNT` / `SEND_GIFT_V2` 早已归位，却被记成「尚未归类」。

### Calibration

- **查官方前端产物两条结论（非流量实测，已按要求标注）**：
  1. 官方解析弹幕时用的表情槽位与字段名与本实现**逐一对应**
     （`emoticonOptions{bulgeDisplay,emoticonUnique,inPlayerArea,isDynamic,height,width,url}` ↔ `EmoteRef`），
     另有 `emoticons[content]` 兜底映射（实测未见）。`emoticon_id` = `emoticon_unique` 按 `_` 切分取末段。
  2. **官方没有任何"房管表情包"的身份分支**：唯一的权限判定 `emoticonDanmakuPermCheck` 只处理
     `identity === 4`（粉丝团）与 `1/2/3`（总督/提督/舰长）；全部「房管」命中都在禁言/拉黑/任命语境里。
     → 房管包只能靠**包级字段**区分，A26 仍需一个真有该包的房间。
- 否定结果一并记录，免得重复走：官方测试房间（`room_id` 5440）近 200 秒只有 2 条 `WATCHED_CHANGE`，
  其标题里的「PK 赏金周赛」是活动横幅而非房间本身在 PK；累计的桌面端日志里也**没有任何礼物命令**。
- **找到 PK 房间的办法**：直播首页推荐房间列表带 `pk_id` 字段，`0` = 没在 PK，非 0 = PK 中
  （拿它当筛子，给连线礼物那项指了条明路）。另：分区分页接口裸请求吃 `code=-352` 风控，
  扩样本必须走带 WBI 的客户端——已记入路线图，免得下次又硬扫。

- **A18（`color` / `mode` 合法域）部分结案**。用「`code=-400 请求错误` = 参数层就拒了 / 后置 code = 过了参数层」
  这个分界当探针，在公开测试房间 5440 实测：`color=0` **被参数层拒绝**（三次复现），
  而 `color=1` / `16777215` / `16777216` 与 `mode=0` / `4` / `6` **全部通过**参数层。
  即低边界 0 非法、上游对 `mode` 与高位 `color` 不做范围检查 → 客户端不必钳制，但不得送出 `color=0`。
  阻塞期间黑名单解开后补完：`color=16777216` 越界值 **`Ok` 投递成功**（上游不做范围校验）；
  `color=1` 收到时是 **`16777215`（白）**——上游对颜色做**可读性规范化**而非简单钳制。
  由此定下实现约束：客户端不必自行钳制 `color`/`mode`，但**不得送出 `color=0`**（唯一被参数层拒的取值）。
  另记：`code=0` + `msg="f"`（被平台吞）与颜色无关，白字也会被吞，属反垃圾噪声。
  CLI 的 `send` 顺带补了 `--mode`（此前写死 `None`，A18 想试模式值都试不了）。

### Fixed

- **大航海表情包被误归到「粉丝牌」**：`identity` 的语义没接对——我的分类器把 `identity ∈ 1..=4`
  一律当粉丝牌，而官方客户端的解锁文案映射写得很清楚：`identity === 4` 是「加入主播的粉丝团」，
  `identity` 1/2/3 是「开通主播的总督/提督/舰长」。现在只有大航海门槛的包会归入「大航海」。
  这条判据来自**官方自身的前端代码**，不需要样本。
  同时记录一个结构性发现：实测的「UP主大表情」包**同时含两类门槛**的表情，
  因此包级分类只是近似，「按身份分组」严格说应按表情级 `identity` 分组（A26 已注明）。

- **大航海播报此前几乎是空的**：`guard()` 只填了 uid 与昵称，`GUARD_BUY` / `USER_TOAST_MSG` 的
  等级、数量、价格、名称全被丢掉——而「徽标」与「礼物栏」都依赖这些字段。现按社区文档的字段表
  补全（`guard_level` / `num` / `price` / `gift_name` / `role_name` / `payflow_id`），
  角色名缺失时按文档的等级映射补（1 总督 / 2 提督 / 3 舰长）。V1 礼物 `SEND_GIFT` 同样按文档补齐。
  注意：这两个命令**仍无真实样本**（10 分钟巨型房间采集零条），字段来自权威文档而非实测，A8/A12/A13 已如实标注。

- **醒目留言（SC）的字段按实测修正**：此前 `superchat()` 是按文档猜的，只填了正文与 uid/uname。
  拿到真实样本后补齐并可核对：金额取 `price`（**单位是元**，样本 `30` 正是 SC 最低档）、
  `ts`（秒级）、`id`（SC 标识）、粉丝牌取 `medal_info`、房管标记取 `user_info.manager`。
  同一载荷的 `rate = 1000` 顺带给出了「1 元 = 1000 金瓜子」这个换算，坐实了礼物与 SC 的单位差异。

### Changed

- **关注列表接口核对完毕**（A28 结案）：实现用的 `roomid`/`uname`/`face`/`live_status` 全部命中官方文档；
  另确认参数 `hit_ab`（默认 true）会把 `online`/`short_id`/封面等置零，但这几项本实现不用，保持默认。
  **同时发现直播关注接口不提供「关注分组」**（新增 A34）：两个直播关注端点与官方页面产物里都没有该字段，
  疑在主站关注接口——分组功能的来源需要另行确认。

- **修正文档对游客态的假设**（已实测）：游客态**不会**掩码字段——`uid`、昵称、粉丝牌、举报标识
  与登录态同样完整，礼物照常下发。差异只在连接能力（认证包 `uid=0`、`key` 为空）。
  A3 与 A21 两行据此改写。

### Added

- **独立可运行的 release 产物**（交付形态）：`tauri build --no-bundle` 产出
  `target/release/danmubox-desktop`（约 13 MB），前端已内嵌——日志里页面加载的是
  `tauri://localhost`，因此不必再起 Vite dev server。构建步骤记入 `docs/operations.md` §1.3。
- **礼物连击聚合与金额排行**（需求 §2.7）：`SEND_GIFT_V2` 带来的 `batch_combo_id` 进 `Message.combo_id`，
  同一串连击在界面上折叠成一行（不受「合并相似消息」开关影响），折叠行的金额是整串总额；
  独立礼物栏顶部显示本场礼物总额与前 5 名排行。
- **礼物：接上 V2 礼物管线**（需求 §2.7）。有些直播间只发 `SEND_GIFT_V2`，此前完全不认识，
  等于「看不到礼物」。载荷是 base64 protobuf，字段名与 tag 抄自**官方前端产物里生成好的 proto
  代码**（包名 `bilibili.live.gift.v1`），映射见 `docs/protocol.md` §10.2。
  另确认 `UNIVERSAL_EVENT_GIFT(_V2)` = **连线礼物**（PK 连线时投喂，社区文档有载）。
- **多房间标签页**（需求 §2.8）：已添加房间多于一个时顶部显示标签页，点一下切换，标签带连接状态圆点。
  房间本来就能同时连接，这里只是补上切换入口。
- **快捷短语与颜文字**（需求 §2.2）：输入区「短语」按钮展开面板——内置颜文字为固定常量，
  自定义短语存偏好键 `composer.phrases`（契约 §8 的偏好键因此由 15 个变为 16 个），面板内可增删。
- **@某人与回复弹幕**（需求 §2.2）：行内动作 `@TA` 把昵称插进输入框并记住 uid，`回复` 显示引用条；
  发送时按官方载荷带上 `reply_mid` / `reply_uname` / `reply_type`，回复时另带 `replay_dmid`
  （**官方字段名就是这个拼写**，见 `protocol.md` §11.6）。
- **点昵称打开用户主页**（需求 §2.3）：新增 `open_url` 命令，桌面三端各用一条系统命令，
  刻意不引入 opener 插件；只接受 `http(s)` 链接。
- **关注列表按分组展示**（需求 §2.6）：组标题为「组名（条数）」，组名为空归入「未分组」，组内保持「直播中置顶」的相对顺序。
- **最近发送记录**（需求 §2.2）：会话内保留最近 8 条（去重、最新在前），草稿为空时显示，点一条填回输入框；发送失败的条目不记录。
- **人气值展示**：`op=3` 心跳回应与 `POPULARITY_CHANGE` 两路都进界面（引擎此前只写日志）。
  新增事件 `danmubox://popularity`，房间头部显示「人气 1063.1万」。实测房间 21987615 收到两路来源。
- **举报理由改为上游清单**：新增 `report_reasons`（`dMReport/ForReason`，实测 7 条 `{id, reason}`），
  界面从自由输入改为下拉。官方客户端同时上报 `reason` 文案与按文案反查出的 `reason_id`，
  手输的理由没有对应 id——这也是它此前必然报错的原因之一。

### Fixed

- **历史回填的弹幕不渲染表情**（用户实测）：历史条目的表情在顶层 `emoticon` 对象里，与实时弹幕的 `info[0][13]` **布局不同**，此前只处理了后者，回填进来的表情就只显示成表情名。现按接口文档的字段形状映射（`emoticon.url` 非空即为表情弹幕）并同样升级为 https。
- **发出去的表情变成了文字**（用户实测）：原先只把表情名当普通文本发送，上游不会渲染成表情。
  照官方实现改为：`msg = emoticon_unique`、`dm_type = 1`、附 `emoticonOptions`（字段名与取值来源见
  `docs/protocol.md` §11.4）。界面侧记住「点的是哪一个表情」，草稿被编辑后自动退回普通文本。
  附带修正一处错误假设：上游**不是**按内容识别表情（该假设已被实测否定）。
- **表情图片全都不显示，显示成一个问号**（面板与弹幕两处，同一个根因）：上游图片 CDN 有**防盗链**——来源不是 bilibili 时返回 403（本地页面的 `Referer` 同样被拒，不带 Referer 才放行）。浏览器拿到这个「不像图片的响应」后以 ORB（Opaque Response Blocking）拦掉，最终只剩一个问号，且**控制台与日志都没有任何线索**。修法：页面声明 `<meta name="referrer" content="no-referrer">`。实测：修复前面板 69 张图 0 张加载、全部 `ERR_BLOCKED_BY_ORB`；修复后 39/39 加载、全部 200。另把上游混用的 `http://` 地址统一升为 https（`danmubox-bili::asset::secure_url`）——实测两套地址返回同一张图，升级无损、顺带消除混合内容风险，**但它不是本次的根因**。
- **弹幕里的表情只显示名字**：`DANMU_MSG` 的表情信息在 `info[0][13]`（是对象时才有；非表情弹幕该槽位是字符串 `"{}"`），此前完全没解析。现带入 `Message.emote_url` 并画图。
- **上游 HTTP 心跳的传输层失败**：20 分钟真实长连中出现偶发 `error sending request`
  （同机 `curl` 连续 200，差异在连接复用——心跳间隔 60s 大于上游空闲连接存活时间，
  被回收的连接留在池里复用即失败）。处理：HTTP 客户端池内空闲上限降为 30s、
  传输层失败立即重试一次、失败计入 `heartbeat_failures` 计数并在 CLI 汇总可见。
  规范同步见 `docs/protocol.md` §8.2。
- 认证回应与认证包同帧头（`protover=1`）却只在非心跳分支处理 op=8，导致 `Connected`
  状态永不广播；已修正并补测试。
- `INTERACT_WORD_V2` 的 protobuf 载荷路径由 `data` 改为 **`data.pb`**：原先取错字段会
  base64 解出空字节，而空字节是合法的「全默认值 protobuf」，于是静默产出 `uid=0` 的假消息；
  现在载荷缺失/为空一律丢弃并计入 `malformed`。
- 计数类命令（`WATCHED_CHANGE` 等）此前每条都生成 `system` 消息塞进会话缓冲，违反
  `docs/protocol.md` §10.7 的「不写入会话缓冲」；现改为只更新计数。

- **登录态连不上弹幕服务器**：认证包恒发 `uid=0`，而 `key` 是用登录凭据换来的，
  上游握手后立刻 reset（实测 3/3，连正在直播的房间也一样，`packets: 0`）。改为登录态发真实 uid。
- **WS 拨号无超时且只用 `host_list` 首个节点**：一个不可达节点会让连接无限挂起。
  改为逐节点尝试 + 单节点 10s 超时。
- **打开房间即卡死**：`App.tsx` 每次渲染新建内联闭包传给 `RoomView`，命中其 `useEffect` 依赖，自激循环。
  改为在 `RoomView` 内直接取稳定的 store action。
- **桌面端白屏**：`tauri.conf.json` 的 `devUrl` 使窗口始终从 `http://localhost:5173` 加载，
  未起 Vite dev server 时就是空白窗口且无任何报错；判读方法记入 `docs/operations.md` §1.1。
- **电池余额、关注列表、表情包库三个适配器的端点与字段错误**（均以真实登录态实测校准，回填 A26 / A28 / A29）：
  电池余额端点真正是 `GET /xlive/revenue/v1/wallet/myWallet`（原四个候选路径实测全部 404），
  且上游不给「电池」，口径为 `电池 = data.gold / 100`；
  关注列表端点为 `GET /xlive/web-ucenter/v1/xfetter/GetWebList`，响应无 `has_more`；
  表情包库的 `platform` 必须是 `pc`（`web` 被上游拒为 500），显示文本在 `emoji` 字段（原实现读的 `text` 字段不存在）。
- **桌面端日志被 ANSI 颜色码污染**：进程由 PTY 拉起时 tracing 会着色，颜色码落进日志文件，
  让 `grep` 与解析失效；现已固定 `with_ansi(false)`。
- 代码里的文档引用错误：`filtering.ts` 的过滤与合并规则分别指向 `ui.md` §4.2 / §4.5，
  实际为 §8.1 / §8.4。

### Changed

- 界面不再展示人气值（`op=3` / `POPULARITY_CHANGE`），改为展示在线人数与累计看过；
  `Event::Popularity` 与 `Dispatch::Popularity` 随之删除，由 `Event::RoomStats { online, watched }` 取代。

- 需求来源变更：基线由选型讨论原文改为 [`REQUIREMENTS.md`](REQUIREMENTS.md)；选型讨论原文已归档到 `docs/.archive/`（不进 git），
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
- 契约 §4.3 的前提纠正：原文断言「B 站本身不提供弹幕历史回放接口」不成立——上游提供
  「最近 10+10 条」但**不可翻页**；结论（跨会话历史不落盘）不变。

### Removed

- **透明度功能（`ui.opacity`）**：用户反馈那一版实现方式不是预期，先删干净——
  偏好键、设置面板滑杆、列表容器的 `opacity` 样式、契约 §8 与派生文档条目一并移除；
  以后重做前先想清楚它作用在什么上（见 `docs/roadmap.md` §8.3）。写进 `prefs.json` 的残留键会被忽略。

- 删除数据库中台与本地 HTTP API 两份专项文档（对应章节本期未采纳），
  其适用契约并入 `docs/contract.md` 与架构文档；全部指向它们的链接已改指契约文档。
- 删除本地 HTTP 服务的决策记录（不再提供 API 实现）。
- 否决 Tauri + Python/Node sidecar 折中方案：会推高包体并引入额外的跨进程生命周期管理。
- 排除纯静态 PWA 方案：B 站 REST 接口受 CORS 限制，登录、签名与发弹幕都需要本地引擎。

### Changed

- **房间页按「一条纵向生长轴」重排**（issue #8，参照官方 web 直播栏）。之前的排法是：过滤条常驻一行、
  礼物栏在主区右侧抢走 240px 宽度、头部塞着刷新/断开/日志三个按钮、面板挤在输入框上面往上顶——
  结果是弹幕列表既被横向切走一块，又要和一堆控件抢纵向空间。现在自上而下固定为
  头部 → **弹幕列表（唯一的 flex-1 生长/滚动区）** → 弹出面板（向上展开）→ 输入区 → 礼物栏（可折叠），
  其余区域展开只会把列表挤短，**最新弹幕不被遮挡**：跟随模式下用 `ResizeObserver` 监听滚动容器，
  高度一变就重新贴底（`docs/ui.md` §2.3、§7.2）。
- **礼物栏从右侧竖栏改为输入区下方的全宽折叠条**：不再抢弹幕宽度，默认折叠（标题行给「礼物 / SC（N）」
  与本场瓜子合计），展开后独立滚动并给礼物排行。`ui.gift_panel_mode = separate` 时才存在（`docs/ui.md` §5）。
- **筛选收进弹出的「筛选」面板**，不再常驻占一行；面板分「消息类型 / 关键词 / 显示」三块，
  字号、时间戳、互动自动消失、系统通知、合并相似、礼物栏模式都在「显示」里（`docs/ui.md` §8.5）。
- **行内动作全部收进右键菜单**：复制内容 / 复制昵称 / ＠TA / 回复 / 屏蔽此用户 / 打开主页 / 举报。
  行里不再挂一排悬停按钮（它们随行宽抖动、也抢了正文宽度），行尾改成一个悬停出现的 `⋯` 作为
  可发现入口，点开的与右键弹出的是同一个菜单（`docs/ui.md` §4.5）。
- **头部瘦身**：只留返回 / 状态点 / 标题 / 连接状态文本 / 在线 / 看过 / 电池，刷新、断开、日志收进 `⋯` 菜单；
  电池只在头部显示一处，不再在输入区重复占位（`docs/ui.md` §3.1、§6.4）。
- **粉丝牌与身份徽标照官方聊天栏量得的形状重做**：45° 渐变胶囊、`1px` 同色系描边、固定宽度等级格、
  白字；尺寸改用 em 随 `ui.font_scale` 一起缩放（官方胶囊 15px 高 / 圆角 8px，见 `docs/ui.md` §4.2）。
  牌面颜色是**本地设计**（按牌名派生稳定色相）——官方的 `v2_medal_color_*` 没进契约，已在 §13 记为待校准项。

### Added

- **发言用户头像**（消费契约 §5 新增的 `Message.face`）：`face` 非空时在徽标左侧画圆形缩略图，
  空串**不渲染**（上游没给就没有这一列），加载失败退化成昵称首字符圆形占位。
- **时间戳显示开关**（`ui.show_timestamp`，默认 `false`）：打开后每行行首渲染 `HH:mm:ss`，
  列宽固定 `8ch` + `tabular-nums` + 右对齐，**逐行纵向对齐**（issue #8 的「弹幕前面的时间要对齐」）。
- **表情尺寸分级与字号联动**：正文里的表情 `1.65em`、大表情（`bulge_display`）`3.3em` + 4px 圆角；
  表情面板里通用 `1.5em`、**非通用（本房间 / 粉丝牌 / 大航海）`2.2em`**——那几族本来是大图，
  缩成通用那么大看不清。全部用 em，字号一改表情跟着变（`docs/ui.md` §4.1、§6.3）。
- **表情面板加搜索框**（`Emote.text` 子串匹配，无结果显示「没有匹配的表情」），补齐 `docs/ui.md` §6.3 早先写了但没做的一项。
- **关注列表展示未开播房间、按最后开播时间排序、分页**（需求 §2.11）：排序为
  「直播中置顶 → `live_start_at` 降序 → `online` 降序 → `room_id` 升序」，每页 30 条、>1 页给页码。
  `live_start_at` / `online` 是上游 `GetWebList` 实测存在的字段（`liveTime` 与 `live_time` 的关系见
  `docs/protocol.md` A28），已合入契约 §5；字段缺失时排序退化为「直播中置顶 + 房间号」。
- **房间列表页的账号区**（issue #1「已登录用户没法切换」）：账号下拉 + 扫码 + 登出之外，新增
  「新增账号」（输入名字 → `profiles_create` → 该 profile 成为当前 → **自动发起扫码**，因为扫码本来就是
  写进当前 profile，所以顺序是先建后扫）与「删除该账号」（`profiles_remove`；当前在用的不可删、
  只剩一个时不可删）。切换 / 扫码 / 新建 / 删除后的会话与关注列表统一走同一条善后逻辑（`docs/ui.md` §2.2）。

### Fixed

- **短语的增删改**（用户 2026-09-12「短语的增删界面逻辑修正一下」，看现有实现找出的两处不顺眼）：
  ① 删除按钮删的永远是「列表里最后一条」，无法对应到具体哪一条；改成在**短语上右键**弹出
  「编辑 / 删除」，编辑就是就地变成输入框。② 短语的 `title` 写着「右键删除」却根本没有右键处理，
  撞名时还会静默清空输入框；现在重复与空值都给出提示，新增改用独立的输入框 +「添加」按钮。
- **面板与短语的插入不再固定追加到末尾**：表情 / 短语 / 最近发言一律插到光标处，并把光标移到插入内容之后。
- **面板展开导致最新弹幕被挤出视口**（issue #8 末条）：跟随模式下容器高度变化后重新贴底，
  用无头冒烟做几何断言（新一行底边 ≤ 面板顶边，且滚动容器仍在底部）。
- 房间列表页的「关注」不再假装有分组：直播关注接口不给分组（`docs/protocol.md` A34），
  原先按 `group_name` 折叠出的一堆「未分组」只是噪音；现在按时间排成一列，`group_name` 有值才作为一项信息展示。

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
