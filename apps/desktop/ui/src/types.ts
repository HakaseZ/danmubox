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
  amount: number;
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
  "ui.opacity": number;
  "ui.theme": "system" | "dark" | "light";
  "ui.auto_scroll": boolean;
  "ui.pause_on_hover": boolean;
  "ui.merge_similar": boolean;
  "ui.merge_window_ms": number;
  "ui.gift_panel_mode": "merged" | "separate";
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

export type EmotePackage = "common" | "medal" | "guard" | "admin";

export interface Emote {
  key: string;
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
}

export const EMOTE_PACKAGE_LABEL: Record<EmotePackage, string> = {
  common: "通用",
  medal: "粉丝牌",
  guard: "大航海",
  admin: "房管",
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
