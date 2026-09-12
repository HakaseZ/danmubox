import { useMemo, useState } from "react";

import {
  EMOTE_PACKAGE_LABEL,
  SEND_OUTCOME_TEXT,
  type Emote,
  type EmotePackage,
  type EmoteToken,
  type SendOutcome,
} from "../types";
import styles from "../app.module.css";

interface Props {
  disabled: boolean;
  loggedIn: boolean;
  lastOutcome?: SendOutcome;
  lastDetail?: string | null;
  emotes: Emote[];
  onSend: (content: string, emote?: EmoteToken) => Promise<SendOutcome | undefined>;
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
const PACKAGE_ORDER: EmotePackage[] = ["common", "room", "medal", "guard", "admin"];

export function Composer({
  disabled,
  loggedIn,
  lastOutcome,
  lastDetail,
  emotes,
  onSend,
  onOpenEmotes,
}: Props) {
  const [draft, setDraft] = useState("");
  // 被点选的表情：名字会重名（实测「贴贴」同时存在于通用包与房间包），
  // 因此发送时必须按「点的是哪一个」来判定，而不是拿草稿去反推。
  const [pickedEmote, setPickedEmote] = useState<Emote | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 按来源分组展示（通用 / 本房间 / 粉丝牌 / 大航海 / 房管），见 docs/ui.md §6.3。
  const grouped = useMemo(() => {
    const groups: Record<EmotePackage, Emote[]> = {
      common: [],
      room: [],
      medal: [],
      guard: [],
      admin: [],
    };
    for (const emote of emotes) groups[emote.package_kind].push(emote);
    return PACKAGE_ORDER.map((kind) => [kind, groups[kind]] as const).filter(
      ([, items]) => items.length > 0,
    );
  }, [emotes]);

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
    setBusy(true);
    const outcome = await onSend(content, asEmote);
    setBusy(false);
    // 只有确实发出去（或被吞）才清空草稿；失败保留内容便于重试。
    if (outcome !== undefined && outcome !== "failed") {
      setDraft("");
      setPickedEmote(null);
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
