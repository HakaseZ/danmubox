import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Avatar } from "./Avatar";
import type {
  Account,
  AccountQr,
  AnchorArea,
  AnchorGateView,
  OwnRoom,
  QrState,
  SessionState,
  StreamEndpoints,
} from "../types";
import styles from "../app.module.css";

/** 长按多久算「复制」（推流地址 / 推流码没有复制键，靠长按）。 */
const LONG_PRESS_MS = 500;

/**
 * 长按复制：拿不到剪贴板**静默**（这不是「我的直播间」要报的错）。
 *
 * 为什么不做复制键：分区 / 地址 / 码三行都塞一枚按钮会把窄屏挤爆，
 * 而这三行的值本身就是要被整段取走的长串（等宽体 + 长按 是同一件事的两种表达）。
 */
function useLongPressCopy(value: string) {
  const timer = useRef<number | undefined>(undefined);
  const clear = () => window.clearTimeout(timer.current);
  useEffect(() => clear, []);
  return {
    onPointerDown: () => {
      clear();
      timer.current = window.setTimeout(() => {
        // 推流码是账号级凭据：只在这一次复制里出现，不进任何日志。
        void navigator.clipboard?.writeText(value).catch(() => undefined);
      }, LONG_PRESS_MS);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
  };
}

/** 开播状态的界面文案：只由 `live_status` 派生，不猜上游的其它值。 */
function liveStatusText(liveStatus: number): string {
  if (liveStatus === 1) return "直播中";
  if (liveStatus === 2) return "轮播";
  return "未开播";
}

/**
 * 分区树里找「这一级」：子分区命中它的父、父分区命中它自己。
 *
 * 选中的可能正是父分区本身（上游给的 `area_id` 是父级时），这时子分区列表是它自己的
 * `children` —— 不这么兜一层，选择器会整个空掉、用户看着像「分区没加载出来」。
 */
function parentOf(areas: AnchorArea[], id: number): AnchorArea | undefined {
  return (
    areas.find((parent) => (parent.children ?? []).some((child) => child.id === id)) ??
    areas.find((parent) => parent.id === id) ??
    areas[0]
  );
}

interface Props {
  /** 全部账号（`accounts_list`）：每个条目自带登录状态与身份。 */
  accounts: Account[];
  session?: SessionState;
  /** 进行中的扫码；`null` 但有 `qrError` = 上一次发起失败，面板给重试。 */
  qr: AccountQr | null;
  qrState: QrState | null;
  qrError: string | null;
  /** 「我的直播间」：展开的是哪个账号（`null` = 都收着）。 */
  anchorFor: string | null;
  /** 当前账号自己的直播间；`null` = 没开通 / 还没读到 / 读失败。 */
  anchorRoom: OwnRoom | null;
  /** 开播分区树（两级）；取不到时为空，界面降级为只读分区名。 */
  anchorAreas: AnchorArea[];
  anchorAreaError?: string;
  anchorTitleDraft?: string;
  /** 界面所选子分区；`undefined` = 沿用直播间当前分区。 */
  anchorAreaId?: number;
  /** 开播成功后的推流端点（含推流码，账号级凭据）。 */
  anchorEndpoints: StreamEndpoints | null;
  /** 开播被身份校验挡住时的引导；非空即弹提示框。 */
  anchorGate: AnchorGateView | null;
  anchorError?: string;
  onClose: () => void;
  onSwitch: (name: string) => void;
  /** 清掉该账号凭据（= 退回游客态）。 */
  onLogout: (name: string) => void;
  onRemove: (name: string) => void;
  /** 不带 `target` = 新增账号；带 = 给该账号重新登录（会覆盖它现有的凭据）。 */
  onStartQr: (target?: string) => void;
  onCancelQr: () => void;
  onPollQr: () => void;
  onToggleAnchor: (name: string) => void;
  onAnchorTitleDraft: (value: string) => void;
  onAnchorArea: (id?: number) => void;
  /** 保存标题；成功返回 true（界面据此只清忙态，文案由后端原话说）。 */
  onAnchorSaveTitle: () => Promise<boolean>;
  onAnchorLive: (live: boolean) => Promise<void>;
  /** `FaceAuth`：用系统浏览器打开认证页。 */
  onAnchorOpenGateUrl: () => void;
  onAnchorCloseGate: () => void;
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
  anchorFor,
  anchorRoom,
  anchorAreas,
  anchorAreaError,
  anchorTitleDraft,
  anchorAreaId,
  anchorEndpoints,
  anchorGate,
  anchorError,
  onClose,
  onSwitch,
  onLogout,
  onRemove,
  onStartQr,
  onCancelQr,
  onPollQr,
  onToggleAnchor,
  onAnchorTitleDraft,
  onAnchorArea,
  onAnchorSaveTitle,
  onAnchorLive,
  onAnchorOpenGateUrl,
  onAnchorCloseGate,
}: Props) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // 两个写按钮的忙态**各管各的**：保存中只禁「保存」、开播 / 下播中只禁那一枚
  // —— 改标题与开播 / 下播是两条独立命令，谁也不必等谁。
  const [busy, setBusy] = useState<"title" | "live" | null>(null);

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
      if (event.key !== "Escape") return;
      // 人脸认证提示框在最上层：Esc 先关它，再一次 Esc 才关对话框（一次只关一层）。
      if (anchorGate) {
        onAnchorCloseGate();
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, anchorGate, onAnchorCloseGate]);

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

  // ---- 「我的直播间」派生：全靠 store 里那几份状态，组件不自己存一份
  const title = anchorTitleDraft ?? anchorRoom?.title ?? "";
  const dirty = title.trim() !== (anchorRoom?.title ?? "");
  // 在播（`1` 直播中 / `2` 轮播）→ 按钮给「下播」；未开播 → 给「开播」。
  const onAir = (anchorRoom?.live_status ?? 0) !== 0;
  // 分区：界面所选优先，否则沿用直播间当前分区（= 上次开播分区，用户不改即可直接开播）。
  const areaId = anchorAreaId ?? anchorRoom?.area_id ?? 0;
  const parent = parentOf(anchorAreas, areaId);
  const children = parent?.children ?? [];
  const areaName =
    anchorAreas.length > 0
      ? children.find((child) => child.id === areaId)?.name ?? parent?.name ?? ""
      : // 列表取不到就降级：只读显示上游给的分区名（不是错误，是这一档的兜底呈现）
        anchorRoom?.area_name ?? "";
  // 推流参数：主 rtmp 优先，没有就退 srt（都缺就不渲染这一块）
  const stream = anchorEndpoints?.rtmp ?? anchorEndpoints?.srt ?? null;
  const addrHooks = useLongPressCopy(stream?.addr ?? "");
  const codeHooks = useLongPressCopy(stream?.code ?? "");

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
              // 一行 = 账号行 +（展开了才有的）直播间管理区，两者并列在同一个纵向列表里。
              <Fragment key={account.name}>
              <div
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
                  {/* 「我的直播间」在删除按钮**右侧**：点开才拉数据、才展开管理区
                      （docs/ui.md §2.2.2）。没开通 / 读失败也按得出，展开后只给错误行。 */}
                  <button
                    data-testid="db-anchor-toggle"
                    title={`查看 / 管理「${who(account)}」自己的直播间`}
                    onClick={() => onToggleAnchor(account.name)}
                  >
                    我的直播间
                  </button>
                </div>
              </div>

              {anchorFor === account.name && (
                <div className={styles.anchorPanel} data-testid="db-anchor-panel">
                  {anchorRoom && (
                    <>
                      <div className={styles.anchorRow} data-testid="db-anchor-title-row">
                        <input
                          className={styles.anchorTitle}
                          data-testid="db-anchor-title"
                          value={title}
                          placeholder="直播间标题"
                          onChange={(event) => onAnchorTitleDraft(event.target.value)}
                        />
                        <button
                          data-testid="db-anchor-title-save"
                          // 与远端一字不差 / 空标题都不必发：前者是没改，后者后端也会拒。
                          disabled={!dirty || title.trim().length === 0 || busy === "title"}
                          onClick={() => {
                            setBusy("title");
                            void onAnchorSaveTitle().finally(() => setBusy(null));
                          }}
                        >
                          保存
                        </button>
                      </div>

                      <div className={styles.anchorRow}>
                        {anchorAreas.length > 0 ? (
                          <>
                            <select
                              className={styles.anchorSelect}
                              aria-label="父分区"
                              value={parent?.id ?? ""}
                              onChange={(event) => {
                                const next = anchorAreas.find(
                                  (item) => item.id === Number(event.target.value),
                                );
                                // 换了父分区就落到它的第一个子分区：开播要的 `area_v2` 是子分区 id。
                                onAnchorArea(next?.children?.[0]?.id ?? next?.id);
                              }}
                            >
                              {anchorAreas.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                            <select
                              className={styles.anchorSelect}
                              data-testid="db-anchor-area-select"
                              aria-label="子分区"
                              value={areaId}
                              onChange={(event) => onAnchorArea(Number(event.target.value))}
                            >
                              {children.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          // 分区列表取不到的降级：只读显示上游给的分区名（不是错误，是这一档的呈现）
                          <span
                            className={styles.anchorStatus}
                            data-testid="db-anchor-area-select"
                            title={anchorAreaError ?? "分区列表未取到，沿用直播间当前分区"}
                          >
                            {areaName.length > 0 ? areaName : "上游未给出分区"}
                          </span>
                        )}
                      </div>

                      <div className={styles.anchorRow} data-testid="db-anchor-status-row">
                        <span className={styles.anchorStatus} data-testid="db-anchor-status">
                          {liveStatusText(anchorRoom.live_status)}
                        </span>
                        <button
                          data-testid="db-anchor-live"
                          disabled={busy === "live"}
                          title={onAir ? "下播" : "开播（沿用所选分区）"}
                          onClick={() => {
                            setBusy("live");
                            void onAnchorLive(!onAir).finally(() => setBusy(null));
                          }}
                        >
                          {onAir ? "下播" : "开播"}
                        </button>
                      </div>

                      {/* 开播成功后**直接渲染**推流参数（不必双击、不必展开）；下播即消失 */}
                      {stream && (
                        <div className={styles.anchorConfig} data-testid="db-anchor-config">
                          <div className={styles.anchorConfigRow}>
                            <span className={styles.anchorLabel}>分区</span>
                            <span data-testid="db-anchor-area">
                              {areaName.length > 0 ? areaName : "上游未给出分区"}
                            </span>
                          </div>
                          <div className={styles.anchorConfigRow}>
                            <span className={styles.anchorLabel}>推流地址（长按复制）</span>
                            <span
                              className={styles.anchorValue}
                              data-testid="db-anchor-rtmp-addr"
                              {...addrHooks}
                            >
                              {stream.addr}
                            </span>
                          </div>
                          <div className={styles.anchorConfigRow}>
                            <span className={styles.anchorLabel}>推流码（长按复制）</span>
                            <span
                              className={styles.anchorValue}
                              data-testid="db-anchor-rtmp-code"
                              {...codeHooks}
                            >
                              {stream.code}
                            </span>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {anchorError && (
                    <div className={styles.anchorError} data-testid="db-anchor-error">
                      {anchorError}
                    </div>
                  )}
                </div>
              )}
              </Fragment>
            ))
          )}
        </div>

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

        {/* 开播被身份校验挡住：弹出提示框引导（docs/ui.md §2.2.2）。
            上游原话照旧留在展开区的错误行里 —— 引导不代替原话。 */}
        {anchorGate && (
          <div
            className={styles.anchorModalBackdrop}
            data-testid="db-anchor-gate-modal"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) onAnchorCloseGate();
            }}
          >
            <div
              className={styles.anchorModal}
              role="dialog"
              aria-modal="true"
              aria-label="开播身份校验"
            >
              <span className={styles.anchorModalTitle}>本次开播需要身份校验</span>
              {anchorGate.kind === "qrconfirm" ? (
                anchorGate.qr_svg ? (
                  // SVG 是纯 ASCII，btoa 直接可用；二维码由 Rust 侧离线编码，不经过任何在线服务
                  <img
                    data-testid="db-anchor-gate-qr"
                    alt="身份校验二维码"
                    src={`data:image/svg+xml;base64,${btoa(anchorGate.qr_svg)}`}
                  />
                ) : (
                  <span className={styles.anchorModalHint} data-testid="db-anchor-gate-qr">
                    上游未给出二维码内容
                  </span>
                )
              ) : (
                // `FaceAuth`：用系统浏览器打开认证页，不内嵌网页
                <button data-testid="db-anchor-gate-open" onClick={onAnchorOpenGateUrl}>
                  去完成人脸认证
                </button>
              )}
              <span className={styles.anchorModalHint} data-testid="db-anchor-gate-hint">
                完成认证后再点一次开播
              </span>
              <button onClick={onAnchorCloseGate}>关闭</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
