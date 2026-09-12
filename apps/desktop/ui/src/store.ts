// 应用状态。UI 只消费这里的数据，不直接调用后端（docs/ipc.md §5）。

import { create, type StoreApi } from "zustand";

import { api, describeError, subscribeEvents } from "./ipc";
import { INTERACT_AUTO_HIDE_MS } from "./types";
import type {
  AppInfo,
  ChatSendResult,
  EmoteToken,
  ReplyTarget,
  ReportReason,
  ConnState,
  Emote,
  FollowedRoom,
  Message,
  Prefs,
  RoomView,
  SendOutcome,
  QrLogin,
  QrState,
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
  /** 各房间最近一次的观众数（协议 §10.7）；上游还没给过的一侧为 undefined。 */
  roomStats: Record<number, { online?: number; watched?: number }>;
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
  send: (
    roomId: number,
    content: string,
    emote?: EmoteToken,
    reply?: ReplyTarget,
  ) => Promise<SendOutcome | undefined>;
  report: (message: Message, reason: ReportReason) => Promise<boolean>;
  /** 凭据文件里的 profiles（契约 §7）；切换后后端会用新凭据重连各房间。 */
  profiles: string[];
  /** 扫码登录：进行中的二维码（null 表示未在扫码）。 */
  qr: QrLogin | null;
  qrError: string | null;
  reportReasons: ReportReason[];
  loadReportReasons: () => Promise<void>;
  loadProfiles: () => Promise<void>;
  switchProfile: (name: string) => Promise<void>;
  /** 新建账号并切过去（需求 §2.1）；建好后用户接着扫码登录即可。 */
  createProfile: (name: string) => Promise<void>;
  /** 删除账号；后端改当前 profile 后要按新会话重拉房间与关注。 */
  removeProfile: (name: string) => Promise<void>;
  /** 会话变化后的统一善后（房间列表 / 关注列表跟着账号走）。 */
  applySession: (session: SessionState) => Promise<void>;
  logout: () => Promise<void>;
  startQrLogin: () => Promise<void>;
  cancelQrLogin: () => void;
  pollQrLogin: () => Promise<QrState | null>;
  /** 用系统浏览器打开用户主页（需求 §2.3：点昵称跳用户主页）。 */
  openProfile: (uid: number) => Promise<void>;
  /** 最近发送记录：仅会话内保留（需求 §2.2），不落盘。 */
  recentSends: string[];
  loadEmotes: (roomId: number) => Promise<void>;
  loadFollowed: () => Promise<void>;
  loadBalance: () => Promise<void>;
  updatePrefs: (patch: Partial<Prefs>) => Promise<void>;
  dismissError: () => void;
  setNotice: (notice?: string) => void;
}

let unsubscribe: (() => void) | undefined;

/**
 * 互动/进场消息自动消失的定时器（`ui.interact_auto_hide` 打开时）。
 * 房间切换或离开房间必须清掉：`local_id` 只在一次房内会话内唯一，
 * 残留的定时器会把另一个房间里同号的消息误删。
 */
let interactTimers: number[] = [];

function clearInteractTimers() {
  for (const timer of interactTimers) window.clearTimeout(timer);
  interactTimers = [];
}

/**
 * 到点把互动消息从列表里摘掉；同一时长已由 CSS 跑成淡出（见 MessageRow）。
 * `roomId` 记下来是为了防房间切换后误删：`local_id` 只在一次房内会话内唯一。
 */
function scheduleInteractHide(store: StoreApi<AppStore>, roomId: number, messages: Message[]) {
  const now = Date.now();
  for (const message of messages) {
    if (message.kind !== "interact") continue;
    const timer = window.setTimeout(
      () => {
        if (store.getState().activeRoomId !== roomId) return;
        store.setState((state) => ({
          messages: state.messages.filter((item) => item.local_id !== message.local_id),
        }));
      },
      Math.max(0, message.ts + INTERACT_AUTO_HIDE_MS - now),
    );
    interactTimers.push(timer);
  }
}

export const useApp = create<AppStore>((set, get, store) => ({
  rooms: [],
  messages: [],
  status: {},
  roomStats: {},
  logs: [],
  seeding: false,
  emotes: [],
  reportReasons: [],
  profiles: [],
  qr: null,
  qrError: null,
  recentSends: [],
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
      // 关注列表在会话就绪后自动拉一次（需求 §2.6 / docs/ui.md §2.2）：
      // 进房间列表就该看到关注里在播的房间，不该等用户去点「刷新」。
      // 失败仍走既有的错误条 + 保留「刷新」按钮，不静默。
      if (session.logged_in) void get().loadFollowed();

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
          if (get().prefs?.["ui.interact_auto_hide"]) {
            scheduleInteractHide(store, message.room_id, [message]);
          }
        },
        onRoomStats: (event) =>
          set((state) => {
            const previous = state.roomStats[event.room_id] ?? {};
            return {
              roomStats: {
                ...state.roomStats,
                [event.room_id]: {
                  online: event.online ?? previous.online,
                  watched: event.watched ?? previous.watched,
                },
              },
            };
          }),
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
      if (get().activeRoomId === roomId) {
        clearInteractTimers();
        set({ activeRoomId: undefined, messages: [] });
      }
      set({ rooms: await api.roomsList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async openRoom(roomId) {
    clearInteractTimers();
    set({ activeRoomId: roomId, messages: [], seeding: true });
    try {
      const history = await api.historyQuery(roomId, {
        limit: 0,
      });
      set({ messages: history });
      if (get().prefs?.["ui.interact_auto_hide"]) {
        scheduleInteractHide(store, roomId, history);
      }
      await get().connect(roomId);
    } catch (error) {
      set({ error: describeError(error) });
    } finally {
      set({ seeding: false });
    }
  },

  closeRoom() {
    clearInteractTimers();
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

  async send(roomId, content, emote, reply) {
    try {
      const result = await api.chatSend(roomId, content, emote, reply);
      // 会话内的最近发送记录：发出去才记，失败的草稿仍留在输入框里等重试。
      set((state) => ({
        lastSend: result,
        recentSends: [content, ...state.recentSends.filter((text) => text !== content)].slice(0, 8),
      }));
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
      return;
    }
    // 只有这个开关本身变了才动定时器：其它偏好改动不能顺手撤销已排好的摘除
    // （无头冒烟实测：拨一下「系统通知」就会让列表里的互动消息永久留下）。
    if (patch["ui.interact_auto_hide"] === undefined) return;
    clearInteractTimers();
    const roomId = get().activeRoomId;
    if (patch["ui.interact_auto_hide"] === true && roomId !== undefined) {
      scheduleInteractHide(store, roomId, get().messages);
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

  async openProfile(uid) {
    try {
      await api.openUrl(`https://space.bilibili.com/${uid}`);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async startQrLogin() {
    try {
      set({ qr: await api.sessionQrStart(), qrError: null });
    } catch (error) {
      set({ qrError: describeError(error) });
    }
  },

  cancelQrLogin() {
    set({ qr: null, qrError: null });
  },

  async pollQrLogin() {
    const qr = get().qr;
    if (!qr) return null;
    try {
      const { state, session } = await api.sessionQrPoll(qr.key);
      if (state === "confirmed") {
        // 后端在这一步已写盘并让房间重连，界面把会话/账号/房间/关注重新拉一遍。
        set({ qr: null, qrError: null, profiles: await api.profilesList() });
        await get().applySession(session);
      }
      return state;
    } catch (error) {
      set({ qrError: describeError(error) });
      return null;
    }
  },

  async loadProfiles() {
    try {
      set({ profiles: await api.profilesList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async applySession(session) {
    set({ session });
    set({ rooms: await api.roomsList() });
    // 关注跟着账号走：换了身份就按新身份重拉；未登录则清空，不留上一个人的列表。
    if (session.logged_in) void get().loadFollowed();
    else set({ followed: [] });
  },

  async switchProfile(name) {
    try {
      // 后端已让各房间用新凭据重连，这里把会话、房间与关注重新拉一遍。
      await get().applySession(await api.profilesSwitch(name));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async createProfile(name) {
    try {
      // 先建后扫：新 profile 建好即成为当前，接着走既有的扫码流程写入凭据（需求 §2.1）。
      await get().applySession(await api.profilesCreate(name));
      set({ profiles: await api.profilesList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async removeProfile(name) {
    try {
      await get().applySession(await api.profilesRemove(name));
      set({ profiles: await api.profilesList() });
      // 被删的可能正是当前 profile（后端会切到别个），二维码状态已无意义。
      set({ qr: null, qrError: null });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async logout() {
    try {
      await get().applySession(await api.sessionLogout());
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loadReportReasons() {
    // 上游固定 7 条，取一次就够；失败不覆盖已有清单。
    if (get().reportReasons.length > 0) return;
    try {
      set({ reportReasons: await api.reportReasons() });
    } catch (error) {
      set({ error: describeError(error) });
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
