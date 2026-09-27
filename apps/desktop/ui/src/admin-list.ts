// 房管名单分页的**纯逻辑**：水位 / 去重 / 在途锁 / 终点 / 作废。
//
// 为什么单独抽一层：这五条判据**都没法从界面上「看着像对」推出来** ——
// 「水位按上游口径还是按去重后的列表长度」（6.7）、「同一 uid 只留一份」（6.8）、
// 「触底风暴压成串行、已翻完不再打上游」（6.9）、「换房 / 重读把在途响应作废」（6.12）。
// 它们同时决定「还翻不翻」「列表会不会重复」「旧响应会不会混进新列表」，
// 因此在这里逐条钉住（需求 `issue202609271523-目标与需求.md` §六 6.7 / 6.8 / 6.9 / 6.10 / 6.11 / 6.12 / 6.15）。
// 单测见同目录 `admin-list.test.ts`（`node --test`，写法见 `docs/testing.md` §9）。
//
// store 只做「触发 + 落地复核（世代号）」，判据全在这里；本模块不碰 React、不碰 IPC、不碰 window。

import type { AdminListSlice } from "./types";

/** 三块名单里**有上游分页**的两块（屏蔽词上游一次给完，走前端切片，不用这套游标）。 */
export type AdminListKind = "silent" | "blacklist";

/**
 * 一条名单的分页游标 / 终点 / 在途 / 缓存状态（前端派生，**不是**契约字段）。
 *
 * `nextOffset` 是**上游口径**的「下一次要的 offset」，与去重后的 `items.length` **分开维护**
 * （6.7：两者一旦混用，同段反复取回、永远翻不完）。`done` 由上游的 `AdminListSlice.done` 收口，
 * 也由 6.13 的「下一页起点越过总数」兜底。
 */
export interface AdminListMeta {
  /** 上游口径的下一次 offset（**不是**去重后的列表长度）。 */
  nextOffset: number;
  /** 上游总数（`AdminListSlice.total`）；`0` = 空名单 / 还没取到。 */
  total: number;
  /** 已到终点：不再打上游（6.9）。 */
  done: boolean;
  /** 在途锁：同一块同时只有一个请求（6.9，触底风暴压成串行）。 */
  inFlight: boolean;
  /** 本次会话内是否成功取过（名单缓存常驻、重开面板直接复用，6.16）。 */
  loaded: boolean;
}

/** 一条名单的完整前端状态：列表 + 游标。 */
export interface AdminListState<T> {
  items: T[];
  meta: AdminListMeta;
}

/** 名单条目的唯一键（**按 uid 去重**，6.8）。 */
export type AdminKeyOf<T> = (item: T) => string | number;

/** 初始态（= 一个作废点落地后的形态，6.11）。 */
export function emptyAdminListMeta(): AdminListMeta {
  return { nextOffset: 0, total: 0, done: false, inFlight: false, loaded: false };
}

/** 两块有上游分页的名单的初始态合集。 */
export type AdminMetaRecord = Record<AdminListKind, AdminListMeta>;

export function emptyAdminMetaRecord(): AdminMetaRecord {
  return { silent: emptyAdminListMeta(), blacklist: emptyAdminListMeta() };
}

/**
 * 作废点的落地形态（6.11）：清「列表 + 分页游标 + 在途 / 终点状态」。
 * 用返回值替换 store 的那几个切片**必须整体替换**（漏一项就会留下能继续翻的游标）。
 */
export function invalidateAdminList<T>(): AdminListState<T> {
  return { items: [], meta: emptyAdminListMeta() };
}

/** 现在许不许打上游：没在途、未到终点（6.9）。 */
export function adminCanRequest(meta: AdminListMeta): boolean {
  return !meta.inFlight && !meta.done;
}

/** 进入在途态（触底 / 刷新发起前落一次）。 */
export function adminMarkInFlight(meta: AdminListMeta): AdminListMeta {
  return { ...meta, inFlight: true };
}

/** 一次请求失败后复位在途态（列表与游标**不动**：失败不该把已加载的那段吞掉）。 */
export function adminClearInFlight(meta: AdminListMeta): AdminListMeta {
  return { ...meta, inFlight: false };
}

/**
 * 把一段响应并进当前状态：按 `keyOf` **去重**后追加（6.8），游标推进到**上游口径**的
 * `slice.next_offset`（6.7），终点按 `slice.done` 收口（6.9）。
 *
 * 三条防御（都由上游的 `done` 兜底，这里只避免「原地打转」）：
 * - `next_offset >= total`（`total > 0`）= 下一页起点越过总数 → 收口（6.13 的前端镜像）。
 * - 这一段既不新增条目、`next_offset` 又没前进 → 说明没有可用的下一游标，再问一次只会死循环；
 *   强制收口为 `done`（宁可少几条也不打转；6.15 的「补齐」由下一次刷新从 0 重新对齐）。
 * - 列表**有界**：条数永远 ≤ `total`（去重 + 到点即停）—— 不设额外条数上限，否则会把还没取到的
 *   条目永久挡在门外（6.15：封顶不得让条目永久取不到）。
 */
export function mergeAdminSlice<T>(
  state: AdminListState<T>,
  slice: AdminListSlice<T>,
  keyOf: AdminKeyOf<T>,
): AdminListState<T> {
  const seen = new Set<string | number>();
  for (const item of state.items) seen.add(keyOf(item));
  const added: T[] = [];
  for (const item of slice.items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(item);
  }
  const items = added.length > 0 ? [...state.items, ...added] : state.items;
  const reachedEnd = slice.total > 0 && slice.next_offset >= slice.total;
  const progressed = slice.next_offset !== state.meta.nextOffset || added.length > 0;
  const done = slice.done || reachedEnd || !progressed;
  return {
    items,
    meta: {
      nextOffset: slice.next_offset,
      total: slice.total,
      done,
      inFlight: false,
      loaded: true,
    },
  };
}

/**
 * 重读对账：把一次重读取回的若干页（已按上游顺序）合并成「当前权威名单」。
 *
 * 与 [`mergeAdminSlice`] 的关键区别：**从空基线累加**，因此上游已删除的条目（如刚解除禁言的人）
 * 不会残留 —— 这正是「写后重读 / 静默刷新」该有的「以远端为准」（需求 6.16）。旧的
 * `mergeAdminSlice` 是「对旧 items 去重后追加」，重读时永远留着旧条目、删人删不掉，这就是
 *「房管名单重读合并」要修的点。`store.ts` 的 `fillAdminList` 在重读路径调用本函数，把整段
 * 取回的页收口成一份名单，**结束时一次性原子替换**旧列表（取数期间旧列表保持可见，不闪空）。
 */
export function reconcileAdminPages<T>(
  pages: readonly AdminListSlice<T>[],
  keyOf: AdminKeyOf<T>,
): AdminListState<T> {
  let state: AdminListState<T> = { items: [], meta: emptyAdminListMeta() };
  for (const page of pages) {
    state = mergeAdminSlice(state, page, keyOf);
  }
  return state;
}

/**
 * 名单**首屏**条数。
 *
 * 与 `store.ts` 曾经的 `ADMIN_PAGE` 同源（黑名单实测 `ps=100` 可一页返回 36 条，三块各先拿 100 条）；
 * 屏蔽词那份**前端切片**的步长也用这一枚 —— 两处共用一个常量，不再各写一份（`ui.md` §4.9 的
 * 「先拉 30 条」是旧值与代码漂移，已按这里的真值 100 修正）。
 */
export const ADMIN_PAGE = 100;

/** 名单滚到底一次补多少条（补一段 / 顺 `next_offset` 补齐到终点时的步长）。 */
export const ADMIN_STEP = 10;
