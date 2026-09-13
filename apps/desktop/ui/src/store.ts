// 应用状态。UI 只消费这里的数据，不直接调用后端（docs/ipc.md §5）。

import { create, type StoreApi } from "zustand";

import { api, describeError, subscribeEvents } from "./ipc";
import { adminDoneText, INTERACT_AUTO_HIDE_MS, SEND_CONFIRM_TIMEOUT_MS, SEND_MATCH_WINDOW_MS } from "./types";
import type {
  Account,
  AccountQr,
  AdminAction,
  AdminUser,
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
  RoomSession,
  RoomView,
  SendOutcome,
  QrState,
  SessionState,
} from "./types";
// 值导入（上面那一组是 `import type`）：发送结果那句话在这里拼，行尾标记与浮片共用同一句。
import { sendOutcomeText } from "./types";

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
  /** 主站「我的表情」（`emotes_owned`）：与房间无关，选中器里排在「通用」之后。 */
  ownedEmotes: Emote[];
  /** 「我的表情」是否已尝试拉取过（成功后不再打扰上游）。 */
  ownedLoaded: boolean;
  /** 「我的表情」上一次拉取失败的原因；成功后清空（面板里给可重试提示）。 */
  ownedError?: string;
  followed: FollowedRoom[];
  balance?: number;

  /** 各房间的本人身份（`room_session` 快照，随后由 `danmubox://session` 事件更新）。 */
  roomIdentities: Record<number, RoomSession>;
  /** 房管面板三块数据（会话级：离开房间即清空）。 */
  adminSilent: AdminUser[];
  adminBlacklist: AdminUser[];
  adminKeywords: string[];
  /** 三块列表各自的读取错误：原样 code + message，失败不静默（contract §7）。 */
  adminErrors: { silent?: string; blacklist?: string; keywords?: string };
  /** 房管写操作进行中（按钮禁用，避免并发重复提交）。 */
  adminBusy: boolean;

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
  /**
   * 全部账号（契约 §7 `accounts_list`）：每个条目自带登录状态与身份。
   * 界面拿它渲染「当前身份」与账号管理对话框，不再自己数 config.toml 里的名字。
   */
  accounts: Account[];
  /**
   * 进行中的扫码（`account_qr_start` 的返回 + 界面侧记的 `target`）。
   * `null` = 没在扫；`qrError` 有值而它为 `null` = 上一次发起失败，面板据此给重试。
   */
  qr: AccountQr | null;
  qrState: QrState | null;
  qrError: string | null;
  reportReasons: ReportReason[];
  loadReportReasons: () => Promise<void>;
  /** 重拉账号列表（登录态事件、扫码确认、增删改之后都要）。 */
  loadAccounts: () => Promise<void>;
  /** 切换当前账号；切换后会话、房间与关注都要按新凭据重来。 */
  switchAccount: (name: string) => Promise<void>;
  /** 删除账号条目；删当前项时后端会自动切走，界面只负责重新拉状态。 */
  removeAccount: (name: string) => Promise<void>;
  /** 清掉某账号的凭据（缺省 = 当前账号）：该账号退回未登录，界面回到游客态。 */
  logoutAccount: (name?: string) => Promise<void>;
  /** 手填 Cookie 登录（需求 §2.5）；成功返回 true。凭据值只进这一次调用，不落任何界面状态。 */
  loginCookie: (cookie: string, name?: string) => Promise<boolean>;
  /** 会话变化后的统一善后（房间列表 / 关注列表跟着账号走）。 */
  applySession: (session: SessionState) => Promise<void>;
  /**
   * 账号或登录态变化后的统一善后：重拉 `session_status` + `accounts_list`，
   * 再按新会话重拉房间与关注。**不吃** `account_*` 的返回值——以重拉的结果为准，
   * 免得把某个命令的返回形状当成事实来源。
   */
  refreshIdentity: () => Promise<void>;
  /** 发起扫码：不带 `target` = 新增账号（后端按昵称自动命名）；带 = 给该账号重新登录。 */
  startAccountQr: (target?: string) => Promise<void>;
  cancelAccountQr: () => void;
  /** 轮询一次扫码状态；返回归一化状态，确认时顺手完成落盘后的界面善后。 */
  pollAccountQr: () => Promise<QrState | null>;
  /** 用系统浏览器打开用户主页（需求 §2.3：点昵称跳用户主页）。 */
  openProfile: (uid: number) => Promise<void>;
  loadEmotes: (roomId: number) => Promise<void>;
  /**
   * 拉主站「我的表情」。`retryFailedOnly` 为 true 时只在**上次失败**后才重试
   * （表情面板打开时用），避免每次开面板都打一次上游。
   */
  loadOwnedEmotes: (retryFailedOnly?: boolean) => Promise<void>;
  loadFollowed: () => Promise<void>;
  loadBalance: () => Promise<void>;
  /** 读该房间的本人身份（进房时一次；之后靠事件更新）。 */
  loadRoomIdentity: (roomId: number) => Promise<void>;
  /** 读房管三块列表：只读，无权限也放行，错误原样展示。 */
  loadAdmin: (roomId: number) => Promise<void>;
  /** 执行一次房管写操作；调用方负责二次确认。成功返回 true。 */
  runAdmin: (roomId: number, action: AdminAction) => Promise<boolean>;
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
 * 本地待确认行（乐观渲染）的 `local_id` 序号：取**负数**（`-1`、`-2`、…），
 * 负号就是「本地生成」这个前缀。真实 `local_id` 由后端按会话单调分配、恒为正，
 * 因此两者永不碰撞：React key 不会重、`onMessage` 的单调判定也不会被带偏
 * （负数只出现在列表末尾，真实号永远比它大）。
 */
let pendingSeq = 0;

/** 待确认行的超时兜底定时器（键 = 本地行的 `local_id`）。 */
const sendTimers = new Map<number, number>();

/**
 * 已经被上游回播**对上的**本地行（`local_id`）。本地行不再被替换成上游那条
 * （见 `onMessage`：那一帧就是最终形态），因此它会一直留在列表里；不给它退场标记的话，
 * 同一正文连发两条时第二条的回播会被**第一条**再次吸走（取列表里最靠前的那条），
 * 第二条于是白等 8 秒被判「未确认」。改前这层语义是天然成立的 —— 命中之后那条被
 * 上游那条替换、`local_id` 转正，自己就退出了对账面；现在把它放到列表**之外**：
 * 行上一个字段都不写，退场只记在这张侧表里。
 * `pendingSeq` 进程内单调递增、号不复用，因此键永不冲突；退房时随缓冲一起清掉。
 */
const echoedLocals = new Set<number>();

/** 摘掉一条待确认行的定时器（回播确认 / 判失败 / 离开房间都要）。 */
function clearSendTimer(localId: number) {
  const timer = sendTimers.get(localId);
  if (timer !== undefined) window.clearTimeout(timer);
  sendTimers.delete(localId);
}

/**
 * 离开房间（返回列表 / 关标签 / 移除房间）时把两类定时器一起清掉。
 * 待确认行随 `messages` 一起清空（契约 §4.3：缓冲的生命周期 = 一次房内会话），
 * 残留的超时回调只会对着另一个房间的同号消息空转。
 *
 * **拨偏好不走这里**：`updatePrefs` 里动 `ui.interact_auto_hide` 只该重排互动消息的定时器，
 * 顺手清掉发送定时器会让那条永远停在「无状态」—— 超时兜底也就永远不会到点。
 */
function clearRoomTimers() {
  clearInteractTimers();
  for (const timer of sendTimers.values()) window.clearTimeout(timer);
  sendTimers.clear();
  // 本地行随 `messages` 一起清空（契约 §4.3：缓冲的生命周期 = 一次房内会话），
  // 侧表里的退场标记没有行可指了，一并清掉。
  echoedLocals.clear();
}

/** 追加一条并守住前端显示上限（真正的会话缓冲在后端，docs/contract.md §4.3）。 */
function appended(messages: Message[], message: Message): Message[] {
  const next = [...messages, message];
  if (next.length > CLIENT_MESSAGE_CAP) {
    next.splice(0, next.length - CLIENT_MESSAGE_CAP);
  }
  return next;
}

/**
 * 对账：这条上游回推是不是我们刚发、还在等确认的那条？返回它在列表里的下标（没命中 = -1）。
 *
 * 三条依据（`docs/ui.md` §4.4）：**uid + 正文 + 时间窗**。
 * - `uid`：回推那条的 uid 要与本地行相同 —— 也就是「这是我们自己那条」。收包侧拿不到
 *   客户端关联 id（2026-09-13 实测：收包 `extra` 里没有发送时用的 `replay_dmid`），
 *   而 uid 是上游给的、别人顶不了，这就是**不会认错**的根据；
 * - 正文：逐字相同。表情弹幕两侧都带 `emote` 时再比 `emoticon_unique`；上游那条没带
 *   表情字段就只比正文 —— 宁可多认一条自己的，也不要把回推漏成第二条；
 * - 时间窗：`SEND_MATCH_WINDOW_MS` 以内（`ts` 之差取绝对值）。
 *
 * 命中多条时取**列表里最靠前**的那条：连发两条同样内容时按先来后到一一对上。
 * 参与范围 = **本地行（`local_id` 为负，见 `insertPending`）且还没对上过** ——
 * `rejected` 那条上游已明确拒绝，不会有回播；`unconfirmed` 仍参与（回播迟到也算收到）；
 * 已经对上过的（`echoedLocals`）出局，否则第二条的回播会再次落到第一条头上。
 * 这也正是**不会重复**的根据：一次发送只可能对上一条本地行。
 */
function matchPending(messages: Message[], incoming: Message): number {
  if (incoming.kind !== "danmaku") return -1;
  return messages.findIndex((item) => {
    if (item.local_id >= 0 || item.send_state === "rejected") return false;
    if (echoedLocals.has(item.local_id)) return false;
    if (item.kind !== incoming.kind || item.uid !== incoming.uid) return false;
    if (item.content !== incoming.content) return false;
    const mine = item.emote?.emoticon_unique ?? "";
    const theirs = incoming.emote?.emoticon_unique ?? "";
    if (mine.length > 0 && theirs.length > 0 && mine !== theirs) return false;
    return Math.abs(incoming.ts - item.ts) <= SEND_MATCH_WINDOW_MS;
  });
}

/**
 * 这条弹幕是不是列表里已经有的**同一条**（`docs/ui.md` §4.5）？
 *
 * `(kind, uid, 正文, ts)` 逐字相同 = 上游给的**同一条**，不是「同一个人说了同样的话」：
 * 真人重复发言每条各有自己的上游 `ts`，合并判据（`filtering.ts` 的 `toDisplayRows`）
 * 照旧把它们合成 ×2 —— 那正是合并该管的事。只有「同一条被送了两遍」才会命中这里，
 * 实测有两类来源：
 * - 「断开连接 → 刷新连接」重建会话时，新会话的回填与界面上残留的旧会话行重合；
 * - 同一条弹幕既在进场回填里、又从实时路径来（上游两条路都会带它）。
 *
 * 只认 `danmaku`：它是唯一有「回填 + 实时回推」两条路进来的类型；礼物/互动本来就允许
 * 同一条被上游反复推（连击、榜单刷新），按内容去重会误伤。
 */
function alreadyListed(messages: Message[], incoming: Message): boolean {
  if (incoming.kind !== "danmaku") return false;
  return messages.some(
    (item) =>
      item.kind === incoming.kind &&
      item.uid === incoming.uid &&
      item.ts === incoming.ts &&
      item.content === incoming.content,
  );
}

/**
 * 本人粉丝牌的**真彩色**。`room_session` 不带它（`protocol.md` A38 只实测到
 * `up_medal.{level, medal_name}`），而弹幕里带着（A37：`user.medal.v2_medal_color_*` 四个键）。
 * 所以从**本人上一条上游行**里取：本地行要「从第一帧起就与上游行渲染逐项相同」，
 * 牌面配色就不能走按牌名派生的兜底色 —— 那是**另一个色**，会和本人其它行对不上。
 * 取不到（本会话里我还没发过言）就返回空串，由 `medalColors` 正常回落。
 */
function ownMedalPalette(messages: Message[], uid: number): {
  medal_color_start: string;
  medal_color_end: string;
  medal_color_border: string;
  medal_color_text: string;
} {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    // 只认带真彩色的弹幕行：回填的历史条目**没有**颜色字段（A30），拿它当来源等于没取到。
    if (item.uid !== uid || item.kind !== "danmaku") continue;
    // 也不认**没点亮**的行：上游给未点亮的牌发的是一套灰（实测 `#919298*`），
    // 拿它当配色会把真彩色的牌画成灰的。
    if (!item.medal_lit) continue;
    if ((item.medal_color_start ?? "").length === 0) continue;
    return {
      medal_color_start: item.medal_color_start ?? "",
      medal_color_end: item.medal_color_end ?? "",
      medal_color_border: item.medal_color_border ?? "",
      medal_color_text: item.medal_color_text ?? "",
    };
  }
  return {
    medal_color_start: "",
    medal_color_end: "",
    medal_color_border: "",
    medal_color_text: "",
  };
}

/**
 * **立刻**把这条弹幕画出来（乐观渲染，用户 2026-09-13：「发送应该即刻响应」），
 * 并给它排一个超时兜底的定时器。返回本地行的 `local_id`（对账 / 修正都用它定位）。
 *
 * 这一行**从第一帧起就与上游回推的行渲染逐项相同**，而且**那一帧就是最终形态**
 * （用户 2026-09-13 追加：发送是一次性落定，上游反馈只在被拦截 / 被拒时才动手）。
 * 正因如此，插入时能填的身份字段必须填全（回播之后没人会再给它补）：
 * - 昵称 / uid 来自 `session`，**头像**来自当前生效账号的 `face`（两者都源自 `nav`）；
 * - 粉丝牌等级与牌名、大航海、房管标记：来自 `roomIdentities[roomId]`（`room_session`，
 *   会话建立时取自上游进房接口，与回播那条同源）；
 * - 牌面**配色**：`room_session` 不带，改从本人上一条上游行取（`ownMedalPalette`）；
 * - `medal_guard_level`（牌面样式）：我的牌就是本房间的牌，因此它 = 我在本房间的大航海等级
 *   （A39：官方拿 `medal.guard_level` 区分牌面样式，取值是该牌所属房间的舰长等级）。
 *
 * **刻意不设 `send_state`**（用户 2026-09-13 的更正）：它要的就是「发出去 = 已发送的样子」，
 * 上游返回只做校验、不作为展示前置，因此插入的这一行在渲染上与「别的客户端看到的我」**逐项相同**；
 * 只有上游明确拒绝（`markPendingRejected`）或结果未知（`markPendingUnconfirmed`）才写上它。
 */
function insertPending(
  store: StoreApi<AppStore>,
  roomId: number,
  content: string,
  emote?: EmoteToken,
  reply?: ReplyTarget,
): number {
  pendingSeq += 1;
  const localId = -pendingSeq;
  const state = store.getState();
  const session = state.session;
  const identity = state.roomIdentities[roomId];
  const uid = session?.uid ?? 0;
  // 头像不在 `session` 里（`SessionState` 只有 `logged_in` / `uid` / `nickname` /
  // `active_profile`，契约 §5），它在当前生效账号上 —— 同样是 `nav` 求证时拿到的 `data.face`。
  const face = state.accounts.find((item) => item.active)?.face ?? "";
  // **牌只在"佩戴着"时才画**（`my_medal_worn` ← 上游 `data.medal.is_weared`）：
  // `up_medal` 只说明**持有**这块牌 —— 实测（2026-09-13）某账号在某房间持有 Lv1 牌
  // 却 `is_weared = false`，官方因此不画它；照旧画就会先多出一块「别人都看不到的牌」、
  // 回播到了再消失（用户当天报的正是这个）。判据与弹幕侧同一个（`Message.medal_lit`）。
  const worn = identity?.my_medal_worn === true;
  const hasMedal = worn && (identity?.my_medal_name ?? "").length > 0;
  const pending: Message = {
    local_id: localId,
    room_id: roomId,
    kind: "danmaku",
    ts: Date.now(),
    uid,
    uname: session?.nickname ?? "",
    content,
    color: 0,
    medal_level: hasMedal ? (identity?.my_medal_level ?? 0) : 0,
    medal_name: hasMedal ? (identity?.my_medal_name ?? "") : "",
    // 画了才说它"亮"：`badgesFor` 用同一个判据过滤，这里给的必须与画出来的一致。
    medal_lit: hasMedal,
    ...ownMedalPalette(state.messages, uid),
    guard_level: identity?.my_guard_level ?? 0,
    medal_guard_level: hasMedal ? (identity?.my_guard_level ?? 0) : 0,
    reply_to_uid: reply?.mid ?? 0,
    reply_to_uname: reply?.uname ?? "",
    is_admin: identity?.is_admin ?? false,
    face,
    is_history: false,
    amount: 0,
    combo_id: "",
    emote:
      emote === undefined
        ? null
        : {
            emoticon_unique: emote.emoticon_unique,
            url: emote.url,
            width: emote.width,
            height: emote.height,
            is_dynamic: emote.is_dynamic,
            in_player_area: emote.in_player_area,
            bulge_display: emote.bulge_display,
          },
    upstream_id: "",
  };
  if (state.activeRoomId === roomId) {
    store.setState((current) => ({ messages: appended(current.messages, pending) }));
  }
  const timer = window.setTimeout(() => {
    // 到点还没等到回播 → 挂上「未确认」（不删：它可能已经发出去了，只是回声没来）。
    markPendingUnconfirmed(store, roomId, localId);
  }, SEND_CONFIRM_TIMEOUT_MS);
  sendTimers.set(localId, timer);
  return localId;
}

/**
 * 挂上「未确认」：**没等到上游回播**（8s 超时）或**传输层出错**（结果未知）。
 *
 * 这一档不是「发失败」。被上游明确拒绝的那种会被 `markPendingRejected` 标成**被拒**（划掉 + 写原因）；
 * 留着这一行，是因为它**可能已经发出去了**（别的客户端看得到），只是我们没等到回声 ——
 * 行尾那枚「未确认」就是唯一的提醒，整行不弱化（要读得清）。
 * 已被上限裁掉 / 房间已切的调用是空操作。
 */
function markPendingUnconfirmed(store: StoreApi<AppStore>, roomId: number, localId: number) {
  clearSendTimer(localId);
  if (store.getState().activeRoomId !== roomId) return;
  store.setState((state) => ({
    messages: state.messages.map((item): Message =>
      item.local_id === localId && item.send_state === undefined
        ? { ...item, send_state: "unconfirmed" }
        : item,
    ),
  }));
}

/**
 * 把本地那条行**就地标成被拒**：上游明确说了这条没上屏（`chat_send` 的 `outcome != ok` ——
 * 被平台 / 直播间吞掉、被禁言、要粉丝牌、频率限制…），并把它**留在列表里**。
 *
 * 为什么留着（用户 2026-09-13）：「那行消失我希望能得到保留，划线并标注一下被 ban 的原因，
 * 便于我对照修改」—— 划掉的那条 + 上游给的原因就是「我该改哪几个字」的全部依据。所以：
 * 整行**不弱化**（要读得清）、正文划线（`.rejectedText`）、行尾那枚标记写**原因**
 * （与浮片同一句，见 `sendOutcomeText`）。
 * 已被上限裁掉 / 房间已切的调用是空操作。
 */
function markPendingRejected(
  store: StoreApi<AppStore>,
  roomId: number,
  localId: number,
  reason: string,
) {
  clearSendTimer(localId);
  if (store.getState().activeRoomId !== roomId) return;
  store.setState((state) => ({
    messages: state.messages.map((item): Message =>
      item.local_id === localId && item.send_state !== "rejected"
        ? { ...item, send_state: "rejected", send_reason: reason }
        : item,
    ),
  }));
}

/** 丢掉某个房间的状态键：会话结束（关标签/移除房间）即销毁，不跨会话复用。 */
function dropRoom<T>(map: Record<number, T>, roomId: number): Record<number, T> {
  const rest = { ...map };
  delete rest[roomId];
  return rest;
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
  ownedEmotes: [],
  ownedLoaded: false,
  reportReasons: [],
  accounts: [],
  qr: null,
  qrState: null,
  qrError: null,
  followed: [],
  roomIdentities: {},
  adminSilent: [],
  adminBlacklist: [],
  adminKeywords: [],
  adminErrors: {},
  adminBusy: false,

  async bootstrap() {
    try {
      const [info, session, rooms, prefs, accounts] = await Promise.all([
        api.appInfo(),
        api.sessionStatus(),
        api.roomsList(),
        api.prefsGet(),
        // 账号列表与登录态无关地拉一次：游客态也要能看到自己的账号条目
        // （「这个账号的 Cookie 失效了，重新扫码」就是从这里发现的）。
        api.accountsList(),
      ]);
      set({ info, session, rooms, prefs, accounts });
      // 关注列表在会话就绪后自动拉一次（需求 §2.6 / docs/ui.md §2.2）：
      // 进房间列表就该看到关注里在播的房间，不该等用户去点「刷新」。
      // 失败仍走既有的错误条 + 保留「刷新」按钮，不静默。
      if (session.logged_in) void get().loadFollowed();

      unsubscribe?.();
      unsubscribe = await subscribeEvents({
        onMessage: (message) => {
          if (message.room_id !== get().activeRoomId) return;
          const current = get().messages;
          // 先对账：这条是不是我们自己刚发、还在等回执的那条（用户 2026-09-13：
          // 本地乐观渲染 + 回执校验）。
          //
          // 对上之后做两件事，且**必须是这两件**：
          //   ① 把**字段换成上游那条**。判定标准（用户 2026-09-13 的原话）：「我在客户端发出去
          //      的弹幕，应该和我用别的客户端看它成功上屏时的样子一样」—— `ts` / 头像 / 牌面
          //      真彩色 / `upstream_id` 只有上游知道（插入时那套是本地按 `room_session` 与本人
          //      上一条行凑的近似），换进来才真的「一样」；
          //   ② 把 `local_id` **照抄本地那个负数**（`{ ...message, local_id }`）。React key 因此
          //      不变 ⇒ DOM 节点不重建、不闪（用户原话：看不出中间有回播这件事）。
          //   ③ 原位替换（`map` 而不是 `appended`）：期间可能有别人插进来，不能把它挪到末尾。
          // 位置与身份都保持，肉眼也就没有变化 —— 插入那一帧已经带着同一套身份了。
          // 上游这条因此不入列，也就不会「同一条刷两遍」（docs/ui.md §4.5）。
          const pendingIndex = matchPending(current, message);
          if (pendingIndex >= 0) {
            const localId = current[pendingIndex].local_id;
            // 记进侧表：这一行已经对上过，不能让下一条同正文的回播再落到它头上。
            echoedLocals.add(localId);
            clearSendTimer(localId);
            set((state) => ({
              messages: state.messages.map((item): Message =>
                item.local_id === localId ? { ...message, local_id: localId } : item,
              ),
            }));
            return;
          }
          // 同一条弹幕的第二份不再入列（`docs/ui.md` §4.5）：合并逻辑会把它画成一行
          // ×2，看着像「用户重复发言」，其实只是同一条走了两条路。真人重复发言各有
          // 各的 `ts`，不受影响。
          if (alreadyListed(current, message)) return;
          // `local_id` 是会话内的单调序号（契约 §5）。进场时我们会用 `history_query`
          // 整批覆盖一次，其间到达的事件可能已经包含在那批快照里；此外运行时若被
          // 重建，序号会从头开始。两种情况下都只能接受「比现有末尾更新」的消息，
          // 否则同一 local_id 会进列表两次（React 会报重复 key，渲染也会错乱）。
          // 待确认行用的是负数，排在末尾也不会把这个判定带偏：真实号恒为正、永远更大。
          const last = current.length > 0 ? current[current.length - 1].local_id : 0;
          if (message.local_id !== 0 && message.local_id <= last) return;
          const messages = appended(current, message);
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
        // 登录态变了（扫码确认 / Cookie 失效 / 后端切号）就顺手重拉账号列表，
        // 否则对话框会一直显示过期的「已登录」标记；不递归：只重拉列表，不碰 session。
        onSession: (session) => {
          set({ session });
          if (!session.logged_in) set({ followed: [] });
          void get().loadAccounts();
        },
        // 房内身份与登录态共用一个事件名（见 ipc.subscribeEvents 的分派）：
        // 身份只进 `roomIdentities`，绝不覆盖登录态。
        onRoomSession: (identity) =>
          set((state) => ({
            roomIdentities: {
              ...state.roomIdentities,
              [identity.room_id]: identity,
            },
          })),
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
        clearRoomTimers();
        set((state) => ({
          activeRoomId: undefined,
          messages: [],
          roomIdentities: dropRoom(state.roomIdentities, roomId),
          adminSilent: [],
          adminBlacklist: [],
          adminKeywords: [],
          adminErrors: {},
        }));
      }
      set({ rooms: await api.roomsList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async openRoom(roomId) {
    clearRoomTimers();
    // 「最近观看」记号（用户 #16）：打开房间就记一次时刻，关注列表据此降序。
    // 不 await：它只是记一笔，不该挡在历史回填与建连前面；失败走既有的错误条。
    void get().updatePrefs({
      "ui.recent_watched": {
        ...get().prefs?.["ui.recent_watched"],
        [String(roomId)]: Date.now(),
      },
    });
    // 新会话：丢掉上一轮的身份与房管数据，否则关标签再进会拿着旧身份放行房管入口。
    set((state) => ({
      activeRoomId: roomId,
      messages: [],
      seeding: true,
      roomIdentities: dropRoom(state.roomIdentities, roomId),
      adminSilent: [],
      adminBlacklist: [],
      adminKeywords: [],
      adminErrors: {},
    }));
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
    clearRoomTimers();
    set((state) => ({
      activeRoomId: undefined,
      messages: [],
      adminSilent: [],
      adminBlacklist: [],
      adminKeywords: [],
      adminErrors: {},
      roomIdentities: state.activeRoomId === undefined
        ? state.roomIdentities
        : dropRoom(state.roomIdentities, state.activeRoomId),
    }));
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
      // 重连可能把已经结束的会话（用户点过「断开连接」）重新建起来，
      // 也可能只是把当前连接掐了重连——两种情况下 `connected` 都以重拉结果为准，
      // 否则房间头菜单里的「断开连接」会拿着旧状态一直置灰。
      set({ rooms: await api.roomsList() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async send(roomId, content, emote, reply) {
    // **乐观渲染**（用户 2026-09-13：「发送应该即刻响应，上游校验如果发送失败再修正弹幕状态」）：
    // 先把这条画出来，**再**发请求。实测改前要等 1.36s 才见自己那条（上游回推），
    // 现在点击那一帧就在列表末尾（docs/contract.md §7 / docs/ui.md §4.4）。
    const localId = insertPending(store, roomId, content, emote, reply);
    try {
      const result = await api.chatSend(roomId, content, emote, reply);
      set({ lastSend: result });
      // 上游明确说这条没上屏（被吞 / 被禁言 / 要粉丝牌 / 频率限制…）→ 就地标成**被拒**：
      // 正文划线 + 行尾写上**原因**（与发送浮片同一句），留着给用户对照着改一条再发。
      // `ok` 则保持不动：那一行已经按「别人看到的我」的样子画着了，等回播把权威字段换进来。
      if (result.outcome !== "ok") {
        markPendingRejected(store, roomId, localId, sendOutcomeText(result.outcome, result.detail));
      }
      return result.outcome;
    } catch (error) {
      // 传输层出错 = **结果未知**，不是「没发出去」：错误条照旧，行上挂「未确认」留着 ——
      // 它可能已经上屏了（别的客户端看得到），删掉反而是撒谎。
      set({ error: describeError(error) });
      markPendingUnconfirmed(store, roomId, localId);
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

  async refreshIdentity() {
    try {
      // 以重拉结果为准：`account_*` 的返回形状不是界面的事实来源，重拉一次最省心也最准。
      const [session, accounts] = await Promise.all([
        api.sessionStatus(),
        api.accountsList(),
      ]);
      set({ accounts });
      await get().applySession(session);
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loadAccounts() {
    try {
      set({ accounts: await api.accountsList() });
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

  async switchAccount(name) {
    try {
      await api.accountSwitch(name);
      await get().refreshIdentity();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async removeAccount(name) {
    try {
      await api.accountRemove(name);
      // 被删的可能正是当前账号（后端会切到别个），进行中的扫码也随之作废。
      set({ qr: null, qrState: null, qrError: null });
      await get().refreshIdentity();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async logoutAccount(name) {
    try {
      await api.accountLogout(name);
      // 清掉凭据后该账号退回未登录：会话变游客、关注列表清空（refreshIdentity 里做）。
      set({ qr: null, qrState: null, qrError: null });
      await get().refreshIdentity();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loginCookie(cookie, name) {
    try {
      const account = await api.accountLoginCookie(cookie, name);
      await get().refreshIdentity();
      set({ notice: `已登录「${account.nickname || account.name}」` });
      return true;
    } catch (error) {
      // 凭据值不回显、不进日志：错误里只可能有后端给的 code + message。
      set({ error: describeError(error) });
      return false;
    }
  },

  async startAccountQr(target) {
    // 换二维码时先把上一张清掉：面板不显示「上一张已作废的二维码 + 新状态」。
    set({ qr: null, qrState: null, qrError: null });
    try {
      const qr = await api.accountQrStart(target);
      set({ qr: { ...qr, target: target ?? null }, qrState: "pending" });
    } catch (error) {
      // 失败时面板仍要留在原地（qr 为 null 但有 qrError），由它给出「重试」。
      set({ qrError: describeError(error) });
    }
  },

  cancelAccountQr() {
    set({ qr: null, qrState: null, qrError: null });
  },

  async pollAccountQr() {
    const qr = get().qr;
    if (!qr) return null;
    try {
      const { state, account } = await api.accountQrPoll(qr.key);
      set({ qrState: state, qrError: null });
      if (state === "confirmed") {
        // 后端在这一步已落盘并让房间重连；界面把登录态、账号、房间、关注重新拉一遍。
        // 新增时说清「加了哪个账号」，重新登录时说清「覆盖了谁的凭据」。
        const who = account ? account.nickname || account.name : "";
        set({
          qr: null,
          qrState: null,
          notice:
            qr.target === null
              ? `已添加账号${who ? `「${who}」` : ""}`
              : `已重新登录${who ? `「${who}」` : ""}，凭据已更新`,
        });
        await get().refreshIdentity();
      }
      return state;
    } catch (error) {
      set({ qrError: describeError(error) });
      return null;
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

  async loadOwnedEmotes(retryFailedOnly = false) {
    // 主站「我的表情」与房间无关（`room_id=0`），一次成功之后不再打扰上游；
    // 面板打开时传 true，只在**上次失败**后重试一次。失败只记在 `ownedError`，
    // 由面板显示并提供重试，绝不阻塞输入框（docs/ui.md §6.3）。
    if (get().ownedLoaded && !(retryFailedOnly && get().ownedError !== undefined)) return;
    try {
      set({
        ownedEmotes: await api.emotesOwned(),
        ownedLoaded: true,
        ownedError: undefined,
      });
    } catch (error) {
      set({ ownedLoaded: true, ownedError: describeError(error) });
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

  async loadRoomIdentity(roomId) {
    try {
      const identity = await api.roomSession(roomId);
      set((state) => ({
        roomIdentities: { ...state.roomIdentities, [roomId]: identity },
      }));
    } catch (error) {
      // 身份拿不到就按「无权限」渲染房管入口（绝不放行），原因进全局错误条。
      set({ error: describeError(error) });
    }
  },

  async loadAdmin(roomId) {
    // 三块各自失败各自留痕：一块挂了不该把另外两块的列表也清空。
    const errors: AppStore["adminErrors"] = {};
    const [silent, blacklist, keywords] = await Promise.all([
      api.adminSilentList(roomId).catch((error: unknown) => {
        errors.silent = describeError(error);
        return undefined;
      }),
      api.adminBlacklistList(roomId).catch((error: unknown) => {
        errors.blacklist = describeError(error);
        return undefined;
      }),
      api.adminKeywordsList(roomId).catch((error: unknown) => {
        errors.keywords = describeError(error);
        return undefined;
      }),
    ]);
    set((state) => ({
      adminSilent: silent ?? state.adminSilent,
      adminBlacklist: blacklist ?? state.adminBlacklist,
      adminKeywords: keywords ?? state.adminKeywords,
      adminErrors: errors,
    }));
  },

  async runAdmin(roomId, action) {
    set({ adminBusy: true });
    try {
      switch (action.kind) {
        case "mute":
          await api.adminMute(roomId, action.uid, action.hour);
          break;
        case "unmute":
          await api.adminUnmute(roomId, action.uid);
          break;
        case "blacklist_add":
          await api.adminBlacklistAdd(roomId, action.uid);
          break;
        case "blacklist_del":
          await api.adminBlacklistDel(roomId, action.uid);
          break;
        case "keyword_add":
          await api.adminKeywordsAdd(roomId, action.word);
          break;
        case "keyword_del":
          await api.adminKeywordsDel(roomId, action.word);
          break;
      }
      set({ notice: adminDoneText(action) });
      // 写成功后就地重读三块：不猜上游怎么变，以远端为准。
      await get().loadAdmin(roomId);
      return true;
    } catch (error) {
      // 非 0 code 原样展示、不赋语义（契约 §7）。
      set({ error: describeError(error) });
      return false;
    } finally {
      set({ adminBusy: false });
    }
  },

  dismissError() {
    set({ error: undefined });
  },
}));
