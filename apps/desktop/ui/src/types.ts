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
  is_admin: boolean;
  /**
   * 发送者头像 URL（契约 §5 新增字段，无则空串）。
   * 界面按**可选**消费：引擎侧尚未落地时是 `undefined`，与空串同样处理（不渲染头像）。
   */
  face?: string;
  /** 进场回填的历史弹幕（上游最近 10+10 条），与实时弹幕区分展示。 */
  is_history: boolean;
  amount: number;
  /** 礼物连击标识；非连击类为空串（界面据此聚合）。 */
  combo_id: string;
  /** 表情弹幕的表情信息（渲染与「发回去」共用）；非表情弹幕为 null。 */
  emote?: EmoteRef | null;
  upstream_id: string;
}

export interface Room {
  room_id: number;
  short_id: number;
  anchor_uid: number;
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
  my_guard_level: number;
  is_admin: boolean;
}

/** 房管列表条目（契约 §5）：禁言名单与黑名单同形。 */
export interface AdminUser {
  uid: number;
  uname: string;
  face: string;
}

/**
 * 房管写操作的待确认对象（`docs/ui.md` §4.5 / §6.6）。
 * 这些操作会不可逆地影响他人，因此一律先出确认条，且文案要说清对象与时长。
 */
export type AdminAction =
  | { kind: "mute"; uid: number; uname: string; hour: number }
  | { kind: "unmute"; uid: number; uname: string }
  | { kind: "blacklist_add"; uid: number; uname: string }
  | { kind: "blacklist_del"; uid: number; uname: string }
  | { kind: "keyword_add"; word: string }
  | { kind: "keyword_del"; word: string };

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

/** 二次确认的文案（确认条上原样显示，说清对象与时长）。 */
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

export interface Prefs {
  "ui.font_scale": number;
  "ui.theme": "system" | "dark" | "light";
  "ui.auto_scroll": boolean;
  "ui.pause_on_hover": boolean;
  "ui.merge_similar": boolean;
  "ui.merge_window_ms": number;
  "ui.gift_panel_mode": "merged" | "separate";
  /** 互动/进场消息显示一会儿后自动消失；关掉则常驻。 */
  "ui.interact_auto_hide": boolean;
  /** 系统通知（开播 / 下播 / 标题变更 / 公告）显示开关。 */
  "ui.system_notice": boolean;
  /** 弹幕行首时间戳显示开关（HH:mm:ss，本地时区）。 */
  "ui.show_timestamp": boolean;
  /** 自定义短语（需求 §2.2）；颜文字是内置常量，不占偏好键。 */
  "composer.phrases": string[];
  "filter.keywords": string[];
  "filter.keywords_mode": "hide" | "only";
  "filter.keywords_alert": boolean;
  "filter.uids": number[];
  "filter.kinds": MessageKind[];
  "filter.medal_level_min": number;
  "history.buffer_rows": number;
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
}

export interface FollowedRoom {
  room_id: number;
  uname: string;
  face: string;
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
  blocked_platform: "被平台风控吞掉",
  blocked_room: "被直播间吞掉",
  rate_limited: "发送过于频繁",
  medal_required: "粉丝牌等级不足",
  muted: "已被禁言",
  failed: "发送失败",
};

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
