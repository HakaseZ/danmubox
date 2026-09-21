/// <reference types="node" />
// `filtering.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/filtering.test.ts
//
// 为什么要把 `node` 的类型在这里显式引一次：本项目 `tsconfig.app.json` 的 `types` 只有
// `vite/client`（应用代码不该看得见 Node 全局），而这一份要 `node:test` / `node:assert`；
// 文件内的三斜线引用只影响这一个编译单元，不用去动共用的 tsconfig。
//
// 钉的是 issue 2609171849 第 5 条的两条口径，两条都不可从界面上「看着像对」推出：
//   ① **两枚低价礼物开关对两个区域都生效**：弹幕区（`chatRows`）与礼物栏（`giftRows`）
//      各折一次、各按同一枚 `isCheapGift` 判；剔除只改统计（本应用里统计只有礼物栏折叠头
//      那一处，弹幕区没有统计面）。
//   ② **剔除 / 折叠 / 隐藏 / 自动消失都只是显示层的派生**：原始消息一条不少（入参数组与
//      数组里的 `message` 都不被改写），每个开关关掉之后逐条回到**原样**
//      （顺序、数量、金额都是原值）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collapseCheapGiftRows,
  giftStatRows,
  interactAutoHidden,
  splitGiftRows,
  toDisplayRows,
} from "./filtering.ts";
import { INTERACT_AUTO_HIDE_MS, type Message, type Prefs } from "./types.ts";

/** 契约 §8 的默认值（键集合与默认值照抄，缺一项都编译不过 —— 这是有意的）。 */
const PREFS_BASE: Prefs = {
  "ui.font_scale": 1,
  "ui.theme": "system",
  "ui.auto_scroll": true,
  "ui.pause_on_hover": false,
  "ui.gift_in_danmaku": true,
  "ui.gift_panel": true,
  "ui.gift_pane_on_top": false,
  "ui.gift_pane_ratio": 0.35,
  "ui.gift_collapse_cheap": false,
  "ui.gift_exclude_cheap_stats": false,
  "ui.interact_auto_hide": true,
  "ui.show_timestamp": false,
  "ui.danmaku_aggregate": true,
  "composer.phrases": [],
  "filter.uids": [],
  "filter.kinds": [],
  "filter.medal_level_min": 0,
  "history.buffer_rows_danmaku": 5000,
  "history.buffer_rows_gift": 2000,
  "history.buffer_rows_superchat": 500,
  "history.buffer_rows_guard": 200,
  "history.buffer_rows_interact": 300,
  "history.buffer_rows_system": 200,
  "ui.recent_watched": {},
};

function prefs(over: Partial<Prefs> = {}): Prefs {
  return { ...PREFS_BASE, ...over };
}

let seq = 0;

/** 造一条 `Message`：只写会参与这一族判据的字段，其余取契约 §5 的缺省。 */
function msg(kind: Message["kind"], content: string, over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    local_id: seq,
    room_id: 1,
    kind,
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

/** 90 / 100 金瓜子 = 0.09 / 0.10 元（算低价）；110 = 0.11 元、0 = 上游没给价（都不算）。 */
const CHEAP_A = { amount: 90 };
const CHEAP_B = { amount: 100 };
const NOT_CHEAP = { amount: 110 };
const NO_PRICE = { amount: 0 };

function conversation(): Message[] {
  return [
    msg("danmaku", "第一条"),
    msg("gift", "投喂 铅笔", CHEAP_A),
    msg("gift", "投喂 橡皮", NOT_CHEAP),
    msg("gift", "投喂 铅笔屑", CHEAP_B),
    msg("danmaku", "第二条"),
  ];
}

test("折叠低价礼物对两个区域都生效：弹幕区与礼物栏各折一次", () => {
  const rows = toDisplayRows(conversation(), prefs());

  const before = splitGiftRows(rows, prefs());
  assert.deepEqual(
    before.chatRows.map((row) => row.message.content),
    ["第一条", "投喂 铅笔", "投喂 橡皮", "投喂 铅笔屑", "第二条"],
    "默认关：两个区域都是一条一行",
  );
  assert.equal(before.giftRows.length, 3, "默认关：礼物栏三条礼物各占一行");
  assert.ok(before.chatRows.every((row) => !row.cheap) && before.giftRows.every((row) => !row.cheap));

  const on = prefs({ "ui.gift_collapse_cheap": true });
  const after = splitGiftRows(rows, on);

  assert.deepEqual(
    after.chatRows.map((row) => row.message.content),
    ["第一条", "投喂 铅笔", "投喂 橡皮", "第二条"],
    "弹幕区也折：第二条低价礼物（投喂 铅笔屑）不再单独成行",
  );
  assert.deepEqual(
    after.giftRows.map((row) => row.message.content),
    ["投喂 铅笔", "投喂 橡皮"],
    "礼物栏照旧折",
  );

  const chatBucket = after.chatRows.find((row) => row.cheap);
  const giftBucket = after.giftRows.find((row) => row.cheap);
  assert.ok(chatBucket && giftBucket, "两个区域各有一条桶行（cheap 标记）");
  // 桶取桶里**第一条**的身份与位置，数量与金额是整桶合计（docs/ui.md §5.3）。
  assert.equal(chatBucket.message.content, "投喂 铅笔");
  assert.equal(chatBucket.message.uname, rows[1].message.uname);
  assert.equal(chatBucket.count, 2);
  assert.equal(chatBucket.message.amount, 190);
  assert.equal(giftBucket.count, 2);
  assert.equal(giftBucket.message.amount, 190);
  // 0.11 元那条与两枚开关无关，两处都照旧单独一行。
  assert.equal(after.chatRows.filter((row) => row.message.content === "投喂 橡皮").length, 1);
  assert.equal(after.giftRows.filter((row) => row.message.content === "投喂 橡皮").length, 1);
});

test("折叠是纯派生：不改入参，关掉开关逐条按原序、原对象回来", () => {
  const rows = toDisplayRows(conversation(), prefs());
  const snapshot = structuredClone(rows.map((row) => row.message));

  const collapsed = splitGiftRows(rows, prefs({ "ui.gift_collapse_cheap": true }));
  assert.equal(collapsed.chatRows.length, 4, "折完少了那一行（前置：这次折叠真的生效）");

  // 显示层只读：桶行是 `{...head.message}` 的新对象，原来那些 `message` 一个字段都没被动过。
  assert.deepEqual(
    rows.map((row) => row.message),
    snapshot,
    "折叠不许改写 `rows` 里的消息（写进去就等于把原始内容弄脏了）",
  );

  const restored = splitGiftRows(rows, prefs());
  assert.deepEqual(
    restored.chatRows.map((row) => row.message.content),
    ["第一条", "投喂 铅笔", "投喂 橡皮", "投喂 铅笔屑", "第二条"],
    "关掉开关：弹幕区逐条回来，顺序照旧",
  );
  assert.deepEqual(
    restored.giftRows.map((row) => row.message.content),
    ["投喂 铅笔", "投喂 橡皮", "投喂 铅笔屑"],
    "关掉开关：礼物栏逐条回来，顺序照旧",
  );
  // 「恢复原样」的强口径：回来的就是当初那几个行对象（数量与金额自然也是原值）。
  assert.ok(restored.chatRows.every((row, index) => row === rows[index]));
  assert.deepEqual(
    restored.giftRows,
    [rows[1], rows[2], rows[3]],
    "礼物栏恢复出来的是同一批行对象",
  );
  for (const row of restored.giftRows) {
    assert.equal(row.count, 1);
  }
  assert.ok(restored.chatRows.every((row) => row.count === 1 && !row.cheap));
});

test("剔除只改统计：两个区域的行都不动，关掉开关统计逐条回来", () => {
  const rows = toDisplayRows(conversation(), prefs({ "ui.gift_collapse_cheap": true }));
  const on = prefs({ "ui.gift_collapse_cheap": true, "ui.gift_exclude_cheap_stats": true });
  const off = prefs({ "ui.gift_collapse_cheap": true });

  const withExclude = splitGiftRows(rows, on);
  const withoutExclude = splitGiftRows(rows, off);

  // 统计集（礼物栏折叠头那一份的来源）：开时把低价礼物整条剔掉，含折出来的那条桶行。
  assert.deepEqual(
    giftStatRows(withExclude.giftRows, on).map((row) => row.message.content),
    ["投喂 橡皮"],
    "剔除开：统计里只剩 0.11 元那条",
  );
  assert.equal(giftStatRows(withoutExclude.giftRows, off), withoutExclude.giftRows,
    "剔除关：统计集就是原样那一份（同一个数组）");

  // 这枚键**只**改统计：两个区域的行集合与它无关 —— 开着它与关着它派生出来的行逐字相同。
  assert.deepEqual(withExclude.chatRows, withoutExclude.chatRows, "弹幕区：行一条不多、一条不少");
  assert.deepEqual(withExclude.giftRows, withoutExclude.giftRows, "礼物栏：条目一条不多、一条不少");
  assert.deepEqual(
    withExclude.chatRows.map((row) => row.message.content),
    ["第一条", "投喂 铅笔", "投喂 橡皮", "第二条"],
    "弹幕区仍然是「折了桶」的那一套行",
  );
  // 「不改展示」的强口径：非桶行就是同一批对象；桶行逐字段相同（桶行每次派生都是新对象，
  // 身份本来就不稳定 —— 稳定的那条是 `local_id`，React key 取它，见 collapseCheapGiftRows）。
  const withBucket = withExclude.giftRows.filter((row) => row.cheap);
  const withoutBucket = withoutExclude.giftRows.filter((row) => row.cheap);
  assert.equal(withBucket.length, 1);
  assert.deepEqual(withBucket[0], withoutBucket[0]);
  assert.ok(
    withExclude.giftRows
      .filter((row) => !row.cheap)
      .every((row) => withoutExclude.giftRows.includes(row)),
  );
});

test("边界：0.09 / 0.10 算低价、0.11 与 0（上游没给价）不算，两处同一口径", () => {
  const rows = toDisplayRows(
    [
      msg("gift", "投喂 铅笔", CHEAP_A),
      msg("gift", "投喂 铅笔屑", CHEAP_B),
      msg("gift", "投喂 橡皮", NOT_CHEAP),
      msg("gift", "投喂 尺子", NO_PRICE),
      msg("superchat", "30 元的 SC", { amount: 30 }),
      msg("guard", "开通 舰长", { amount: 138_000, guard_level: 3 }),
    ],
    prefs(),
  );
  const split = splitGiftRows(rows, prefs({ "ui.gift_collapse_cheap": true }));

  for (const [area, areaRows] of [
    ["弹幕区", split.chatRows],
    ["礼物栏", split.giftRows],
  ] as const) {
    assert.deepEqual(
      areaRows.map((row) => row.message.content),
      ["投喂 铅笔", "投喂 橡皮", "投喂 尺子", "30 元的 SC", "开通 舰长"],
      `${area}：只有两条真低价进了桶，0.11 / 没给价 / SC / 大航海都不进`,
    );
    const bucket = areaRows.find((row) => row.cheap);
    assert.equal(bucket?.count, 2);
    assert.equal(bucket?.message.amount, 190, `${area}：桶的金额是整桶合计`);
  }
});

test("自动消失是显示层的：到点不画，但消息一直在，关掉开关同一帧回来", () => {
  const ts = 1_700_000_000_000;
  const talk = msg("danmaku", "普通弹幕");
  const enter = msg("interact", "观众进场", { ts });
  const messages = [talk, enter, msg("danmaku", "后面这条")];
  const snapshot = structuredClone(messages);

  const on = prefs({ "ui.interact_auto_hide": true });
  const off = prefs({ "ui.interact_auto_hide": false });

  assert.equal(interactAutoHidden(enter, on, ts + INTERACT_AUTO_HIDE_MS - 1), false);
  assert.equal(interactAutoHidden(enter, on, ts + INTERACT_AUTO_HIDE_MS), true);
  assert.equal(interactAutoHidden(enter, off, ts + 24 * 3600 * 1000), false);
  assert.equal(interactAutoHidden(talk, on, ts + 24 * 3600 * 1000), false, "只对互动行生效");

  const justBefore = toDisplayRows(messages, on, ts + INTERACT_AUTO_HIDE_MS - 1);
  assert.deepEqual(
    justBefore.map((row) => row.message.content),
    ["普通弹幕", "观众进场", "后面这条"],
    "到点之前照画",
  );

  const expired = toDisplayRows(messages, on, ts + INTERACT_AUTO_HIDE_MS);
  assert.deepEqual(
    expired.map((row) => row.message.content),
    ["普通弹幕", "后面这条"],
    "到点之后不再画那一条（空间随之回收）",
  );

  // 「不丢内容」：入参一条没少、一个字没改；关掉开关，那一行**在原位**回来。
  assert.deepEqual(messages, snapshot, "自动消失不许动 `messages`");
  const restored = toDisplayRows(messages, off, ts + INTERACT_AUTO_HIDE_MS);
  assert.deepEqual(
    restored.map((row) => row.message.content),
    ["普通弹幕", "观众进场", "后面这条"],
    "关掉开关：消失过的那条原序回来",
  );
  assert.equal(restored[1].message, enter, "回来的就是原来那条消息对象");
});

test("折叠与剔除都不动 `messages`：桶行的合计只活在派生出来的那一行上", () => {
  const messages = conversation();
  const snapshot = structuredClone(messages);
  const prefsOn = prefs({ "ui.gift_collapse_cheap": true, "ui.gift_exclude_cheap_stats": true });

  const rows = toDisplayRows(messages, prefsOn);
  const split = splitGiftRows(rows, prefsOn);
  collapseCheapGiftRows(split.giftRows);
  giftStatRows(split.giftRows, prefsOn);

  assert.deepEqual(messages, snapshot, "三条礼物各自的 amount / 顺序都还是原值");
  assert.deepEqual(
    messages.filter((message) => message.kind === "gift").map((message) => message.amount),
    [90, 110, 100],
    "原始消息里没有「190」这种合计数——合计只存在于派生行",
  );
});
