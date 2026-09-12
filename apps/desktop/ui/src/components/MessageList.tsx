import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
    estimateSize: () => 26,
    overscan: 12,
    getItemKey: (index) => rows[index].message.local_id,
  });

  // 跟随最新：仅在 following 且未悬停时把视口钉在末尾。
  // 这里必须用 `virtualizer.scrollToIndex(align: "end")`，**不能**换成 `el.scrollTop = el.scrollHeight`：
  // 虚拟列表的高度先按 `estimateSize` 估、再由实测修正，直接滚到 scrollHeight 会在修正后差出一截
  // （实测：60 条连发后列表停在离底很远的地方，onScroll 随即把 following 判成 false，整条跟随链断掉）。
  // 代价是末行**底边**对齐容器底边，容器下内边距被滚出视野（最新一条紧贴输入区/面板边框，实测差 0.2px）；
  // 那是「贴底」的正常样子，不是被遮挡。
  useEffect(() => {
    if (!following || rows.length === 0) return;
    if (pauseOnHover && hovered) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
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
      virtualizer.scrollToIndex(count - 1, { align: "end" });
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
            virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
          }}
        >
          回到最新
        </button>
      )}
    </div>
  );
}
