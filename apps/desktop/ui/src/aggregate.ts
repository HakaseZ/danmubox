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
 * 弹幕聚合：把相邻、同键、同窗口内、**够多条且不止一个人**的弹幕折成一行
 * （`docs/ui.md` §8.4 的第二张表）。
 *
 * 单趟「先收 run、再决定折不折」：
 * - **run** = 相邻 + 同键 + 与**锚点**（run 第一条）时间差 ≤ `AGGREGATE_WINDOW_MS`
 *   + 条数 < `AGGREGATE_MAX_COUNT`；
 * - 只有 run 长度 ≥ `AGGREGATE_MIN_COUNT` **且**参与观众去重后 ≥ `AGGREGATE_MIN_SENDERS`
 *   位不同 uid 才折成一行（`message` = run 第一条，`count` = run 长度，
 *   `senders` = 去重后前 `AGGREGATE_AVATARS_SHOWN` 位）；
 * - 否则 run 里每一行**原样逐条输出**（不折的 run 一个对象都不动）。
 * 先收后判的理由：折不折要看**整串**（够不够 3 条、有没有第二位观众），
 * 边收边定就得先假定它会折、判不成立时再把前面几行吐回去 —— 那才是会留下中间态的写法。
 *
 * 折出来的那一行**不改身份**：`message` 仍是第一条（头像列的**几张**头像来自 `senders`，
 * 正文 / 时间戳 / React key 都不动，行因此不跳位、节点不重建），只加 `count` 与 `senders`。
 *
 * **开关**：`ui.danmaku_aggregate` 关掉即逐条显示（返回入参本身，不复制、不重排）——
 * 与礼物那两枚开关同一条口径：折叠只是显示层的派生，关掉就回到原样。
 *
 * 输入是 `filtering.toDisplayRows` 的输出（已过滤 + 已做礼物连击折叠）；不改动入参。
 */
export function aggregateRows(rows: DisplayRow[], prefs: Prefs): DisplayRow[] {
  if (!prefs["ui.danmaku_aggregate"]) return rows;

  const out: DisplayRow[] = [];
  let run: DisplayRow[] = [];
  let runKey: string | null = null;

  const flush = () => {
    if (run.length === 0) return;
    const senders = sendersOf(run);
    if (run.length >= AGGREGATE_MIN_COUNT && senders.length >= AGGREGATE_MIN_SENDERS) {
      out.push({ ...run[0], count: run.length, senders });
    } else {
      // 不折：这一串逐条照原样（**同一个行对象**，不是副本）—— 门槛没到的刷屏
      // 与改前逐条渲染完全一样。
      for (const row of run) out.push(row);
    }
    run = [];
    runKey = null;
  };

  for (const row of rows) {
    // 低价礼物桶（`ui.gift_collapse_cheap`）**不参与**：它是另一条合并规则的产品
    // （T5 的口径：桶行 `cheap === true`、`count`/`amount` 已是整桶合计），别把它再并一次。
    // 桶本来只装 `gift`、`aggregateKey` 对非弹幕已经返回 null —— 这一句是显式的边界，
    // 免得以后桶装得下别的 kind 时悄悄串味。
    const key = row.cheap ? null : aggregateKey(row.message);
    if (key === null) {
      // 不参与聚合的行把当前的 run 就地封口（键不同的行天然把链断开），自己也独占一行。
      flush();
      out.push(row);
      continue;
    }
    if (run.length === 0) {
      run = [row];
      runKey = key;
      continue;
    }
    const joinable =
      key === runKey &&
      Math.abs(row.message.ts - run[0].message.ts) <= AGGREGATE_WINDOW_MS &&
      run.length < AGGREGATE_MAX_COUNT;
    if (joinable) {
      run.push(row);
      continue;
    }
    flush();
    run = [row];
    runKey = key;
  }
  flush();
  return out;
}
