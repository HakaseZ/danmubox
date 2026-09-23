/// <reference types="node" />
// `session-messages.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/session-messages.test.ts
//
// 为什么单独测这一层：`local_id` 是**会话内**序号（契约 §5），而「断开连接 → 刷新连接」会让外壳
// **重建一次会话**、号从 1 重新编号（`apps/desktop/src-tauri/src/lib.rs` 的 `refresh_room`）。
// 界面若不换列表，末尾那个号就是**上一个会话的号**，新消息会被判成「不比末尾更大」**静默丢掉**
// —— 房间看着已连接，弹幕却再也不进来（用户 2026-09-17 报的那条）。
//
// 这一族判据住在 `session-messages.ts`：`store.ts` 的值导入不带 `.ts` 后缀，`node --test`
// import 不进来（Node 的类型擦除不解析无后缀的相对说明符），所以规则必须独立成模块才测得到。
// 本文件里 `refreshReenter` / `feed` 两步按 `store.refresh` 与 `store.onMessage` 的调用顺序复刻，
// `fixNow = false` 那一档就是**修前**的行为（`refresh` 当时只调 `rooms_reconnect`，列表原样留着）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adoptSessionSnapshot,
  appended,
  dropSessionMessages,
  insertIncoming,
  KIND_CAPS,
  refreshMode,
} from "./session-messages.ts";
import type { Message, MessageKind, RoomView } from "./types.ts";

let seq = 0;

/** 造一条 `Message`：显式给 `local_id`（这一族判据全在它上面），其余取契约 §5 的缺省。 */
function row(local_id: number, content: string, over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    local_id,
    room_id: 7,
    kind: "danmaku",
    ts: 1_700_000_000_000 + seq,
    uid: 10_000 + seq,
    uname: `观众${seq}`,
    content,
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

/** `rooms_list` 里的一条（`connected` = 外壳里还有没有这个房间的运行时，契约 §5 `RoomView`）。 */
function roomView(room_id: number, connected: boolean): RoomView {
  return {
    room_id,
    short_id: room_id,
    anchor_uid: 20_000 + room_id,
    anchor_uname: `主播${room_id}`,
    title: `房间 ${room_id}`,
    live_status: 1,
    connected,
    buffered: 0,
  };
}

/** `store.refresh` 的第一步：建连**之前**清上一个会话的行（修前 = 这一步不存在）。 */
function refreshReenter(messages: Message[], rooms: RoomView[], roomId: number): Message[] {
  return refreshMode(rooms, roomId) === "reenter" ? dropSessionMessages(messages) : messages;
}

/** `store.onMessage` 的落地那一半：一批实时消息按到达顺序入列。 */
function feed(messages: Message[], incoming: Message[]): Message[] {
  return incoming.reduce<Message[]>((acc, message) => insertIncoming(acc, message) ?? acc, messages);
}

test("按 kind 分档裁剪：礼物没到礼物档上限就不会被弹幕挤掉", () => {
  // 用户 2026-09-22 第 5 条：改前是一个不分类型的总数上限（`CLIENT_MESSAGE_CAP`），
  // 弹幕一多就把礼物顶掉 —— 看着像「分类型缓存没生效」。现在各 `kind` 只受自己的上限约束。
  const cap = KIND_CAPS.danmaku;
  let list: Message[] = [];
  for (let i = 1; i <= cap; i += 1) {
    list = appended(list, row(i, `弹幕${i}`));
  }
  assert.equal(list.length, cap, "前置：弹幕档正好填满");

  // 一条礼物进的是**礼物档**，弹幕一条都不该被挤掉。
  list = appended(list, row(cap + 1, "投喂 铅笔", { kind: "gift" as MessageKind, amount: 100 }));
  assert.equal(
    list.filter((item) => item.kind === "danmaku").length,
    cap,
    "弹幕档一条不少",
  );
  assert.equal(list.filter((item) => item.kind === "gift").length, 1, "礼物没被弹幕挤掉");

  // 弹幕超档时只丢**弹幕里最旧**的那条，礼物照旧在（这就是「互不挤占」）。
  const after = appended(list, row(cap + 2, "弹幕超了"));
  assert.equal(
    after.filter((item) => item.kind === "danmaku").length,
    cap,
    "弹幕档仍是上限条数",
  );
  assert.ok(!after.some((item) => item.content === "弹幕1"), "丢的是弹幕里最旧的一条");
  assert.equal(after.filter((item) => item.kind === "gift").length, 1, "礼物一条不动");
});

test("断连之后再点「刷新」：新会话的弹幕照旧上屏（修前这一按一条都进不来）", () => {
  // 上一个会话：界面上已经收了 3 条，号是 1..3。
  const oldSession = [row(1, "上一条-a"), row(2, "上一条-b"), row(3, "上一条-c")];
  // 「断开连接」+「刷新」之后，外壳重建的品牌新会话从 1 重新编号（进场回填也是这批号）。
  const newSession = [row(1, "新的-a"), row(2, "新的-b"), row(3, "新的-c")];
  const rooms = [roomView(7, false)];

  // 修前：只调 `rooms_reconnect`，列表原样留着 → 新消息全被判成「不比末尾更大」。
  assert.deepEqual(
    feed(oldSession, newSession).map((message) => message.content),
    ["上一条-a", "上一条-b", "上一条-c"],
    "缺陷现场：新会话的号不大于末尾，三条全丢（房间看着已连接，弹幕再也不进来）",
  );

  // 修后：建连前摘掉上一个会话的行 → 建连 → 新会话快照整批落地 → 实时继续。
  let list = refreshReenter(oldSession, rooms, 7);
  assert.deepEqual(list, [], "先摘掉上一个会话的行（此刻房间还没有会话，清不掉任何刚到的事件）");
  list = feed(list, newSession.slice(0, 2));
  list = adoptSessionSnapshot([newSession[0], newSession[1]], list);
  list = feed(list, newSession.slice(2));
  assert.deepEqual(
    list.map((message) => message.content),
    ["新的-a", "新的-b", "新的-c"],
    "新会话的消息照旧上屏",
  );
  assert.deepEqual(list.map((message) => message.local_id), [1, 2, 3]);
});

test("换会话之后同一条只画一行：回填与实时两条路带来的同一份不再入列", () => {
  const rooms = [roomView(7, false)];
  const session = [row(1, "同一条"), row(2, "后一条")];
  let list = refreshReenter([row(9, "上一个会话的")], rooms, 7);
  // 进场回填先到两条，快照又把同一批给了一遍（上游两条路都会带它）。
  list = adoptSessionSnapshot(session, feed(list, session));
  assert.deepEqual(list.map((message) => message.content), ["同一条", "后一条"], "同一批只画一行");

  assert.equal(insertIncoming(list, session[1]), null, "同一条的第二份不进列表（`alreadyListed`）");
  assert.equal(
    insertIncoming(list, row(2, "上一个会话的")),
    null,
    "上一个会话的号不许再进列表：同一个号进两次 React 会报重复 key",
  );
});

test("会话还在时「刷新」不动列表：已渲染的消息留着，后续消息照旧追加", () => {
  const rooms = [roomView(7, true)];
  const onScreen = [row(1, "已经在上面的")];
  assert.equal(
    refreshReenter(onScreen, rooms, 7),
    onScreen,
    "原地重连：同一份列表（同一个引用），界面上的弹幕不重建、不清空",
  );
  assert.deepEqual(
    feed(onScreen, [row(2, "接着来的")]).map((message) => message.content),
    ["已经在上面的", "接着来的"],
  );
});

test("「刷新」的档位只看列表载荷的 connected：列表里没有这个房间时不换列表", () => {
  assert.equal(refreshMode([roomView(7, true)], 7), "reconnect", "会话还在 → 原地重连");
  assert.equal(refreshMode([roomView(7, false)], 7), "reenter", "会话已结束 → 等价重新进房");
  assert.equal(refreshMode([roomView(8, false)], 7), "reconnect", "拿不准时不动手，不误清列表");
});

test("刷新换会话时，本地待确认行跟着活下来并仍排在末尾", () => {
  const pending = row(-1, "我刚发的");
  const oldSession = [row(1, "别人的"), pending];
  const list = adoptSessionSnapshot(
    [row(1, "新的")],
    refreshReenter(oldSession, [roomView(7, false)], 7),
  );
  assert.deepEqual(
    list.map((message) => message.local_id),
    [1, -1],
    "新会话的快照在前、待确认行仍在末尾（回播还能按负数号对上它）",
  );
});

test("快照没覆盖到的那几条（号更大）不会被快照抹掉", () => {
  const snapshot = [row(1, "快照里的一")];
  const onScreen = [row(1, "快照里的一"), row(2, "快照之后到的"), row(-3, "我刚发的")];
  assert.deepEqual(
    adoptSessionSnapshot(snapshot, onScreen).map((message) => message.local_id),
    [1, 2, -3],
    "快照之后才到的、已经上屏的那几条留着：同一个号不会再发第二遍，丢掉就是静默少一条",
  );
});
