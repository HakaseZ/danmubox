import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Avatar } from "./Avatar";
import { useApp } from "../store";
import type { Account, AccountQr, QrState, SessionState } from "../types";
import styles from "../app.module.css";

interface Props {
  /** 全部账号（`accounts_list`）：每个条目自带登录状态与身份。 */
  accounts: Account[];
  session?: SessionState;
  /** 进行中的扫码；`null` 但有 `qrError` = 上一次发起失败，面板给重试。 */
  qr: AccountQr | null;
  qrState: QrState | null;
  qrError: string | null;
  onClose: () => void;
  onSwitch: (name: string) => void;
  /** 清掉该账号凭据（= 退回游客态）。 */
  onLogout: (name: string) => void;
  onRemove: (name: string) => void;
  /** 不带 `target` = 新增账号；带 = 给该账号重新登录（会覆盖它现有的凭据）。 */
  onStartQr: (target?: string) => void;
  onCancelQr: () => void;
  onPollQr: () => void;
}

/** 整行可点时的 DOM 属性（当前账号行返回 `undefined`）。 */
type SwitchRowProps = {
  role: "button";
  tabIndex: number;
  "aria-label": string;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
};

/**
 * 非当前账号的行：整行就是「切到它」（用户 2026-09-13：「用户直接点击切换，不要那个专门的切换按钮」）。
 *
 * 给按钮语义与 `tabIndex`，键盘 Enter / Space 与鼠标点击等价；当前账号行**不给**这些属性——
 * 它没有可切的目标，点了也不该有副作用（连焦点都不该停在它上面）。
 * 行内的动作按钮（重新登录 / 退出登录 / 删除）由 `.accountActions` 容器统一 `stopPropagation`，
 * 点它们不会顺带触发切号。
 */
function switchRowProps(
  account: Account,
  onSwitch: (name: string) => void,
): SwitchRowProps | undefined {
  if (account.active) return undefined;
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": `切到「${who(account)}」`,
    onClick: () => onSwitch(account.name),
    onKeyDown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Space 默认滚页面、Enter 可能触发别的默认行为；这一下只做「切换」。
      event.preventDefault();
      onSwitch(account.name);
    },
  };
}

const QR_HINT: Record<QrState, string> = {
  pending: "请用 B 站客户端扫码",
  scanned: "已扫码，请在手机上确认",
  confirmed: "登录成功",
  expired: "二维码已过期，请重新获取",
};

/**
 * 我的直播间的开播状态文案（`OwnRoom.live_status`，与 `Room.live_status` 同义）。
 * 上游只给这三个数，别的一律说「未开播」——界面不给状态编语义。
 */
function liveStatusText(status: number): string {
  if (status === 1) return "直播中";
  if (status === 2) return "轮播";
  return "未开播";
}

/** 分区名上游没给时的说法（`OwnRoom.area_name` 是空串，不是错误）。 */
const AREA_FALLBACK = "上游未给出分区";

/** 二次确认的对象：三种都改凭据或删条目，不能点一下就走。 */
type Confirm =
  | { kind: "rescan"; name: string }
  | { kind: "logout"; name: string }
  | { kind: "remove"; name: string };

/** 昵称缺失时退回账号名：10 多处按钮 title / 确认文案都要同一口径，不能这处写昵称那处写账号名。 */
function who(account: Account): string {
  return account.nickname.length > 0 ? account.nickname : account.name;
}

/** 账号状态文案（需求 §2.5）：三条路径各有各的说法，别混成一句。 */
function statusOf(account: Account): string {
  if (!account.logged_in) return "未登录";
  return account.active ? "已登录 · 当前" : "已登录";
}

/**
 * 账号管理对话框（用户 2026-09-12：「整个账号管理重写一下逻辑和 ui」）。
 *
 * 为什么是对话框而不是下拉：**单账号时下拉里只有一项，会被读成「切换功能坏了」**
 * （用户原话「切换身份的功能好像没法选」）。列表要能一眼看到「有几个账号、各是谁、
 * 哪个在用」，那本来就不是一个下拉能装下的信息。
 *
 * 三条硬规则（来自一次真实事故：用户用旧界面上的「扫码登录」把原账号凭据顶掉了）：
 * 1. 「＋ 添加账号」是**默认入口**，走 `account_qr_start()`（不带 target），**永不覆盖**任何凭据；
 * 2. 覆盖路径（「重新登录」某个账号）**必须显式确认**，文案写明会覆盖谁的凭据；
 * 3. 每一行都露出**昵称 + uid**，当前账号另有「已登录 · 当前」标记——覆盖的是谁必须看得见。
 *
 * 两条路径都在这里可达：扫码（唯一登录入口）、游客（退出登录即清凭据，条目保留，可随时重新扫码）。
 */
export function AccountManager({
  accounts,
  session,
  qr,
  qrState,
  qrError,
  onClose,
  onSwitch,
  onLogout,
  onRemove,
  onStartQr,
  onCancelQr,
  onPollQr,
}: Props) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  // 「我的直播间」那一块（用户 2026-09-19：账号行**下面**再加一块）。它整块按**凭据**算出来，
  // 因此对话框一打开、以及每次换号后各拉一次：`account_switch` 之后 `active_profile` 变了，
  // 上一份直播间数据必须先走掉再重取。切号 / 登出的清空由 store 的 `resetIdentityState` 负责；
  // 未登录时这个动作自己会清空三份状态、连上游都不问。
  const anchorRoom = useApp((store) => store.anchorRoom);
  const anchorError = useApp((store) => store.anchorError);
  const anchorEndpoints = useApp((store) => store.anchorEndpoints);
  const loadAnchorRoom = useApp((store) => store.loadAnchorRoom);
  const setAnchorTitle = useApp((store) => store.setAnchorTitle);
  const setAnchorLive = useApp((store) => store.setAnchorLive);

  const loggedIn = session?.logged_in === true;
  useEffect(() => {
    void loadAnchorRoom();
  }, [loadAnchorRoom, loggedIn, session?.active_profile]);

  /**
   * 标题草稿：初值 = 远端的标题，远端变了就以远端为准（本地草稿不冒充事实）。
   *
   * **不用 effect 同步**（`react(set-state-in-effect)` 会告警，且白多一次渲染）：把「这份草稿
   * 属于哪个直播间」一并存下，**渲染时**判断它还属不属于当前这一个 —— 换了房间/账号，草稿
   * 自然回到远端值，不需要任何副作用。
   */
  const [titleDraft, setTitleDraft] = useState<{ room: number | null; value: string }>({
    room: anchorRoom?.room_id ?? null,
    value: anchorRoom?.title ?? "",
  });
  /**
   * 「相关配置项」的展开态：**默认收起**，且只对**当时那个直播间**有效 ——
   * 收起时推流码一个字都不在 DOM 里，换号/换直播间也自动回到收起（同一条派生规则）。
   */
  const [configOpenFor, setConfigOpenFor] = useState<number | null>(null);
  /**
   * 进行中的写操作：只禁掉**正在跑的那一个**按钮（改标题与开播 / 下播是两条独立命令，
   * 谁也不必等谁）。它不进 store —— 这是这一块自己的、随对话框关闭就消失的瞬态。
   */
  const [busy, setBusy] = useState<"title" | "live" | null>(null);

  const roomId = anchorRoom?.room_id ?? null;
  const roomTitle = anchorRoom?.title ?? "";
  /** 草稿属于当前这个直播间时才用它，否则以远端标题为准（见 `titleDraft` 的说明）。 */
  const title = titleDraft.room === roomId ? titleDraft.value : roomTitle;
  const configOpen = roomId !== null && configOpenFor === roomId;

  const liveStatus = anchorRoom?.live_status ?? 0;
  const live = liveStatus === 1;
  /** 「改名后才启用」：与远端标题一字不差就没得保存。 */
  const titleChanged = anchorRoom !== null && title !== anchorRoom.title;
  /**
   * 展开时给哪一组推流端点：按 `rtmp → rtmp_backup → srt` 取第一个可用的
   * （后端对 `None` 是 `skip_serializing_if`，键可能整个不在，也可能为 `null`；不猜、不补默认）。
   */
  const endpoint =
    anchorEndpoints?.rtmp ?? anchorEndpoints?.rtmp_backup ?? anchorEndpoints?.srt ?? null;

  const saveTitle = async () => {
    setBusy("title");
    try {
      // 失败原因是后端原话，落进 `anchorError` 由下面那行显示（成功会就地重读、草稿随之对齐）。
      await setAnchorTitle(title);
    } finally {
      setBusy(null);
    }
  };

  const toggleLive = async () => {
    setBusy("live");
    try {
      await setAnchorLive(!live);
    } finally {
      setBusy(null);
    }
  };

  /** 复制推流地址 / 推流码：**失败静默** —— 拿不到剪贴板不是这一块要报的错。 */
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 静默：这里不弹提示、也不写错误条。
    }
  };

  // 每 2 秒问一次扫码状态（契约 §7）；过期与出错都停下来，交给「重新获取」重来。
  // 轮询回调存 ref：它在父组件里是内联箭头，若进依赖表，任何一次 store 更新都会重开定时器。
  const polling = qr !== null && qrError === null && qrState !== "expired";
  const pollRef = useRef(onPollQr);
  useEffect(() => {
    pollRef.current = onPollQr;
  });
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => pollRef.current(), 2000);
    return () => window.clearInterval(timer);
  }, [polling, qr?.key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirmed = ((): { text: string; label: string; run: () => void } | null => {
    if (!confirm) return null;
    const account = accounts.find((item) => item.name === confirm.name);
    if (!account) return null;
    if (confirm.kind === "rescan") {
      return {
        text: `重新登录「${who(account)}」会用新凭据覆盖该账号（${account.name}）现有的凭据，原凭据无法恢复。`,
        label: "确认覆盖并扫码",
        run: () => onStartQr(account.name),
      };
    }
    if (confirm.kind === "logout") {
      return {
        text: `退出「${who(account)}」会清掉该账号（${account.name}）的凭据，界面回到游客态；账号条目保留，可随时重新扫码。`,
        label: "确认退出登录",
        run: () => onLogout(account.name),
      };
    }
    const switching = account.active ? "它正在使用中，删除后会自动切到另一个账号。" : "";
    return {
      text: `删除账号「${who(account)}」（${account.name}）：条目与凭据一并删除，不可恢复。${switching}`,
      label: "确认删除",
      run: () => onRemove(account.name),
    };
  })();

  const scanning = qr !== null || qrError !== null;
  const target = qr?.target ?? null;
  const targetAccount = target ? accounts.find((item) => item.name === target) : undefined;

  return (
    <div
      className={styles.dialogBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.accountDialog}
        role="dialog"
        aria-modal="true"
        aria-label="账号管理"
        data-testid="db-account-dialog"
      >
        <div className={styles.dialogHead}>
          <span className={styles.dialogTitle}>账号管理</span>
          <span className={styles.dialogSub}>
            {session?.logged_in ? "已登录" : "游客态"}
            {` · ${accounts.length} 个账号`}
          </span>
        </div>

        <div className={styles.accountList}>
          {accounts.length === 0 ? (
            <div className={styles.dialogSub} data-testid="db-account-empty">
              还没有账号。用下面的「＋ 添加账号」扫码即可。
            </div>
          ) : (
            accounts.map((account) => (
              <div
                key={account.name}
                className={`${styles.accountItem} ${
                  account.active ? styles.accountItemActive : styles.accountItemSwitchable
                }`}
                data-testid="db-account-row"
                {...switchRowProps(account, onSwitch)}
              >
                <Avatar url={account.face} name={who(account)} />
                <div className={styles.accountWho}>
                  <span className={styles.accountName} data-testid="db-account-row-name">
                    {who(account)}
                  </span>
                  <span className={styles.accountMeta} data-testid="db-account-row-uid">
                    uid {account.uid}
                    {` · 账号 ${account.name}`}
                  </span>
                </div>
                <span
                  className={account.logged_in ? styles.accountLoggedIn : styles.accountOffline}
                  data-testid="db-account-row-status"
                >
                  {statusOf(account)}
                </span>
                {/* 行内动作一律不冒泡到行：点「重新登录 / 退出登录 / 删除」不该顺带切号
                    （键鼠都是：按钮上的 Enter 也会冒泡到行的 keydown 处理） */}
                <div
                  className={styles.accountActions}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <button
                    data-testid="db-account-rescan"
                    title={`用扫码重新登录「${who(account)}」（会覆盖它现有的凭据，需确认）`}
                    onClick={() => setConfirm({ kind: "rescan", name: account.name })}
                  >
                    重新登录
                  </button>
                  {account.logged_in && (
                    <button
                      data-testid="db-account-logout"
                      title={`清掉「${who(account)}」的凭据，退回游客态`}
                      onClick={() => setConfirm({ kind: "logout", name: account.name })}
                    >
                      退出登录
                    </button>
                  )}
                  <button
                    data-testid="db-account-remove"
                    disabled={accounts.length <= 1}
                    title={
                      accounts.length <= 1
                        ? "至少保留一个账号"
                        : `删除账号「${who(account)}」（条目与凭据一并删除）`
                    }
                    onClick={() => setConfirm({ kind: "remove", name: account.name })}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 「我的直播间」（用户 2026-09-19：账号行**下面**再来一块）。渲染条件铁面无私：
            当前账号**已登录** 且（`anchor_room` 真给出了直播间 **或** 上一次读失败）——
            没开通（后端返回 `null`）与游客态两种情况，这一块整块都不在 DOM 里，
            绝不把上一个账号的直播间摆出来。

            **读失败必须留痕**：读失败（凭据失效 `-101`、风控 `-352` …）时 `anchor_room` 是 `null`，
            后端把非 0 code 原样带回（`AGENT.md` §8.9），界面就得把它说出来；若把错误行跟着
            直播间一起收掉，用户只看得到一块空白、不知为何 —— 那正是 `docs/ui.md` §2.2.1
            禁止的「失败静默消失」。所以错误行**独立于**直播间数据渲染；而**只有**它渲染：
            标题行 / 状态行 / 开播下播都不在 DOM 里 —— 没有直播间就没有标题可改、没有开播状态
            可报，空输入框与「未开播」都是编出来的事实。 */}
        {loggedIn && (anchorRoom !== null || anchorError !== null) && (
          <div className={styles.anchorPanel} data-testid="db-anchor-panel">
            {/* 标题行与状态行只在真拿到直播间时画：`anchorRoom` 为 `null` 时手上没有这一份数据，
                不能拿状态默认值凑出一行来（错误行在下面）。 */}
            {anchorRoom !== null && (
              <>
                <div className={styles.anchorRow} data-testid="db-anchor-title-row">
                  <input
                    data-testid="db-anchor-title"
                    aria-label="直播间标题"
                    placeholder="直播间标题"
                    value={title}
                    onChange={(event) => setTitleDraft({ room: roomId, value: event.target.value })}
                  />
                  <button
                    data-testid="db-anchor-title-save"
                    disabled={busy === "title" || !titleChanged}
                    title={titleChanged ? "保存直播间标题" : "标题没改，不用保存"}
                    onClick={() => void saveTitle()}
                  >
                    保存
                  </button>
                </div>

                <div className={styles.anchorRow} data-testid="db-anchor-status-row">
                  {/* 状态文本是「相关配置项」的开关：双击（主路径）或 Enter / Space 都能开合，
                      因此它带 role/tabIndex 与 `title` 说明怎么用 —— 一块可点的文字不能让人猜。 */}
                  <span
                    data-testid="db-anchor-status"
                    className={styles.anchorStatus}
                    role="button"
                    tabIndex={0}
                    title="双击查看相关配置项"
                    onDoubleClick={() => setConfigOpenFor(configOpen ? null : roomId)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setConfigOpenFor(configOpen ? null : roomId);
                    }}
                  >
                    {liveStatusText(liveStatus)}
                  </span>
                  <button
                    data-testid="db-anchor-live"
                    disabled={busy === "live"}
                    title={live ? "结束本场直播" : "开始直播（沿用当前分区）"}
                    onClick={() => void toggleLive()}
                  >
                    {live ? "下播" : "开播"}
                  </button>
                </div>
              </>
            )}

            {/* 读 / 写的失败原因：后端原话（契约 §7），失败不静默。它**不跟着**上面两行一起收：
                读失败恰是 `anchorRoom === null` 的那一种，只有这一行能把原因说清楚。 */}
            {anchorError !== null && (
              <div className={styles.anchorError} data-testid="db-anchor-error">
                {anchorError}
              </div>
            )}

            {/* 配置项读的是直播间的分区名，同样得有 `anchorRoom` 才画。 */}
            {anchorRoom !== null && configOpen && (
              <div className={styles.anchorConfig} data-testid="db-anchor-config">
                <div className={styles.anchorConfigRow}>
                  <span className={styles.anchorConfigLabel}>分区</span>
                  <span className={styles.anchorConfigValue} data-testid="db-anchor-area">
                    {anchorRoom.area_name.trim().length > 0 ? anchorRoom.area_name : AREA_FALLBACK}
                  </span>
                </div>
                {/* 推流地址 / 推流码只有在**本次会话刚开播**拿到端点时才有：下播（或收起）之后
                    这两行连同推流码一起从 DOM 里消失，不留残留。 */}
                {endpoint !== null && (
                  <>
                    <div className={styles.anchorConfigRow}>
                      <span className={styles.anchorConfigLabel}>推流地址</span>
                      <span className={styles.anchorConfigValue} data-testid="db-anchor-rtmp-addr">
                        {endpoint.addr}
                      </span>
                      <button
                        data-testid="db-anchor-copy-addr"
                        title="复制推流地址"
                        onClick={() => void copy(endpoint.addr)}
                      >
                        复制
                      </button>
                    </div>
                    <div className={styles.anchorConfigRow}>
                      <span className={styles.anchorConfigLabel}>推流码</span>
                      <span className={styles.anchorConfigValue} data-testid="db-anchor-rtmp-code">
                        {endpoint.code}
                      </span>
                      <button
                        data-testid="db-anchor-copy-code"
                        title="复制推流码（拿到它就能向本直播间推流，别外传）"
                        onClick={() => void copy(endpoint.code)}
                      >
                        复制
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {confirmed && (
          <div className={styles.adminConfirm} data-testid="db-account-confirm">
            <span>{confirmed.text}</span>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                confirmed.run();
                setConfirm(null);
              }}
            >
              {confirmed.label}
            </button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
          </div>
        )}

        {!scanning && (
          <button
            className={styles.accountAdd}
            data-testid="db-account-add"
            title="添加账号"
            onClick={() => onStartQr()}
          >
            ＋ 添加账号
          </button>
        )}

        {scanning && (
          <div className={styles.qrPanel} data-testid="db-account-qr">
            <div className={styles.qrTitle}>
              {targetAccount
                ? `重新登录「${who(targetAccount)}」`
                : "扫码添加账号"}
            </div>
            {targetAccount && (
              <div className={styles.qrWarn} data-testid="db-account-qr-warn">
                扫完会用新凭据覆盖该账号（{targetAccount.name}）现有的凭据
              </div>
            )}
            {qr ? (
              <>
                {/* SVG 是纯 ASCII，btoa 直接可用；二维码由后端离线渲染，不经过任何在线服务 */}
                <img
                  data-testid="db-account-qr-img"
                  alt="登录二维码"
                  src={`data:image/svg+xml;base64,${btoa(qr.svg)}`}
                />
                <div className={styles.qrHint} data-testid="db-account-qr-hint">
                  {qrError ?? (qrState ? QR_HINT[qrState] : QR_HINT.pending)}
                </div>
              </>
            ) : (
              <div className={styles.qrHint} data-testid="db-account-qr-hint">
                {qrError ?? "二维码获取失败"}
              </div>
            )}
            <div className={styles.qrActions}>
              {(qrError !== null || qrState === "expired" || qr === null) && (
                <button
                  data-testid="db-account-qr-retry"
                  onClick={() => onStartQr(target ?? undefined)}
                >
                  重新获取
                </button>
              )}
              <button data-testid="db-account-qr-cancel" onClick={onCancelQr}>
                关闭二维码
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
