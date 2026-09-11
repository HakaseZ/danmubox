// 显示层的纯逻辑：过滤、合并相似、徽标派生、时间格式化。
// 这些规则来自 docs/ui.md 与 docs/contract.md §8 的偏好键，放这里便于单测。

import type { Message, Prefs } from "./types";

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

/** 过滤规则（docs/ui.md §4.2 的求值顺序：类型 → 粉丝牌 → 用户 → 关键词）。 */
export function passesFilter(message: Message, prefs: Prefs): boolean {
  if (prefs["filter.kinds"].length > 0 && !prefs["filter.kinds"].includes(message.kind)) {
    return false;
  }
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

export interface DisplayRow {
  message: Message;
  /** 合并了几条（1 表示未合并）。 */
  count: number;
}

/**
 * 过滤 + 合并相似消息。合并规则：同一 uid、同一内容、且在 `ui.merge_window_ms`
 * 窗口内连续出现的消息合成一行，`count` 记录条数（docs/ui.md §4.5）。
 */
export function toDisplayRows(messages: Message[], prefs: Prefs): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const mergeEnabled = prefs["ui.merge_similar"];
  const windowMs = prefs["ui.merge_window_ms"];

  for (const message of messages) {
    if (!passesFilter(message, prefs)) continue;

    const last = rows[rows.length - 1];
    const mergeable =
      mergeEnabled &&
      message.kind === "danmaku" &&
      last !== undefined &&
      last.message.kind === "danmaku" &&
      last.message.uid === message.uid &&
      last.message.content === message.content &&
      message.ts - last.message.ts <= windowMs;

    if (mergeable) {
      last.count += 1;
      last.message = message;
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
