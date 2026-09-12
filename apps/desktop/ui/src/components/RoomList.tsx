import { useMemo, useState } from "react";

import { Avatar } from "./Avatar";
import { QrLogin } from "./QrLogin";
import { FOLLOW_PAGE_SIZE, formatLastLive, paginate, sortFollowedRooms } from "../filtering";
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
  onCreateProfile: (name: string) => void;
  onRemoveProfile: (name: string) => void;
  onLogout: () => void;
  followed: FollowedRoom[];
  onAdd: (input: string) => void;
  onOpen: (roomId: number) => void;
  onRemove: (roomId: number) => void;
  onRefreshFollowed: () => void;
  onOpenFollowed: (roomId: number) => void;
}

const LIVE_LABEL: Record<number, string> = {
  0: "未开播",
  1: "直播中",
  2: "轮播中",
};

/**
 * 房间列表页：账号区 + 手动添加 + 已添加房间 + 关注列表（docs/ui.md §2）。
 *
 * 关注列表按「直播中置顶 → 最后开播时间近的在前」排序并分页（需求 §2.11）。
 */
export function RoomList({
  rooms,
  info,
  session,
  profiles,
  onSwitchProfile,
  onCreateProfile,
  onRemoveProfile,
  onLogout,
  followed,
  onAdd,
  onOpen,
  onRemove,
  onRefreshFollowed,
  onOpenFollowed,
}: Props) {
  const [input, setInput] = useState("");
  const [newProfile, setNewProfile] = useState("");
  const [profilePick, setProfilePick] = useState("");
  const [page, setPage] = useState(1);
  // 新账号建好后自动走一次扫码：新建的 profile 就是当前 profile，扫码即写入它的凭据。
  const [qrStartToken, setQrStartToken] = useState(0);

  const submit = () => {
    const value = input.trim();
    if (value.length === 0) return;
    onAdd(value);
    setInput("");
  };

  const sortedFollowed = useMemo(() => sortFollowedRooms(followed), [followed]);
  const paged = paginate(sortedFollowed, page);

  const activeProfile = session?.active_profile ?? "";
  const pickedProfile = profilePick.length > 0 ? profilePick : activeProfile;
  const canRemoveProfile =
    profiles.length > 1 && pickedProfile.length > 0 && pickedProfile !== activeProfile;

  return (
    <div className={styles.listPage}>
      <h1>弹幕框</h1>

      {/* 账号区：登录态 + 多账号并存（issue #1）。新增账号先建 profile，再扫码写入凭据 */}
      <div className={styles.account} data-testid="db-account">
        <div className={styles.accountWho}>
          {session?.logged_in
            ? `已登录：${session.nickname || session.uid}`
            : "游客态：可接收弹幕，发送需先登录"}
          {info ? ` · v${info.version}` : ""}
        </div>
        <div className={styles.accountRow}>
          <label>
            账号
            <select
              className={styles.profilePick}
              title="切换账号（后端会用新凭据重连各房间）"
              value={pickedProfile}
              onChange={(event) => {
                setProfilePick(event.target.value);
                onSwitchProfile(event.target.value);
              }}
            >
              {(profiles.length > 0 ? profiles : [activeProfile])
                .filter((name) => name.length > 0)
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                    {name === activeProfile ? "（当前）" : ""}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={!canRemoveProfile}
            title={
              profiles.length <= 1
                ? "至少保留一个账号"
                : pickedProfile === activeProfile
                  ? "当前正在用的账号不能删，先切到另一个账号"
                  : `删除账号 ${pickedProfile}（会清掉它的凭据）`
            }
            onClick={() => {
              onRemoveProfile(pickedProfile);
              setProfilePick("");
            }}
          >
            删除该账号
          </button>
          <label>
            新增账号
            <input
              value={newProfile}
              size={10}
              placeholder="账号名"
              onChange={(event) => setNewProfile(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                const name = newProfile.trim();
                if (name.length === 0 || profiles.includes(name)) return;
                onCreateProfile(name);
                setNewProfile("");
                setProfilePick(name);
                setQrStartToken((value) => value + 1);
              }}
            />
          </label>
          <button
            disabled={newProfile.trim().length === 0 || profiles.includes(newProfile.trim())}
            title="新建一个账号并切过去，接着扫码登录"
            onClick={() => {
              const name = newProfile.trim();
              onCreateProfile(name);
              setNewProfile("");
              setProfilePick(name);
              setQrStartToken((value) => value + 1);
            }}
          >
            新建并扫码
          </button>
          {/* 扫码入口两种状态都给：登录态下扫码 = 重新登录（覆盖当前 profile 的凭据） */}
          <QrLogin startToken={qrStartToken} />
          {session?.logged_in && (
            <button onClick={onLogout} title="清空当前 profile 的凭据">
              登出
            </button>
          )}
        </div>
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
            data-testid="db-room-card"
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
            <h2>关注（{sortedFollowed.length}）</h2>
            <button onClick={onRefreshFollowed}>刷新</button>
          </div>
          {sortedFollowed.length === 0 ? (
            <div className={styles.empty}>
              没有关注的人，或接口未实测通过（见 docs/protocol.md 的 A28）
            </div>
          ) : (
            <>
              {paged.items.map((item) => (
                <div
                  key={item.room_id}
                  className={styles.followItem}
                  data-testid="db-follow-item"
                  onClick={() => onOpenFollowed(item.room_id)}
                >
                  <Avatar url={item.face} name={item.uname} />
                  <span className={styles.followName}>{item.uname}</span>
                  <span
                    className={item.live_status === 1 ? styles.live : styles.idle}
                  >
                    {LIVE_LABEL[item.live_status] ?? "未开播"}
                  </span>
                  <span className={styles.headerSpacer} />
                  {formatLastLive(item.live_start_at) && (
                    <span className={styles.roomMeta} title="最后开播时间（上游 liveTime）">
                      最后开播 {formatLastLive(item.live_start_at)}
                    </span>
                  )}
                  {item.group_name.length > 0 && (
                    <span className={styles.roomMeta}>{item.group_name}</span>
                  )}
                  <span className={styles.roomMeta}>{item.room_id}</span>
                </div>
              ))}
              {paged.pageCount > 1 && (
                <div className={styles.pager}>
                  <button
                    disabled={paged.page <= 1}
                    onClick={() => setPage(paged.page - 1)}
                  >
                    上一页
                  </button>
                  <span className={styles.roomMeta}>
                    {paged.page} / {paged.pageCount}（每页 {FOLLOW_PAGE_SIZE}）
                  </span>
                  <button
                    disabled={paged.page >= paged.pageCount}
                    onClick={() => setPage(paged.page + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
