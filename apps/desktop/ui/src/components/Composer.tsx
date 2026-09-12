import { useEffect, useMemo, useState } from "react";

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

interface Props {
  disabled: boolean;
  loggedIn: boolean;
  lastOutcome?: SendOutcome;
  lastDetail?: string | null;
  emotes: Emote[];
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

/** 表情分组展示顺序。 */
const PACKAGE_ORDER: EmotePackage[] = ["common", "room", "medal", "guard"];

/// 内置颜文字与快捷短语（需求 §2.2 的「快捷短语 / 颜文字」）。
/// 它们是固定常量，不进偏好；用户自己加的短语才存 `composer.phrases`。
const KAOMOJI: string[] = ["233", "awsl", "yyds", "(￣▽￣)", "(・∀・)", "╮(╯▽╰)╭", "→_→", "666"];

export function Composer({
  disabled,
  loggedIn,
  lastOutcome,
  lastDetail,
  emotes,
  seenEmotes,
  recentSends,
  pendingAction,
  prefs,
  onPrefs,
  onSend,
  onOpenEmotes,
}: Props) {
  const [draft, setDraft] = useState("");
  // 被点选的表情：名字会重名（实测「贴贴」同时存在于通用包与房间包），
  // 因此发送时必须按「点的是哪一个」来判定，而不是拿草稿去反推。
  const [pickedEmote, setPickedEmote] = useState<Emote | null>(null);
  // 回复某条弹幕时显示引用条；@ 某人只是把名字插进草稿，另记 uid 供发送时上报。
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mention, setMention] = useState<{ mid: number; uname: string } | null>(null);

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
    // 只在用户点菜单时应用一次：token 每次点击都变，因此不会自激。
  }, [pendingAction]);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [phrasesOpen, setPhrasesOpen] = useState(false);
  const [newPhrase, setNewPhrase] = useState("");

  // 按来源分组展示（通用 / 本房间 / 粉丝牌 / 大航海 / 房管），见 docs/ui.md §6.3。
  const customPhrases = prefs["composer.phrases"] ?? [];

  const grouped = useMemo(() => {
    const groups: Record<EmotePackage, Emote[]> = {
      common: [],
      room: [],
      medal: [],
      guard: [],
        };
    // 接口给的包 + 从弹幕学到的表情；同一个唯一键只出现一次（接口优先）。
    const known = new Set(emotes.map((emote) => emote.emoticon_unique));
    const merged = [...emotes, ...seenEmotes.filter((emote) => !known.has(emote.emoticon_unique))];
    for (const emote of merged) groups[emote.package_kind].push(emote);
    return PACKAGE_ORDER.map((kind) => [kind, groups[kind]] as const).filter(
      ([, items]) => items.length > 0,
    );
  }, [emotes, seenEmotes]);

  // 输入区预览：把草稿里能对上的表情名换成图片，让用户看清「这条发出去长什么样」。
  // 上游按**内容**识别表情弹幕（收包侧 `info[1]` 就是表情名，是服务端补的 `info[0][13]`），
  // 所以「插入名字」与「插入表情」在协议上是同一件事——这里只是把它显示出来。
  const preview = useMemo(() => {
    if (draft.length === 0 || emotes.length === 0) return null;
    // 长名优先，避免短名吃掉长名的前缀。
    const candidates = emotes
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
  }, [draft, emotes]);

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
    }
  };

  return (
    <>
      {pickerOpen && (
        <div className={styles.picker}>
          {grouped.length === 0 ? (
            <div className={styles.empty}>没有可用表情（或尚未加载）</div>
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
                      className={styles.pickerItem}
                      title={emote.text}
                      onClick={() => {
                        setDraft((value) => value + emote.text);
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

      {phrasesOpen && (
        <div className={styles.phrases}>
          <div className={styles.phrasesRow}>
            <span className={styles.previewLabel}>颜文字</span>
            {KAOMOJI.map((text) => (
              <button
                key={text}
                className={styles.phraseItem}
                onClick={() => setDraft((value) => value + text)}
              >
                {text}
              </button>
            ))}
          </div>
          <div className={styles.phrasesRow}>
            <span className={styles.previewLabel}>自定义</span>
            {customPhrases.length === 0 && (
              <span className={styles.previewLabel}>（还没有，在右边加一个）</span>
            )}
            {customPhrases.map((text) => (
              <button
                key={text}
                className={styles.phraseItem}
                title="点一下插入；右键或按下面的 ✕ 删除"
                onClick={() => setDraft((value) => value + text)}
              >
                {text}
              </button>
            ))}
            <input
              className={styles.phraseInput}
              value={newPhrase}
              placeholder="回车添加"
              onChange={(event) => setNewPhrase(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const text = newPhrase.trim();
                if (text.length === 0 || customPhrases.includes(text)) {
                  setNewPhrase("");
                  return;
                }
                onPrefs({ "composer.phrases": [...customPhrases, text] });
                setNewPhrase("");
              }}
            />
            {customPhrases.length > 0 && (
              <button
                className={styles.phraseItem}
                title="删掉最后一个自定义短语"
                onClick={() =>
                  onPrefs({ "composer.phrases": customPhrases.slice(0, -1) })
                }
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {replyTo && (
        <div className={styles.replyBar}>
          <span className={styles.previewLabel}>
            回复 {replyTo.uname}：{replyTo.content.slice(0, 30)}
          </span>
          <button onClick={() => setReplyTo(null)}>取消回复</button>
        </div>
      )}

      {draft.length === 0 && recentSends.length > 0 && (
        <div className={styles.recent}>
          <span className={styles.previewLabel}>最近</span>
          {recentSends.slice(0, 4).map((text) => (
            <button
              key={text}
              className={styles.recentItem}
              title="点击填入输入框"
              onClick={() => setDraft(text)}
            >
              {text.length > 12 ? `${text.slice(0, 12)}…` : text}
            </button>
          ))}
        </div>
      )}

      {preview && (
        <div className={styles.preview}>
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
        <button
          disabled={disabled || !loggedIn}
          title="快捷短语与颜文字"
          onClick={() => setPhrasesOpen((open) => !open)}
        >
          短语
        </button>
        <button
          disabled={disabled || !loggedIn}
          title="表情包库"
          onClick={() => {
            if (!pickerOpen) onOpenEmotes();
            setPickerOpen((open) => !open);
          }}
        >
          表情
        </button>
        <textarea
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
        <button
          disabled={disabled || !loggedIn || busy || draft.trim().length === 0}
          onClick={() => void submit()}
        >
          {busy ? "发送中" : "发送"}
        </button>
      </div>
      <div
        className={`${styles.composerHint} ${
          lastOutcome ? (OUTCOME_CLASS[lastOutcome] ?? "") : ""
        }`}
      >
        {!loggedIn
          ? "未登录：仅能接收弹幕，发送需要先在凭据文件中登录"
          : lastOutcome
            ? `上次发送：${SEND_OUTCOME_TEXT[lastOutcome]}${
                lastDetail ? ` · ${lastDetail}` : ""
              }`
            : " "}
      </div>
    </>
  );
}
