import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { installBackBridge } from "./back";
import { installKeepAliveBridge } from "./keepalive";
import "./index.css";

// 原生（Android 的 `MainActivity`）在每次返回时同步调它；桌面端没人调（见 back.ts）。
// 挂在渲染之前：首帧就能接住返回手势，不必等 React 装完。
installBackBridge();
// 同一套约定：原生在应用退到后台（`onStop`）时同步调它问「有没有活跃连接」，
// 只有答 true 才起那个带常驻通知的前台服务（见 keepalive.ts）。
installKeepAliveBridge();

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
