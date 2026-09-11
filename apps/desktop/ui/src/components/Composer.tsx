import { useState } from "react";

import { SEND_OUTCOME_TEXT, type SendOutcome } from "../types";
import styles from "../app.module.css";

interface Props {
  disabled: boolean;
  loggedIn: boolean;
  lastOutcome?: SendOutcome;
  onSend: (content: string) => Promise<SendOutcome | undefined>;
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

export function Composer({ disabled, loggedIn, lastOutcome, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

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
      <div className={styles.composer}>
        <textarea
          value={draft}
          placeholder={loggedIn ? "说点什么…（Enter 发送，Shift+Enter 换行）" : "未登录，只能看弹幕"}
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
      <div className={`${styles.composerHint} ${lastOutcome ? (OUTCOME_CLASS[lastOutcome] ?? "") : ""}`}>
        {!loggedIn
          ? "未登录：仅能接收弹幕，发送需要先在凭据文件中登录"
          : lastOutcome
            ? `上次发送：${SEND_OUTCOME_TEXT[lastOutcome]}`
            : " "}
      </div>
    </>
  );
}
