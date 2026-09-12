import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { MessageRow } from "./MessageRow";
import type { DisplayRow } from "../filtering";
import type { Message, Prefs } from "../types";
import styles from "../app.module.css";

interface Props {
  rows: DisplayRow[];
  anchorUid?: number;
  prefs: Prefs;
  onReport?: (message: Message) => void;
}

/** 聊天流。虚拟滚动 + 自动跟随/暂停规则见 docs/ui.md §2、§3。 */
export function MessageList({ rows, anchorUid, prefs, onReport }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(prefs["ui.auto_scroll"]);
  const pauseOnHover = prefs["ui.pause_on_hover"];
  const [hovered, setHovered] = useState(false);

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

  const showJumpButton = !following && rows.length > 0;

  return (
    <div className={styles.chatArea}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        style={{
          fontSize: `${14 * prefs["ui.font_scale"]}px`,
          opacity: prefs["ui.opacity"],
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
                showLiveDivider={
                  item.index > 0 &&
                  !rows[item.index].message.is_history &&
                  rows[item.index - 1].message.is_history
                }
                anchorUid={anchorUid}
                prefs={prefs}
                onReport={onReport}
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
