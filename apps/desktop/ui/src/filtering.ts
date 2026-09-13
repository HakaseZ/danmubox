// 显示层的纯逻辑：过滤、礼物连击折叠、徽标派生、时间格式化。
// 这些规则来自 docs/ui.md 与 docs/contract.md §8 的偏好键，放这里便于单测。

import type { FollowedRoom, Message, Prefs } from "./types";

export interface Badges {
  anchor: boolean;
  admin: boolean;
  /** 0 无 / 1 总督 / 2 提督 / 3 舰长 */
  guardLevel: number;
  medalLevel: number;
  medalName: string;
}

/** 徽标派生：主播由 uid == anchor_uid 派生，房管与大航海取消息字段。 */
export function badgesFor(message: Message, anchorUid?: number): Badges {
  return {
    anchor: anchorUid !== undefined && anchorUid !== 0 && message.uid === anchorUid,
    admin: message.is_admin,
    guardLevel: message.guard_level,
    medalLevel: message.medal_level,
    medalName: message.medal_name,
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

/** 过滤规则（docs/ui.md §8.1 的求值顺序：类型 → 系统通知 → 粉丝牌 → 用户 → 关键词）。 */
export function passesFilter(message: Message, prefs: Prefs): boolean {
  if (prefs["filter.kinds"].length > 0 && !prefs["filter.kinds"].includes(message.kind)) {
    return false;
  }
  // 系统通知（开播 / 下播 / 标题变更 / 公告）默认不渲染，开关打开才显示（需求 §2.4）。
  if (message.kind === "system" && !prefs["ui.system_notice"]) return false;
  if (message.medal_level < prefs["filter.medal_level_min"]) return false;
  if (prefs["filter.uids"].includes(message.uid)) return false;

  const keywords = prefs["filter.keywords"].filter((word) => word.length > 0);
  if (keywords.length > 0) {
    const hit = keywords.some((word) => message.content.includes(word));
    if (prefs["filter.keywords_mode"] === "hide" && hit) return false;
    if (prefs["filter.keywords_mode"] === "only" && !hit) return false;
  }
  return true;
}

/** 命中关键词告警（高亮）：仅当偏好开启且命中时。 */
export function alertsOn(message: Message, prefs: Prefs): boolean {
  if (!prefs["filter.keywords_alert"]) return false;
  return prefs["filter.keywords"]
    .filter((word) => word.length > 0)
    .some((word) => message.content.includes(word));
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
  /** 礼物连击折叠了几条（1 表示未折叠）；只有礼物连击会 > 1。 */
  count: number;
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
 */
export function toDisplayRows(messages: Message[], prefs: Prefs): DisplayRow[] {
  const rows: DisplayRow[] = [];

  for (const message of messages) {
    if (!passesFilter(message, prefs)) continue;

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
