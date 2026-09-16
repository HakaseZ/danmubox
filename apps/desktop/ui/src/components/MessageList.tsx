import { useEffect, useRef, useState } from "react";
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual";

import { MessageRow } from "./MessageRow";
import type { MenuPoint } from "./ContextMenu";
import type { DisplayRow } from "../filtering";
import type { Message, Prefs } from "../types";
import styles from "../app.module.css";

interface Props {
  rows: DisplayRow[];
  anchorUid?: number;
  prefs: Prefs;
  onMenu: (message: Message, at: MenuPoint) => void;
  /**
   * 这一份列表实例在**哪一处**（docs/ui.md §5.3）：弹幕区（`chat`）还是独立礼物栏（`gift`）。
   *
   * 两处**共用这一份实现**（用户 2026-09-16 第 2 条：礼物栏要与弹幕区「一样的布局、一样的
   * 背景色、一样的自动滚动」）—— 虚拟列表、贴底判据、8px 阈值、悬停暂停、「回到最新」
   * 与 `scrollToIndex(align: "end")` 全是同一段代码，各实例各持自己的滚动位置与虚拟列表状态。
   * scope 只做两件事：把两处的 `data-testid` 分成两族（否则「弹幕流里还有没有这条」的断言
   * 会被礼物栏那一份蒙混过去），以及决定礼物 / 大航海行画不画金额行。
   */
  scope?: "chat" | "gift";
  /**
   * 空列表时的文案（不传 = 什么都不画，例如弹幕区的空态由别的层负责）。
   * 礼物栏用「本场还没有礼物」（§5.3）——文案由调用方给，判据（哪一套行算「本场」）
   * 因此留在调用方那一处。
   */
  empty?: string;
}

/**
 * 两处实例的分叉（docs/ui.md §2.3 的稳定钩子表）：弹幕区沿用既有那一套钩子，
 * 礼物栏自成一族 —— 两处的行、滚动容器与「回到最新」都能被分别选中。
 */
interface ListScope {
  /** 列表根（`.chatArea`）。 */
  area: string;
  /** 滚动容器（`.scroller`）。 */
  scroll: string;
  /** 虚拟高度块（`.msgList`）。 */
  list: string;
  /** 「回到最新」那枚悬浮钮。 */
  anchor: string;
  /** 交给 `MessageRow` 的 testid 前缀。 */
  row: "msg" | "gift";
  /** 礼物 / 大航海行画不画金额行（只有礼物栏那一份画，见 §4.1 / §5.3）。 */
  showGiftAmount: boolean;
}

const SCOPES: Record<"chat" | "gift", ListScope> = {
  chat: {
    area: "db-chat-area",
    scroll: "db-chat-scroll",
    list: "db-msg-list",
    anchor: "db-bottom-anchor",
    row: "msg",
    showGiftAmount: false,
  },
  gift: {
    area: "db-gift-area",
    scroll: "db-gift-scroll",
    list: "db-gift-list",
    anchor: "db-gift-anchor",
    row: "gift",
    showGiftAmount: true,
  },
};

/**
 * 贴底：交给虚拟列表自己定位（`scrollToIndex(align: "end")`）。
 *
 * 不要换成「`el.scrollTop = el.scrollHeight`」——内容高度还没测准（虚拟列表先估后测）时，
 * 这么赋值会把 scrollTop 往回**夹**，onScroll 随即把它读成「用户往上滚」，
 * 于是跟随被判成暂停、再也不贴底（踩过两次：60 条连发后列表停在离底 826/1086px 处）。
 *
 * 末行与容器底边的呼吸空间（= 容器下内边距）不由这里负责，由高度块的 `flexShrink: 0` 保证：
 * 块不被压扁，容器下内边距才不会被挤出可滚区域。
 */
function pinToBottom(
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>,
  count: number,
) {
  if (count > 0) virtualizer.scrollToIndex(count - 1, { align: "end" });
}

/** 聊天流。虚拟滚动 + 自动跟随/暂停规则见 docs/ui.md §2、§3。 */
export function MessageList({
  rows,
  anchorUid,
  prefs,
  onMenu,
  scope = "chat",
  empty,
}: Props) {
  const ids = SCOPES[scope];
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(prefs["ui.auto_scroll"]);
  const pauseOnHover = prefs["ui.pause_on_hover"];
  const [hovered, setHovered] = useState(false);
  // 面板展开/收起与窗口缩放会改可视高度，回调里要读到最新的「是否跟随」与行数，
  // 但观察器只该建一次（每来一条消息重建一次 ResizeObserver 是纯浪费）。
  const stateRef = useRef({ following, count: rows.length });
  stateRef.current = { following, count: rows.length };
  // 上一次滚动位置：用来分辨「用户往上滚」与「布局变化导致的离底变远」（见 onScroll）。
  // 首个滚动事件没有可比的上一次（`null`），按「不在底部就算暂停」处理。
  const prevScrollTopRef = useRef<number | null>(null);

  /* 冻结视口时记下**滚动容器自己的顶边**（屏幕坐标）：布局变化里有一部分是「容器自己挪了」
     —— 进出沉浸模式把它整个下移 88.1px（房间头 57 + 房间标签条 31.1 回到弹幕区**上方**），
     而容器里面的内容一动不动（实测：`scrollTop` 不变、锚点行的内容坐标不变、它相对容器顶边的
     偏移 1px → 1px）。容器挪了多少就把 `scrollTop` 补回多少，用户在读的那一行才留在原来的
     屏幕位置上（docs/ui.md §7.3 第 5 行、§2.3.1「沉浸态里滚到中段再展开，当前位置不被弹回」）。

     **只认容器自己的位移，不认「锚点行的屏幕位移」**（后者试过、行不通）：把锚点行的屏幕位移
     当差值补，等于把**虚拟列表自己刚做完的修正**再补一次 —— 礼物栏展开时列表刚挂载、那次贴底
     落在还没量准的内容高度上（261），量准之后的修正把它带到真实底部（437），锚点行相对记账
     时刻正好差了 176px，补回去又把它推回 261：列表停在离底 176px、「回到最新」一直挂着
     （冒烟 `giftFollowPinnedToBottom` / `giftNewestRowVisible` 当场转红）。
     容器**内**的那一部分（锚点上方各行重算偏移）本来就由虚拟列表按 item 尺寸变化自己补
     （`shouldAdjustScrollPositionOnItemSizeChange` 的默认行为）—— 两边各管一段，互不打架。 */
  const scrollerTopRef = useRef<number | null>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    // 行的实测高度由虚拟列表量准，这里只是**估值**（先估后测，见下面的贴底注释）。
    // 弹幕行改成上下两行（身份行 + 正文行）后，一行 = 2 × 21px 行盒 + 2 × 8px 内边距 ≈ 58px
    // （改前是单行 ≈ 29px，估值写的是 26）。正文折行时更高，由实测修正。
    estimateSize: () => 58,
    overscan: 12,
    // 行的身份 = `local_id`，它在**一行的整个生命期内不变**：本地那条收到上游回播时
    // 既不重建也不改写（用户 2026-09-13，见 `store.onMessage`），转正意义上的「换 id」
    // 已经不存在了。**别换成会变的东西**（渲染序号 / `ts` / 上游 id…）：key 一变
    // React 就拆掉这个节点重建，行内 `<img>` 跟着重新挂载、样式重算，
    // 「发送那一刻的那一帧」就没了（这条由冒烟断言 `sendOptimisticEchoSameNode` 钉住）。
    getItemKey: (index) => rows[index].message.local_id,
  });

  // 跟随最新：仅在 following 且未悬停时把视口钉在末尾（`pinToBottom` 说明了为什么不是
  // `scrollToIndex(align: "end")`）。也不能换成「直接滚到 scrollHeight 后不管」：
  // 虚拟列表的高度先按 `estimateSize` 估、再由实测修正，滚完若没人再贴一次就会差出一截——
  // 所以下面的 ResizeObserver 同时盯着容器与内容块，任何高度变化都会重新贴底。
  useEffect(() => {
    if (!following || rows.length === 0) return;
    if (pauseOnHover && hovered) return;
    pinToBottom(virtualizer, rows.length);
  }, [rows.length, following, hovered, pauseOnHover, virtualizer]);

  // 聊天区是唯一生长区：表情/短语/筛选面板向上展开时它变矮。
  // 跟随模式下必须重新贴底，否则最新弹幕会被面板推出视口（issue #8 末条）。
  // 两个元素都要观察：外层容器（面板/礼物栏开合改可视高度）与内层高度块
  // （虚拟列表先估后测，实测修正同样会改内容高度），否则都会让「贴底」悄悄失效。
  // 冻结视口时不贴底，改为**按容器自己的位移补 `scrollTop`**（见 `scrollerTopRef` 的说明）：
  // 容器顶边也会挪（进出沉浸模式：房间头 57 + 房间标签条 31.1 = 88.1px），不补的话
  // 整块内容会跟着容器一起挪 —— 用户在读的那一行于屏幕上就下移了一行。
  useEffect(() => {
    const el = scrollerRef.current;
    const content = listRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const { following: pinned, count } = stateRef.current;
      // 容器自己的顶边挪了多少 = 这一轮要补回的差值（上一次落定时记的值 → 现在）。
      // 先把账翻到当前值再用：补完不迭代，下一轮以这次的落点为准（反复逼近会在子像素上抖）。
      const top = el.getBoundingClientRect().top;
      const previousTop = scrollerTopRef.current;
      scrollerTopRef.current = top;
      if (pinned) {
        if (count > 0) pinToBottom(virtualizer, count);
        return;
      }
      if (previousTop !== null && Math.abs(top - previousTop) >= 0.5) {
        el.scrollTop += top - previousTop;
      }
    });
    observer.observe(el);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [virtualizer]);

  const showJumpButton = !following && rows.length > 0;

  return (
    <div className={styles.chatArea} data-testid={ids.area}>
      <div
        ref={scrollerRef}
        data-testid={ids.scroll}
        className={styles.scroller}
        style={{
          // em 而不是 px：基准字号由 body 的 --fs-root 给定（app.module.css 的令牌）
          fontSize: `${prefs["ui.font_scale"]}em`,
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          // 8px 阈值：小于它视为仍在底部（docs/ui.md §3.3）。
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          const previous = prevScrollTopRef.current;
          prevScrollTopRef.current = el.scrollTop;
          if (atBottom) {
            // 回到（或仍在）底部 = 跟随。
            if (!following) setFollowing(true);
            return;
          }
          // 不在底部时**只有用户往上滚**才算「我想暂停跟随」。
          // 面板展开/收起、礼物栏开合、行高实测修正都会让「离底多远」变化，但那不是用户的意图——
          // 那些情况由上面的 ResizeObserver 重新贴底。修复前这里是 `setFollowing(atBottom)`，
          // 于是展开一轮面板就会把跟随悄悄关掉（窄屏实测：展开房管面板后列表停在离底 398px 处，
          // 最新一条被推出视口，只剩「回到最新」按钮在提示）。
          if (previous === null || el.scrollTop < previous) setFollowing(false);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* 空态（礼物栏用「本场还没有礼物」）：文案由调用方给，判据因此留在调用方那一处
            （哪一套行算「本场」由它决定，见 Props.empty）。它落在滚动容器里，
            与旧版的 `db-gift-body` 空态同一个位置。 */}
        {rows.length === 0 && empty !== undefined && (
          <div className={styles.empty}>{empty}</div>
        )}
        <div
          ref={listRef}
          data-testid={ids.list}
          className={styles.msgList}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
            // 不许被 flex 压扁：滚动容器是 flex 列，默认 `flex-shrink: 1` 会把这块高度块
            // 缩到视口那么高，于是虚拟行**溢出**它、并把容器下内边距挤出可滚区域——
            // 贴底时末行就紧贴输入区/面板边框（实测 0.2px）。保持原高，那段内边距才留在末行下方。
            flexShrink: 0,
          }}
        >
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <MessageRow
                row={rows[item.index]}
                anchorUid={anchorUid}
                prefs={prefs}
                onMenu={onMenu}
                scope={ids.row}
                showGiftAmount={ids.showGiftAmount}
              />
            </div>
          ))}
        </div>
      </div>
      {showJumpButton && (
        <button
          className={`${styles.ctlRound} ${styles.bottomAnchor}`}
          data-testid={ids.anchor}
          title="回到最新"
          aria-label="回到最新"
          onClick={() => {
            setFollowing(true);
            pinToBottom(virtualizer, rows.length);
          }}
        >
          {/*
            下箭头（用户 2026-09-13 #2：「回到最新图标改为下箭头，指这整个按钮删掉，
            用一个返回按钮旋转 90° 来代替」）：所以这里**不另造控件**，直接挂房间里那两枚
            圆形控件用的 `.ctlRound`（40 × 40 正圆、透明底 + hover 洗色）与 `.ctlIcon`
            （60% 盒 = 24px，与 viewBox 1:1）—— 图标因此与返回键**同源几何**
            （docs/ui.md §3.1 的矢量规范）：`viewBox="0 0 24 24"`、同一条 `stroke-width 1.75`、
            round 线帽、墨迹居中 (12,12)、主轴 16 单位。把返回键 `M15 4.875 9 12l6 7.125`
            绕 (12,12) 转 -90°（朝下）即得下面这条 path（**不**挂 CSS `rotate()`：`rotate(90deg)`
            会把左箭头转成向上，而且直写省一层 transform，描边宽度 / 墨迹居中不必再跟变换打架）。
            文字已删，可访问名改由 `aria-label` 给（冒烟按可访问名断言）；图标是装饰，`aria-hidden`。
          */}
          <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4.875 9 12 15l7.125-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
