import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { ContextMenu, type MenuItem, type MenuPoint } from "./ContextMenu";
import type { AdminAction, AdminUser } from "../types";
import styles from "../app.module.css";

interface Props {
  silent: AdminUser[];
  blacklist: AdminUser[];
  keywords: string[];
  /** 三块各自的读取错误：原样 code + message（不翻译、不猜测上游语义）。 */
  errors: { silent?: string; blacklist?: string; keywords?: string };
  busy: boolean;
  /** 面板只负责发起动作，二次确认与执行都在上层。 */
  onConfirm: (action: AdminAction) => void;
  onClose: () => void;
}

/** 面板的三个 tab：禁言名单 / 黑名单 / 屏蔽词，一次只渲染当前这一个。 */
type AdminTab = "silent" | "blacklist" | "keywords";

/** tab 的顺序（键盘 ←→ 与屏幕上的顺序同源）。 */
const TAB_ORDER: AdminTab[] = ["silent", "blacklist", "keywords"];

const TAB_LABEL: Record<AdminTab, string> = {
  silent: "禁言",
  blacklist: "黑名单",
  keywords: "屏蔽词",
};

/** 批量动作条上的按钮文案：按当前 tab 给出（issue #4）。 */
const BATCH_LABEL: Record<AdminTab, string> = {
  silent: "批量解除禁言",
  blacklist: "批量移出黑名单",
  keywords: "批量删除屏蔽词",
};

/** tabpanel 的 id：tab 的 `aria-controls` 与它的 `aria-labelledby` 靠它对上。 */
const ADMIN_PANEL_ID = "db-admin-tabpanel";

/** 一个 tab 的按钮 id（同一个 tab 在 DOM 里只会有一个按钮）。 */
const adminTabId = (tab: AdminTab) => `db-admin-tab-${tab}`;

function name(user: AdminUser): string {
  return user.uname.length > 0 ? user.uname : `uid ${user.uid}`;
}

function parseUid(value: string): number | undefined {
  const uid = Number(value.trim());
  return Number.isInteger(uid) && uid > 0 ? uid : undefined;
}

/**
 * 房管面板（issue #3）：禁言名单 / 黑名单 / 屏蔽词三块列表 —— 用户 2026-09-13 第 1 条把三块
 * 收成**三个 tab**（一次只渲染一块），轨道与键盘行为照搬表情分组的现成实现（WAI-ARIA tabs 口径：
 * `aria-selected` / `aria-controls` / roving tabindex，←→ 换 tab、Home / End 跳首尾）。
 *
 * 几条规则来自需求：
 * - 三块列表**照常请求上游**：上游会拒绝并给出 `code` + `message`，界面原样展示，
 *   不翻译成自造文案、也不在本地假装成功。**面板入口本身只在房管身份时存在**（`RoomView` 把关，
 *   `docs/ui.md` §4.9），所以面板里不再有身份提示；因为「打开即静默刷新」之后没有手动重试入口，
 *   读取失败的**错误条必须留在面板里**（三块各自独立显示，互不清空）。
 * - 所有写操作（禁言 / 拉黑 / 解除 / 增删词）都只提交给上层，由那里出**二次确认**——
 *   这些动作会不可逆地影响他人。
 * - **单点动作收在行的右键菜单里**，「批量」模式才是行内的多选（用户 2026-09-13 第 4 条）：
 *   打开批量后每行前出现勾选框，全选 / 已选 / 批量动作在第 2 排。
 *   批量同样走上层的二次确认（一次确认覆盖整批，文案含数量）。
 * - **排布是两排、都贴顶**（用户 2026-09-14 第 5 条「不要竖着排版」）：
 *   第 1 排 = 输入框（唯一可缩项）+ 该 tab 的主操作 + 批量图标钮；批量模式下第 2 排
 *   （全选 / 已选 N 项 / 批量动作）紧贴第 1 排下方，仍是横向一排。列表与错误条在两者之下。
 * - 增删的输入沿用输入区已有的样式（input + 按钮，屏蔽词回车即可添加）。
 */
export function AdminPanel({
  silent,
  blacklist,
  keywords,
  errors,
  busy,
  onConfirm,
  onClose,
}: Props) {
  const [tab, setTab] = useState<AdminTab>("silent");
  const [batch, setBatch] = useState(false);
  // 勾选项的键：换 tab / 关批量即清空（两边的成员不同类，留着只会误伤另一份名单）。
  const [picked, setPicked] = useState<string[]>([]);
  // 行的右键菜单：打开时就把菜单项连同对象一起定下（菜单开着时名单被重读也不改它）。
  const [menu, setMenu] = useState<{ at: MenuPoint; items: MenuItem[] } | null>(null);
  const [muteUid, setMuteUid] = useState("");
  const [blackUid, setBlackUid] = useState("");
  const [word, setWord] = useState("");
  const railRef = useRef<HTMLDivElement>(null);

  // tab 文案**不再带计数**（issue #3：「禁言 3」→「禁言」）：条数就是三块列表自己的长度
  // （`silent` / `blacklist` / `keywords`），屏幕上由 `.adminList` 里的芯片数直接给出，
  // 不在这里另算一份渲染出去。
  const userKey = (user: AdminUser) => `u:${user.uid}`;
  const wordKey = (item: string) => `w:${item}`;
  const currentKeys =
    tab === "keywords"
      ? keywords.map(wordKey)
      : (tab === "silent" ? silent : blacklist).map(userKey);
  // 勾选数按**当前列表**数：写成功后重读三块，已经不在名单里的勾选自动落下去，
  // 因此「已选 N 项」与动作条按下的对象永远一致（不会拿着已经生效的旧勾再去确认一次）。
  const pickedKeys = currentKeys.filter((key) => picked.includes(key));
  const allPicked = currentKeys.length > 0 && pickedKeys.length === currentKeys.length;

  const togglePick = (key: string) =>
    setPicked((value) =>
      value.includes(key) ? value.filter((item) => item !== key) : [...value, key],
    );

  const toggleAll = () =>
    setPicked((value) =>
      allPicked
        ? value.filter((key) => !currentKeys.includes(key))
        : [...new Set([...value, ...currentKeys])],
    );

  /** 换 tab：勾选与右键菜单都只属于当前 tab，一起清掉。 */
  const selectTab = (next: AdminTab) => {
    setTab(next);
    setPicked([]);
    setMenu(null);
  };

  /**
   * tab 轨道的键盘导航（WAI-ARIA tabs 口径，与表情分组同一套）：roving tabindex ——
   * 只有选中的那个 tab 可 Tab 到，进去之后 ←→ 换 tab、Home / End 跳首尾，焦点跟着选中项走。
   */
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = Math.max(0, TAB_ORDER.indexOf(tab));
    const next =
      event.key === "ArrowRight"
        ? (current + 1) % TAB_ORDER.length
        : event.key === "ArrowLeft"
          ? (current - 1 + TAB_ORDER.length) % TAB_ORDER.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TAB_ORDER.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = TAB_ORDER[next];
    if (target === undefined) return;
    selectTab(target);
    railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  /**
   * 名字格要不要跑马灯：**这一行被指到时才量一次**（`scrollWidth > clientWidth`）。
   * 不给几百行各挂一个 ResizeObserver —— 只有悬停 / 聚焦的那一行需要这个结论。
   */
  const markScroll = (event: { currentTarget: HTMLElement }) => {
    const name = event.currentTarget.querySelector<HTMLElement>("[data-admin-name]");
    if (name) name.dataset.scroll = String(name.scrollWidth > name.clientWidth);
  };

  /** 离开 / 失焦即收起（下次进来重新量）。 */
  const clearScroll = (event: { currentTarget: HTMLElement }) => {
    const name = event.currentTarget.querySelector<HTMLElement>("[data-admin-name]");
    if (name) delete name.dataset.scroll;
  };

  /**
   * 行：**每行一项**（需求 2026-09-26）。
   *
   * 改前是芯片流式换行，勾选框**只在批量模式下插入** —— 一开批量每个芯片都变宽、换行位置
   * 全变，整片名单重排。现在行是等列的，勾选槽**常驻**（非批量时 `visibility: hidden`
   * 但占位），开关批量因此**零跳位**。
   *
   * 名字超宽默认可横滑；**只有悬停 / 键盘聚焦的那一行**才跑马灯（需求 2026-09-26）——
   * 几十行一起滚会很吵，`prefers-reduced-motion` 下也自动停。
   * 完整文本始终在 `title` 上，任何形态下都取得到。
   *
   * 单点动作仍在**右键菜单**里（issue #4）—— 菜单项在**打开那一刻**连同对象一起定下
   * （挂到 state 上），菜单开着时名单被重读也不改它。
   * 行级 testid 与改前一致（冒烟按它定位），勾选框单独一枚 testid。
   */
  const row = (key: string, testid: string, label: string, items: MenuItem[]) => (
    <div
      key={key}
      className={styles.adminItem}
      data-testid={testid}
      data-picked={batch && picked.includes(key) ? "true" : undefined}
      title="右键可操作"
      onMouseEnter={markScroll}
      onMouseLeave={clearScroll}
      onFocus={markScroll}
      onBlur={clearScroll}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ at: { x: event.clientX, y: event.clientY }, items });
      }}
    >
      {/* 勾选槽**常驻**：`visibility: hidden` 只藏不拆，宽度一个像素都不动 ——
          这是「开关批量零跳位」的全部机关。热区由这层 `label` 承担（复选框本体不撑高），
          点它就能勾，触屏上不用去点那 13px 的小方块。 */}
      <label className={styles.adminPick} data-hidden={batch ? undefined : "true"}>
        <input
          type="checkbox"
          data-testid="db-admin-select"
          aria-label={`选择 ${label}`}
          checked={picked.includes(key)}
          onChange={() => togglePick(key)}
        />
      </label>
      {/* 名字格：不放不下就跑马灯；轨道是**两份完全相同的拷贝**首尾相接，
          动画走 `-50%`（正好一份），循环处没有断口 —— 口径与房间头标题逐字同源。 */}
      <span className={styles.adminName} data-admin-name title={label}>
        <span className={styles.adminNameTrack}>
          <span className={styles.adminNameItem}>{label}</span>
          <span className={styles.adminNameItem} aria-hidden="true">
            {label}
          </span>
        </span>
      </span>
    </div>
  );

  /**
   * 批量动作条：只提交**当前 tab** 的成员，按列表顺序排列（执行顺序即屏幕顺序）。
   * 二次确认与执行都在上层（`RoomView` 的确认条 → `store.runAdmin`），这里不落地任何写操作。
   */
  const confirmBatch = () => {
    if (tab === "keywords") {
      const words = keywords.filter((item) => picked.includes(wordKey(item)));
      if (words.length === 0) return;
      onConfirm({
        kind: "batch",
        actions: words.map((item) => ({ kind: "keyword_del", word: item })),
      });
      return;
    }
    const users = (tab === "silent" ? silent : blacklist).filter((user) =>
      picked.includes(userKey(user)),
    );
    if (users.length === 0) return;
    onConfirm({
      kind: "batch",
      actions: users.map((user) =>
        tab === "silent"
          ? { kind: "unmute", uid: user.uid, uname: user.uname }
          : { kind: "blacklist_del", uid: user.uid, uname: user.uname },
      ),
    });
  };

  /** 上游拒绝时原样展示 code + message（同一份渲染，三块各自独立留痕）。 */
  const errorRow = (text: string | undefined) =>
    text === undefined ? null : (
      <div className={styles.adminError} data-testid="db-admin-error">
        {text}
      </div>
    );

  /**
   * 第 1 排末尾的**批量图标钮**（issue #5：文字开关从 tab 行挪下来、换成图标，tab 行于是只留关闭）。
   * `aria-pressed` 说明它是**模式**不是一次性动作，打开态换成强调色填充；图标没有文字可读，
   * 因此 `aria-label` / `title` 都要写全。打开后第 2 排出现在**本排正下方**。
   */
  const batchToggle = (
    <button
      type="button"
      className={`${styles.ctlRound}${batch ? ` ${styles.adminToggleOn}` : ""}`}
      data-testid="db-admin-batch"
      aria-pressed={batch}
      aria-label={batch ? "退出批量处理" : "批量处理"}
      title={batch ? "退出批量处理" : "批量处理（多选后一次处理）"}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        setBatch((value) => !value);
        setPicked([]);
        setMenu(null);
      }}
    >
      {/* 「清单 + 勾」：两行「勾选框 + 名字」，正是打开批量后名单的样子。
          规范与房间头两枚同一套（§3.1）：墨迹居中于 (12,12)、主轴 16 单位（横向量到的
          4 → 20）、`stroke-width` 1.75 + round 线帽 / 接合。 */}
      <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4.875 8.75 6.875 10.75 10.875 6.75M13 8.75h6.125M4.875 15.25 6.875 17.25 10.875 13.25M13 15.25h6.125"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );

  /**
   * 第 2 排（**只在批量模式下**、紧贴第 1 排下方，横向一排不竖排）：全选 / 已选 N 项 / 批量动作。
   * 这一排把原来分居两处的「名单上方的全选头」与「表单下方的动作条」合到了一起（issue #5），
   * testid 一个没动。全选与勾选都只作用**当前 tab**，动作条只提交当前 tab 的成员。
   */
  const batchBar = batch ? (
    <div className={styles.adminBatchBar} data-testid="db-admin-batch-bar">
      <button
        type="button"
        data-testid="db-admin-select-all"
        disabled={currentKeys.length === 0}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleAll}
      >
        {allPicked ? "取消全选" : "全选"}
      </button>
      <span className={styles.previewLabel}>已选 {pickedKeys.length} 项</span>
      <button
        type="button"
        data-testid="db-admin-batch-action"
        disabled={busy || pickedKeys.length === 0}
        onMouseDown={(event) => event.preventDefault()}
        onClick={confirmBatch}
      >
        {BATCH_LABEL[tab]}
      </button>
    </div>
  ) : null;

  return (
    <div className={styles.adminPanel} data-testid="db-admin-panel">
      <div className={styles.panelHead}>
        <div
          className={styles.adminRail}
          data-testid="db-admin-tabs"
          role="tablist"
          aria-label="房管名单"
          ref={railRef}
          onKeyDown={onTabKeyDown}
        >
          {TAB_ORDER.map((item) => (
            <button
              key={item}
              type="button"
              id={adminTabId(item)}
              role="tab"
              aria-selected={item === tab}
              aria-controls={ADMIN_PANEL_ID}
              tabIndex={item === tab ? 0 : -1}
              className={styles.adminTab}
              data-testid="db-admin-tab"
              data-kind={item}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectTab(item)}
            >
              {TAB_LABEL[item]}
            </button>
          ))}
        </div>
        <span className={styles.composerSpacer} />
        {/* tab 行右侧**只留关闭**（issue #4）：原来的文字「关闭」与「批量」开关都从这里挪走了
            —— 批量搬进第 1 排（issue #5），关闭换成 X 号图标（没有文字，可访问名靠
            `aria-label` + `title`）。控件族与房间头那两枚同一套：`.ctlRound` + `.ctlIcon`
            （40 × 40 正圆、透明底 + hover 洗色），图标规范见 `docs/ui.md` §3.1。 */}
        <button
          type="button"
          className={styles.ctlRound}
          data-testid="db-admin-close"
          aria-label="关闭"
          title="关闭"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <svg className={styles.ctlIcon} viewBox="0 0 24 24" aria-hidden="true">
            {/* X：两条对角线的墨迹居中于 (12,12)，主轴（对角线盒的边长）16 单位 = 返回箭头的高 */}
            <path
              d="M4.875 4.875 19.125 19.125M19.125 4.875 4.875 19.125"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div
        id={ADMIN_PANEL_ID}
        role="tabpanel"
        aria-labelledby={adminTabId(tab)}
        data-testid="db-admin-tabpanel"
      >
        {tab === "silent" && (
          <>
            <div className={styles.adminForm}>
              <input
                className={styles.adminInput}
                value={muteUid}
                placeholder="观众 uid"
                onChange={(event) => setMuteUid(event.target.value)}
              />
              <button
                type="button"
                disabled={busy || parseUid(muteUid) === undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const uid = parseUid(muteUid);
                  if (uid !== undefined) {
                    onConfirm({ kind: "mute", uid, uname: "", hour: 0 });
                  }
                }}
              >
                禁言
              </button>
              {batchToggle}
            </div>
            {batchBar}
            {errorRow(errors.silent)}
            <div className={styles.adminList}>
              {silent.length === 0 ? (
                <span className={styles.previewLabel}>（名单为空）</span>
              ) : (
                silent.map((user) =>
                  row(userKey(user), "db-admin-silent-item", name(user), [
                    {
                      label: "解除禁言",
                      disabled: busy,
                      onSelect: () =>
                        onConfirm({
                          kind: "unmute",
                          uid: user.uid,
                          uname: user.uname,
                        }),
                    },
                  ]),
                )
              )}
            </div>
          </>
        )}

        {tab === "blacklist" && (
          <>
            <div className={styles.adminForm}>
              <input
                className={styles.adminInput}
                value={blackUid}
                placeholder="观众 uid"
                onChange={(event) => setBlackUid(event.target.value)}
              />
              <button
                type="button"
                disabled={busy || parseUid(blackUid) === undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const uid = parseUid(blackUid);
                  if (uid !== undefined) {
                    onConfirm({ kind: "blacklist_add", uid, uname: "" });
                  }
                }}
              >
                拉黑
              </button>
              {batchToggle}
            </div>
            {batchBar}
            {errorRow(errors.blacklist)}
            <div className={styles.adminList}>
              {blacklist.length === 0 ? (
                <span className={styles.previewLabel}>（名单为空）</span>
              ) : (
                blacklist.map((user) =>
                  row(userKey(user), "db-admin-blacklist-item", name(user), [
                    {
                      label: "移出黑名单",
                      disabled: busy,
                      onSelect: () =>
                        onConfirm({
                          kind: "blacklist_del",
                          uid: user.uid,
                          uname: user.uname,
                        }),
                    },
                  ]),
                )
              )}
            </div>
          </>
        )}

        {tab === "keywords" && (
          <>
            <div className={styles.adminForm}>
              <input
                className={styles.adminInput}
                value={word}
                placeholder="屏蔽词，回车添加"
                onChange={(event) => setWord(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const value = word.trim();
                  if (value.length === 0) return;
                  onConfirm({ kind: "keyword_add", word: value });
                  setWord("");
                }}
              />
              <button
                type="button"
                disabled={busy || word.trim().length === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const value = word.trim();
                  if (value.length === 0) return;
                  onConfirm({ kind: "keyword_add", word: value });
                  setWord("");
                }}
              >
                添加屏蔽词
              </button>
              {batchToggle}
            </div>
            {batchBar}
            {errorRow(errors.keywords)}
            <div className={styles.adminList}>
              {keywords.length === 0 ? (
                <span className={styles.previewLabel}>（还没有屏蔽词）</span>
              ) : (
                keywords.map((item) =>
                  row(wordKey(item), "db-admin-keyword-item", item, [
                    {
                      label: "删除",
                      danger: true,
                      disabled: busy,
                      onSelect: () => onConfirm({ kind: "keyword_del", word: item }),
                    },
                  ]),
                )
              )}
            </div>
          </>
        )}
      </div>

      {menu && (
        <ContextMenu
          at={menu.at}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
