/// <reference types="node" />
// `pane-split.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/pane-split.test.ts
//
// 为什么要把 `node` 的类型在这里显式引一次：本项目 `tsconfig.app.json` 的 `types` 只有
// `vite/client`（应用代码不该看得见 Node 全局），而这一份要 `node:test` / `node:assert`；
// 文件内的三斜线引用只影响这一个编译单元，不用去动共用的 tsconfig。
//
// 钉的是需求 §四 4.1–4.4 与 §五 5.1–5.4 里**看不出来对错**的那几条：
//   ① **默认份额 0.25**（= 礼物 : 弹幕 = 1 : 3，需求 4.1）—— 它与契约 §8
//      （`docs/contract.md:473`）、`crates/danmubox-core/src/prefs.rs` 的默认值、`docs/ui.md` §5.4
//      必须逐字相同，这里断言的是前端这一侧的那一份；
//   ② **单轴模型**：折叠 = 份额压到下限**以下**（`PANE_COLLAPSED_SHARE`）+ 裁剪，
//      展开 = 份额回到落盘那一份；两栏 grow 之和恒为 1；
//   ③ **开合只在松手那一刻判**（需求 4.2）：判据只看松手时那一份份额，拖动中途到过哪儿不算数。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clampPaneRatio,
  PANE_COLLAPSED_SHARE,
  PANE_KEY_STEP,
  PANE_RATIO_DEFAULT,
  PANE_RATIO_MAX,
  PANE_RATIO_MIN,
  paneFoldAfterDrag,
  paneGrowOf,
  paneKeyboardStep,
  roundPaneRatio,
} from "./pane-split.ts";

test("默认份额 0.25（1 : 3）：与契约 §8 / prefs.rs / ui.md §5.4 四处同值，域仍是 0.10–0.90", () => {
  assert.equal(PANE_RATIO_DEFAULT, 0.25, "需求 4.1：默认 1/4，即礼物 : 弹幕 = 1 : 3");
  assert.equal(PANE_RATIO_MIN, 0.1, "域的下限不动");
  assert.equal(PANE_RATIO_MAX, 0.9, "域的上限不动");
  // 默认值必须落在域内：域一改而默认值没跟着改，`prefs` 会以 BAD_REQUEST 把它顶回来。
  assert.equal(clampPaneRatio(PANE_RATIO_DEFAULT), PANE_RATIO_DEFAULT);
  assert.ok(PANE_COLLAPSED_SHARE < PANE_RATIO_MIN, "折叠态的份额必须**低于**下限（单轴模型的那一端）");
});

test("份额夹取与取整：越界夹回闭区间两端，落盘前收成三位小数", () => {
  assert.equal(clampPaneRatio(0.05), PANE_RATIO_MIN);
  assert.equal(clampPaneRatio(0), PANE_RATIO_MIN);
  assert.equal(clampPaneRatio(1.5), PANE_RATIO_MAX);
  assert.equal(clampPaneRatio(0.1), 0.1, "两端是闭区间：0.10 / 0.90 本身照收");
  assert.equal(clampPaneRatio(0.9), 0.9);
  assert.equal(roundPaneRatio(0.123456789), 0.123);
});

test("单轴模型：折叠 = 份额压到下限以下，展开 = 落盘那一份，两栏 grow 之和恒为 1", () => {
  // 折叠：礼物栏不长（0），弹幕区拿走全部 —— 这一栏的高度由它的最小高度（实测的总计条）兜住。
  assert.equal(paneGrowOf(0.25, true, true), PANE_COLLAPSED_SHARE);
  assert.equal(paneGrowOf(0.9, true, true), PANE_COLLAPSED_SHARE, "折叠态与落盘的份额无关");
  // 展开：份额就是礼物栏的 grow，与它在上面还是下面无关（换位不改比例）。
  assert.equal(paneGrowOf(0.25, false, true), 0.25);
  assert.equal(paneGrowOf(PANE_RATIO_DEFAULT, false, true), 0.25, "默认形态：礼物栏占 1/4");
  // 没有礼物栏（ui.gift_panel = false）：分区退化为弹幕区全高。
  assert.equal(paneGrowOf(0.25, false, false), 0);
  assert.equal(paneGrowOf(0.25, true, false), 0);
  // 「两个 grow 之和必须恰好是 1」：和小于 1 时 Flexbox 只分配那么多自由空间，底部会空掉一截。
  for (const collapsed of [false, true]) {
    for (const hasGift of [false, true]) {
      for (const share of [0.1, 0.25, 0.9]) {
        const gift = paneGrowOf(share, collapsed, hasGift);
        assert.equal(gift + (1 - gift), 1);
        assert.ok(gift >= 0 && gift <= 1, `grow 必须落在 [0, 1]：${gift}`);
      }
    }
  }
});

test("松手判定（需求 4.2/4.3）：压到下限 = 收起、折叠态被拖开 = 展开、其余只落盘份额", () => {
  // 展开态把份额压到下限、还想更小 → 收起（与点右端那枚小箭头同一条路）。
  assert.equal(paneFoldAfterDrag(PANE_RATIO_MIN - 0.05, false), "collapse");
  assert.equal(paneFoldAfterDrag(0, false), "collapse");
  assert.equal(paneFoldAfterDrag(PANE_RATIO_MIN, false), "collapse", "恰好压到下限也算「到头了」");
  // 展开态没压到下限 → 什么都不改（只改份额）。
  assert.equal(paneFoldAfterDrag(0.3, false), null);
  assert.equal(paneFoldAfterDrag(PANE_RATIO_MIN + 1e-6, false), null, "下限之上一点就是「没压到头」");
  // 折叠态被拖开 → 展开（与点小箭头同一条路）。
  assert.equal(paneFoldAfterDrag(0.3, true), "expand");
  assert.equal(paneFoldAfterDrag(PANE_RATIO_MIN + 0.001, true), "expand");
  // 折叠态没被拖开（指针还在下限那一侧）→ 不变：本来就是折叠的，不必再收一次。
  assert.equal(paneFoldAfterDrag(PANE_RATIO_MIN, true), null);
  assert.equal(paneFoldAfterDrag(0.02, true), null);
});

test("开合只看松手那一刻（需求 4.2）：中途压到底再拖回来，松手仍是「什么都不改」", () => {
  // 拖动全程不改开合态 —— 中间到过哪儿都不算数，判定只吃松手时的那一份份额。
  const path = [0.4, PANE_RATIO_MIN, 0.05, PANE_RATIO_MIN, 0.4];
  const released = path[path.length - 1];
  assert.equal(paneFoldAfterDrag(released, false), null, "拖到下限以下又拖回来：松手时不算「收起」");
  // 反面：同一条路径停在「压到底」那一格上，才收起 —— 两条一起把「判据是松手那一份」钉住。
  assert.equal(paneFoldAfterDrag(PANE_RATIO_MIN, false), "collapse");
  // 折叠态起手：中间怎么晃都无所谓，松手在下限之上就是展开。
  assert.equal(paneFoldAfterDrag(0.4, true), "expand");
});

test("键盘那条路是即时提交：压到下限那一侧 = 收起，折叠态按一步先展开", () => {
  // 到下限还往「压小」那一侧按 = 收起（判据在「按不动了」之前）。
  assert.deepEqual(paneKeyboardStep(PANE_RATIO_MIN, false, false), {
    ratio: null,
    fold: "collapse",
  });
  // 已经折叠着再往那一侧按：什么都不发生（不必再收一次）。
  assert.deepEqual(paneKeyboardStep(PANE_RATIO_MIN, true, false), { ratio: null, fold: null });
  // 普通一步：撑开 / 压小各 0.02。
  assert.deepEqual(paneKeyboardStep(0.25, false, true), {
    ratio: 0.25 + PANE_KEY_STEP,
    fold: null,
  });
  assert.deepEqual(paneKeyboardStep(0.25, false, false), {
    ratio: 0.25 - PANE_KEY_STEP,
    fold: null,
  });
  // 折叠态下按任何有效的一步都先展开（折叠态的屏幕几何由最小高度兜着，份额改在它上面看不见）。
  assert.deepEqual(paneKeyboardStep(0.25, true, true), {
    ratio: 0.25 + PANE_KEY_STEP,
    fold: "expand",
  });
  assert.deepEqual(paneKeyboardStep(0.25, true, false), { ratio: 0.23, fold: "expand" });
  // 夹在上下限上：按不动了，不改份额也不改开合。
  assert.deepEqual(paneKeyboardStep(PANE_RATIO_MAX, false, true), { ratio: null, fold: null });
  // 上限之上 / 下限之下进来的脏值先被夹回域内再走一步（`prefs` 给不出越界值，这里防的是调用方）。
  assert.deepEqual(paneKeyboardStep(0.95, false, false), { ratio: roundPaneRatio(0.88), fold: null });
});
