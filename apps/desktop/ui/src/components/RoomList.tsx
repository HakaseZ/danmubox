import { QrLogin } from "./QrLogin";
import { useMemo, useState } from "react";

import type {
  AppInfo,
  FollowedRoom,
  RoomView as RoomViewData,
  SessionState,
} from "../types";
import styles from "../app.module.css";

interface Props {
  rooms: RoomViewData[];
  info?: AppInfo;
  session?: SessionState;
  profiles: string[];
  onSwitchProfile: (name: string) => void;
  onLogout: () => void;
  followed: FollowedRoom[];
  onAdd: (input: string) => void;
  onOpen: (roomId: number) => void;
  onRemove: (roomId: number) => void;
  onRefreshFollowed: () => void;
  onOpenFollowed: (roomId: number) => void;
}

/** 房间列表页：手动添加 + 已添加房间 + 关注列表（docs/ui.md §2）。 */
export function RoomList({
  rooms,
  info,
  session,
  profiles,
  onSwitchProfile,
  onLogout,
  followed,
  onAdd,
  onOpen,
  onRemove,
  onRefreshFollowed,
  onOpenFollowed,
}: Props) {
  const [input, setInput] = useState("");

  const submit = () => {
    const value = input.trim();
    if (value.length === 0) return;
    onAdd(value);
    setInput("");
  };

  // 按关注分组展示（需求 §2.6）。后端已按「直播中置顶」排好序，
  // 这里只做分组、保持组内相对顺序，因此每个分组里直播中的仍在前面。
  const followedGroups = useMemo(() => {
    const groups = new Map<string, FollowedRoom[]>();
    for (const item of followed) {
      const name = item.group_name.trim().length > 0 ? item.group_name : "未分组";
      const list = groups.get(name);
      if (list) list.push(item);
      else groups.set(name, [item]);
    }
    return [...groups.entries()];
  }, [followed]);

  return (
    <div className={styles.listPage}>
      <h1>弹幕框</h1>
      <div className={styles.subtitle}>
        {session?.logged_in
          ? `已登录：${session.nickname || session.uid}`
          : "游客态：可接收弹幕，发送需先登录"}
        {/* 账号切换（契约 §7）；后端会在切换后用新凭据重连各房间 */}
        <select
          className={styles.profilePick}
          title="切换账号（后端会用新凭据重连各房间）"
          value={session?.active_profile ?? ""}
          disabled={!session?.logged_in || profiles.length < 2}
          onChange={(event) => onSwitchProfile(event.target.value)}
        >
          {(profiles.length > 0 ? profiles : [session?.active_profile ?? ""])
            .filter((name) => name.length > 0)
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </select>
        {/* 扫码入口两种状态都给：登录态下扫码 = 重新登录（覆盖当前 profile 的凭据），
            这正是凭据失效时该走的路。 */}
        <QrLogin />
        {session?.logged_in && (
          <button onClick={onLogout} title="清空当前 profile 的凭据">
            登出
          </button>
        )}
        {info ? ` · v${info.version}` : ""}
      </div>

      <div className={styles.addRow}>
        <input
          value={input}
          placeholder="房间号 / 短号 / 直播间链接"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <button onClick={submit} disabled={input.trim().length === 0}>
          添加并打开
        </button>
      </div>

      {rooms.length === 0 ? (
        <div className={styles.empty}>还没有添加房间。输入房间号开始。</div>
      ) : (
        rooms.map((room) => (
          <div
            key={room.room_id}
            className={styles.roomCard}
            onClick={() => onOpen(room.room_id)}
          >
            <div className={styles.roomCardMain}>
              <div className={styles.roomTitle}>
                {room.title.length > 0 ? room.title : `房间 ${room.room_id}`}
              </div>
              <div className={styles.roomMeta}>
                {room.room_id}
                {room.short_id > 0 ? `（短号 ${room.short_id}）` : ""}
                {" · "}
                {room.live_status === 1 ? (
                  <span className={styles.live}>直播中</span>
                ) : (
                  <span className={styles.idle}>
                    {room.live_status === 2 ? "轮播" : "未开播"}
                  </span>
                )}
                {room.connected ? ` · 已连接（缓冲 ${room.buffered}）` : ""}
              </div>
            </div>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onRemove(room.room_id);
              }}
            >
              移除
            </button>
          </div>
        ))
      )}

      {session?.logged_in && (
        <div className={styles.followSection}>
          <div className={styles.followHeader}>
            <h2>关注（直播中置顶）</h2>
            <button onClick={onRefreshFollowed}>刷新</button>
          </div>
          {followed.length === 0 ? (
            <div className={styles.empty}>
              尚未拉取，或接口未实测通过（见 docs/protocol.md 的 A28）
            </div>
          ) : (
            followedGroups.map(([group, items]) => (
              <div key={group} className={styles.followGroup}>
                <div className={styles.followGroupName}>
                  {group}（{items.length}）
                </div>
                {items.map((item) => (
                  <div
                    key={item.room_id}
                    className={styles.followItem}
                    onClick={() => onOpenFollowed(item.room_id)}
                  >
                    <span className={styles.roomCardMain}>
                      {item.live_status === 1 && (
                        <span className={styles.live}>● </span>
                      )}
                      {item.uname}
                    </span>
                    <span className={styles.roomMeta}>{item.room_id}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
