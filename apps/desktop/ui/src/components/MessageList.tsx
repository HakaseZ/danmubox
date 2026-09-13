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
}

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
export function MessageList({ rows, anchorUid, prefs, onMenu }: Props) {
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
  useEffect(() => {
    const el = scrollerRef.current;
    const content = listRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const { following: pinned, count } = stateRef.current;
      if (!pinned || count === 0) return;
      pinToBottom(virtualizer, count);
    });
    observer.observe(el);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [virtualizer]);

  const showJumpButton = !following && rows.length > 0;

  return (
    <div className={styles.chatArea}>
      <div
        ref={scrollerRef}
        data-testid="db-chat-scroll"
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
        <div
          ref={listRef}
          data-testid="db-msg-list"
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
              />
            </div>
          ))}
        </div>
      </div>
      {showJumpButton && (
        <button
          className={styles.bottomAnchor}
          data-testid="db-bottom-anchor"
          onClick={() => {
            setFollowing(true);
            pinToBottom(virtualizer, rows.length);
          }}
        >
          回到最新
        </button>
      )}
    </div>
  );
}
