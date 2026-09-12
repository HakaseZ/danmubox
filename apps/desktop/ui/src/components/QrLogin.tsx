import { useEffect, useState } from "react";

import { useApp } from "../store";
import type { QrState } from "../types";
import styles from "../app.module.css";

const HINT: Record<QrState, string> = {
  pending: "请用 B 站客户端扫码",
  scanned: "已扫码，请在手机上确认",
  confirmed: "登录成功",
  expired: "二维码已过期，请重新获取",
};

/**
 * 扫码登录面板（契约 §7 的 `session_qr_start` / `session_qr_poll`）。
 *
 * 二维码由后端离线渲染成 SVG——不引任何第三方在线二维码服务（那等于把登录票据交给别人）。
 */
export function QrLogin() {
  const qr = useApp((state) => state.qr);
  const qrError = useApp((state) => state.qrError);
  const startQrLogin = useApp((state) => state.startQrLogin);
  const cancelQrLogin = useApp((state) => state.cancelQrLogin);
  const pollQrLogin = useApp((state) => state.pollQrLogin);
  const [qrState, setQrState] = useState<QrState>("pending");

  useEffect(() => {
    if (!qr) return;
    setQrState("pending");
    const timer = setInterval(() => {
      void pollQrLogin().then((next) => {
        if (next) setQrState(next);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [qr, pollQrLogin]);

  if (!qr) {
    return (
      <button onClick={() => void startQrLogin()} title="用 B 站客户端扫码登录">
        扫码登录
      </button>
    );
  }

  return (
    <div className={styles.qrPanel}>
      {/* SVG 是纯 ASCII（二维码内容就是那个 URL），btoa 直接可用 */}
      <img alt="登录二维码" src={`data:image/svg+xml;base64,${btoa(qr.svg)}`} />
      <div className={styles.qrHint}>{HINT[qrState]}</div>
      {qrError && <div className={styles.qrHint}>{qrError}</div>}
      <div className={styles.qrActions}>
        {qrState === "expired" && (
          <button onClick={() => void startQrLogin()}>重新获取</button>
        )}
        <button onClick={cancelQrLogin}>关闭</button>
      </div>
    </div>
  );
}
