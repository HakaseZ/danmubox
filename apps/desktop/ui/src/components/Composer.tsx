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

/** 输入区上方四个弹出面板：同时只开一个，向上展开（issue #8）。 */
type PanelKind = "emotes" | "phrases" | "recent" | "filter";

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
  recentSends: string[];
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

/** 内置颜文字与快捷短语（需求 §2.2 的「快捷短语 / 颜文字」）。 */
const KAOMOJI: string[] = [
  "233",
  "awsl",
  "yyds",
  "(￣▽￣)",
  "(・∀・)",
  "╮(╯▽╰)╭",
  "→_→",
  "666",
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
  recentSends,
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
    const reply = replyTo
      ? { mid: replyTo.uid, uname: replyTo.uname, dmid: replyTo.upstream_id }
      : mention
        ? { mid: mention.mid, uname: mention.uname, dmid: "" }
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

  const panelFont = { fontSize: `${14 * prefs["ui.font_scale"]}px` };

  return (
    <>
      {panel === "emotes" && (
        <div className={styles.picker} data-testid="db-panel" style={panelFont}>
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>表情</span>
            <input
              className={styles.panelSearch}
              value={emoteQuery}
              placeholder="搜索表情"
              onChange={(event) => setEmoteQuery(event.target.value)}
            />
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
            grouped.map(([kind, items]) => (
              <div key={kind} className={styles.pickerGroup}>
                <div className={styles.pickerTitle}>
                  {EMOTE_PACKAGE_LABEL[kind]}
                </div>
                <div className={styles.pickerItems}>
                  {items.map((emote) => (
                    <button
                      key={emote.key}
                      // 通用表情之外（本房间 / 粉丝牌 / 大航海）画大一点：那几族本来就大，
                      // 缩成通用表情那么大根本看不清（issue #8）。
                      className={`${styles.pickerItem} ${
                        kind === "common" ? "" : styles.pickerItemBig
                      }`}
                      title={emote.text}
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
              </div>
            ))
          )}
        </div>
      )}

      {panel === "phrases" && (
        <div className={styles.phrases} data-testid="db-panel">
          <div className={styles.phrasesRow}>
            <span className={styles.previewLabel}>颜文字</span>
            {KAOMOJI.map((text) => (
              <button
                key={text}
                className={styles.phraseItem}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertAtCaret(text)}
              >
                {text}
              </button>
            ))}
          </div>
          <div className={styles.phrasesRow}>
            <span className={styles.previewLabel}>自定义</span>
            {customPhrases.length === 0 && (
              <span className={styles.previewLabel}>（还没有，在右边加一条）</span>
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
        </div>
      )}

      {panel === "recent" && (
        <div className={styles.recent} data-testid="db-panel">
          <span className={styles.previewLabel}>最近发言</span>
          {recentSends.length === 0 ? (
            <span className={styles.previewLabel}>（本会话还没发过）</span>
          ) : (
            recentSends.map((text) => (
              <button
                key={text}
                className={styles.recentItem}
                title="点击填入输入框"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertAtCaret(text)}
              >
                {text.length > 16 ? `${text.slice(0, 16)}…` : text}
              </button>
            ))
          )}
        </div>
      )}

      {panel === "filter" && (
        <div className={styles.filterPanel} data-testid="db-panel">
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
        <div className={styles.replyBar}>
          <span className={styles.previewLabel}>
            回复 {replyTo.uname}：{replyTo.content.slice(0, 30)}
          </span>
          <button onClick={() => setReplyTo(null)}>取消回复</button>
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
        <div className={styles.composerTools}>
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
            title="快捷短语与颜文字（右键短语可改名 / 删除）"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("phrases")}
          >
            短语
          </button>
          <button
            className={panel === "recent" ? styles.toolActive : undefined}
            disabled={disabled || !loggedIn}
            title="本会话最近发过的内容"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => togglePanel("recent")}
          >
            最近
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
      <div
        className={`${styles.composerHint} ${
          lastOutcome ? (OUTCOME_CLASS[lastOutcome] ?? "") : ""
        }`}
      >
        {!loggedIn
          ? "未登录：仅能接收弹幕，发送需要先扫码登录"
          : lastOutcome
            ? `上次发送：${SEND_OUTCOME_TEXT[lastOutcome]}${
                lastDetail ? ` · ${lastDetail}` : ""
              }`
            : " "}
      </div>
    </>
  );
}
