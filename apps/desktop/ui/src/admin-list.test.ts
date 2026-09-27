/// <reference types="node" />
// `admin-list.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/admin-list.test.ts
//
// 为什么单独测这一层：房管名单分页的五条判据**都没法从界面上「看着像对」推出来** ——
// 「水位按上游口径还是按去重后的列表长度」（6.7）、「同一 uid 只留一份」（6.8）、
// 「触底风暴压成串行、已翻完不再打上游」（6.9）、「换房 / 重读把在途响应作废」（6.12）。
// 它们同时决定「还翻不翻」「列表会不会重复」「旧响应会不会混进新列表」，
// 因此在这里逐条钉住（`docs/ui.md` §4.9、`issue202609271523-目标与需求.md` §六）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADMIN_PAGE,
  ADMIN_STEP,
  adminCanRequest,
  adminClearInFlight,
  adminMarkInFlight,
  emptyAdminListMeta,
  emptyAdminMetaRecord,
  invalidateAdminList,
  mergeAdminSlice,
  type AdminListState,
} from "./admin-list.ts";
import type { AdminListSlice, AdminUser } from "./types.ts";

/** 造一个名单条目（uid 就是唯一键，`AdminUser` 的其余字段与这一族判据无关）。 */
const user = (uid: number): AdminUser => ({ uid, uname: `u${uid}`, face: "" });

/** 与 store 一样的去重键。 */
const keyOf = (item: AdminUser) => item.uid;

/** 造一段响应：`items` 条数、`total` 总数、`next_offset` 上游口径的下一游标、`done` 终点标记。 */
function slice(
  items: AdminUser[],
  total: number,
  next_offset: number,
  done: boolean,
): AdminListSlice<AdminUser> {
  return { items, total, next_offset, done };
}

const state = (items: AdminUser[]): AdminListState<AdminUser> => ({
  items,
  meta: emptyAdminListMeta(),
});

test("水位按上游口径推进：混了重复条目的那一段也不影响 next_offset（6.7）", () => {
  // 手上已有 1、2、3；上游说「下一次从 4 开始，共 10 条」，但这一段里混了重复的 2 / 3。
  const before: AdminListState<AdminUser> = { items: [user(1), user(2), user(3)], meta: emptyAdminListMeta() };
  const after = mergeAdminSlice(before, slice([user(2), user(3), user(4)], 10, 4, false), keyOf);
  assert.equal(after.meta.nextOffset, 4);
  assert.equal(after.meta.total, 10);
  assert.equal(after.meta.done, false);
});

test("水位与列表长度分离：上游说 7，去重后列表只有 3（6.7）", () => {
  const before: AdminListState<AdminUser> = { items: [user(1), user(2)], meta: emptyAdminListMeta() };
  // 上游 offset=7 处返回 8、9；重复的 1 被去掉 → 列表 3 条，但下一游标必须是 9 而不是 3。
  const after = mergeAdminSlice(before, slice([user(1), user(8), user(9)], 20, 9, false), keyOf);
  assert.equal(after.items.map((u) => u.uid).join(","), "1,2,8,9");
  assert.equal(after.meta.nextOffset, 9);
});

test("按 uid 去重：同一段里重复的 uid 只留一份，列表有界（6.8）", () => {
  const before = state([user(1)]);
  const after = mergeAdminSlice(before, slice([user(2), user(2), user(1), user(3)], 3, 3, true), keyOf);
  assert.deepEqual(after.items.map((u) => u.uid), [1, 2, 3]);
  assert.ok(after.items.length <= after.meta.total);
  // 引用不变（没有新增）时不重建数组，订阅者不会白重渲染。
  const again = mergeAdminSlice(after, slice([user(1), user(2), user(3)], 3, 3, true), keyOf);
  assert.equal(again.items, after.items);
});

test("在途锁：请求在途 / 已到终点时都不许再打上游（6.9）", () => {
  const idle = emptyAdminListMeta();
  assert.equal(adminCanRequest(idle), true);
  const inFlight = adminMarkInFlight(idle);
  assert.equal(inFlight.inFlight, true);
  assert.equal(adminCanRequest(inFlight), false);
  assert.equal(adminCanRequest(adminClearInFlight(inFlight)), true);
  assert.equal(adminCanRequest({ ...idle, done: true }), false);
  // 合并一段 = 请求落地 → 在途自动复位。
  const merged = mergeAdminSlice({ items: [], meta: inFlight }, slice([user(1)], 1, 1, true), keyOf);
  assert.equal(merged.meta.inFlight, false);
  assert.equal(merged.meta.loaded, true);
});

test("终点判定：上游 done / 下一游标越过总数 / 原地打转 三种收口（6.9 / 6.13）", () => {
  // ① 上游明确 done。
  const a = mergeAdminSlice(state([]), slice([user(1)], 1, 1, true), keyOf);
  assert.equal(a.meta.done, true);
  // ② 上游没说 done，但 next_offset 已越过 total → 收口，不再翻。
  const b = mergeAdminSlice({ items: [user(1)], meta: { ...emptyAdminListMeta(), nextOffset: 1 } }, slice([user(2)], 2, 2, false), keyOf);
  assert.equal(b.meta.done, true);
  // ③ 既不新增、游标又没前进、done 还是假 → 强制收口，绝不死循环（6.15 的补齐交给下一次刷新）。
  const c = mergeAdminSlice(
    { items: [user(1)], meta: { ...emptyAdminListMeta(), nextOffset: 5, loaded: true } },
    slice([user(1)], 9, 5, false),
    keyOf,
  );
  assert.equal(c.meta.done, true);
  // 对照：游标前进了就继续翻（哪怕这一段一条没新增）。
  const d = mergeAdminSlice(
    { items: [user(1)], meta: { ...emptyAdminListMeta(), nextOffset: 5, loaded: true } },
    slice([], 9, 6, false),
    keyOf,
  );
  assert.equal(d.meta.done, false);
  assert.equal(d.meta.nextOffset, 6);
});

test("作废点：列表与游标（含在途 / 终点 / 已加载标记）整体清回初始态（6.11）", () => {
  const dirty: AdminListState<AdminUser> = {
    items: [user(1), user(2)],
    meta: { nextOffset: 7, total: 20, done: false, inFlight: true, loaded: true },
  };
  const wiped = invalidateAdminList<AdminUser>();
  assert.deepEqual(wiped.items, []);
  assert.deepEqual(wiped.meta, emptyAdminListMeta());
  // 清完之后还能重新开始翻（不是「被焊死在 done」）。
  assert.equal(adminCanRequest(wiped.meta), true);
  assert.notEqual(dirty.meta.loaded, wiped.meta.loaded);
});

test("两块名单的初始态各自独立（作废点不会互相串）", () => {
  const record = emptyAdminMetaRecord();
  assert.notEqual(record.silent, record.blacklist);
  assert.deepEqual(record.silent, emptyAdminListMeta());
  assert.deepEqual(record.blacklist, emptyAdminListMeta());
});

test("首屏与步长常量是面板与 store 的共同来源（漂移修正）", () => {
  assert.equal(ADMIN_PAGE, 100);
  assert.equal(ADMIN_STEP, 10);
});
