import { useEffect, useMemo, useRef, useState } from "react";

import { ContextMenu, type MenuItem, type MenuPoint } from "./ContextMenu";
import { FilterBar } from "./FilterBar";
import {
  EMOTE_PACKAGE_LABEL,
  SEND_OUTCOME_TEXT,
  type Emote,
  type EmotePackage,
  type Message,
  type Prefs,
  type EmoteToken,
  type ReplyTarget,
  type SendOutcome,
} from "../types";
import styles from "../app.module.css";

/** 输入区上方三个弹出面板：同时只开一个，向上展开（issue #8）。 */
type PanelKind = "emotes" | "phrases" | "filter";

interface Props {
  disabled: boolean;
  loggedIn: boolean;
  lastOutcome?: SendOutcome;
  lastDetail?: string | null;
  emotes: Emote[];
  /** 主站「我的表情」（`emotes_owned`）：与接口给的按房间包同侧，排在「通用」之后。 */
  ownedEmotes: Emote[];
  /** 「我的表情」上次拉取失败的原因；面板里显示并提供重试（不阻塞输入框）。 */
  ownedError?: string;
  seenEmotes: Emote[];
  /** 行菜单里点的 @ / 回复，点一次应用一次（token 变则重放）。 */
  pendingAction?: { kind: "mention" | "reply"; message: Message; token: number } | null;
  prefs: Prefs;
  onPrefs: (patch: Partial<Prefs>) => void;
  onSend: (
    content: string,
    emote?: EmoteToken,
    reply?: ReplyTarget,
  ) => Promise<SendOutcome | undefined>;
  onOpenEmotes: () => void;
  /** 面板里「我的表情」加载失败后的重试入口。 */
  onRetryOwned: () => void;
  onNotice: (text: string) => void;
}

/** 发送结果 → 文案与样式（docs/ui.md §6.5 的七态）。 */
const OUTCOME_CLASS: Record<SendOutcome, string | undefined> = {
  ok: styles.sendOk,
  blocked_platform: styles.sendFail,
  blocked_room: styles.sendWarn,
  rate_limited: styles.sendWarn,
  medal_required: styles.sendWarn,
  muted: styles.sendFail,
  failed: styles.sendFail,
};

/** 表情分组展示顺序：接口给的包在前（通用 → 我的表情 → 本房间 → 粉丝牌 → 大航海）。 */
const PACKAGE_ORDER: EmotePackage[] = [
  "common",
  "owned",
  "room",
  "medal",
  "guard",
];

export function Composer({
  disabled,
  loggedIn,
  lastOutcome,
  lastDetail,
  emotes,
  ownedEmotes,
  ownedError,
  seenEmotes,
  pendingAction,
  prefs,
  onPrefs,
  onSend,
  onOpenEmotes,
  onRetryOwned,
  onNotice,
}: Props) {
  const [draft, setDraft] = useState("");
  // 被点选的表情：名字会重名（实测「贴贴」同时存在于通用包与房间包），
  // 因此发送时必须按「点的是哪一个」来判定，而不是拿草稿去反推。
  const [pickedEmote, setPickedEmote] = useState<Emote | null>(null);
  // 回复某条弹幕时显示引用条；@ 某人只是把名字插进草稿，另记 uid 供发送时上报。
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mention, setMention] = useState<{ mid: number; uname: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const [emoteQuery, setEmoteQuery] = useState("");
  // 表情分组 tab：null = 还没选过，显示第一组（顺序固定，见 PACKAGE_ORDER）。
  const [emoteTab, setEmoteTab] = useState<EmotePackage | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [newPhrase, setNewPhrase] = useState("");
  // 短语的「改」：就地变成输入框（右键菜单里点「编辑」进入）。
  const [editingPhrase, setEditingPhrase] = useState<{ index: number; text: string } | null>(null);
  const [phraseMenu, setPhraseMenu] = useState<{ at: MenuPoint; index: number } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

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

  // 接口给的包（`emotes_list` 的按房间包 + 主站「我的表情」）是**权威**的一侧：
  // 同一个 `emoticon_unique` 只保留接口给的那条。「我的表情」并进这一侧之后，
  // 从弹幕学到的同类表情会被自动去重（接口优先、学到的补漏）。
  const interfaceEmotes = useMemo(() => {
    const known = new Set<string>();
    const out: Emote[] = [];
    for (const emote of [...emotes, ...ownedEmotes]) {
      if (known.has(emote.emoticon_unique)) continue;
      known.add(emote.emoticon_unique);
      out.push(emote);
    }
    return out;
  }, [emotes, ownedEmotes]);

  // 接口包 + 从弹幕学到的表情（去重后）；面板分组与「将发送」预览都走这一份，
  // 否则学到的表情能在面板里选、预览里却显示成文字。
  const allEmotes = useMemo(() => {
    const known = new Set(interfaceEmotes.map((emote) => emote.emoticon_unique));
    return [
      ...interfaceEmotes,
      ...seenEmotes.filter((emote) => !known.has(emote.emoticon_unique)),
    ];
  }, [interfaceEmotes, seenEmotes]);

  // 按来源分组展示（通用 / 我的表情 / 本房间 / 粉丝牌 / 大航海），见 docs/ui.md §6.3。
  const grouped = useMemo(() => {
    const groups: Record<EmotePackage, Emote[]> = {
      common: [],
      owned: [],
      room: [],
      medal: [],
      guard: [],
    };
    const query = emoteQuery.trim().toLowerCase();
    for (const emote of allEmotes) {
      if (query.length > 0 && !emote.text.toLowerCase().includes(query)) continue;
      groups[emote.package_kind].push(emote);
    }
    return PACKAGE_ORDER.map((kind) => [kind, groups[kind]] as const).filter(
      ([, items]) => items.length > 0,
    );
  }, [allEmotes, emoteQuery]);

  // 当前 tab：选中的那一组还在（搜索可能把它整组过滤掉）就用它，否则回落到第一组。
  // 派生的，不放进 state —— 搜索把当前组过滤空时不会留下一个「指向空气」的选中态。
  const activeKind = grouped.some(([kind]) => kind === emoteTab)
    ? emoteTab
    : grouped[0]?.[0];
  const activeItems = grouped.find(([kind]) => kind === activeKind)?.[1] ?? [];

  // 输入区预览：把草稿里能对上的表情名换成图片，让用户看清「这条发出去长什么样」。
  const preview = useMemo(() => {
    if (draft.length === 0 || allEmotes.length === 0) return null;
    // 长名优先，避免短名吃掉长名的前缀。
    const candidates = allEmotes
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
  }, [draft, allEmotes]);

  /** 在光标处插入（面板点选与 @ 都走这里），插完把光标放到插入内容之后。 */
  const insertAtCaret = (text: string) => {
    const el = areaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + text + draft.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const togglePanel = (kind: PanelKind) => {
    if (panel === kind) {
      setPanel(null);
      return;
    }
    if (kind === "emotes") onOpenEmotes();
    setPanel(kind);
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

  const submit = async () => {
    const content = draft.trim();
    if (content.length === 0 || busy) return;
    // 草稿与点选的表情完全一致时才按表情发送：这样「点了表情直接发」得到的是表情弹幕，
    // 而任何编辑都退回普通文本，不会把用户没想发的东西发成表情。
    const asEmote =
      pickedEmote && content === pickedEmote.text
        ? {
            emoticon_unique: pickedEmote.emoticon_unique,
            emoji: pickedEmote.text,
            url: pickedEmote.url,
            width: pickedEmote.width,
            height: pickedEmote.height,
            is_dynamic: pickedEmote.is_dynamic,
            in_player_area: pickedEmote.in_player_area,
            bulge_display: pickedEmote.bulge_display,
          }
        : undefined;
    // 回复优先于 @：回复本身就带上了被回复者，官方载荷里也是一组字段。
    // @ 目标走 `mentionTarget`（从草稿派生）：文本里删掉了 @ 名字就不带上。
    const reply = replyTo
      ? { mid: replyTo.uid, uname: replyTo.uname, dmid: replyTo.upstream_id }
      : mentionTarget
        ? { mid: mentionTarget.mid, uname: mentionTarget.uname, dmid: "" }
        : undefined;
    setBusy(true);
    const outcome = await onSend(content, asEmote, reply);
    setBusy(false);
    // 只有确实发出去（或被吞）才清空草稿；失败保留内容便于重试。
    if (outcome !== undefined && outcome !== "failed") {
      setDraft("");
      setPickedEmote(null);
      setReplyTo(null);
      setMention(null);
      setPanel(null);
    }
  };

  // 与弹幕列表同一口径：em 相对 body 的 --fs-root，字号滑杆改这一处
  const panelFont = { fontSize: `${prefs["ui.font_scale"]}em` };

  // 三个面板共用的关闭入口（面板是文档流里的一块，关掉它就是收起自己）。
  const panelClose = (
    <button
      data-testid="db-panel-close"
      title="关闭面板"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => setPanel(null)}
    >
      关闭
    </button>
  );

  return (
    <>
      {panel === "emotes" && (
        <div
          className={styles.picker}
          data-testid="db-panel"
          style={panelFont}
          ref={panelRef}
        >
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>表情</span>
            <input
              className={styles.panelSearch}
              value={emoteQuery}
              placeholder="搜索表情"
              onChange={(event) => setEmoteQuery(event.target.value)}
            />
            <span className={styles.composerSpacer} />
            {panelClose}
          </div>
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
            <div className={styles.empty}>
              {emoteQuery.trim().length > 0
                ? "没有匹配的表情"
                : "没有可用表情（或尚未加载）"}
            </div>
          ) : (
            <>
              {/* 分组 tab：一组一屏，不再纵向堆五个分区（用户 #6）。
                  搜索是在**所有组**里搜的，所以 tab 只列「当前有内容的组」——
                  搜完切到有命中的那一组，不必自己挨个点开找。 */}
              <div className={styles.emoteTabs} data-testid="db-emote-tabs" role="tablist">
                {grouped.map(([kind, items]) => (
                  <button
                    key={kind}
                    type="button"
                    role="tab"
                    className={`${styles.emoteTab} ${
                      kind === activeKind ? styles.toolActive : ""
                    }`}
                    data-testid="db-emote-tab"
                    data-kind={kind}
                    aria-selected={kind === activeKind}
                    title={`${EMOTE_PACKAGE_LABEL[kind]}（${items.length}）`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setEmoteTab(kind);
                      // 换 tab 回到格子顶部：否则会停在上一个 tab 的滚动位置
                      if (panelRef.current) panelRef.current.scrollTop = 0;
                    }}
                  >
                    {EMOTE_PACKAGE_LABEL[kind]}（{items.length}）
                  </button>
                ))}
              </div>
              <div
                className={styles.emoteGrid}
                data-testid="db-emote-group"
                data-kind={activeKind}
                role="tabpanel"
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
                        ? `${emote.text}（当前身份用不了，置灰只是提示，发送仍由上游判定）`
                        : emote.text
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      insertAtCaret(emote.text);
                      setPickedEmote(emote);
                    }}
                  >
                    {emote.url.length > 0 ? (
                      <img src={emote.url} alt={emote.text} />
                    ) : (
                      emote.text
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {panel === "phrases" && (
        <div className={styles.phrases} data-testid="db-panel" style={panelFont}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>短语</span>
            <span className={styles.composerSpacer} />
            {panelClose}
          </div>
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
              className={styles.phraseItem}
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
        <div className={styles.filterPanel} data-testid="db-panel">
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>筛选与显示</span>
            <span className={styles.composerSpacer} />
            {panelClose}
          </div>
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
        <div className={styles.preview} data-testid="db-send-preview" style={panelFont}>
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

      <div className={styles.composer}>
        <textarea
          ref={areaRef}
          value={draft}
          placeholder={
            loggedIn ? "说点什么…（Enter 发送，Shift+Enter 换行）" : "未登录，只能看弹幕"
          }
          disabled={disabled || !loggedIn}
          onChange={(event) => setDraft(event.target.value)}
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
            title="表情包库（在输入框上方展开）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("emotes")}
          >
            表情
          </button>
          <button
            className={panel === "phrases" ? styles.toolActive : undefined}
            disabled={disabled || !loggedIn}
            title="快捷短语（右键短语可改名 / 删除）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("phrases")}
          >
            短语
          </button>
          <button
            className={panel === "filter" ? styles.toolActive : undefined}
            title="筛选与显示（关键词 / 类型 / 字号 / 时间戳…）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("filter")}
          >
            筛选
          </button>
          <span className={styles.composerSpacer} />
          <button
            disabled={disabled || !loggedIn || busy || draft.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? "发送中" : "发送"}
          </button>
        </div>
      </div>
      {/* 发送结果只在**需要用户做点什么**时占一行：失败 / 被吞 / 限流要说清原因，
          成功不必说——弹幕已经出现在列表里了（用户：那条「上次发送：已发出」没有意义
          且不协调）。没有话要说时整行不渲染，窄屏也就不用白留一行。 */}
      {(!loggedIn || (lastOutcome !== undefined && lastOutcome !== "ok")) && (
        <div
          className={`${styles.composerHint} ${
            lastOutcome ? (OUTCOME_CLASS[lastOutcome] ?? "") : ""
          }`}
          data-testid="db-send-hint"
        >
          {!loggedIn
            ? "未登录：仅能接收弹幕，发送需要先扫码登录"
            : `上次发送：${SEND_OUTCOME_TEXT[lastOutcome as SendOutcome]}${
                lastDetail ? ` · ${lastDetail}` : ""
              }`}
        </div>
      )}
    </>
  );
}
