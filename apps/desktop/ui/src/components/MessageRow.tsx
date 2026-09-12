import { Avatar } from "./Avatar";
import type { MenuPoint } from "./ContextMenu";
import {
  alertsOn,
  badgesFor,
  cssColor,
  formatClock,
  GUARD_TITLE,
  medalHue,
  type DisplayRow,
} from "../filtering";
import type { Message, Prefs } from "../types";
import { INTERACT_AUTO_HIDE_MS } from "../types";
import styles from "../app.module.css";

interface Props {
  row: DisplayRow;
  anchorUid?: number;
  prefs: Prefs;
  /** 右键（或行尾「⋯」）时把坐标与消息交给上层弹菜单（docs/ui.md §4.5）。 */
  onMenu: (message: Message, at: MenuPoint) => void;
}

/** 六种 kind 的渲染规范见 docs/ui.md §4.1；互动与系统行的文案由展示层生成。 */
export function MessageRow({ row, anchorUid, prefs, onMenu }: Props) {
  const { message, count } = row;
  const badges = badgesFor(message, anchorUid);
  const hue = medalHue(badges.medalName);
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

  // 互动/进场消息：默认显示一会儿就淡出（store 到点摘除，见 store.scheduleInteractHide）；
  // 关掉 `ui.interact_auto_hide` 则常驻。
  const autoHide = message.kind === "interact" && prefs["ui.interact_auto_hide"];

  const variant = [
    kindClass[message.kind] ?? "",
    autoHide ? styles.autoHide : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`${styles.row} ${variant}`}
      data-testid="db-msg-row"
      style={autoHide ? { animationDuration: `${INTERACT_AUTO_HIDE_MS}ms` } : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(message, { x: event.clientX, y: event.clientY });
      }}
    >
      {/* 时间戳列：开关见 `ui.show_timestamp`；固定宽度 + tabular-nums，保证逐行纵向对齐 */}
      {prefs["ui.show_timestamp"] && (
        <span className={styles.time} data-testid="db-msg-time">
          {formatClock(message.ts)}
        </span>
      )}
      {message.kind !== "system" && (
        <Avatar url={message.face} name={message.uname} />
      )}
      {message.kind !== "system" && (
        <span className={styles.badges}>
          {badges.anchor && (
            <span className={`${styles.badge} ${styles.badgeAnchor}`}>主播</span>
          )}
          {badges.admin && (
            <span className={`${styles.badge} ${styles.badgeAdmin}`}>房管</span>
          )}
          {badges.guardLevel > 0 && (
            <span
              className={`${styles.badge} ${
                styles[`badgeGuard${badges.guardLevel}`] ?? styles.badgeGuard
              }`}
            >
              {GUARD_TITLE[badges.guardLevel] ?? `Guard${badges.guardLevel}`}
            </span>
          )}
          {badges.medalLevel > 0 && badges.medalName.length > 0 && (
            <span
              className={`${styles.badge} ${styles.badgeMedal}`}
              style={{
                // 牌面底色按牌名派生（见 filtering.medalHue）：上游真彩色未进契约
                backgroundImage: `linear-gradient(45deg, hsl(${hue} 32% 50%), hsl(${hue} 34% 66%))`,
              }}
            >
              <span className={styles.medalName}>{badges.medalName}</span>
              <span className={styles.medalLevel}>{badges.medalLevel}</span>
            </span>
          )}
        </span>
      )}
      {message.kind !== "system" && message.uname.length > 0 && (
        <span className={styles.name} style={color ? { color } : undefined}>
          {message.uname}:
        </span>
      )}
      {message.emote ? (
        // 表情弹幕：正文就是表情名，只显示文字会让人以为「表情没渲染」，
        // 因此改画图（标题与 alt 都保留表情名——图加载不出来时浏览器回退显示 alt）。
        // 尺寸用 em，随 `ui.font_scale` 联动（docs/ui.md §4.1）。
        <img
          className={`${styles.contentEmote} ${
            message.emote.bulge_display ? styles.contentEmoteBulge : ""
          } ${highlight ?? ""}`}
          src={message.emote.url}
          alt={message.content}
          title={message.content}
        />
      ) : (
        <span className={`${styles.content} ${highlight ?? ""}`}>{text}</span>
      )}
      {/* 礼物行始终显示数量（连击聚合后的次数）；其余类型只在合并时显示 */}
      {(count > 1 || message.kind === "gift") && (
        <span className={styles.merged}>×{count}</span>
      )}
      {/* 行内不再挂一排按钮（issue #8）：动作收进右键菜单，这里只留一个可点的入口 */}
      <button
        className={styles.rowMenuTrigger}
        title="更多操作（复制 / @ / 回复 / 举报）"
        aria-label="更多操作"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu(message, { x: rect.left, y: rect.bottom + 2 });
        }}
      >
        ⋯
      </button>
    </div>
  );
}
