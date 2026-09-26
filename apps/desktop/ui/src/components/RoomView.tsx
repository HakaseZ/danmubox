import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { AdminPanel } from "./AdminPanel";
import { Composer, type PanelKind } from "./Composer";
import { ContextMenu, type MenuItem, type MenuPoint } from "./ContextMenu";
import { MessageList } from "./MessageList";
import { InteractSlot } from "./InteractSlot";
import { SplitPanes } from "./SplitPanes";
import { BACK_PRIORITY, registerBackHandler } from "../back";
import { LIVE_DOT_CLASS, LIVE_TEXT, liveKindOf } from "../liveKind";
import { useApp } from "../store";
import {
  amountYuan,
  formatCount,
  GIFT_KINDS,
  giftStatRows,
  splitGiftRows,
  yuanText,
  type DisplayRow,
} from "../filtering";
import {
  ADMIN_CONFIRM_LABEL,
  adminActionText,
  KIND_LABEL,
  MUTE_HOURS,
  type AdminAction,
  type Emote,
  type Message,
  type MessageKind,
  type Prefs,
  type RoomView as RoomViewData,
  type EmoteToken,
  type ReportReason,
  type ReplyTarget,
  type SendOutcome,
  type SessionState,
} from "../types";
import styles from "../app.module.css";

interface Props {
  room: RoomViewData;
  rows: DisplayRow[];
  prefs: Prefs;
  session?: SessionState;
  lastOutcome?: SendOutcome;
  lastDetail?: string | null;
  logs: string[];
  emotes: Emote[];
  /** 主站「我的表情」，与 `emotes` 同侧并进选择器（见 Composer）。 */
  ownedEmotes: Emote[];
  /** 「我的表情」上次拉取失败的原因（面板里给可重试提示）。 */
  ownedError?: string;
  balance?: number;
  onBack: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onSend: (
    content: string,
    emote?: EmoteToken,
    reply?: ReplyTarget,
  ) => Promise<SendOutcome | undefined>;
  onReport: (message: Message, reason: ReportReason) => Promise<void>;
  onPrefs: (patch: Partial<Prefs>) => void;
  onNotice: (text: string) => void;
}

/**
 * 沉浸模式（issue #1）的**双击判据**（唯一一处，`docs/ui.md` §2.3「沉浸模式」）。
 *
 * 用**指针事件**（`pointerdown` + `pointerup`）而不是 `dblclick`：鼠标双击、触屏点两下、
 * 手写笔点两下走的是同一条路，不依赖各引擎「触摸是否合成 dblclick」这件不可靠的事
 * （WKWebView 上双击本来就是缩放手势）。判据是「两次**点**」：
 *
 * - 每次「点」= 指针按下到抬起之间没挪动超过 {@link TAP_SLOP_PX}（拖动 / 滚动 / 选词都不算点）；
 * - 两次点之间不超过 {@link TAP_MS}、且落点相距不超过 {@link TAP_SLOP_PX}（间隔用
 *   `performance.now()` 量：同一只钟，不押在引擎对 `event.timeStamp` 的实现上）。
 *   400ms 是**两边都够用**的那一档：鼠标双击的系统阈值通常在 500ms 上下（手慢的人也点得进来），
 *   而 Android 的双击超时是 300ms（触屏更快，400ms 一样进得来）；比这更长就会把「两次独立的轻点」误收成一次。
 * - 只认主指针的主键（`isPrimary` + `button === 0`）：右键弹行菜单、多指手势的副指针都不算。
 *
 * **与选中文本 / 双击选词的关系**：这条判据不 `preventDefault`、也不改 `user-select`，
 * 浏览器原生的双击选词照旧发生；沉浸态只收起标题栏与输入区，弹幕区原样在场，
 * 选中的文字仍然看得见、仍然复制得到（冒烟 `immersiveKeepsTextSelection` 钉住这一点）。
 * 落在 {@link TAP_IGNORE} 上的双击**不切**——那些元素有自己的双击语义。
 */
const TAP_MS = 400;
const TAP_SLOP_PX = 24;
/** 自带双击语义的元素：落在这上面的双击不切沉浸模式。 */
const TAP_IGNORE = "button, a, input, textarea, select, [role='button'], [contenteditable='true']";

/**
 * 房间页。从左到右、从上到下只有一条生长轴（issue #8 的重排）：
 *
 * ```
 * [头部：◀返回 · ●直播状态 · 直播间标题（放不下就循环滚动） ······ 在线 · 看过 · ⋯菜单]
 * [共享分区 ← 唯一的 flex-1 生长区，由 SplitPanes 管（issue #8）：
 *    默认 [弹幕列表 ← 内部滚动] / [分割条 8px 热区] / [礼物 / SC 栏 ← 内部滚动]
 *    `ui.gift_pane_on_top` 换上下，拖动分割条改比例，长按任一栏 0.5s 拖拽换位]
 * [弹出面板（表情 / 短语 / 筛选 / 房管）← 向上展开，共享分区随之变矮并重新贴底]
 * [输入区：输入框 + 工具行 + 发送]
 * ```
 *
 * 面板在正常文档流里（不是浮层），所以展开时只会挤压共享分区，不会盖住最新弹幕；
 * 两栏的高度比例与上下顺序都落在 `prefs.json`（契约 §8），重开应用保持。
 *
 * **房管面板 / 表情 / 短语 / 筛选 / 独立礼物栏五者互斥**（用户 2026-09-13 第 4 条）：
 * 同时最多开一个 —— 五个面板状态都在这里（输入区那三个是受控的），打开一个就收起另外四个。
 *
 * **沉浸模式**（issue #1）是这条生长轴上的一次「收起」：弹幕区双击进 / 出（判据见
 * {@link TAP_MS} 那一段），收起房间头、输入区（含三个弹出面板）与举报 / 房管 / 日志那几块，
 * 只留**弹幕区**与**礼物 / SC 栏**（`ui.gift_panel` 为真时）——弹幕区因此长高，
 * 虚拟列表靠 `MessageList` 自己的 `ResizeObserver` 重新量高（跟随中会重新贴底；不跟随则把正在读的
 * 那一行按回原来的屏幕位置 —— 收起 / 展开还会把房间头与标签条搬进搬出弹幕区**上方**，
 * 容器顶边跟着挪 88.1px，`docs/ui.md` §7.3 第 5 行）。
 * 房间标签条不在本组件里（它在 `App` 里、是本页的兄弟），由 `<html data-immersive>` +
 * 一条 CSS 规则收起（见下面的 effect）。状态本体是 store 的 `immersive`（会话内瞬态）。
 */

export function RoomView({
  room,
  rows,
  prefs,
  session,
  lastOutcome,
  lastDetail,
  logs,
  emotes,
  ownedEmotes,
  ownedError,
  balance,
  onBack,
  onRefresh,
  onDisconnect,
  onSend,
  onReport,
  onPrefs,
  onNotice,
}: Props) {
  const [showLogs, setShowLogs] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<MenuPoint | null>(null);
  const [messageMenu, setMessageMenu] = useState<{ at: MenuPoint; message: Message } | null>(null);
  const [reportTarget, setReportTarget] = useState<Message>();
  const [giftOpen, setGiftOpen] = useState(false);
  // 输入区的三个弹出面板（表情 / 短语 / 筛选）：状态**提到这里**，因为互斥的对手
  // 是房管面板与独立礼物栏（用户 2026-09-13 第 4 条：五个面板同时最多开一个）。
  const [panel, setPanel] = useState<PanelKind | null>(null);
  // 房管面板与待确认的写操作（issue #3）。写操作一律先落到 `adminConfirm` 再执行：
  // 禁言 / 拉黑 / 解除 / 增删词都会不可逆地影响他人。
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminConfirm, setAdminConfirm] = useState<AdminAction | null>(null);
  // 行菜单里点的 @ / 回复：交给 Composer 应用。
  // 带 token 是为了「每点一次应用一次」——同一个对象引用重复触发容易写成死循环。
  const [pendingAction, setPendingAction] = useState<{
    kind: "mention" | "reply";
    message: Message;
    token: number;
  } | null>(null);
  // 举报理由改用上游固定清单（`dReport/ForReason`，实测 7 条）：
  // 官方客户端按文案反查 `reason_id` 后与文案一起上报，因此界面不该让用户手输。
  const [reasonId, setReasonId] = useState("");
  // 状态点三态（用户 2026-09-13 的口径 + 当天的更正）：**绿 = 开播 / 红 = 下播 / 灰 = 未连接**。
  // 判据是「本房间的连接态 + 上游的 live_status」两件事，收在 `liveKindOf` 一处：
  // 没连上时根本不知道在不在播，那一档是**未连接**（灰）；连上了再看 `live_status === 1`
  // 才是**开播**（绿）；其余（`0` 下播、`2` 轮播）都归**下播**（红）——轮播不是开播，
  // 不许借绿点冒充。**房间标签页上那颗点走的是同一个函数**，两处颜色因此永远一致。
  // 文案只进 title / aria-label，不上屏（用户 2026-09-12：房间头不再写字，靠小圆点区分）。
  // 连接态取**事件驱动**的那一份（`danmubox://status`，与房间标签页上的圆点同源）。
  const connState = useApp((store) => store.status[room.room_id]?.state);
  const liveKind = liveKindOf(connState, room.connected, room.live_status);
  const liveText = LIVE_TEXT[liveKind];
  // 沉浸模式（issue #1）：状态在 store 里（会话内瞬态，见 `store.immersive`），
  // 这里只读出来渲染。**只有**这一处状态，多个组件不各持一份。
  const immersive = useApp((store) => store.immersive);
  const setImmersive = useApp((store) => store.setImmersive);
  // 标题放不下就循环滚动（用户 2026-09-13 第 3 条）：量「一份文字」的宽度与可视宽度比，
  // 放不下才启动动画 —— 短标题因此一动不动（不是「一律滚」）。
  const titleText = room.title.length > 0 ? room.title : `房间 ${room.room_id}`;
  const titleViewportRef = useRef<HTMLSpanElement>(null);
  const titleCopyRef = useRef<HTMLSpanElement>(null);
  const [titleScrolls, setTitleScrolls] = useState(false);
  const [titlePeriod, setTitlePeriod] = useState(0);

  // 从 store 直接取 action：它的身份在渲染之间是稳定的，
  // 所以下面的 effect 只会在登录态变化时触发。经 props 传内联闭包会导致每次渲染都重跑（曾因此死循环）。
  const loadBalance = useApp((store) => store.loadBalance);
  const loadEmotes = useApp((store) => store.loadEmotes);
  const loadOwnedEmotes = useApp((store) => store.loadOwnedEmotes);
  const reportReasons = useApp((store) => store.reportReasons);
  const loadReportReasons = useApp((store) => store.loadReportReasons);
  const openProfile = useApp((store) => store.openProfile);
  const roomStats = useApp((store) => store.roomStats[room.room_id]);
  // 房管权限前置：房管身份来自 `room_session`，主播身份由登录 uid 与房间主播 uid 对上。
  // 拿不到身份时 `is_admin` 为 undefined，且主播 uid 不匹配 → 按**无权限**渲染。
  const isAdmin = useApp((store) => store.roomIdentities[room.room_id]?.is_admin) === true;
  const isAnchor = session?.uid === room.anchor_uid && room.anchor_uid !== 0;
  const canAdmin = isAdmin || isAnchor;
  // 弹幕字数上限（第 12 条 / 契约 C3）：随本人身份一起来的 `danmaku_length`
  // （上游 `getInfoByUser` 的 `data.property.danmu.length`）。取不到时 Composer 按官方缺省 20 回落，
  // 这里不兜底、不写死数值。
  const danmakuLength = useApp((store) => store.roomIdentities[room.room_id]?.danmaku_length);
  const adminSilent = useApp((store) => store.adminSilent);
  const adminBlacklist = useApp((store) => store.adminBlacklist);
  const adminKeywords = useApp((store) => store.adminKeywords);
  const adminErrors = useApp((store) => store.adminErrors);
  const adminBusy = useApp((store) => store.adminBusy);
  const loadRoomIdentity = useApp((store) => store.loadRoomIdentity);
  const loadAdmin = useApp((store) => store.loadAdmin);
  const runAdmin = useApp((store) => store.runAdmin);
  const startAdminPolling = useApp((store) => store.startAdminPolling);
  // 面板按钮三态的「检查」与名单滚到底的「补一段」：都在 store 里（分页 + 限速 + 节流）。
  const checkAdminMember = useApp((store) => store.checkAdminMember);
  const loadAdminMore = useApp((store) => store.loadAdminMore);
  const loggedIn = session?.logged_in ?? false;

  /**
   * 面板互斥（用户 2026-09-13 第 4 条）：**房管面板 / 表情 / 短语 / 筛选 / 独立礼物栏
   * 五个面板同时最多开一个**。打开任何一个都把其它四个收起来；收起某一个不动别人
   * （所以「再点一次工具按钮收起」这条老路照旧）。
   *
   * 三个入口都收在这里：`onPanel`（输入区三个面板，受控）、`toggleAdminPanel`、
   * `toggleGiftDock`。确认条（`adminConfirm`）跟着房管面板走：面板一收就撤销，
   * 免得一条无主的待确认动作挂在屏幕上。
   */
  const onPanel = useCallback(
    (next: PanelKind | null) => {
      // 打开表情面板就顺手刷新（身份可能变过）：「我的表情」按时间节流重拉 ——
      // 距上次成功超过阈值或上次失败才打接口（issue202609242158 第 8 条 A4）。
      if (next === "emotes") {
        void loadEmotes(room.room_id);
        void loadOwnedEmotes(true);
      }
      setPanel(next);
      if (next === null) return;
      setAdminOpen(false);
      setAdminConfirm(null);
      setGiftOpen(false);
    },
    [loadEmotes, loadOwnedEmotes, room.room_id],
  );

  const toggleAdminPanel = () => {
    const next = !adminOpen;
    setAdminOpen(next);
    setAdminConfirm(null);
    if (next) {
      setPanel(null);
      setGiftOpen(false);
    }
    // 打开时顺手重取身份与三块列表：以远端为准（身份 / 名单都可能刚变过）。
    void loadRoomIdentity(room.room_id);
    if (next) void loadAdmin(room.room_id);
  };

  const toggleGiftDock = () => {
    const next = !giftOpen;
    setGiftOpen(next);
    if (next) {
      setPanel(null);
      setAdminOpen(false);
      setAdminConfirm(null);
    }
  };

  // 上一次「点」与本次按下的落点（双击判据的**全部**状态，见文件顶部的 `TAP_MS` 一段）。
  const lastTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const tapDownRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * 弹幕区的双击（issue #1）——判据见文件顶部 {@link TAP_MS} 那一段，进 / 出是**同一个动作**。
   *
   * 落点用 `event.target` 而不是 `currentTarget`：包裹层里有弹幕行（不是可交互元素，
   * 双击它就是要切）与「回到最新」那枚按钮（可交互，双击它不切）。事件不 `preventDefault`
   * —— 双击选词是浏览器的原生行为，这条判据不跟它抢。
   */
  const onChatPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 只认主指针的主键：右键（弹行菜单）、多指手势的副指针都不算「点」。
    tapDownRef.current =
      event.isPrimary && event.button === 0
        ? { x: event.clientX, y: event.clientY }
        : null;
    // 按下就把上一次的「点」作废：中间插了一次别的按下（右键 / 副指）之后，
    // 抬起时不该跟更早的那次凑成「双击」。
    if (tapDownRef.current === null) lastTapRef.current = null;
  };

  const onChatPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = tapDownRef.current;
    tapDownRef.current = null;
    if (down === null || !event.isPrimary || event.button !== 0) return;
    // 拖动（滚动 / 拖选文字）不是「点」：按下到抬起之间挪动过就不算。
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_SLOP_PX) return;
    // 自带双击语义的控件不参与（按钮 / 输入框 / 链接 / 可编辑区），见 `TAP_IGNORE`。
    if (event.target instanceof Element && event.target.closest(TAP_IGNORE) !== null) return;
    const now = { at: performance.now(), x: event.clientX, y: event.clientY };
    const prev = lastTapRef.current;
    lastTapRef.current = now;
    if (prev === null) return;
    if (now.at - prev.at > TAP_MS) return;
    if (Math.hypot(now.x - prev.x, now.y - prev.y) > TAP_SLOP_PX) return;
    // 三次连点只切一次：用掉这一对就清空，第三下重新算「第一下」。
    lastTapRef.current = null;
    setImmersive(!immersive);
  };

  /** 触摸滚动会把这一串指针事件 CANCEL 掉：清掉按下记录，免得它跟后面某一下凑成「双击」。 */
  const onChatPointerCancel = () => {
    tapDownRef.current = null;
    lastTapRef.current = null;
  };

  /**
   * 沉浸态落到 `<html data-immersive>` 的那一枚属性：**房间标签条**在 `App.tsx` 里
   * （与本页是兄弟节点，组件树里够不着），由 `app.module.css` 的一条规则按这枚属性收起它。
   * 与主题落 `data-theme` 是同一处口径（文档根上的属性 + 一条 CSS 规则）。
   * 只在沉浸时写、离开即删：这枚属性不该影响清单页或别的页面。
   */
  useEffect(() => {
    if (!immersive) return;
    document.documentElement.dataset.immersive = "true";
    return () => {
      delete document.documentElement.dataset.immersive;
    };
  }, [immersive]);

  /**
   * 展开礼物栏（**只开、不关**）：点折叠头那条路走 `toggleGiftDock`（它能收），
   * 这里给拖动分割条用 —— 礼物栏折叠着时它只有折叠头那么高，份额驱动不了它，
   * 所以「拖开」这一下与点「展开」同源：同一套互斥（五者最多开一个）也照旧。
   */
  const openGiftDock = useCallback(() => {
    setGiftOpen(true);
    setPanel(null);
    setAdminOpen(false);
    setAdminConfirm(null);
  }, []);

  /**
   * 系统返回手势第 2 级：在房间页 → 回房间列表。`onBack` 就是房间头那枚圆形返回键
   * （`App.tsx` 传给它的正是 store 的 `closeRoom`），两条入口同源。
   */
  useEffect(
    () =>
      registerBackHandler(BACK_PRIORITY.page, () => {
        onBack();
        return true;
      }),
    [onBack],
  );

  /**
   * 系统返回手势第 1 级：面板先关，顺序与「打开任何一个就把别的收起来」那条互斥规则同一批。
   *
   * **常驻注册**（`RoomView` 挂着就注册），认不认领由处理器里的**当下状态**决定，而不是由
   * 「注册 == 开着」决定：注册 / 注销要等 effect（一次提交之后才跑），面板刚开或刚关的那一帧里
   * 会剩下一个与界面不符的处理器 —— 该认领的返回被放走、或该放走的被吞掉。
   * 关的动作复用界面上既有的那三条：`onPanel(null)` 是点面板外 / 再点一次工具按钮走的路，
   * 两个 `toggle` 是 `⋯` 菜单里那条「收起房管面板」与礼物栏按钮走的路，不另写一套状态变更。
   * 每次渲染的最新状态与动作**在布局阶段**写进 ref（与 `MessageList` 的 `stateRef` 同一套写法）：
   * 写在渲染期会让被丢弃的那一版渲染把值漏进 ref，而处理器要的只是「最后一次提交的值」。
   *
   * **沉浸态排在最前**（issue #1）：沉浸态里房间头与标签条都不在场上（返回键、标签都没了），
   * 返回手势该做的第一件事是**退出沉浸**，而不是把整个房间页关掉 —— 后者会连房间一起丢，
   * 从沉浸态里「一步退回列表页」不是用户按一次返回的意图。
   */
  const backRef = useRef({
    immersive,
    panel,
    adminOpen,
    giftOpen,
    onPanel,
    toggleAdminPanel,
    toggleGiftDock,
    setImmersive,
  });
  useLayoutEffect(() => {
    backRef.current = {
      immersive,
      panel,
      adminOpen,
      giftOpen,
      onPanel,
      toggleAdminPanel,
      toggleGiftDock,
      setImmersive,
    };
  });

  useEffect(
    () =>
      registerBackHandler(BACK_PRIORITY.panel, () => {
        const now = backRef.current;
        if (now.immersive) {
          now.setImmersive(false);
          return true;
        }
        if (now.panel !== null) {
          now.onPanel(null);
          return true;
        }
        if (now.adminOpen) {
          now.toggleAdminPanel();
          return true;
        }
        if (now.giftOpen) {
          now.toggleGiftDock();
          return true;
        }
        return false;
      }),
    [],
  );

  // 切房间（多标签）时把本页的**临时界面状态**清干净（用户 2026-09-13 第 2 条）：
  // 多标签只是切渲染，`RoomView` 的组件实例被 React 复用，本地状态不显式清就会串台 ——
  // 最刺眼的是上一个房间的房管面板 / 待确认写操作还开着（`adminOpen` / `adminConfirm`），
  // 还有输入区那三个弹出面板（`panel`）、上一个房间的行菜单、举报目标与 @ 目标（`pendingAction`）。
  // 输入草稿**不在这里重置**：它按房间各留一份，由 `Composer` 自己按 `roomId` 存取（契约 C1）。
  // 这里用 effect 而不是给 `RoomView` 加 `key`：加 key 会把整棵子树重挂（含 `Composer`），
  // 草稿与「不是整页重挂」的口径相冲；弹幕列表的滚动/跟随另用 `MessageList` 的 key 处理（见下）。
  useEffect(() => {
    // 规则给的替代路径在这里都不成立：①「加 `key`」（React 官方的整套重置法）会把整棵子树
    // 重挂，`Composer` 的按房间草稿跟着丢，上面那段注释解释了为什么不走它；②「从触发方改」
    // 也不成立 —— 切房间的真相在 store（`room.room_id` 变了），点标签只是其中一条路
    // （列表页进房、返回手势、断开重连都会改它）。这个 effect 因此就是那个**同步点**。
    // oxlint-disable-next-line react/set-state-in-effect
    setShowLogs(false);
    setHeaderMenu(null);
    setMessageMenu(null);
    setReportTarget(undefined);
    setReasonId("");
    setGiftOpen(false);
    setPanel(null);
    setAdminOpen(false);
    setAdminConfirm(null);
    setPendingAction(null);
    // 沉浸态同样是**本页的临时界面状态**：切标签（多标签只是切渲染，组件实例被复用）
    // 必须回到非沉浸态 —— 上一个房间收起的那些区块不该跟着新房间一起消失。
    setImmersive(false);
  }, [room.room_id, setImmersive]);

  // 房管入口按身份出现（第 3 条，契约 C6）：面板打开期间房管与主播身份均失效
  // （事件更新 / 会话重建）就收起面板与确认条 —— 不能让「无权限还开着房管面板」这一档留下来。
  // 身份不是本组件的事件（它从 store 的事件更新里来），因此这里就是同步点；
  // 也不改成「渲染期按 `canAdmin` 屏蔽面板」—— 那会让身份恢复时面板自己弹回来，是另一种行为。
  useEffect(() => {
    if (canAdmin) return;
    // oxlint-disable-next-line react/set-state-in-effect
    setAdminOpen(false);
    setAdminConfirm(null);
  }, [canAdmin]);

  // 房管面板展开期间的静默轮询（issue202609242158 第 8 条 A2）：面板开着才跑、收起即停
  // （卸载 / 切房由 effect 清理停掉）。打开面板时 `toggleAdminPanel` 已同步重拉过一次，
  // 因此首拍按周期排。
  useEffect(() => {
    if (!adminOpen) return;
    return startAdminPolling(room.room_id);
  }, [adminOpen, room.room_id, startAdminPolling]);

  useEffect(() => {
    if (loggedIn) void loadBalance();
  }, [loggedIn, loadBalance]);

  // 进房间就把表情加载好：输入区的「将发送」预览要靠它把表情名换成图片，
  // 若等到用户打开面板才加载，打字时就没有可匹配的表情（预览会静默失效）。
  useEffect(() => {
    if (loggedIn) void loadEmotes(room.room_id);
  }, [loggedIn, loadEmotes, room.room_id]);

  // 主站「我的表情」与房间无关（room_id=0），进房间且会话就绪后拉一次即可；
  // 拉成功之后 store 会跳过重复请求，面板打开时若上次失败才会再试（见 Composer）。
  useEffect(() => {
    if (loggedIn) void loadOwnedEmotes();
  }, [loggedIn, loadOwnedEmotes]);

  // 本人在这房间的身份（房管入口的权限前置）。进房取一次即可，之后的更新走事件。
  useEffect(() => {
    if (loggedIn) void loadRoomIdentity(room.room_id);
  }, [loggedIn, loadRoomIdentity, room.room_id]);

  // 房管数据**进房就加载**（用户 2026-09-13 第 4 条：「连接到有房管权限的直播间时就加载好
  // 房管的数据」）：身份是**异步到的**（`room_session` 一次 + 事件更新），所以 `canAdmin`
  // 必须在依赖里 —— 没有它，进房那一帧身份还是 false，这一批数据就永远不会被拉。
  // 打开面板时再静默重拉一次（见 `toggleAdminPanel`），保证看到的是新鲜的。
  useEffect(() => {
    if (!canAdmin) return;
    void loadAdmin(room.room_id);
  }, [canAdmin, loadAdmin, room.room_id]);

  useEffect(() => {
    if (reportTarget) void loadReportReasons();
  }, [reportTarget, loadReportReasons]);

  // 字号在下面有两处用处：① 标题那一趟测量（依赖数组里只能放**变量** —— `prefs["ui.font_scale"]`
  // 这种带下标的表达式会被 `react-hooks/exhaustive-deps` 判成「复杂表达式」而拒绝静态检查）；
  // ② 交给弹幕列表。抄成一个变量语义一字不变，规则也就能真的盯住它。
  const fontScale = prefs["ui.font_scale"];

  // 标题的循环滚动是**量出来的**：一份文字的宽度 vs 可视宽度（ResizeObserver 同时盯容器与
  // 文字本身，所以窗口改宽 / 字号滑杆 / 换标题都会重新判一次）。滚动是纯 CSS 的
  // `translateX(-50%)` 无限循环，布局宽度自始至终不变（`.title` 是 `overflow: hidden` +
  // `min-width: 0` 的 flex 项），因此**不会引起布局跳动**。
  useEffect(() => {
    const viewport = titleViewportRef.current;
    const copy = titleCopyRef.current;
    if (!viewport || !copy) return;
    const measure = () => {
      const textWidth = copy.offsetWidth;
      const overflow = textWidth > viewport.clientWidth + 0.5;
      setTitleScrolls(overflow);
      // 匀速约 40px/s 走完一份标题，最少 6s 一圈（短标题不该飞快闪一下）
      setTitlePeriod(overflow ? Math.max(6, Math.round(textWidth / 40)) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(copy);
    return () => observer.disconnect();
    // `room.room_id` 也在依赖里：两个房间的标题文字可能一样，但「在线 / 看过」两个数值
    // 占的宽度不同、可视宽度因此不同，只拿文字当依赖会留下上一个房间量出的滚动结论。
    // `immersive` 同理：沉浸态里房间头整块不在场上（两个 ref 都是 null），退出时它才重新挂上，
    // 这一趟必须重新量一次 —— 否则短标题会带着上一轮的结论回来（ResizeObserver 绑在新节点上，
    // 但 `measure()` 得有人叫第一声）。
  }, [titleText, fontScale, room.room_id, immersive]);

  const { chatRows, giftRows } = splitGiftRows(rows, prefs);
  // 独立礼物栏是否存在由 `ui.gift_panel` 单独决定（弹幕流那一头由 `ui.gift_in_danmaku` 管，
  // 见 splitGiftRows）；折叠态是它自己的本地状态，与偏好无关。
  // `ui.gift_collapse_cheap` 在 `splitGiftRows` 里对**两头各折一次**（弹幕区与礼物栏都折，
  // issue 2609171849 第 5 条）—— `chatRows` 因此也可能带一条 `cheap` 桶行，本组件不必额外处理。
  const giftPanel = prefs["ui.gift_panel"];
  // 共享分区的顺序与份额（契约 §8）：两枚都是**持久化**的偏好，重开应用保持。
  const giftPaneOnTop = prefs["ui.gift_pane_on_top"];
  // 礼物栏内按 kind 筛选（契约 §8）：空数组 = 全显示。
  const giftPaneKinds = prefs["ui.gift_pane_kinds"];
  /* 三族图标（`public/icons/`，由 Vite 原样拷到产物根）：礼物是从官方雪碧图里切出来的矢量，
     SC 与舰长是官方位图。三枚都是**装饰**，`alt=""` —— 可读名由按钮的 `title` / 文本给。 */
  const GIFT_ICON: Partial<Record<MessageKind, string>> = {
    gift: "/icons/gift.svg",
    superchat: "/icons/sc.png",
    guard: "/icons/guard.png",
  };

  /**
   * 独立礼物栏折叠态的按 kind 汇总（docs/ui.md §5.3）：礼物 / SC / 大航海**各自一组**。
   *
   * **单位已统一为元**（2026-09-16，契约 §5「金额单位」）：`amountText` 把礼物 / 大航海的
   * 金瓜子按 `÷1000` 换算，SC 的原值本来就是元 —— 三组因此**同单位**，先前那条
   * 「金瓜子与元不加到一起」的红线随之失效。**分组结构本身保留**：是否合并成一条合计
   * 由用户拍板，本轮不改结构（docs/ui.md §5.3）。
   *
   * 条数取连击折叠后的**次数之和**（`DisplayRow.count`），金额取折叠后累加的 `message.amount`
   * —— 与 `toDisplayRows` 同源，不另立一套口径。空组不出现（没有 SC 就不显示 SC 那一格）。
   *
   * 输入是 `giftStatRows(giftRows, prefs)` 而不是 `giftRows`：`ui.gift_exclude_cheap_stats`
   * 打开时低价礼物整条桶**不进统计**（issue 2609162056 第 4 条）。这枚键只改这一处的口径 ——
   * 礼物栏的条目由 `giftRows` 渲染，与它无关；「礼物 / SC（N）」那个 N 也跟着这里走
   * （它数的就是这份汇总的条数，不是礼物栏的行数）。
   */
  const giftStat = giftStatRows(giftRows, prefs);
  /** 三族各自的条数与金额（**筛选条**那三个格）。空组不出现。 */
  const giftGroups = GIFT_KINDS.map((kind) => {
    const group = giftStat.filter((row) => row.message.kind === kind);
    return {
      kind,
      label: KIND_LABEL[kind],
      count: group.reduce((sum, row) => sum + row.count, 0),
      // 三族单位已统一为元（`amountYuan`），因此可以跨族相加。
      yuan: group.reduce(
        (sum, row) => sum + amountYuan(row.message.amount, row.message.kind),
        0,
      ),
    };
  }).filter((group) => group.count > 0);

  /** 三族合计（**总计条**）。条数与金额都与筛选条同源 —— 统计链是「先筛选、后汇总」。 */
  const giftTotalCount = giftGroups.reduce((sum, group) => sum + group.count, 0);
  const giftTotalYuan = giftGroups.reduce((sum, group) => sum + group.yuan, 0);
  /** 礼物栏内正在按 kind 筛选（契约 §8 `ui.gift_pane_kinds` 非空）。 */
  const giftFiltering = giftPaneKinds.length > 0;

  /**
   * 总计条的文案（需求 2026-09-26）：`礼物 12条 ¥1,168.7`。
   *
   * **开启筛选后只给条数、不给金额** —— 金额已按族分列在筛选条上，总计再压成一个总额
   * 就是同一份数的第二次出现，两个数字各差一次筛选就会互相打架。
   *
   * 统计集空的两档沿用改前的口径：礼物栏里还有条目（被 `ui.gift_exclude_cheap_stats` 剔出
   * 统计的低价礼物）时写「低价礼物已剔除」，而不是「0 条」—— 列表里明明有东西。
   */
  const giftTotalText =
    giftGroups.length > 0
      ? `礼物 ${giftTotalCount}条${giftFiltering ? "" : ` ${yuanText(giftTotalYuan)}`}`
      : giftRows.length > 0
        ? "低价礼物已剔除"
        : "礼物 0条";

  /** 点筛选条上的一格：选中的族取并集，取消最后一个即回到「全显示」（空数组）。 */
  const toggleGiftKind = (kind: (typeof GIFT_KINDS)[number]) =>
    onPrefs({
      "ui.gift_pane_kinds": giftPaneKinds.includes(kind)
        ? giftPaneKinds.filter((item) => item !== kind)
        : [...giftPaneKinds, kind],
    });

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotice("已复制");
    } catch (error) {
      onNotice(`复制失败：${String(error)}`);
    }
  };

  /** 行右键菜单（issue #8：举报 / @ / 回复等一律收到菜单里）。 */
  const messageMenuItems = (message: Message): MenuItem[] => {
    const mine = session !== undefined && message.uid === session.uid;
    const isDanmaku = message.kind === "danmaku";
    // 房管三项的可用条件：自己是房管或主播 + 目标有 uid + 不是自己。
    const canModerate = canAdmin && !mine && message.uid !== 0;
    const moderateHint = !canAdmin
      ? "你不是本直播间主播或房管"
      : mine
        ? "这是你自己"
        : message.uid === 0
          ? "游客没有 UID，无法管理"
          : undefined;
    return [
      {
        label: "复制内容",
        disabled: message.content.length === 0,
        hint: message.content.length === 0 ? "这条没有文字内容" : undefined,
        onSelect: () => void copyText(message.content),
      },
      {
        label: "复制昵称",
        disabled: message.uname.length === 0,
        onSelect: () => void copyText(message.uname),
      },
      {
        label: "＠TA",
        disabled: !isDanmaku || message.uname.length === 0 || mine,
        hint: mine ? "这是你自己" : "只有弹幕能 @",
        onSelect: () =>
          setPendingAction({ kind: "mention", message, token: Date.now() }),
      },
      {
        label: "回复",
        disabled: !isDanmaku || mine,
        hint: mine ? "这是你自己" : "只有弹幕能回复",
        onSelect: () =>
          setPendingAction({ kind: "reply", message, token: Date.now() }),
      },
      {
        label: "屏蔽此用户",
        disabled: message.uid === 0,
        hint: message.uid === 0 ? "游客没有 UID，无法屏蔽" : undefined,
        onSelect: () =>
          onPrefs({
            "filter.uids": [...new Set([...prefs["filter.uids"], message.uid])],
          }),
      },
      // 房管三项（issue #3）：**权限前置**——既不是主播也不是房管就置灰并说明原因，
      // 绝不做成「点了再看上游错误码」。确认条会带上对象与时长。
      {
        label: "禁言…",
        danger: true,
        disabled: !canModerate,
        hint: moderateHint,
        onSelect: () =>
          setAdminConfirm({
            kind: "mute",
            uid: message.uid,
            uname: message.uname,
            hour: 0,
          }),
      },
      {
        label: "拉黑",
        danger: true,
        disabled: !canModerate,
        hint: moderateHint,
        onSelect: () =>
          setAdminConfirm({
            kind: "blacklist_add",
            uid: message.uid,
            uname: message.uname,
          }),
      },
      {
        label: "解除禁言",
        disabled: !canModerate,
        hint: moderateHint,
        onSelect: () =>
          setAdminConfirm({
            kind: "unmute",
            uid: message.uid,
            uname: message.uname,
          }),
      },
      {
        label: "打开主页",
        disabled: message.uid === 0,
        hint: message.uid === 0 ? "游客没有主页" : undefined,
        onSelect: () => void openProfile(message.uid),
      },
      {
        label: "举报",
        disabled: !isDanmaku || message.upstream_id.length === 0 || !loggedIn,
        hint: !loggedIn
          ? "需登录后举报"
          : message.upstream_id.length === 0
            ? "缺少上游标识，无法举报"
            : undefined,
        onSelect: () => setReportTarget(message),
      },
    ];
  };

  /** 执行待确认的房管写操作；成功才收起确认条（失败时的原因由 store 的 error 条原样展示）。 */
  const commitAdmin = async () => {
    if (!adminConfirm) return;
    if (await runAdmin(room.room_id, adminConfirm)) setAdminConfirm(null);
  };

  const headerMenuItems: MenuItem[] = [
    // 房管入口（第 3 条，契约 C6）：确认是本房间主播或房管才出现这一项。
    // 房管判据来自 `RoomSession.is_admin`，主播判据则是登录 uid 与 `anchor_uid` 相同；
    // 两者都对不上 = 无权限 = **没有这个入口**，而不是置灰让用户点开看上游报错。
    ...(canAdmin
      ? [
          {
            label: adminOpen ? "收起房管面板" : "房管面板",
            onSelect: toggleAdminPanel,
          },
        ]
      : []),
    { label: "刷新连接", onSelect: onRefresh },
    {
      label: "断开连接",
      disabled: !room.connected,
      hint: room.connected ? undefined : "当前未连接",
      onSelect: onDisconnect,
    },
    {
      label: showLogs ? "隐藏日志" : "显示日志",
      onSelect: () => setShowLogs((value) => !value),
    },
  ];

  return (
    <div className={styles.shell} data-immersive={String(immersive)}>
      {/* 沉浸模式（issue #1）：房间头整块**不渲染**（标题 / 返回 / 状态点 / ⋯ 一起收起）。
          这里是条件渲染而不是 CSS 藏起来：收起 = 这一段不在场上（下面输入区 / 举报条 /
          房管面板 / 日志块同理），于是弹幕区自己长高，虚拟列表按 `MessageList` 的
          `ResizeObserver` 重新量高。 */}
      {/* 房间头（用户 2026-09-13 的纠正）：**一排**——
          ◀返回 · ●状态点 · 直播间标题（放不下就循环滚动） ······ 在线 · 看过 · ⋯。
          标题不再另起一排；电池也不在这排（挪到输入区的发送按钮左侧），这排腾给
          「当前在线」与「看过」两个数值。连接状态仍可在房间标签页的圆点上看到（见 DOT）。 */}
      {!immersive && (
        <div className={styles.roomHeader} data-testid="db-room-header">
          <div className={styles.headerBar} data-testid="db-room-header-bar">
            <button
              className={styles.ctlRound}
              data-testid="db-header-back"
              title="返回房间列表"
              aria-label="返回房间列表"
              onClick={onBack}
            >
              {/* 图标规范（返回与 ⋯ **共用同一套**，用户 2026-09-13：「可能他们本就不一致，
                  只调 size 没用？」——上一版只把两枚的墨迹粗细都调成 1.5，形状与光学尺寸仍各走各的）：
                  `viewBox="0 0 24 24"` + `.ctlIcon`（24 × 24 盒，缩放系数正好 1）+ `stroke-width 1.75`
                  + `stroke-linecap/linejoin="round"`；**墨迹居中于 (12,12)**，主轴尺寸都是 16 单位
                  （箭头的高 = ⋯ 的宽）。改前箭头是 `M15 4.5 7.5 12l7.5 7.5`（墨迹 9 × 16.5、
                  居中点偏左 0.75）。 */}
              <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M15 4.875 9 12l6 7.125"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* 状态点 = **外壳 12px（热区 / 悬停面，与改前同尺寸）+ 里面一颗 10px 的圆点**。
                两件事分开写：外壳承 `title` / `aria-label` / `data-*`，圆点承颜色 ——
                这样「缩短到 10px」只是看得见的那颗点变小，热区一点没动。 */}
            <span
              className={styles.liveDotBox}
              data-testid="db-live-dot-box"
              data-live={String(room.live_status)}
              data-state={liveKind}
              role="img"
              title={liveText}
              aria-label={liveText}
            >
              <span
                className={`${styles.liveDot} ${LIVE_DOT_CLASS[liveKind]}`}
                data-testid="db-live-dot"
              />
            </span>
            {/* 标题紧跟状态点：**同一排**、左边缘在状态点右侧。放不下时轨道循环滚动，
                两份拷贝首尾相接（动画走 -50% 正好一份），文字区之外一律裁掉 */}
            <span
              className={styles.title}
              data-testid="db-room-title"
              title={titleText}
              ref={titleViewportRef}
            >
              <span
                className={styles.titleTrack}
                data-testid="db-title-track"
                data-scroll={String(titleScrolls)}
                style={titlePeriod > 0 ? { animationDuration: `${titlePeriod}s` } : undefined}
              >
                <span className={styles.titleItem}>
                  <span className={styles.titleText} data-testid="db-title-copy" ref={titleCopyRef}>
                    {titleText}
                  </span>
                </span>
                {titleScrolls && (
                  <span className={styles.titleItem} aria-hidden="true">
                    <span className={styles.titleText}>{titleText}</span>
                  </span>
                )}
              </span>
            </span>
            {roomStats?.online !== undefined && (
              <span className={styles.balance} title="当前在线">
                在线 {formatCount(roomStats.online)}
              </span>
            )}
            {roomStats?.watched !== undefined && (
              <span className={styles.balance} title="累计看过">
                看过 {formatCount(roomStats.watched)}
              </span>
            )}
            <button
              className={styles.ctlRound}
              data-testid="db-header-more"
              title="刷新 / 断开 / 日志"
              aria-label="更多"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setHeaderMenu({ x: rect.left - 120, y: rect.bottom + 2 });
              }}
            >
              {/* ⋯ 画成**矢量**（三个圆点）而不是文字字形：文字字形的墨迹厚度由字体决定
                  （实测 Chromium 下 14px 的 U+22EF 墨迹只有 1px，WebKit 又是另一套字体）。
                  与返回**同一套规范**：圆点直径 = **2 × 描边宽**（= 3.5。Material 同款比例 ——
                  一个圆点就是一个零长度描边段的圆头，所以「粗细」与描边同一件事），
                  相邻圆点中心距 6.25（缝 2.75），行宽 16 = 返回箭头的高，整体居中于 (12,12)。
                  改前是 r = 0.75（直径 1.5）、跨度 11.5、居中但明显偏轻。
                  盒子仍是 `.ctlIcon`（24 × 24），控件尺寸一点没动。 */}
              <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5.75" cy="12" r="1.75" fill="currentColor" />
                <circle cx="12" cy="12" r="1.75" fill="currentColor" />
                <circle cx="18.25" cy="12" r="1.75" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* 弹幕区与礼物栏**共享一块上下分区**（issue #8，契约 §8）：默认弹幕在上、礼物在下，
          中间一条可拖动的分割条（热区 ≥ 8px）；长按任一栏 0.5s 拖拽换位。
          两栏的高度比例与上下顺序都落 prefs，重开应用保持；`ui.gift_panel` 关掉时
          共享区域退化为弹幕区全高、分割条不渲染（见 SplitPanes）。
          唯一的生长区从「弹幕列表」变成「这一块」：面板 / 房管面板 / 输入区展开时挤的是它。
          **沉浸模式（issue #1）只收标题栏、房间标签条与输入区**，所以这一块在沉浸态里照旧在场；
          双击落点仍是弹幕那一栏（`.chatWrap`，见下），礼物栏上的双击与它无关。 */}
      <SplitPanes
        giftOnTop={giftPaneOnTop}
        ratio={prefs["ui.gift_pane_ratio"]}
        fontScale={fontScale}
        giftCollapsed={!giftOpen}
        onRatio={(value) => onPrefs({ "ui.gift_pane_ratio": value })}
        onSwap={() => onPrefs({ "ui.gift_pane_on_top": !giftPaneOnTop })}
        onExpand={openGiftDock}
        danmaku={
          <div
            className={styles.chatWrap}
            data-testid="db-chat-wrap"
            onPointerDown={onChatPointerDown}
            onPointerUp={onChatPointerUp}
            onPointerCancel={onChatPointerCancel}
          >
            <MessageList
              key={room.room_id}
              rows={chatRows}
              anchorUid={room.anchor_uid}
              prefs={prefs}
              onMenu={(message, at) => setMessageMenu({ at, message })}
            />
            {/* 互动/进场消息共用单槽位（ui.interact_single_slot，docs/ui.md §4.8）：
                浮在弹幕区底部偏左，显示最新一条、下一条快速顶掉上一条，空闲淡出。
                关掉开关时互动消息退回弹幕列表行（由 filtering.toDisplayRows 控制）。 */}
            {prefs["ui.interact_single_slot"] && <InteractSlot />}
          </div>
        }
        /* 独立礼物栏（issue 2609152029 第 5 条改成**每个礼物 / SC / 大航海一条**；
           2026-09-16 第 2 条再进一步：**与弹幕区同一套呈现** —— 行就是 MessageRow、
           列表就是 MessageList（scope="gift"）：一样的布局（头像列 / 身份行 / 正文块 /
           时间戳）、一样的背景色、一样的自动滚动与「跟随 / 暂停 / 回到最新」。它自己的
           滚动位置与虚拟列表状态是**另一份实例**，两边互不影响。
           是否出现由 `ui.gift_panel` 决定（管弹幕流那一头的是 `ui.gift_in_danmaku`，
           两枚各自独立：都开 = 默认形态，同一批消息两处都渲染）。
           折叠头带 `data-pane-head`：它是**这一栏的最小高度**（SplitPanes 实测）。
           空态文案在 `empty` 上（判据「哪一套行算本场」留在调用方）。 */
        gift={
          giftPanel ? (
            /* 礼物栏内部就这三段：总计条 / 列表 / 筛选条，由 `.giftPane` 一个容器排。
               **总计条永远贴屏幕中心（贴分割条）**、筛选条永远在外侧，顺序靠
               `flex-direction` 翻转（`data-on-top`）—— 与 `.panes` 翻两栏同一套口径，
               不搬节点：列表的滚动位置与虚拟列表状态不受礼物栏在上在下影响。
               ⚠ 不能指望外层 `.panes` 的 `column-reverse` 把这里也翻过来：它只翻两栏。

               总计条带 `data-pane-head`：折叠态它是唯一一条，也就是这一栏的最小高度
               （SplitPanes 实测它写进 `--gift-min-h`）。展开态**没有**折叠头 ——
               「收起」的入口就是总计条右端那枚图标。 */
            <div
              className={styles.giftPane}
              data-testid="db-gift-pane"
              data-on-top={giftPaneOnTop ? "true" : undefined}
            >
              {/* 总计条：贴中心；**它就是拖动热区**（需求 2026-09-26，见 SplitPanes）。
                  文案 `礼物 12条 ¥1,168.7`；开启筛选后只给条数（金额已在筛选条上分列）。 */}
              <div className={styles.giftPaneTotal} data-testid="db-gift-total" data-pane-head>
                <span className={styles.giftPaneTotalText} data-testid="db-gift-total-text">
                  {giftTotalText}
                </span>
                <button
                  type="button"
                  className={styles.ctlRound}
                  data-testid="db-gift-toggle"
                  aria-expanded={giftOpen}
                  aria-label={giftOpen ? "收起礼物栏" : "展开礼物栏"}
                  title={giftOpen ? "收起礼物栏" : "展开礼物栏"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={toggleGiftDock}
                >
                  {/* 返回箭头旋转 90°（展开态朝上、收起态朝下），图标规范同 §3.1。 */}
                  <svg
                    className={styles.ctlIcon}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    data-dir={giftOpen ? "up" : "down"}
                  >
                    <path
                      d="M19.125 12H4.875M10.875 6 4.875 12l6 6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              {giftOpen && (
                <MessageList
                  rows={giftRows}
                  anchorUid={room.anchor_uid}
                  prefs={prefs}
                  scope="gift"
                  empty={giftRows.length === 0 ? "本场还没有礼物" : undefined}
                  onMenu={(message, at) => setMessageMenu({ at, message })}
                />
              )}
              {/* 筛选条：**远离**中心的外侧。三格 = 三族的分类金额，点击切换筛选
                  （不选 = 全显示，选多项 = 并集，契约 §8 `ui.gift_pane_kinds`）。
                  放在外侧是为了不与热区抢点击 —— 热区会吞掉它覆盖的那 8px。 */}
              {giftOpen && (
                <div className={styles.giftPaneFilter} data-testid="db-gift-filter">
                  {giftGroups.map((group) => {
                    const on = giftPaneKinds.includes(group.kind);
                    return (
                      <button
                        key={group.kind}
                        type="button"
                        className={styles.giftPaneChip}
                        data-testid="db-gift-chip"
                        data-kind={group.kind}
                        aria-pressed={on}
                        title={`${group.label} ${group.count} 条${
                          group.yuan > 0 ? ` · ${yuanText(group.yuan)}` : ""
                        }（点击筛选）`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => toggleGiftKind(group.kind)}
                      >
                        <img
                          className={styles.giftPaneIcon}
                          src={GIFT_ICON[group.kind]}
                          alt=""
                          width={16}
                          height={16}
                        />
                        <span>{group.yuan > 0 ? yuanText(group.yuan) : `${group.count} 条`}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null
        }
      />

      {messageMenu && (
        <ContextMenu
          at={messageMenu.at}
          items={messageMenuItems(messageMenu.message)}
          onClose={() => setMessageMenu(null)}
        />
      )}

      {/* 日志块与举报条都不是「弹幕区」也不是「礼物区」：沉浸态里一并收起
          （入口在房间头 ⋯ 菜单里，那块本来就收起来了）。 */}
      {!immersive && showLogs && (
        <div className={styles.logs}>
          {logs.length === 0
            ? "（暂无日志）"
            : logs.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}

      {!immersive && reportTarget && (
        <div className={styles.reportBar}>
          <span className={styles.roomMeta}>
            举报「{reportTarget.content.slice(0, 24)}」
          </span>
          <select
            value={reasonId}
            onChange={(event) => setReasonId(event.target.value)}
          >
            <option value="">
              {reportReasons.length === 0 ? "理由清单加载中…" : "选择举报理由…"}
            </option>
            {reportReasons.map((item) => (
              <option key={item.id} value={String(item.id)}>
                {item.reason}
              </option>
            ))}
          </select>
          <button
            disabled={reasonId === ""}
            onClick={() => {
              const picked = reportReasons.find(
                (item) => String(item.id) === reasonId,
              );
              if (!picked || !reportTarget) return;
              const target = reportTarget;
              setReportTarget(undefined);
              setReasonId("");
              void onReport(target, picked);
            }}
          >
            提交举报
          </button>
          <button
            onClick={() => {
              setReportTarget(undefined);
              setReasonId("");
            }}
          >
            取消
          </button>
        </div>
      )}

      {/* 房管面板（issue #3）：三块列表收成三个 tab，单点在右键菜单、批量在多选动作条。
          入口只在 `canAdmin` 时出现（第 3 条，契约 C6），因此渲染出来就是主播或房管身份 ——
          面板里不再有身份提示；打开即静默刷新（第 5 条），所以读取失败的**错误条必须留在面板里**
          （没有手动刷新按钮，错误是唯一的反馈）。
          它是文档流里的一块（不是浮层），与输入区的面板一样只挤压弹幕列表；
          与输入区面板 / 独立礼物栏**互斥**（第 4 条）：开它就关那四个（见上面的三个入口）。
          沉浸态里不渲染（它是输入区上方的一块，入口在房间头 ⋯ 菜单里）。 */}
      {!immersive && adminOpen && (
        <AdminPanel
          silent={adminSilent}
          blacklist={adminBlacklist}
          keywords={adminKeywords}
          errors={adminErrors}
          busy={adminBusy}
          onCheck={(tab, value) => checkAdminMember(room.room_id, tab, value)}
          onLoadMore={(tab) => loadAdminMore(room.room_id, tab)}
          onConfirm={setAdminConfirm}
          onClose={() => {
            setAdminOpen(false);
            setAdminConfirm(null);
          }}
        />
      )}

      {/* 二次确认条：所有房管写操作都先经过它，文案说清对象与时长（不可逆）。
          它跟着房管面板走，沉浸态里同样不渲染。 */}
      {!immersive && adminConfirm && (
        <div className={styles.adminConfirm} data-testid="db-admin-confirm">
          <span className={styles.roomMeta}>{adminActionText(adminConfirm)}</span>
          {adminConfirm.kind === "mute" && (
            <select
              className={styles.adminSelect}
              value={String(adminConfirm.hour)}
              onChange={(event) =>
                setAdminConfirm({
                  ...adminConfirm,
                  hour: Number(event.target.value),
                })
              }
            >
              {MUTE_HOURS.map((item) => (
                <option key={item.hour} value={item.hour}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
          <button disabled={adminBusy} onClick={() => void commitAdmin()}>
            {ADMIN_CONFIRM_LABEL[adminConfirm.kind]}
          </button>
          <button onClick={() => setAdminConfirm(null)}>取消</button>
        </div>
      )}

      {/* 输入区（弹幕输入框 + 工具行 + 字数提示）与它上方那三个弹出面板（表情 / 短语 / 筛选）
          整块不渲染 —— 收起清单里的「输入区」就是把 `Composer` 这一棵子树摘掉，
          面板 / 引用条 / 预览 / 浮片都跟着走，不必逐个列。
          草稿不会丢：它按 `身份:房间` 存在 `Composer` 模块级的 Map 里（契约 C1），
          再挂回来时原样取回。 */}
      {!immersive && (
        <Composer
          roomId={room.room_id}
          // 草稿的分键是 `${identityKey}:${roomId}`（契约 C1 修订）：换房、换号都各留一份，
          // 所以这里既不去清草稿、也不给 `Composer` 加 `key`（重挂会连草稿一起丢）。
          identityKey={session?.logged_in ? String(session.uid ?? 0) : "guest"}
          danmakuLength={danmakuLength}
          disabled={!room.connected}
          loggedIn={loggedIn}
          lastOutcome={lastOutcome}
          lastDetail={lastDetail}
          emotes={emotes}
          ownedEmotes={ownedEmotes}
          ownedError={ownedError}
          balance={balance}
          onRefreshBalance={() => void loadBalance()}
          pendingAction={pendingAction}
          panel={panel}
          onPanel={onPanel}
          prefs={prefs}
          onPrefs={onPrefs}
          onSend={onSend}
          onRetryOwned={() => void loadOwnedEmotes(true)}
          onNotice={onNotice}
        />
      )}

      {/* 房间头 ⋯ 的菜单：它的触发钮在收起的房间里，沉浸态里也没有理由浮着
          （行右键菜单不在此列：它属于弹幕行，那一块在沉浸态里照旧在场上）。 */}
      {!immersive && headerMenu && (
        <ContextMenu
          at={headerMenu}
          items={headerMenuItems}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </div>
  );
}
