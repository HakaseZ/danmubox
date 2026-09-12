import { useEffect, useRef, useState } from "react";

import { Avatar } from "./Avatar";
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
  onLoginCookie: (cookie: string, name?: string) => Promise<boolean>;
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
 * 三种登录方式都在这里可达：扫码（默认入口）、手填 Cookie（折叠的高级入口）、
 * 游客（退出登录即清凭据，条目保留，可随时重新扫码）。
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
  onLoginCookie,
}: Props) {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [cookie, setCookie] = useState("");
  const [cookieName, setCookieName] = useState("");
  const [cookieBusy, setCookieBusy] = useState(false);

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
          <span className={styles.headerSpacer} />
          <button
            data-testid="db-account-close"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        <div className={styles.accountList}>
          {accounts.length === 0 ? (
            <div className={styles.dialogSub} data-testid="db-account-empty">
              还没有账号。用下面的「＋ 添加账号」扫码即可——扫完由后端按昵称自动命名，不用先起名字。
            </div>
          ) : (
            accounts.map((account) => (
              <div
                key={account.name}
                className={`${styles.accountItem} ${account.active ? styles.accountItemActive : ""}`}
                data-testid="db-account-row"
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
                <div className={styles.accountActions}>
                  {!account.active && (
                    <button
                      data-testid="db-account-switch"
                      title={`切到「${who(account)}」（后端会用它的凭据重连各房间）`}
                      onClick={() => onSwitch(account.name)}
                    >
                      切换
                    </button>
                  )}
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
            title="扫码添加一个新账号（不会覆盖任何已有账号的凭据）"
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
            {targetAccount ? (
              <div className={styles.qrWarn} data-testid="db-account-qr-warn">
                扫完会用新凭据覆盖该账号（{targetAccount.name}）现有的凭据
              </div>
            ) : (
              <div className={styles.dialogSub}>
                扫完由后端按昵称自动命名，不需要先起名字；不会动任何已有账号
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

        <button
          className={styles.accountAdvanced}
          data-testid="db-account-cookie-toggle"
          aria-expanded={cookieOpen}
          onClick={() => setCookieOpen((open) => !open)}
        >
          {cookieOpen ? "收起「手填 Cookie」" : "高级：手填 Cookie"}
        </button>

        {cookieOpen && (
          <div className={styles.accountCookie} data-testid="db-account-cookie">
            <div className={styles.dialogSub}>
              Cookie 只用于这一次登录，不回显、不进日志；账号名可留空，由后端按昵称自动命名。
            </div>
            <input
              data-testid="db-account-cookie-input"
              type="password"
              autoComplete="off"
              placeholder="SESSDATA=…; bili_jct=…; DedeUserID=…"
              value={cookie}
              onChange={(event) => setCookie(event.target.value)}
            />
            <input
              data-testid="db-account-cookie-name"
              placeholder="账号名（可留空）"
              value={cookieName}
              onChange={(event) => setCookieName(event.target.value)}
            />
            <button
              data-testid="db-account-cookie-submit"
              disabled={cookieBusy || cookie.trim().length === 0}
              onClick={() => {
                const value = cookie.trim();
                if (value.length === 0) return;
                const name = cookieName.trim();
                setCookieBusy(true);
                void onLoginCookie(value, name.length > 0 ? name : undefined).then(
                  (ok) => {
                    setCookieBusy(false);
                    if (!ok) return;
                    setCookie("");
                    setCookieName("");
                  },
                );
              }}
            >
              {cookieBusy ? "登录中…" : "用 Cookie 登录"}
            </button>
          </div>
        )}

        <div className={styles.dialogSub}>
          游客态不登录也能收弹幕；发送需要登录。三种方式：扫码（默认）、手填 Cookie、
          退出登录（回到游客态）。
        </div>
      </div>
    </div>
  );
}
