import { Avatar } from "./Avatar";
import type { MenuPoint } from "./ContextMenu";
import {
  alertsOn,
  badgesFor,
  formatClock,
  GUARD_TITLE,
  medalColors,
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
  const medal = medalColors(message);
  // 正文统一用主题前景色：上游允许发送者自定义弹幕颜色（舰长/老爷常见金黄），
  // 用户 2026-09-12 要求「所有文本统一一下」，因此不再照色渲染。
  const highlight = alertsOn(message, prefs) ? styles.highlight : undefined;
  // 被 @ 的名字用上游给的颜色（与粉丝牌真彩色同一口径：空串不是颜色，缺失就不上色）
  const replyNameColor =
    message.reply_uname_color !== undefined && message.reply_uname_color.length > 0
      ? message.reply_uname_color
      : undefined;
  // 一枚徽标都没有时不渲染空徽标组：空的 flex 项会白吃掉簇内的一道间距
  const hasBadges =
    badges.anchor ||
    badges.admin ||
    badges.guardLevel > 0 ||
    (badges.medalLevel > 0 && badges.medalName.length > 0);

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
        // 头像列永远占位：没有头像（face 为空串）时不画假图，但列宽照留，
        // 否则这一行的身份簇 / 正文会整体左移，逐行对不齐（issue #8）。
        // 它钉在**首行盒**上（高度 = 行盒高、内部居中），不随折行掉到行的中间。
        <span className={styles.avatarCol} data-testid="db-msg-avatar-col">
          <Avatar url={message.face} name={message.uname} />
        </span>
      )}
      {/* 正文块：身份簇与正文是它的**同一个网格的两列**——两列都从首行盒顶起算，
          于是共用同一条基线；正文只在第 2 列里折行，折行后每一行都与首行文字左对齐
          （悬挂缩进），不会回到头像下面。为什么不用 `align-items: baseline`：
          见 app.module.css `.row` 上的注释（块级大表情会让身份簇跳到图片底边）。 */}
      <span className={styles.text}>
        {message.kind !== "system" && (hasBadges || message.uname.length > 0) && (
          // 身份簇：徽标组 + 昵称 + 回复标记**是一个整体**——身份属于人名，不是独立一栏。
          // 簇内只用一种间距（--sp-1），簇与正文之间才用另一种（--sp-2）。
          <span className={styles.identity} data-testid="db-msg-identity">
            {hasBadges && (
              <span className={styles.badges} data-testid="db-msg-badges">
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
                      // 牌面配色优先用上游真彩色（契约 §5）；空串不是颜色，缺失时
                      // medalColors 已回退到按牌名派生的色相（docs/ui.md §4.2）。
                      backgroundImage: `linear-gradient(45deg, ${medal.start}, ${medal.end})`,
                      ...(medal.border ? { borderColor: medal.border } : null),
                      ...(medal.text ? { color: medal.text } : null),
                    }}
                  >
                    <span className={styles.medalName}>{badges.medalName}</span>
                    <span className={styles.medalLevel}>{badges.medalLevel}</span>
                  </span>
                )}
              </span>
            )}
            {message.uname.length > 0 && (
              // 昵称**不吃**弹幕自身颜色：那是正文的颜色，套到人名的后果是普通弹幕
              // （上游给 16777215 白色）在浅色主题下与背景同色、整条人名看不见（用户实测）。
              <span className={styles.name} data-testid="db-msg-name">
                {message.uname}:
              </span>
            )}
            {message.reply_to_uid !== 0 && message.reply_to_uname.length > 0 && (
              // 「回复了谁」看得到（用户 #13b）：显示在被回复者该出现的位置——昵称之后、正文之前。
              // 这一格同时是「纯 @ 某人」的槽位：两种形态只差文案与层级，不各开一列；
              // 收包侧的 `reply_type_enum` / `show_reply` 还没进契约，所以此刻只有「回复」这一种形态。
              // 长昵称按 `.replyTo` 截断，完整名字在 title 里。
              <span
                className={styles.replyTo}
                data-testid="db-msg-reply"
                title={`回复 @${message.reply_to_uname}`}
              >
                回复{" "}
                {/* 被 @ 的名字单独一格：上游给了颜色就上色（实测 #FB7299），没给就沿用标记的弱化色 */}
                <span
                  data-testid="db-msg-reply-name"
                  style={replyNameColor ? { color: replyNameColor } : undefined}
                >
                  @{message.reply_to_uname}
                </span>
              </span>
            )}
          </span>
        )}
        {/* 正文：文字与表情图**同一个行盒**——表情不另起一列、不另站一个基线。
            正文统一用主题前景色：上游允许发送者自定义弹幕颜色（舰长/老爷常见金黄），
            用户 2026-09-12 要求「所有文本统一一下」，因此不再照色渲染。
            大表情（bulge）尺寸太大，由 `.contentEmoteBulge` 单独占一行。 */}
        <span className={styles.content} data-testid="db-msg-body">
          {message.emote ? (
            // 表情弹幕：正文就是表情名，只显示文字会让人以为「表情没渲染」，
            // 因此改画图（标题与 alt 都保留表情名——图加载不出来时浏览器回退显示 alt）。
            // 尺寸走 `--emote`（从行盒派生），随 `ui.font_scale` 联动（docs/ui.md §4.1）。
            <img
              className={`${styles.contentEmote} ${
                message.emote.bulge_display ? styles.contentEmoteBulge : ""
              } ${highlight ?? ""}`}
              src={message.emote.url}
              alt={message.content}
              title={message.content}
            />
          ) : (
            <span className={highlight}>{text}</span>
          )}
          {/* 礼物行始终显示数量（连击聚合后的次数）；其余类型只在合并时显示。
              它是正文里的**行内**一格：跟在最后一行文字后面，不另占一行。 */}
          {(count > 1 || message.kind === "gift") && (
            <span className={styles.merged}>×{count}</span>
          )}
        </span>
      </span>
    </div>
  );
}
