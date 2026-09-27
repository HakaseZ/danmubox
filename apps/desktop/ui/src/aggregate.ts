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
 * **滑动**：基准是这一组的**最后并入**的那条（需求 202609271523 §二 2.4），每并进一条就把整个窗口往后
 * 刷一次 5 秒 —— 只要这条刷屏还在有人接，它就一直并进同一组，**没有条数上限**（用户：
 * 「5 秒内聚合，每聚合一条重新刷新一次 5 秒，无上限」）。
 *
 * 当初定「非滑动」（锚点 = 第一条、不随后续顺延）的理由是怕「一个人流量不断时这一行
 * 永远闭不了口、行的寿命没有上界」。实际用下来那正是刷屏本来的样子：非滑动会把同一波
 * 刷屏按 5 秒**硬切**成好几串，每串都可能不够 `AGGREGATE_MIN_COUNT` 而一行都不折，
 * `×N` 也被摊成好几个小数 —— 折不出来的聚合等于没有聚合。改回滑动之后，组的收口
 * 只由「超过 5 秒没人再接同一条」决定 —— **换键（乃至插进任何别的行）都不再收口**
 * （需求 202609271523 §二 2.3），组的寿命由刷屏自己结束，不再人为封顶。
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
 * 为什么是 3：每人只错开 34% 个头像宽（每人露 66%，需求 202609271523 §二 2.1；错开量在 `MessageRow` 的
 * `AVATAR_STACK_OFFSET`，低价礼物桶复用同一个常量，故两族同取一个值 —— 需求 202609271523 §二 2.2），
 * 3 张一共占 1.68 个头像宽（≈ 窄屏 360 下正文可用宽度的 1/6），再多就开始吃正文的宽度；
 * 而 3 张已经足够看出「不是同一个人」。
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
 * 这条消息落在哪个**聚合键**上；`null` = 不参与聚合、自己独占一行
 * （礼物 / SC / 大航海 / 互动 / 系统 / 低价礼物桶 / 本地乐观行 / 空正文，需求 202609271523 §二 2.3）。
 *
 * 返回 `null` 只是说「这一行不参与聚合」——它**不打断**同键已经累积起来的那一组
 * （见 `aggregateRows` 的第一趟）。
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
 * 一组里出现过的观众：按首次出现顺序去重（契约 §4），最多收 `AGGREGATE_AVATARS_SHOWN` 位 ——
 * 判定要两位、展示要三位，收到三位，两件事都不缺了（再多收也没人看，还白扫一遍）。
 * 入参是**这一组的成员下标**（升序），行本身仍从 `rows` 现取 —— 分组那一趟只记下标，
 * 不复制行对象。
 */
function sendersOf(rows: readonly DisplayRow[], members: readonly number[]): SenderRef[] {
  const limit = Math.max(AGGREGATE_AVATARS_SHOWN, AGGREGATE_MIN_SENDERS);
  const senders: SenderRef[] = [];
  for (const at of members) {
    const { uid, uname, face } = rows[at].message;
    if (senders.some((sender) => sender.uid === uid)) continue;
    senders.push({ uid, uname, face: face ?? "" });
    if (senders.length >= limit) break;
  }
  return senders;
}

/** 一组同键弹幕：成员是它们在入参里的**下标**（升序），`lastTs` 是**最后并入**的那条的时刻。 */
interface AggregateGroup {
  members: number[];
  lastTs: number;
}

/**
 * 弹幕聚合：把**同键、同窗口内、够多条且不止一个人**的弹幕折成一行
 * （`docs/ui.md` §8.4 的第二张表）。
 *
 * 分两趟走 —— 只为「容忍插花」还保住 O(n)（列表是虚拟化的，不能引入 O(n²)）：
 *
 * **第一趟：分组。** 只有取到**聚合键**的行参与（`aggregateKey` 返回 `null` 的行 ——
 * 礼物 / SC / 大航海 / 互动 / 系统 / 低价礼物桶 / 本地乐观行 / 空正文 —— 与**键不同**的
 * 弹幕一样，**都不打断**同键已经累积起来的那一组，需求 202609271523 §二 2.3）。
 * 同键的行按「与**这一组最后并入**的那条」的**距离**归组（需求 202609271523 §二 2.4）：
 * 距离 ≤ `AGGREGATE_WINDOW_MS` 即续窗、每并入一条就把窗口往后刷一次，**没有条数上限**；
 * 隔得太远就为这个键另起一组 —— **每一组各持自己的计时**，插在中间别的行不参与计时。
 *
 * **第二趟：落位。** 折与不折先定下来，再顺着原索引走一遍：**参与聚合且折了的**那一组，
 * 只在**它首条的原位**出一行（需求 202609271523 §二 2.6：折叠行落首条原位、代表行仍是第一条、
 * React key 仍是那一条的 `local_id`，因此节点不重建、行不跳位）；**其余每一行** ——
 * 插花行、以及**未达门槛**那一组的每一个成员 —— 都在自己的位置上**原样输出入参那一行
 * 对象**（需求 202609271523 §二 2.5：不重排、不复制、不重生成）。
 *
 * 折的条件两个都要过：这一组长度 ≥ `AGGREGATE_MIN_COUNT` **且**参与观众按 uid 去重后
 * ≥ `AGGREGATE_MIN_SENDERS` 位不同 uid（`message` = 组内第一条、`count` = 组内条数、
 * `senders` = 去重后前 `AGGREGATE_AVATARS_SHOWN` 位）。先收完整组再判的理由没变：
 * 折不折要看**整组**（够不够 3 条、有没有第二位观众），边收边定就得先假定它会折、
 * 判不成立时再把前面几行吐回去 —— 那才是会留下中间态的写法。
 *
 * 折出来的那一行**不改身份**：`message` 仍是第一条（头像列的**几张**头像来自 `senders`，
 * 正文 / 时间戳 / React key 都不动），只加 `count` 与 `senders`。注意窗口的基准
 * （**最后并入**的一条）与代表行（**第一**条）是两回事，且是刻意的：代表行若跟着窗口走到
 * 最后一条，React key 每来一条同文本就变一次 ⇒ 行节点重建、行在列表里抖。
 *
 * **开关**：`ui.danmaku_aggregate` 关掉即逐条显示（返回入参本身，不复制、不重排）——
 * 与礼物那两枚开关同一条口径：折叠只是显示层的派生，关掉就回到原样。
 *
 * 输入是 `filtering.toDisplayRows` 的输出（已过滤 + 已做礼物连击折叠）；不改动入参。
 */
export function aggregateRows(rows: DisplayRow[], prefs: Prefs): DisplayRow[] {
  if (!prefs["ui.danmaku_aggregate"]) return rows;

  // ---- 第一趟：分组。`groupOf[index] < 0` = 这一行不参与聚合（原样留在原位）。
  const groupOf: number[] = new Array<number>(rows.length).fill(-1);
  const groups: AggregateGroup[] = [];
  /** 每个聚合键**当前**还开着的那一组；同键再来的那条若离得太远，就为它另起一组。 */
  const opened = new Map<string, number>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    // 低价礼物桶（`ui.gift_collapse_cheap`）**不参与**：它是另一条合并规则的产品
    // （桶行 `cheap === true`、`count`/`amount` 已是整桶合计），别把它再并一次。
    // 桶本来只装 `gift`、`aggregateKey` 对非弹幕已经返回 null —— 这一句是显式的边界，
    // 免得以后桶装得下别的 kind 时悄悄串味。
    const key = row.cheap ? null : aggregateKey(row.message);
    if (key === null) continue;

    const current = opened.get(key);
    if (current !== undefined) {
      const group = groups[current];
      // **滑动**：与这一组的**最后并入**的那条比（不是第一条）—— 每并入一条，窗口就整体
      // 往后刷一次 5 秒，因此只要这条刷屏还有人接，它就一直长在同一组里，不设条数上限。
      if (Math.abs(row.message.ts - group.lastTs) <= AGGREGATE_WINDOW_MS) {
        group.members.push(index);
        group.lastTs = row.message.ts;
        groupOf[index] = current;
        continue;
      }
    }
    opened.set(key, groups.length);
    groupOf[index] = groups.length;
    groups.push({ members: [index], lastTs: row.message.ts });
  }

  // ---- 折与不折先定下来：只对「够条数」的那些组算一眼观众（不够的根本不必扫）。
  // 算出不到 `AGGREGATE_MIN_SENDERS` 位的那一组就是不折，第二趟按「原样逐条」处理。
  const sendersByGroup = groups.map((group) =>
    group.members.length >= AGGREGATE_MIN_COUNT ? sendersOf(rows, group.members) : [],
  );

  // ---- 第二趟：落位。顺着原索引走：折了的那一组只在**首条原位**出一行，成员不再各自
  // 出行（插花行留在自己的位置上 ⇒ 原序不变）；其余每一行都原样输出。
  const out: DisplayRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const group = groupOf[index];
    if (group < 0) {
      out.push(rows[index]);
      continue;
    }
    const { members } = groups[group];
    const senders = sendersByGroup[group];
    if (senders.length < AGGREGATE_MIN_SENDERS) {
      // 不折：这一组的成员各自在自己的位置上原样出行（这一条就是它自己那一条）。
      out.push(rows[index]);
      continue;
    }
    // 折：整组只在**首条的原位**出一行，成员里除首条之外的都不再单独出行。
    if (members[0] === index) {
      out.push({ ...rows[index], count: members.length, senders });
    }
  }
  return out;
}
