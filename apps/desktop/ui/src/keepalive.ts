/**
 * Android 后台保活（前台服务）的 JS 端桥。
 *
 * 原生在 `MainActivity.onStop()`（应用退到后台）求值一次
 * `(window.__danmuboxHasActiveConnection && window.__danmuboxHasActiveConnection()) === true`：
 * 为真才起那个带常驻通知的前台服务（见 `MainActivity.CONNECTION_SCRIPT` 与
 * `KeepAliveService`）。**求值表达式两处必须一字不差地对应**——协议与返回值的约定
 * 跟返回手势那条桥完全一样（`back.ts` 文件头：同步求值、返回值即答案）。
 *
 * 为什么问页面而不是让原生自己判断：活跃连接是**页面这一侧**的事实（房间在 store 里、
 * 连接态由后端 `danmubox://status` 事件维护），外壳看不见。反过来这里也**绝不新增状态**：
 * 只是把已有的两路信号读成一个布尔值，「谁在连」的判据仍然只有 store 一份。
 *
 * 桌面端也会挂上这个函数（与 `installBackBridge()` 一起，见 `main.tsx`），
 * 但**没有任何人调用它**，因此桌面行为不变。
 */

import { useApp } from "./store";

/**
 * 现在还有没有活跃的房间连接 —— 原生据此决定要不要起保活服务。
 *
 * 口径与房间头那颗状态点（`components/RoomView.tsx` 的 `liveKindOf`）**同源**：事件驱动的
 * `status[room_id]` 与列表载荷的 `room.connected` 各自都可能落后，所以两路信号取**与**
 * ——事件还没到（`undefined`）时以列表载荷为准，否则两路都得说「在连」。唯一的差别是
 * 「连上」这一档的范围：状态点画的是**开播 / 下播 / 未连接**，而保活关心的是「这条连接还值
 * 不值得为它顶着进程」，因此 `connecting`（含退避重连中）也算——那正是最不该被系统回收的时候。
 */
export function hasActiveConnection(): boolean {
  const { rooms, status } = useApp.getState();
  return rooms.some((room) => {
    const conn = status[room.room_id]?.state;
    return conn === undefined ? room.connected : (conn === "connected" || conn === "connecting") && room.connected;
  });
}

/** 把桥挂到 `window` 上（在 `main.tsx` 里、首次渲染之前调一次，与返回手势那条桥并列）。 */
export function installKeepAliveBridge(): void {
  window.__danmuboxHasActiveConnection = hasActiveConnection;
}

declare global {
  interface Window {
    /**
     * Android 外壳的后台保活入口：还有活跃的房间连接返回 `true`，否则返回 `false`。
     * 桌面端存在但无人调用；协议见 `docs/operations.md` §2.8。
     */
    __danmuboxHasActiveConnection?: () => boolean;
  }
}
