// 显示层的纯逻辑：过滤、合并相似、徽标派生、时间格式化。
// 这些规则来自 docs/ui.md 与 docs/contract.md §8 的偏好键，放这里便于单测。

import type { Emote, FollowedRoom, Message, Prefs } from "./types";

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

/** 连接状态对应的圆点样式（房间头与多房间标签页共用）。 */
export const DOT_CLASS: Record<string, string> = {
  connecting: "_dotConnecting",
  connected: "_dotConnected",
  disconnected: "_dotDisconnected",
  error: "_dotError",
};

/**
 * 观众数的展示格式：过万折成「x.x万」（官方客户端同款习惯）。
 * 在线人数与累计看过的取值路径见 docs/protocol.md §10.7。
 */
export function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value);
}

/**
 * 从收到的弹幕里收集见过的表情，供表情选择器补全。
 *
 * 为什么需要：上游有些表情家族（如 `upower_` 的 UP 主专属表情）**不在直播表情接口里**，
 * 只能从弹幕学到。收下来了却选不到，用户就没法把它们发回去。
 */
export function collectSeenEmotes(messages: Message[]): Emote[] {
  const seen = new Map<string, Emote>();
  for (const message of messages) {
    const emote = message.emote;
    if (!emote || emote.url.length === 0 || emote.emoticon_unique.length === 0) continue;
    if (seen.has(emote.emoticon_unique)) continue;
    seen.set(emote.emoticon_unique, {
      key: `seen:${emote.emoticon_unique}`,
      emoticon_unique: emote.emoticon_unique,
      package_kind: "room",
      text: message.content,
      url: emote.url,
      room_id: message.room_id,
      width: emote.width,
      height: emote.height,
      is_dynamic: emote.is_dynamic,
      in_player_area: emote.in_player_area,
      bulge_display: emote.bulge_display,
    });
  }
  return [...seen.values()];
}

export interface DisplayRow {
  message: Message;
  /** 合并了几条（1 表示未合并）。 */
  count: number;
}

/** 关注列表每页条数（需求 §2.11 的分页；前端分页，后端一次拉全）。 */
export const FOLLOW_PAGE_SIZE = 30;

/**
 * 关注列表排序（docs/ui.md §2.2，需求 §2.11）：
 * 直播中置顶 → 最后开播时间近的在前 → 人气高的在前 → 房间号升序兜底。
 *
 * `live_start_at`（上游 `liveTime`，Unix 秒）与 `online` 缺失时按 0 参与比较，
 * 退化成「直播中置顶 + 房间号升序」——不会因此乱序或抛错。
 * 不改动入参，返回新数组。
 */
export function sortFollowedRooms(rooms: FollowedRoom[]): FollowedRoom[] {
  return [...rooms].sort((a, b) => {
    const live = Number(b.live_status === 1) - Number(a.live_status === 1);
    if (live !== 0) return live;
    const time = (b.live_start_at ?? 0) - (a.live_start_at ?? 0);
    if (time !== 0) return time;
    const online = (b.online ?? 0) - (a.online ?? 0);
    if (online !== 0) return online;
    return a.room_id - b.room_id;
  });
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
 * 过滤 + 合并相似消息。合并规则：同一 uid、同一内容、且在 `ui.merge_window_ms`
 * 窗口内连续出现的消息合成一行，`count` 记录条数（docs/ui.md §8.4）。
 */
export function toDisplayRows(messages: Message[], prefs: Prefs): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const mergeEnabled = prefs["ui.merge_similar"];
  const windowMs = prefs["ui.merge_window_ms"];

  for (const message of messages) {
    if (!passesFilter(message, prefs)) continue;

    const last = rows[rows.length - 1];
    // 礼物连击：同一次连击的每条礼物共享 `combo_id`，一律折叠成一行。
    // 它不受「合并相似消息」开关影响——连击刷屏本来就是同一个动作的重复。
    const sameCombo =
      message.combo_id.length > 0 &&
      last !== undefined &&
      last.message.combo_id === message.combo_id;
    const mergeable = sameCombo || (
      mergeEnabled &&
      message.kind === "danmaku" &&
      last !== undefined &&
      last.message.kind === "danmaku" &&
      last.message.uid === message.uid &&
      last.message.content === message.content &&
      message.ts - last.message.ts <= windowMs);

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

/**
 * 弹幕颜色是十进制 RGB；`0` 与 `0xFFFFFF` 都表示**未指定**，用主题前景色。
 *
 * 为什么把白色也算未指定：上游给普通弹幕的颜色就是 `16777215`（白）。界面里它只作用于
 * **正文**（人名不吃它），而浅色主题的前景是深色、背景是白的——照搬白色等于把正文写没。
 * 真正的彩色弹幕（付费色）照原样上色。
 */
export function cssColor(value: number): string | undefined {
  // `!(value > 0)` 同时盖住 0 与 NaN（上游字段缺失时可能给进来一个非数字）
  if (!(value > 0) || value >= 0xffffff) return undefined;
  return `#${value.toString(16).padStart(6, "0")}`;
}
