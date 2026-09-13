import { useMemo, useState } from "react";

import { Avatar } from "./Avatar";
import {
  FOLLOW_PAGE_SIZE,
  formatLastLive,
  paginate,
  roomDisplayName,
  sortFollowedRooms,
} from "../filtering";
import type {
  Account,
  AppInfo,
  FollowedRoom,
  Prefs,
  RoomView as RoomViewData,
  SessionState,
} from "../types";
import styles from "../app.module.css";

interface Props {
  rooms: RoomViewData[];
  info?: AppInfo;
  session?: SessionState;
  /** 全部账号：用来在账号区显示「当前是谁」。 */
  accounts: Account[];
  /** 打开账号管理对话框；切换 / 添加 / 重新登录 / 退出登录都在那里。 */
  onOpenAccounts: () => void;
  followed: FollowedRoom[];
  /** `ui.recent_watched`：房间号 → 最近一次打开的时刻，关注列表据此降序（用户 #16）。 */
  recentWatched: Record<string, number>;
  /** `ui.theme` 当前档位。列表页页头是它**唯一**的开关（用户 2026-09-13 #10）。 */
  theme: Prefs["ui.theme"];
  /** 写回 `ui.theme`；落到 `<html data-theme>` 由 App 的 effect 负责（本组件只写偏好）。 */
  onTheme: (value: Prefs["ui.theme"]) => void;
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
 * 关注列表按「直播中置顶 → 最近观看降序 → 最后开播时间近的在前」排序并分页
 * （需求 §2.11、用户 #14–#16）；行内只出现头像 / 主播名 / 直播标题 / 状态 / 最后开播时间，
 * **不出现房间号**（用户 #14/#15/#17）。宽窄屏的两种排布见 app.module.css 的 `.followItem`。
 */
export function RoomList({
  rooms,
  info,
  session,
  accounts,
  onOpenAccounts,
  followed,
  recentWatched,
  theme,
  onTheme,
  onAdd,
  onOpen,
  onRemove,
  onRefreshFollowed,
  onOpenFollowed,
}: Props) {
  const [input, setInput] = useState("");
  const [page, setPage] = useState(1);

  const submit = () => {
    const value = input.trim();
    if (value.length === 0) return;
    onAdd(value);
    setInput("");
  };

  const sortedFollowed = useMemo(
    () => sortFollowedRooms(followed, recentWatched),
    [followed, recentWatched],
  );
  const paged = paginate(sortedFollowed, page);

  // 当前身份：账号列表里的 `active` 条目为准（它带昵称/uid/头像）；拉不到时退回会话里的两个字段，
  // 免得账号区整块空着。游客态没有账号条目，直接显示「游客态」。
  const active = accounts.find((account) => account.active);
  const loggedIn = session?.logged_in ?? false;
  const nickname = active?.nickname ?? session?.nickname ?? "";
  const uid = active?.uid ?? session?.uid ?? 0;

  return (
    <div className={styles.listPage} data-testid="db-list-page">
      {/*
        页头一行：标题在左、**主题开关**在右（用户 2026-09-13 #10：主题是全局的，主界面就该能切）。
        开关原先在房间页筛选面板的「显示」块里 —— 那里只有进房间、且展开面板才够得着，
        与「全局」不符。三档取值仍是 `ui.theme`（契约 §8），落到 `<html data-theme>` 由 App 的
        effect 负责；这里只写偏好，不做第二处解析。
      */}
      <div className={styles.listHeader}>
        <h1>弹幕框</h1>
        <label
          className={styles.themePicker}
          title="跟随系统 = 随操作系统外观自动切换；整应用一套深浅配色"
        >
          主题
          <select
            data-testid="db-pref-theme"
            value={theme}
            onChange={(event) => onTheme(event.target.value as Prefs["ui.theme"])}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
      </div>

      {/*
        账号区只留一行：当前身份 + 一个「账号」按钮（用户 2026-09-12：「切换身份的功能好像没法选」）。
        切换**不再做成下拉**——只有一个账号时下拉里就一项，看起来像控件坏了；
        完整列表与所有操作都在账号管理对话框里（AccountManager）。
      */}
      <div className={styles.account} data-testid="db-account">
        <div className={styles.accountIdentity}>
          {loggedIn ? (
            <>
              <Avatar url={active?.face} name={nickname} />
              <span className={styles.accountName} data-testid="db-account-name">
                {nickname.length > 0 ? nickname : `uid ${uid}`}
              </span>
              <span className={styles.accountMeta} data-testid="db-account-uid">
                uid {uid}
              </span>
            </>
          ) : (
            <span className={styles.accountGuest} data-testid="db-account-guest">
              游客态：可接收弹幕，发送需先登录
            </span>
          )}
          {info && <span className={styles.accountMeta}>v{info.version}</span>}
        </div>
        <button
          data-testid="db-account-open"
          title="管理账号：切换 / 添加 / 重新登录 / 退出登录"
          onClick={onOpenAccounts}
        >
          账号
        </button>
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
              {/* 连接的房间列表只报「谁 · 哪个直播间」，不报房间号（用户 #17）。 */}
              <div className={styles.roomTitle} data-testid="db-room-name" title="主播 · 直播间">
                {roomDisplayName(room)}
              </div>
              <div className={styles.roomMeta}>
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
              {paged.items.map((item) => {
                const lastLive = formatLastLive(item.live_start_at);
                return (
                  <div
                    key={item.room_id}
                    className={styles.followItem}
                    data-testid="db-follow-item"
                    onClick={() => onOpenFollowed(item.room_id)}
                  >
                    {/* 头像列永远占位：上游没给 face 的条目也要和别的条目左对齐。 */}
                    <span className={styles.followAvatar}>
                      <Avatar url={item.face} name={item.uname} />
                    </span>
                    {/* 宽屏时这一层是 flex（名字 + 标题并排在左半边）；窄屏时被「摊平」
                        （`display: contents`），名字与标题各自落到第一排 / 第二排的网格里。 */}
                    <span className={styles.followWho}>
                      <span className={styles.followName} data-testid="db-follow-name">
                        {item.uname}
                      </span>
                      {item.title.length > 0 && (
                        <span
                          className={styles.followTitle}
                          data-testid="db-follow-title"
                          title={item.title}
                        >
                          {item.title}
                        </span>
                      )}
                    </span>
                    <span
                      className={`${styles.followStatus} ${
                        item.live_status === 1 ? styles.live : styles.idle
                      }`}
                      data-testid="db-follow-status"
                    >
                      {LIVE_LABEL[item.live_status] ?? "未开播"}
                    </span>
                    {lastLive.length > 0 && (
                      <span
                        className={styles.followLastLive}
                        data-testid="db-follow-last-live"
                        title="最后开播时间（上游 liveTime）"
                      >
                        最后开播 {lastLive}
                      </span>
                    )}
                  </div>
                );
              })}
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
