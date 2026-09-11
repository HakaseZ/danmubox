import {
  alertsOn,
  badgesFor,
  cssColor,
  formatClock,
  GUARD_TITLE,
  type DisplayRow,
} from "../filtering";
import type { Message, Prefs } from "../types";
import styles from "../app.module.css";

interface Props {
  row: DisplayRow;
  anchorUid?: number;
  prefs: Prefs;
}

/** 六种 kind 的渲染规范见 docs/ui.md §6.1；互动与系统行的文案由展示层生成。 */
export function MessageRow({ row, anchorUid, prefs }: Props) {
  const { message, count } = row;
  const badges = badgesFor(message, anchorUid);
  const color = cssColor(message.color);
  const highlight = alertsOn(message, prefs) ? styles.highlight : undefined;

  const kindClass: Record<Message["kind"], string | undefined> = {
    danmaku: undefined,
    gift: styles.kindGift,
    superchat: styles.kindSuperchat,
    guard: styles.kindGuard,
    interact: styles.kindInteract,
    system: styles.kindSystem,
  };

  const text =
    message.content.length > 0
      ? message.content
      : message.kind === "interact"
        ? `${message.uname || "有人"} 进入直播间`
        : "";

  return (
    <div className={`${styles.row} ${kindClass[message.kind] ?? ""}`}>
      <span className={styles.meta}>{formatClock(message.ts)}</span>
      {message.kind !== "system" && (
        <span className={styles.badges}>
          {badges.anchor && (
            <span className={`${styles.badge} ${styles.badgeAnchor}`}>主播</span>
          )}
          {badges.admin && (
            <span className={`${styles.badge} ${styles.badgeAdmin}`}>房管</span>
          )}
          {badges.guardLevel > 0 && (
            <span className={`${styles.badge} ${styles.badgeGuard}`}>
              {GUARD_TITLE[badges.guardLevel] ?? `Guard${badges.guardLevel}`}
            </span>
          )}
          {badges.medalLevel > 0 && badges.medalName.length > 0 && (
            <span className={`${styles.badge} ${styles.badgeMedal}`}>
              {badges.medalName} {badges.medalLevel}
            </span>
          )}
        </span>
      )}
      {message.kind !== "system" && message.uname.length > 0 && (
        <span className={styles.meta} style={color ? { color } : undefined}>
          {message.uname}:
        </span>
      )}
      <span className={`${styles.content} ${highlight ?? ""}`}>{text}</span>
      {count > 1 && <span className={styles.merged}>×{count}</span>}
    </div>
  );
}
