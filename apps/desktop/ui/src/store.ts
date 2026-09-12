// 应用状态。UI 只消费这里的数据，不直接调用后端（docs/ipc.md §5）。

import { create } from "zustand";

import { api, describeError, subscribeEvents } from "./ipc";
import type {
  AppInfo,
  ChatSendResult,
  ConnState,
  Emote,
  FollowedRoom,
  Message,
  Prefs,
  RoomView,
  SendOutcome,
  SessionState,
} from "./types";

/** 前端只保留的显示上限；真正的会话缓冲在后端（docs/contract.md §4.3）。 */
const CLIENT_MESSAGE_CAP = 2000;
const LOG_CAP = 200;

interface AppStore {
  info?: AppInfo;
  session?: SessionState;
  rooms: RoomView[];
  activeRoomId?: number;
  messages: Message[];
  status: Record<number, { state: ConnState; detail: string }>;
  prefs?: Prefs;
  logs: string[];
  lastSend?: ChatSendResult;
  error?: string;
  notice?: string;
  seeding: boolean;

  emotes: Emote[];
  followed: FollowedRoom[];
  balance?: number;

  bootstrap: () => Promise<void>;
  addRoom: (input: string) => Promise<void>;
  removeRoom: (roomId: number) => Promise<void>;
  openRoom: (roomId: number) => Promise<void>;
  closeRoom: () => void;
  connect: (roomId: number) => Promise<void>;
  disconnect: (roomId: number) => Promise<void>;
  refresh: (roomId: number) => Promise<void>;
  send: (roomId: number, content: string) => Promise<SendOutcome | undefined>;
  report: (message: Message, reason: string) => Promise<boolean>;
  loadEmotes: (roomId: number) => Promise<void>;
  loadFollowed: () => Promise<void>;
  loadBalance: () => Promise<void>;
  updatePrefs: (patch: Partial<Prefs>) => Promise<void>;
  dismissError: () => void;
  setNotice: (notice?: string) => void;
}

let unsubscribe: (() => void) | undefined;

export const useApp = create<AppStore>((set, get) => ({
  rooms: [],
  messages: [],
  status: {},
  logs: [],
  seeding: false,
  emotes: [],
  followed: [],

  async bootstrap() {
    try {
      const [info, session, rooms, prefs] = await Promise.all([
        api.appInfo(),
        api.sessionStatus(),
        api.roomsList(),
        api.prefsGet(),
      ]);
      set({ info, session, rooms, prefs });

      unsubscribe?.();
      unsubscribe = await subscribeEvents({
        onMessage: (message) => {
          if (message.room_id !== get().activeRoomId) return;
          const current = get().messages;
          // `local_id` 是会话内的单调序号（契约 §5）。进场时我们会用 `history_query`
          // 整批覆盖一次，其间到达的事件可能已经包含在那批快照里；此外运行时若被
          // 重建，序号会从头开始。两种情况下都只能接受「比现有末尾更新」的消息，
          // 否则同一 local_id 会进列表两次（React 会报重复 key，渲染也会错乱）。
          const last = current.length > 0 ? current[current.length - 1].local_id : 0;
          if (message.local_id !== 0 && message.local_id <= last) return;
          const messages = [...current, message];
          if (messages.length > CLIENT_MESSAGE_CAP) {
            messages.splice(0, messages.length - CLIENT_MESSAGE_CAP);
          }
          set({ messages });
        },
        onStatus: (status) =>
          set((state) => ({
            status: {
              ...state.status,
              [status.room_id]: { state: status.state, detail: status.detail },
            },
          })),
        onRoom: (room) =>
          set((state) => ({
            rooms: state.rooms.map((item) =>
              item.room_id === room.room_id ? { ...item, ...room } : item,
            ),
          })),
        onSession: (session) => set({ session }),
        onSend: (lastSend) => set({ lastSend }),
        onLog: (line) => {
          const logs = [...get().logs, line];
          if (logs.length > LOG_CAP) logs.splice(0, logs.length - LOG_CAP);
          set({ logs });
        },
      });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async addRoom(input) {
    try {
      const room = await api.roomsAdd(input);
      const rooms = await api.roomsList();
      set({ rooms });
      await get().openRoom(room.room_id);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async removeRoom(roomId) {
    try {
      await api.roomsRemove(roomId);
      if (get().activeRoomId === roomId) set({ activeRoomId: undefined, messages: [] });
      set({ rooms: await api.roomsList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async openRoom(roomId) {
    set({ activeRoomId: roomId, messages: [], seeding: true });
    try {
      const history = await api.historyQuery(roomId, {
        limit: 0,
      });
      set({ messages: history });
      await get().connect(roomId);
    } catch (error) {
      set({ error: describeError(error) });
    } finally {
      set({ seeding: false });
    }
  },

  closeRoom() {
    set({ activeRoomId: undefined, messages: [] });
  },

  async connect(roomId) {
    try {
      await api.roomsConnect(roomId);
      set({ rooms: await api.roomsList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async disconnect(roomId) {
    try {
      await api.roomsDisconnect(roomId);
      set({ rooms: await api.roomsList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refresh(roomId) {
    try {
      await api.roomsReconnect(roomId);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async send(roomId, content) {
    try {
      const result = await api.chatSend(roomId, content);
      set({ lastSend: result });
      return result.outcome;
    } catch (error) {
      set({ error: describeError(error) });
      return undefined;
    }
  },

  async updatePrefs(patch) {
    try {
      set({ prefs: await api.prefsSet(patch) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  setNotice(notice) {
    set({ notice });
  },

  async report(message, reason) {
    try {
      await api.chatReport(message, reason);
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async loadEmotes(roomId) {
    try {
      set({ emotes: await api.emotesList(roomId) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loadFollowed() {
    try {
      set({ followed: await api.followList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loadBalance() {
    try {
      set({ balance: await api.walletBalance() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  dismissError() {
    set({ error: undefined });
  },
}));
