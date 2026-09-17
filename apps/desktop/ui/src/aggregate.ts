// 弹幕聚合的纯逻辑（issue 2609171849 第 7 条）：**不同观众**在短时间窗口里发的**同一条**弹幕
// 合成一行。独立成模块的理由：它是纯函数（不碰 React、不碰 store），能脱离界面单独验证；
// 参数是规范性常量，只能从 `docs/contract.md` §4 原样引用。
//
// 与 `filtering.ts` 的**礼物连击折叠**是两条互不相干的规则（`docs/ui.md` §8.4）：
// 那条折的是**同一个动作**的重复（同一次连击、同一个 `combo_id`），
// 这条折的是**不同的人**说了同一句话。别把两者并到一处。

import type { DisplayRow, SenderRef } from "./filtering";
import type { Message } from "./types";

/**
 * 聚合窗口（毫秒）：一条聚合行只收**锚点之后**这个窗口内的消息（契约 §4）。
 *
 * 取 5 秒的依据：契约 §4 的「相同内容 5 秒内去重」是同一个尺度上的节流窗口，
 * 单个人在那里已经被压成 5 秒一条 —— 窗口取同一档，聚合里出现的多条就只可能来自
 * **不同的观众**，正是这条需求要的形态（「不同的观众短时间内刷同一个弹幕」）。
 *
 * **非滑动**：锚点 = 这一行的第一条，不随后续加入顺延。滑动窗口下，一个人流量不断时
 * 这条行会一直长下去、永远闭不了口；非滑动则窗口一到就另起一行，行的寿命有确定上界。
 */
export const AGGREGATE_WINDOW_MS = 5000;

/**
 * 一条聚合行最多折叠的条数。到顶即封口，由下一条开一行新的（契约 §4）。
 *
 * 窗口已经限住了「多久」，这一条是**上界兜底**：窗口内刷了几千条时，
 * 一行的 `count` 仍有确定上限 —— 渲染开销与数字长度都可预期，也不必给 `×N` 另设显示上限。
 */
export const AGGREGATE_MAX_COUNT = 999;

/**
 * 聚合行上**列出**几位观众的名字，其余只报总数（契约 §4）。
 *
 * 3 位是「一眼看得出是不同的人」的最小值；再多会把正文这一行挤到折行
 * （`docs/ui.md` §8.4 的单行长度口径）。总数永远照实说（`等 N 人`）。
 */
export const AGGREGATE_SENDERS_SHOWN = 3;

/** 上游可以不给人名；名单里那一条按这个写，不渲染空的一段名字。 */
const ANONYMOUS_SENDER = "匿名观众";

/**
 * 这条消息落在哪个**聚合键**上；`null` = 不参与聚合、自己独占一行。
 *
 * - 只有 `danmaku`：礼物 / SC / 大航海 / 互动 / 系统各有自己的展示形态，合了会吃掉信息；
 * - **本地乐观行**（`local_id < 0`）不参与：刚发出的那条必须自己站一行，
 *   否则「我这条到底发出去没有」会被折进别人的行里（`docs/ui.md` §4.4）；
 * - **表情弹幕**按 `emoticon_unique` 取键：图不同即不同条，哪怕正文 token 恰好一样；
 * - 其余按**归一化正文**；**空正文不聚合**（没有可比较的内容）。
 *
 * 归一化 = 去首尾空白 + 连续空白并成一个空格 + 大小写不敏感（契约 §4 的聚合归一化规则）：
 * 落在同一个键上就是界面上看起来**同一条**弹幕。`\s` 已含全角空格 U+3000，
 * 因此「哈哈哈」与「哈哈哈␣」这类差异被吃掉。
 */
export function aggregateKey(message: Message): string | null {
  if (message.kind !== "danmaku") return null;
  if (message.local_id < 0) return null;
  const unique = message.emote?.emoticon_unique ?? "";
  if (unique.length > 0) return `emote:${unique}`;
  const text = message.content.replace(/\s+/gu, " ").trim().toLowerCase();
  return text.length > 0 ? `text:${text}` : null;
}

/**
 * 弹幕聚合：把相邻、同键、同窗口内的弹幕折成一行（`docs/ui.md` §8.4 的第二张表）。
 *
 * 规则（全部满足才折）：上一行存在 → 键相同 → **与锚点**的时间差 ≤ `AGGREGATE_WINDOW_MS`
 * → 条数 < `AGGREGATE_MAX_COUNT` → 参与观众**还没到两位**时必须是**新的人**。
 * 最后一条是这条需求的本体：只有**不同的观众**刷同一条才聚合，同一个人的重复不算。
 *
 * 折进来的那些**不改这一行的身份**：`message` 仍是第一条（头像 / 昵称 / 时间戳 / React key
 * 都不动，行因此不跳位、节点不重建），只加 `count` 与 `senders`。
 *
 * 输入是 `filtering.toDisplayRows` 的输出（已过滤 + 已做礼物连击折叠）；不改动入参。
 */
export function aggregateRows(rows: DisplayRow[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  // 与 `out` 一一对应的账：每一行的聚合键与**锚点时刻**（这一行第一条的 `ts`）。
  // 非聚合行也记 —— 相邻判据靠它，且键不同的行天然把链断开。
  const keys: (string | null)[] = [];
  const anchors: number[] = [];

  for (const row of rows) {
    // 低价礼物桶（`ui.gift_collapse_cheap`）**不参与**：它是另一条合并规则的产品
    // （T5 的口径：桶行 `cheap === true`、`count`/`amount` 已是整桶合计），别把它再并一次。
    // 桶本来只装 `gift`、`aggregateKey` 对非弹幕已经返回 null —— 这一句是显式的边界，
    // 免得以后桶装得下别的 kind 时悄悄串味。
    const key = row.cheap ? null : aggregateKey(row.message);
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    const lastKey = keys.length > 0 ? keys[keys.length - 1] : null;
    const lastAnchor = anchors.length > 0 ? anchors[anchors.length - 1] : 0;

    if (last !== undefined && key !== null && lastKey === key) {
      // 已有的参与者：这一行还没折过别人时，参与的就是它自己那一条。
      const participants: SenderRef[] = last.senders
        ? last.senders.slice()
        : [{ uid: last.message.uid, uname: last.message.uname }];
      const known = participants.some((s) => s.uid === row.message.uid);
      const joinable =
        Math.abs(row.message.ts - lastAnchor) <= AGGREGATE_WINDOW_MS &&
        last.count < AGGREGATE_MAX_COUNT &&
        // 跨观众：凑齐两位之前只挡同一个人的重复；凑齐之后同一个人再刷也算进条数。
        (!known || participants.length >= 2);
      if (joinable) {
        last.count += 1;
        if (!known) {
          participants.push({ uid: row.message.uid, uname: row.message.uname });
          last.senders = participants;
        }
        continue;
      }
    }

    out.push({ ...row });
    keys.push(key);
    anchors.push(row.message.ts);
  }
  return out;
}

/**
 * 聚合行上「都是谁」的文本（`docs/ui.md` §8.4）：按首次出现顺序列前 `AGGREGATE_SENDERS_SHOWN`
 * 位，多于这个数就补「等 N 人」（N = **参与观众总数**，不是折叠条数 —— 条数由 `×N` 那一格说）。
 */
export function sendersText(senders: SenderRef[]): string {
  const names = senders
    .slice(0, AGGREGATE_SENDERS_SHOWN)
    .map((sender) => (sender.uname.length > 0 ? sender.uname : ANONYMOUS_SENDER));
  const head = names.join("、");
  return senders.length > names.length
    ? `${head} 等 ${senders.length} 人`
    : head;
}
