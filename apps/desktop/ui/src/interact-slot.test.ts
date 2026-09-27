/// <reference types="node" />
// `interact-slot.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/interact-slot.test.ts
//
// 为什么要把 `node` 的类型在这里显式引一次：本项目 `tsconfig.app.json` 的 `types` 只有
// `vite/client`（应用代码不该看得见 Node 全局），而这一份要 `node:test` / `node:assert`；
// 文件内的三斜线引用只影响这一个编译单元，不用去动共用的 tsconfig。
//
// 钉的是需求 §一 1.1–1.4 里那条**只能靠时钟**的判据（CSS Modules 会把 `@keyframes`
// 改名，比对 `animationName` 认不出来 ⇒ 槽位永不卸载、预留永不回收）：
//   ① 槽位只认「本房间 + interact + ts 最新」的那一条，其余一律不参与；
//   ② 寿命是**到达时刻起算**的 `INTERACT_SLOT_LIFE_MS` = 空闲 4s + 淡出 300ms；
//      到点 `remainingMs <= 0`，组件据此卸载 ⇒ `:has()` 失效 ⇒ 预留归零（1.2 / 1.4）；
//   ③ 退场层（接力动画里向上滑出的那条）只在它被顶掉时还在屏幕上才画。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INTERACT_SLOT_LIFE_MS,
  interactSlotRemainingMs,
  interactSlotSelection,
} from "./interact-slot.ts";
import type { Message } from "./types.ts";
import { INTERACT_SLOT_FADE_MS, INTERACT_SLOT_MS } from "./types.ts";

const ROOM = 5440;
const T0 = 1_700_000_000_000;

/** 只写会参与这一族判据的字段，其余取契约 §5 的缺省。 */
function msg(kind: Message["kind"], ts: number, over: Partial<Message> = {}): Message {
  return {
    local_id: ts,
    room_id: ROOM,
    kind,
    ts,
    uid: 100,
    uname: "进场观众",
    content: "",
    color: 0,
    medal_level: 0,
    medal_name: "",
    medal_lit: true,
    guard_level: 0,
    medal_guard_level: 0,
    reply_to_uid: 0,
    reply_to_uname: "",
    is_admin: false,
    is_history: false,
    amount: 0,
    combo_id: "",
    upstream_id: "",
    ...over,
  };
}

/**
 * 组件里跑的正是这两半（`react(purity)` 不许在渲染期调 `Date.now()`，所以时钟那一半
 * 放在 effect 里）：这里合成一个入口，用例的表达就是「缓冲 + now ⇒ 活跃 / 该不该卸载」。
 */
function view(messages: readonly Message[], roomId: number | undefined, now: number) {
  const { latest, prev } = interactSlotSelection(messages, roomId);
  return { latest, prev, remainingMs: interactSlotRemainingMs(latest, now) };
}

test("寿命 = 空闲 4s + 淡出 300ms（两个数各自只有一处来源）", () => {
  assert.equal(INTERACT_SLOT_MS, 4000);
  assert.equal(INTERACT_SLOT_FADE_MS, 300);
  assert.equal(INTERACT_SLOT_LIFE_MS, 4300);
});

test("空缓冲 / 只有别的 kind：没有活跃消息，也不排卸载定时器", () => {
  const messages = [msg("danmaku", T0), msg("gift", T0 + 1), msg("system", T0 + 2)];
  const state = view(messages, ROOM, T0 + 10);
  assert.equal(state.latest, null);
  assert.equal(state.prev, null);
  assert.equal(state.remainingMs, null, "没有活跃消息 ⇒ 不该排定时器（null，而不是 0）");
});

test("别的房间的互动不串进槽位；没进房间（roomId undefined）同样为空", () => {
  const messages = [msg("interact", T0, { room_id: ROOM + 1 })];
  assert.equal(view(messages, ROOM, T0).latest, null);
  assert.equal(view(messages, undefined, T0).latest, null);
});

test("只显示最新一条，次新的作为退场层，剩余寿命从**最新那条的到达时刻**起算", () => {
  const first = msg("interact", T0);
  const second = msg("interact", T0 + 100, { local_id: 2 });
  const state = view([first, second], ROOM, T0 + 500);
  assert.equal(state.latest?.local_id, 2);
  assert.equal(state.prev?.local_id, first.local_id);
  // now 距**最新那条**（T0 + 100）400ms —— 上一条的到达时刻不参与寿命（那是接力，不是计时）。
  assert.equal(state.remainingMs, INTERACT_SLOT_LIFE_MS - 400);
});

test("最新的判定按 ts 而不是数组顺序（缓冲可能乱序）", () => {
  const older = msg("interact", T0);
  const newer = msg("interact", T0 + 900, { local_id: 2 });
  const state = view([newer, older], ROOM, T0 + 1_000);
  assert.equal(state.latest?.local_id, 2);
  assert.equal(state.prev?.local_id, older.local_id);
});

test("到点：空闲满寿命时 remainingMs = 0，超过即为负（组件两种情况都卸）", () => {
  const messages = [msg("interact", T0)];
  assert.equal(
    view(messages, ROOM, T0 + INTERACT_SLOT_LIFE_MS - 1).remainingMs,
    1,
    "还差 1ms：不该卸（淡出动画这时正在播）",
  );
  assert.equal(view(messages, ROOM, T0 + INTERACT_SLOT_LIFE_MS).remainingMs, 0);
  assert.ok((view(messages, ROOM, T0 + INTERACT_SLOT_LIFE_MS + 5_000).remainingMs ?? 0) < 0);
});

test("淡出期间（空闲已过 4s 但没到 4.3s）仍在寿命内 —— 卸载不能早于动画播完", () => {
  const messages = [msg("interact", T0)];
  const state = view(messages, ROOM, T0 + INTERACT_SLOT_MS + 150);
  assert.ok((state.remainingMs ?? 0) > 0);
  assert.equal(state.remainingMs, INTERACT_SLOT_FADE_MS - 150);
});

test("迟到的新消息不带走早已到点的退场层（否则滑出动画会闪出一个过期人名）", () => {
  const stale = msg("interact", T0);
  const fresh = msg("interact", T0 + INTERACT_SLOT_LIFE_MS, { local_id: 2 });
  const state = view([stale, fresh], ROOM, T0 + INTERACT_SLOT_LIFE_MS);
  assert.equal(state.latest?.local_id, 2, "新的那条照样上屏");
  assert.equal(state.prev, null, "旧的那条早到点了，不该再当退场层");
});

test("接力窗口内（寿命之内）的退场层照画", () => {
  const first = msg("interact", T0);
  const second = msg("interact", T0 + INTERACT_SLOT_LIFE_MS - 1, { local_id: 2 });
  const state = view([first, second], ROOM, T0 + INTERACT_SLOT_LIFE_MS);
  assert.equal(state.prev?.local_id, first.local_id, "差 1ms 到点：那一刻它还在屏幕上");
});

test("非互动消息夹在中间不影响槽位读数（聚合/礼物/大航海都不参与）", () => {
  const first = msg("interact", T0);
  const second = msg("interact", T0 + 200, { local_id: 3 });
  const noise = [
    msg("gift", T0 + 100),
    msg("superchat", T0 + 120),
    msg("guard", T0 + 140),
    msg("danmaku", T0 + 160),
  ];
  const state = view([first, ...noise, second], ROOM, T0 + 300);
  assert.equal(state.latest?.local_id, 3);
  assert.equal(state.prev?.local_id, first.local_id);
  assert.equal(state.remainingMs, INTERACT_SLOT_LIFE_MS - 100);
});

test("同毫秒并列：两条 ts 相同的互动只留最新到达的那条，不造退场层（否则两行叠在一起）", () => {
  const earlier = msg("interact", T0, { local_id: 1 });
  const later = msg("interact", T0, { local_id: 2 });
  const state = view([earlier, later], ROOM, T0 + 10);
  assert.equal(state.latest?.local_id, 2, "同毫秒取最后到达的那条作 latest");
  assert.equal(state.prev, null, "同毫秒没有时序差，不该出现退场层（避免并列重叠）");
});

test("同毫秒并列不抢时序：后到者作 latest、不把先到者错当滑出的旧层", () => {
  const a = msg("interact", T0, { local_id: 10 });
  const b = msg("interact", T0, { local_id: 11 });
  // 缓冲里先到 a、后到 b；旧实现会让 a 当 latest、b 当 prev（退场层），接力方向反了。
  const state = view([a, b], ROOM, T0 + 5);
  assert.equal(state.latest?.local_id, 11);
  assert.equal(state.prev, null);
});
