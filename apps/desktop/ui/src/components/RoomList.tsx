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
  /** `ui.theme` 当前档位。列表页页头那枚按钮是它**唯一**的开关（用户 2026-09-13 #10 / #7）。 */
  theme: Prefs["ui.theme"];
  /**
   * 写回 `ui.theme`；落到 `<html data-theme>` 由 App 的 effect 负责（本组件只写偏好）。
   * 页头按钮只调它、不自己改档 —— 下一档由 `THEME_NEXT` 从当前 prop 算。
   */
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
 * 主题按钮的三态环：**亮 → 暗 → 自动**（用户 2026-09-13 #7：「主题切换模仿安卓或 ios 的日月
 * 按钮，但是分亮、暗、自动三态，是按钮非滑块」）。顺序即用户给的顺序；`自动` 是环里的一档
 * （不是「回到默认」），所以「暗 → 自动 → 亮」也是环里的一步。
 */
const THEME_NEXT: Record<Prefs["ui.theme"], Prefs["ui.theme"]> = {
  light: "dark",
  dark: "system",
  system: "light",
};

/** 三档的中文名：只进 `title` / `aria-label` —— 图标没有可见文字，可访问名必须自带当前档。 */
const THEME_LABEL: Record<Prefs["ui.theme"], string> = {
  light: "亮",
  dark: "暗",
  system: "自动",
};

/**
 * 主题按钮的图标：**日**（亮）/ **月**（暗）/ **日月**（自动，即跟随系统）。
 * 自绘矢量，遵守 docs/ui.md §3.1 的图标规范 —— 同一个 `viewBox="0 0 24 24"` 与同一个
 * `.ctlIcon` 盒（60% × `--ctl-round` = 24px，缩放系数正好 1）、同一条 `stroke-width 1.75`
 * 与 round 线帽 / 接合；三枚的墨迹都**居中于 (12,12)**，主轴墨迹都是 **16 单位**（= 返回
 * 那枚箭头的高、⋯ 的宽），所以换档时图标不会跳大小。
 *
 * 几何（各条弧线的圆心 / 半径都按「墨迹 16 单位」反推，描边半宽 0.875 已算进去，
 * 于是三枚的墨迹包围盒都正好是 [4,20]² —— 与房间头那两枚同档）：
 * - 日：圆盘 r=3 + 8 道光芒，光芒中线从半径 5.75 到 7.125（墨迹外缘到 8 单位处）；
 * - 月：外弧 r=7.125 从正上方**逆时针** 270° 转到正右方（`1 0` = 大弧、逆时针），
 *   再以内弧 r=8.625 从正右方回到正上方（`0 1`，圆心 (20.51,3.49)）—— 内弧朝圆心一侧鼓，
 *   于是右上角被「咬」掉一块，月牙的两只尖角分别指着正上 / 正右；
 * - 日月：整圆 r=7.125 + **左半边实心**（同一段弧 + 直径闭合），日 / 月同体 —— 「不管系统
 *   是哪一套，两套都在」（自动 / 跟随系统）。
 */
function ThemeGlyph({ mode }: { mode: Prefs["ui.theme"] }) {
  if (mode === "light") {
    return (
      <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        <path
          d="M6.25 12h-1.375M17.75 12h1.375M12 6.25V4.875M12 17.75v1.375M6.962 6.962 7.934 7.934M17.038 6.962 16.066 7.934M6.962 17.038 7.934 16.066M17.038 17.038 16.066 16.066"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 4.875A7.125 7.125 0 1 0 19.125 12A8.625 8.625 0 0 1 12 4.875"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="7.125"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path d="M12 4.875A7.125 7.125 0 0 0 12 19.125Z" fill="currentColor" />
    </svg>
  );
}

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

  // 图标按钮没有可见文字：当前档与「点一下去哪一档」都只在 title / aria-label 里说清，
  // 读屏与悬停拿到的是同一句话（docs/ui.md §8.3）。
  const themeHint = `主题：${THEME_LABEL[theme]}（点一下切到${THEME_LABEL[THEME_NEXT[theme]]}）`;

  return (
    <div className={styles.listPage} data-testid="db-list-page">
      {/*
        页头一行：标题在左、**主题按钮**在右（用户 2026-09-13 #10：主题是全局的，主界面就该能切）。
        控件原先在房间页筛选面板的「显示」块里 —— 那里只有进房间、且展开面板才够得着，
        与「全局」不符。三档取值仍是 `ui.theme`（契约 §8），落到 `<html data-theme>` 由 App 的
        effect 负责；这里只写偏好，不做第二处解析。
        形态是**按钮不是滑块 / 下拉**（用户 2026-09-13 #7：「模仿安卓 / iOS 的日月按钮，
        但是分亮、暗、自动三态，是按钮非滑块」）：点一下循环一档，图标随档变，见 THEME_NEXT。
      */}
      <div className={styles.listHeader}>
        <h1>弹幕框</h1>
        <button
          className={styles.ctlRound}
          data-testid="db-pref-theme"
          title={themeHint}
          aria-label={themeHint}
          onClick={() => onTheme(THEME_NEXT[theme])}
        >
          <ThemeGlyph mode={theme} />
        </button>
      </div>

      {/*
        账号区只占一行，**整行就是入口**（用户 2026-09-13 #8：「账号面板改为直接点击头像所在的
        那个圆角长方形就能进入，不需要独立的『账号』按钮」）：头像 + 昵称 + uid 那一块本身可点，
        游客态同样可点（那时它的作用就是去登录）。行内没有别的可点元素 —— 切换 / 新增 / 扫码 /
        登出都在打开后的对话框里（AccountManager）。
      */}
      <div
        className={styles.account}
        data-testid="db-account"
        role="button"
        tabIndex={0}
        aria-label="账号管理"
        title="账号管理"
        onClick={onOpenAccounts}
        onKeyDown={(event) => {
          // 原生 button 的键盘行为：Enter / Space 等价于点击（Space 要挡掉页面滚动）
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenAccounts();
          }
        }}
      >
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
              游客态
            </span>
          )}
          {info && <span className={styles.accountMeta}>v{info.version}</span>}
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
            <div className={styles.empty}>还没有关注的主播</div>
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
                        title="最后开播时间"
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
