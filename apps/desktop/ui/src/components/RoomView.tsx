import { useEffect, useMemo, useState } from "react";

import { Composer } from "./Composer";
import { FilterBar } from "./FilterBar";
import { MessageList } from "./MessageList";
import { useApp } from "../store";
import { formatCount, type DisplayRow } from "../filtering";
import type {
  ConnState,
  Emote,
  Message,
  Prefs,
  RoomView as RoomViewData,
  EmoteToken,
  ReportReason,
  ReplyTarget,
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
  lastDetail?: string | null;
  logs: string[];
  emotes: Emote[];
  /** 从收到的弹幕里学到的表情，补进选择器（见 filtering.collectSeenEmotes）。 */
  seenEmotes: Emote[];
  recentSends: string[];
  balance?: number;
  onBack: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  onSend: (
    content: string,
    emote?: EmoteToken,
    reply?: ReplyTarget,
  ) => Promise<SendOutcome | undefined>;
  onReport: (message: Message, reason: ReportReason) => Promise<void>;
  onPrefs: (patch: Partial<Prefs>) => void;
}

/** 连接状态 → 圆点样式（房间头部与多房间标签页共用）。 */
export const DOT: Record<ConnState, string> = {
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
  lastDetail,
  logs,
  emotes,
  seenEmotes,
  recentSends,
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
  // 行悬浮菜单里点的 @ / 回复：交给 Composer 应用。
  // 带 token 是为了「每点一次应用一次」——同一个对象引用重复触发容易写成死循环。
  const [pendingAction, setPendingAction] = useState<{
    kind: "mention" | "reply";
    message: Message;
    token: number;
  } | null>(null);
  // 举报理由改用上游固定清单（`dReport/ForReason`，实测 7 条）：
  // 官方客户端按文案反查 `reason_id` 后与文案一起上报，因此界面不该让用户手输。
  const [reasonId, setReasonId] = useState("");
  const state = status?.state ?? "disconnected";
  const separateGifts = prefs["ui.gift_panel_mode"] === "separate";

  // 从 store 直接取 action：它的身份在渲染之间是稳定的，
  // 所以下面的 effect 只会在登录态变化时触发。经 props 传内联闭包会导致每次渲染都重跑（曾因此死循环）。
  const loadBalance = useApp((store) => store.loadBalance);
  const loadEmotes = useApp((store) => store.loadEmotes);
  const reportReasons = useApp((store) => store.reportReasons);
  const loadReportReasons = useApp((store) => store.loadReportReasons);
  const openProfile = useApp((store) => store.openProfile);
  const roomStats = useApp((store) => store.roomStats[room.room_id]);
  const loggedIn = session?.logged_in ?? false;

  useEffect(() => {
    if (loggedIn) void loadBalance();
  }, [loggedIn, loadBalance]);

  // 进房间就把表情加载好：输入区的「将发送」预览要靠它把表情名换成图片，
  // 若等到用户打开面板才加载，打字时就没有可匹配的表情（预览会静默失效）。
  useEffect(() => {
    if (loggedIn) void loadEmotes(room.room_id);
  }, [loggedIn, loadEmotes, room.room_id]);

  useEffect(() => {
    if (reportTarget) void loadReportReasons();
  }, [reportTarget, loadReportReasons]);

  // 礼物金额统计与排行（需求 §2.7）：只算本次会话；金额口径是金瓜子（协议 §10.2）。
  const giftStats = useMemo(() => {
    const byUser = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      if (row.message.kind !== "gift") continue;
      total += row.message.amount;
      const who = row.message.uname.length > 0 ? row.message.uname : `uid ${row.message.uid}`;
      byUser.set(who, (byUser.get(who) ?? 0) + row.message.amount);
    }
    return {
      total,
      ranking: [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [rows]);

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
        {(roomStats?.online !== undefined || roomStats?.watched !== undefined) && (
          <span className={styles.roomMeta}>
            {roomStats?.online !== undefined && (
              <span className={styles.balance} title="在线人数（协议 §10.7 的 ONLINE_RANK_COUNT）">
                在线 {formatCount(roomStats.online)}
              </span>
            )}
            {roomStats?.watched !== undefined && (
              <span className={styles.balance} title="累计看过（协议 §10.7 的 WATCHED_CHANGE）">
                看过 {formatCount(roomStats.watched)}
              </span>
            )}
          </span>
        )}
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
          onMention={(message) =>
            setPendingAction({ kind: "mention", message, token: Date.now() })
          }
          onReply={(message) =>
            setPendingAction({ kind: "reply", message, token: Date.now() })
          }
          onOpenProfile={(uid) => void openProfile(uid)}
          onReport={setReportTarget}
        />
        {separateGifts && (
          <div className={styles.giftPanel}>
            <h2>礼物 / SC</h2>
            {giftStats.total > 0 && (
              <div className={styles.giftStats}>
                <div>本场礼物 {giftStats.total.toLocaleString()} 瓜子</div>
                {giftStats.ranking.map(([who, amount], index) => (
                  <div key={who} className={styles.giftRankItem}>
                    {index + 1}. {who} · {amount.toLocaleString()}
                  </div>
                ))}
              </div>
            )}
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
        lastDetail={lastDetail}
        emotes={emotes}
        seenEmotes={seenEmotes}
        recentSends={recentSends}
        pendingAction={pendingAction}
        prefs={prefs}
        onPrefs={onPrefs}
        onSend={onSend}
        onOpenEmotes={() => void loadEmotes(room.room_id)}
      />

      {reportTarget && (
        <div className={styles.reportBar}>
          <span className={styles.roomMeta}>
            举报「{reportTarget.content.slice(0, 24)}」
          </span>
          <select
            value={reasonId}
            onChange={(event) => setReasonId(event.target.value)}
          >
            <option value="">
              {reportReasons.length === 0 ? "理由清单加载中…" : "选择举报理由…"}
            </option>
            {reportReasons.map((item) => (
              <option key={item.id} value={String(item.id)}>
                {item.reason}
              </option>
            ))}
          </select>
          <button
            disabled={reasonId === ""}
            onClick={() => {
              const picked = reportReasons.find(
                (item) => String(item.id) === reasonId,
              );
              if (!picked || !reportTarget) return;
              const target = reportTarget;
              setReportTarget(undefined);
              setReasonId("");
              void onReport(target, picked);
            }}
          >
            提交举报
          </button>
          <button
            onClick={() => {
              setReportTarget(undefined);
              setReasonId("");
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
