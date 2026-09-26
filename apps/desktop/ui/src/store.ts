// 应用状态。UI 只消费这里的数据，不直接调用后端（docs/ipc.md §5）。

import { create, type StoreApi } from "zustand";

import { api, describeError, subscribeEvents } from "./ipc";
// 「哪些消息在列表里」那几条规则住在这个纯模块里（可被 `node --test` 直接钉住，见该文件头）。
import {
  adoptSessionSnapshot,
  appended,
  dropSessionMessages,
  insertIncoming,
  refreshMode,
} from "./session-messages";
import {
  adminDoneText,
  SEND_CONFIRM_TIMEOUT_MS,
  SEND_MATCH_WINDOW_MS,
} from "./types";
import type {
  Account,
  AccountQr,
  AdminAction,
  AdminTab,
  AdminUser,
  AnchorArea,
  AnchorGateView,
  AppInfo,
  ChatSendResult,
  EmoteToken,
  ReplyTarget,
  ReportReason,
  ConnState,
  Emote,
  FollowedRoom,
  Message,
  OwnRoom,
  Prefs,
  RoomSession,
  RoomView,
  SendOutcome,
  QrState,
  SessionState,
  StreamEndpoints,
} from "./types";
// 值导入（上面那一组是 `import type`）：发送结果那句话在这里拼，行尾标记与浮片共用同一句。
import { isAnchorGate, sendOutcomeText } from "./types";

/** 前端日志只保留的行数（`docs/ipc.md` §8）；消息按 `kind` 分档的显示上限 `KIND_CAPS` 在 `session-messages.ts`。 */
const LOG_CAP = 200;

interface AppStore {
  info?: AppInfo;
  session?: SessionState;
  rooms: RoomView[];
  activeRoomId?: number;
  /**
   * 沉浸模式（issue #1）：弹幕区双击收起标题栏与输入区、只留弹幕区与礼物区的**会话内瞬态**。
   * 它**不是**偏好 —— 不进 `prefs.json`、不跨重启（契约 §8 的键表里没有它，界面也不许自己加）；
   * 切房间与关房间一律回到非沉浸态（`RoomView` 在 `room_id` 变化时清一次，`closeRoom` 这里再清一次）。
   * 放在 store 而不是组件本地：「进 / 出」有两条入口（弹幕区双击、系统返回手势），
   * 而且需要**一处**统一清空，不能让每个组件各持一份。
   */
  immersive: boolean;
  messages: Message[];
  /**
   * 显示层的**重算信号**（`App.tsx` 的 `chatRows` 依赖里读它）。
   *
   * 「互动消息自动消失」那整条链（`ui.interact_auto_hide`）已删除，互动消息改由单槽位浮层
   * 呈现（`ui.interact_single_slot`），不再有到点定时器挪动这个值 —— 字段留着只是因为
   * `App.tsx` 那处订阅还在（那一处由后续清理一并收掉）。
   */
  interactTick: number;
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
  /**
   * 「我的表情」**上一次成功拉取**的时刻（`Date.now()`）；失败不更新。
   * 面板打开时按它判「距上次成功是否已超过 {@link OWNED_EMOTES_STALE_MS}」——过期才重拉，
   * 避免每开一次面板都打一次上游（issue202609242158 第 8 条 A4）。
   */
  ownedLoadedAt?: number;
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

  /**
   * 「我的直播间」（`docs/ui.md` §2.2.2）：账号行上的按钮**展开了哪个账号**的管理区
   * （`null` = 都收着）。按账号名存而不是一个布尔：按钮在每一行都有，
   * 但后端读的永远是当前账号自己的直播间，展开态必须跟着行走。
   */
  anchorPanelFor: string | null;
  /** 当前账号自己的直播间（`anchor_room`）；`null` = 没开通 / 还没读到。 */
  anchorRoom: OwnRoom | null;
  /** 开播分区树（`anchor_area_list`，两级）。 */
  anchorAreas: AnchorArea[];
  /** 分区列表取不到的原因；界面据此降级为只读分区名（`title` 里也带一句）。 */
  anchorAreaError?: string;
  /** 标题输入框的草稿；`undefined` = 跟随远端（`anchorRoom.title`，成功保存后清回）。 */
  anchorTitleDraft?: string;
  /** 界面所选子分区 id；`undefined` = 沿用直播间当前分区（上次开播分区）。 */
  anchorAreaId?: number;
  /**
   * 开播成功后的推流端点，**含推流码**（契约 §5）。
   *
   * 推流码是账号级凭据：只在这一份内存里，**不进 `prefs.json`、不落盘、不打日志**；
   * 下播 / 换人 / 关对话框即清（`resetIdentityState`）。
   */
  anchorEndpoints: StreamEndpoints | null;
  /** 开播被上游身份校验挡住时的引导（`AnchorGateView`）；非空即弹提示框。 */
  anchorGate: AnchorGateView | null;
  /** 这一块读 / 写失败的原因：**后端原话**，失败不静默。 */
  anchorError?: string;
  /**
   * 每个账号自己的直播间（`anchor_room(account)` 的预取结果，`docs/ui.md` §2.2.2）：
   * 账号名 → `OwnRoom | null`。`null` = 该账号**没开通**直播间（不是错误），界面据此
   * **不渲染**那行的「我的直播间」按钮（issue202609241553 第 2 条）。
   */
  anchorRooms: Record<string, OwnRoom | null>;
  /**
   * 每个账号「取自己直播间」失败的原因（同上，按账号名）。有错误 → 也不渲染按钮，
   * 但原因留痕（失败不静默，`AGENT.md` §8.7）。
   */
  anchorRoomErrors: Record<string, string>;

  bootstrap: () => Promise<void>;
  addRoom: (input: string) => Promise<void>;
  removeRoom: (roomId: number) => Promise<void>;
  openRoom: (roomId: number) => Promise<void>;
  closeRoom: () => void;
  /**
   * 拖动重排标签（`docs/ui.md` §2.3「拖动排序」）：把 `roomId` 挪到数组下标 `toIndex`。
   * **只动顺序** —— `activeRoomId` 不变（拖的是排列，不是切房间）。顺序是**会话态**：
   * 不落偏好键（`rooms_list` 才是房间集合的事实来源，见 `mergeRoomOrder`）。
   */
  moveRoom: (roomId: number, toIndex: number) => void;
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
   * 拉主站「我的表情」。`ifStale` 为 true（表情面板打开时用）时**只在数据过期或上次失败**
   * 后才重拉 —— 过期阈值见 {@link OWNED_EMOTES_STALE_MS}，避免每开一次面板都打一次上游
   * （issue202609242158 第 8 条 A4）。缺省 false = 只在从未成功加载过时加载一次。
   */
  loadOwnedEmotes: (ifStale?: boolean) => Promise<void>;
  /** 重拉关注列表；返回这一份有没有拿到（列表页轮询按它判退避，契约 §4）。 */
  loadFollowed: () => Promise<boolean>;
  loadBalance: () => Promise<void>;
  /**
   * 列表页的**开播状态轮询**（契约 §4）：停在列表页时让状态自己跟上上游。
   *
   * **返回停止函数** —— 进房间页 / 组件卸载就调它停掉；重复调用先停上一轮（幂等）。
   * 进入列表页立即拍一拍，之后每 30 秒一拍；不可见跳过、不重叠、失败退避，口径见 `docs/ui.md` §2.2。
   */
  startListStatusPolling: () => () => void;
  /** 读该房间的本人身份（进房时一次；之后靠事件更新）。 */
  loadRoomIdentity: (roomId: number) => Promise<void>;
  /**
   * 读房管三块列表：只读，无权限也放行，错误原样展示。返回**这一批有没有拿到**
   * （三块全成 = true；各自失败各自留痕）—— 面板展开期的静默轮询按它判退避（第 8 条 A2）。
   *
   * **分段取**：`limit` 缺省 = 每块 `ADMIN_PAGE`（30）条；**重读时保留已加载水位**
   * —— 已经翻到 80 条就不会被打回 30 条。屏蔽词上游没有分页，一次给完。
   */
  loadAdmin: (roomId: number, limit?: number) => Promise<boolean>;
  /** 名单滚到底再补一段（`ADMIN_STEP` = 10 条）。屏蔽词是前端切片，不调上游。 */
  loadAdminMore: (roomId: number, tab: AdminTab) => Promise<void>;
  /**
   * 「这个对象在不在名单里」—— 房管面板按钮三态的依据。
   *
   * 会先按房间**节流地取一次全量**，因此结论是权威的：只在已加载的那 30 条里查，
   * 会把「还没翻到的成员」误判成不在名单里（需求 2026-09-26：拉黑时目标常常
   * 根本不在直播间、也没被翻到）。
   */
  checkAdminMember: (
    roomId: number,
    tab: AdminTab,
    value: string | number,
  ) => Promise<boolean>;
  /** 执行一次房管写操作；调用方负责二次确认。成功返回 true。 */
  runAdmin: (roomId: number, action: AdminAction) => Promise<boolean>;
  /**
   * 房管面板的**静默轮询**（issue202609242158 第 8 条 A2）：面板展开期间按周期重拉三块列表，
   * 收起即停。返回停止函数；与列表页轮询同款链条式调度（不重叠、不可见整拍跳过、失败退避），
   * 落地前复核 `activeRoomId` 仍是它。
   */
  startAdminPolling: (roomId: number) => () => void;
  /**
   * 展开 / 收起某个账号行的「我的直播间」管理区（再点一次收起）。**不必切到该账号**
   * （issue202609241553 第 3 条）：展开即按 `name` 拉那个账号的房间与分区。
   */
  toggleAnchorPanel: (name: string) => Promise<void>;
  closeAnchorPanel: () => void;
  /**
   * 打开账号对话框时**并发**预取所有已登录账号的「自己的直播间」（`anchor_room(account)`），
   * 落到 `anchorRooms` / `anchorRoomErrors`，供按钮显隐判断（第 2 条）。已在的条目会被刷新。
   */
  loadAnchorRooms: () => Promise<void>;
  /**
   * 拉（或重拉）某个账号的直播间；不传 `name` = 当前展开的那个。同时回填 `anchorRoom`。
   * `silent`（展开期静默轮询用）= 不打断正在编辑的标题草稿，且窗口内不让重读盖回刚保存的
   * 标题；返回**这一份有没有落地**（被更新的响应越过、或换号作废时为 false）供轮询判退避。
   */
  loadAnchorRoom: (name?: string, opts?: { silent?: boolean }) => Promise<boolean>;
  /**
   * 「我的直播间」展开区的**静默轮询**（issue202609242158 第 7 条）：面板展开期间按周期
   * 重拉 `anchor_room(account)`，收起 / 关对话框即停。返回停止函数（与列表页轮询同一套
   * 链条式调度：不重叠、不可见整拍跳过、失败退避；落地前复核身份世代）。
   */
  startAnchorPolling: (account: string) => () => void;
  /** 拉开播分区树。取不到只降级为只读分区名，不当作这一块的致命错误。 */
  loadAnchorAreas: () => Promise<void>;
  /** 标题草稿；传空串等于「清空」。 */
  setAnchorTitleDraft: (value: string) => void;
  /** 选中的子分区（`undefined` = 沿用直播间当前分区）。 */
  setAnchorAreaId: (id?: number) => void;
  /**
   * 改分区且**立即存**（issue202609241553 第 4 条）：改即发一次 `anchor_area_set` 写，
   * 与标题的「改完点保存」分开提交。成功就地换分区名；失败回退选择并留原话在错误行。
   */
  saveAnchorArea: (id: number) => Promise<void>;
  /** 保存标题；成功返回 true（成功后远端为准，就地重读）。 */
  saveAnchorTitle: () => Promise<boolean>;
  /** 开播 / 下播。开播成功落推流端点、被身份校验挡住落引导。 */
  setAnchorLive: (live: boolean) => Promise<void>;
  /** 关掉人脸认证提示框（引导态清掉，错误行的上游原话留着）。 */
  closeAnchorGate: () => void;
  /** `FaceAuth` 的「去完成人脸认证」：用系统浏览器打开认证页（`open_url`，不内嵌网页）。 */
  openAnchorGateUrl: () => Promise<void>;
  updatePrefs: (patch: Partial<Prefs>) => Promise<void>;
  /**
   * 切沉浸模式：`true` 进、`false` 出（返回手势与切房间清理都复用同一个动作，
   * 调用方不直接改字段）。见 `immersive` 的注释。
   */
  setImmersive: (value: boolean) => void;
  dismissError: () => void;
  setNotice: (notice?: string) => void;
}

let unsubscribe: (() => void) | undefined;

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
 * 离开房间（返回列表 / 关标签 / 移除房间）时把待确认行的超时兜底定时器清掉。
 * 待确认行随 `messages` 一起清空（契约 §4.3：缓冲的生命周期 = 一次房内会话），
 * 残留的超时回调只会对着另一个房间的同号消息空转。
 *
 * **拨偏好不走这里**：偏好改动不该顺手清掉发送定时器，否则那条会永远停在「无状态」
 * —— 超时兜底也就永远不会到点（无头冒烟实测过这一条）。
 */
function clearRoomTimers() {
  for (const timer of sendTimers.values()) window.clearTimeout(timer);
  sendTimers.clear();
  // 本地行随 `messages` 一起清空（契约 §4.3：缓冲的生命周期 = 一次房内会话），
  // 侧表里的退场标记没有行可指了，一并清掉。
  echoedLocals.clear();
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

/** 丢掉某个房间的状态键：会话结束（关标签/移除房间/断开连接）即销毁，不跨会话复用。 */
function dropRoom<T>(map: Record<number, T>, roomId: number): Record<number, T> {
  const rest = { ...map };
  delete rest[roomId];
  return rest;
}

/**
 * **身份世代**：换人时递增（切号 / 登出当前账号 / 删掉当前账号 / 扫码确认新账号）。
 *
 * 换人期间发起的读取（`session_status` / `accounts_list` / `rooms_list` / 房内身份）落地前
 * 都要复核自己是否还是最新的一代 —— 否则先点账号 1、后点账号 2 时，1 的回包后到就把界面
 * 改回 1（审计 P67：界面「当前」标记不是最后点击的那个）。
 * 取号必须在**命令之前**：按意图顺序（点击顺序）而不是回包顺序，晚到的旧续作直接放弃，
 * 也就不会再多发一轮重拉。
 */
let identityEpoch = 0;

/** 换人：取一个新世代号（调用方在命令之前取，落地前复核）。 */
function beginIdentityChange(): number {
  identityEpoch += 1;
  return identityEpoch;
}

/**
 * 全量房间列表的**落地护栏**（审计 P66）。`rooms_list` 是当前态的全量快照，晚到的旧快照
 * 盖回新状态就是界面串台：`openRoom(A)` 后立刻 `openRoom(B)`，A 那条后到的快照会把 B 的
 * `connected` / 会话条数指回旧值。
 * 每次发起取一个递增号，落地时只接受**还没落过更新快照**的那一份 —— 号是发起顺序，而响应
 * 必然是发起那一刻的当前态，所以号大的永远不比号小的旧。失败不占号：一次失败不该把别人
 * 已经落地的快照判成「更旧」。
 */
let roomsSeq = 0;
let roomsAppliedSeq = 0;

/**
 * 取一份房间**全量快照**并过护栏（审计 P66）。`source` 缺省是 `rooms_list`（登记表快照），
 * 列表页那一拍传 `rooms_refresh_status`（真的去问上游，契约 §4）—— 两者返回同形，
 * 落地口径因此也必须同一条。这次请求已被更新的快照越过时返回 undefined（= 这一份丢掉不落）。
 */
async function reloadRooms(
  source: () => Promise<RoomView[]> = () => api.roomsList(),
): Promise<RoomView[] | undefined> {
  roomsSeq += 1;
  const seq = roomsSeq;
  const rooms = await source();
  if (seq < roomsAppliedSeq) return undefined;
  roomsAppliedSeq = seq;
  return rooms;
}

/**
 * `rooms_list` 落地时的**顺序口径**：上游给**集合**，界面给**顺序**。
 *
 * 用户拖过的排列在本次会话里必须一直有效（`docs/ui.md` §2.3「拖动排序」），而
 * `openRoom` 每切一次房间都会 `connect` → 重拉一次 `rooms_list`：不保序的话
 * 「拖完点一下标签，顺序当场弹回上游那一份」，拖动排序等于没做。
 *
 * 规则：上一份快照里有的房间按**界面现有顺序**留住；新出现的房间（`rooms_add` /
 * 别处加的）按上游顺序接在末尾 —— `sort` 稳定，所以同一条路径上的相对顺序就是上游顺序。
 * 集合仍以上游为准：上游不再返回的房间直接消失。
 */
function mergeRoomOrder(previous: RoomView[], incoming: RoomView[]): RoomView[] {
  const rank = new Map(previous.map((room, index) => [room.room_id, index]));
  return incoming
    .slice()
    .sort(
      (a, b) =>
        (rank.get(a.room_id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.room_id) ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * 列表页开播状态刷新周期（契约 §4）。用户 2026-09-16：「列表应该定期查询状态」——
 * 打开着的房间靠长连接的 `LIVE` / `PREPARING` 实时变（`danmubox://room`），
 * 列表上的那些房间没人替它们问上游，所以由列表页按这个周期自己问。
 */
const LIST_STATUS_REFRESH_MS = 30_000;

/** 失败退避的封顶：`30 → 60 → 120 → 240` 秒（契约 §4）。再久就等于这一页不再刷新了。 */
const LIST_STATUS_REFRESH_MAX_MS = LIST_STATUS_REFRESH_MS * 8;

/** 在跑的那一拍（`undefined` = 没在跑）。链条式调度：**这一拍落地才排下一拍**。 */
let listStatusTimer: number | undefined;
/** 连续失败次数：只用来算退避，成功即复位。 */
let listStatusFailures = 0;

/**
 * 停掉列表页轮询（进房间页 / 组件卸载 / 重新 start 时都走它）。幂等。
 */
function stopListStatusPolling() {
  if (listStatusTimer !== undefined) window.clearTimeout(listStatusTimer);
  listStatusTimer = undefined;
  listStatusFailures = 0;
}

/**
 * 排下一拍。**链条式**（下一拍只在上一拍落地后才有）而不是 `setInterval`：这样
 * 「不重叠」是结构上成立的 —— 上游慢只会把下一拍推后，不会把请求叠起来，
 * 也不需要「上一拍还没回来就跳过这一拍」那种会白丢一拍的写法。
 */
function scheduleListStatusPoll(store: StoreApi<AppStore>, delayMs: number) {
  listStatusTimer = window.setTimeout(() => {
    listStatusTimer = undefined;
    void runListStatusPoll(store);
  }, delayMs);
}

/**
 * 一拍：先看**可见性**，不可见就整拍跳过（一个请求都不发 —— 契约 §4 的第一道闸门），
 * 可见则拉两份状态，最后按这一拍的成败排下一拍（失败退避，成功复位）。
 *
 * 定时器在不可见时**留着**（只是空转）：它的代价为零，而浏览器在后台本来就会把定时器节流；
 * 真正的纪律是「不可见就不打上游」，由这里的提前返回保证。
 */
async function runListStatusPoll(store: StoreApi<AppStore>) {
  if (document.visibilityState !== "visible") {
    scheduleListStatusPoll(store, LIST_STATUS_REFRESH_MS);
    return;
  }

  if (await refreshListStatuses(store)) {
    listStatusFailures = 0;
  } else {
    listStatusFailures += 1;
  }

  const delay = Math.min(
    LIST_STATUS_REFRESH_MS * 2 ** listStatusFailures,
    LIST_STATUS_REFRESH_MAX_MS,
  );
  scheduleListStatusPoll(store, delay);
}

/**
 * 这一拍要拉的两份状态：**「我的房间」**走 `rooms_refresh_status`（逐个房间只读上游一次，
 * 游客同样成立），**「关注」**走 `follow_list`（它同时是关注行「最后开播时间」的唯一来源，
 * 没有别的接口能替代这一份）。两份**并发**发；**两份都成**才算这一拍成功。
 *
 * 关注那份只在登录时发：游客态没有关注列表可刷（后端会以 `NOT_LOGGED_IN` 回绝）。
 */
async function refreshListStatuses(store: StoreApi<AppStore>): Promise<boolean> {
  const [roomsOk, followedOk] = await Promise.all([
    refreshRoomStatuses(store),
    store.getState().session?.logged_in === true
      ? store.getState().loadFollowed()
      : Promise.resolve(true),
  ]);
  return roomsOk && followedOk;
}

/**
 * 「我的房间」那一份：`rooms_refresh_status` 返回的是**与 `rooms_list` 同形**的全量快照，
 * 因此走同一条落地口径 —— 同一个快照序号护栏（晚到的旧快照不许把连接态指回旧值）+
 * `mergeRoomOrder`（用户拖过的顺序不许被上游顺序顶掉）。
 *
 * 失败进错误条（与其它命令同一条纪律：不静默），并把 `false` 交回给调用方去退避。
 */
async function refreshRoomStatuses(store: StoreApi<AppStore>): Promise<boolean> {
  try {
    const rooms = await reloadRooms(() => api.roomsRefreshStatus());
    if (rooms !== undefined) {
      store.setState((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
    }
    return true;
  } catch (error) {
    store.setState({ error: describeError(error) });
    return false;
  }
}

/**
 * 「我的表情」的**新鲜度阈值**（issue202609242158 第 8 条 A4）：表情面板打开时，距上次
 * **成功**拉取超过它才重拉一次。10 分钟是个折中 —— 表情变动很慢，而每开一次面板都打接口太吵。
 */
const OWNED_EMOTES_STALE_MS = 10 * 60_000;

/**
 * 「我的直播间」展开区的**静默刷新周期**（issue202609242158 第 7 条）。
 *
 * 与列表页那一拍同一节奏（30 秒）、同一套纪律：链条式调度（下一拍只在上一拍落地后才排）、
 * 不可见整拍跳过、失败退避（30 → 60 → 120 → 240 秒封顶）、成功复位。面板收起 / 关对话框即停。
 */
const ANCHOR_REFRESH_MS = 30_000;

/** 退避封顶（再久就等于这块不再刷新了）。 */
const ANCHOR_REFRESH_MAX_MS = ANCHOR_REFRESH_MS * 8;

/** 在跑的那一拍（`undefined` = 没在跑）。 */
let anchorPollTimer: number | undefined;
/** 连续失败次数：只用来算退避，成功即复位。 */
let anchorPollFailures = 0;
/**
 * 轮询**世代号**（PR #30 评审修正）：`stop` / 重新 `start` 都会自增它。在途的旧一拍
 * 落地后按号自查 —— 已被新一轮取代就**什么都不动**。没有它，「收起 A、马上展开 B」时
 * A 的在途拍会调到全局 `stop`，把 B 刚排上的定时器清掉，B 的轮询就此静默死掉
 * （要再收起重开一次才活）。
 */
let anchorPollGen = 0;

/** 停掉「我的直播间」展开区轮询（收起 / 关对话框 / 换号 / 重新 start 时都走它）。幂等。 */
function stopAnchorPolling() {
  anchorPollGen += 1;
  if (anchorPollTimer !== undefined) window.clearTimeout(anchorPollTimer);
  anchorPollTimer = undefined;
  anchorPollFailures = 0;
}

/** 排下一拍。链条式：下一拍只在上一拍落地后才有，结构上不重叠（理由同列表页）。 */
function scheduleAnchorPoll(
  store: StoreApi<AppStore>,
  account: string,
  delayMs: number,
  gen: number,
) {
  anchorPollTimer = window.setTimeout(() => {
    anchorPollTimer = undefined;
    void runAnchorPoll(store, account, gen);
  }, delayMs);
}

/**
 * 一拍：面板已收起 / 换到别的账号就停下，应用不可见就整拍跳过，可见则重拉一次
 * `anchor_room(account)`，最后按成败排下一拍。**只重拉直播间** —— `anchorAreas` 是静态
 * 公开数据，展开时拉一次即可，不进轮询。
 */
async function runAnchorPoll(store: StoreApi<AppStore>, account: string, gen: number) {
  // 已被新一轮（重新 start / 停表后重启）取代：这一拍作废，别碰新一轮的定时器。
  if (gen !== anchorPollGen) return;
  if (store.getState().anchorPanelFor !== account) {
    stopAnchorPolling();
    return;
  }
  if (document.visibilityState !== "visible") {
    scheduleAnchorPoll(store, account, ANCHOR_REFRESH_MS, gen);
    return;
  }
  const ok = await store.getState().loadAnchorRoom(account, { silent: true });
  // `await` 期间可能已被新一轮取代（换行展开 / 收起重开）：同样别碰新定时器。
  if (gen !== anchorPollGen) return;
  if (store.getState().anchorPanelFor !== account) {
    stopAnchorPolling();
    return;
  }
  anchorPollFailures = ok ? 0 : anchorPollFailures + 1;
  const delay = Math.min(ANCHOR_REFRESH_MS * 2 ** anchorPollFailures, ANCHOR_REFRESH_MAX_MS);
  scheduleAnchorPoll(store, account, delay, gen);
}

/** 房管三块名单的**首屏**条数：黑名单实测 `ps=100` 可一页返回 36 条，三块各先拿 100 条。 */
const ADMIN_PAGE = 100;
/** 名单滚到底一次补多少条。 */
const ADMIN_STEP = 10;
/**
 * 「取全量」时的条数上限（安全阀）。
 *
 * 上游禁言每页固定 10 条、页间已限速 200ms，取 500 条最坏是 50 页 ≈ 10 秒 ——
 * 这是一次**用户触发**的操作（在输入框里按下按钮），不是轮询，可以慢。
 */
const ADMIN_FULL_LIMIT = 500;
/** 同一房间两次「取全量」之间的最小间隔：连点输入框不该打爆上游。 */
const ADMIN_FULL_THROTTLE_MS = 30_000;
/** 各房间最近一次「取全量」的时刻（UTC 毫秒）。 */
const adminFullAt: Record<number, number> = {};

/**
 * 房管三块列表的**静默刷新周期**。
 *
 * 改前是 60 秒 —— 用户 2026-09-26 判定「不对」：房管面板不是高频功能，
 * 无差别轮询既招风控（每拍都要翻几十页）又没打到真正需要的时点。放宽到 **5 分钟**，
 * 与「打开面板时拉一次」「写操作后重读」配合（需求 2026-09-26）。
 */
const ADMIN_REFRESH_MS = 300_000;
const ADMIN_REFRESH_MAX_MS = ADMIN_REFRESH_MS * 8;

let adminPollTimer: number | undefined;
let adminPollFailures = 0;
/** 轮询世代号：口径与「我的直播间」那套完全一致（PR #30 评审修正，防换房时旧拍误停新表）。 */
let adminPollGen = 0;

/** 停掉房管面板轮询（收起面板 / 换房 / 卸载 / 重新 start 时都走它）。幂等。 */
function stopAdminPolling() {
  adminPollGen += 1;
  if (adminPollTimer !== undefined) window.clearTimeout(adminPollTimer);
  adminPollTimer = undefined;
  adminPollFailures = 0;
}

function scheduleAdminPoll(
  store: StoreApi<AppStore>,
  roomId: number,
  delayMs: number,
  gen: number,
) {
  adminPollTimer = window.setTimeout(() => {
    adminPollTimer = undefined;
    void runAdminPoll(store, roomId, gen);
  }, delayMs);
}

/**
 * 一拍：房间已切走就停；不可见整拍跳过；否则重拉三块。落地复核在 `loadAdmin` 里
 * （`activeRoomId !== roomId` 时那一批不落地，返回值算「这一拍没成」、进退避）。
 */
async function runAdminPoll(store: StoreApi<AppStore>, roomId: number, gen: number) {
  // 已被新一轮取代：这一拍作废，别碰新一轮的定时器（同「我的直播间」那套世代号）。
  if (gen !== adminPollGen) return;
  if (store.getState().activeRoomId !== roomId) {
    stopAdminPolling();
    return;
  }
  if (document.visibilityState !== "visible") {
    scheduleAdminPoll(store, roomId, ADMIN_REFRESH_MS, gen);
    return;
  }
  const ok = await store.getState().loadAdmin(roomId);
  if (gen !== adminPollGen) return;
  if (store.getState().activeRoomId !== roomId) {
    stopAdminPolling();
    return;
  }
  adminPollFailures = ok ? 0 : adminPollFailures + 1;
  const delay = Math.min(ADMIN_REFRESH_MS * 2 ** adminPollFailures, ADMIN_REFRESH_MAX_MS);
  scheduleAdminPoll(store, roomId, delay, gen);
}

/**
 * 「我的直播间」读写的**发起序号**（护栏口径同 `roomsSeq`）：`anchor_room`（展开首拉与
 * 展开期静默轮询）与 `anchor_title_set` / `anchor_area_set` 都会写 `anchorRoom`，并发时
 * 晚到的旧响应不许把先落地的新值盖回去（issue202609242158 第 3.1 条）。号是**发起顺序**，
 * 失败或被越过的那一份不占落地号。
 *
 * **读与写分开判**（PR #30 评审修正）：写响应是权威（上游 `code==0` 即已落库），
 * **永远落地**、只让位给**更晚发起的写**；读响应既让位给更晚的读、也让位给**已落地的写**。
 * 若共用一个落地号，一拍在写之后发起、却先返回的轮询读会以号大把写响应整份吞掉 ——
 * 写明明成功、草稿却没清、写穿窗口也没开，第 3.1 条就换了个形式复发。
 */
let anchorRoomSeq = 0;
/** 读已落地的最大发起号：只管读与读之间的乱序。 */
let anchorReadAppliedSeq = 0;
/** 写已落地的最大发起号：写一落地，所有更早发起（含在途）的读全部作废。 */
let anchorWriteAppliedSeq = 0;

/**
 * 标题「写穿窗口」：`anchor_title_set` 成功后，后端返回的已是以请求值为准的合并结果，
 * 但紧接着的一次 `anchor_room` 重读（展开首拉 / 静默轮询）仍可能读到上游尚未刷新的旧标题
 * —— 在这段时间里以刚保存的本地标题为准，避免输入框「保存后又跳回原标题」（第 3.1 条）。
 * **只保标题一个字段**，其余字段照常以远端为准；窗口很短，上游刷新后自然收敛。
 */
const ANCHOR_TITLE_SETTLE_MS = 15_000;
let anchorTitleSaved: { account: string; title: string; at: number } | undefined;

/**
 * 把远端读到的房间与「窗口内刚保存过的本地标题」合并（窗口外 / 非同一账号 / 该账号没开通
 * 直播间则原样返回）。`room` 可为 `null`（没开通）：那种情况下没有标题要保。
 */
function mergeSavedTitle(account: string, room: OwnRoom | null): OwnRoom | null {
  if (
    room !== null &&
    anchorTitleSaved !== undefined &&
    anchorTitleSaved.account === account &&
    room.title !== anchorTitleSaved.title &&
    Date.now() - anchorTitleSaved.at < ANCHOR_TITLE_SETTLE_MS
  ) {
    return { ...room, title: anchorTitleSaved.title };
  }
  return room;
}

/**
 * 开播 / 下播成功后的**乐观落地**：只改 `live_status`（开播 → 1、下播 → 0），不重读、
 * 不等上游的 `anchor_room` 追上来；随后由展开期的静默轮询校正（第 3.2 条）。
 */
function applyAnchorLive(
  state: AppStore,
  account: string,
  liveStatus: number,
): { anchorRooms: AppStore["anchorRooms"]; anchorRoom: AppStore["anchorRoom"] } {
  const mapped = state.anchorRooms[account];
  return {
    anchorRooms: mapped
      ? { ...state.anchorRooms, [account]: { ...mapped, live_status: liveStatus } }
      : state.anchorRooms,
    anchorRoom:
      state.anchorPanelFor === account && state.anchorRoom
        ? { ...state.anchorRoom, live_status: liveStatus }
        : state.anchorRoom,
  };
}

/**
 * 丢掉上一个身份留下的界面状态（用户 2026-09-13：「切换用户也要做隔离」）。
 *
 * 为什么连房间列表、表情库、房管三块也一起丢：它们全按凭据算出来——房间的连接态属于旧凭据，
 * 表情包按房内身份下发，房管数据只对旧身份成立；留下任何一块都等于把上一个人的视角摆在新账号
 * 面前。后端在切号时已用新凭据重建各房间连接（契约 §7 `account_switch`），这里只管清前端。
 * 草稿不在这里：`Composer` 按「身份 + 房间」分键，切号后自然不恢复（`docs/ui.md` §2.2.1）。
 */
function resetIdentityState(set: (partial: Partial<AppStore>) => void) {
  // 定时器先停：残留的超时回调会对着另一个身份/房间的同号消息继续动。
  clearRoomTimers();
  // 「我的直播间」与房管面板的轮询一并停：换号后旧回包不得再落地；标题写穿窗口清空。
  stopAnchorPolling();
  stopAdminPolling();
  anchorTitleSaved = undefined;
  set({
    rooms: [],
    activeRoomId: undefined,
    messages: [],
    roomIdentities: {},
    adminSilent: [],
    adminBlacklist: [],
    adminKeywords: [],
    adminErrors: {},
    adminBusy: false,
    emotes: [],
    ownedEmotes: [],
    ownedLoaded: false,
    ownedLoadedAt: undefined,
    ownedError: undefined,
    // 余额是**账号级**数字（`wallet_balance`）：留着它，新账号进房时状态栏会先把上一个
    // 账号的电池数摆出来，直到重拉落地（审计 P72）。
    balance: undefined,
    seeding: false,
    lastSend: undefined,
    // 「我的直播间」整块跟着身份走：房间、分区、推流码（**账号级凭据**）、人脸认证
    // 引导、展开态与草稿一并清 —— 留下任何一块都是把上一个人的直播间摆在新账号面前
    // （`docs/ui.md` §2.2.2：换号 / 登出即清）。按账号的房间映射也清（那一份是身份派生）。
    anchorPanelFor: null,
    anchorRoom: null,
    anchorRooms: {},
    anchorRoomErrors: {},
    anchorAreas: [],
    anchorAreaError: undefined,
    anchorTitleDraft: undefined,
    anchorAreaId: undefined,
    anchorEndpoints: null,
    anchorGate: null,
    anchorError: undefined,
  });
}

/**
 * 把界面的 `messages` 换成**该房间当前会话**的快照（`history_query`，契约 §7）。
 *
 * 「进房间」与「会话结束后再点刷新」是同一条口径（契约 §4.3：重进是全新会话、缓冲从空开始），
 * 因此两处共用这一个函数 —— 分开各写一遍，正是「进房间记得换列表、刷新忘了换」这个缺陷的来源。
 *
 * 落地复核（审计 P65）：await 期间用户可能已经切到别的房间 —— 那批快照属于上一个房间，
 * 整批写进 `messages` 就是把 B 的列表换成 A 的。调用方**不因此跳过建连**：这个房间是用户
 * 点开过的，多标签下各房间各自连着。
 */
async function syncSessionMessages(store: StoreApi<AppStore>, roomId: number): Promise<void> {
  const snapshot = await api.historyQuery(roomId, {
    limit: 0,
  });
  if (store.getState().activeRoomId !== roomId) return;
  const messages = adoptSessionSnapshot(snapshot, store.getState().messages);
  store.setState({ messages });
}

/**
 * 一条房管动作 → **按序执行的一串上游调用**（批量就是多个成员展开的结果）。
 *
 * 写操作只有这一条通道（`runAdmin` 循环 await，失败即停）：单点与批量因此共享同一份
 * 「哪个动作打哪条 IPC」的映射，不存在「批量另写一套」的旁路。批量成员按屏幕顺序排列，
 * 执行顺序因此与用户在列表里看到的顺序一致。
 */
function adminCalls(roomId: number, action: AdminAction): (() => Promise<unknown>)[] {
  switch (action.kind) {
    case "mute":
      return [() => api.adminMute(roomId, action.uid, action.hour)];
    case "unmute":
      return [() => api.adminUnmute(roomId, action.uid)];
    case "blacklist_add":
      return [() => api.adminBlacklistAdd(roomId, action.uid)];
    case "blacklist_del":
      return [() => api.adminBlacklistDel(roomId, action.uid)];
    case "keyword_add":
      return [() => api.adminKeywordsAdd(roomId, action.word)];
    case "keyword_del":
      return [() => api.adminKeywordsDel(roomId, action.word)];
    case "batch":
      return action.actions.flatMap((step) => adminCalls(roomId, step));
  }
}

export const useApp = create<AppStore>((set, get, store) => ({
  rooms: [],
  immersive: false,
  messages: [],
  interactTick: 0,
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
  anchorPanelFor: null,
  anchorRoom: null,
  anchorRooms: {},
  anchorRoomErrors: {},
  anchorAreas: [],
  anchorEndpoints: null,
  anchorGate: null,

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
          // 入列的判据（同一条不重复 + 会话内序号只进不退）在 `session-messages.ts` 的
          // `insertIncoming`；它只保证**同一次会话内**不重复，会话换代（「断开连接」之后
          // 再「刷新连接」）时号会从 1 重来，那一路由 `refresh` 换列表。
          const messages = insertIncoming(current, message);
          if (messages === null) return;
          set({ messages });
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
        // 房间元信息变化（`danmubox://room`）：当前发布点是长连接里的 `LIVE` / `PREPARING`
        // （契约 §6/§7），因此这条实际承载的是**开播状态**。
        //
        // 两处都要跟着变，否则用户会在同一个界面上看到两个自相矛盾的状态：
        // ① `rooms` 里那一条 —— 房间标签条圆点 / 房间头状态点 / 列表卡片都读它；
        // ② `followed` 里同号的那一条 —— 关注行的状态标签读它（`live_status == 1` 还决定置顶，
        //    排序是渲染时按 `followed` 现算的，改了这一条排序自然跟着动）。
        // 只有在载荷真的带了 `live_status` 时才动关注行：载荷按契约是整条 `Room`，但**不许**
        // 把「这一份没带」当成「状态是 undefined」写进去（那会把关注行的状态标签打空）。
        onRoom: (room) =>
          set((state) => {
            // 房间列表与关注行照旧跟着变（见上方注释）。
            const rooms = state.rooms.map((item) =>
              item.room_id === room.room_id ? { ...item, ...room } : item,
            );
            const followed =
              typeof room.live_status === "number"
                ? state.followed.map((item) =>
                    item.room_id === room.room_id
                      ? { ...item, live_status: room.live_status }
                      : item,
                  )
                : state.followed;
            // 「我的直播间」面板：主播自己改了标题时（`ROOM_CHANGE` 经 `danmubox://room`
            // 推来，只带房间号与新标题），面板不该还挂着改之前那一份
            // （issue202609241553 第 6 条）。未连接自己直播间收不到这条（限制见 ui.md）。
            let anchorRoom = state.anchorRoom;
            let anchorRooms = state.anchorRooms;
            if (
              state.anchorRoom &&
              room.title !== undefined &&
              state.anchorRoom.room_id === room.room_id
            ) {
              // 外部改标题（`ROOM_CHANGE`）与刚保存的本地标题对不上 = 真的是别人改的：
              // 清掉写穿窗口，让随后的重读以上游为准（issue202609242158 第 3.1 条）。
              if (
                anchorTitleSaved !== undefined &&
                state.anchorPanelFor === anchorTitleSaved.account &&
                room.title !== anchorTitleSaved.title
              ) {
                anchorTitleSaved = undefined;
              }
              anchorRoom = { ...state.anchorRoom, title: room.title };
              if (state.anchorPanelFor) {
                anchorRooms = {
                  ...state.anchorRooms,
                  [state.anchorPanelFor]: anchorRoom,
                };
              }
            }
            return { rooms, followed, anchorRoom, anchorRooms };
          }),
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
        // `danmubox://send` 与命令返回是**同一份结果**（ipc.md §4）：同样只登记当前房间的
        // —— 晚到的旧结果不得让另一个房间弹浮片（审计 P73）。
        onSend: (lastSend) => {
          if (lastSend.room_id !== get().activeRoomId) return;
          set({ lastSend });
        },
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
      const rooms = await reloadRooms();
      if (rooms !== undefined) set((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
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
      const rooms = await reloadRooms();
      if (rooms !== undefined) set((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
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
    // 切房只换渲染：清掉上个房间的弹幕与房管数据、丢掉发往别的房间的浮片。
    // **身份快照不删**（审计 P71）：切房并没有结束会话 —— 这个房间（多标签下可能同时连着
    // 好几个）的连接还在，切回来还是同一次会话，删了只会让房管入口白闪一下再取回来。
    // 「不留陈旧身份」由另外两件事兜住：① 结束会话的路径各自删掉该房间的身份（关标签 /
    // 移除房间 / 断开连接 / 换人）；② 会话重建时 core 重取身份并经 `danmubox://session`
    // 覆盖（`session.rs`），界面另在进房与打开房管入口时各读一次。
    set({
      activeRoomId: roomId,
      messages: [],
      seeding: true,
      // 发送浮片只属于发出它的那个房间：切房即清（见 `send` 的落地复核，审计 P73）。
      lastSend: undefined,
      adminSilent: [],
      adminBlacklist: [],
      adminKeywords: [],
      adminErrors: {},
    });
    try {
      await syncSessionMessages(store, roomId);
      await get().connect(roomId);
    } catch (error) {
      set({ error: describeError(error) });
    } finally {
      // 「正在载入」由**当下一代**收尾：晚到的那次不该把新房间的提示提前撤掉（审计 P65）。
      if (get().activeRoomId === roomId) set({ seeding: false });
    }
  },

  closeRoom() {
    clearRoomTimers();
    set((state) => ({
      activeRoomId: undefined,
      // 离开房间页即离开沉浸态：这枚标志是房间页的界面状态，不跟着房间活到下一次进来
      // （重进同一房间是**新会话**，见 `docs/ui.md` §2.4）。
      immersive: false,
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

  moveRoom(roomId, toIndex) {
    set((state) => {
      const from = state.rooms.findIndex((room) => room.room_id === roomId);
      // 拖动中房间没了（关标签 / 移除房间 / 上游快照不再包含它）：整次重排作废 ——
      // 别的房间也不许被带着挪一位。只有一个房间时同理，没什么可挪的。
      if (from < 0 || state.rooms.length < 2) return {};
      const to = Math.max(0, Math.min(toIndex, state.rooms.length - 1));
      // 落在原位 = 没有变化（拖了一圈放回原处、只开两枚时互相换位都会走到这里）：
      // 不动 `rooms` 的引用，订阅者因此不会白重渲染一次。
      if (to === from) return {};
      const next = state.rooms.slice();
      const moved = next.splice(from, 1)[0];
      next.splice(to, 0, moved);
      return { rooms: next };
    });
  },

  async connect(roomId) {
    try {
      await api.roomsConnect(roomId);
      // `rooms_list` 的落地复核（审计 P66）：这一份被更新的快照越过就丢掉，
      // 否则 A→B 连点时 A 那条后到的快照会把 B 的连接态指回旧值。
      const rooms = await reloadRooms();
      if (rooms !== undefined) set((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async disconnect(roomId) {
    try {
      await api.roomsDisconnect(roomId);
      // 断开 = 这个房间的会话结束（`docs/ipc.md` §8「离开房间」那一行）：该房间的身份快照与
      // 房管三块一并作废 —— 与 `closeRoom` / `removeRoom` 同款。留着的话，房管入口还按
      // 上一个会话的身份放行（审计 P70）。**弹幕留在屏幕上不动**：断开的这一刻只是不再收，
      // 用户还可能接着看；真要从这个状态回去，只有「刷新」那一档 —— 它会重建一次会话并把
      // 列表换成新会话的快照（见 `refresh`）。
      set((state) => ({
        roomIdentities: dropRoom(state.roomIdentities, roomId),
        ...(state.activeRoomId === roomId
          ? { adminSilent: [], adminBlacklist: [], adminKeywords: [], adminErrors: {} }
          : {}),
      }));
      const rooms = await reloadRooms();
      if (rooms !== undefined) set((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async refresh(roomId) {
    // 「刷新」有两档（契约 §4.3）：**会话还在** → 原地重连，列表原样不动（`docs/ui.md` §3.2）；
    // **会话已被「断开连接」结束** → 外壳当场重建一次会话（`lib.rs::refresh_room`），等价重新进房。
    // 后一档必须换列表：新会话的 `local_id` 从 1 重新编号，而界面还记着上一个会话的号 ——
    // 新消息会被「不比末尾更大」那一条全数丢掉，房间看着已连接却再也不上屏（`docs/ui.md` §2.4）。
    const reenter = refreshMode(get().rooms, roomId) === "reenter";
    // 换列表要**先**把上一个会话的行摘掉：此刻这个房间已经**没有**会话（下面的
    // `rooms_reconnect` 才把它建起来），因此没有发布者会在这两步之间推东西进来，这一清
    // 不会带走任何刚到的事件。反过来放在建连之后清，就会把刚推来的那几条抹掉。
    // 待确认行留着 —— 用户刚发出去的那条不该因为一次刷新消失（见 `dropSessionMessages`）。
    if (reenter && get().activeRoomId === roomId) {
      set({ messages: dropSessionMessages(get().messages) });
    }
    try {
      await api.roomsReconnect(roomId);
      // 建连之后再把**新会话**的快照整批落进来（与进房间同一口径，见 `syncSessionMessages`）：
      // 新会话的进场回填与实时消息从此都有正当的号，照旧入列。
      if (reenter) await syncSessionMessages(store, roomId);
      // 重连可能把已经结束的会话重新建起来，也可能只是把当前连接掐了重连——两种情况下
      // `connected` 都以重拉结果为准，否则房间头菜单里的「断开连接」会拿着旧状态一直置灰。
      const rooms = await reloadRooms();
      if (rooms !== undefined) set((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
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
      // 落地复核（审计 P73）：结果属于**发出去的那个房间**（`ChatSendResult.room_id`），
      // 只有它还是当前房间才登记 —— 否则 B 的输入区会弹 A 那条的失败浮片。
      // 行上的标记不受影响：`markPending*` 各自按房间复核一次。
      if (get().activeRoomId === roomId) set({ lastSend: result });
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
    // 偏好改动**不动任何定时器**（无头冒烟实测过：任何偏好改动顺手清发送定时器，
    // 都会让那条待确认行永远停在「无状态」）。互动消息那批到点定时器已随
    // `ui.interact_auto_hide` 一起删除，这里因此没有需要重排的东西。
  },

  setNotice(notice) {
    set({ notice });
  },

  setImmersive(immersive) {
    set({ immersive });
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
    // 换人复核（审计 P67）：重拉的这几份都以**当下的身份**为准，晚到的旧一代回包一律丢掉。
    const epoch = identityEpoch;
    try {
      // 以重拉结果为准：`account_*` 的返回形状不是界面的事实来源，重拉一次最省心也最准。
      const [session, accounts] = await Promise.all([
        api.sessionStatus(),
        api.accountsList(),
      ]);
      if (epoch !== identityEpoch) return;
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
    const epoch = identityEpoch;
    set({ session });
    // 关注跟着账号走：换了身份就按新身份重拉；未登录则清空，不留上一个人的列表。
    if (session.logged_in) void get().loadFollowed();
    else set({ followed: [] });
    const rooms = await reloadRooms();
    // 落地复核（审计 P67）：这一轮重拉期间又换了一次人，房间列表交给那一代去铺。
    if (epoch !== identityEpoch) return;
    if (rooms !== undefined) set((state) => ({ rooms: mergeRoomOrder(state.rooms, rooms) }));
  },

  async switchAccount(name) {
    // 换人先取号（按**点击顺序**，不是回包顺序）——晚到的旧续作在下面直接放弃。
    const epoch = beginIdentityChange();
    try {
      await api.accountSwitch(name);
      // 已经有更晚的一次换人：清切片与重拉都交给那一代，绝不拿这一轮覆盖它（审计 P67）。
      if (epoch !== identityEpoch) return;
      // 切号成功：上一个身份的界面状态先清干净，再按新会话重铺（需求 2026-09-13）。
      // 后端已用新凭据重建各房间连接（契约 §7），界面这边不能留着旧身份的视角。
      resetIdentityState(set);
      await get().refreshIdentity();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async removeAccount(name) {
    try {
      // 删的若是当前账号，后端会切到剩下的第一个 —— 那也是换人，与切号同款隔离。
      // 判定必须在命令之前取：后端切换后会推 `danmubox://session`，store 里的
      // `active_profile` 可能先一步变成新账号，回头再比就对不上了。
      const wasCurrent = name === get().session?.active_profile;
      // 删当前账号 = 换人，取号；删别的账号不动身份，也就不取号（那一轮只重拉状态，
      // `refreshIdentity` 自己会复核世代）。
      const epoch = wasCurrent ? beginIdentityChange() : undefined;
      await api.accountRemove(name);
      if (epoch !== undefined && epoch !== identityEpoch) return;
      if (wasCurrent) resetIdentityState(set);
      // 被删的可能正是当前账号（后端会切到别个），进行中的扫码也随之作废。
      set({ qr: null, qrState: null, qrError: null });
      await get().refreshIdentity();
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async logoutAccount(name) {
    try {
      // 登出当前账号 = 身份退回游客，同样要把上一个身份的界面状态清掉；
      // 登出别的账号不动当前界面（`active_profile` 不因登出改名，所以这里不必抢在命令前取值）。
      const wasCurrent = name === undefined || name === get().session?.active_profile;
      // 与删当前账号同款：换人才取号（审计 P67）。
      const epoch = wasCurrent ? beginIdentityChange() : undefined;
      await api.accountLogout(name);
      if (epoch !== undefined && epoch !== identityEpoch) return;
      if (wasCurrent) resetIdentityState(set);
      // 清掉凭据后该账号退回未登录：会话变游客、关注列表清空（refreshIdentity 里做）。
      set({ qr: null, qrState: null, qrError: null });
      await get().refreshIdentity();
    } catch (error) {
      set({ error: describeError(error) });
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
        // 确认 = 换人：取号，让这一代之前的在途读取全部作废（与切号同款，审计 P67）。
        beginIdentityChange();
        // 后端在这一步已落盘并让房间重连；界面把登录态、账号、房间、关注重新拉一遍。
        // 新增时说清「加了哪个账号」，重新登录时说清「覆盖了谁的凭据」。
        const who = account ? account.nickname || account.name : "";
        // 确认即意味着账号集合或凭据变了（新账号会被设为当前）——与切号同款清一遍，
        // 表情库与身份快照按新身份重新取（对话框只在房间列表页可达，这里通常已经不在房里）。
        resetIdentityState(set);
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
      const emotes = await api.emotesList(roomId);
      // 落地复核（审计 P68）：表情库按**房内身份**下发，而 `emotes` 是全局单份数组 ——
      // await 期间切了房间就不能写进去，否则 B 的预览 / 置灰是按 A 的身份算的。
      if (get().activeRoomId !== roomId) return;
      set({ emotes });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async loadOwnedEmotes(ifStale = false) {
    // 主站「我的表情」与房间无关（`room_id=0`）：进房那次只在从未成功加载过时拉。
    // 面板打开时传 true —— 只在**上次失败**或**距上次成功已超过阈值**时重拉，别每开一次
    // 面板都打一次上游（issue202609242158 第 8 条 A4）。失败只记在 `ownedError`，
    // 由面板显示并提供重试，绝不阻塞输入框（docs/ui.md §6.3）。
    if (get().ownedLoaded) {
      if (!ifStale) return;
      const loadedAt = get().ownedLoadedAt;
      const fresh =
        get().ownedError === undefined &&
        loadedAt !== undefined &&
        Date.now() - loadedAt < OWNED_EMOTES_STALE_MS;
      if (fresh) return;
    }
    try {
      set({
        ownedEmotes: await api.emotesOwned(),
        ownedLoaded: true,
        ownedLoadedAt: Date.now(),
        ownedError: undefined,
      });
    } catch (error) {
      // 失败也记 `ownedLoaded`（= 尝试过），但**不更新成功时刻** → 下次开面板仍会重试。
      set({ ownedLoaded: true, ownedError: describeError(error) });
    }
  },

  /**
   * 重拉关注列表。返回**这一份有没有拿到**：列表页的轮询按它判退避（契约 §4），
   * 因此失败除了进错误条，还要把「这一拍没成」这句话交回给调用方。
   * 现有调用方（启动 / 换号 / 「刷新」按钮）照旧 `void` 掉它，行为不变。
   */
  async loadFollowed(): Promise<boolean> {
    try {
      set({ followed: await api.followList() });
      return true;
    } catch (error) {
      set({ error: describeError(error) });
      return false;
    }
  },

  async loadBalance() {
    try {
      set({ balance: await api.walletBalance() });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  startListStatusPolling() {
    // 幂等：重复 start 先停掉上一轮（React 严格模式下 effect 会跑两遍，卸载/重挂也走这里）。
    stopListStatusPolling();
    // **进列表页立即一拍**（延迟 0，不是等满一个周期）：用户刚看这一页时的那一眼必须是
    // 当下的状态 —— 否则「刚开播的房间」要等 30 秒才在列表上亮起来。之后由链条自己按周期走。
    scheduleListStatusPoll(store, 0);
    return stopListStatusPolling;
  },

  async loadRoomIdentity(roomId) {
    // 身份世代复核（审计 P67 / P71）：这份身份是按**凭据**取的，换人后晚到的那份属于
    // 上一个账号 —— 写进去会让房管入口按旧身份放行。
    const epoch = identityEpoch;
    try {
      const identity = await api.roomSession(roomId);
      if (epoch !== identityEpoch) return;
      set((state) => ({
        roomIdentities: { ...state.roomIdentities, [roomId]: identity },
      }));
    } catch (error) {
      // 身份拿不到就按「无权限」渲染房管入口（绝不放行），原因进全局错误条。
      set({ error: describeError(error) });
    }
  },

  async loadAdmin(roomId, limit) {
    // 三块各自失败各自留痕：一块挂了不该把另外两块的列表也清空。
    const errors: AppStore["adminErrors"] = {};
    // **保留已加载水位**：重读（5 分钟静默刷新 / 写后重读）按「手上已有多少条」取，
    // 否则用户翻到 80 条会被打回 30 条 —— 那个体验比 412 还糟。
    const state0 = get();
    const want = (have: number) => Math.max(ADMIN_PAGE, have, limit ?? 0);
    const [silent, blacklist, keywords] = await Promise.all([
      api
        .adminSilentList(roomId, 0, want(state0.adminSilent.length))
        .catch((error: unknown) => {
          errors.silent = describeError(error);
          return undefined;
        }),
      api
        .adminBlacklistList(roomId, 0, want(state0.adminBlacklist.length))
        .catch((error: unknown) => {
          errors.blacklist = describeError(error);
          return undefined;
        }),
      api.adminKeywordsList(roomId).catch((error: unknown) => {
        errors.keywords = describeError(error);
        return undefined;
      }),
    ]);
    // 落地复核（审计 P69）：三块是「当前房间」的会话级单例，await 期间切了房间就丢弃这一批
    // —— A 打开面板后立刻切 B，B 的面板不该显示 A 的名单。丢弃不算失败，交回 true。
    if (get().activeRoomId !== roomId) return true;
    const ok = Object.keys(errors).length === 0;
    set((state) => ({
      adminSilent: silent?.items ?? state.adminSilent,
      adminBlacklist: blacklist?.items ?? state.adminBlacklist,
      adminKeywords: keywords ?? state.adminKeywords,
      adminErrors: errors,
    }));
    return ok;
  },

  async loadAdminMore(roomId, tab) {
    // 屏蔽词上游没有分页（一次给完），这里不动上游 —— 它走前端切片。
    if (tab === "keywords") return;
    const offset =
      tab === "silent" ? get().adminSilent.length : get().adminBlacklist.length;
    try {
      const slice =
        tab === "silent"
          ? await api.adminSilentList(roomId, offset, ADMIN_STEP)
          : await api.adminBlacklistList(roomId, offset, ADMIN_STEP);
      if (get().activeRoomId !== roomId) return;
      set((state) =>
        tab === "silent"
          ? { adminSilent: [...state.adminSilent, ...slice.items] }
          : { adminBlacklist: [...state.adminBlacklist, ...slice.items] },
      );
    } catch (error) {
      // 补一段失败**不**清掉已经加载的整段，只留痕。
      set((state) => ({
        adminErrors: { ...state.adminErrors, [tab]: describeError(error) },
      }));
    }
  },

  async checkAdminMember(roomId, tab, value) {
    // 只在**已加载的那一批**里查会误判：名单是分段取的，目标可能还没被翻到。
    // 因此先按房间节流地取一次全量，再回答（需求 2026-09-26）。
    const now = Date.now();
    if (now - (adminFullAt[roomId] ?? 0) >= ADMIN_FULL_THROTTLE_MS) {
      adminFullAt[roomId] = now;
      await get().loadAdmin(roomId, ADMIN_FULL_LIMIT);
    }
    const state = get();
    if (state.activeRoomId !== roomId) return false;
    if (tab === "keywords") return state.adminKeywords.includes(String(value));
    const list = tab === "silent" ? state.adminSilent : state.adminBlacklist;
    return list.some((user) => user.uid === value);
  },

  async runAdmin(roomId, action) {
    set({ adminBusy: true });
    // 一条待确认动作 = **按序执行的一串上游调用**（批量就是多个），失败即停。
    // 单点与批量因此走同一条通道，store 里不为批量另开旁路（见 types.AdminAction）。
    const calls = adminCalls(roomId, action);
    let done = 0;
    try {
      for (const call of calls) {
        await call();
        done += 1;
      }
      set({ notice: adminDoneText(action) });
      // 写成功后就地重读三块：不猜上游怎么变，以远端为准。
      await get().loadAdmin(roomId);
      return true;
    } catch (error) {
      // 非 0 code 原样展示、不赋语义（契约 §7）。批量停下来时前半段可能已经生效：
      // 进度必须说出来（否则用户不知道停在哪一项），并且照样重读三块。
      const reason = describeError(error);
      set({
        error: done > 0 ? `已执行 ${done} 项，第 ${done + 1} 项失败：${reason}` : reason,
      });
      if (done > 0) await get().loadAdmin(roomId);
      return false;
    } finally {
      set({ adminBusy: false });
    }
  },

  startAdminPolling(roomId) {
    // 幂等：重复 start 先停上一轮（面板重开 / 换房 / React 严格模式 effect 跑两遍都走这里）。
    stopAdminPolling();
    const gen = adminPollGen;
    // 打开面板时 `toggleAdminPanel` 已同步拉过一次，首拍因此按周期排，不再重复一次首拉。
    scheduleAdminPoll(store, roomId, ADMIN_REFRESH_MS, gen);
    // 停止函数带世代自查（口径同 `startAnchorPolling`）。
    return () => {
      if (adminPollGen === gen) stopAdminPolling();
    };
  },

  async toggleAnchorPanel(name) {
    if (get().anchorPanelFor === name) {
      // 收起即停轮询（App 侧的 effect 清理也会停一次；这里再停一道，保证幂等）。
      stopAnchorPolling();
      set({ anchorPanelFor: null, anchorGate: null });
      return;
    }
    // 换一行展开：上一行的推流码（账号级凭据）与引导态不留在新面板里。
    set({
      anchorPanelFor: name,
      anchorRoom: null,
      anchorEndpoints: null,
      anchorGate: null,
      anchorError: undefined,
      anchorTitleDraft: undefined,
      anchorAreaId: undefined,
    });
    // **不必切到该账号**（issue202609241553 第 3 条）：展开即按 `name` 拉那个账号的房间与分区。
    // 未登录账号没房间可读（预取阶段就不会给它按钮），这里再拦一道。
    const account = get().accounts.find((item) => item.name === name);
    if (!account?.logged_in) {
      set({ anchorError: "该账号未登录，扫码登录后才能管理直播间" });
      return;
    }
    await get().loadAnchorRoom(name);
    await get().loadAnchorAreas();
  },

  closeAnchorPanel() {
    // 收起即停：展开期的静默轮询到此为止（关对话框也走这里）。
    stopAnchorPolling();
    // 收起即清：推流码（**账号级凭据**）不留在界面内存里，展开态与引导态也一并复位
    // （`docs/ui.md` §2.2.2：关掉对话框 / 收起 → 推流参数与提示框都不在）。
    // 分区列表留着：它是公开数据，下次展开不必再问一次上游。
    set({
      anchorPanelFor: null,
      anchorRoom: null,
      anchorEndpoints: null,
      anchorGate: null,
      anchorError: undefined,
      anchorTitleDraft: undefined,
      anchorAreaId: undefined,
    });
  },

  async loadAnchorRooms() {
    // 并发预取所有**已登录**账号的「自己的直播间」：账号通常 1–3 个，`Promise.all`
    // 与 `loadAdmin` 并发同款（docs/ui.md §2.2.2）。单个失败不影响其余（各自 try）。
    const accounts = get().accounts.filter((item) => item.logged_in);
    const results = await Promise.all(
      accounts.map(async (item) => {
        try {
          const room = await api.anchorRoom(item.name);
          return [item.name, room, undefined] as const;
        } catch (error) {
          return [item.name, null, describeError(error)] as const;
        }
      }),
    );
    set((state) => {
      const rooms = { ...state.anchorRooms };
      const errors = { ...state.anchorRoomErrors };
      for (const [name, room, error] of results) {
        rooms[name] = room;
        // 成功（error 为 undefined）也清掉旧错误：统一落字符串，`""` = 无错误。
        errors[name] = error ?? "";
      }
      return { anchorRooms: rooms, anchorRoomErrors: errors };
    });
  },

  async loadAnchorRoom(name, opts) {
    const account = name ?? get().anchorPanelFor;
    if (!account) return false;
    const epoch = identityEpoch;
    const silent = opts?.silent === true;
    anchorRoomSeq += 1;
    const seq = anchorRoomSeq;
    try {
      const room = await api.anchorRoom(account);
      // 换号：这一份属于上一个身份，丢弃（算「没落地」）。
      if (epoch !== identityEpoch) return false;
      // 已被更晚的读或任何一次已落地的写越过：丢弃，但这不是失败（不进退避）。
      if (seq < anchorReadAppliedSeq || seq < anchorWriteAppliedSeq) return true;
      anchorReadAppliedSeq = seq;
      // 远端为准；静默拍不打断正在编辑的标题草稿，并用写穿窗口挡住「保存后又跳回旧标题」。
      const merged = mergeSavedTitle(account, room);
      set((state) => {
        const onPanel = state.anchorPanelFor === account;
        return {
          anchorRooms: { ...state.anchorRooms, [account]: merged },
          anchorRoomErrors: { ...state.anchorRoomErrors, [account]: "" },
          anchorRoom: onPanel ? merged : state.anchorRoom,
          anchorTitleDraft: onPanel && !silent ? undefined : state.anchorTitleDraft,
          // 读成功即无这一档的错：清掉旧读错。**引导框开着时不清** —— 上游原话要一直挂着。
          anchorError: onPanel && !state.anchorGate ? undefined : state.anchorError,
        };
      });
      return true;
    } catch (error) {
      if (epoch !== identityEpoch) return false;
      // 同款越过判据：这一拍是旧读，它的失败也不许盖掉新值（错误行会被下一次成功读清掉）。
      if (seq < anchorReadAppliedSeq || seq < anchorWriteAppliedSeq) return true;
      // 读失败也要留痕（凭据失效 / 风控…）：只渲染错误行，不编一行假状态。
      const reason = describeError(error);
      set((state) => ({
        anchorRooms: { ...state.anchorRooms, [account]: null },
        anchorRoomErrors: { ...state.anchorRoomErrors, [account]: reason },
        anchorRoom: state.anchorPanelFor === account ? null : state.anchorRoom,
        anchorError: state.anchorPanelFor === account ? reason : state.anchorError,
      }));
      return false;
    }
  },

  async loadAnchorAreas() {
    const account = get().anchorPanelFor;
    const epoch = identityEpoch;
    try {
      const areas = await api.anchorAreaList(account ?? undefined);
      if (epoch !== identityEpoch) return;
      set({ anchorAreas: areas, anchorAreaError: undefined });
    } catch (error) {
      if (epoch !== identityEpoch) return;
      // 分区列表取不到**只降级**（界面改为只读显示 `area_name`），但原因要留下来：
      // 失败不静默（`AGENT.md` §8.7），理由挂在分区行的 `title` 上。
      set({ anchorAreas: [], anchorAreaError: describeError(error) });
    }
  },

  setAnchorTitleDraft(value) {
    set({ anchorTitleDraft: value });
  },

  setAnchorAreaId(id) {
    set({ anchorAreaId: id });
  },

  async saveAnchorTitle() {
    const account = get().anchorPanelFor;
    if (!account) return false;
    const title = (get().anchorTitleDraft ?? get().anchorRoom?.title ?? "").trim();
    // 空标题界面已禁用保存键，后端也会拒（BAD_REQUEST）；这里不再发一次无效请求。
    if (title.length === 0) return false;
    const epoch = identityEpoch;
    anchorRoomSeq += 1;
    const seq = anchorRoomSeq;
    try {
      const room = await api.anchorTitleSet(account, title);
      if (epoch !== identityEpoch) return false;
      // 写响应是权威、**永远落地**，只让位给更晚发起的写（PR #30 评审修正）：
      // 不能被「写之后发起、却先落地」的轮询读按号吞掉。
      if (seq < anchorWriteAppliedSeq) return true;
      anchorWriteAppliedSeq = seq;
      // 记下写穿窗口：后端已按请求值合并；随后的一次 `anchor_room` 重读若仍读到旧标题，不回退它。
      anchorTitleSaved = { account, title: room.title, at: Date.now() };
      // 保存成功就地落**返回值**（后端已把请求标题并进去），并清草稿 → 输入框显示新标题。
      set((state) => ({
        anchorRooms: { ...state.anchorRooms, [account]: room },
        anchorRoom: state.anchorPanelFor === account ? room : state.anchorRoom,
        anchorTitleDraft: state.anchorPanelFor === account ? undefined : state.anchorTitleDraft,
        anchorError: state.anchorPanelFor === account ? undefined : state.anchorError,
        // 自己房间改标题后，弹幕页头部标题（来自 `state.rooms`，见 `App` 的 `activeRoom`）
        // 也要跟着刷新：按 `room_id` 把新标题合并进 `state.rooms` 同条目，与 `onRoom`
        // 处理外部 `ROOM_CHANGE` 是同一口径（`{...item, ...room}`）。否则在「我的直播间」
        // 面板改完标题，弹幕页头部仍显示旧标题（issue：标题不随 ROOM_CHANGE 自动更新）。
        rooms: state.rooms.map((item) =>
          item.room_id === room.room_id ? { ...item, title: room.title } : item,
        ),
      }));
      return true;
    } catch (error) {
      if (epoch !== identityEpoch) return false;
      set({ anchorError: describeError(error) });
      return false;
    }
  },

  async saveAnchorArea(id: number) {
    const account = get().anchorPanelFor;
    if (!account) return;
    const epoch = identityEpoch;
    // 选中即写（issue202609241553 第 4 条）：先记下选择（供开播覆盖与显示），
    // 再发一次 `anchor_area_set`；失败回退选择并留原话。
    set({ anchorAreaId: id });
    anchorRoomSeq += 1;
    const seq = anchorRoomSeq;
    try {
      const room = await api.anchorAreaSet(account, id);
      if (epoch !== identityEpoch) return;
      // 写响应是权威、**永远落地**，只让位给更晚发起的写（同 `saveAnchorTitle` 的评审修正）。
      if (seq < anchorWriteAppliedSeq) return;
      anchorWriteAppliedSeq = seq;
      // 写成功就地换分区名：不猜上游怎么改的，以远端为准；但**标题字段过写穿窗口** ——
      // 改分区后的重读同样可能撞上 `get_info` 缓存里的旧标题，不能盖掉刚保存的标题
      // （`anchorTitleSaved` 只由标题写开启，改分区不开新窗口）。
      const merged = mergeSavedTitle(account, room);
      set((state) => ({
        anchorRooms: { ...state.anchorRooms, [account]: merged },
        anchorRoom: state.anchorPanelFor === account ? merged : state.anchorRoom,
        anchorError: state.anchorPanelFor === account ? undefined : state.anchorError,
      }));
    } catch (error) {
      if (epoch !== identityEpoch) return;
      // 失败即停、不重试：选择回退到服务端当前分区，错误原话进错误行。
      set((state) => ({
        anchorAreaId: state.anchorRoom?.area_id,
        anchorError: describeError(error),
      }));
    }
  },

  startAnchorPolling(account) {
    // 幂等：重复 start 先停上一轮（换行展开 / React 严格模式 effect 跑两遍都走这里）。
    // `stop` 自增世代号，上一轮的在途拍从此碰不到这一轮的定时器。
    stopAnchorPolling();
    const gen = anchorPollGen;
    // 展开时 `toggleAnchorPanel` 已同步拉过一次，首拍因此按周期排，不再重复一次首拉。
    scheduleAnchorPoll(store, account, ANCHOR_REFRESH_MS, gen);
    // 返回的停止函数带世代自查：effect 清理时若已被新一轮取代，就不动新一轮的定时器。
    return () => {
      if (anchorPollGen === gen) stopAnchorPolling();
    };
  },

  async setAnchorLive(live) {
    const account = get().anchorPanelFor;
    if (!account) return;
    const epoch = identityEpoch;
    try {
      // `areaV2` 缺省 = 沿用直播间当前分区（上次开播分区）；界面选了才覆盖。
      const result = await api.anchorLiveSet(account, live, get().anchorAreaId);
      if (epoch !== identityEpoch) return;
      if (!live) {
        // 下播：推流码**立刻**从内存里消失，不留残留。
        set({ anchorEndpoints: null, anchorGate: null, anchorError: undefined });
      } else if (isAnchorGate(result)) {
        // 被身份校验挡住：弹出提示框引导，**不轮询、不自动重试**。
        // `QrConfirm` 的上游原话（码 + msg）是有用的下一步，挂在错误行上；
        // `FaceAuth` 的上游原话（「客户端老了 / 请升级客户端」）是无效提示 —— 已有浏览器
        // 认证入口，不留红字（issue202609242158 第 6 条）。
        set({
          anchorGate: result,
          anchorEndpoints: null,
          anchorError:
            result.kind === "qrconfirm" ? `${result.message}（code ${result.code}）` : undefined,
        });
        return;
      } else {
        set({ anchorEndpoints: result ?? null, anchorGate: null, anchorError: undefined });
      }
      // 乐观落状态：开播 → 在播、下播 → 未开播，不等 `anchor_room` 重读的缓存追上
      // （issue202609242158 第 3.2 条）；展开期的静默轮询随后以上游为准校正。
      set((state) => applyAnchorLive(state, account, live ? 1 : 0));
    } catch (error) {
      if (epoch !== identityEpoch) return;
      set({ anchorError: describeError(error), anchorGate: null });
    }
  },

  async openAnchorGateUrl() {
    const gate = get().anchorGate;
    if (!gate || gate.url.length === 0) return;
    try {
      await api.openUrl(gate.url);
    } catch (error) {
      set({ anchorError: describeError(error) });
    }
  },

  closeAnchorGate() {
    set({ anchorGate: null });
  },

  dismissError() {
    set({ error: undefined });
  },
}));
