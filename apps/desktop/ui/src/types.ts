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
  guard_level: number;
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

export interface QrLogin {
  key: string;
  url: string;
  /** 二维码本体：SVG 源码（后端离线生成），界面包成 data URI 显示。 */
  svg: string;
}

export interface QrPoll {
  state: QrState;
  session: SessionState;
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

export type EmotePackage = "common" | "room" | "medal" | "guard";

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
