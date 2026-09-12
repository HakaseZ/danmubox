// IPC 客户端：唯一一处直接接触 Tauri API 的地方（docs/ipc.md §6）。
// 后端命令与事件名见 docs/contract.md §7。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Account,
  AccountQr,
  AccountQrPoll,
  AdminUser,
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
  RoomSession,
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
  /**
   * 全部账号（契约 §7 `accounts_list`）：每个条目自带登录状态与身份（昵称 / uid / 头像），
   * 界面靠它渲染账号行，不再靠「自己数 config.toml 里有哪些名字」。
   */
  accountsList: () => call<Account[]>("accounts_list"),
  /** 切换当前账号（后端用新凭据重连各房间）。返回值不吃，切换后统一重拉状态。 */
  accountSwitch: (name: string) => call<SessionState>("account_switch", { name }),
  /**
   * 发起扫码：不带 `target` = 新增一个账号（名称由后端按昵称自动生成，重名加后缀）；
   * 带 `target` = 给该账号重新登录。
   */
  accountQrStart: (target?: string) =>
    call<AccountQr>("account_qr_start", target === undefined ? {} : { target }),
  accountQrPoll: (key: string) =>
    call<AccountQrPoll>("account_qr_poll", { key }),
  /** 手填 Cookie（需求 §2.5 的三种方式之一）；`name` 缺省时后端按昵称自动生成。 */
  accountLoginCookie: (cookie: string, name?: string) =>
    call<Account>(
      "account_login_cookie",
      name === undefined ? { cookie } : { cookie, name },
    ),
  /** 清掉某个账号的凭据（缺省 = 当前账号）；账号条目保留，`logged_in=false` = 退回游客态。 */
  accountLogout: (name?: string) =>
    call<SessionState>("account_logout", name === undefined ? {} : { name }),
  /** 删除账号条目。最后一个与错误情形由后端拦（`BAD_REQUEST` / `NOT_FOUND`）。 */
  accountRemove: (name: string) =>
    call<SessionState>("account_remove", { name }),

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
  /** 主站「我的表情」（契约 §7）：与房间无关，`package_kind="owned"`、`room_id=0`。 */
  emotesOwned: () => call<Emote[]>("emotes_owned"),

  /** 本人在该房间的身份（契约 §7）。房间没有活跃会话时返回全零身份而不是错误。 */
  roomSession: (roomId: number) => call<RoomSession>("room_session", { roomId }),

  // 房管（契约 §7）：只读列表用 call（失败要进日志），写操作用 invoke。
  // 权限判断走 `room_session` 的 `is_admin`，绝不「先点了再看上游错误码」。
  adminSilentList: (roomId: number) =>
    call<AdminUser[]>("admin_silent_list", { roomId }),
  adminBlacklistList: (roomId: number) =>
    call<AdminUser[]>("admin_blacklist_list", { roomId }),
  adminKeywordsList: (roomId: number) =>
    call<string[]>("admin_keywords_list", { roomId }),
  adminMute: (roomId: number, uid: number, hour: number, msg?: string) =>
    invoke<void>("admin_mute", { roomId, uid, hour, msg }),
  adminUnmute: (roomId: number, uid: number) =>
    invoke<void>("admin_unmute", { roomId, uid }),
  adminBlacklistAdd: (roomId: number, uid: number) =>
    invoke<void>("admin_blacklist_add", { roomId, uid }),
  adminBlacklistDel: (roomId: number, uid: number) =>
    invoke<void>("admin_blacklist_del", { roomId, uid }),
  adminKeywordsAdd: (roomId: number, words: string) =>
    invoke<void>("admin_keywords_add", { roomId, words }),
  adminKeywordsDel: (roomId: number, word: string) =>
    invoke<void>("admin_keywords_del", { roomId, word }),
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
  /**
   * 房内身份（`RoomSession`）。引擎把它与登录态**共用** `danmubox://session`
   * 事件名推出来，因此这里按判别字段分派（见下面的订阅实现）。
   */
  onRoomSession?: (session: RoomSession) => void;
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
  if (handlers.onSession || handlers.onRoomSession) {
    unlisteners.push(
      await listen<SessionState | RoomSession>("danmubox://session", (e) => {
        // 同一个事件名上有两种载荷：登录态 `SessionState`（带 `logged_in`）与
        // 房内身份 `RoomSession`（带 `is_admin`）。契约 §7 目前只登记了前者，
        // 身份那侧由引擎推、`ipc.md` 未记；这里按判别字段分派，绝不让身份载荷
        // 覆盖登录态（否则 `logged_in` 变 undefined，界面会误判成游客）。
        const payload = e.payload as Partial<SessionState & RoomSession>;
        if (typeof payload.logged_in === "boolean") {
          handlers.onSession?.(payload as SessionState);
        } else if (typeof payload.is_admin === "boolean") {
          handlers.onRoomSession?.(payload as RoomSession);
        }
      }),
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
