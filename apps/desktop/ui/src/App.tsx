import { useEffect, useMemo } from "react";

import { RoomList } from "./components/RoomList";
import { RoomView } from "./components/RoomView";
import { toDisplayRows } from "./filtering";
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
  const followed = useApp((state) => state.followed);
  const balance = useApp((state) => state.balance);

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

  // 主题来自偏好；system 时跟随系统。
  useEffect(() => {
    const theme = prefs?.["ui.theme"] ?? "system";
    const resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : theme;
    document.documentElement.dataset.theme = resolved;
  }, [prefs]);

  const rows = useMemo(
    () => (prefs ? toDisplayRows(messages, prefs) : []),
    [messages, prefs],
  );

  const activeRoom = rooms.find((room) => room.room_id === activeRoomId);

  return (
    <div className={styles.shell}>
      {activeRoom && prefs ? (
        <RoomView
          room={activeRoom}
          rows={rows}
          status={status[activeRoom.room_id]}
          prefs={prefs}
          session={session}
          lastOutcome={lastSend?.outcome}
          lastDetail={lastSend?.detail}
          logs={logs}
          emotes={emotes}
          balance={balance}
          onBack={closeRoom}
          onRefresh={() => void refresh(activeRoom.room_id)}
          onDisconnect={() => void disconnect(activeRoom.room_id)}
          onSend={(content) => send(activeRoom.room_id, content)}
          onReport={async (message, reason) => {
            if (await report(message, reason)) setNotice("举报已提交");
          }}
          onPrefs={(patch) => void updatePrefs(patch)}
        />
      ) : (
        <RoomList
          rooms={rooms}
          info={info}
          session={session}
          followed={followed}
          onAdd={(input) => void addRoom(input)}
          onOpen={(roomId) => void openRoom(roomId)}
          onRemove={(roomId) => void removeRoom(roomId)}
          onRefreshFollowed={() => void loadFollowed()}
          onOpenFollowed={(roomId) => void addRoom(String(roomId))}
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
