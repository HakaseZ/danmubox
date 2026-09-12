// 显示层的纯逻辑：过滤、合并相似、徽标派生、时间格式化。
// 这些规则来自 docs/ui.md 与 docs/contract.md §8 的偏好键，放这里便于单测。

import type { Emote, Message, Prefs } from "./types";

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

/** 弹幕颜色是十进制 RGB；0 表示未指定，用默认前景色。 */
export function cssColor(value: number): string | undefined {
  if (!value || value <= 0 || value > 0xffffff) return undefined;
  return `#${value.toString(16).padStart(6, "0")}`;
}
