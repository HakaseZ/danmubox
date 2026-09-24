import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { BACK_PRIORITY, registerBackHandler } from "./back";
import { AccountManager } from "./components/AccountManager";
import { RoomList } from "./components/RoomList";
import { RoomView } from "./components/RoomView";
import { roomTabName, toDisplayRows } from "./filtering";
import { LIVE_DOT_CLASS, LIVE_TEXT, liveKindOf } from "./liveKind";
import { useApp } from "./store";
import styles from "./app.module.css";
// 房间载荷类型：`RoomView` 这个名字在本文件已经是上面那个组件，类型只好另起一个别名。
import type { ConnState, RoomView as RoomViewState } from "./types";

/**
 * 越过这个位移（px）才算「拖」而不是「点」。
 * 取 5：一档触摸抖动实测在 2–3px 内，4 的倍数又正好是标签之间的间距（`--sp-1`），
 * 阈值再大就会出现「想让位却还在原位」的死区。
 */
const TAB_DRAG_THRESHOLD_PX = 5;

/**
 * 触摸下先**按住**这么久（期间位移不超过阈值）才算把标签「拿起来」。
 * 触摸的横向滑动要留给「看更多标签」（`touch-action: pan-x` 把它交给了浏览器），
 * 于是排序只能从「按住」这件事上分出来 —— 与手机桌面上挪图标是同一套手势（400ms）。
 */
const TAB_HOLD_MS = 400;

/** 一次按压 / 拖动（`pointerdown` 那一刻建，松手 / 取消 / 卸载时拆）。 */
interface TabPress {
  pointerId: number;
  roomId: number;
  /** 起点（视口坐标）。 */
  x: number;
  y: number;
  /** 触摸要等按住计时器；鼠标 / 触控笔一动就算。 */
  holdOnly: boolean;
  timer: number | null;
  /** 已「拿起来」= 进入拖拽态（低于阈值时全程为 false，松手仍是点击）。 */
  lifted: boolean;
  /**
   * 拿起来之后**真的挪过**（收到过 `pointermove`）。
   * 触摸下「按住 `TAB_HOLD_MS` 再原地松手」是常见的慢点：它已经进了拖拽态却没换过位，
   * 那一下 `click` 就不该吞 —— 吞了就是「点了标签什么都没发生」（见 `up` 的落位分支）。
   */
  moved: boolean;
  /** 当前插入位：**DOM 序**的下标（0 = 插到最前，标签条长度 = 插到最后）。 */
  index: number;
  stop: () => void;
}

interface RoomTabsProps {
  rooms: RoomViewState[];
  status: Record<number, { state: ConnState; detail: string }>;
  activeRoomId?: number;
  onOpen: (roomId: number) => void;
  /**
   * 落位（`toIndex` = 摘掉被拖那一枚之后的**数组下标**，由本组件换算）。
   * 拖动中房间被关掉时**不会**调用它（整次拖动作废）。
   */
  onReorder: (roomId: number, toIndex: number) => void;
}

/**
 * 房间标签条（需求 §2.8，交互口径见 `docs/ui.md` §2.3）：
 * 横向滚动（开再多也不压缩单枚标签的可读宽度）+ 指针拖动排序。
 *
 * **为什么不用 HTML5 拖放**：`draggable` / `dragstart` 在触摸下根本不发（桌面与移动会分叉成
 * 两套代码），而指针事件鼠标与触摸同一条流，还能与「点一下切房间」共用同一个按下序列。
 *
 * 三种手势的判定：
 * ① 位移没到 `TAB_DRAG_THRESHOLD_PX` 就松手 = **点击**（切房间）；
 * ② 鼠标横着越过阈值 = **拖动排序**（被拖项半透明 + 插入位指示条）；
 * ③ 触摸横着滑动 = **滚标签条**（`touch-action: pan-x` 让浏览器接管，并回一个 `pointercancel`
 *    把这次按压作废）；触摸要排序得先按住 `TAB_HOLD_MS` 再拖。
 *
 * **触摸排序为什么要挂一条原生 `touchmove`（而不是只靠 CSS / `pointermove`）**：
 * 浏览器在 **touchstart 那一刻**就把 touch-action 快照下来交给自己手势识别器了 ——
 * 之后 JS 再把 `touch-action` 改成 `none`（`.tabsDragging`）对**正在进行**的这场手势无效，
 * `pointermove` 上 `preventDefault()` 也拦不住滚动（它压根不是滚动的默认动作）。
 * 实测（2026-09-21，Chromium 124 / 桌面 Chrome 153，CDP 注入真实触摸）：
 * 按住 400ms 进入拖拽态后第一次 `pointermove` 就收到 `pointercancel`，排序一次都没成过。
 * 唯一有效的写法是**挂载时就挂一条非 passive 的 `touchmove`**：非 passive 让浏览器在这块
 * 区域上把滚动交给主线程裁决，于是「拿起来之后」那一下 `preventDefault()` 真的拦得住
 * （同一实验：`pointercancel` 0 次、拖得动；未拿起来时不 preventDefault，横划的滚动量与
 * 什么都不做的基线逐像素相同 —— 见 `docs/ui.md` §2.3 的「拖动排序」行）。
 */
function RoomTabs({ rooms, status, activeRoomId, onOpen, onReorder }: RoomTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<TabPress | null>(null);
  // 渲染用的拖拽态（被拖项 + 插入位）。真正的手势判据是 `pressRef`，这里只决定画什么。
  const [drag, setDrag] = useState<{ roomId: number; index: number } | null>(null);
  // 拖动之后浏览器照发一次 `click`（按下与松开落在同一枚标签上时）：那一下必须吞掉，
  // 否则「拖完顺手切了房间」——拖的是顺序，不是切换。**只有真的拖动了才举它**（见 `up`），
  // 且下一次按下即复位（每一下落在标签上的 `click` 前面一定有它自己的 `pointerdown`）。
  const swallowClick = useRef(false);
  // 松手那一刻要按**最新**的房间列表换算下标（拖动期间列表可能被上游快照改过）。
  // 写在布局阶段而不是渲染期：渲染期写 ref 会让**被丢弃的那一版渲染**把值漏进来
  // （React 要求渲染保持纯）。`commit` 只在松手那一刻读它，那时早已过了布局阶段。
  const roomsRef = useRef(rooms);
  useLayoutEffect(() => {
    roomsRef.current = rooms;
  });

  /** 指针落在第几个插入位（按每枚标签的中点判）：0 = 最前，标签数 = 最后。 */
  const dropIndexAt = (clientX: number) => {
    const strip = stripRef.current;
    if (!strip) return 0;
    return Array.from(strip.querySelectorAll('[data-testid="db-room-tab"]')).filter((tab) => {
      const box = tab.getBoundingClientRect();
      return box.left + box.width / 2 < clientX;
    }).length;
  };

  const beginPress = (event: React.PointerEvent<HTMLButtonElement>, roomId: number) => {
    // 只认主键 / 单指；已经有一次按着就不叠加（多指按下不该开第二场）。
    if (event.button !== 0 || pressRef.current) return;
    const press: TabPress = {
      pointerId: event.pointerId,
      roomId,
      x: event.clientX,
      y: event.clientY,
      holdOnly: event.pointerType === "touch",
      timer: null,
      lifted: false,
      moved: false,
      index: 0,
      stop: () => {},
    };
    swallowClick.current = false;

    const lift = () => {
      if (press.lifted) return;
      press.lifted = true;
      press.index = dropIndexAt(event.clientX);
      setDrag({ roomId: press.roomId, index: press.index });
    };

    /** 当前插入位 → 数组下标：自己要从列表里摘掉再插，落在自己右边时要减一。 */
    const commit = () => {
      const list = roomsRef.current;
      const from = list.findIndex((room) => room.room_id === press.roomId);
      // 拖动中房间被关掉（另一条路径移除 / 上游快照不再包含它）：这次拖动整场作废。
      if (from < 0) return;
      const to = press.index - (press.index > from ? 1 : 0);
      if (to !== from) onReorder(press.roomId, to);
    };

    const move = (event_: PointerEvent) => {
      if (event_.pointerId !== press.pointerId) return;
      const dx = event_.clientX - press.x;
      const dy = event_.clientY - press.y;
      if (!press.lifted) {
        // 还没越过阈值：可能仍是「点一下」，什么都不做。
        if (
          Math.abs(dx) < TAB_DRAG_THRESHOLD_PX &&
          Math.abs(dy) < TAB_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        // 越过了阈值：触摸（`holdOnly`）这条路上「先动了」= 用户在滑动看更多标签，
        // 整次按压作废，横向滑动交给容器自己的 `touch-action: pan-x`；
        // 竖向位移也不算拖（标签条只横着排）。
        if (press.holdOnly || Math.abs(dy) >= Math.abs(dx)) {
          press.stop();
          return;
        }
        lift();
      }
      press.moved = true;
      const index = dropIndexAt(event_.clientX);
      if (index !== press.index) {
        press.index = index;
        setDrag({ roomId: press.roomId, index });
      }
    };

    const up = (event_: PointerEvent) => {
      if (event_.pointerId !== press.pointerId) return;
      // 落位用**最后一次算出的插入位**，不用松手位置：松手时指针常已飘出标签条。
      // 只有「拿起来并且真的挪过」才算一次拖拽：原地长按后松手是慢点（要让它照旧切房间），
      // 所以那一下 `click` 也不能吞 —— 吞掉的后果就是「点了标签、什么都没发生」。
      if (press.lifted && press.moved) {
        commit();
        swallowClick.current = true;
      }
      press.stop();
    };

    const cancel = (event_: PointerEvent) => {
      if (event_.pointerId !== press.pointerId) return;
      // `pointercancel` = 浏览器把这条手势收走了（触摸下开始滚动就是这么来的）：
      // 整次拖动作废，不落顺序。
      press.stop();
    };

    press.stop = () => {
      if (press.timer !== null) window.clearTimeout(press.timer);
      press.timer = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (pressRef.current === press) pressRef.current = null;
      setDrag(null);
    };

    pressRef.current = press;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    if (press.holdOnly) {
      press.timer = window.setTimeout(() => {
        press.timer = null;
        lift();
      }, TAB_HOLD_MS);
    }
  };

  const draggedRoomId = drag?.roomId;
  useEffect(() => {
    if (draggedRoomId === undefined) return;
    // 拖动中被拖的那个房间没了：收掉指示条、不留悬挂的按压会话。
    if (rooms.some((room) => room.room_id === draggedRoomId)) return;
    pressRef.current?.stop();
  }, [rooms, draggedRoomId]);

  /**
   * 触摸排序的那条命脉（原理见本组件文件头）：**挂载时就挂**一条非 passive 的 `touchmove`，
   * 只在「已经拿起来」时 `preventDefault()`。
   *
   * 三条都是实测出来的，少一条都不成立：
   * · 必须**原生**注册：React 的 `onTouchMove` 走的是根容器上的 passive 监听，
   *   passive 上 `preventDefault()` 是空操作（控制台还会报一条 ignored 警告）；
   * · 必须**挂载时**就注册：等到拿起来（400ms 后）再挂，浏览器早已按「这块没人在意手势」
   *   走了快路径 —— 实测那条路（`dragfix-gesture-variants` 的 5 个变体里，唯一「在按下时
   *   才注册」的 P3）连普通横划的滚动都一起弄死了（滚动量 0），排序也照样进不去；
   * · 只能在拿起来之后 preventDefault：否则标签条就再也滑不动了（横划是「看更多标签」的正路）。
   *
   * 读的是 `pressRef` 而不是 state：这里一次都不该因为重渲染而重挂监听。
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onTouchMove = (event: TouchEvent) => {
      if (pressRef.current?.lifted) event.preventDefault();
    };
    strip.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => strip.removeEventListener("touchmove", onTouchMove);
  }, []);

  useEffect(
    // 卸载（返回列表页 / 关掉当前房间）时把窗口级监听摘掉：留着的话下一次松手
    // 还会对一份已经过期的列表落顺序。
    () => () => pressRef.current?.stop(),
    [],
  );

  return (
    <div
      ref={stripRef}
      className={drag === null ? styles.tabs : `${styles.tabs} ${styles.tabsDragging}`}
      data-testid="db-room-tabs"
      data-dragging={drag === null ? "false" : "true"}
    >
      {rooms.map((room, index) => {
        // 标签页上那颗点**与房间头那颗是同一个东西**（用户 2026-09-13：「橙色的需求改成灰色，
        // 但是下面的标题栏左边还是之前的样子」）：同一个 `liveKindOf` 判据、同一套 `--live-*`
        // 令牌、同一条 `.liveDot` 规则，所以同一状态下必然是同一个色。
        const kind = liveKindOf(
          status[room.room_id]?.state,
          room.connected,
          room.live_status,
        );
        // 标签条报主播名，不报房间号（用户 #18）；拿不到主播名才退回直播间标题。
        const name = roomTabName(room);
        const active = room.room_id === activeRoomId;
        const dragged = draggedRoomId === room.room_id;
        return (
          <Fragment key={room.room_id}>
            {/* 目标位插空指示：插在「第 index 枚之前」（index = 标签数时插在末尾那一段）。 */}
            {drag !== null && drag.index === index && (
              <span className={styles.tabDrop} data-testid="db-tab-drop" />
            )}
            <button
              className={
                `${active ? styles.tabActive : styles.tab}${dragged ? ` ${styles.tabDragging}` : ""}`
              }
              data-testid="db-room-tab"
              data-room-id={room.room_id}
              data-active={active ? "true" : "false"}
              data-dragging={dragged ? "true" : "false"}
              title={`${name} · ${LIVE_TEXT[kind]}`}
              onPointerDown={(event) => beginPress(event, room.room_id)}
              onClick={() => {
                if (swallowClick.current) {
                  swallowClick.current = false;
                  return;
                }
                onOpen(room.room_id);
              }}
            >
              <span
                className={`${styles.liveDot} ${LIVE_DOT_CLASS[kind]}`}
                data-testid="db-tab-dot"
                data-state={kind}
              />
              {name}
            </button>
          </Fragment>
        );
      })}
      {drag !== null && drag.index >= rooms.length && (
        <span className={styles.tabDrop} data-testid="db-tab-drop" />
      )}
    </div>
  );
}


export function App() {
  const info = useApp((state) => state.info);
  const session = useApp((state) => state.session);
  const rooms = useApp((state) => state.rooms);
  const activeRoomId = useApp((state) => state.activeRoomId);
  const messages = useApp((state) => state.messages);
  // 「互动消息自动消失」的到点信号：它只用来**触发重算**（判据在 filtering.toDisplayRows，
  // 见 store.interactTick）。没有它，行虽然不会丢，但到点那一下没人叫醒 React。
  const interactTick = useApp((state) => state.interactTick);
  const status = useApp((state) => state.status);
  const prefs = useApp((state) => state.prefs);
  const logs = useApp((state) => state.logs);
  const lastSend = useApp((state) => state.lastSend);
  const error = useApp((state) => state.error);
  const notice = useApp((state) => state.notice);
  const seeding = useApp((state) => state.seeding);
  const emotes = useApp((state) => state.emotes);
  const ownedEmotes = useApp((state) => state.ownedEmotes);
  const ownedError = useApp((state) => state.ownedError);
  const accounts = useApp((state) => state.accounts);
  const loadAccounts = useApp((state) => state.loadAccounts);
  const switchAccount = useApp((state) => state.switchAccount);
  const removeAccount = useApp((state) => state.removeAccount);
  const logoutAccount = useApp((state) => state.logoutAccount);
  const qr = useApp((state) => state.qr);
  const qrState = useApp((state) => state.qrState);
  const qrError = useApp((state) => state.qrError);
  const startAccountQr = useApp((state) => state.startAccountQr);
  const cancelAccountQr = useApp((state) => state.cancelAccountQr);
  const pollAccountQr = useApp((state) => state.pollAccountQr);
  const followed = useApp((state) => state.followed);
  const balance = useApp((state) => state.balance);
  const anchorFor = useApp((state) => state.anchorPanelFor);
  const anchorRooms = useApp((state) => state.anchorRooms);
  const anchorRoomErrors = useApp((state) => state.anchorRoomErrors);
  const anchorRoom = useApp((state) => state.anchorRoom);
  const anchorAreas = useApp((state) => state.anchorAreas);
  const anchorAreaError = useApp((state) => state.anchorAreaError);
  const anchorTitleDraft = useApp((state) => state.anchorTitleDraft);
  const anchorAreaId = useApp((state) => state.anchorAreaId);
  const anchorEndpoints = useApp((state) => state.anchorEndpoints);
  const anchorGate = useApp((state) => state.anchorGate);
  const anchorError = useApp((state) => state.anchorError);
  const toggleAnchorPanel = useApp((state) => state.toggleAnchorPanel);
  const loadAnchorRooms = useApp((state) => state.loadAnchorRooms);
  const setAnchorTitleDraft = useApp((state) => state.setAnchorTitleDraft);
  const saveAnchorArea = useApp((state) => state.saveAnchorArea);
  const saveAnchorTitle = useApp((state) => state.saveAnchorTitle);
  const setAnchorLive = useApp((state) => state.setAnchorLive);
  const closeAnchorPanel = useApp((state) => state.closeAnchorPanel);
  const openAnchorGateUrl = useApp((state) => state.openAnchorGateUrl);
  const closeAnchorGate = useApp((state) => state.closeAnchorGate);

  const [accountsOpen, setAccountsOpen] = useState(false);
  const bootstrap = useApp((state) => state.bootstrap);
  const addRoom = useApp((state) => state.addRoom);
  const removeRoom = useApp((state) => state.removeRoom);
  const openRoom = useApp((state) => state.openRoom);
  const closeRoom = useApp((state) => state.closeRoom);
  const moveRoom = useApp((state) => state.moveRoom);
  const disconnect = useApp((state) => state.disconnect);
  const refresh = useApp((state) => state.refresh);
  const send = useApp((state) => state.send);
  const report = useApp((state) => state.report);
  const loadFollowed = useApp((state) => state.loadFollowed);
  const startListStatusPolling = useApp((state) => state.startListStatusPolling);
  const startAnchorPolling = useApp((state) => state.startAnchorPolling);
  const updatePrefs = useApp((state) => state.updatePrefs);
  const dismissError = useApp((state) => state.dismissError);
  const setNotice = useApp((state) => state.setNotice);

  /** 关掉账号对话框 = 放弃这次扫码：面板不再留在后台偷偷轮询。**关闭按钮与返回手势共用这一处**。 */
  const closeAccounts = useCallback(() => {
    cancelAccountQr();
    // 「我的直播间」的展开态一起收起：推流码是账号级凭据，关了对话框就不该还留在内存里。
    closeAnchorPanel();
    setAccountsOpen(false);
  }, [cancelAccountQr, closeAnchorPanel]);

  // 系统返回手势第 1 级：账号对话框是盖在最上面的模态，先关它（关法与「✕」同源）。
  // 常驻注册、由**当下状态**决定认不认领（同 RoomView：注册/注销要等 effect，会落后一帧）。
  const accountsOpenRef = useRef(accountsOpen);
  // 同上：最新值在**布局阶段**写进 ref，渲染保持纯。处理器只在返回手势里读它，那时已经写完。
  useLayoutEffect(() => {
    accountsOpenRef.current = accountsOpen;
  });
  useEffect(
    () =>
      registerBackHandler(BACK_PRIORITY.panel, () => {
        if (!accountsOpenRef.current) return false;
        closeAccounts();
        return true;
      }),
    [closeAccounts],
  );

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /**
   * 列表页的开播状态轮询（契约 §4）：**只在房间列表页、且会话已就绪**时跑，进房间页立刻停。
   *
   * 门为什么还挂在 `session` 上：`activeRoomId` 在启动时本来就是空的，而那一刻 `bootstrap`
   * 还没落地 —— 先跑会把它的 `rooms` / `followed` 覆盖成一轮还没回来（或更旧）的快照。
   * `session` 是 `bootstrap` 里那一次 `set` 带进来的，所以它到了就代表启动数据已经就位。
   */
  const listPolling = activeRoomId === undefined && session !== undefined;
  useEffect(() => {
    if (!listPolling) return;
    return startListStatusPolling();
  }, [listPolling, startListStatusPolling]);

  /**
   * 「我的直播间」展开区的静默轮询（issue202609242158 第 7 条）：面板展开期间每 30 秒重拉
   * 一次 `anchor_room`，收起 / 关对话框（`anchorFor` 变 `null`、或关掉对话框走
   * `closeAnchorPanel`）由 effect 清理停掉。展开时 `toggleAnchorPanel` 已同步拉过一次，
   * 因此首拍按周期排。换号后旧回包由身份世代复核挡下。
   */
  useEffect(() => {
    if (anchorFor === null) return;
    return startAnchorPolling(anchorFor);
  }, [anchorFor, startAnchorPolling]);

  // 提示 3 秒后自动消失。
  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  // 主题来自偏好；system 时跟随系统（并在系统外观变化时**实时**跟随）。
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const theme = prefs?.["ui.theme"] ?? "system";
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    // 只有 system 才订阅：显式浅色 / 深色时系统怎么变都与界面无关。
    // 首次绘制前的默认值由 index.html 的内联脚本给 —— prefs 要等 IPC 回来，
    // 否则浅色系统上会先画一帧深色再翻白。
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [prefs]);

  // `interactTick` 在依赖里是**必须**的：互动行到点那一下由它触发重算
  // （`toDisplayRows` 的第三参默认 `Date.now()`；到点的不画，但消息不丢）。
  // 回调体里读不到它，规则因此判它「多余」—— 它要的正是「值没变也重算」这件事
  // （到点的那一刻钟要重新读一次）。整条规则在这一处（依赖数组那一行）按**误报**处理。
  const rows = useMemo(
    () => (prefs ? toDisplayRows(messages, prefs) : []),
    // oxlint-disable-next-line react/exhaustive-deps
    [messages, prefs, interactTick],
  );

  const activeRoom = rooms.find((room) => room.room_id === activeRoomId);

  // 多房间标签页（需求 §2.8）：房间本来就能同时连接，这里只是给一个切换入口。
  // **只在房间页里渲染**（用户 2026-09-12）：列表页已经有「已连接房间」卡片列表，
  // 两者做的是同一件事，主页再挂一条标签条是重复。房间页内部照旧（`RoomTabs`）。

  return (
    <div className={styles.shell}>
      {activeRoom && prefs ? (
        <>
          {rooms.length > 1 && (
            <RoomTabs
              rooms={rooms}
              status={status}
              activeRoomId={activeRoomId}
              onOpen={(roomId) => void openRoom(roomId)}
              onReorder={moveRoom}
            />
          )}
          <RoomView
            room={activeRoom}
            rows={rows}
            prefs={prefs}
            session={session}
            lastOutcome={lastSend?.outcome}
            lastDetail={lastSend?.detail}
            logs={logs}
            emotes={emotes}
            ownedEmotes={ownedEmotes}
            ownedError={ownedError}
            balance={balance}
            onBack={closeRoom}
            onRefresh={() => void refresh(activeRoom.room_id)}
            onDisconnect={() => void disconnect(activeRoom.room_id)}
            onSend={(content, emote, reply) =>
              send(activeRoom.room_id, content, emote, reply)
            }
            onReport={async (message, reason) => {
              if (await report(message, reason)) setNotice("举报已提交");
            }}
            onPrefs={(patch) => void updatePrefs(patch)}
            onNotice={setNotice}
          />
        </>
      ) : (
        <RoomList
          rooms={rooms}
          info={info}
          session={session}
          followed={followed}
          recentWatched={prefs?.["ui.recent_watched"] ?? {}}
          theme={prefs?.["ui.theme"] ?? "system"}
          onTheme={(value) => void updatePrefs({ "ui.theme": value })}
          onAdd={(input) => void addRoom(input)}
          onOpen={(roomId) => void openRoom(roomId)}
          accounts={accounts}
          onOpenAccounts={() => {
            // 打开对话框：先把开关打开（界面立刻有响应），再重拉账号、再预取各账号直播间。
            setAccountsOpen(true);
            // 重拉一次：用户可能刚在别处登过号，列表必须说当下的事实。
            // **预取必须在 accounts 落地之后**：否则 `loadAnchorRooms` 读到旧的 / 空的账号表，
            // 按钮显隐映射就是空的（issue202609241553 第 2 条靠它）。
            void (async () => {
              await loadAccounts();
              void loadAnchorRooms();
            })();
          }}
          onRemove={(roomId) => void removeRoom(roomId)}
          onRefreshFollowed={() => void loadFollowed()}
          onOpenFollowed={(roomId) => void addRoom(String(roomId))}
        />
      )}

      {accountsOpen && (
        <AccountManager
          accounts={accounts}
          session={session}
          qr={qr}
          qrState={qrState}
          qrError={qrError}
          anchorFor={anchorFor}
          anchorRooms={anchorRooms}
          anchorRoomErrors={anchorRoomErrors}
          anchorRoom={anchorRoom}
          anchorAreas={anchorAreas}
          anchorAreaError={anchorAreaError}
          anchorTitleDraft={anchorTitleDraft}
          anchorAreaId={anchorAreaId}
          anchorEndpoints={anchorEndpoints}
          anchorGate={anchorGate}
          anchorError={anchorError}
          onClose={closeAccounts}
          onSwitch={(name) => void switchAccount(name)}
          onLogout={(name) => void logoutAccount(name)}
          onRemove={(name) => void removeAccount(name)}
          onStartQr={(target) => void startAccountQr(target)}
          onCancelQr={cancelAccountQr}
          onPollQr={() => void pollAccountQr()}
          onToggleAnchor={(name) => void toggleAnchorPanel(name)}
          onAnchorTitleDraft={setAnchorTitleDraft}
          onAnchorArea={(id) => void saveAnchorArea(id)}
          onAnchorSaveTitle={saveAnchorTitle}
          onAnchorLive={(live) => setAnchorLive(live)}
          onAnchorOpenGateUrl={() => void openAnchorGateUrl()}
          onAnchorCloseGate={closeAnchorGate}
        />
      )}

      {seeding && (
        <div className={styles.composerHint}>正在载入本次会话的弹幕…</div>
      )}

      {notice !== undefined && (
        <div className={`${styles.error} ${styles.notice}`}>
          <span>{notice}</span>
        </div>
      )}

      {error !== undefined && (
        <div className={styles.error}>
          <span>{error}</span>
          <button onClick={dismissError}>关闭</button>
        </div>
      )}
    </div>
  );
}
