import { useEffect, useState } from "react";

import { Composer } from "./Composer";
import { FilterBar } from "./FilterBar";
import { MessageList } from "./MessageList";
import { useApp } from "../store";
import type { DisplayRow } from "../filtering";
import type {
  ConnState,
  Emote,
  Message,
  Prefs,
  RoomView as RoomViewData,
  SendOutcome,
  SessionState,
} from "../types";
import styles from "../app.module.css";

interface Props {
  room: RoomViewData;
  rows: DisplayRow[];
  status?: { state: ConnState; detail: string };
  prefs: Prefs;
  session?: SessionState;
  lastOutcome?: SendOutcome;
  logs: string[];
  emotes: Emote[];
  balance?: number;
  onBack: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onSend: (content: string) => Promise<SendOutcome | undefined>;
  onReport: (message: Message, reason: string) => Promise<void>;
  onPrefs: (patch: Partial<Prefs>) => void;
}

const DOT: Record<ConnState, string> = {
  connected: styles.dotConnected,
  connecting: styles.dotConnecting,
  disconnected: styles.dotDisconnected,
  error: styles.dotError,
};

const STATE_TEXT: Record<ConnState, string> = {
  connected: "已连接",
  connecting: "连接中",
  disconnected: "已断开",
  error: "异常",
};

/** 房间页：状态头 + 过滤条 + 聊天流（+ 可选独立礼物栏）+ 输入区。 */
export function RoomView({
  room,
  rows,
  status,
  prefs,
  session,
  lastOutcome,
  logs,
  emotes,
  balance,
  onBack,
  onRefresh,
  onDisconnect,
  onSend,
  onReport,
  onPrefs,
}: Props) {
  const [showLogs, setShowLogs] = useState(false);
  const [reportTarget, setReportTarget] = useState<Message>();
  const [reason, setReason] = useState("");
  const state = status?.state ?? "disconnected";
  const separateGifts = prefs["ui.gift_panel_mode"] === "separate";

  // 从 store 直接取 action：它的身份在渲染之间是稳定的，
  // 所以下面的 effect 只会在登录态变化时触发。经 props 传内联闭包会导致每次渲染都重跑（曾因此死循环）。
  const loadBalance = useApp((store) => store.loadBalance);
  const loadEmotes = useApp((store) => store.loadEmotes);
  const loggedIn = session?.logged_in ?? false;

  useEffect(() => {
    if (loggedIn) void loadBalance();
  }, [loggedIn, loadBalance]);

  const giftRows = separateGifts
    ? rows.filter((row) =>
        ["gift", "superchat", "guard"].includes(row.message.kind),
      )
    : [];
  const chatRows = separateGifts
    ? rows.filter(
        (row) => !["gift", "superchat", "guard"].includes(row.message.kind),
      )
    : rows;

  return (
    <div className={styles.shell}>
      <div className={styles.roomHeader}>
        <button onClick={onBack}>返回</button>
        <span className={`${styles.dot} ${DOT[state]}`} />
        <span className={styles.title}>
          {room.title.length > 0 ? room.title : `房间 ${room.room_id}`}
        </span>
        <span className={styles.roomMeta}>
          {STATE_TEXT[state]}
          {status?.detail ? `（${status.detail}）` : ""}
        </span>
        {balance !== undefined && (
          <span className={styles.balance}>电池 {balance}</span>
        )}
        <button onClick={onRefresh} title="长连接卡住或推流中断时手动重连">
          刷新
        </button>
        <button onClick={onDisconnect} disabled={!room.connected}>
          断开
        </button>
        <button onClick={() => setShowLogs((value) => !value)}>
          {showLogs ? "隐藏日志" : "日志"}
        </button>
      </div>

      <FilterBar prefs={prefs} onChange={onPrefs} />

      <div className={styles.body}>
        <MessageList
          rows={chatRows}
          anchorUid={room.anchor_uid}
          prefs={prefs}
          onReport={setReportTarget}
        />
        {separateGifts && (
          <div className={styles.giftPanel}>
            <h2>礼物 / SC</h2>
            {giftRows.length === 0 ? (
              <div className={styles.empty}>本场还没有礼物</div>
            ) : (
              giftRows.map((row) => (
                <div key={row.message.local_id} className={styles.giftItem}>
                  {row.message.uname} {row.message.content}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <Composer
        disabled={!room.connected}
        loggedIn={session?.logged_in ?? false}
        lastOutcome={lastOutcome}
        emotes={emotes}
        onSend={onSend}
        onOpenEmotes={() => void loadEmotes(room.room_id)}
      />

      {reportTarget && (
        <div className={styles.reportBar}>
          <span className={styles.roomMeta}>
            举报「{reportTarget.content.slice(0, 24)}」
          </span>
          <input
            value={reason}
            placeholder="举报理由（取值尚未实测，按原文提交）"
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            disabled={reason.trim().length === 0}
            onClick={() => {
              const target = reportTarget;
              setReportTarget(undefined);
              setReason("");
              void onReport(target, reason.trim());
            }}
          >
            提交举报
          </button>
          <button
            onClick={() => {
              setReportTarget(undefined);
              setReason("");
            }}
          >
            取消
          </button>
        </div>
      )}

      {showLogs && (
        <div className={styles.logs}>
          {logs.length === 0
            ? "（暂无日志）"
            : logs.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}
    </div>
  );
}
