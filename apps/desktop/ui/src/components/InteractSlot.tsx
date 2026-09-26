import { useMemo, type CSSProperties } from "react";

import { useApp } from "../store";
import { Avatar } from "./Avatar";
import { interactText } from "../filtering";
import type { Message } from "../types";
import { INTERACT_SLOT_MS, INTERACT_SLOT_REPLACE_MS } from "../types";
import styles from "../app.module.css";

/**
 * 互动/进场消息共用弹幕区一处固定槽位（仿官方网页直播间，docs/ui.md §4.8）。
 *
 * 所有 `kind === "interact"` 的消息不进弹幕列表（`ui.interact_single_slot` 开时由
 * `filtering.toDisplayRows` 剔除，不再逐行堆叠挤占空间），改在这里显示**最新一条**；
 * 下一条到来时快速顶掉上一条（新自下而上滑入、旧向上滑出），空闲 `INTERACT_SLOT_MS`
 * 后浮层淡出。纯展示、不改缓冲：消息仍在 `messages` 里，关掉开关即逐条回到列表。
 *
 * 实现要点：当前房间最新的互动消息与「上一条」都从缓冲里**现算**（纯派生，不碰 ref、
 * 不在 effect 里 setState，规避 oxlint 的 set-state-in-effect / refs 两条规则）。latest
 * 进展示层，prev 作为接力动画的退场层——下一条到达时 `local_id` 作 `key` 让整块重挂，
 * 退场层正好是被顶掉的那条。空闲淡出与滑入滑出全交 CSS 动画。
 */
export function InteractSlot() {
  const messages = useApp((s) => s.messages);
  const activeRoomId = useApp((s) => s.activeRoomId);

  // 当前房间**最新一条**与**上一条**互动消息都从缓冲里现算：latest 用于展示，prev 是
  // 接力动画的退场层（下一条到达时它正好是被顶掉的那条）。按 ts 取最大与次大两条。
  const { latest, prev } = useMemo(() => {
    let found: Message | undefined;
    let prevFound: Message | undefined;
    for (const m of messages) {
      if (m.room_id !== activeRoomId) continue;
      if (m.kind !== "interact") continue;
      if (!found || m.ts > found.ts) {
        prevFound = found;
        found = m;
      } else if (!prevFound || m.ts > prevFound.ts) {
        prevFound = m;
      }
    }
    return { latest: found, prev: prevFound };
  }, [messages, activeRoomId]);

  if (!latest) return null;

  return (
    <div className={styles.interactSlot} data-testid="db-interact-slot" aria-hidden="true">
      <div
        key={latest.local_id}
        className={styles.interactSlotBox}
        style={
          {
            "--slot-replace-ms": `${INTERACT_SLOT_REPLACE_MS}ms`,
            "--slot-life-ms": `${INTERACT_SLOT_MS + 300}ms`,
          } as CSSProperties
        }
      >
        {prev && (
          <div
            key={`exit-${prev.local_id}`}
            className={`${styles.interactSlotRow} ${styles.interactSlotExit}`}
          >
            <InteractContent message={prev} />
          </div>
        )}
        <div
          key={`cur-${latest.local_id}`}
          className={`${styles.interactSlotRow} ${styles.interactSlotEnter}`}
        >
          <InteractContent message={latest} />
        </div>
      </div>
    </div>
  );
}

function InteractContent({ message }: { message: Message }) {
  return (
    <>
      {message.face !== undefined && message.face.length > 0 && (
        <span className={styles.interactSlotAvatar}>
          <Avatar url={message.face} name={message.uname} testId="db-interact-avatar" />
        </span>
      )}
      <span className={styles.interactSlotText}>{interactText(message)}</span>
    </>
  );
}
