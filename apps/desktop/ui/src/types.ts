// 与后端一致的类型定义（字段名保持 snake_case，见 docs/ipc.md §2）。

export type MessageKind =
  | "danmaku"
  | "gift"
  | "superchat"
  | "interact"
  | "guard"
  | "system";

export interface Message {
  local_id: number;
  room_id: number;
  kind: MessageKind;
  ts: number;
  uid: number;
  uname: string;
  content: string;
  color: number;
  medal_level: number;
  medal_name: string;
  /**
   * **这块粉丝牌该不该画**（契约 §5）：上游 `user.medal.is_light`（1 = 亮着）。
   *
   * 官方前端的弹幕行渲染分支就取它（`if (F?.is_lighted) { 追加粉丝牌 }`，`is_lighted`
   * 由 `medal.is_light` 派生 —— 2026-09-13 读官方产物取证）：**没点亮的牌官方不画**，
   * 上游连配色都给灰（实测 `#919298*`）。界面按同一判据过滤（`filtering.badgesFor`），
   * 否则会画出一块**别人都看不到**的牌。后端保证给这个字段；缺了按 `true`。
   */
  medal_lit: boolean;
  /**
   * 粉丝牌真彩色（契约 §5）：上游 `user.medal.v2_medal_color_*`，取值是带 alpha 的
   * CSS 十六进制串（如 `#3FB4F699`）。**空串不是颜色**——缺失时界面用按牌名派生的
   * 色相兜底（见 `filtering.medalColors`），不拿黑色顶替。
   */
  medal_color_start?: string;
  medal_color_end?: string;
  medal_color_border?: string;
  medal_color_text?: string;
  guard_level: number;
  /**
   * 发送者**粉丝牌自身**所属房间的舰长标记（契约 §5）：只用于牌面样式，
   * **不得**拿来画本房间的舰长标——那会把别的房间的身份按到本房间头上（用户 #12）。
   */
  medal_guard_level: number;
  /** 被回复者 uid；`0` = 这条不是回复（契约 §5）。 */
  reply_to_uid: number;
  /** 被回复者昵称；非回复为空串。 */
  reply_to_uname: string;
  /**
   * 被 @ 的昵称的颜色（契约 §5）：上游 `extra.reply_uname_color`，实测 `#FB7299`。
   * **界面不再消费它**（用户 2026-09-13 第 1 条：身份牌后那枚「回复 @某人」的牌子会与正文里
   * 自带的 @ 重复，已删；@ 改在正文里就地强调，配色取身份牌的字符色）。字段照旧带出，
   * 与 `Message.color` 一样只留在契约里。
   */
  reply_uname_color?: string;
  is_admin: boolean;
  /**
   * 发送者头像 URL（契约 §5 新增字段，无则空串）。
   * 界面按**可选**消费：引擎侧尚未落地时是 `undefined`，与空串同样处理（不渲染头像）。
   */
  face?: string;
  /** 进场回填的历史弹幕（上游 `data.room` 的最近 10 条，见 `history.rs` / 契约 §4.3），与实时弹幕区分展示。 */
  is_history: boolean;
  amount: number;
  /** 礼物连击标识；非连击类为空串（界面据此聚合）。 */
  combo_id: string;
  /** 表情弹幕的表情信息（渲染与「发回去」共用）；非表情弹幕为 null。 */
  emote?: EmoteRef | null;
  upstream_id: string;
  /**
   * **本地乐观行**的标记（UI 专用字段，后端不认识它）。**缺省 = 正常行**：既包括上游回播
   * 换进来的那条，也包括刚插入、还在等回执的本地行 —— 后者按用户 2026-09-13 的口径必须与
   * 「别的客户端看到的我」渲染逐项相同，因此不许用它表达「发送中」。
   * 只在发送没成时写上它：`unconfirmed`（结果未知）或 `rejected`（上游明确拒绝，
   * 正文划线并附 `send_reason`）—— 两档的差别见 `SendState`（`docs/ui.md` §4.4）。
   */
  send_state?: SendState;
  /**
   * 被上游拒绝的**原因**（UI 专用，只在 `send_state === "rejected"` 时有）：行尾标记原样显示它，
   * 与发送浮片（§6.5.1）是**同一句**（`sendOutcomeText`）—— 两者必须说的是同一件事。
   */
  send_reason?: string;
}

export interface Room {
  room_id: number;
  short_id: number;
  anchor_uid: number;
  /**
   * 主播昵称（契约 §5 `Room.anchor_uname`；上游 `getH5InfoByRoom` 的
   * `anchor_info.base_info.uname`——`getRoomPlayInfo` 里没有这个字段）。
   * 主界面用它**代替房间号**展示房间（#17 房间列表 / #18 标签条）；
   * 空串 = 上游没给，界面回落到 `title`、再回落到「房间 <号>」（不渲染空）。
   */
  anchor_uname: string;
  /** 直播间标题（上游 `getH5InfoByRoom` 的 `room_info.title`）；空串 = 上游没给。 */
  title: string;
  live_status: number;
}

export interface RoomView extends Room {
  connected: boolean;
  buffered: number;
}

export type ConnState = "connecting" | "connected" | "disconnected" | "error";

export interface EmoteRef {
  emoticon_unique: string;
  url: string;
  width: number;
  height: number;
  is_dynamic: boolean;
  in_player_area: boolean;
  bulge_display: boolean;
}

/** 扫码状态机的归一化取值（后端 `QrState`，serde 小写）。 */
export type QrState = "pending" | "scanned" | "confirmed" | "expired";

/**
 * 一个账号（契约 §5）：**一份具名凭据**，底层是 `config.toml` 里的一条 profile，
 * 界面与文档统一叫「账号」。**游客态不是账号**——没有凭据就没有条目。
 *
 * `logged_in` 与身份三件套由后端从凭据读出来：界面不必（也不能）自己从
 * `config.toml` 推断谁登录了。`active` 是「当前正在用的那一个」。
 */
export interface Account {
  name: string;
  nickname: string;
  uid: number;
  face: string;
  logged_in: boolean;
  active: boolean;
}

/** `account_qr_start` 的返回：二维码 + 本次扫码针对的账号（界面侧补记）。 */
export interface AccountQr {
  key: string;
  url: string;
  /** 二维码本体：SVG 源码（后端离线生成），界面包成 data URI 显示。 */
  svg: string;
  /**
   * 界面侧补记：`null` = 新增账号（后端按昵称自动命名）；字符串 = 给该账号重新登录。
   * 它只用于面板文案与成功提示，不参与后端协议（后端不认这个字段）。
   */
  target: string | null;
}

export interface AccountQrPoll {
  state: QrState;
  /** 确认后由后端落盘并返回的那个账号；未确认时为 `null`。 */
  account: Account | null;
}

export interface ReplyTarget {
  mid: number;
  uname: string;
  /** 被回复弹幕的上游 id；仅 @ 时为空串。 */
  dmid: string;
}

export interface ReportReason {
  id: number;
  reason: string;
}

/**
 * 本人在某个房间的身份（契约 §5 `RoomSession`）：会话级、不落盘。
 * 与 `Message.medal_level` 区分——那是**发送者**的牌，这是我**自己**在这个房间的牌。
 * 房间没有活跃会话时后端返回全零身份（不报错），界面按「还没有身份信息」处理。
 */
export interface RoomSession {
  room_id: number;
  my_medal_level: number;
  my_medal_name: string;
  /**
   * **我在这房间是否佩戴着粉丝牌**（契约 §5，上游 `data.medal.is_weared`）。
   *
   * 与 `my_medal_level` 是两回事：**持有 ≠ 佩戴** —— 实测某账号在该房间持有 Lv1 牌却
   * `is_weared = false`，官方因此不画它。发送时插的那条乐观行只有这里为 `true` 才画牌，
   * 否则会先多出一块"别人都看不到的牌"、回播到了又消失（用户 2026-09-13 报的正是这个）。
   */
  my_medal_worn: boolean;
  my_guard_level: number;
  is_admin: boolean;
  /**
   * **本房间的弹幕字数上限**（契约 §5，上游 `getInfoByUser` 的 `data.property.danmu.length`）：
   * 实测当前账号 × 8 个房间 = 40，官方前端缺省 20（`docs/protocol.md` A44）。
   * 输入区据此截断并显示 `已用/上限`；`0` = 还没取到身份，按缺省 20 处理。
   */
  danmaku_length: number;
}

/** 房管列表条目（契约 §5）：禁言名单与黑名单同形。 */
export interface AdminUser {
  uid: number;
  uname: string;
  face: string;
}

/**
 * 房管写操作的待确认对象（`docs/ui.md` §4.5 / §4.9）。
 * 这些操作会不可逆地影响他人，因此一律先出确认条，且文案要说清对象与时长。
 *
 * `batch` 是面板**批量模式**提交的一批**同类**动作（成员按屏幕上的顺序排列）：
 * 一次确认覆盖整批，执行时按序逐个 await、失败即停（`store.runAdmin`）。
 * 批量不新开一条执行通道 —— 它复用同一批成员动作，因此「确认文案 / 结果文案 / 上游调用」
 * 三处都只有一份口径。
 */
export type AdminAction =
  | { kind: "mute"; uid: number; uname: string; hour: number }
  | { kind: "unmute"; uid: number; uname: string }
  | { kind: "blacklist_add"; uid: number; uname: string }
  | { kind: "blacklist_del"; uid: number; uname: string }
  | { kind: "keyword_add"; word: string }
  | { kind: "keyword_del"; word: string }
  | { kind: "batch"; actions: AdminAction[] };

/** 禁言时长档（`admin_mute` 的 `hour`，契约 §7：-1 永久 / 0 本场 / 其余小时数）。 */
export const MUTE_HOURS: { hour: number; label: string }[] = [
  { hour: 0, label: "本场直播" },
  { hour: -1, label: "永久" },
  { hour: 1, label: "1 小时" },
  { hour: 6, label: "6 小时" },
  { hour: 24, label: "24 小时" },
];

export function muteHourLabel(hour: number): string {
  return MUTE_HOURS.find((item) => item.hour === hour)?.label ?? `${hour} 小时`;
}

/** 「谁」的统一写法：有昵称就带上，只有 uid 时只说 uid（黑名单加人只输 uid）。 */
function who(uname: string, uid: number): string {
  return uname.length > 0 ? `${uname}（uid ${uid}）` : `uid ${uid}`;
}

/** 一条动作的对象：人写「昵称（uid）」，词写「词」，批量（只会出现在文案的兜底分支）写条数。 */
function targetOf(action: AdminAction): string {
  switch (action.kind) {
    case "mute":
    case "unmute":
    case "blacklist_add":
    case "blacklist_del":
      return who(action.uname, action.uid);
    case "keyword_add":
    case "keyword_del":
      return `「${action.word}」`;
    case "batch":
      return `${action.actions.length} 项`;
  }
}

/** 批量条的动词（面板只会批量这三类，其余落到通用说法）：文案与动作同源，不各自写一遍。 */
function batchVerb(action: AdminAction): string {
  switch (action.kind) {
    case "unmute":
      return "解除禁言";
    case "blacklist_del":
      return "移出黑名单";
    case "keyword_del":
      return "删除屏蔽词";
    default:
      return "处理";
  }
}

/** 批量对象的名字串：只列前几个，多的折成省略号（确认条不该被一屏名字撑爆）。 */
function targetList(actions: AdminAction[], limit = 5): string {
  const names = actions.map(targetOf);
  return names.length <= limit
    ? names.join("、")
    : `${names.slice(0, limit).join("、")}…`;
}

/** 二次确认的文案（确认条上原样显示，说清对象与时长；批量必须含数量）。 */
export function adminActionText(action: AdminAction): string {
  switch (action.kind) {
    case "mute":
      return `禁言 ${who(action.uname, action.uid)} · 时长：${muteHourLabel(action.hour)}`;
    case "unmute":
      return `解除 ${who(action.uname, action.uid)} 的禁言`;
    case "blacklist_add":
      return `拉黑 ${who(action.uname, action.uid)}（会解除关系并禁止互动，比禁言重）`;
    case "blacklist_del":
      return `把 ${who(action.uname, action.uid)} 移出黑名单`;
    case "keyword_add":
      return `添加屏蔽词「${action.word}」`;
    case "keyword_del":
      return `删除屏蔽词「${action.word}」`;
    case "batch": {
      const first = action.actions[0];
      const verb = first === undefined ? "处理" : batchVerb(first);
      return `${verb} ${action.actions.length} 项：${targetList(action.actions)}`;
    }
  }
}

/** 确认按钮的文案（动词开头的短句）。 */
export const ADMIN_CONFIRM_LABEL: Record<AdminAction["kind"], string> = {
  mute: "确认禁言",
  unmute: "确认解除",
  blacklist_add: "确认拉黑",
  blacklist_del: "确认移出",
  keyword_add: "确认添加",
  keyword_del: "确认删除",
  batch: "确认批量",
};

/** 成功后的提示文案。 */
export function adminDoneText(action: AdminAction): string {
  switch (action.kind) {
    case "mute":
      return `已禁言 ${who(action.uname, action.uid)}（${muteHourLabel(action.hour)}）`;
    case "unmute":
      return `已解除 ${who(action.uname, action.uid)} 的禁言`;
    case "blacklist_add":
      return `已拉黑 ${who(action.uname, action.uid)}`;
    case "blacklist_del":
      return `已把 ${who(action.uname, action.uid)} 移出黑名单`;
    case "keyword_add":
      return `已添加屏蔽词「${action.word}」`;
    case "keyword_del":
      return `已删除屏蔽词「${action.word}」`;
    case "batch": {
      const first = action.actions[0];
      const verb = first === undefined ? "处理" : batchVerb(first);
      return `已${verb} ${action.actions.length} 项`;
    }
  }
}

export interface RoomStatsEvent {
  room_id: number;
  /** 在线人数（`ONLINE_RANK_COUNT` 的 `online_count`，协议 §10.7）；上游未给过为 null。 */
  online: number | null;
  /** 累计看过（`WATCHED_CHANGE` 的 `num`，协议 §10.7）；上游未给过为 null。 */
  watched: number | null;
}

export interface StatusEvent {
  room_id: number;
  state: ConnState;
  detail: string;
}

export type SendOutcome =
  | "ok"
  | "blocked_platform"
  | "blocked_room"
  | "rate_limited"
  | "medal_required"
  | "muted"
  | "failed";

export interface ChatSendResult {
  room_id: number;
  content: string;
  outcome: SendOutcome;
  /** 上游原始答复（非 ok 时）：原话 + code，见 docs/ui.md §6.5。 */
  detail?: string | null;
}

export interface SessionState {
  logged_in: boolean;
  uid: number;
  nickname: string;
  active_profile: string;
}

export interface AppInfo {
  version: string;
  data_dir: string;
  config_path: string;
  logged_in: boolean;
}

/**
 * 一键诊断：一次采集窗口（契约 §7 `diagnose_start`）。
 *
 * 两端都是 UTC 毫秒；界面按 `ends_ms` 倒计时，到点自动收工（`docs/ui.md` §3.6）。
 */
export interface DiagnoseStart {
  started_ms: number;
  ends_ms: number;
}

/**
 * 一键诊断的导出结果（契约 §7 `diagnose_export`）。
 *
 * `path` 是**给用户看的位置**：桌面端是 `~/Downloads/danmubox-diagnose-….txt`，
 * Android 是 `/sdcard/Download/danmubox-diagnose-….txt`。一次诊断只产生这一个文件。
 */
export interface DiagnoseExport {
  path: string;
  name: string;
  bytes: number;
  attempts: number;
  logs: number;
  started_ms: number | null;
  ends_ms: number | null;
}

export interface Prefs {
  "ui.font_scale": number;
  "ui.theme": "system" | "dark" | "light";
  "ui.auto_scroll": boolean;
  "ui.pause_on_hover": boolean;
  /**
   * 弹幕流里**是否包含**礼物 / SC / 大航海三类消息（契约 §8 新增的两枚布尔键之一）。
   * 与 `ui.gift_panel` 各管一头：这枚管弹幕流，那枚管独立礼物栏；两枚都开是默认形态，
   * 同一批礼物类消息因此两处都渲染（docs/ui.md §5）。
   */
  "ui.gift_in_danmaku": boolean;
  /** 是否显示输入区下方的**独立礼物栏**（契约 §8）。关掉它只是不画那一条，不影响弹幕流。 */
  "ui.gift_panel": boolean;
  /**
   * 礼物栏与弹幕区**共享上下分区**时礼物栏在不在上半（契约 §8，issue #8）。
   * `false`（默认）= 弹幕在上、礼物在下，与改前一致；换位入口 = 长按任一栏 0.5s 拖到另一栏松手。
   */
  "ui.gift_pane_on_top": boolean;
  /**
   * 礼物栏占共享分区高度的**份额**（契约 §8，0.10–0.90，默认 0.35）。
   * 与它在上面还是下面无关（换位不改比例）；落到像素时再被两栏最小高度夹一次
   * （礼物栏 ≥ 折叠头、弹幕区 ≥ 3 行），所以存的是指针意图而不是实测像素。
   */
  "ui.gift_pane_ratio": number;
  /**
   * **礼物栏**里把单个价值 ≤ 0.1 元的礼物合并成一条（契约 §8，默认 `false` = 一条一行不变）。
   * 只作用礼物栏：弹幕流的分支不受影响，SC / 大航海不在其列（docs/ui.md §5.3「低价礼物桶」）。
   */
  "ui.gift_collapse_cheap": boolean;
  /**
   * 把 ≤ 0.1 元的礼物从**折叠汇总 / 统计**里剔除（契约 §8，默认 `false` = 统计与展示一致）。
   * 只改统计口径：这些礼物作为消息的展示（礼物栏条目、弹幕流分支）不受影响。
   */
  "ui.gift_exclude_cheap_stats": boolean;
  /** 互动/进场消息显示一会儿后自动消失；关掉则常驻。 */
  "ui.interact_auto_hide": boolean;
  /** 弹幕行首时间戳显示开关（HH:mm:ss，本地时区）。 */
  "ui.show_timestamp": boolean;
  /** 自定义短语（需求 §2.2）；短语面板里唯一的内容来源，点选插到光标处。 */
  "composer.phrases": string[];
  "filter.uids": number[];
  "filter.kinds": MessageKind[];
  "filter.medal_level_min": number;
  /**
   * 会话缓冲的**各档上限**（契约 §4.3 / §8）。后端按 `kind` 分道裁剪、每道丢自己的最旧，
   * 界面不参与这件事 —— 这几枚键只经 `prefs_get` / `prefs_set` 往返，
   * 改动对**下一次进房**生效。
   */
  "history.buffer_rows_danmaku": number;
  /** 礼物档；档内再按金额切低 10% / 中 40% / 高 50%（价高的留得多，契约 §4.3）。 */
  "history.buffer_rows_gift": number;
  "history.buffer_rows_superchat": number;
  "history.buffer_rows_guard": number;
  /** 互动 / 进场档：刻意小于弹幕档。 */
  "history.buffer_rows_interact": number;
  /** 系统通知档：刻意小于弹幕档。 */
  "history.buffer_rows_system": number;
  /**
   * 各房间最近一次**打开**的时刻（键 = 房间号，值 = UTC 毫秒）。
   * 界面在 `openRoom` 时记一次，关注列表按它降序排（契约 §8，用户 #16）。
   */
  "ui.recent_watched": Record<string, number>;
}

export interface ApiError {
  code: string;
  message: string;
}

export type EmotePackage = "common" | "owned" | "room" | "medal" | "guard";

export interface EmoteToken {
  emoticon_unique: string;
  emoji: string;
  url: string;
  width: number;
  height: number;
  is_dynamic: boolean;
  in_player_area: boolean;
  bulge_display: boolean;
}

export interface Emote {
  key: string;
  /** 上游唯一键；发送表情弹幕时上游要的就是它（见 docs/protocol.md §11.4）。 */
  emoticon_unique: string;
  width: number;
  height: number;
  is_dynamic: boolean;
  in_player_area: boolean;
  bulge_display: boolean;
  package_kind: EmotePackage;
  text: string;
  url: string;
  room_id: number;
  /**
   * **当前身份用不了**这个表情（契约 §5 `Emote.locked`；上游按调用者身份当场算，
   * 因此换房间 / 换账号后要重新拉一次 `emotes_list`）。
   *
   * 界面只用它**置灰**（降视觉权重），不隐藏、不禁用：真正的闸门在上游发送侧。
   * **缺失即视为可用**——老后端不给这个字段时不能把整面板画灰。
   */
  locked?: boolean;
}

export interface FollowedRoom {
  room_id: number;
  uname: string;
  face: string;
  /** 直播间标题（上游 `GetWebList` 的 `title`）；空串 = 上游未给，界面不渲染该行。 */
  title: string;
  live_status: number;
  group_name: string;
  /**
   * 最后/本次开播的起始时间（上游 `GetWebList` 的 `liveTime`，Unix 秒；0/缺失 = 未知）。
   * 排序用（docs/ui.md §2.2、契约 §5）。刻意不叫 `live_time`——上游同名字段是「已开播秒数」。
   */
  live_start_at?: number;
  /** 人气/在线数（上游 `online`；缺失 = 未知）。 */
  online?: number;
}

export const EMOTE_PACKAGE_LABEL: Record<EmotePackage, string> = {
  common: "通用",
  owned: "我的表情",
  room: "本房间",
  medal: "粉丝牌",
  guard: "大航海",
};

/** 发送结果的用户可见文案（docs/ui.md §6.5）。 */
export const SEND_OUTCOME_TEXT: Record<SendOutcome, string> = {
  ok: "已发出",
  // 被吞这两档**把原因写进文案**（用户 2026-09-13：「被吞写明理由，如 发送失败 · 全局屏蔽词 /
  // 发送失败 · 房间屏蔽词」）。上游只给一个 `f` / `k` 标记（`protocol.md` §11.2），
  // 说清是哪一份词库由我们负责：「全局屏蔽词」= 平台那份，「房间屏蔽词」= 主播 / 房管在本直播间
  // 配的那份（就是房管面板第三块「屏蔽词」管的那张表）。
  blocked_platform: "发送失败 · 全局屏蔽词",
  blocked_room: "发送失败 · 房间屏蔽词",
  rate_limited: "发送过于频繁",
  medal_required: "粉丝牌等级不足",
  muted: "已被禁言",
  failed: "发送失败",
};

/**
 * 发送结果那句话 —— **浮片（§6.5.1）与行尾标记（§4.4）共用同一句**，两者必须说同一件事。
 * 「发送失败」这个前缀**由表里那句自带**（被吞那两档是「发送失败 · 原因」；`failed` 本身就是
 * 「发送失败」，所以这里不再统一加前缀，否则会拼成「发送失败：发送失败 · …」）。
 */
export function sendOutcomeText(outcome: SendOutcome, detail?: string | null): string {
  return `${SEND_OUTCOME_TEXT[outcome]}${detail ? ` · ${detail}` : ""}`;
}

export const KIND_LABEL: Record<MessageKind, string> = {
  danmaku: "弹幕",
  gift: "礼物",
  superchat: "SC",
  interact: "互动",
  guard: "大航海",
  system: "系统",
};

/**
 * 互动/进场消息自动消失前的停留时长（`ui.interact_auto_hide` 打开时）。
 * `store` 的摘除定时器与行的淡出动画共用这一个长度，两者不会错位。
 */
export const INTERACT_AUTO_HIDE_MS = 8000;

/**
 * 发送失败那条**浮动提示**从出现到消失的时长（含淡出）。
 * 淡出本身是 CSS 动画（`.toast` 的 `toastFade`），这里只决定动画时长与
 * 「什么时候把元素摘掉」同一个数 —— 两者错位就会出现「已经透明了还占着位置」。
 */
export const SEND_TOAST_MS = 2600;

/**
 * 本地行的标记（`Message.send_state`，UI 专用）—— 只在「发送没成」时出现：
 *
 * - `unconfirmed` —— **结果未知**：8 秒（`SEND_CONFIRM_TIMEOUT_MS`）没等到上游回播，或
 *   `chat_send` 在传输层就出错了（IPC 没回来）。这条**可能已经上屏了**（别的客户端看得到），
 *   只是我们没拿到证据 —— 所以行留着、不划线，尾上一枚「未确认」就是提醒
 *   （用户 2026-09-13：不要永远停在「发送中」）。
 * - `rejected` —— **上游明确拒绝**（`outcome != ok`，含被平台 / 直播间吞掉、被禁言、要粉丝牌、
 *   频率限制…）：这条别的客户端根本看不到。用户 2026-09-13 的口径是**留着它**——
 *   正文划线 + 行尾写上游给的原因（`Message.send_reason`），便于对照着改一条再发。
 *
 * 判定标准（用户原话）：「我在客户端发出去的弹幕，应该和我用别的客户端看它成功上屏时的样子一样」——
 * 所以这两种标记**都不弱化整行**（照旧读得清），也和「发送中」那种待确认视觉无关。
 */
export type SendState = "unconfirmed" | "rejected";

/** 标记的兜底文案（`rejected` 有原因时直接用原因，见 `Message.send_reason`）。 */
export const SEND_STATE_TEXT: Record<SendState, string> = {
  unconfirmed: "未确认",
  rejected: "发送失败",
};

/**
 * 等上游回推的上限：到点把那条标成**失败族**的「未确认」（不删，也不再假装它「发送中」）。
 *
 * 取值理由（2026-09-13 实测）：点击 → 我方请求往返 460.6ms（nav 133.5 + POST 326.9），
 * 上游把自己那条回推回来要 1.36s，界面出现自己那条合计约 1.82s。
 * **8s ≈ 实测回推延迟的 6 倍**：正常房间的排队抖动都在这以内，又短到不会让一条始终等不到
 * 回推的本地行长久无从分辨 —— 票据给的区间是 5–10s，取上限侧是为了别把慢房间误判成失败。
 */
export const SEND_CONFIRM_TIMEOUT_MS = 8000;

/**
 * 对账的时间窗：上游回播那条的 `ts` 与本地行的 `ts` 差超过它就不再认成同一条。
 * 一声发送对应一条回播，正常只差 1–2 秒；放宽到 60s 是为了容忍慢房间的排队，
 * 而「很久以前发过同样的话」不会被误认 —— 比的是两条消息**各自的 `ts`**，
 * 十分钟前那条与此刻的回播差着十分钟，压根出不了这个窗；
 * 此外对上过一次的行已由 `echoedLocals` 退出对账面（见 `store.matchPending`）。
 */
export const SEND_MATCH_WINDOW_MS = 60_000;
