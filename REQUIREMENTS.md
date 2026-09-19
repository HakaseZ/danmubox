# danmubox 需求基线

| 项 | 值 |
|---|---|
| 项目 | danmubox（弹幕框） |
| 包标识 | `dev.kksk.danmubox` |
| 状态 | 本期范围已确认，无待定项，可进入实现 |
| 最近更新 | 2026-09-19 |

## 1. 目标

复刻 ac站官方直播间的聊天框，**不解码视频**，自用不发布，覆盖 macOS / Windows / 安卓三端。

## 2. 本期功能需求

### 2.1 看弹幕

- 显示弹幕、礼物、醒目留言（SuperChat）、进场与互动提示、大航海与系统通知 — 落点 `contract.md` §5
- 开播 / 下播 / 标题变更 / 分区变更 — 落点 `contract.md` §5、`protocol.md` §10.7
- 开播下播时状态要能自动更新：**打开的房间实时更新状态，列表定期查询状态**（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4、§7 `rooms_refresh_status`
- 房间观众数展示**两个值**：**在线人数**与**累计看过**；人气值不再展示，那个参数官方也没实现（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `RoomStats`
- 每条消息展示发送者头像与昵称；上游没给头像就不渲染头像列（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `Message.face`
- SC 和礼物要有用户头像；大航海同理，但大航海不是漏读、是上游不给（用户反馈已落地，见 CHANGELOG）— 落点 `protocol.md` §10.2 / §10.3 / A12
- SC 的样式仿官方 SC 的样式（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5「金额单位」、`protocol.md` 附录 A.2
- 历史 10 条记录前面混入了本地的本人发言记录：**仅保留历史记录**（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4.3、`protocol.md` A30
- 历史记录与实时记录存在割裂，**保持显示效果的一致性**，不提示「以上为历史记录」（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `is_history`
- 互动（进场消息）**显示一会儿就自动消失**，只有常开才一直显示（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.interact_auto_hide`
- 系统通知（开播 / 下播 / 标题变更 / 公告）默认**关闭**，勾上「系统」才显示（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `filter.kinds`
- 弹幕里的文字表情（`[dog]` 这类）要画出来：正文整条就是一个 token 的已修，token 夹在句中的仍按原文显示（部分落地，见 CHANGELOG）— 落点 `contract.md` §5 `Message.emote`、`protocol.md` A42
- 弹幕里要看得见 @ 关系：正文里的 `@昵称` 就地高亮（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `reply_to_uid`
- 不同的观众短时间内刷**同一个弹幕**时做聚合（**至少两位不同 uid** 才成立）（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4、`aggregate.ts`

### 2.2 发弹幕

- 发送弹幕 — 落点 `contract.md` §3 `DanmakuSender`
- 表情包库：**按用户身份加载**（通用 / 粉丝牌 / 大航海；**房管没有表情分类**），另有本房间专属与主站「我的表情」两组可发 — 落点 `contract.md` §5 `Emote`、`protocol.md` A26
- 表情界面仿官方实现，**使用 tab，不要使用按钮**；通用的表情全部超出边框很丑，要落在格子里（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/Composer.tsx`
- 表情菜单栏里，通用表情以外的表情要变大一点，好看清楚；字号要同步调整表情的尺寸（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/Composer.tsx`
- 主站的表情要能选择到（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `Emote.package_kind=owned`
- @某人 / 回复某条弹幕 — 落点 `protocol.md` §11.6
- @ 某人后文本框里会有 `@xxx`，**删掉这个后发的弹幕不该再 @**；另外弹幕里要看得到 @ 关系（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/Composer.tsx`（`mentionTarget`）、`contract.md` §5 `reply_to_uid`
- 弹幕字数有上限，在输入框限制 & 提示一下，免得发出去才发现超长了（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `danmaku_length`、`protocol.md` A44
- 开中文输入法输入英文时按回车选词，**不得**把弹幕直接发出去（macOS / Windows）（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/Composer.tsx`（`composingRef`）
- 发送失败的原因提示：全局禁言、直播间禁言、粉丝牌等级不足、频率限制（另有其他失败的原样原因）— 落点 `contract.md` §5 `SendOutcome`
- 输入草稿：按「身份 × 房间」各留一份，**会话内**保留（不落盘；失败时草稿保留便于重试）（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4.3
- 自定义短语（「快捷短语」面板的内容来源，用户自建），短语的增删界面逻辑要修正（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `composer.phrases`
- 电池余额 — 落点 `contract.md` §3 `WalletProvider`、`protocol.md` A29

### 2.3 身份与徽标

- 徽标：主播 / 房管 / 舰长 / 提督 / 总督 — 落点 `contract.md` §5
- 能看到房管身份 — 落点 `contract.md` §5 `is_admin`、`protocol.md` A5
- 能看到当前直播间的粉丝牌等级 — 落点 `contract.md` §5 `RoomSession.my_medal_level`
- 参照官方实现优化粉丝牌与身份标识的显示效果，加入发言用户头像，加入时间戳显示开关（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `Message.face`、§8 `ui.show_timestamp`
- 舰长标和本房间的舰长不完全一样（其他房间的舰长也有舰长标）：**只看「本房间」的舰长身份**（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `guard_level` / `medal_guard_level`、`protocol.md` A39
- 点昵称跳用户主页（跳转浏览器）— 落点 `contract.md` §7 `open_url`

### 2.4 举报

- 举报弹幕，行为与官方一致；理由从上游的固定清单里选 — 落点 `contract.md` §3 `DanmakuReporter`、§7 `report_reasons`、`protocol.md` A27

### 2.5 登录与账号

- 两种方式：游客、扫码；**扫码是唯一的登录入口**（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4.1
- Cookie 存进配置文件；启动时本地已有 Cookie 则直接读取（手工编辑该文件不在界面能力范围内）— 落点 `contract.md` §4.1
- Cookie 失效时提示重登；扫码换号 — 落点 `contract.md` §7 `account_qr_start` / `account_qr_poll`
- 多账号：**单个配置文件内多 profiles**，可切换 — 落点 `contract.md` §4.1
- 已登录的用户要能直接切换身份（凭证在后台），不要只能重登（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §7 `account_switch`
- 用户直接点击切换，不要那个专门的「切换」按钮（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AccountManager.tsx`
- 账号面板改为直接点击头像所在的那个圆角长方形就能进入，不需要独立的「账号」按钮（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AccountManager.tsx`
- 添加账号按钮居中；展开的二维码卡片宽度和间距与上方元素保持一致（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AccountManager.tsx`
- 账号管理里的关闭按钮去掉，这个按钮用不上（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AccountManager.tsx`
- 切换用户也要做隔离：切号后上一个身份的界面状态一律清掉（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §7 `account_switch`、`store.resetIdentityState`

### 2.6 房间与关注

- 房间号 / 短链解析为真实房间 — 落点 `contract.md` §7 `rooms_add`、`protocol.md` §2.1
- 登录后能看到**所有**关注的直播间（含未开播），**正在直播的置顶**，其余按**最近观看**的顺序降序排列（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5、§8 `ui.recent_watched`
- 关注的未开播也展示出来，按最后开播的时间排序，分页展示（部分落地，见 CHANGELOG）— 落点 `protocol.md` A28；未开播条目上游不给最后开播时间，那一档仍按在线人数 / 房间号排
- 关注列表在会话就绪后**自动加载**，不需要用户手动点刷新；失败时保留「刷新」按钮与错误提示（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §7 `follow_list`
- 关注分组；可从关注列表直接进场 — 落点 `contract.md` §5 `FollowedRoom.group_name`、`protocol.md` A34
- 房间内「刷新」按钮：长连接卡住或推流暂时中断时手动重连 — 落点 `contract.md` §7 `rooms_reconnect`、`protocol.md` §14
- 连接的房间列表不展示房间号，仅展示「主播 · 直播间名」（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `Room.anchor_uname`、`protocol.md` A41
- tab 不展示房间号，展示主播名（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5 `Room.anchor_uname`

### 2.7 礼物

- 能看到礼物事件 — 落点 `contract.md` §5
- 礼物栏显示方式改成**两个选项：1. 弹幕包含礼物 2. 独立礼物栏**，**默认都有**（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.gift_in_danmaku` / `ui.gift_panel`
- 礼物栏独立滚动 — 落点 `contract.md` §8
- 独立礼物栏每个礼物 / SC / 大航海一条，不要「金额一条、内容详情一条」；SC 和大航海也要统计金额（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5、`filtering.amountText`
- 礼物金额统计：礼物栏折叠头按 kind 分组汇总（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5、`filtering.giftStatRows`
- SC 在礼物区域显示不全；礼物区域的显示和弹幕区直接保持一致（一样的布局、一样的背景颜色、一样的自动滚动）（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/MessageRow.tsx`
- 礼物 / 大航海的单位按**元**（1 元 = 1000 金瓜子；先前写的「电池」已作废）（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5「金额单位」
- 舰长金额按**真实金额**统计：不要 198 原价与 138 / 168 实付折后价各统计一次（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5、`protocol.md` A12 / A13
- 连击聚合展示 — 落点 `contract.md` §5、`filtering.toDisplayRows`
- 独立礼物栏与弹幕内容区**共享同一个区域**，中间由分割条上下隔开，可以拖动分割条调整分割比例；长按某一区域可以开启拖动，拖到另一个区域上可以互相调换上下的位置（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.gift_pane_on_top` / `ui.gift_pane_ratio`
- 辅助功能增加一个**折叠低价礼物**（单个价值小于等于 0.1）的选项（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.gift_collapse_cheap`
- 辅助功能增加一个**剔除低价礼物统计**（单个价值小于等于 0.1）的选项（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.gift_exclude_cheap_stats`
- 折叠低价礼物和剔除低价礼物统计对 **2 个区域都生效**；所有剔除、折叠、隐藏、自动消失**都不会丢掉相应内容**，把开关关掉后要能恢复原样（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8「不丢内容（硬口径）」、§4.3

### 2.8 展示与过滤

- 主题（深色 / 浅色 / 跟随系统）；字号缩放 — 落点 `contract.md` §8 `ui.theme` / `ui.font_scale`
- 主题切换模仿安卓或 iOS 的日月按钮，分**亮、暗、自动**三态，是按钮非滑块（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.theme`
- 切换跟随系统暗色还是亮色的功能放在主界面「弹幕框」右边，全局切换（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.theme`、`apps/desktop/ui/src/components/RoomList.tsx`
- 字号只控制弹幕区，不改变面板区的字号（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.font_scale`
- 时间戳显示开关：默认关闭，可开关；显示时放在最右边（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.show_timestamp`
- 弹幕正文统一按主题前景色渲染，不照上游自定义颜色（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §5
- 过滤：按消息 **kind**、**uid**（屏蔽某用户）、**粉丝牌最低等级**筛选 — 落点 `contract.md` §8 `filter.*`
- 筛选里的「系统」和「系统通知」两项是重复的，只留「系统」（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `filter.kinds`
- 「消息类型」改成**左右两排勾选**的形式，不要按钮形式（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `filter.kinds`、`apps/desktop/ui/src/components/FilterBar.tsx`
- 时间戳、互动消息自动消失、弹幕包含礼物、独立礼物栏在筛选面板里作为**辅助功能**项，同消息类型一样是两排勾选（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8 `ui.show_timestamp` / `ui.interact_auto_hide` / `ui.gift_in_danmaku` / `ui.gift_panel`
- 「辅助功能」和「消息类型」这两个标题要更醒目（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/FilterBar.tsx`、`app.module.css`（`.filterSection h3`）
- 多房间标签页 — 落点 `contract.md` §7 `rooms_*`
- 顶部 tab 滚动的时候不要有滑块，会挡住标签（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`.tabs`）

### 2.9 数据

- 只保留**单次房内会话**的弹幕：进房间算一次，退出到房间列表再进即刷新；不落盘，进程退出即丢 — 落点 `contract.md` §4.3
- 礼物、弹幕、互动（进场消息）、系统通知**分开做缓存**，互动和系统通知存少一点，礼物分级缓存、价值越高权重越高（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4.3、§8 `history.buffer_rows_*`
- 超管发了提示走的是 `NOTICE_MSG`（当系统消息、受「消息类型」门控）；真正那条 `WARNING` 未归一化，落进 `unknown_cmd`（用户反馈已落地，见 CHANGELOG）— 落点 `protocol.md` §10.7 / §10.8

### 2.10 房管

- 房管功能要有界面：加黑名单、拦截词那些（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §7 `admin_*`、`protocol.md` A36
- 有房管身份才能有房管界面的选项（参照官方 web 的实现方式）（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §7、`protocol.md` A38
- 连接到有房管权限的直播间时就把房管数据加载好（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomView.tsx`
- 「你是本直播间房管」和「刷新」都不需要，打开界面时静默刷新（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AdminPanel.tsx`
- 房管对他人消息的写操作：禁言（含时长）/ 解除禁言、拉黑 / 移出黑名单、增删屏蔽词，均需二次确认，非房管时入口置灰（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §7 `admin_*`
- 移除黑名单、删除等功能设一个**批量处理键**，单点处理绑在右键（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AdminPanel.tsx`、`ContextMenu.tsx`
- 房管界面整体布局：禁言、黑名单、屏蔽词分**三个 tab**（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AdminPanel.tsx`
- 房管面板里各 tab 不需要展示数量（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AdminPanel.tsx`
- 房管面板里 tab 右侧仅留关闭，用 X 号不用文字（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AdminPanel.tsx`
- 房管面板批量按钮挪到下面的层级，与输入框和添加按钮全部置顶，重新设计排布格式，不要竖着排版（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/AdminPanel.tsx`
- 我同时可以打开房管面板和下面三个面板，这有点太影响布局了：**同时只允许打开一个面板**（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomView.tsx`
- 房管面板报 `upstream error: 响应解析失败: error decoding response body（UPSTREAM_ERROR）`：要能看出是哪个端点、什么状态、什么内容（用户反馈已落地，见 CHANGELOG）— 落点 `protocol.md` A45

### 2.11 界面与布局

- 主界面**竖屏模式**：第一排左对齐头像、主播名，右对齐直播状态；第二排左对齐直播标题，右对齐最后开播时间；**不要房间号**（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomList.tsx`
- 主界面**宽屏模式**：第一排左对齐头像、主播名、直播标题，右对齐直播状态、最后开播时间；**不要房间号**（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomList.tsx`
- 宽屏一排展示的内容按同一规则在窄屏下分成 2 排（或者一开始就做成 2 排）；拆分断点 520px，窄屏可达面 360px（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`.followItem`）
- 筛选功能全部列到展开菜单中（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/FilterBar.tsx`
- 很多可以放到右键的逻辑（举报、@、短语的增删等）尽量放到右键菜单里（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/ContextMenu.tsx`
- 弹幕前面的时间要对齐（宽度一致）（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`--time-col`）
- 下方菜单展开时，自动把弹幕区域往上弹，不要挡住最新的弹幕（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomView.tsx`
- 短语和筛选顶部的提示和关闭也删掉，展开高度看齐表情界面（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`--panel-h`）
- 筛选与布局 & 快捷短语界面重新做布局，要清晰整洁，同时兼顾竖屏和宽屏 2 种视觉效果（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/FilterBar.tsx`、`Composer.tsx`
- 有一些提示可以不用写（例如「游客态不登录也能收弹幕；发送需要登录。三种方式：扫码（默认）、手填 Cookie、退出登录（回到游客态）。」这是写需求时给的案例，不必写在产物程序里），全局检查还有没有类似的，能删就删（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/Composer.tsx`、`AccountManager.tsx`
- 不同 tab 中的界面要做隔离：**切换了 tab 界面也要重新打开**，而不是开着界面切换（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomView.tsx`
- 回到最新图标改为下箭头（返回键旋转 90°）；后来整个按钮删掉，改用一个返回按钮旋转 90° 的圆形图标钮代替（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`.bottomAnchor`）
- 弹幕页 tab 多一个**拖动左右排序**和**左右滚动**，开多了不要全挤在一起（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/App.tsx`
- 在安卓上实际操作，tab 和礼物 / 弹幕区域拖动的功能有问题：拖动这个交互要按触摸改对（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §8、`apps/desktop/ui/src/components/SplitPanes.tsx`
- 在弹幕区域双击能够**收起标题栏和输入框**（包括下方的表情等 & 上方的 tab），仅保留弹幕区和礼物区（如果开启了的话），这种状态下上下翻动弹幕（礼物）不受影响；再次双击后可以恢复标题栏和输入框的显示（沉浸模式，减少遮挡）（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/RoomView.tsx`
- 安卓打开系统键盘、输入框避让系统键盘时，向上滑动弹幕列表**不得**让整个应用界面向上滑动，顶部标题栏不得滑到界面以外（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- 选中某条弹幕时，底色**从界面最左一直到最右**（现在卡在头像上不好看）（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`--select-wash`）
- SC 的高亮框**仅显示在内容部分**，也就是用户名、身份牌下面的区域（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/components/MessageRow.tsx`（`db-msg-sc-card`）
- 分割独立礼物栏的那个横折叠区域弄点横线或者虚线之类的，2 个区间要有边界（用户反馈已落地，见 CHANGELOG）— 落点 `apps/desktop/ui/src/app.module.css`（`--fold-line`）

### 2.12 连接、保活与诊断

- 部分账号连接进**自己的**直播间无法看到任何消息内容（这些账号在浏览器里能正常加载弹幕）。从三个方向排查：逆向官方网页版弹幕（如果这个方案能解决，**以此为准**）、参考作者 fork 的 `bilibili-API-collect` 与 `bilibili-api`、再在互联网上搜有没有相关案例（部分落地，见 CHANGELOG）— 落点 `protocol.md` A46
- 安卓端有没有后台保活机制？（有用户反馈说「好像不會後台自動運行和讀取彈幕」）（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §2（Android 例外）
- 确认当前的后台有没有能力挂 **7×24 小时**（所有端）；此外安卓端实测会丢弹幕（挂在后台一段时间后唤起到前台，最新的一部分弹幕看不到，不知道什么时候丢的、也不知道为什么丢）：先给原因（用户反馈已落地，见 CHANGELOG）— 落点 `protocol.md` §13.2
- 安卓端切换网络环境好像会断连、之后无法快速自动恢复连接（也有可能和放在后台有关）：确认一下（用户反馈已落地，见 CHANGELOG）— 落点 `protocol.md` §13.2
- 全面检查之前的日志，看看有没有业务逻辑上的问题；日志里不得出现自身 `vmid` 与关注的人 `uids[]`（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §4 `DANMUBOX_LOG`

### 2.13 已删除（不做什么）

| 不做 | 说明 / 落点 |
|---|---|
| 透明度调节 | 原实现非预期，先删掉放待办（已删除，见 CHANGELOG）— `contract.md` §8 已无该键；重做前先明确它作用在什么上，见 `roadmap.md` §2.3 |
| 关键词过滤与命中告警 | 用不上（已删除，见 CHANGELOG）— `contract.md` §8 已无 `filter.keywords*` 三键 |
| 手填 Cookie | 现在的登录方式（游客 / 扫码）很合理，不做导入入口（已删除，见 CHANGELOG）— `contract.md` §4.1 |
| 短语里的内置颜文字 | 短语只留用户自建的条目（已删除，见 CHANGELOG）— `contract.md` §8 `composer.phrases` |
| 文本框上方的「将发送 xxx」预览 | 没有这个需求（已删除，见 CHANGELOG）— `apps/desktop/ui/src/components/Composer.tsx` |
| 「最近发言 / 最近发送记录」面板 | 整条链路已删，输入区只留草稿与自定义短语（已删除，见 CHANGELOG）— `contract.md` §4.3 |

## 3. 架构约束

- ac站 API 不可控，可能有后期的逆向需求：这部分代码必须**完全分离**，后续修改不影响核心业务逻辑 — 落点 `contract.md` §3、`architecture.md` §3

## 4. 非目标（本期明确不做）

| 项 | 说明 |
|---|---|
| 视频流解码 | 只消费弹幕协议，界面里没有播放器 |
| iOS 端、Fold8 / 折叠屏适配 | 后期 enhancement（折叠屏只做可行性研究，不做实现） |
| 本地数据库 / 历史落盘 | 见 §2.9，弹幕只在内存中保留 |
| 弹幕回看、导出 | 不做 |
| 词云 | 下期，非核心 |
| AI 原生接口 | 本期置空。想法：后期接入 MCP，让 Agent 直接消费弹幕数据；架构上保持兼容能力即可 |
| 推送 | 不做 |
| 后台保活 | **桌面端**：前台运行（关窗即退出）。**Android 例外**：退到后台且仍有活跃房间连接时起一枚常驻通知的前台服务，回前台即停（用户反馈已落地，见 CHANGELOG）— 落点 `contract.md` §2 |
| 应用商店发布 | 自用产物 |

## 5. 参考与外部输入

| 项 | 说明 |
|---|---|
| 协议实现参考 | 作者 GitHub 上连接并解析 ac站直播数据包的项目（Go 与 Python 各一） |
| 协议参考库 | 作者 fork 的 `bilibili-API-collect` 与 `bilibili-api` |
| 被吞弹幕判定 | [哔哩哔哩直播 被吞弹幕标记](https://update.greasyfork.org/scripts/453468/Bilibili%20Live%20Banned%20Danmaku%20Marker.user.js) |
| 包标识 | 由 `dev.zack.danmubox` 改为 `dev.kksk.danmubox` |
