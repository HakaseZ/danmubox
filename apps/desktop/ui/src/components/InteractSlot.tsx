import { useMemo, useState, type CSSProperties } from "react";

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
  // 用 `latest.local_id` 作 key：下一条互动到达即整块重挂，`idle` 随之重置为 false，
  // 不依赖 effect，也就不踩 set-state-in-effect；进场 / 退场 / 接力动画靠内层 key 重挂触发。
  return <InteractSlotInner key={latest.local_id} latest={latest} prev={prev} />;
}

function InteractSlotInner({ latest, prev }: { latest: Message; prev?: Message }) {
  const [idle, setIdle] = useState(false);
  // 空闲（最新一条互动已淡出）时整块卸载，弹幕区底部预留高度随之归零、上方弹幕自动回填
  // （仿官方网页直播间「互动消息」条：无消息时那条位置不留空白）。预留高度由 CSS 绑在
  // `.interactSlot` 元素存在上（见 app.module.css 的 `:has` 选择器），这里只在淡出动画结束后
  // 把元素摘掉；进场 / 退场 / 接力动画全部保留，不重写组件。
  if (idle) return null;

  return (
    <div className={styles.interactSlot} data-testid="db-interact-slot" aria-hidden="true">
      <div
        className={styles.interactSlotBox}
        style={
          {
            "--slot-replace-ms": `${INTERACT_SLOT_REPLACE_MS}ms`,
            "--slot-life-ms": `${INTERACT_SLOT_MS + 300}ms`,
          } as CSSProperties
        }
        onAnimationEnd={(event) => {
          // 仅自身这条「生命周期」动画结束才判定空闲；行内进/退场动画会冒泡上来，凭动画名过滤。
          // CSS Modules 会把 @keyframes 名哈希成 `_interactSlotLife_<hash>_<n>`（实测产物），
          // `event.animationName` 因此永远不等于字面量 "interactSlotLife" —— 必须按子串判
          // （issue 271100：等值比较导致 idle 永不成立、槽位永不卸载、弹幕区预留高度永不收回）。
          if (event.animationName.includes("interactSlotLife")) setIdle(true);
        }}
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
