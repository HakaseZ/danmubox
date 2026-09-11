import { useMemo, useState } from "react";

import {
  EMOTE_PACKAGE_LABEL,
  SEND_OUTCOME_TEXT,
  type Emote,
  type EmotePackage,
  type SendOutcome,
} from "../types";
import styles from "../app.module.css";

interface Props {
  disabled: boolean;
  loggedIn: boolean;
  lastOutcome?: SendOutcome;
  emotes: Emote[];
  onSend: (content: string) => Promise<SendOutcome | undefined>;
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
const PACKAGE_ORDER: EmotePackage[] = ["common", "medal", "guard", "admin"];

export function Composer({
  disabled,
  loggedIn,
  lastOutcome,
  emotes,
  onSend,
  onOpenEmotes,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 按身份分组展示（通用 / 粉丝牌 / 大航海 / 房管），见 docs/ui.md §6.3。
  const grouped = useMemo(() => {
    const groups: Record<EmotePackage, Emote[]> = {
      common: [],
      medal: [],
      guard: [],
      admin: [],
    };
    for (const emote of emotes) groups[emote.package_kind].push(emote);
    return PACKAGE_ORDER.map((kind) => [kind, groups[kind]] as const).filter(
      ([, items]) => items.length > 0,
    );
  }, [emotes]);

  const submit = async () => {
    const content = draft.trim();
    if (content.length === 0 || busy) return;
    setBusy(true);
    const outcome = await onSend(content);
    setBusy(false);
    // 只有确实发出去（或被吞）才清空草稿；失败保留内容便于重试。
    if (outcome !== undefined && outcome !== "failed") setDraft("");
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
                      onClick={() => setDraft((value) => value + emote.text)}
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
            ? `上次发送：${SEND_OUTCOME_TEXT[lastOutcome]}`
            : " "}
      </div>
    </>
  );
}
