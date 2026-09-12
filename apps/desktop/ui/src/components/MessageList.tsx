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
  const [following, setFollowing] = useState(prefs["ui.auto_scroll"]);
  const pauseOnHover = prefs["ui.pause_on_hover"];
  const [hovered, setHovered] = useState(false);
  // 面板展开/收起与窗口缩放会改可视高度，回调里要读到最新的「是否跟随」与行数，
  // 但观察器只该建一次（每来一条消息重建一次 ResizeObserver 是纯浪费）。
  const stateRef = useRef({ following, count: rows.length });
  stateRef.current = { following, count: rows.length };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 26,
    overscan: 12,
    getItemKey: (index) => rows[index].message.local_id,
  });

  // 跟随最新：仅在 following 且未悬停时把视口钉在末尾。
  useEffect(() => {
    if (!following || rows.length === 0) return;
    if (pauseOnHover && hovered) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, following, hovered, pauseOnHover, virtualizer]);

  // 聊天区是唯一生长区：表情/短语/筛选面板向上展开时它变矮。
  // 跟随模式下必须重新贴底，否则最新弹幕会被面板推出视口（issue #8 末条）。
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const { following: pinned, count } = stateRef.current;
      if (!pinned || count === 0) return;
      virtualizer.scrollToIndex(count - 1, { align: "end" });
    });
    observer.observe(el);
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
          fontSize: `${14 * prefs["ui.font_scale"]}px`,
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          // 8px 阈值：小于它视为仍在底部（docs/ui.md §3.3）。
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          if (atBottom !== following) setFollowing(atBottom);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
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
