import { Avatar } from "./Avatar";
import type { MenuPoint } from "./ContextMenu";
import type { ReactNode } from "react";
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

/** 正文里的 @昵称（用户 2026-09-13 第 1 条）：`@` 之后到空白或句读为止都算名字
    （昵称里不会有空格）。命中的那一段由 `.mention` 就地强调 —— 配色取 `--mention`
    （正文里的**醒目可读色**，不是身份牌那枚彩底白字，见 app.module.css 令牌段）。 */
const MENTION_RE = /@[^\s@,，。、:：;；!！?？.．"“”'‘’()（）[\]【】<>《》]+/g;

/** 把正文按 `@昵称` 切成「普通文字 / 强调片段」两族，其余字符原样保留。 */
function withMentions(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const at = match.index ?? 0;
    if (at > end) nodes.push(text.slice(end, at));
    nodes.push(
      <span key={at} className={styles.mention} data-testid="db-msg-mention">
        {match[0]}
      </span>,
    );
    end = at + match[0].length;
  }
  if (end < text.length) nodes.push(text.slice(end));
  return nodes;
}

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
      {/* 正文块 = **上下两行**（参考图口径，用户 2026-09-13）：第一行身份
          （用户名 + 身份牌），第二行正文。两块都是块级，所以正文必然落在自己的行上、
          左起点与用户名对齐（悬挂缩进），并且拿到**整行宽度**——旧版是「身份簇 ｜ 正文」
          左右两列，窄屏 360 下正文只有 112–165px（占视口 46%），长文本自然折得又窄又碎。
          身份行内只用 --sp-1（贴）；与正文的「分」由换行本身给出，不再有 --sp-2 外边距。 */}
      <span className={styles.text}>
        {message.kind !== "system" && (hasBadges || message.uname.length > 0) && (
          // 身份行：昵称 + 身份牌**是一个整体**（都属于「谁在说话」）。
          // 牌在昵称**右边**（参考图：蓝底白字的房间牌跟在用户名后面）。
          // 「回复了谁」不再另起一格（用户 2026-09-13 第 1 条：与正文里自带的 @ 重复）——
          // 身份行的最后那一枚「回复 @某人」的牌子已删，@ 改在**正文里**就地强调（见 withMentions）。
          <span className={styles.identity} data-testid="db-msg-identity">
            {message.uname.length > 0 && (
              // 昵称**不吃**弹幕自身颜色：那是正文的颜色，套到人名的后果是普通弹幕
              // （上游给 16777215 白色）在浅色主题下与背景同色、整条人名看不见（用户实测）。
              <span className={styles.name} data-testid="db-msg-name">
                {message.uname}:
              </span>
            )}
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
          </span>
        )}
        {/* 正文：文字与表情图**同一个行盒**——表情不另起一列、不另站一个基线。
            正文统一用主题前景色：上游允许发送者自定义弹幕颜色（舰长/老爷常见金黄），
            用户 2026-09-12 要求「所有文本统一一下」，因此不再照色渲染。
            正文里的 @昵称 就地强调（用户 2026-09-13 第 1 条），其余文字原样。
            大表情（bulge）尺寸太大，由 `.contentEmoteBulge` 单独占一行；
            通用表情（原图 200×60 的横条）走 `.contentEmoteWide` 的宽盒，见那条注释。 */}
        <span className={styles.content} data-testid="db-msg-body">
          {message.emote ? (
            // 表情弹幕：正文就是表情名，只显示文字会让人以为「表情没渲染」，
            // 因此改画图（标题与 alt 都保留表情名——图加载不出来时浏览器回退显示 alt）。
            // 尺寸走 `--emote`（从行盒派生），随 `ui.font_scale` 联动（docs/ui.md §4.1）。
            <img
              className={`${styles.contentEmote} ${
                message.emote.bulge_display
                  ? styles.contentEmoteBulge
                  : message.emote.width >= message.emote.height * 2
                    ? styles.contentEmoteWide
                    : ""
              } ${highlight ?? ""}`}
              src={message.emote.url}
              alt={message.content}
              title={message.content}
            />
          ) : (
            <span className={highlight}>{withMentions(text)}</span>
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
