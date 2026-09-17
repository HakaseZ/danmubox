/**
 * 房间状态点（直播三态）的**判据与令牌**：房间头与房间标签条共用这一份。
 *
 * 从 `components/RoomView.tsx` 拆出来的（2026-09-17）：那个文件只该导出组件，
 * 混在一处会让 Fast Refresh 对整个文件失效（`react/only-export-components`）。
 * 口径一字未改，只是换了个落点 —— 两处圆点仍然走同一个 `liveKindOf`，颜色因此必然一致。
 */
import styles from "./app.module.css";
import type { ConnState } from "./types";

/** 状态点三态：**开播 / 下播 / 未连接**（房间头与房间标签页**共用这一套**）。 */
export type LiveKind = "on" | "off" | "idle";

/** 连接态 × 上游 `live_status` → 三态。这是**唯一**的判据：两处圆点都走它，颜色因此必然一致。 */
export function liveKindOf(
  conn: ConnState | undefined,
  connected: boolean,
  liveStatus: number,
): LiveKind {
  // 两路「连没连上」的信号取**与**：事件驱动的连接态（`danmubox://status`）与列表载荷的
  // `connected` 各自都可能落后 —— 刚开房间时事件还没到（那时以载荷为准），断开那一刻载荷
  // 已经刷新而事件还在路上（那时以载荷为准）。**任一说没连上，这颗点就是未连接（灰）**：
  // 宁可早一格变灰，也不许把「已经断了」一直显示成红 / 绿（用户 2026-09-13 报的就是它 ——
  // 标题旁那颗点断连后没有变化，只有红绿）。
  const live = conn === undefined ? connected : conn === "connected" && connected;
  return live ? (liveStatus === 1 ? "on" : "off") : "idle";
}

/** 三态 → 圆点配色（`--live-*` 三枚令牌）。 */
export const LIVE_DOT_CLASS: Record<LiveKind, string> = {
  on: styles.liveOn,
  off: styles.liveOff,
  idle: styles.liveIdle,
};

/** 三态 → 文案：只进 `title` / `aria-label`，不上屏（用户 2026-09-12：房间头不再写字）。 */
export const LIVE_TEXT: Record<LiveKind, string> = {
  on: "开播",
  off: "下播",
  idle: "未连接",
};
