// IPC 客户端：唯一一处直接接触 Tauri API 的地方（docs/ipc.md §6）。
// 后端命令与事件名见 docs/contract.md §7。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  QrLogin,
  QrPoll,
  ApiError,
  AppInfo,
  ChatSendResult,
  Emote,
  EmoteToken,
  FollowedRoom,
  Message,
  RoomStatsEvent,
  ReportReason,
  ReplyTarget,
  Prefs,
  Room,
  RoomView,
  SendOutcome,
  SessionState,
  StatusEvent,
} from "./types";

function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error
  );
}

/** 把后端的错误模型转成人类可读文案，同时保留 code 供调用方判断。 */
export function describeError(error: unknown): string {
  if (isApiError(error)) return `${error.message}（${error.code}）`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface HistoryQuery {
  limit?: number;
  after?: number;
  before?: number;
  kinds?: string[];
  uid?: number;
  q?: string;
}

/** IPC 唯一入口：失败时把命令名与错误码打到控制台（经日志桥进入 Rust 日志）。 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    console.error(`IPC ${command} 失败: ${describeError(error)}`);
    throw error;
  }
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  sessionStatus: () => call<SessionState>("session_status"),
  profilesList: () => call<string[]>("profiles_list"),
  profilesSwitch: (name: string) => call<SessionState>("profiles_switch", { name }),
  /** 新建账号（多账号并存，需求 §2.1）：建好后该 profile 即为当前，接着走既有的扫码登录。 */
  profilesCreate: (name: string) =>
    call<SessionState>("profiles_create", { name }),
  /** 删除账号；当前在用的与最后一个由界面拦住，不发给后端。 */
  profilesRemove: (name: string) =>
    call<SessionState>("profiles_remove", { name }),
  sessionLogout: () => call<SessionState>("session_logout"),
  sessionQrStart: () => call<QrLogin>("session_qr_start"),
  sessionQrPoll: (key: string) => call<QrPoll>("session_qr_poll", { key }),

  roomsList: () => call<RoomView[]>("rooms_list"),
  roomsAdd: (input: string) => call<RoomView>("rooms_add", { input }),
  roomsRemove: (roomId: number) =>
    invoke<void>("rooms_remove", { roomId }),
  roomsConnect: (roomId: number) => call<void>("rooms_connect", { roomId }),
  roomsDisconnect: (roomId: number) =>
    invoke<void>("rooms_disconnect", { roomId }),
  /** 房间内「刷新」：立即重连，不清空已收弹幕。 */
  roomsReconnect: (roomId: number) =>
    invoke<void>("rooms_reconnect", { roomId }),

  historyQuery: (roomId: number, query: HistoryQuery = {}) =>
    invoke<Message[]>("history_query", { roomId, query }),

  chatSend: (
    roomId: number,
    content: string,
    emote?: EmoteToken,
    reply?: ReplyTarget,
    color?: number,
  ) => invoke<ChatSendResult>("chat_send", { roomId, content, emote, reply, color }),

  /** 用系统浏览器打开链接（点昵称跳主页）。 */
  openUrl: (url: string) => call<void>("open_url", { url }),

  /** 举报一条弹幕。理由取值尚未实测，先按不透明字符串传递。 */
  chatReport: (message: Message, reason: ReportReason) =>
    invoke<void>("chat_report", { message, reason }),
  reportReasons: () => call<ReportReason[]>("report_reasons"),

  emotesList: (roomId: number) => call<Emote[]>("emotes_list", { roomId }),
  followList: () => call<FollowedRoom[]>("follow_list"),
  walletBalance: () => call<number>("wallet_balance"),

  prefsGet: () => call<Prefs>("prefs_get"),
  prefsSet: (patch: Partial<Prefs>) => call<Prefs>("prefs_set", { patch }),
};

export interface EventHandlers {
  onMessage?: (message: Message) => void;
  onStatus?: (status: StatusEvent) => void;
  onRoomStats?: (event: RoomStatsEvent) => void;
  onRoom?: (room: Room) => void;
  onSession?: (session: SessionState) => void;
  onSend?: (result: ChatSendResult) => void;
  onLog?: (line: string) => void;
}

/** 订阅全部后端事件；返回取消订阅函数。 */
export async function subscribeEvents(
  handlers: EventHandlers,
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  if (handlers.onMessage) {
    unlisteners.push(
      await listen<Message>("danmubox://message", (e) =>
        handlers.onMessage!(e.payload),
      ),
    );
  }
  if (handlers.onStatus) {
    unlisteners.push(
      await listen<StatusEvent>("danmubox://status", (e) =>
        handlers.onStatus!(e.payload),
      ),
    );
  }
  if (handlers.onRoomStats) {
    unlisteners.push(
      await listen<RoomStatsEvent>("danmubox://room_stats", (e) =>
        handlers.onRoomStats!(e.payload),
      ),
    );
  }
  if (handlers.onRoom) {
    unlisteners.push(
      await listen<Room>("danmubox://room", (e) => handlers.onRoom!(e.payload)),
    );
  }
  if (handlers.onSession) {
    unlisteners.push(
      await listen<SessionState>("danmubox://session", (e) =>
        handlers.onSession!(e.payload),
      ),
    );
  }
  if (handlers.onSend) {
    unlisteners.push(
      await listen<ChatSendResult>("danmubox://send", (e) =>
        handlers.onSend!(e.payload),
      ),
    );
  }
  if (handlers.onLog) {
    unlisteners.push(
      await listen<string>("danmubox://log", (e) => handlers.onLog!(e.payload)),
    );
  }
  return () => unlisteners.forEach((off) => off());
}

export type { SendOutcome };
