/**
 * 系统返回手势（Android 侧滑 / 三键返回）的 JS 端桥。
 *
 * 原生每次返回都**同步**求值一次
 * `(window.__danmuboxHandleBack && window.__danmuboxHandleBack()) === true`：
 * 页面「消费掉」这次返回 → 原生什么都不做；没消费 → 原生退出应用。求值表达式与
 * `MainActivity.BACK_SCRIPT` 必须一字不差地对应（见那一处注释里「为什么用返回值」）。
 *
 * 桌面端也会挂上这个函数（契约要求「存在」），但**没有任何人调用它**，因此桌面行为不变。
 *
 * 三级顺序（`docs/ui.md` §2.1）在 JS 侧只落成两级 —— 第 3 级「已经是根页面」等于
 * **没有人消费**，由原生拿到 `false` 后退出应用。
 */

/** 一个「我能消费这次返回」的处理器：消费掉返回 `true`，与自己无关（交给下一级）返回 `false`。 */
export type BackHandler = () => boolean;

/**
 * 两级优先级：数字大的先试。**只在返回手势这一处用**，不参与渲染或样式。
 */
export const BACK_PRIORITY = {
  /** 第 1 级：任何打开的面板（账号对话框 / 表情 / 短语 / 筛选 / 房管 / 独立礼物栏）。 */
  panel: 2,
  /** 第 2 级：房间页 → 回房间列表（与房间头那枚圆形返回键同义）。 */
  page: 1,
} as const;

interface Entry {
  priority: number;
  /** 注册序号：同一优先级里**后注册的先试**（后打开的那一层盖住先打开的）。 */
  seq: number;
  handler: BackHandler;
}

const entries: Entry[] = [];
let nextSeq = 0;

/**
 * 注册一个返回处理器，返回注销函数（放进 effect 的清理里）。
 *
 * 注册时机即「这一层现在开着」的事实：面板关掉时注销，就不必在处理器里复述一遍
 * 「我现在是不是还开着」。
 */
export function registerBackHandler(priority: number, handler: BackHandler): () => void {
  const entry: Entry = { priority, seq: nextSeq++, handler };
  entries.push(entry);
  return () => {
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
  };
}

/**
 * 按优先级从高到低试一遍（同级后进先出）；第一次被消费即返回 `true`。
 *
 * 处理器只做「状态变更 + 返回 true」，不在这里判断自己是否还开着：它注册时就开着了。
 */
export function handleBack(): boolean {
  const ordered = [...entries].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  for (const entry of ordered) {
    if (entry.handler()) return true;
  }
  return false;
}

/** 把桥挂到 `window` 上（在 `main.tsx` 里、首次渲染之前调一次）。 */
export function installBackBridge(): void {
  window.__danmuboxHandleBack = handleBack;
}

/**
 * 落点是否在**系统手势区**（左右边缘那一条）内。
 *
 * 手势导航下，从边缘起手的返回会**先**把这个 DOWN 交给页面、再把整条触摸流 CANCEL 收走
 * （实测：`input swipe 0 …` 下页面收到 down(0,457) → cancel(31,457)）。页面若把这一下当
 * 「点在外面」，一次侧滑就变成两件事：先把面板点没了、返回再退一级 —— 面板那一级等于白设。
 * 因此收起面板之前先问这里，边缘那一条里的触摸**不当点击**用。
 *
 * 宽度取自原生下发的 `--gesture-left` / `--gesture-right`（Android 的 systemGestures inset）；
 * 取不到或为 0（三键导航、没有会抢触摸的系统手势）就不避让，行为与从前一致。
 */
export function isSystemBackGestureZone(x: number): boolean {
  const style = getComputedStyle(document.documentElement);
  const left = px(style.getPropertyValue("--gesture-left"));
  const right = px(style.getPropertyValue("--gesture-right"));
  if (left <= 0 && right <= 0) return false;
  return (left > 0 && x <= left) || (right > 0 && x >= document.documentElement.clientWidth - right);
}

/** 读一个 CSS 长度变量的数值；空串、`auto` 之类一律当 0。 */
function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

declare global {
  interface Window {
    /**
     * Android 外壳的系统返回入口：消费掉这次返回返回 `true`，没得可返回返回 `false`。
     * 桌面端存在但无人调用；协议与三级顺序见 `docs/ui.md` §2.1。
     */
    __danmuboxHandleBack?: () => boolean;
  }
}
