import { useEffect, useMemo, useState } from "react";

import { AccountManager } from "./components/AccountManager";
import { RoomList } from "./components/RoomList";
import { LIVE_DOT_CLASS, LIVE_TEXT, RoomView, liveKindOf } from "./components/RoomView";
import { roomTabName, toDisplayRows } from "./filtering";
import { useApp } from "./store";
import styles from "./app.module.css";

export function App() {
  const info = useApp((state) => state.info);
  const session = useApp((state) => state.session);
  const rooms = useApp((state) => state.rooms);
  const activeRoomId = useApp((state) => state.activeRoomId);
  const messages = useApp((state) => state.messages);
  const status = useApp((state) => state.status);
  const prefs = useApp((state) => state.prefs);
  const logs = useApp((state) => state.logs);
  const lastSend = useApp((state) => state.lastSend);
  const error = useApp((state) => state.error);
  const notice = useApp((state) => state.notice);
  const seeding = useApp((state) => state.seeding);
  const emotes = useApp((state) => state.emotes);
  const ownedEmotes = useApp((state) => state.ownedEmotes);
  const ownedError = useApp((state) => state.ownedError);
  const accounts = useApp((state) => state.accounts);
  const loadAccounts = useApp((state) => state.loadAccounts);
  const switchAccount = useApp((state) => state.switchAccount);
  const removeAccount = useApp((state) => state.removeAccount);
  const logoutAccount = useApp((state) => state.logoutAccount);
  const loginCookie = useApp((state) => state.loginCookie);
  const qr = useApp((state) => state.qr);
  const qrState = useApp((state) => state.qrState);
  const qrError = useApp((state) => state.qrError);
  const startAccountQr = useApp((state) => state.startAccountQr);
  const cancelAccountQr = useApp((state) => state.cancelAccountQr);
  const pollAccountQr = useApp((state) => state.pollAccountQr);
  const followed = useApp((state) => state.followed);
  const balance = useApp((state) => state.balance);

  const [accountsOpen, setAccountsOpen] = useState(false);
  const bootstrap = useApp((state) => state.bootstrap);
  const addRoom = useApp((state) => state.addRoom);
  const removeRoom = useApp((state) => state.removeRoom);
  const openRoom = useApp((state) => state.openRoom);
  const closeRoom = useApp((state) => state.closeRoom);
  const disconnect = useApp((state) => state.disconnect);
  const refresh = useApp((state) => state.refresh);
  const send = useApp((state) => state.send);
  const report = useApp((state) => state.report);
  const loadFollowed = useApp((state) => state.loadFollowed);
  const updatePrefs = useApp((state) => state.updatePrefs);
  const dismissError = useApp((state) => state.dismissError);
  const setNotice = useApp((state) => state.setNotice);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 提示 3 秒后自动消失。
  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [notice, setNotice]);

  // 主题来自偏好；system 时跟随系统（并在系统外观变化时**实时**跟随）。
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const theme = prefs?.["ui.theme"] ?? "system";
    const apply = () => {
      const resolved = theme === "system" ? (media.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    // 只有 system 才订阅：显式浅色 / 深色时系统怎么变都与界面无关。
    // 首次绘制前的默认值由 index.html 的内联脚本给 —— prefs 要等 IPC 回来，
    // 否则浅色系统上会先画一帧深色再翻白。
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [prefs]);

  const rows = useMemo(
    () => (prefs ? toDisplayRows(messages, prefs) : []),
    [messages, prefs],
  );

  const activeRoom = rooms.find((room) => room.room_id === activeRoomId);

  // 多房间标签页（需求 §2.8）：房间本来就能同时连接，这里只是给一个切换入口。
  // **只在房间页里渲染**（用户 2026-09-12）：列表页已经有「已连接房间」卡片列表，
  // 两者做的是同一件事，主页再挂一条标签条是重复。房间页内部照旧。
  const roomTabs = (
    <div className={styles.tabs} data-testid="db-room-tabs">
      {rooms.map((room) => {
        // 标签页上那颗点**与房间头那颗是同一个东西**（用户 2026-09-13：「橙色的需求改成灰色，
        // 但是下面的标题栏左边还是之前的样子」）：同一个 `liveKindOf` 判据、同一套 `--live-*`
        // 令牌、同一条 `.liveDot` 规则，所以同一状态下必然是同一个色。
        const kind = liveKindOf(
          status[room.room_id]?.state,
          room.connected,
          room.live_status,
        );
        // 标签条报主播名，不报房间号（用户 #18）；拿不到主播名才退回直播间标题。
        const name = roomTabName(room);
        return (
          <button
            key={room.room_id}
            className={room.room_id === activeRoomId ? styles.tabActive : styles.tab}
            data-testid="db-room-tab"
            title={`${name} · ${LIVE_TEXT[kind]}`}
            onClick={() => void openRoom(room.room_id)}
          >
            <span
              className={`${styles.liveDot} ${LIVE_DOT_CLASS[kind]}`}
              data-testid="db-tab-dot"
              data-state={kind}
            />
            {name}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={styles.shell}>
      {activeRoom && prefs ? (
        <>
          {rooms.length > 1 && roomTabs}
          <RoomView
            room={activeRoom}
            rows={rows}
            prefs={prefs}
            session={session}
            lastOutcome={lastSend?.outcome}
            lastDetail={lastSend?.detail}
            logs={logs}
            emotes={emotes}
            ownedEmotes={ownedEmotes}
            ownedError={ownedError}
            balance={balance}
            onBack={closeRoom}
            onRefresh={() => void refresh(activeRoom.room_id)}
            onDisconnect={() => void disconnect(activeRoom.room_id)}
            onSend={(content, emote, reply) =>
              send(activeRoom.room_id, content, emote, reply)
            }
            onReport={async (message, reason) => {
              if (await report(message, reason)) setNotice("举报已提交");
            }}
            onPrefs={(patch) => void updatePrefs(patch)}
            onNotice={setNotice}
          />
        </>
      ) : (
        <RoomList
          rooms={rooms}
          info={info}
          session={session}
          followed={followed}
          recentWatched={prefs?.["ui.recent_watched"] ?? {}}
          theme={prefs?.["ui.theme"] ?? "system"}
          onTheme={(value) => void updatePrefs({ "ui.theme": value })}
          onAdd={(input) => void addRoom(input)}
          onOpen={(roomId) => void openRoom(roomId)}
          accounts={accounts}
          onOpenAccounts={() => {
            // 打开就先重拉一次：用户可能刚在别处登过号，列表必须说当下的事实。
            void loadAccounts();
            setAccountsOpen(true);
          }}
          onRemove={(roomId) => void removeRoom(roomId)}
          onRefreshFollowed={() => void loadFollowed()}
          onOpenFollowed={(roomId) => void addRoom(String(roomId))}
        />
      )}

      {accountsOpen && (
        <AccountManager
          accounts={accounts}
          session={session}
          qr={qr}
          qrState={qrState}
          qrError={qrError}
          onClose={() => {
            // 关掉对话框 = 放弃这次扫码：面板不再留在后台偷偷轮询。
            cancelAccountQr();
            setAccountsOpen(false);
          }}
          onSwitch={(name) => void switchAccount(name)}
          onLogout={(name) => void logoutAccount(name)}
          onRemove={(name) => void removeAccount(name)}
          onStartQr={(target) => void startAccountQr(target)}
          onCancelQr={cancelAccountQr}
          onPollQr={() => void pollAccountQr()}
          onLoginCookie={loginCookie}
        />
      )}

      {seeding && (
        <div className={styles.composerHint}>正在载入本次会话的弹幕…</div>
      )}

      {notice !== undefined && (
        <div className={`${styles.error} ${styles.notice}`}>
          <span>{notice}</span>
        </div>
      )}

      {error !== undefined && (
        <div className={styles.error}>
          <span>{error}</span>
          <button onClick={dismissError}>关闭</button>
        </div>
      )}
    </div>
  );
}
