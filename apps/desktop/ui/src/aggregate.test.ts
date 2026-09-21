/// <reference types="node" />
// `aggregate.ts` 的机制级单测。跑法（Node 的类型擦除直接吃 TS，仓库里没装 vitest）：
//
//     cd apps/desktop/ui && node --test src/aggregate.test.ts
//
// 为什么单独测这一层：刷屏折叠的几条判据**都没法从界面上「看着像对」推出来** ——
// 「够几条才折」（`AGGREGATE_MIN_COUNT`）、「是不是不止一个人在刷」（两位不同 uid）、
// 「窗口是**锚点**起的非滑动窗口」、「关掉开关就逐条显示」。它们同时决定行数、头像列画几张
// 头像、身份位印什么，因此在这里逐条钉住（`docs/ui.md` §8.4 第二张表、契约 §4）。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATE_AVATARS_SHOWN,
  AGGREGATE_MAX_COUNT,
  AGGREGATE_WINDOW_MS,
  aggregateRows,
} from "./aggregate.ts";
import type { DisplayRow } from "./filtering.ts";
import type { Message, Prefs } from "./types.ts";

/**
 * 这一族判据只读 `ui.danmaku_aggregate` 一枚键（`aggregate.ts` 是纯逻辑，不碰别的偏好），
 * 因此这里给一个只带这一枚键的替身，而不是把契约 §8 的整张键表再抄一遍
 * （那份逐键对照在 `filtering.test.ts` 的 `PREFS_BASE` 里，抄错了那里会先红）。
 */
const prefs = (aggregate = true): Prefs =>
  ({ "ui.danmaku_aggregate": aggregate }) as Prefs;

let seq = 0;

/** 造一条 `Message`：只写会参与这一族判据的字段，其余取契约 §5 的缺省。 */
function msg(content: string, over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    local_id: seq,
    room_id: 1,
    kind: "danmaku",
    ts: T0 + seq,
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

/** 一个基准时刻：把 `ts` 写成相对它，窗口的那几条判据才读得出来。 */
const T0 = 1_700_000_000_000;

/** `filtering.toDisplayRows` 的输出形状：这一层只关心 `message` 与 `count`（同一个形状在
 *  下面每一处都要，行对象本身不参与断言时就不必先摊开写）。 */
function rowsOf(messages: Message[]): DisplayRow[] {
  return messages.map((message) => ({ message, count: 1 }));
}

/** 一块「刷屏」：同一条正文、`count` 条、每位一条不同 uid（`step` 毫秒一条）。 */
function spam(count: number, options: { step?: number; face?: boolean } = {}): Message[] {
  const step = options.step ?? 100;
  return Array.from({ length: count }, (_, index) =>
    msg("刷屏样本", {
      ts: T0 + index * step,
      uid: 200 + index,
      uname: `刷屏${index}`,
      ...(options.face === false ? {} : { face: `https://face/${index}.png` }),
    }),
  );
}

test("折叠门槛是 3 条：两条同文本逐条显示，第三条一到才并成一行", () => {
  const [a, b, c] = spam(3);

  const two = rowsOf([a, b]);
  const kept = aggregateRows(two, prefs());
  assert.equal(kept.length, 2, "两条不够门槛：一行都不折");
  assert.ok(
    kept.every((item, index) => item === two[index]),
    "不折的那一串是**同一批行对象**（不是副本），逐条渲染与改前逐字相同",
  );

  const folded = aggregateRows(rowsOf([a, b, c]), prefs());
  assert.equal(folded.length, 1, "三条才折成一行");
  assert.equal(folded[0].count, 3, "count = 这一串的条数");
  assert.equal(folded[0].message, a, "代表行仍是第一条（头像列 / 正文 / React key 都不动）");
  assert.deepEqual(
    folded[0].senders?.map((sender) => sender.uid),
    [a.uid, b.uid, c.uid],
    "参与观众按首次出现顺序去重",
  );
});

test("两位不同观众才折：同一个人的三条重复逐条显示", () => {
  const uid = 777;
  const repeated = [0, 1, 2].map((index) =>
    msg("同一个人连发", { ts: T0 + index * 100, uid, uname: "一个人" }),
  );

  const kept = aggregateRows(rowsOf(repeated), prefs());
  assert.equal(kept.length, 3, "一个人连发三条不算刷屏：一条都不折");
  assert.ok(kept.every((item) => item.senders === undefined));

  // 正面对照：同一批消息里掺进第二位观众，门槛与跨观众两条同时成立 ⇒ 折。
  const twoPeople = [...repeated, msg("同一个人连发", { ts: T0 + 300, uid: 778, uname: "另一个人" })];
  const folded = aggregateRows(rowsOf(twoPeople), prefs());
  assert.equal(folded.length, 1);
  assert.equal(folded[0].count, 4, "凑齐两位观众之后，同一个人再刷也照数");
  assert.deepEqual(
    folded[0].senders?.map((sender) => sender.uid),
    [uid, 778],
    "去重后只留两位观众（这个人四条只算一位）",
  );
});

test("窗口是**锚点**起的非滑动窗口：锚点之后超过 5 秒的另起一行", () => {
  const anchor = msg("窗口样本", { ts: T0, uid: 301, uname: "窗口一号" });
  const inside = msg("窗口样本", { ts: T0 + AGGREGATE_WINDOW_MS - 100, uid: 302, uname: "窗口二号" });
  const outside = msg("窗口样本", { ts: T0 + AGGREGATE_WINDOW_MS + 100, uid: 303, uname: "窗口三号" });

  const out = aggregateRows(rowsOf([anchor, inside, outside]), prefs());
  assert.equal(
    out.length,
    3,
    "第三条离**锚点**（第一条）超过一个窗口 ⇒ 另起一串；" +
      "滑动窗口下它与第二条只差 200ms、三条会并成一行（正是这条判据要挡住的）",
  );
  assert.ok(out.every((item) => item.senders === undefined));

  // 同一批消息，只把第三条挪进锚点的窗口内：立刻折成一行（窗口的**边界**在这里）。
  const insideLast = { ...outside, ts: T0 + AGGREGATE_WINDOW_MS };
  const folded = aggregateRows(rowsOf([anchor, inside, insideLast]), prefs());
  assert.equal(folded.length, 1, "与锚点相差正好等于窗口的那一条仍算窗口内（≤ 而非 <）");
  assert.equal(folded[0].count, 3);
});

test("头像列只画前 AGGREGATE_AVATARS_SHOWN 位观众的头像（face 取自那条消息）", () => {
  const many = spam(AGGREGATE_AVATARS_SHOWN + 2);
  const folded = aggregateRows(rowsOf(many), prefs());

  assert.equal(folded.length, 1);
  assert.equal(folded[0].count, many.length, "条数说全部，头像只画前几位");
  assert.deepEqual(
    folded[0].senders?.map((sender) => sender.face),
    many.slice(0, AGGREGATE_AVATARS_SHOWN).map((message) => message.face),
    "前几位的顺序与头像都照原样（第 4 / 5 位不进这一格）",
  );

  // 上游没给头像（`Message.face` 缺席）时是**空串**：头像列按空串不画假图（`Avatar` 的口径），
  // 因此这一格必须留下「没有」这个事实，不能拿昵称或占位图顶替。
  const noFace = spam(3, { face: false });
  const bare = aggregateRows(rowsOf(noFace), prefs());
  assert.deepEqual(
    bare[0].senders?.map((sender) => sender.face),
    ["", "", ""],
  );
});

test("条数上限：一串到 AGGREGATE_MAX_COUNT 即封口，多出来的开一行新的", () => {
  const overflow = spam(AGGREGATE_MAX_COUNT + 1, { step: 0 });
  const out = aggregateRows(rowsOf(overflow), prefs());

  assert.equal(out.length, 2, "到顶封口，第 1000 条另起一行");
  assert.equal(out[0].count, AGGREGATE_MAX_COUNT);
  assert.equal(out[1].count, 1, "新的一串只有一条，不够门槛 ⇒ 逐条显示（没有 senders）");
  assert.equal(out[1].senders, undefined);
  assert.equal(out[1].message, overflow[AGGREGATE_MAX_COUNT]);
});

test("开关关掉就逐条显示：原样返回入参那一份，不复制、不重排", () => {
  const list = rowsOf(spam(4));
  const off = aggregateRows(list, prefs(false));

  assert.equal(off, list, "关掉 = 入参那一份原样交回去（纯派生，点回来就折回去）");
  assert.ok(off.every((item) => item.senders === undefined));

  const on = aggregateRows(list, prefs());
  assert.equal(on.length, 1, "同一批行、同一份消息：开关一开就折");
  assert.equal(on[0].message, list[0].message, "折出来的那一行指向原样的消息对象");
});

test("折叠不改入参：那一串消息一个字段都没动，折出来的行是新对象", () => {
  const list = rowsOf(spam(4));
  const snapshot = structuredClone(list.map((item) => item.message));

  const folded = aggregateRows(list, prefs());

  assert.deepEqual(
    list.map((item) => item.message),
    snapshot,
    "聚合只读：不改 `rows` 里的消息（改了就等于把原始内容弄脏了）",
  );
  assert.equal(list.length, 4, "入参那一份也没有被就地改写（行数照旧）");
  assert.ok(list.every((item) => item.count === 1 && item.senders === undefined));
  assert.notEqual(folded[0], list[0], "折出来的行是新对象（`count` / `senders` 只活在它上面）");
});

test("只有弹幕参与：礼物 / 互动 / 系统各行独占一行，也不把两边的弹幕串起来", () => {
  const talk = spam(3);
  // 同一批正文的礼物 / 互动 / 系统：`aggregateKey` 对非弹幕一律返回 null。
  const others = (["gift", "interact", "system"] as const).flatMap((kind, kindIndex) =>
    [0, 1, 2].map((index) =>
      msg("刷屏样本", {
        kind,
        ts: T0 + index * 100,
        uid: 900 + kindIndex * 10 + index,
        uname: `${kind}${index}`,
      }),
    ),
  );

  // 中间隔着三行非弹幕 ⇒ 前后各一串两条，两串都不够门槛 ⇒ 一条都不折。
  const out = aggregateRows(rowsOf([...talk.slice(0, 2), ...others, ...talk.slice(2)]), prefs());
  assert.equal(out.length, 2 + others.length + 1);
  assert.ok(out.every((item) => item.senders === undefined), "非弹幕不聚合，也不参与邻居的聚合");

  // 非弹幕自己再怎么重复也不折（这里只有它们自己）。
  const onlyOthers = aggregateRows(rowsOf(others), prefs());
  assert.equal(onlyOthers.length, others.length, "礼物 / 互动 / 系统一条一行（形态各不相同）");
});

test("本地乐观行与空正文不参与：本地那条自己站一行，也把两边的弹幕串隔开", () => {
  const before = spam(2);
  const optimistic = msg("刷屏样本", { local_id: -1, uid: 999, uname: "我" });
  const after = spam(2);
  const out = aggregateRows(rowsOf([...before, optimistic, ...after]), prefs());

  assert.equal(out.length, 5, "本地那条不许被折进别人的行里，也不许把前后两串连起来");
  assert.ok(out.every((item) => item.senders === undefined));

  const empty = [0, 1, 2].map((index) => msg("", { ts: T0 + index * 100, uid: 500 + index }));
  const blanks = aggregateRows(rowsOf(empty), prefs());
  assert.equal(blanks.length, 3, "空正文没有可比较的内容：一条都不折");
  assert.ok(blanks.every((item) => item.senders === undefined));
});
