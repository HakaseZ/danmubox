/// <reference types="node" />
// `faces.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/faces.test.ts
//
// 为什么单独测这一层：补取的**门槛**（哪些行该问）与**去重**（同一个 uid 只问一次）
// 都不会在界面上报错 —— 前者判错的表现是「大航海永远没头像」，后者判错是「一场直播
// 把上游打爆」，两者都只能在这里钉住（需求 §三 3.2 / 3.4 / 3.6）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { displayFace, missingFaceUids, senderFace } from "./faces.ts";
import type { DisplayRow } from "./filtering.ts";
import type { Message, MessageKind } from "./types.ts";

let seq = 0;

/** 造一条只带判据相关字段的消息（其余取契约 §5 的缺省）。 */
function msg(kind: MessageKind, over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    local_id: seq,
    room_id: 1,
    kind,
    ts: 1_700_000_000_000 + seq,
    uid: 1000 + seq,
    uname: `用户${seq}`,
    content: "x",
    color: 16777215,
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
    emote: null,
    upstream_id: "",
    ...over,
  };
}

function row(message: Message, over: Partial<DisplayRow> = {}): DisplayRow {
  return { message, count: 1, ...over };
}

test("缺头像的大航海 / 礼物 / SC 才补取，其余 kind 不问", () => {
  const rows = [
    row(msg("guard", { uid: 42, face: "" })),
    row(msg("gift", { uid: 43 })),
    row(msg("superchat", { uid: 44 })),
    // 有可靠来源的三类：载荷带了头像、或本来就不在补取范围内。
    row(msg("gift", { uid: 45, face: "https://i0.hdslb.com/bfs/face/a.jpg" })),
    row(msg("danmaku", { uid: 46, face: "" })),
    row(msg("interact", { uid: 47, face: "" })),
    row(msg("system", { uid: 0, face: "" })),
  ];
  assert.deepEqual(missingFaceUids(rows, {}, new Set()), [42, 43, 44]);
});

test("同一个 uid 只收一次（跨行去重、保序）", () => {
  const rows = [
    row(msg("gift", { uid: 42 })),
    row(msg("guard", { uid: 7 })),
    row(msg("gift", { uid: 42 })),
    row(msg("superchat", { uid: 7 })),
  ];
  assert.deepEqual(missingFaceUids(rows, {}, new Set()), [42, 7]);
});

test("已经问过的 uid 不再问：空串也是一条结论", () => {
  const rows = [row(msg("guard", { uid: 42 }))];
  // 空串 = 问过了、上游没给 —— 不许因此再问一次（否则每一行都重打上游）。
  assert.deepEqual(missingFaceUids(rows, { 42: "" }, new Set()), []);
  assert.deepEqual(missingFaceUids(rows, { 42: "https://x/y.jpg" }, new Set()), []);
  assert.deepEqual(missingFaceUids(rows, {}, new Set([42])), [], "在途的也不重复发");
});

test("uid 无效（0 / 负数）不问上游", () => {
  const rows = [
    row(msg("guard", { uid: 0 })),
    row(msg("superchat", { uid: -1 })),
  ];
  assert.deepEqual(missingFaceUids(rows, {}, new Set()), []);
});

test("聚合行里的赠送者一并补取，弹幕聚合行整体不问", () => {
  const senders = [
    { uid: 51, uname: "甲", face: "" },
    { uid: 52, uname: "乙", face: "https://i0.hdslb.com/bfs/face/b.jpg" },
    { uid: 53, uname: "丙", face: "" },
  ];
  // 低价礼物桶：kind 是 gift（桶头那一条），senders 是几位赠送者。
  assert.deepEqual(
    missingFaceUids([row(msg("gift", { uid: 50 }), { senders, count: 3 })], {}, new Set()),
    [50, 51, 53],
  );
  // 弹幕聚合行：kind 是 danmaku，整行不进补取（连 senders 也不看）。
  assert.deepEqual(
    missingFaceUids(
      [row(msg("danmaku", { uid: 60 }), { senders, count: 3 })],
      {},
      new Set(),
    ),
    [],
  );
});

test("行内头像取值：载荷自带的优先，否则查补取表", () => {
  const faces = { 42: "https://i0.hdslb.com/bfs/face/fetched.jpg", 7: "" };
  assert.equal(
    displayFace("https://i0.hdslb.com/bfs/face/payload.jpg", 42, faces),
    "https://i0.hdslb.com/bfs/face/payload.jpg",
  );
  assert.equal(displayFace("", 42, faces), "https://i0.hdslb.com/bfs/face/fetched.jpg");
  assert.equal(displayFace(undefined, 42, faces), "https://i0.hdslb.com/bfs/face/fetched.jpg");
  // 取了但上游没给（空串）与没取到都返回空串：`Avatar` 对空串不画任何东西。
  assert.equal(displayFace("", 7, faces), "");
  assert.equal(displayFace(undefined, 99, faces), "");
  assert.equal(senderFace({ uid: 42, uname: "甲", face: "" }, faces), faces[42]);
  assert.equal(senderFace({ uid: 7, uname: "乙", face: "https://x/y.png" }, faces), "https://x/y.png");
});
