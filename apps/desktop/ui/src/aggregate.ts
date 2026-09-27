// 弹幕聚合的纯逻辑（issue 202609211940 第 3 条）：**不同观众**在短时间窗口里发的**同一条**
// 弹幕够多了就折成一行，头像列画前几位发言者的头像，身份位改印「刷屏 ×N」。
// 独立成模块的理由：它是纯函数（不碰 React、不碰 store），能脱离界面单独验证；
// 参数是规范性常量，只能从 `docs/contract.md` §4 原样引用。
//
// 与 `filtering.ts` 的**礼物连击折叠**是两条互不相干的规则（`docs/ui.md` §8.4）：
// 那条折的是**同一个动作**的重复（同一次连击、同一个 `combo_id`），
// 这条折的是**不同的人**说了同一句话。别把两者并到一处。

import type { DisplayRow, SenderRef } from "./filtering";
import type { Message, Prefs } from "./types";

/**
 * 聚合窗口（毫秒）：一条聚合行只收**上一条之后**这个窗口内的消息（契约 §4）。
 *
 * 取 5 秒的依据：契约 §4 的「相同内容 5 秒内去重」是同一个尺度上的节流窗口，
 * 单个人在那里已经被压成 5 秒一条 —— 窗口取同一档，聚合里出现的多条就只可能来自
 * **不同的观众**，正是这条需求要的形态（「不同的观众短时间内刷同一个弹幕」）。
 *
 * **滑动**：基准是这一串的**最后一条**，每并进一条就把整个窗口往后刷一次 5 秒 ——
 * 只要这条刷屏还在有人接，它就一直并进同一行，**没有条数上限**（用户：「5 秒内聚合，
 * 每聚合一条重新刷新一次 5 秒，无上限」）。
 *
 * 当初定「非滑动」（锚点 = 第一条、不随后续顺延）的理由是怕「一个人流量不断时这一行
 * 永远闭不了口、行的寿命没有上界」。实际用下来那正是刷屏本来的样子：非滑动会把同一波
 * 刷屏按 5 秒**硬切**成好几串，每串都可能不够 `AGGREGATE_MIN_COUNT` 而一行都不折，
 * `×N` 也被摊成好几个小数 —— 折不出来的聚合等于没有聚合。改回滑动之后，行的收口
 * 交给「下一条换了键 / 超过 5 秒没人再接」，行的寿命由刷屏自己结束，不再人为封顶。
 */
export const AGGREGATE_WINDOW_MS = 5000;

/**
 * **折叠门槛**：同键的一串要够 3 条才折成一行，不足就逐条照原样显示（契约 §4）。
 *
 * 为什么是 3：折起来的代价是**信息**——折完之后那一行不再有用户名（身份位改印「刷屏 ×N」），
 * 谁说的只能靠头像列那几张图认。两条同文本里省下的那一行不值得把「谁说的」搭进去，
 * 而且两条重复最常见的情形是**同一个人**连发两遍（那连「不同观众」都不成立）；
 * 三条以上才叫刷屏 —— 这正是用户报这条需求时说的形态（issue 202609211940 第 3 条
 * 「3 条以上刷屏触发折叠」）。门槛与 `AGGREGATE_MIN_SENDERS` 各管一头：
 * 这条管「同一条刷了几次」，那条管「是不是不止一个人在刷」。
 */
export const AGGREGATE_MIN_COUNT = 3;

/**
 * 聚合行的头像列**画**几位观众的头像（契约 §4）；参与观众多于这个数的，多出来的不画 ——
 * 头像列只回答「是几个人在刷」，不报总数（条数由身份位的 `×N` 说）。
 *
 * 为什么是 3：每人只错开 30% 个头像宽，3 张一共占 1.6 个头像宽（≈ 窄屏 360 下正文可用宽度的
 * 1/6），再多就开始吃正文的宽度；而 3 张已经足够看出「不是同一个人」。
 * 它同时是**向上取整的上限**：`AGGREGATE_MIN_SENDERS`（2）≤ 它，因此收集时收到这个数
 * 就够判定加展示两件事了（见 `sendersOf`）。
 */
export const AGGREGATE_AVATARS_SHOWN = 3;

/**
 * 聚合成立的**观众**门槛：参与观众按 uid 去重后至少两位（契约 §4）。
 * 「同一句」在同一个人嘴里重复不叫刷屏 —— 那是一个人连发，与跨观众聚合无关。
 */
const AGGREGATE_MIN_SENDERS = 2;

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
 * 一串里出现过的观众：按首次出现顺序去重（契约 §4），最多收 `AGGREGATE_AVATARS_SHOWN` 位 ——
 * 判定要两位、展示要三位，收到三位，两件事都不缺了（再多收也没人看，还白扫一遍）。
 */
function sendersOf(run: DisplayRow[]): SenderRef[] {
  const limit = Math.max(AGGREGATE_AVATARS_SHOWN, AGGREGATE_MIN_SENDERS);
  const senders: SenderRef[] = [];
  for (const row of run) {
    const { uid, uname, face } = row.message;
    if (senders.some((sender) => sender.uid === uid)) continue;
    senders.push({ uid, uname, face: face ?? "" });
    if (senders.length >= limit) break;
  }
  return senders;
}

/**
 * 弹幕聚合：把**同一窗口内同键**的弹幕折成一行（`docs/ui.md` §8.4 的第二张表）。
 *
 * 与旧版的关键差别（issue 260926 后续）：不要求同键弹幕**连续** —— 中间可以插任何别的行
 * （不同文本弹幕、礼物 / SC / 大航海 / 互动 / 系统、本地乐观行、空正文、低价礼物桶），
 * 这些都不参与聚合，也**不打断**某一键的累积。判据仍只有两条门槛：同键的一组够
 * `AGGREGATE_MIN_COUNT` 条、**且**去重后够 `AGGREGATE_MIN_SENDERS` 位不同 uid 才折
 * （`message` = 组里第一条，`count` = 组大小，`senders` = 前几位观众）。
 *
 * 两遍：
 * - **第一遍分组**：顺一个 `Map<key, Group>` 收，一条同键消息只要离本组**最后并入**那条同键
 *   消息 ≤ `AGGREGATE_WINDOW_MS`（滑动窗口，与上一条同键比）就并进同一组；超窗口则同键另起
 *   一组（旧组封口）。非聚合行（键为 `null`）既不进组、也不打断任何组。
 * - **第二遍决定折不折**：够门槛的组折成一行（代表行用第一条，React key 不动、节点不重建、
 *   正文 / 时间戳都不动，只加 `count` 与 `senders`）；不够门槛的组一行都不动，成员留在原位
 *   （不重排、不复制）。折叠**不改入参**——折出来的行是新对象，原消息一个字段都没动。
 *
 * 关掉 `ui.danmaku_aggregate` 即逐条显示（返回入参本身，不复制、不重排）。
 * 输入是 `filtering.toDisplayRows` 的输出（已过滤 + 已做礼物连击折叠）；不改动入参。
 */
export function aggregateRows(rows: DisplayRow[], prefs: Prefs): DisplayRow[] {
  if (!prefs["ui.danmaku_aggregate"]) return rows;

  interface Group {
    indices: number[];
    lastTs: number;
  }
  const groups: Group[] = [];
  const activeByKey = new Map<string, Group>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // 低价礼物桶（`ui.gift_collapse_cheap`）不参与：它是另一条合并规则的产品，别再并一次。
    // 桶本来只装 `gift`、`aggregateKey` 对非弹幕已经返回 null —— 这一句是显式的边界，
    // 免得以后桶装得下别的 kind 时悄悄串味。
    const key = row.cheap ? null : aggregateKey(row.message);
    if (key === null) continue; // 非聚合行：不进组、也不打断任何组
    const g = activeByKey.get(key);
    if (g !== undefined && row.message.ts - g.lastTs <= AGGREGATE_WINDOW_MS) {
      // 滑动窗口：与上一条同键比，每并入一条即顺延 —— 没有条数上限。
      g.indices.push(i);
      g.lastTs = row.message.ts;
    } else {
      if (g !== undefined) groups.push(g); // 同键但超出窗口：旧组封口，同键另起一组
      const ng: Group = { indices: [i], lastTs: row.message.ts };
      activeByKey.set(key, ng);
    }
  }
  for (const g of activeByKey.values()) groups.push(g);

  // 够门槛才折；不够门槛的组一行都不动（成员留在原位，不重排、不复制）。
  const dropped = new Set<number>();
  const repAt = new Map<number, DisplayRow>();
  for (const g of groups) {
    const members = g.indices.map((index) => rows[index]);
    const senders = sendersOf(members);
    if (members.length >= AGGREGATE_MIN_COUNT && senders.length >= AGGREGATE_MIN_SENDERS) {
      for (let k = 1; k < members.length; k++) dropped.add(g.indices[k]);
      // 代表行 = 第一条；`message` 仍是第一条（身份 / 正文 / React key 都不动），只加 `count` 与 `senders`。
      repAt.set(g.indices[0], { ...members[0], count: members.length, senders });
    }
  }

  const out: DisplayRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (dropped.has(i)) continue; // 被折进代表行的后续同键消息：丢弃
    const rep = repAt.get(i);
    out.push(rep !== undefined ? rep : rows[i]);
  }
  return out;
}
