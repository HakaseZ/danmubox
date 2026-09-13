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
 *   打开批量后每行前出现勾选框、列表上方有「全选」、底部升起当前 tab 的批量动作条。
 *   批量同样走上层的二次确认（一次确认覆盖整批，文案含数量）。
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

  const counts: Record<AdminTab, number> = {
    silent: silent.length,
    blacklist: blacklist.length,
    keywords: keywords.length,
  };

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
   * 行：批量模式下前面多一个勾选框；单点动作在**右键菜单**里（issue #4）——
   * 菜单项在**打开那一刻**连同对象一起定下（挂到 state 上），菜单开着时名单被重读也不改它。
   * 行级 testid 与改前一致（冒烟按它定位），勾选框单独一枚 testid。
   */
  const row = (key: string, testid: string, label: string, items: MenuItem[]) => (
    <div
      key={key}
      className={styles.adminItem}
      data-testid={testid}
      data-picked={batch && picked.includes(key) ? "true" : undefined}
      title="右键可操作"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ at: { x: event.clientX, y: event.clientY }, items });
      }}
    >
      {batch && (
        // 勾选框外面包一层 `label`：**热区由 label 承担**（复选框本体不撑高，见 §9.1 的窄屏热区口径），
        // 点名字也能勾 —— 触屏上不用去点那 13px 的小方块。
        <label className={styles.adminPick}>
          <input
            type="checkbox"
            data-testid="db-admin-select"
            aria-label={`选择 ${label}`}
            checked={picked.includes(key)}
            onChange={() => togglePick(key)}
          />
          <span>{label}</span>
        </label>
      )}
      {!batch && <span>{label}</span>}
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
              <span className={styles.adminTabCount}>（{counts[item]}）</span>
            </button>
          ))}
        </div>
        <span className={styles.composerSpacer} />
        <button
          data-testid="db-admin-batch"
          aria-pressed={batch}
          className={batch ? styles.adminToggleOn : undefined}
          title={batch ? "退出批量处理" : "批量处理（多选后一次处理）"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setBatch((value) => !value);
            setPicked([]);
            setMenu(null);
          }}
        >
          批量
        </button>
        <button
          data-testid="db-admin-close"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div
        id={ADMIN_PANEL_ID}
        role="tabpanel"
        aria-labelledby={adminTabId(tab)}
        data-testid="db-admin-tabpanel"
      >
        {batch && (
          <div className={styles.adminPickHead}>
            <button
              data-testid="db-admin-select-all"
              disabled={currentKeys.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleAll}
            >
              {allPicked ? "取消全选" : "全选"}
            </button>
          </div>
        )}

        {tab === "silent" && (
          <>
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
            <div className={styles.adminForm}>
              <input
                className={styles.adminInput}
                value={muteUid}
                placeholder="观众 uid"
                onChange={(event) => setMuteUid(event.target.value)}
              />
              <button
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
            </div>
          </>
        )}

        {tab === "blacklist" && (
          <>
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
            <div className={styles.adminForm}>
              <input
                className={styles.adminInput}
                value={blackUid}
                placeholder="观众 uid"
                onChange={(event) => setBlackUid(event.target.value)}
              />
              <button
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
            </div>
          </>
        )}

        {tab === "keywords" && (
          <>
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
            </div>
          </>
        )}

        {batch && (
          <div className={styles.adminBatchBar} data-testid="db-admin-batch-bar">
            <span className={styles.previewLabel}>已选 {pickedKeys.length} 项</span>
            <button
              data-testid="db-admin-batch-action"
              disabled={busy || pickedKeys.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={confirmBatch}
            >
              {BATCH_LABEL[tab]}
            </button>
          </div>
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
