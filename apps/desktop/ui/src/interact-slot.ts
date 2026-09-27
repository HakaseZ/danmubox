// 互动槽位（`ui.interact_single_slot` 的浮层，`components/InteractSlot.tsx`）的状态判据。
// 抽成纯函数是为了能被 `node --test` 直接跑（显示层纯逻辑，写法见 `docs/testing.md` §9）：
//
//     cd apps/desktop/ui && node --test src/interact-slot.test.ts
//
// **为什么空闲判定只能落在时钟上**（需求 1.4）：淡出是 CSS Modules 里的 `@keyframes`，
// 类名与动画名都会被哈希改名（`interactSlotFade` → `_interactSlotFade_xxxx`），
// 按 `animationName` 认「我的淡出播完了没有」认不出来 —— 于是槽位永不卸载、
// `.chatWrap` 的预留高度永不回收（需求 1.2 的「缩回补齐」也就永远不会发生）。
// 判据因此只有一条：最新一条互动消息到达后 `INTERACT_SLOT_LIFE_MS` 就是它的寿命，
// **JS 计时到点卸载**；CSS 只负责把淡出画出来（两个数取自同一对常量）。
//
// **为什么是两半**：`react(purity)`（oxlint，见 `.oxlintrc.json` 的 `plugins: ["react"]`）
// 不许在渲染期调 `Date.now()` 这类不纯函数 —— 所以
//   ① 渲染期只跑 `interactSlotSelection`（只看缓冲，不看时钟）；
//   ② 时钟那一半 `interactSlotRemainingMs` 在 effect 里跑（effects 本就允许读时钟）。
// 两半合起来就是「消息列表 + now ⇒ 当前是否活跃 / 该不该卸载」这一条判据（需求 §一 1.4）。
//
// 时间口径：互动的 `Message.ts` 是**本地收包时刻**（`cmd.rs` 的 `interact_json` /
// `interact_v2` 同口径，上游时钟只进 debug 留档），因此 `now - ts` 就是本地时钟量出来的
// 空闲时长，不存在上下游时钟差。

// 显式带 `.ts` 后缀：本文件的单测用 `node --test src/interact-slot.test.ts` 直接跑
// （Node 的类型擦除**只认带后缀的相对说明符**，它不解析 `./types` 那种无后缀写法；
// 与 `filtering.ts` 同一条口径）。`tsconfig.app.json` 已开 `allowImportingTsExtensions`。
import type { Message } from "./types.ts";
import { INTERACT_SLOT_FADE_MS, INTERACT_SLOT_MS } from "./types.ts";

/** 槽位总寿命 = 空闲时长 + 淡出时长（两半的唯一来源是 `types.ts` 那两枚常量）。 */
export const INTERACT_SLOT_LIFE_MS = INTERACT_SLOT_MS + INTERACT_SLOT_FADE_MS;

export interface InteractSlotSelection {
  /** 当前该显示的互动消息（本房间 `ts` 最大的那条）；没有则 `null`。 */
  latest: Message | null;
  /**
   * 接力动画的**退场层**：次新的那条，仅当它在 `latest` 到达时**还没到点**（否则不画）。
   * 槽位现在会真卸载，迟到的新消息若还带着一条早已到点的 `prev`，滑出动画就会闪出
   * 一个过期的人名。
   */
  prev: Message | null;
}

/**
 * 从缓冲里现算槽位该显示哪两条（**只看缓冲，不看时钟** —— 渲染期跑的就是这一半）。
 *
 * `roomId` 为 `undefined`（列表页 / 没进房间）时一律返回空 —— 槽位只在房间页挂载，
 * 这一条守的是「别的房间的互动不许串进来」。
 */
export function interactSlotSelection(
  messages: readonly Message[],
  roomId: number | undefined,
): InteractSlotSelection {
  let latest: Message | null = null;
  let prev: Message | null = null;
  for (const message of messages) {
    if (message.room_id !== roomId) continue;
    if (message.kind !== "interact") continue;
    if (latest === null || message.ts > latest.ts) {
      prev = latest;
      latest = message;
    } else if (prev === null || message.ts > prev.ts) {
      prev = message;
    }
  }
  if (latest === null) return { latest: null, prev: null };
  // 退场层只在这条被顶掉的那一刻**还在屏幕上**才画：`latest` 到点前它自己必须也还在寿命内。
  if (prev !== null && latest.ts - prev.ts >= INTERACT_SLOT_LIFE_MS) prev = null;
  return { latest, prev };
}

/**
 * 距「整块卸载」还剩多少毫秒（`<= 0` = 到点，该卸载）；没有活跃消息时为 `null`
 * （组件据此**不排**定时器）。
 */
export function interactSlotRemainingMs(latest: Message | null, now: number): number | null {
  if (latest === null) return null;
  return INTERACT_SLOT_LIFE_MS - (now - latest.ts);
}
