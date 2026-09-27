import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { useApp } from "../store";
import { Avatar } from "./Avatar";
import { interactText } from "../filtering";
import { interactSlotRemainingMs, interactSlotSelection } from "../interact-slot";
import type { Message } from "../types";
import { INTERACT_SLOT_FADE_MS, INTERACT_SLOT_MS, INTERACT_SLOT_REPLACE_MS } from "../types";
import styles from "../app.module.css";

/**
 * 互动/进场消息共用弹幕区一处固定槽位（仿官方网页直播间，docs/ui.md §4.8）。
 *
 * 所有 `kind === "interact"` 的消息不进弹幕列表（`ui.interact_single_slot` 开时由
 * `filtering.toDisplayRows` 剔除，不再逐行堆叠挤占空间），改在这里显示**最新一条**；
 * 下一条到来时快速顶掉上一条（新自下而上滑入、旧向上滑出），空闲 `INTERACT_SLOT_MS`
 * 后浮层淡出，**淡出结束即整块卸载**。纯展示、不改缓冲：消息仍在 `messages` 里，
 * 关掉开关即逐条回到列表。
 *
 * 实现要点：
 * ① 当前房间最新的互动消息与「上一条」都从缓冲里**现算**（`interact-slot.ts` 的
 *    `interactSlotSelection`，纯函数、不看时钟 —— oxlint 的 `react(purity)` 不许渲染期
 *    读时钟）。组件唯一的状态是「哪一条已经到点卸掉了」，由下面那次定时器写入。
 * ② 空闲判定只认**时钟**（`INTERACT_SLOT_LIFE_MS` = 空闲 + 淡出）：到点把整块摘掉 ——
 *    不比对 CSS Modules 哈希后的 `animationName`，那个名字认不出来，槽位会永远留在
 *    DOM 里（理由见 `interact-slot.ts` 的文件头）。
 * ③ 卸载就是「缩回」：`.interactSlot` 一离开 DOM，`.chatWrap:has(> .interactSlot)` 失效 →
 *    预留归零 → 弹幕上移补齐空出的那一段（需求 1.2 / 1.4）。预留的**唯一**来源是那条
 *    `:has()` 规则，不看任何开关属性（需求 1.3）。
 * ④ 滑入 / 滑出 / 淡出仍全交 CSS 动画（`interactSlotEnter` / `interactSlotExit` /
 *    `interactSlotFade`），组件只负责「什么时候卸」。
 */
export function InteractSlot() {
  const messages = useApp((s) => s.messages);
  const activeRoomId = useApp((s) => s.activeRoomId);
  /** 已经到点卸载的那条互动（`local_id`）；`0` = 还没卸过任何一条。 */
  const [expiredId, setExpiredId] = useState(0);

  // 渲染期只跑无时钟的那一半（`react(purity)` 不许在渲染里调 `Date.now()`）：
  // 该显示哪两条只看缓冲，什么时候卸由下面那次定时器说了算。
  const { latest, prev } = useMemo(
    () => interactSlotSelection(messages, activeRoomId),
    [messages, activeRoomId],
  );

  useEffect(() => {
    const remainingMs = interactSlotRemainingMs(latest, Date.now());
    if (latest === null || remainingMs === null) return;
    const id = latest.local_id;
    // 到点卸载整块。`Math.max(0, …)` 兜住「排定时器时寿命已经过了」（那就不该再多留一帧）。
    const timer = window.setTimeout(() => setExpiredId(id), Math.max(0, remainingMs));
    return () => window.clearTimeout(timer);
  }, [latest]);

  if (latest === null || latest.local_id === expiredId) return null;

  return (
    <div className={styles.interactSlot} data-testid="db-interact-slot" aria-hidden="true">
      <div
        key={latest.local_id}
        className={styles.interactSlotBox}
        style={
          {
            "--slot-replace-ms": `${INTERACT_SLOT_REPLACE_MS}ms`,
            // 空闲到点开始淡出、淡完 JS 同时卸载：两个数就是寿命的两半（interact-slot.ts）。
            "--slot-idle-ms": `${INTERACT_SLOT_MS}ms`,
            "--slot-fade-ms": `${INTERACT_SLOT_FADE_MS}ms`,
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
