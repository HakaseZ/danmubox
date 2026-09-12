import { useEffect, useMemo, useState } from "react";

import { Composer } from "./Composer";
import { ContextMenu, type MenuItem, type MenuPoint } from "./ContextMenu";
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
  onNotice: (text: string) => void;
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

/**
 * 房间页。从左到右、从上到下只有一条生长轴（issue #8 的重排）：
 *
 * ```
 * [头部：返回 · ●状态 · 标题 ······ 在线 · 看过 · 电池 · ⋯菜单]
 * [弹幕列表  ← 唯一的 flex-1 生长/滚动区]
 * [弹出面板（表情 / 短语 / 最近 / 筛选）← 向上展开，列表自动上弹]
 * [输入区：输入框 + 工具行 + 发送]
 * [礼物 / SC 栏 ← 在输入区下方，可折叠]
 * ```
 *
 * 面板与礼物栏都在正常文档流里（不是浮层），所以展开时只会挤压弹幕列表，不会盖住最新弹幕。
 */
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
  onNotice,
}: Props) {
  const [showLogs, setShowLogs] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<MenuPoint | null>(null);
  const [messageMenu, setMessageMenu] = useState<{ at: MenuPoint; message: Message } | null>(null);
  const [reportTarget, setReportTarget] = useState<Message>();
  const [giftOpen, setGiftOpen] = useState(false);
  // 行菜单里点的 @ / 回复：交给 Composer 应用。
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

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotice("已复制");
    } catch (error) {
      onNotice(`复制失败：${String(error)}`);
    }
  };

  /** 行右键菜单（issue #8：举报 / @ / 回复等一律收到菜单里）。 */
  const messageMenuItems = (message: Message): MenuItem[] => {
    const mine = session !== undefined && message.uid === session.uid;
    const isDanmaku = message.kind === "danmaku";
    return [
      {
        label: "复制内容",
        disabled: message.content.length === 0,
        hint: message.content.length === 0 ? "这条没有文字内容" : undefined,
        onSelect: () => void copyText(message.content),
      },
      {
        label: "复制昵称",
        disabled: message.uname.length === 0,
        onSelect: () => void copyText(message.uname),
      },
      {
        label: "＠TA",
        disabled: !isDanmaku || message.uname.length === 0 || mine,
        hint: mine ? "这是你自己" : "只有弹幕能 @",
        onSelect: () =>
          setPendingAction({ kind: "mention", message, token: Date.now() }),
      },
      {
        label: "回复",
        disabled: !isDanmaku || mine,
        hint: mine ? "这是你自己" : "只有弹幕能回复",
        onSelect: () =>
          setPendingAction({ kind: "reply", message, token: Date.now() }),
      },
      {
        label: "屏蔽此用户",
        disabled: message.uid === 0,
        hint: message.uid === 0 ? "游客没有 UID，无法屏蔽" : undefined,
        onSelect: () =>
          onPrefs({
            "filter.uids": [...new Set([...prefs["filter.uids"], message.uid])],
          }),
      },
      {
        label: "打开主页",
        disabled: message.uid === 0,
        hint: message.uid === 0 ? "游客没有主页" : undefined,
        onSelect: () => void openProfile(message.uid),
      },
      {
        label: "举报",
        disabled: !isDanmaku || message.upstream_id.length === 0 || !loggedIn,
        hint: !loggedIn
          ? "需登录后举报"
          : message.upstream_id.length === 0
            ? "缺少上游标识，无法举报"
            : undefined,
        onSelect: () => setReportTarget(message),
      },
    ];
  };

  const headerMenuItems: MenuItem[] = [
    { label: "刷新连接", onSelect: onRefresh },
    {
      label: "断开连接",
      disabled: !room.connected,
      hint: room.connected ? undefined : "当前未连接",
      onSelect: onDisconnect,
    },
    {
      label: showLogs ? "隐藏日志" : "显示日志",
      onSelect: () => setShowLogs((value) => !value),
    },
  ];

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
        <span className={styles.headerSpacer} />
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
        {balance !== undefined && (
          <span className={styles.balance}>电池 {balance}</span>
        )}
        <button
          title="刷新 / 断开 / 日志"
          aria-label="更多"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHeaderMenu({ x: rect.left - 120, y: rect.bottom + 2 });
          }}
        >
          ⋯
        </button>
      </div>

      {/* 唯一的生长区：面板与礼物栏展开时只有它会变矮 */}
      <MessageList
        rows={chatRows}
        anchorUid={room.anchor_uid}
        prefs={prefs}
        onMenu={(message, at) => setMessageMenu({ at, message })}
      />

      {messageMenu && (
        <ContextMenu
          at={messageMenu.at}
          items={messageMenuItems(messageMenu.message)}
          onClose={() => setMessageMenu(null)}
        />
      )}

      {showLogs && (
        <div className={styles.logs}>
          {logs.length === 0
            ? "（暂无日志）"
            : logs.map((line, index) => <div key={index}>{line}</div>)}
        </div>
      )}

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

      <Composer
        disabled={!room.connected}
        loggedIn={loggedIn}
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
        onNotice={onNotice}
      />

      {/* 礼物 / SC 栏在输入区下方（issue #8）：把宽度还给弹幕，可折叠 */}
      {separateGifts && (
        <div className={styles.giftDock} data-testid="db-gift-dock">
          <button
            className={styles.giftDockHead}
            aria-expanded={giftOpen}
            onClick={() => setGiftOpen((value) => !value)}
          >
            <span className={styles.giftDockTitle}>礼物 / SC（{giftRows.length}）</span>
            <span className={styles.giftDockSummary}>
              {giftStats.total > 0
                ? `本场 ${giftStats.total.toLocaleString()} 瓜子`
                : "本场暂无礼物"}
            </span>
            <span className={styles.giftDockToggle}>{giftOpen ? "收起" : "展开"}</span>
          </button>
          {giftOpen && (
            <div className={styles.giftDockBody} data-testid="db-gift-body">
              {giftStats.ranking.length > 0 && (
                <div className={styles.giftStats}>
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
      )}

      {headerMenu && (
        <ContextMenu
          at={headerMenu}
          items={headerMenuItems}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </div>
  );
}
