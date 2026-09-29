import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import styles from "../app.module.css";
import {
  clampPaneRatio,
  PANE_COLLAPSED_SHARE,
  PANE_RATIO_DEFAULT,
  PANE_RATIO_MAX,
  PANE_RATIO_MIN,
  paneFoldAfterDrag,
  paneGrowOf,
  paneKeyboardStep,
  roundPaneRatio,
} from "../pane-split";

/**
 * 一块**上下分区**：两栏（弹幕区 / 礼物栏）共享高度，中间一条可拖动的分割条，
 * 长按任一栏 0.5s 可以把两栏上下换位（issue #8，用户 2026-09-16）。
 *
 * 四条口径（`docs/ui.md` §5.4 与实现同源，改这里先改那里；纯逻辑在 `src/pane-split.ts`）：
 *
 * 1. **份额**（`ratio`）= 礼物栏占分区高度的比例，与它在上面还是下面无关。
 *    两栏都是 `flex-basis: 0` + `flex-grow: <份额>`，所以容器高度怎么变比例都成立；
 *    两栏各自的**最小高度**（礼物栏 ≥ 它的总计条、弹幕区 ≥ 3 行）由 CSS 兜住 ——
 *    夹到极限时由浏览器就地分配，窗口从宽拖到 360px 也仍然成立。
 * 2. **DOM 顺序恒为「弹幕 → 分割条 → 礼物栏」**，上下位置只由 `flex-direction`
 *    （`column` / `column-reverse`）决定：换位因此**不搬节点** —— 弹幕列表的滚动位置、
 *    虚拟列表状态、两栏各自的内部滚动全都原样保留，读屏与 tab 顺序也稳定地按主次走。
 * 3. **开合是同一根轴上的两个区间**（需求 5.1–5.4，单轴模型）：**折叠 = 份额被压到下限
 *    以下 + 这一栏按自己的最小高度裁剪**，展开 = 份额回到落盘那一份。两栏 grow 之和恒为 1
 *    （`paneGrowOf`）。礼物栏折叠着时它只有总计条那么高、列表与芯片被裁掉（照旧挂载），
 *    但分割条仍在、仍可拖。
 * 4. **开合只在松手那一刻判**（需求 4.2）：拖动全程只改可视份额，一次都不改开合状态 ——
 *    折叠态被拖开 = 展开、展开态压到下限以下 = 收起，两向都由松手那一份份额决定
 *    （`paneFoldAfterDrag`），与点总计条右端那枚小箭头同一条路；**取消（ESC / pointercancel）
 *    只还原份额**，不留中间态。键盘那条路没有拖动过程，按键当场判、当场落盘（`paneKeyboardStep`）。
 *
 * **触摸下这三条手势谁说了算**（2026-09-21 实测重写，细节见下面那个 `useEffect`）：
 * 浏览器在 touchstart 那一刻就把 `touch-action` 快照给手势识别器了，之后 JS 再改它、
 * 或在 `pointermove` 上 `preventDefault()`，都拦不住已经开跑的滚动。所以「拿起来之后」
 * 这一场手势是靠**挂载时就挂上**的一条非 passive `touchmove` 抢回来的；分割条自己没有
 * 这条问题 —— 它的 `touch-action: none` 是**静态**写在元素上的，touchstart 那一刻就已生效。
 *
 * 拖动中**一帧都不写 store**：份额直接写在分区的两个自定义属性上（`--gift-share` /
 * `--danmaku-share`），松手（或键盘停下 350ms）才回写一次偏好。房间页会因为新弹幕
 * 随时重渲染，而 React 会把 inline style 按**已落盘的**份额写回去，所以每次提交后再补
 * 一次实时值，直到偏好回执把 `ratio` 送到为止。
 */

/** 键盘微调的落盘节流：连按只写最后一次（拖动那条路是松手写一次）。 */
const KEY_COMMIT_MS = 350;
/** 长按多久进入换位拖拽态（用户口径 0.5s）—— 也是「长按」与「拖动分割条 / 在列表里滚动」的分界。 */
const LONG_PRESS_MS = 500;
/** 按下后移动超过这个距离就不再算长按（那是在滚列表 / 选字，不是在换位）。 */
const PRESS_SLOP = 8;

interface Props {
  /** 礼物栏在不在上半（契约 §8 `ui.gift_pane_on_top`）。 */
  giftOnTop: boolean;
  /** 礼物栏占分区高度的份额（契约 §8 `ui.gift_pane_ratio`）。 */
  ratio: number;
  /** 新的份额：**松手 / 键盘停下才调**一次。 */
  onRatio: (ratio: number) => void;
  /** 长按后拖到另一栏松手 → 两栏上下互换。 */
  onSwap: () => void;
  /**
   * 折叠态下拖动 / 微调把这一栏拖开时调一次（与点总计条右端那枚小箭头同一条路）。
   * 拖动那条路只在**松手**时调（需求 4.2：拖动全程不改开合态）。
   */
  onExpand: () => void;
  /**
   * 展开态下把份额拖（或微调）到 `PANE_RATIO_MIN` **还想再压小**时调一次
   * （与点那枚小箭头同一条路）。语义与 `onExpand` 对称：**份额压到下限 = 收起** ——
   * 用户把分割条一路压到头的意图是「这一栏不要了」，而不是「留 10% 在那儿」。
   * 拖动那条路同样只在**松手**时调。
   */
  onCollapse: () => void;
  /** 弹幕字号缩放（`ui.font_scale`）：弹幕栏最小高度里的行盒部分跟着它缩。 */
  fontScale: number;
  /** 礼物栏是不是折叠着（折叠 = 份额被压到下限以下 + 这一栏按最小高度裁剪）。 */
  giftCollapsed: boolean;
  /** 弹幕区。 */
  danmaku: ReactNode;
  /**
   * 礼物栏的内容（`null` = 不显示礼物栏：分区退化为弹幕区全高，分割条不渲染）。
   * **第一个带 `data-pane-head` 的元素 = 折叠头**，它的实测高度就是这一栏的最小高度。
   */
  gift: ReactNode;
}

export function SplitPanes({
  giftOnTop,
  ratio,
  onRatio,
  onSwap,
  onExpand,
  onCollapse,
  fontScale,
  giftCollapsed,
  danmaku,
  gift,
}: Props) {
  const hasGift = gift !== null && gift !== undefined;
  const share = clampPaneRatio(Number.isFinite(ratio) ? ratio : PANE_RATIO_DEFAULT);
  /**
   * 真正的 `flex-grow`：折叠态（或没有礼物栏）时礼物栏**不长**（份额压到下限以下，
   * 高度由它的最小高度 = 实测的总计条兜住），弹幕区拿走全部 —— 两个 grow 之和必须**恰好是 1**。
   *
   * `flex-grow` 之和小于 1 时，Flexbox 只分配「和」那么多比例的自由空间（规范 §9.7），
   * 于是剩下的部分空着：第一版就踩了它 —— 折叠态下礼物栏 grow = 0、弹幕区 0.65，
   * 分区底部白白空掉 35%（实测 787px 的容器里空 263px）。
   */
  const grow = paneGrowOf(share, giftCollapsed, hasGift);

  const regionRef = useRef<HTMLDivElement>(null);
  const danmakuRef = useRef<HTMLDivElement>(null);
  const giftRef = useRef<HTMLDivElement>(null);
  const splitterRef = useRef<HTMLDivElement>(null);
  /** 拖动 / 键盘微调中**尚未落盘**的份额（`null` = 听 `prefs` 的）。 */
  const liveRef = useRef<number | null>(null);
  /** 键盘微调的落盘定时器。 */
  const commitTimer = useRef<number | null>(null);
  /**
   * 换位拖拽是否已经「拿起来」（长按成立）。
   * 挂载时那条非 passive 的 `touchmove` 要读它，所以它必须是 ref 而不是 state
   * （state 一变就要重挂监听器，而那正是最不该发生的事）。
   */
  const armedRef = useRef(false);
  /** 换位拖拽之后紧跟着的那一下 `click` / `contextmenu` 该不该吞（见 `releaseRef` 的收尾）。 */
  const swallowClick = useRef(false);
  /** 一次按下（长按计时 / 拖拽）的全部收尾动作 —— 同一时刻只允许一次。 */
  const releaseRef = useRef<(() => void) | null>(null);
  /** 正在跟随指针的那一栏（长按之后才非空）。 */
  const [swapPane, setSwapPane] = useState<"danmaku" | "gift" | null>(null);
  /** 松手会落在另一栏上（落点提示）。 */
  const [swapOver, setSwapOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 回调放进 ref：指针监听器活在按下那一刻的闭包里，而房间页随时会因为新弹幕重渲染。
  // 写在**布局阶段**（渲染期写 ref 会让被丢弃的那一版渲染把值漏进来）：指针事件永远在
  // 提交之后才到，处理器读到的因此一定是最新的那一组回调。
  const handlers = useRef({ onRatio, onSwap, onExpand, onCollapse });
  useLayoutEffect(() => {
    handlers.current = { onRatio, onSwap, onExpand, onCollapse };
  });

  const applyShare = useCallback((value: number) => {
    const region = regionRef.current;
    if (!region) return;
    region.style.setProperty("--gift-share", String(value));
    region.style.setProperty("--danmaku-share", String(1 - value));
  }, []);

  // 拖动中的实时值每帧都补在 DOM 上（见文件头的第 4 段）。
  // ⚠ **比的是 `grow`、不是 `share`**：`liveRef` 装的一直是「要写进 `--gift-share` 的那份
  // grow」，而折叠态下 `grow`（0）与份额（≥0.1）不是同一个数。拿 `share` 比会在折叠态的
  // 收尾上判成「还没对上」而反复贴回份额值，把界面按在 10% 高度出不来（2026-09-29 issue）。
  useLayoutEffect(() => {
    const live = liveRef.current;
    if (live === null) return;
    if (Math.abs(live - grow) < 1e-6) {
      liveRef.current = null; // 偏好回执到了：inline style 从此就是同一个值
      return;
    }
    applyShare(live);
  });

  // 礼物栏的最小高度 = 它**折叠头**的实测高度（契约 §8）：字号缩放 / 主题 / 边框都会改它，
  // 写死一个像素值迟早对不上。
  useLayoutEffect(() => {
    const region = regionRef.current;
    const head = giftRef.current?.querySelector<HTMLElement>("[data-pane-head]");
    if (!region || !head) return;
    const measure = () => {
      const height = Math.ceil(head.getBoundingClientRect().height);
      if (height > 0) region.style.setProperty("--gift-min-h", `${height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    return () => observer.disconnect();
  }, [hasGift]);

  // 卸载时收尾：拆掉进行中的一次按下，并把没落盘的份额补写一次（不补就白拖了）。
  useEffect(
    () => () => {
      releaseRef.current?.();
      if (commitTimer.current === null) return;
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
      const value = liveRef.current;
      if (value !== null) {
        liveRef.current = null;
        handlers.current.onRatio(value);
      }
    },
    [],
  );

  /**
   * 触摸换位的两条常驻监听（**挂载时挂一次，一辈子不重挂**）：
   *
   * ① 区块上一条**非 passive** 的 `touchmove`，只在「已经拿起来」时 `preventDefault()`。
   *    为什么非它不可：浏览器在 **touchstart 那一刻**就把 `touch-action` 快照给了自己的
   *    手势识别器 —— 拿起来之后再改 CSS（`touch-action: none`）对这场手势**无效**，
   *    而在 `pointermove` 上 `preventDefault()` 也拦不住滚动（滚动不是它的默认动作）。
   *    实测（2026-09-21，Android WebView Chrome/124 + 桌面 Chrome 153，CDP 注入真实触摸）：
   *    按住 560ms 进入换位态后，第一次 `pointermove` 就收到 `pointercancel`，换位一次都没成过；
   *    改成这条非 passive 监听后 `pointercancel` 0 次、换位落位正常，而未拿起来时的列表
   *    滚动量与什么都不做的基线逐像素相同（非 passive 只让浏览器多问主线程一句，
   *    不 preventDefault 时滚动照旧）。React 的 `onTouchMove` 不行：它在根容器上是 passive 的。
   *
   * ② `window` 上两条捕获监听（`click` / `contextmenu`）：吞掉换位拖拽松手之后浏览器补发的
   *    那一下（否则会顺手点到行里的东西 / 把礼物折叠头开合一次）。举旗在 `releaseRef` 的收尾，
   *    **放旗在「下一次真的按下 / 按键」**（另两条捕获监听）：那一下是另一次操作，它的 click
   *    与自己无关 —— 绝不像旧实现那样用一个 600ms 定时器去猜「那一下 click 来没来」，
   *    那个窗口里任何一处点击都会被吃掉（2026-09-21 实测：长按弹幕栏拖一小段再松手，
   *    紧接着真的按一下礼物折叠头 —— 旧实现在**同一份探针**里 `toggledByNextTap=false`，
   *    即那一下点击被整个吞掉；而「没有按下那一步」的合成 click 在两个版本里都照样被吞，
   *    说明差别就在「下一次按下会不会放旗」这件事本身）。
   */
  useEffect(() => {
    const region = regionRef.current;
    const onTouchMove = (event: TouchEvent) => {
      if (armedRef.current) event.preventDefault();
    };
    const swallow = (event: Event) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const disarm = (event: Event) => {
      // 新的按下 / 新的按键 = 新的一次操作：这一下 click 与刚才那次换位拖拽无关，不能吞。
      // （键盘那条也要放旗：焦点在按钮上按 Enter 一样会派发 click，而它前面没有 pointerdown。）
      if (event.type === "pointerdown" || event.type === "keydown") swallowClick.current = false;
    };
    region?.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("click", swallow, true);
    window.addEventListener("contextmenu", swallow, true);
    window.addEventListener("pointerdown", disarm, true);
    window.addEventListener("keydown", disarm, true);
    return () => {
      region?.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("contextmenu", swallow, true);
      window.removeEventListener("pointerdown", disarm, true);
      window.removeEventListener("keydown", disarm, true);
    };
  }, []);

  /** 拖动分割条：指针事件（触摸与鼠标同一条路）。热区由 `.splitter` 保证 ≥ 8px（桌面）；
   *  触摸设备上 CSS 的 `@media (pointer: coarse)` 把它撑到 24px（依据见 app.module.css）。 */
  const onSplitterDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const region = regionRef.current;
    if (!region || releaseRef.current) return;
    const rect = region.getBoundingClientRect();
    // 热区已经**不占布局高度**（`.splitter` 的负 margin，见 app.module.css）：两栏分掉整块
    // 高度，分割条的**正中**就是两栏的分界 —— 因此这里不再减 `track`，
    // 减了会让「拖到顶端 / 底端」时落盘的份额差一截（夹取点整体偏移半个热区）。
    const usable = rect.height;
    if (usable <= 0) return;
    // 触屏没有 hover：按住时给热区挂 `data-grab`，把手靠它显形（松手即摘）。
    const el = event.currentTarget;
    el.dataset.grab = "true";

    const pointerId = event.pointerId;
    /** 拖动前的那一份 grow（折叠态是 `PANE_COLLAPSED_SHARE`）：拖动作废时原地还原的就是它。 */
    const baseGrow = grow;
    /** 按下那一刻它是不是折叠着。**拖动全程不改开合态**（需求 4.2），所以这一档到松手时仍成立。 */
    const wasCollapsed = giftCollapsed;
    let latest = share;
    /**
     * 指针给的份额**没被夹取、也没四舍五入**的那一份：松手时判开合用它，不用 `latest`
     * —— 夹取会把「压到下限」与「刚好在下限之上」归到同一个数上（见 `paneFoldAfterDrag`）。
     */
    let latestRaw = share;
    let moved = false;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      // 指针停在哪儿，分割条就跟到哪儿：礼物栏在下面时，指针上方是弹幕区。
      // 这一式同时也把**方向**翻好了 —— 礼物栏在上时指针越往上它越矮，在下时越往下越矮。
      const offset = moveEvent.clientY - rect.top;
      const raw = giftOnTop ? offset / usable : 1 - offset / usable;
      latestRaw = raw;
      // **实时几何**（写进 DOM 的那一份）**下限压在 0**、不是 `PANE_RATIO_MIN`：
      // 折叠那一端（`--gift-share` = 0 = 只剩总计条）才是这条轴真正的端点，分割条必须
      // 1:1 跟着指针一路走到它。压到 0.1 会让「拖开再拖回原位」停在 10% 高度上、回不到
      // 折叠高度（2026-09-29 用户报的「拖回去归不了位 / 还有收不起来的情况」）——
      // 折叠高度（≈ 48px）本来就在 10% 之下，夹在 0.1 等于把这一端从拖动里挖掉了。
      const live = roundPaneRatio(Math.min(PANE_RATIO_MAX, Math.max(0, raw)));
      // **落盘**那一份另算：域仍是 0.1–0.9（越界会被 IPC 以 `BAD_REQUEST` 拒掉），
      // 它与 `latestRaw` 一起供**松手**时判开合（需求 4.2/4.3）。
      latest = roundPaneRatio(clampPaneRatio(raw));
      // **只改可视份额，一次都不改开合状态**（需求 4.2）：折叠着也能被拖开（展开前也照拖，
      // 拖到哪儿就长到哪儿），展开着拖到下限也不会半路变成折叠。开合由**松手**时的
      // `paneFoldAfterDrag` 判一次。改前的写法在 `move` 里当场 `onExpand()` / `onCollapse()`，
      // 于是「拖到一半被识别成已收起、之后拖不动」——那一版的反悔分支也只是在补这个洞。
      if (!moved) {
        moved = true;
        setDragging(true);
      }
      liveRef.current = live;
      applyShare(live);
    };

    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      releaseRef.current?.();
      if (!moved) return; // 只是点了一下分割条：什么都没发生，不写偏好
      // 松手定案（需求 4.2/4.3）：先看这一份份额要不要开合，再落盘份额（两条都是同一次操作）。
      const fold = paneFoldAfterDrag(latestRaw, wasCollapsed);
      if (fold === "collapse") {
        // 收起：**先把实时值交还给 React**（不清掉 `liveRef`，下面那个 `useLayoutEffect`
        // 会在下一次重渲染时把拖动中写下的那一份份额又贴回 DOM 上，等于把刚收起的这一栏
        // 又撑开），再自己把几何落到折叠态上 —— 松手这一帧就已经是折叠的样子，不等调度。
        // （随后 React 会把 grow 从按下前那一份改成 `PANE_COLLAPSED_SHARE`，写的也是同一个值。）
        liveRef.current = null;
        applyShare(PANE_COLLAPSED_SHARE);
        handlers.current.onCollapse();
      } else {
        // 展开 / 不开合：把落盘那一份**折算回 grow** 再贴回 DOM，让它在偏好回执到达之前
        // 一直贴在 DOM 上（`liveRef` 装的一直是 grow，见上面那条 effect）。
        // ⚠ 直接贴 `latest`（份额）在「折叠态拖开又拖回折叠区间」这一种收尾上是错的：
        // 那时 `giftCollapsed` 仍是 true、React 写的 `--gift-share` 是 `PANE_COLLAPSED_SHARE`
        // （0），而 React **只在 style 值变化时才碰 DOM** —— 命令式写下的 ≥0.1 会留在 DOM 上，
        // 与折叠态打架，界面停在 10% 高度、`aria-expanded` 却是 false（2026-09-29 用户报的
        // 「还有收不起来的情况」）。折算成 grow 之后两边写的是同一个数（折叠 → 0）。
        const collapsedNow = fold === "expand" ? false : wasCollapsed;
        liveRef.current = paneGrowOf(latest, collapsedNow, hasGift);
        applyShare(liveRef.current);
        if (fold === "expand") handlers.current.onExpand();
      }
      handlers.current.onRatio(latest);
    };

    /**
     * ESC / pointercancel：**只还原份额**（需求 4.3），不留中间态 —— 开合状态本来就没被
     * 这一次拖动改过（改前要在这里把中途收起 / 展开的那一档拨回去，见 `move` 的注释）。
     */
    const abort = () => {
      releaseRef.current?.();
      if (liveRef.current === null) return;
      liveRef.current = null;
      applyShare(baseGrow);
    };

    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) abort();
    };

    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") abort();
    };

    releaseRef.current = () => {
      releaseRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      // 松手 / 取消即摘掉 `data-grab`：把手回到隐藏态（触屏这条等价于 hover 退出）。
      delete el.dataset.grab;
      setDragging(false);
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  };

  /** 键盘可达（ARIA window splitter 那一套）：←→ 不管用，↑↓ 微调份额。 */
  const onSplitterKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const up = event.key === "ArrowUp";
    const down = event.key === "ArrowDown";
    if (!up && !down) return;
    event.preventDefault();
    // 方向键移动的是**分割条**：向上 ⇒ 上面那一栏变矮、下面那一栏变高。
    const growGift = up ? !giftOnTop : giftOnTop;
    // 判据与拖动那条路同源（`pane-split.ts`）：到下限那一侧 = 收起、折叠态按一步先展开。
    // 键盘这条**没有拖动过程**，所以按键当场判、当场落盘（拖动那条路是松手才判，需求 4.2）。
    const step = paneKeyboardStep(liveRef.current ?? share, giftCollapsed, growGift);
    if (step.fold === "collapse") handlers.current.onCollapse();
    else if (step.fold === "expand") handlers.current.onExpand();
    const next = step.ratio;
    if (next === null) return;
    liveRef.current = next;
    applyShare(next);
    if (commitTimer.current !== null) return; // 连按只有最后一次落盘
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      const value = liveRef.current;
      if (value !== null) handlers.current.onRatio(value);
    }, KEY_COMMIT_MS);
  };

  /**
   * 长按任一栏 0.5s → 该栏半透明跟随指针；拖到另一栏松手 = 两栏上下互换，
   * 拖回原位 / 按 ESC = 取消。**与另外两条手势的分界**：
   * - 与「拖动分割条」：分割条不在两栏里（它是分区的另一个子元素），按下走的是分割条自己的那条路；
   * - 与「在列表里滚动 / 点选」：0.5s 之前移动超过 `PRESS_SLOP` 就放弃（触摸滚动会先动，
   *   于是根本不会进换位态）；拿起来之后的滚动由**区块上那条非 passive 的 `touchmove`**
   *   拦掉（见上面 useEffect —— `pointermove` 的 `preventDefault()` 拦不住滚动，
   *   这里保留它只是为了顺带压掉选字）。
   */
  const onPaneDown = (pane: "danmaku" | "gift") => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (releaseRef.current) return;
    const splitterBox = splitterRef.current?.getBoundingClientRect();
    if (!splitterBox) return; // 没有分割条 = 没有另一栏可换（礼物栏关掉时不装长按）
    const el = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    // 拖动中这一栏会被 translate，判断「落点是不是另一栏」要拿它**没被 translate 时**的盒子：
    // 判据是**指针有没有越过分割条**（两栏的边界），不是「指针落在对方矩形里」——
    // 礼物栏折叠着时它只有 27px 高，按矩形判就等于要求像素级瞄准（踩过这个坑）。
    const ownRect = el.getBoundingClientRect();
    const boundary = splitterBox.top + splitterBox.height / 2;
    const dropIsSwap = (clientY: number) =>
      ownRect.top < boundary ? clientY > boundary : clientY < boundary;
    let timer = 0;
    let fired = false;
    let over = false;

    const track = (next: boolean) => {
      if (next === over) return;
      over = next;
      setSwapOver(next);
    };

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!fired) {
        if (
          Math.abs(moveEvent.clientX - startX) > PRESS_SLOP ||
          Math.abs(moveEvent.clientY - startY) > PRESS_SLOP
        ) {
          releaseRef.current?.(); // 在滚列表 / 点选，不是长按
        }
        return;
      }
      moveEvent.preventDefault();
      const region = regionRef.current?.getBoundingClientRect();
      const raw = moveEvent.clientY - startY;
      // 不许把这一栏拖出共享分区（拖出去就整块看不见了）
      const dy = region
        ? Math.min(
            Math.max(raw, region.top - ownRect.top),
            region.bottom - ownRect.bottom,
          )
        : raw;
      el.style.transform = `translateY(${dy}px)`;
      track(dropIsSwap(moveEvent.clientY));
    };

    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      const landed = fired && over;
      releaseRef.current?.();
      if (landed) handlers.current.onSwap();
    };

    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) releaseRef.current?.();
    };

    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") releaseRef.current?.();
    };

    releaseRef.current = () => {
      releaseRef.current = null;
      if (timer !== 0) window.clearTimeout(timer);
      timer = 0;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      el.style.transform = "";
      if (!fired) return;
      fired = false;
      armedRef.current = false;
      document.body.style.userSelect = "";
      setSwapPane(null);
      setSwapOver(false);
      // 换位拖拽之后浏览器照发的那一下 `click` / `contextmenu` 要吞掉（松手会顺手点到
      // 行里的东西、把礼物折叠头开合一次）。它在 pointerup **之后**才派发，所以只能在这里
      // **举旗**，由挂载时那两条常驻捕获监听器去吞（见上面的 useEffect）：
      // 吞到就放旗，而**下一次真的按下 / 按键也放旗** —— 那是另一次操作，它的 click 与自己无关。
      // 旧实现是「举旗 + 600ms 兜底定时器收监听」，那个窗口里任何一处点击都会被吃掉
      // （本票实测：长按弹幕栏拖一小段再松手、紧接着真的按一下礼物折叠头，
      // 旧实现那一下点击被整个吞掉 —— 与冒烟里 `panelBackOnCommon` 记的是同一件事）。
      swallowClick.current = true;
    };

    timer = window.setTimeout(() => {
      timer = 0;
      fired = true;
      // 触摸这条路上「已经拿起来」= 全场手势归我：挂载时那条非 passive 的 touchmove
      // 靠这个标志决定要不要 preventDefault（见上面 useEffect 的说明）。
      armedRef.current = true;
      setSwapPane(pane);
      // 换位拖拽期间**全局**禁掉选字：拖到另一栏（那是一大片可选的弹幕正文）时，
      // Chrome 会把这一下判成「开始选字」并直接发 pointercancel，换位当场夭折
      // （实测：按住 0.65s 成功进入换位态，一往下拖就被 cancel）。拖完立刻还原。
      document.body.style.userSelect = "none";
    }, LONG_PRESS_MS);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
  };

  const pane = (which: "danmaku" | "gift") => {
    const isGift = which === "gift";
    const dragged = swapPane === which;
    return (
      <div
        key={which}
        ref={isGift ? giftRef : danmakuRef}
        className={[styles.pane, isGift ? styles.paneGift : styles.paneDanmaku].join(" ")}
        data-testid={isGift ? "db-pane-gift" : "db-pane-danmaku"}
        data-pane={which}
        data-swap-drag={dragged ? "true" : undefined}
        data-swap-over={swapPane !== null && swapPane !== which && swapOver ? "true" : undefined}
        onPointerDown={onPaneDown(which)}
      >
        {isGift ? gift : danmaku}
      </div>
    );
  };

  const splitter = (
    <div
      key="splitter"
      ref={splitterRef}
      className={styles.splitter}
      data-testid="db-pane-splitter"
      data-dragging={dragging ? "true" : undefined}
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="调整礼物栏高度"
      aria-valuemin={Math.round(PANE_RATIO_MIN * 100)}
      aria-valuemax={Math.round(PANE_RATIO_MAX * 100)}
      aria-valuenow={Math.round(share * 100)}
      title="拖动调整高度；长按任一栏半秒可拖拽换位"
      onPointerDown={onSplitterDown}
      onKeyDown={onSplitterKey}
    />
  );

  return (
    <div
      ref={regionRef}
      className={styles.panes}
      data-testid="db-panes"
      data-gift={hasGift ? "on" : "off"}
      data-on-top={hasGift && giftOnTop ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      style={
        {
          "--gift-share": grow,
          "--danmaku-share": 1 - grow,
          "--chat-scale": fontScale,
        } as CSSProperties
      }
    >
      {/* DOM 顺序恒为「弹幕 → 分割条 → 礼物栏」，上下位置只由 flex-direction 决定（见文件头第 2 条） */}
      {[pane("danmaku"), hasGift ? splitter : null, hasGift ? pane("gift") : null]}
    </div>
  );
}
