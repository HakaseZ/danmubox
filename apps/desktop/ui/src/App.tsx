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
  const seeding = useApp((state) => state.seeding);

  const bootstrap = useApp((state) => state.bootstrap);
  const addRoom = useApp((state) => state.addRoom);
  const removeRoom = useApp((state) => state.removeRoom);
  const openRoom = useApp((state) => state.openRoom);
  const closeRoom = useApp((state) => state.closeRoom);
  const disconnect = useApp((state) => state.disconnect);
  const refresh = useApp((state) => state.refresh);
  const send = useApp((state) => state.send);
  const updatePrefs = useApp((state) => state.updatePrefs);
  const dismissError = useApp((state) => state.dismissError);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

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
          logs={logs}
          onBack={closeRoom}
          onRefresh={() => void refresh(activeRoom.room_id)}
          onDisconnect={() => void disconnect(activeRoom.room_id)}
          onSend={(content) => send(activeRoom.room_id, content)}
          onPrefs={(patch) => void updatePrefs(patch)}
        />
      ) : (
        <RoomList
          rooms={rooms}
          info={info}
          session={session}
          onAdd={(input) => void addRoom(input)}
          onOpen={(roomId) => void openRoom(roomId)}
          onRemove={(roomId) => void removeRoom(roomId)}
        />
      )}

      {seeding && (
        <div className={styles.composerHint}>正在载入本次会话的弹幕…</div>
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
