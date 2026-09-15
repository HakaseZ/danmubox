import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ContextMenu, type MenuItem, type MenuPoint } from "./ContextMenu";
import { FilterBar } from "./FilterBar";
import { isSystemBackGestureZone } from "../back";
import {
  EMOTE_PACKAGE_LABEL,
  sendOutcomeText,
  SEND_TOAST_MS,
  type Emote,
  type EmotePackage,
  type Message,
  type Prefs,
  type EmoteToken,
  type ReplyTarget,
  type SendOutcome,
} from "../types";
import styles from "../app.module.css";

/** 输入区上方三个弹出面板：同时只开一个，向上展开（issue #8）。
 *  状态**归 `RoomView`**（issue 2609132259 #4：与房管面板 / 独立礼物栏一起互斥，同时最多开一个），
 *  `Composer` 只收受控的 `panel` 与 `onPanel`。 */
export type PanelKind = "emotes" | "phrases" | "filter";

/** 草稿按「身份 × 房间」各留一份：正文、回复目标、@ 目标三者同属一份草稿（契约 C1）。 */
interface ComposerDraft {
  text: string;
  replyTo: Message | null;
  mention: { mid: number; uname: string } | null;
}

/**
 * 每个「身份 × 房间」各留一份草稿，键是 `${identityKey}:${roomId}`（用户 item 2 / item 4）。
 *
 * 放在**模块级**而不是 store：草稿是纯界面状态（契约 §8 没有对应的偏好键），也不该落盘；
 * 切号的隔离由键里的身份段天然给出——换了身份就换了键，新身份从空草稿开始，
 * 切回原身份仍能看到自己原来那份。
 */
const composerDrafts = new Map<string, ComposerDraft>();

/**
 * 上游没给弹幕上限时的回落值，照官方前端（产物里 `t.danmu_length || 20`，见 `docs/protocol.md` A44）。
 * 只在 `RoomSession.danmaku_length` 还没取到（0 / 未下发）时兜底，不在别处重复这个数字。
 */
const DEFAULT_DANMAKU_LENGTH = 20;

/**
 * 草稿**开头**那段 `@昵称 ` 的长度（没有就是 0）。
 *
 * 官方把 at 前缀算在弹幕上限之外（`inputLengthLimit = danmakuLengthLimit + tempAtUserName.length`），
 * 因此「在开头 @ 了某人」时实际能打的字数要多出这一截。
 */
function atPrefixLength(text: string, uname: string | null | undefined): number {
  if (uname === null || uname === undefined || uname.length === 0) return 0;
  const token = `@${uname} `;
  return text.startsWith(token) ? token.length : 0;
}

interface Props {
  /** 当前房间号：草稿按「身份 × 房间」分键时用它（item 2）。 */
  roomId: number;
  /** 当前身份键（游客 `"guest"`、登录为 uid 字符串）：切号即换键，草稿不串号（item 4）。 */
  identityKey: string;
  /** 本房间的弹幕字数上限（`RoomSession.danmaku_length`）；未取到按官方缺省 20（item 12）。 */
  danmakuLength?: number;
  disabled: boolean;
  loggedIn: boolean;
  lastOutcome?: SendOutcome;
  lastDetail?: string | null;
  emotes: Emote[];
  /** 主站「我的表情」（`emotes_owned`）：与接口给的按房间包同侧，排在「通用」之后。 */
  ownedEmotes: Emote[];
  /** 「我的表情」上次拉取失败的原因；面板里显示并提供重试（不阻塞输入框）。 */
  ownedError?: string;
  /** 电池余额（`wallet_balance`）：显示在**发送按钮左侧**（用户 2026-09-13）。 */
  balance?: number;
  /** 点数值手动刷新余额（docs/ui.md §6.4）。 */
  onRefreshBalance: () => void;
  /** 行菜单里点的 @ / 回复，点一次应用一次（token 变则重放）。 */
  pendingAction?: { kind: "mention" | "reply"; message: Message; token: number } | null;
  /** 展开中的面板（受控，见 `PanelKind`）：`null` = 都收起。 */
  panel: PanelKind | null;
  /** 请求把面板切到某个 / 收起（`null`）：互斥与互斥带来的副作用都在 `RoomView` 一处收口。 */
  onPanel: (panel: PanelKind | null) => void;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  onSend: (
    content: string,
    emote?: EmoteToken,
    reply?: ReplyTarget,
  ) => Promise<SendOutcome | undefined>;
  /** 面板里「我的表情」加载失败后的重试入口。 */
  onRetryOwned: () => void;
  onNotice: (text: string) => void;
}

/** 表情分组展示顺序：接口给的包在前（通用 → 我的表情 → 本房间 → 粉丝牌 → 大航海）。 */
const PACKAGE_ORDER: EmotePackage[] = [
  "common",
  "owned",
  "room",
  "medal",
  "guard",
];

/** 表情网格（`role=tabpanel`）的 id：tab 的 `aria-controls` 与它的 `aria-labelledby` 靠它对上。 */
const EMOTE_PANEL_ID = "db-emote-panel";

/** 一个分组的 tab 的 id（同一个分组在 DOM 里只会有一个 tab）。 */
const emoteTabId = (kind: EmotePackage) => `db-emote-tab-${kind}`;

export function Composer({
  roomId,
  identityKey,
  danmakuLength,
  disabled,
  loggedIn,
  lastOutcome,
  lastDetail,
  emotes,
  ownedEmotes,
  ownedError,
  balance,
  onRefreshBalance,
  pendingAction,
  panel,
  onPanel,
  prefs,
  onPrefs,
  onSend,
  onRetryOwned,
  onNotice,
}: Props) {
  const [draft, setDraft] = useState("");
  // 回复某条弹幕时显示引用条；@ 某人只是把名字插进草稿，另记 uid 供发送时上报。
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mention, setMention] = useState<{ mid: number; uname: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // 表情分组 tab：null = 还没选过，显示第一组（顺序固定，见 PACKAGE_ORDER）。
  const [emoteTab, setEmoteTab] = useState<EmotePackage | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [newPhrase, setNewPhrase] = useState("");
  // 发送失败那条**浮动提示**（用户 2026-09-12：不要在**最下**出常驻提示，要「弹窗 + 渐隐」，
  // 而且整个过程不能挡住滚动的弹幕 —— 见 .toast 的 pointer-events 与它在文档流里的位置）。
  // 上限提示（item 12）走同一张浮片：`key` 每次自增，连着两次同文案也会重放动画（见 showToast）。
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const toastKeyRef = useRef(0);
  // 每一次发送落定都 +1：连续两次同样的失败因此会**重新弹一次**（挂在 outcome 字符串上不会重跑）。
  const [sendSeq, setSendSeq] = useState(0);
  // 短语的「改」：就地变成输入框（右键菜单里点「编辑」进入）。
  const [editingPhrase, setEditingPhrase] = useState<{ index: number; text: string } | null>(null);
  const [phraseMenu, setPhraseMenu] = useState<{ at: MenuPoint; index: number } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // 输入区这一块（含向上展开的面板）：用来判「点在外面就收起面板」（见下面的 pointerdown）。
  const composerRef = useRef<HTMLDivElement>(null);
  // 展开中的那个面板自身（表情 / 短语 / 筛选三选一，同时只有一个在 DOM 里）。
  const panelRef = useRef<HTMLDivElement>(null);

  /** 弹一张浮片（发送失败原因 / 字数上限提示共用）：`key` 变了才会重放渐隐动画。 */
  const showToast = (text: string) => {
    toastKeyRef.current += 1;
    setToast({ text, key: toastKeyRef.current });
  };

  // 草稿分键：**身份 + 房间**（契约 C1）。切房间或切号都换键 —— 换号不继承上一个身份的草稿（item 4）。
  const draftKey = `${identityKey}:${roomId}`;
  // 当前 state 里的草稿属于哪个键；`null` = 还没装载过（首次渲染）。
  const loadedDraftKeyRef = useRef<string | null>(null);

  // 切键时**先存旧键、再取新键**（契约 C1）：面板类状态（面板 / 分组 tab / 右键菜单 / 改短语 /
  // 浮片 / 「加一条」的输入）一律重置 —— 换房间不该带着上一个房间的面板；
  // 同一个键内的每一次编辑都立刻同步进 Map，组件卸载时最后几个字也不会丢。
  useEffect(() => {
    if (loadedDraftKeyRef.current !== draftKey) {
      if (loadedDraftKeyRef.current !== null) {
        composerDrafts.set(loadedDraftKeyRef.current, { text: draft, replyTo, mention });
      }
      const saved = composerDrafts.get(draftKey);
      setDraft(saved?.text ?? "");
      setReplyTo(saved?.replyTo ?? null);
      setMention(saved?.mention ?? null);
      loadedDraftKeyRef.current = draftKey;
      onPanel(null);
      setEmoteTab(null);
      setPhraseMenu(null);
      setEditingPhrase(null);
      setToast(null);
      setNewPhrase("");
      return;
    }
    composerDrafts.set(draftKey, { text: draft, replyTo, mention });
  }, [draftKey, draft, replyTo, mention, onPanel]);

  // 行菜单送来的动作：@ 与回复各应用一次（token 每次点击都变，不会自激）。
  useEffect(() => {
    if (!pendingAction) return;
    const { kind, message } = pendingAction;
    if (kind === "mention") {
      if (message.uname.length === 0) return;
      setMention({ mid: message.uid, uname: message.uname });
      setDraft((value) =>
        value.startsWith(`@${message.uname} `) ? value : `@${message.uname} ${value}`,
      );
    } else {
      setReplyTo(message);
    }
  }, [pendingAction]);

  useEffect(() => {
    // `sendSeq === 0` = 还没发过东西（可能是进房间带进来的旧结果）：不弹。
    if (sendSeq === 0) return;
    if (lastOutcome === undefined || lastOutcome === "ok") return;
    // 与那一行行尾的标记**同一句**（`sendOutcomeText`）：浮片与行上写的必须是同一件事。
    showToast(sendOutcomeText(lastOutcome, lastDetail));
  }, [sendSeq, lastOutcome, lastDetail]);

  // 渐隐是 CSS 动画（.toast），这里只负责在动画走完之后把元素摘掉 ——
  // 否则它会「透明地占着一块地方」，那正是用户不要的形态。
  // 文案与来源无关（发送失败 / 字数上限），因此挂在浮片自己身上，不挂在发送序号上。
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), SEND_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 面板顶上不再有「关闭」按钮（用户 2026-09-12：表情与关闭都不需要），
  // 关面板的入口因此是两条：① 再点一次那个工具按钮（togglePanel）；
  // ② 点输入区这一块**外面**的任何地方 —— 包括弹幕列表、别的面板入口。
  //
  // 「外面」的判据必须是**面板之外**，不是「输入区之外」（用户 2026-09-13 报的真 bug：
  // 「展开表情包面板后切换 tab，面板就自动关闭了」）。面板与输入区是**兄弟**节点
  // （面板在输入区上方、文档流里各占一块），只判 `composerRef` 就会把面板内部的按下
  // 当成外面：真鼠标点 tab 先发 `pointerdown` → 面板当场卸载 → tab 切不动。
  // 因此这里排除三块：输入区、展开中的面板、面板自己弹出来的右键菜单（短语的「改 / 删」）。
  useEffect(() => {
    if (panel === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target !== null && composerRef.current?.contains(target)) return;
      if (target !== null && panelRef.current?.contains(target)) return;
      // 面板里弹出的右键菜单也归面板：它的「编辑 / 删除」点下去时面板必须还在
      // （`pointerdown` 连右键一起收，菜单项不在面板 DOM 里，不排除就会被关掉）。
      if (target instanceof Element && target.closest('[data-testid="db-context-menu"]')) return;
      // 屏幕左右边缘那一条是**系统手势区**：从那里起手的返回手势会先把这个 DOWN 发给页面、
      // 再把整条流 CANCEL 收走。把它当「点在外面」就会在返回到达前先把面板关掉，
      // 于是面板那一级白设（见 back.ts 的 isSystemBackGestureZone）。
      if (isSystemBackGestureZone(event.clientX)) return;
      onPanel(null);
    };
    // 捕获阶段：先于被点元素的处理收起面板，避免「点了一下别人、面板还挂在上面」
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [panel, onPanel]);

  const customPhrases = prefs["composer.phrases"] ?? [];

  /**
   * 发送时的 @ 目标：**从草稿文本派生**，不额外保存一份「目标状态」。
   *
   * 否则就是用户 #13a 的情形：`@张三 ` 被从文本框里删掉之后目标仍然在，
   * 于是发出一条文本里看不见、上游却带 at 字段的弹幕。派生之后两者不可能不一致——
   * 文本里没有这个 token，就不带 `reply_mid` / `reply_uname`。
   *
   * 认两种写法：`@名字 `（插入时补的那个空格还在）与 `@名字` 收尾；只有前缀相同
   * （如 `@张三丰`）不算，避免把别人的 @ 认成这一个。
   */
  const mentionTarget = useMemo(() => {
    if (!mention) return null;
    const token = `@${mention.uname}`;
    return draft.includes(`${token} `) || draft.endsWith(token) ? mention : null;
  }, [mention, draft]);

  // 上游给的房间上限（`RoomSession.danmaku_length`）：`0` = 身份还没取到，按官方缺省 20 兜底 ——
  // 绝不能把 0 当成「一个字都不许发」（那时输入框会整个不能用）。
  const roomLengthLimit =
    danmakuLength !== undefined && danmakuLength > 0 ? danmakuLength : DEFAULT_DANMAKU_LENGTH;
  // 有效上限 = 房间上限 + 草稿开头的 `@昵称 ` 前缀（官方口径，见 atPrefixLength）；
  // 计数与截断都按 `String.length`（UTF-16 码元），与官方一致（实测 60 个汉字被截到 40）。
  const lengthLimit = roomLengthLimit + atPrefixLength(draft, mention?.uname);

  /**
   * 写入草稿的**唯一入口**：超有效上限即截断到上限并按官方文案提示（用户 item 12）。
   *
   * 截断发生在输入这一侧（而不是发送前）：用户要的是「在输入框限制 & 提示一下，
   * 免得发出去才发现超长了」，因此打字与粘贴都不越界，超出的部分当场被挡下。
   */
  const applyDraft = (next: string) => {
    const limit = roomLengthLimit + atPrefixLength(next, mention?.uname);
    if (next.length > limit) {
      setDraft(next.slice(0, limit));
      showToast(`最多输入 ${limit} 个字哦~`);
      return;
    }
    setDraft(next);
  };

  // 接口给的包（`emotes_list` 的按房间包 + 主站「我的表情」）是**唯一**的来源：
  // 面板分组与「将发送」预览都走这一份。同一个 `emoticon_unique` 只保留先来的那条
  // （顺序是 `emotes` 在前、`ownedEmotes` 在后，因此同名时接口包优先）。
  const panelEmotes = useMemo(() => {
    const known = new Set<string>();
    const out: Emote[] = [];
    for (const emote of [...emotes, ...ownedEmotes]) {
      if (known.has(emote.emoticon_unique)) continue;
      known.add(emote.emoticon_unique);
      out.push(emote);
    }
    return out;
  }, [emotes, ownedEmotes]);

  // 按来源分组展示（通用 / 我的表情 / 本房间 / 粉丝牌 / 大航海），见 docs/ui.md §6.3。
  // 面板里**没有搜索框**（用户 2026-09-12：「上方的搜索也没必要」）：分组就是唯一的浏览方式。
  const grouped = useMemo(() => {
    const groups: Record<EmotePackage, Emote[]> = {
      common: [],
      owned: [],
      room: [],
      medal: [],
      guard: [],
    };
    for (const emote of panelEmotes) {
      groups[emote.package_kind].push(emote);
    }
    return PACKAGE_ORDER.map((kind) => [kind, groups[kind]] as const).filter(
      ([, items]) => items.length > 0,
    );
  }, [panelEmotes]);

  // 当前 tab：选中的那一组还在就用它，否则回落到第一组（派生值，不留在 state 里）。
  const activeKind = grouped.some(([kind]) => kind === emoteTab)
    ? emoteTab
    : grouped[0]?.[0];
  const activeItems = grouped.find(([kind]) => kind === activeKind)?.[1] ?? [];

  /** 换分组：把**表情格**滚回顶部（面板头与轨道不滚，否则会停在上一个分组的滚动位置）。 */
  const selectEmoteTab = (kind: EmotePackage) => {
    setEmoteTab(kind);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  };

  /**
   * tab 轨道的键盘导航（WAI-ARIA tabs 口径）：roving tabindex —— 只有选中的那个 tab 可 Tab 到，
   * 进去之后 ↑↓ 换组、Home / End 跳到首尾，焦点跟着选中项走。
   *
   * 这套键盘行为是「它是个 tab 而不是一排按钮」的一部分：一排普通按钮要么全都可 Tab 到
   * （键盘用户要按 N 次才过得了这一排），要么全都不可达。
   */
  const onRailKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const kinds = grouped.map(([kind]) => kind);
    if (kinds.length === 0) return;
    const current = activeKind === null || activeKind === undefined
      ? 0
      : Math.max(0, kinds.indexOf(activeKind));
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % kinds.length
        : event.key === "ArrowUp"
          ? (current - 1 + kinds.length) % kinds.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? kinds.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    selectEmoteTab(kinds[next]);
    railRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  // 输入区预览：把草稿里能对上的表情名换成图片，让用户看清「这条发出去长什么样」。
  const preview = useMemo(() => {
    if (draft.length === 0 || panelEmotes.length === 0) return null;
    // 长名优先，避免短名吃掉长名的前缀。
    const candidates = panelEmotes
      .filter((emote) => emote.text.length > 0 && emote.url.length > 0)
      .sort((a, b) => b.text.length - a.text.length);
    const parts: { text: string; emote?: Emote }[] = [];
    let buffer = "";
    let matched = 0;
    for (let i = 0; i < draft.length; ) {
      const hit = candidates.find((emote) => draft.startsWith(emote.text, i));
      if (hit) {
        if (buffer.length > 0) {
          parts.push({ text: buffer });
          buffer = "";
        }
        parts.push({ text: hit.text, emote: hit });
        matched += 1;
        i += hit.text.length;
      } else {
        buffer += draft[i];
        i += 1;
      }
    }
    if (buffer.length > 0) parts.push({ text: buffer });
    return matched > 0 ? parts : null;
  }, [draft, panelEmotes]);

  /** 在光标处插入（面板点选与 @ 都走这里），插完把光标放到插入内容之后。 */
  const insertAtCaret = (text: string) => {
    const el = areaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    // 插入同样受有效上限约束：@ 前缀会增加上限，因此按插入**后**的文本重新算（见 applyDraft）。
    applyDraft(draft.slice(0, start) + text + draft.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  /**
   * 工具按钮：点已展开的那个 = 收起（② 再点一次工具按钮），点别的 = 换上它。
   * 真正的落地在 `RoomView` 的 `onPanel`（互斥与「打开表情面板时刷表情」都在那里）。
   */
  const togglePanel = (kind: PanelKind) => {
    onPanel(panel === kind ? null : kind);
  };

  const commitPhrase = (text: string) => {
    const value = text.trim();
    if (value.length === 0) {
      onNotice("短语不能为空");
      return false;
    }
    if (customPhrases.includes(value)) {
      onNotice("这条短语已经有了");
      return false;
    }
    onPrefs({ "composer.phrases": [...customPhrases, value] });
    return true;
  };

  const renamePhrase = (index: number, text: string) => {
    const value = text.trim();
    if (value.length === 0) {
      onNotice("短语不能为空");
      return;
    }
    if (customPhrases.some((item, i) => i !== index && item === value)) {
      onNotice("这条短语已经有了");
      return;
    }
    onPrefs({
      "composer.phrases": customPhrases.map((item, i) => (i === index ? value : item)),
    });
  };

  const removePhrase = (index: number) => {
    onPrefs({
      "composer.phrases": customPhrases.filter((_, i) => i !== index),
    });
  };

  const phraseMenuItems = (index: number): MenuItem[] => [
    {
      label: "编辑",
      onSelect: () => setEditingPhrase({ index, text: customPhrases[index] }),
    },
    {
      label: "删除",
      danger: true,
      onSelect: () => removePhrase(index),
    },
  ];

  /**
   * 点选表情 = **直接发送**（用户 2026-09-12：「发送表情包的时候有一个二次确认的过程，
   * 其实没有必要，点选某个表情直接发送出去就行」）。
   *
   * 因此不再把表情名插进草稿、也不再要求用户再点一次「发送」：草稿与 @ 目标原样留着
   * （它们属于文字那一侧），已经选了「回复」的话这一条表情就发成回复。面板不关 ——
   * 连发几个表情不必反复开面板。表情名会重名（实测「贴贴」同时在通用包与房间包里），
   * 发出去的是**点中的那一个**的 `emoticon_unique`，不拿草稿反推。
   */
  const sendEmote = async (emote: Emote) => {
    if (disabled || busy) return;
    const token: EmoteToken = {
      emoticon_unique: emote.emoticon_unique,
      emoji: emote.text,
      url: emote.url,
      width: emote.width,
      height: emote.height,
      is_dynamic: emote.is_dynamic,
      in_player_area: emote.in_player_area,
      bulge_display: emote.bulge_display,
    };
    const reply = replyTo
      ? { mid: replyTo.uid, uname: replyTo.uname, dmid: replyTo.upstream_id }
      : undefined;
    setBusy(true);
    const outcome = await onSend(emote.text, token, reply);
    setBusy(false);
    setSendSeq((value) => value + 1);
    // 被这一条消耗掉的回复目标就清掉；没发出去就留着（与文字发送同一口径：留着能重试）
    if (replyTo && outcome === "ok") setReplyTo(null);
  };

  const submit = async () => {
    const content = draft.trim();
    if (content.length === 0 || busy) return;
    // 回复优先于 @：回复本身就带上了被回复者，官方载荷里也是一组字段。
    // @ 目标走 `mentionTarget`（从草稿派生）：文本里删掉了 @ 名字就不带上。
    const reply = replyTo
      ? { mid: replyTo.uid, uname: replyTo.uname, dmid: replyTo.upstream_id }
      : mentionTarget
        ? { mid: mentionTarget.mid, uname: mentionTarget.uname, dmid: "" }
        : undefined;
    setBusy(true);
    const outcome = await onSend(content, undefined, reply);
    setBusy(false);
    setSendSeq((value) => value + 1);
    // 只有**确实发出去**才清空草稿：被拒的那条要照着行上划掉的正文 + 原因自己改
    // （用户 2026-09-13：「便于我对照修改」），结果未知的还能原样重发。
    if (outcome === "ok") {
      setDraft("");
      setReplyTo(null);
      setMention(null);
      onPanel(null);
    }
  };

  // 「将发送」预览是**弹幕行长什么样**的预览，所以它跟弹幕区一起缩放；三个面板不跟
  // （用户 2609140651：字号只控制弹幕区，不改面板区）。
  const previewFont = { fontSize: `${prefs["ui.font_scale"]}em` };

  return (
    <>
      {panel === "emotes" && (
        <div
          className={styles.picker}
          data-testid="db-panel"
          ref={panelRef}
        >
          {/* 面板顶上**没有标题、也没有「关闭」**（用户 2026-09-12：「表情包栏顶部的表情和
              关闭不需要」）：收起面板靠再点一次「表情」或点输入区外面（见上面那条 pointerdown）。
              少掉这一行之后，三行大表情格就是面板的全部高度。
              短语与筛选面板同样没有这一行（用户 item 8），三个面板因此是同一副骨架。 */}
          {/* 「我的表情」拉失败只在面板里提示并可重试：输入框与已加载的分组照常可用 */}
          {ownedError !== undefined && (
            <div className={styles.panelError} data-testid="db-owned-error">
              <span>我的表情加载失败：{ownedError}</span>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={onRetryOwned}
              >
                重试
              </button>
            </div>
          )}
          {grouped.length === 0 ? (
            <div className={styles.empty}>没有可用表情（或尚未加载）</div>
          ) : (
            // 面板主体分两列：左边**竖向 tab 轨道**（分组），右边表情网格。
            // 两列**各自滚且同高**（轨道高 = 网格高 = 三行大表情格）：分组多了在轨道里上下滚，
            // 表情多了在网格里上下滚（用户 2026-09-12：「左边也加入上下滚动」）。
            <div className={styles.emoteBody}>
              {/* 分组 tab 轨道：一组一个 tab，选中那格左侧一条强调色 + 底色抬起 + 字重加粗。
                  用 `role=tablist/tab` + roving tabindex（WAI-ARIA tabs 口径），↑↓ 换组、焦点跟着走 ——
                  它得**读起来就是 tab**，不是一排长得像 tab 的普通按钮（用户 2026-09-12：
                  「给表情的全是按钮，根本框不住表情图标，可以直接仿照官方实现」）。
                  tab 只列**当前有内容的组**（面板里没有搜索，见上）。 */}
              <div
                className={styles.emoteRail}
                data-testid="db-emote-tabs"
                role="tablist"
                aria-orientation="vertical"
                aria-label="表情分组"
                ref={railRef}
                onKeyDown={onRailKeyDown}
              >
                {grouped.map(([kind, items]) => (
                  <button
                    key={kind}
                    type="button"
                    id={emoteTabId(kind)}
                    role="tab"
                    aria-selected={kind === activeKind}
                    aria-controls={EMOTE_PANEL_ID}
                    tabIndex={kind === activeKind ? 0 : -1}
                    className={styles.emoteTab}
                    data-testid="db-emote-tab"
                    data-kind={kind}
                    title={`${EMOTE_PACKAGE_LABEL[kind]}（${items.length}）`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectEmoteTab(kind)}
                  >
                    {EMOTE_PACKAGE_LABEL[kind]}
                    <span className={styles.emoteTabCount}>（{items.length}）</span>
                  </button>
                ))}
              </div>
              <div
                className={styles.emoteGrid}
                data-testid="db-emote-group"
                data-kind={activeKind}
                id={EMOTE_PANEL_ID}
                role="tabpanel"
                aria-labelledby={activeKind === null || activeKind === undefined
                  ? undefined
                  : emoteTabId(activeKind)}
                ref={gridRef}
              >
                {activeItems.map((emote) => (
                  <button
                    key={emote.key}
                    data-testid="db-emote-item"
                    // 无权限的那批：置灰但照常列出、照常可点（闸门在上游发送侧）
                    data-locked={emote.locked === true ? "true" : "false"}
                    // 通用表情之外（本房间 / 粉丝牌 / 大航海）画大一点：那几族本来就大，
                    // 缩成通用表情那么大根本看不清（issue #8）。
                    className={`${styles.pickerItem} ${
                      activeKind === "common" ? "" : styles.pickerItemBig
                    } ${emote.locked === true ? styles.pickerItemLocked : ""}`}
                    title={
                      emote.locked === true
                        ? `${emote.text}（点一下直接发送；当前身份用不了，置灰只是提示，能不能发由上游判定）`
                        : emote.text
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void sendEmote(emote)}
                  >
                    {emote.url.length > 0 ? (
                      <img src={emote.url} alt={emote.text} />
                    ) : (
                      emote.text
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {panel === "phrases" && (
        <div className={styles.phrases} data-testid="db-panel" ref={panelRef}>
          {/* 面板没有标题行、也没有「关闭」按钮（用户 item 8：「展开高度看齐表情界面」）：
              「加一条」就是面板的第一行内容。 */}
          {/* 「加一条」是**固定的一行**（不跟芯片抢换行位、不随芯片区滚走）：
              竖屏下短语再多，这个输入框都还在、还能用（用户 #8）。 */}
          <div className={styles.phraseAdd} data-testid="db-phrase-add">
            <input
              className={styles.phraseInput}
              value={newPhrase}
              placeholder="新短语，回车添加"
              onChange={(event) => setNewPhrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (commitPhrase(newPhrase)) setNewPhrase("");
              }}
            />
            <button
              className={styles.phraseAddBtn}
              disabled={newPhrase.trim().length === 0}
              title="添加这条短语"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (commitPhrase(newPhrase)) setNewPhrase("");
              }}
            >
              添加
            </button>
          </div>
          {/* 芯片区：一组**等宽列**（见 .phrasesRow），短语各占一格、左对齐，
              行数多少都在这里自己滚 —— 面板高度不跟着内容走（契约 C7）。 */}
          <div className={styles.phrasesBody}>
            <div className={styles.phrasesRow}>
              {customPhrases.length === 0 && (
                <span className={styles.previewLabel}>（还没有，在上面加一条）</span>
              )}
              {customPhrases.map((text, index) =>
                editingPhrase?.index === index ? (
                  <input
                    key={`edit-${index}`}
                    className={styles.phraseInput}
                    autoFocus
                    value={editingPhrase.text}
                    onChange={(event) =>
                      setEditingPhrase({ index, text: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        renamePhrase(index, editingPhrase.text);
                        setEditingPhrase(null);
                      }
                      if (event.key === "Escape") setEditingPhrase(null);
                    }}
                    onBlur={() => setEditingPhrase(null)}
                  />
                ) : (
                  <button
                    key={`${text}-${index}`}
                    className={styles.phraseItem}
                    title="点一下插入；右键可改名或删除"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertAtCaret(text)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setPhraseMenu({
                        at: { x: event.clientX, y: event.clientY },
                        index,
                      });
                    }}
                  >
                    {text}
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
      )}

      {panel === "filter" && (
        <div
          className={styles.filterPanel}
          data-testid="db-panel"
          ref={panelRef}
        >
          {/* 同样没有面板头与关闭按钮（用户 item 8）：面板本体就是 FilterBar 的两块
              （消息类型 / 显示），收起靠再点一次「筛选」或点面板外。
              字号**不跟** `ui.font_scale`（用户 2609140651：字号只控制弹幕区）——三个面板都
              吃 body 的基准字号，`--panel-h` 那套 em 定高因此也是常数，三者必然同高。 */}
          <FilterBar prefs={prefs} onChange={onPrefs} />
        </div>
      )}

      {phraseMenu && (
        <ContextMenu
          at={phraseMenu.at}
          items={phraseMenuItems(phraseMenu.index)}
          onClose={() => setPhraseMenu(null)}
        />
      )}

      {replyTo && (
        <div className={styles.replyBar} data-testid="db-reply-bar">
          <span className={styles.previewLabel}>
            回复 {replyTo.uname}：{replyTo.content.slice(0, 30)}
          </span>
          <button onClick={() => setReplyTo(null)}>取消回复</button>
        </div>
      )}

      {/* @ 目标的提示：它是**派生**出来的（文本里还有 @名字 才显示），
          所以显示的与发出去的永远一致；取消方式就是删掉文本里那个 @名字（issue #13a）。 */}
      {mentionTarget && (
        <div className={styles.replyBar} data-testid="db-mention-hint">
          <span className={styles.previewLabel}>
            将 @{mentionTarget.uname} · 删掉文本里的 @{mentionTarget.uname} 即取消
          </span>
        </div>
      )}

      {preview && (
        <div className={styles.preview} data-testid="db-send-preview" style={previewFont}>
          <span className={styles.previewLabel}>将发送</span>
          {preview.map((part, index) =>
            part.emote ? (
              <img
                key={`${index}-${part.text}`}
                className={styles.previewEmote}
                src={part.emote.url}
                alt={part.text}
                title={part.text}
              />
            ) : (
              <span key={`${index}-${part.text}`}>{part.text}</span>
            ),
          )}
        </div>
      )}

      {/* 发送失败的**浮动提示**：排在弹幕列表与输入区之间（文档流里的一张浮片），
          矩形因此与弹幕列表区域不相交；`pointer-events: none` 让提示期间弹幕照常滚。 */}
      {toast !== null && (
        <div
          key={toast.key}
          className={styles.toast}
          data-testid="db-toast"
          role="status"
          style={{ animationDuration: `${SEND_TOAST_MS}ms` }}
        >
          {toast.text}
        </div>
      )}

      <div className={styles.composer} ref={composerRef}>
        {/* 超上限即截断并按官方文案弹提示（见 applyDraft）：不等到发送才发现超长。 */}
        <textarea
          ref={areaRef}
          value={draft}
          placeholder={loggedIn ? "说点什么…" : "未登录，只能看弹幕"}
          disabled={disabled || !loggedIn}
          onChange={(event) => applyDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {/* 工具行：四个面板入口在左，发送在右。按钮 mousedown 不抢焦点，草稿与光标都留着 */}
        <div className={styles.composerTools} data-testid="db-composer-tools">
          <button
            className={panel === "emotes" ? styles.toolActive : undefined}
            disabled={disabled || !loggedIn}
            title="表情包库"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("emotes")}
          >
            表情
          </button>
          <button
            className={panel === "phrases" ? styles.toolActive : undefined}
            disabled={disabled || !loggedIn}
            title="快捷短语"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("phrases")}
          >
            短语
          </button>
          <button
            className={panel === "filter" ? styles.toolActive : undefined}
            title="筛选与显示"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("filter")}
          >
            筛选
          </button>
          <span className={styles.composerSpacer} />
          {/* 字数计数 `已用/有效上限`（用户 item 12）：上限来自上游、@ 前缀不计入（见 applyDraft），
              因此这里显示的就是「还能再打几个字」的准确刻度，不必等到发出去才发现超长。 */}
          {loggedIn && (
            <span
              className={styles.inputCount}
              data-testid="db-input-count"
              title={`本房间弹幕上限 ${lengthLimit} 字`}
            >
              {draft.length}/{lengthLimit}
            </span>
          )}
          {/* 发送簇 = **电池 + 发送**，同进同退（窄屏换行时不许被拆到两排——
              用户 2026-09-13：「电池数量挪到底部发送按钮左侧」）。
              电池是**圆角矩形**（.battery），与返回 / ⋯ 的圆**不同形状**；点数值手动刷新（§6.4）。 */}
          <span className={styles.sendCluster} data-testid="db-send-cluster">
            {balance !== undefined && (
              <button
                className={styles.battery}
                data-testid="db-battery"
                title={`电池余额 ${balance}（点一下刷新）`}
                onClick={onRefreshBalance}
              >
                <svg className={styles.batteryIcon} viewBox="0 0 24 24" aria-hidden="true">
                  {/* **竖着**的电池（用户 2026-09-13 第 3 条：官方的电池标是竖的，
                      横过来的那个看着像一根电量条，容易被当成「显示电量」的指示）。
                      机身 10×16 的竖矩形 + 顶上那截极柱；图标盒尺寸没动（.batteryIcon = 1.1em）。 */}
                  <rect
                    x="7"
                    y="5"
                    width="10"
                    height="16"
                    rx="3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M11 3h2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <span data-testid="db-battery-balance">{balance}</span>
              </button>
            )}
            <button
              disabled={disabled || !loggedIn || busy || draft.trim().length === 0}
              onClick={() => void submit()}
            >
              {busy ? "发送中" : "发送"}
            </button>
          </span>
        </div>
      </div>
    </>
  );
}
