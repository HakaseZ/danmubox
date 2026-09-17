import { Avatar } from "./Avatar";
import type { MenuPoint } from "./ContextMenu";
import type { ReactNode } from "react";
import {
  amountText,
  badgesFor,
  formatClock,
  GUARD_TITLE,
  medalColors,
  superChatTier,
  type DisplayRow,
} from "../filtering";
import type { Message, Prefs } from "../types";
import { INTERACT_AUTO_HIDE_MS, SEND_STATE_TEXT } from "../types";
import styles from "../app.module.css";

/** 正文里的 @昵称（用户 2026-09-13 第 1 条）：`@` 之后到空白或句读为止都算名字
    （昵称里不会有空格）。命中的那一段由 `.mention` 就地强调 —— 配色取 `--mention`
    （正文里的**醒目可读色**，不是身份牌那枚彩底白字，见 app.module.css 令牌段）。 */
const MENTION_RE = /@[^\s@,，。、:：;；!！?？.．"“”'‘’()（）[\]【】<>《》]+/g;

/** 把正文按 `@昵称` 切成「普通文字 / 强调片段」两族，其余字符原样保留。
    `testId` 由调用方给（`db-msg-mention` / `db-gift-mention`，见 `Props.scope`）。 */
function withMentions(text: string, testId: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(MENTION_RE)) {
    const at = match.index ?? 0;
    if (at > end) nodes.push(text.slice(end, at));
    nodes.push(
      <span key={at} className={styles.mention} data-testid={testId}>
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
  /**
   * 这一行渲染在**哪一处**（docs/ui.md §5.3）：弹幕区（`msg`）还是独立礼物栏（`gift`）。
   *
   * 两处**共用这一个组件**（用户 2026-09-16 第 2 条：「礼物区域的显示和弹幕区直接保持一致」），
   * scope 只做两件事：把行内的 `data-testid` 分成 `db-msg-*` / `db-gift-*` 两族（否则
   * 「弹幕流里还有没有这条」的断言会被礼物栏那一份蒙混过去），以及下面那条金额行的开关。
   */
  scope: "msg" | "gift";
  /**
   * 礼物 / 大航海行**额外画一行金额**（`db-gift-amount`）：只有独立礼物栏为真。
   *
   * 依据：弹幕流里这三类**不画金额**（§4.1：行内的 `×N` 与金额挤在一起不好读，金额在礼物栏里
   * 按「`<金额> 元`」呈现）；礼物栏那一份因此保留金额，而 SC 两处都画 —— 金额行本来就是 SC
   * 卡片规格的一部分（`.scAmount`）。
   */
  showGiftAmount?: boolean;
}

/** 行内各格的 `data-testid` 前缀（两族分得开，见 `Props.scope`）。 */
const testIdFor = (scope: "msg" | "gift") => (part: string) => `db-${scope}-${part}`;

/** 六种 kind 的渲染规范见 docs/ui.md §4.1；互动与系统行的文案由展示层生成。 */
export function MessageRow({
  row,
  anchorUid,
  prefs,
  onMenu,
  scope,
  showGiftAmount = false,
}: Props) {
  const t = testIdFor(scope);
  const { message, count } = row;
  const badges = badgesFor(message, anchorUid);
  const medal = medalColors(message);
  // 正文统一用主题前景色：上游允许发送者自定义弹幕颜色（舰长/老爷常见金黄），
  // 用户 2026-09-12 要求「所有文本统一一下」，因此不再照色渲染。
  // 一枚徽标都没有时不渲染空徽标组：空的 flex 项会白吃掉簇内的一道间距
  const hasBadges =
    badges.anchor ||
    badges.admin ||
    badges.guardLevel > 0 ||
    (badges.medalLevel > 0 && badges.medalName.length > 0);
  // 有没有身份行：系统行不画，昵称与徽标都空的也不画（空盒会白吃一道间距）。
  // 时间戳要落在这两族行的**同一个纵向位置**上，所以这里统一算一次给两处用。
  const hasIdentity =
    message.kind !== "system" && (hasBadges || message.uname.length > 0);

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

  // 互动/进场消息：默认显示一会儿就淡出，到点这一行**不再被画**（`filtering.interactAutoHidden`，
  // 判据 `ts + INTERACT_AUTO_HIDE_MS`）—— 消息仍在会话缓冲里，关掉 `ui.interact_auto_hide`
  // 就原样回来（issue 2609171849 第 5 条，见 docs/ui.md §4.8）。
  const autoHide = message.kind === "interact" && prefs["ui.interact_auto_hide"];

  // 本地乐观行**不加任何待确认视觉**（用户 2026-09-13 的更正：「发出去就是和已发送一样的状态，
  // 上游返回的数据只做校验」）：插入时不带 `send_state`，因此这一行与「别的客户端看到的我」
  // 渲染逐项相同。标记只在**发送没成**时出现（整行不弱化，要读得清）：被拒的那条还要把正文
  // 划掉并写出上游给的原因（用户 2026-09-13：留着便于对照修改）。
  const rejected = message.send_state === "rejected";
  // 醒目留言按金额取档（`--sc-1 … --sc-5`）：卡片背景与边框都取自那一枚令牌，
  // 档位边界是**本地**取值（依据见 filtering.superChatTier 与 docs/ui.md §4.1）。
  // 金额格按 §4.1 的规格：低一档加粗；上游没给价（amount = 0）时**不画**这一格。
  const scTier = message.kind === "superchat" ? superChatTier(message.amount) : 0;
  const scAmount = message.kind === "superchat" ? amountText(message.amount, "superchat") : "";
  // 礼物 / 大航海的金额行：**只有礼物栏那一份**画（`showGiftAmount`，见 Props 的说明）；
  // 与 SC 那一格同一个规格（`.scAmount`：独占一行、低一档加粗），两处的金额因此一个样子。
  const giftAmount =
    showGiftAmount && (message.kind === "gift" || message.kind === "guard")
      ? amountText(message.amount, message.kind)
      : "";
  const variant = [
    kindClass[message.kind] ?? "",
    autoHide ? styles.autoHide : "",
    scTier > 0 ? styles.scCard : "",
    scTier > 0 ? styles[`scTier${scTier}`] : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`${styles.row} ${variant}`}
      data-testid={t("row")}
      data-sc-tier={scTier > 0 ? scTier : undefined}
      style={autoHide ? { animationDuration: `${INTERACT_AUTO_HIDE_MS}ms` } : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(message, { x: event.clientX, y: event.clientY });
      }}
    >
      {/* 时间戳（用户 2026-09-14：「时间戳显示时放在最右边」）：**不再占行首一列**，
          位置改到身份行的右端，见下面 `.text` 里那两处渲染；没有身份行的行走
          「只有时间」的首行。开关仍是 `ui.show_timestamp`（默认关闭）。 */}
      {message.kind !== "system" && (
        // 头像列永远占位：没有头像（face 为空串）时不画假图，但列宽照留，
        // 否则这一行的身份簇 / 正文会整体左移，逐行对不齐（issue #8）。
        // 它钉在**首行盒**上（高度 = 行盒高、内部居中），不随折行掉到行的中间。
        <span className={styles.avatarCol} data-testid={t("avatar-col")}>
          <Avatar url={message.face} name={message.uname} testId={t("avatar")} />
        </span>
      )}
      {/* 正文块 = **上下两行**（参考图口径，用户 2026-09-13）：第一行身份
          （用户名 + 身份牌，**右端是时间戳**），第二行正文。两块都是块级，所以正文必然落在自己的行上、
          左起点与用户名对齐（悬挂缩进），并且拿到**整行宽度**——旧版是「身份簇 ｜ 正文」
          左右两列，窄屏 360 下正文只有 112–165px（占视口 46%），长文本自然折得又窄又碎。
          身份行内只用 --sp-1（贴）；与正文的「分」由换行本身给出，不再有 --sp-2 外边距。 */}
      <span className={styles.text}>
        {hasIdentity ? (
          // 身份行：昵称 + 身份牌**是一个整体**（都属于「谁在说话」）。
          // 牌在昵称**右边**（参考图：蓝底白字的房间牌跟在用户名后面）。
          // 「回复了谁」不再另起一格（用户 2026-09-13 第 1 条：与正文里自带的 @ 重复）——
          // 身份行的最后那一枚「回复 @某人」的牌子已删，@ 改在**正文里**就地强调（见 withMentions）。
          <span className={styles.identity} data-testid={t("identity")}>
            {message.uname.length > 0 && (
              // 昵称**不吃**弹幕自身颜色：那是正文的颜色，套到人名的后果是普通弹幕
              // （上游给 16777215 白色）在浅色主题下与背景同色、整条人名看不见（用户实测）。
              <span className={styles.name} data-testid={t("name")}>
                {message.uname}:
              </span>
            )}
            {hasBadges && (
              <span className={styles.badges} data-testid={t("badges")}>
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
            {/* 时间戳：身份行的**最后一格**、靠右（`margin-left: auto`，见 `.time`）——
                用户 2026-09-14：「时间戳显示时放在最右边」。它是定宽的一格，所以逐行的
                右边缘相同（用户 2026-09-12「时间要对齐」）；`flex: none` 保证昵称 + 牌
                再长也压不扁它（超出的部分由可收缩的昵称省略号吸收）。 */}
            {prefs["ui.show_timestamp"] && (
              <span className={styles.time} data-testid={t("time")}>
                {formatClock(message.ts)}
              </span>
            )}
          </span>
        ) : (
          // 没有身份行的行（`kind === "system"`、或既无昵称又无徽标）：时间**独占正文块的
          // 首行**、同样靠右 —— 不因为缺身份行就把时间丢掉；正文仍从下一行、左边缘起点开始。
          prefs["ui.show_timestamp"] && (
            <span className={`${styles.timeLine} ${styles.time}`} data-testid={t("time")}>
              {formatClock(message.ts)}
            </span>
          )
        )}
        {/* 正文：文字与表情图**同一个行盒**——表情不另起一列、不另站一个基线。
            正文统一用主题前景色：上游允许发送者自定义弹幕颜色（舰长/老爷常见金黄），
            用户 2026-09-12 要求「所有文本统一一下」，因此不再照色渲染。
            正文里的 @昵称 就地强调（用户 2026-09-13 第 1 条），其余文字原样。
            大表情（bulge）尺寸太大，由 `.contentEmoteBulge` 单独占一行；
            通用表情（原图 200×60 的横条）走 `.contentEmoteWide` 的宽盒，见那条注释。 */}
        <span className={styles.content} data-testid={t("body")}>
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
              }`}
              src={message.emote.url}
              alt={message.content}
              title={message.content}
            />
          ) : (
            <span className={rejected ? styles.rejectedText : undefined}>
              {withMentions(text, t("mention"))}
            </span>
          )}
          {/* 礼物行始终显示数量（连击折叠后的次数）；其余类型不再有 ×N ——
              「相似消息合并」已整条删除（P49），count > 1 只可能来自礼物连击。
              它是正文里的**行内**一格：跟在最后一行文字后面，不另占一行。 */}
          {(count > 1 || message.kind === "gift") && (
            <span className={styles.merged} data-testid={t("count")}>
              ×{count}
            </span>
          )}
          {message.send_state !== undefined && (
            // 发送没成的标记（乐观渲染，用户 2026-09-13）：正常行（刚插入还在等回执的本地行、
            // 上游回播换进来的那条）不带这个字段，因此不渲染任何标记。与合并计数一样是正文里的
            // **行内**一格；整行不弱化（要读得清）。被拒的那条写**上游给的原因**（与浮片同一句，
            // 见 `sendOutcomeText`），「未确认」那档只说明我们没等到回声。
            <span
              className={styles.sendState}
              data-testid={t("send-state")}
              data-state={message.send_state}
            >
              {message.send_reason ?? SEND_STATE_TEXT[message.send_state]}
            </span>
          )}
        </span>
        {/* 醒目留言的金额行（§4.1 规格）：卡片内**独占一行**、低一档加粗。
            单位是元 —— 与礼物栏同一口径（2026-09-16 统一）：`amountText` 对 SC 用原值、
            对礼物 / 大航海按契约 §5 的 `元 = 金瓜子 / 1000` 换算，两处印的都是元。 */}
        {scAmount.length > 0 && (
          <span className={styles.scAmount} data-testid={t("sc-amount")}>
            {scAmount}
          </span>
        )}
        {/* 礼物 / 大航海的金额行：与上面 SC 那一格同一个规格（`.scAmount`），只在礼物栏那一份画
            （`showGiftAmount`）—— 弹幕流里这两类不画金额，见 §4.1 与 Props 的说明。 */}
        {giftAmount.length > 0 && (
          <span className={styles.scAmount} data-testid={t("amount")}>
            {giftAmount}
          </span>
        )}
      </span>
    </div>
  );
}
