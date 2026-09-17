// 显示层的纯逻辑：过滤、礼物连击折叠、徽标派生、时间格式化。
// 这些规则来自 docs/ui.md 与 docs/contract.md §8 的偏好键，放这里便于单测。

// 显式带 `.ts` 后缀 + 混用 `type` 修饰符：这个模块要从 `types.ts` 取**值**
// （`INTERACT_AUTO_HIDE_MS`），而本文件的单测用 `node --test src/filtering.test.ts` 直接跑
// （Node 的类型擦除**只认带后缀的相对说明符**，它不解析 `./types` 那种无后缀写法）。
// `tsconfig.app.json` 已开 `allowImportingTsExtensions`，vite 与 tsc 都照这个后缀解析。
import {
  INTERACT_AUTO_HIDE_MS,
  type FollowedRoom,
  type Message,
  type MessageKind,
  type Prefs,
} from "./types.ts";

export interface Badges {
  anchor: boolean;
  admin: boolean;
  /** 0 无 / 1 总督 / 2 提督 / 3 舰长 */
  guardLevel: number;
  medalLevel: number;
  medalName: string;
}

/**
 * 徽标派生：主播由 uid == anchor_uid 派生，房管与大航海取消息字段。
 *
 * **粉丝牌只在「亮着」时才算数**（`Message.medal_lit` ← 上游 `user.medal.is_light`）：
 * 官方前端的弹幕行渲染分支就是这么判的（`if (F?.is_lighted) { 追加粉丝牌 }`，
 * `is_lighted` 由 `medal.is_light` 派生 —— 2026-09-13 读官方产物取证）：
 * **没点亮的牌官方不画**，上游连配色都给灰（实测 `#919298*`）。
 * 过滤放在这里而不是渲染处：`hasBadges` 与牌面都从这几个字段派生，在这里归零最省事。
 */
export function badgesFor(message: Message, anchorUid?: number): Badges {
  const lit =
    message.medal_lit && message.medal_level > 0 && message.medal_name.length > 0;
  return {
    anchor: anchorUid !== undefined && anchorUid !== 0 && message.uid === anchorUid,
    admin: message.is_admin,
    guardLevel: message.guard_level,
    medalLevel: lit ? message.medal_level : 0,
    medalName: lit ? message.medal_name : "",
  };
}

export const GUARD_TITLE: Record<number, string> = {
  1: "总督",
  2: "提督",
  3: "舰长",
};

/**
 * 粉丝牌底色相（**兜底**用，不是首选）。
 *
 * 官方的牌面配色来自上游 `v2_medal_color_start/_end/_border/_text`，契约 §5 已转发
 * （`Message.medal_color_*`）；上游没给（空串）时才退回这里按牌名派生的稳定色相：
 * 不同主播颜色不同，同一主播每次一致。
 */
export function medalHue(name: string): number {
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return hue;
}

/**
 * 粉丝牌配色（docs/ui.md §4.2）：**优先**上游真彩色（契约 §5 `Message.medal_color_*`，
 * 带 alpha 的 CSS 十六进制串），缺失时回退到按牌名派生的色相（本地设计：同一主播固定、
 * 不同主播不同色）。
 *
 * 引擎保证缺失即**空串**，而空串不是颜色，所以每一档单独判空：起止色缺一个就整体回退，
 * 描边与文字色各自回退到 CSS 里的默认值。
 */
export function medalColors(message: Message): {
  start: string;
  end: string;
  border?: string;
  text?: string;
} {
  const start = message.medal_color_start ?? "";
  const end = message.medal_color_end ?? "";
  const hue = medalHue(message.medal_name);
  const solid = start.length > 0 && end.length > 0;
  return {
    start: solid ? start : `hsl(${hue} 32% 50%)`,
    end: solid ? end : `hsl(${hue} 34% 66%)`,
    border: message.medal_color_border || undefined,
    text: message.medal_color_text || undefined,
  };
}

/** 过滤规则（docs/ui.md §8.1 的求值顺序：类型 → 粉丝牌 → 用户）。 */
export function passesFilter(message: Message, prefs: Prefs): boolean {
  if (prefs["filter.kinds"].length > 0 && !prefs["filter.kinds"].includes(message.kind)) {
    return false;
  }
  if (message.medal_level < prefs["filter.medal_level_min"]) return false;
  if (prefs["filter.uids"].includes(message.uid)) return false;
  return true;
}

/**
 * 观众数的展示格式：过万折成「x.x万」（官方客户端同款习惯）。
 * 在线人数与累计看过的取值路径见 docs/protocol.md §10.7。
 */
export function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

export interface DisplayRow {
  message: Message;
  /**
   * 这一行代表几条消息（1 = 未折叠）。>1 有三个来源：礼物**连击**折叠（`toDisplayRows`，
   * 同一次连击的重复）、**低价礼物桶**（`collapseCheapGiftRows`，带 `cheap` 标记）与
   * 弹幕**聚合**（不同观众短时间内刷同一句，`aggregate.ts`，带 `senders`）。
   * 金额同理取 `message.amount`（前两条路径都把它累加成合计）。
   */
  count: number;
  /**
   * 这一行是**低价礼物桶**（`ui.gift_collapse_cheap` 折叠出来的那一条，见
   * `collapseCheapGiftRows`）：`count` 与 `amount` 都是整桶合计。
   * **两个区域各有一条自己的桶行**（弹幕区与礼物栏各折一次），其余行
   * （含未折叠的单条低价礼物）都没有这个标记。
   */
  cheap?: boolean;
}

/** 关注列表每页条数（需求 §2.11 的分页；前端分页，后端一次拉全）。 */
export const FOLLOW_PAGE_SIZE = 30;

/**
 * 关注列表排序（docs/ui.md §2.2，需求 §2.11，用户 #16）：
 * 直播中置顶 → **最近观看降序** → 最后开播时间近的在前 → 人气高的在前 → 房间号升序兜底。
 *
 * `recentWatched` 是 `ui.recent_watched`（房间号 → 打开时刻，UTC 毫秒）。没看过的房间
 * 没有条目，按 0 参与比较：**全都会排在看过的之后**，彼此之间仍走旧的那条链
 * （`live_start_at` → `online` → `room_id`），所以缺省 `{}` 时与旧版行为完全一致。
 *
 * `live_start_at`（上游 `liveTime`，Unix 秒）与 `online` 缺失时按 0 参与比较，
 * 退化成「直播中置顶 + 房间号升序」——不会因此乱序或抛错。
 * 不改动入参，返回新数组。
 */
export function sortFollowedRooms(
  rooms: FollowedRoom[],
  recentWatched: Record<string, number> = {},
): FollowedRoom[] {
  return [...rooms].sort((a, b) => {
    const live = Number(b.live_status === 1) - Number(a.live_status === 1);
    if (live !== 0) return live;
    const watched =
      (recentWatched[String(b.room_id)] ?? 0) -
      (recentWatched[String(a.room_id)] ?? 0);
    if (watched !== 0) return watched;
    const time = (b.live_start_at ?? 0) - (a.live_start_at ?? 0);
    if (time !== 0) return time;
    const online = (b.online ?? 0) - (a.online ?? 0);
    if (online !== 0) return online;
    return a.room_id - b.room_id;
  });
}

/**
 * 房间名的兜底：上游连主播名与标题都没给（`anchor_uname` 与 `title` 都是空串）时
 * **只报房间号**。
 *
 * 为什么不是「未命名直播间」那种占位：占位词不告诉用户这是哪个房间（用户 2026-09-12
 * 报的就是它）。口径见 `docs/ui.md` §2.2：主播名 → 直播间标题 → 房间 <号>。
 */
export function roomFallbackName(roomId: number): string {
  return `房间 ${roomId}`;
}

/**
 * 列表里的房间名（用户 #17：房间列表不展示房间号）：
 * 「主播名 · 直播间名」，缺哪一侧就只显示另一侧（不留悬空的分隔符）；
 * 两侧都没有才退到 `roomFallbackName`。
 */
export function roomDisplayName(room: {
  room_id: number;
  anchor_uname: string;
  title: string;
}): string {
  const parts = [room.anchor_uname.trim(), room.title.trim()].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : roomFallbackName(room.room_id);
}

/**
 * 标签条上的房间名（用户 #18：tab 展示主播名）。
 * 主播名取不到才退回直播间标题，标题也没有才退到房间号——标签也要能认出是哪个房间。
 */
export function roomTabName(room: {
  room_id: number;
  anchor_uname: string;
  title: string;
}): string {
  const uname = room.anchor_uname.trim();
  if (uname.length > 0) return uname;
  const title = room.title.trim();
  return title.length > 0 ? title : roomFallbackName(room.room_id);
}

/** 分页切片；`page` 从 1 开始，越界时夹回有效范围。 */
export function paginate<T>(
  items: T[],
  page: number,
  size = FOLLOW_PAGE_SIZE,
): { items: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, pageCount };
}

/**
 * 这条互动/进场行是不是**已经到点、不该再画**（`ui.interact_auto_hide`，docs/ui.md §4.8）。
 *
 * 判据只有一条：`ts + INTERACT_AUTO_HIDE_MS <= now` —— 与行上那段淡出动画共用同一个常量
 * （`types.ts` 的 `INTERACT_AUTO_HIDE_MS`），两者不会错位。`ui.interact_auto_hide` 关着时
 * **恒假**：关掉开关，早先「消失」的那些行原样回来（顺序、数量都不变）。
 *
 * **它只回答「画不画」，不回答「留不留」**：消息一直在会话缓冲里（调用方给的 `messages`），
 * 「消失」是派生出来的 —— 这正是 issue 2609171849 第 5 条要的那条口径（自动消失不许丢内容）。
 * 时间由调用方给（默认 `Date.now()`），单测因此与挂钟无关。
 */
export function interactAutoHidden(message: Message, prefs: Prefs, now: number): boolean {
  return (
    prefs["ui.interact_auto_hide"] &&
    message.kind === "interact" &&
    message.ts + INTERACT_AUTO_HIDE_MS <= now
  );
}

/**
 * 过滤 + 礼物连击折叠。只折叠**礼物连击**：同一次连击的每条礼物共享 `combo_id`，
 * 合成一行，`count` 记条数、`amount` 累加。
 *
 * 这里**不做**「相似消息合并」（同 uid + 同正文 + 时间窗）——用户 2026-09-13 明确
 * 那条功能不是他要的、也没必要，整条删除（见 `docs/requests.md` P49）。
 *
 * **本地乐观行不参与礼物连击折叠**（用户 2026-09-13 的决定，docs/ui.md §4.4）：刚发出的那条必须
 * 自己单独站一行，否则「我这条到底发出去没有」会被折进上一行的 ×N 里。判据取 `local_id < 0`
 * （本地行恒为负，见 `store.insertPending`）而不是 `send_state` —— 乐观行插入时**不带**
 * `send_state`（它与已确认行渲染逐项相同），只有这条负数前缀能一直认出它。
 *
 * `now` 只喂给「互动消息自动消失」那一判（见 `interactAutoHidden`）：到点的互动行**不画**，
 * 但它**仍在 `messages` 里**（调用方传进来的数组一个元素都不少）—— 关掉
 * `ui.interact_auto_hide` 后同一份输入立刻把这一行原样还回来（issue 2609171849 第 5 条：
 * 隐藏 / 自动消失只是显示层的事，不许丢内容）。默认 `Date.now()` 只是给调用方便利；
 * 单测一律显式传时刻，判据因此与挂钟无关。
 */
export function toDisplayRows(
  messages: Message[],
  prefs: Prefs,
  now: number = Date.now(),
): DisplayRow[] {
  const rows: DisplayRow[] = [];

  for (const message of messages) {
    if (!passesFilter(message, prefs)) continue;
    if (interactAutoHidden(message, prefs, now)) continue;

    const last = rows[rows.length - 1];
    const pending = message.local_id < 0 ||
      (last !== undefined && last.message.local_id < 0);
    // 礼物连击：同一次连击的每条礼物共享 `combo_id`，一律折叠成一行。
    // 连击刷屏本来就是同一个动作的重复。
    const sameCombo =
      last !== undefined &&
      message.combo_id.length > 0 &&
      last.message.combo_id === message.combo_id;
    const mergeable = !pending && sameCombo;

    if (mergeable) {
      last.count += 1;
      // 金额累加：连击折叠成一行后，这一行的 amount 应是整串连击的总额，
      // 否则「礼物金额统计」会只算到第一条。
      last.message = { ...message, amount: last.message.amount + message.amount };
      continue;
    }
    rows.push({ message, count: 1 });
  }
  return rows;
}

/**
 * 礼物类三族（docs/ui.md §5）：礼物 / SC / 大航海。
 *
 * 它们是**两枚偏好键各自作用的对象**：`ui.gift_in_danmaku` 决定它们要不要留在弹幕流里，
 * `ui.gift_panel` 决定独立礼物栏存在不存在；`filter.kinds` 白名单是更上一层、对两处都生效
 * （`toDisplayRows` 已先把白名单外的行滤掉）。
 */
export const GIFT_KINDS: readonly MessageKind[] = ["gift", "superchat", "guard"];

/**
 * 礼物类消息的去向（docs/ui.md §5）：两枚键各管一头，四种组合都有确定行为。
 *
 * | `ui.gift_in_danmaku` | `ui.gift_panel` | 结果 |
 * |---|---|---|
 * | 真（默认） | 真（默认） | 弹幕流与独立礼物栏**都**渲染这三类 |
 * | 真 | 假 | 只在弹幕流里 |
 * | 假 | 真 | 只在独立礼物栏里 |
 * | 假 | 假 | 两处都不渲染（用户自己的选择；`filter.kinds` 里的礼物芯片与这个结论无关） |
 *
 * **低价礼物桶对两个区域都生效**（`ui.gift_collapse_cheap`，issue 2609171849 第 5 条）：
 * 弹幕区与礼物栏**各折一次**，走的是同一条 `collapseCheapGiftRows`，桶的形状与落点判据
 * （取桶里第一条的身份与位置）两处完全一样 —— 「两个区域」指的就是这两栏，见
 * `docs/ui.md` §5.3「低价礼物桶」段。两处各持自己的行集合：一条礼物在弹幕区折进桶里，
 * 在礼物栏也折进（另一条）桶里，二者互不影响，也都不动 `filter.kinds` 那一层。
 */
export function splitGiftRows(
  rows: DisplayRow[],
  prefs: Prefs,
): { chatRows: DisplayRow[]; giftRows: DisplayRow[] } {
  // 折叠是**纯派生**：两处的桶都从同一个 `rows` 现折，`messages` 一个元素都不动 ——
  // 关掉开关下次重算就逐条回来（数量、顺序、金额都回到原样）。
  const collapse = prefs["ui.gift_collapse_cheap"];
  const panelRows = prefs["ui.gift_panel"]
    ? rows.filter((row) => GIFT_KINDS.includes(row.message.kind))
    : [];
  const giftRows = collapse ? collapseCheapGiftRows(panelRows) : panelRows;
  const chatBase = prefs["ui.gift_in_danmaku"]
    ? rows
    : rows.filter((row) => !GIFT_KINDS.includes(row.message.kind));
  const chatRows = collapse ? collapseCheapGiftRows(chatBase) : chatBase;
  return { chatRows, giftRows };
}

/**
 * 金瓜子与元的换算（契约 §5「金额单位」）：**1 元 = 1000 金瓜子**。
 *
 * 依据三条：① 社区协议文档给的礼物 `price` 口径就是「该值 / 1000 的单位为元」；
 * ② SC 载荷里的 `rate = 1000`（2026-09-12 实测，`protocol.md` A9）与之一致；
 * ③ 大航海 `price` 同为 CNY × 1000（A12）——舰长 138000 ↔ 官方标价 138 元。
 *
 * **不要把 `price` 当电池数**：金瓜子与电池另有比值（1 电池 = 100 金瓜子 = 0.1 元，
 * 即 1 元 = 10 电池，见 `protocol.md` A29），当成电池会差 10 倍。
 */
const COINS_PER_YUAN = 1000;

/**
 * 金额的展示文本（含单位）。**单位统一是元**（用户 2026-09-16 口径）：
 * SC 的 `amount` 上游本来就是元，礼物与大航海是金瓜子，按 `COINS_PER_YUAN` 换算成元再打印。
 * 整数元不带小数（`138 元`），非整数保留必要小数（`0.1 元`）——金瓜子 ÷ 1000 最多三位小数，
 * 因此小数位上限就是 3。
 *
 * `amount <= 0` 表示上游没给价（协议 §10.2 / §10.6：无价字段时 `0`，不得猜测）——
 * 这时返回**空串**，界面不画金额格，也不拿 0 冒充一个数。
 */
export function amountText(amount: number, kind: MessageKind): string {
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const yuan = kind === "superchat" ? amount : amount / COINS_PER_YUAN;
  return `${yuan.toLocaleString(undefined, { maximumFractionDigits: 3 })} 元`;
}

/**
 * 低价礼物的门槛：单个价值 ≤ 0.1 **元**（契约 §8 两枚键的共同判据）。
 *
 * 单位口径照 `amountText`：一律先换算成元再比，`COINS_PER_YUAN` = 1000，因此门槛恰好是
 * **100 金瓜子** —— 冒烟夹具里那条「投喂 辣条」（100 金瓜子）就落在边界上、算低价。
 */
export const CHEAP_GIFT_YUAN = 0.1;

/**
 * 这条消息算不算「低价礼物」（契约 §8 的口径表）：
 *
 * ① 只有 `kind === "gift"` 参与 —— SC 最低档 30 元、舰长 138 元，两枚开关**不碰**它们；
 * ② 单个价值 ≤ 0.1 元（0.09 与 0.1 算低价，0.11 不算）；
 * ③ `amount <= 0` **不算低价**：协议 §10.2 / §10.6 的口径是「上游没给价、不得猜测」
 *    （界面也不画金额格），不是「免费」—— 折进低价桶等于替上游猜价。这一条同时管住 `0` 那一档。
 */
export function isCheapGift(message: Message): boolean {
  return (
    message.kind === "gift" &&
    message.amount > 0 &&
    message.amount / COINS_PER_YUAN <= CHEAP_GIFT_YUAN
  );
}

/**
 * 低价礼物桶（`ui.gift_collapse_cheap`，docs/ui.md §5.3）：把低价礼物合并成**一条**。
 *
 * **两个区域各折一次**（issue 2609171849 第 5 条）：弹幕区与礼物栏都走这一个函数
 * （`splitGiftRows` 里对两头各调一次），形状与落点判据两处完全一致。函数本身与「哪一栏」
 * 无关 —— 它只看行集合。
 *
 * 它与礼物连击折叠（`toDisplayRows`）**不是同一件事，别把两者并到一处**：
 * - 连击折叠折的是**同一个动作的重复**（`combo_id` 相同且相邻），取**最新**一条的身份，
 *   行的位置跟着连击走 —— 连击有天然的顺序与边界；
 * - 低价礼物桶折的是**一段时间里所有人的零钱礼物**，彼此无关。它取桶里**第一条**的身份与
 *   **位置**：新礼物进来只改这一行的 `×N` 与金额，行本身不跳位（React key = 第一条的
 *   `local_id` 也不变），虚拟列表的锚点因此稳定。
 *
 * 两者叠加时（低价礼物本身也在连击）顺序是**先连击、后成桶**：桶里的 `count` 已是连击折叠后的
 * 次数，与「数量与弹幕行同口径」那一条一致。桶里只有一条时**原样返回入参**（本来就是一条）。
 *
 * **不改入参、不丢内容**：返回的是新数组，桶里那些行的 `message` 一个字段都没被改写
 * （合并行是 `{...head.message}` 的新对象），`messages` 与 `rows` 都保持原样 —— 关掉开关
 * 下一次重算就逐条回来（数量、顺序、金额都是原值）。
 *
 * `cheap` 标记只在这一处置位：合并行的 `amount` 是整桶合计，早就超过 100 金瓜子了，
 * 单看金额认不出它是低价（`giftStatRows` 靠这个标记整桶剔除）。
 */
export function collapseCheapGiftRows(rows: DisplayRow[]): DisplayRow[] {
  const bucket = rows.filter((row) => isCheapGift(row.message));
  if (bucket.length <= 1) return rows;
  const head = bucket[0];
  const merged: DisplayRow = {
    message: {
      ...head.message,
      amount: bucket.reduce((sum, row) => sum + row.message.amount, 0),
    },
    count: bucket.reduce((sum, row) => sum + row.count, 0),
    cheap: true,
  };
  const out: DisplayRow[] = [];
  let placed = false;
  for (const row of rows) {
    if (!isCheapGift(row.message)) {
      out.push(row);
      continue;
    }
    if (!placed) {
      out.push(merged);
      placed = true;
    }
  }
  return out;
}

/**
 * 参与**折叠汇总 / 统计**的礼物行（`ui.gift_exclude_cheap_stats`，契约 §8）：
 * 开时把低价礼物（含折叠后那一条桶）整条剔除，关时原样返回。
 *
 * **只改统计**：礼物栏的条目（`splitGiftRows` 的 giftRows）与弹幕流的行都不经过这里 ——
 * 「不影响它们作为消息的展示」就是这枚键的定义（契约 §8）。
 *
 * 「统计」在本应用里只有**一处**：礼物栏折叠头那份按 kind 分组的汇总（`RoomView` 的
 * `giftSummaryText`，标题的「礼物 / SC（N）」与三组明细同源）。**弹幕区没有统计面**
 * （它的礼物行不画金额，见 docs/ui.md §5.3「金额与单位」），所以这枚键在那一栏没有可改的
 * 东西 —— 这也是它对**两个区域都生效**的确切含义：统计出现在哪，它就管到哪；判定用的是
 * 与折叠同一枚 `isCheapGift`（`row.cheap` 只是「这条是桶」的标记，桶的金额已被累加、
 * 单看金额认不出来，所以两个条件都要查）。
 *
 * 与折叠一样是**纯派生**：入参 `rows` 不被改写，关掉开关下一次重算统计就逐字回来。
 */
export function giftStatRows(rows: DisplayRow[], prefs: Prefs): DisplayRow[] {
  if (!prefs["ui.gift_exclude_cheap_stats"]) return rows;
  return rows.filter((row) => !row.cheap && !isCheapGift(row.message));
}

/**
 * SC 卡片档位（`1`…`5`，对应 `--sc-1 … --sc-5` 五枚令牌）。
 *
 * **边界是本地取值，不是官方取色**：B 站 SC 的可购档位是 30 / 50 / 100 / 500 / 1000 / 2000 元，
 * 这里按其中段切成五档（分界 100 / 500 / 1000 / 2000 元），取值依据写在 docs/ui.md §4.1；
 * 与网页端卡片配色的逐档比对仍留在 docs/protocol.md 附录 A 的待校准表里
 * （A.2「SC 卡片配色档位边界」），核验后改边界即改这一处。
 *
 * `amount <= 0`（上游没给价）落到**最低档**，不编造高档位。
 */
export function superChatTier(amount: number): 1 | 2 | 3 | 4 | 5 {
  if (amount >= 2000) return 5;
  if (amount >= 1000) return 4;
  if (amount >= 500) return 3;
  if (amount >= 100) return 2;
  return 1;
}

export function formatClock(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 关注列表里的最后开播时间（本地时区 `MM-DD HH:mm`）。
 * 上游给的是 Unix 秒；0 / 未给 = 未知，返回空串（界面不画「—」顶替）。
 */
export function formatLastLive(startAt?: number): string {
  if (startAt === undefined || startAt <= 0) return "";
  const date = new Date(startAt * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
