// IPC 客户端：唯一一处直接接触 Tauri API 的地方（docs/ipc.md §6）。
// 后端命令与事件名见 docs/contract.md §7。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  ApiError,
  AppInfo,
  ChatSendResult,
  Emote,
  FollowedRoom,
  Message,
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

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  sessionStatus: () => invoke<SessionState>("session_status"),

  roomsList: () => invoke<RoomView[]>("rooms_list"),
  roomsAdd: (input: string) => invoke<RoomView>("rooms_add", { input }),
  roomsRemove: (roomId: number) =>
    invoke<void>("rooms_remove", { roomId }),
  roomsConnect: (roomId: number) => invoke<void>("rooms_connect", { roomId }),
  roomsDisconnect: (roomId: number) =>
    invoke<void>("rooms_disconnect", { roomId }),
  /** 房间内「刷新」：立即重连，不清空已收弹幕。 */
  roomsReconnect: (roomId: number) =>
    invoke<void>("rooms_reconnect", { roomId }),

  historyQuery: (roomId: number, query: HistoryQuery = {}) =>
    invoke<Message[]>("history_query", { roomId, query }),

  chatSend: (roomId: number, content: string, color?: number) =>
    invoke<ChatSendResult>("chat_send", { roomId, content, color }),

  /** 举报一条弹幕。理由取值尚未实测，先按不透明字符串传递。 */
  chatReport: (message: Message, reason: string) =>
    invoke<void>("chat_report", { message, reason }),

  emotesList: (roomId: number) => invoke<Emote[]>("emotes_list", { roomId }),
  followList: () => invoke<FollowedRoom[]>("follow_list"),
  walletBalance: () => invoke<number>("wallet_balance"),

  prefsGet: () => invoke<Prefs>("prefs_get"),
  prefsSet: (patch: Partial<Prefs>) => invoke<Prefs>("prefs_set", { patch }),
};

export interface EventHandlers {
  onMessage?: (message: Message) => void;
  onStatus?: (status: StatusEvent) => void;
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
