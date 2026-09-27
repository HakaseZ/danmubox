/**
 * 共享分区（弹幕区 ⇕ 礼物栏）的**份额几何与开合判定** —— 纯逻辑：没有 React、没有 DOM。
 *
 * 为什么单独一个文件：这几条判据是 `SplitPanes.tsx` 里唯一「看不出来对错」的部分 ——
 * 拖动那一路活在指针监听器的闭包里，界面只能靠喂一串指针事件才看得出来。抽到这里之后
 * `node --test`（`docs/testing.md` §9）能直接钉住它们，见 `pane-split.test.ts`。
 *
 * **口径**（`docs/ui.md` §5.3 / §5.4；需求 §四 4.1–4.4、§五 5.1–5.4）：
 *
 * 1. **份额**（`ui.gift_pane_ratio`）= 礼物栏占共享分区高度的比例，**与它在上面还是下面无关**
 *    （换位不改比例）。域 `0.10–0.90`（闭区间，越界会被 IPC 以 `BAD_REQUEST` 拒掉），
 *    默认 `0.25` = 礼物 : 弹幕 = **1 : 3**（需求 4.1）。契约那一侧的同名默认值在
 *    `crates/danmubox-core/src/prefs.rs` —— 改这一处必须两处一起改。
 * 2. **单轴模型**（需求 5.1–5.4）：开与合不是两件事，而是**同一个数轴上的两个区间** ——
 *    **折叠 = 份额被压到下限以下**（`PANE_COLLAPSED_SHARE`）**+ 这一栏按自己的最小高度裁剪**；
 *    **展开 = 份额回到落盘那一份**（≥ 下限）。两栏的 `flex-grow` 之和因此恒为 1
 *    （小于 1 时 Flexbox 只分配「和」那么多自由空间，分区底部会白白空掉一截）。
 *    列表与三枚芯片**常驻挂载**，折叠不靠卸载表达：展开只改份额，不重挂、不重取，即刻呈现。
 * 3. **开合只在松手那一刻判**（需求 4.2）：拖动全程只改可视份额，一次都不改开合状态 ——
 *    否则就会出现「拖到一半被识别成已收起、之后拖不动」。键盘那条路没有拖动过程，
 *    仍是**即时提交**（`paneKeyboardStep`），语义与拖动一致：压到下限那一侧 = 收起。
 */

/** 份额的取值域（契约 §8 `ui.gift_pane_ratio`）：补丁越界会被 `BAD_REQUEST` 拒掉，所以拖动先在这里夹一次。 */
export const PANE_RATIO_MIN = 0.1;
export const PANE_RATIO_MAX = 0.9;
/**
 * 契约 §8 记的**默认份额**（= 1 : 3，需求 4.1）。`prefs` 一定给得出值，这里是它缺席时的兜底；
 * 与 `crates/danmubox-core/src/prefs.rs` 的 `ui.gift_pane_ratio` 默认值必须逐字相同。
 */
export const PANE_RATIO_DEFAULT = 0.25;
/**
 * **折叠态**的份额：压到下限**以下**（0 < 0.10）。折叠这一栏的高度因此与份额无关，
 * 只由它的最小高度（= 实测的总计条，见 `--gift-min-h`）兜住 —— 这就是单轴模型的那一端。
 * 拖动中不写它：拖动写的是指针给的那份份额，松手时才由 `paneFoldAfterDrag` 判要不要落到这里。
 */
export const PANE_COLLAPSED_SHARE = 0;
/** 方向键一次微调的步长。 */
export const PANE_KEY_STEP = 0.02;

/** 夹进取值域（闭区间）。 */
export function clampPaneRatio(value: number): number {
  return Math.min(PANE_RATIO_MAX, Math.max(PANE_RATIO_MIN, value));
}

/** 落盘前收一下精度：像素级的分辨率存成 17 位小数只会让 `prefs.json` 难看。 */
export function roundPaneRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 落盘的份额 → 渲染用的 `flex-grow`：
 * 折叠（或没有礼物栏）时取 `PANE_COLLAPSED_SHARE`，弹幕区拿走剩下的全部 —— 两个 grow 之和恒为 1。
 */
export function paneGrowOf(share: number, collapsed: boolean, hasGift: boolean): number {
  if (!hasGift || collapsed) return PANE_COLLAPSED_SHARE;
  return clampPaneRatio(share);
}

/** 一次开合变更：`expand` = 展开（份额回到落盘那一份），`collapse` = 收起（份额压到下限以下）。 */
export type PaneFold = "expand" | "collapse";

/**
 * **松手那一刻**的开合判定（需求 4.2 / 4.3）—— 单轴：只看松手时那一份份额与下限的关系。
 *
 * - `raw <= PANE_RATIO_MIN`（指针已经被压到下限、还想更小）→ **收起**；本来就是折叠的 → 不变；
 * - `raw > PANE_RATIO_MIN` 且按下时是折叠的（这一栏被拖开了）→ **展开**；
 * - 其余 → 不变（`null`：只落盘份额，不动开合）。
 *
 * `raw` 用的是**没被夹取、也没四舍五入**的那一份指针份额（`clamp(raw)` 在边界上会把两侧
 * 归到同一个数上，判据要用原始值才分得清「压到下限」与「刚好在下限之上」）。
 */
export function paneFoldAfterDrag(raw: number, collapsed: boolean): PaneFold | null {
  if (raw <= PANE_RATIO_MIN) return collapsed ? null : "collapse";
  return collapsed ? "expand" : null;
}

/** 键盘一次微调的结果：`ratio` = 新的份额（`null` = 不改份额），`fold` = 同时发生的开合变更。 */
export interface PaneKeyboardStep {
  ratio: number | null;
  fold: PaneFold | null;
}

/**
 * 键盘那条路（`↑` / `↓` 微调），**即时提交**：没有拖动过程，所以按键当场判、当场落盘。
 *
 * 语义与拖动那条路同源：`growGift` = 这一按的方向是**把礼物栏撑开**（`false` = 压小它）。
 * 已经停在下限还要往「压小」那一侧按 = **收起**（判据必须在「按不动了」之前 —— 夹在下限时
 * 下一份份额与当前相等，那是「到头了」，不是「什么都没发生」）；折叠态下按任何有效的一步
 * 都先把这一栏**展开**再走这一步（折叠态的屏幕几何由最小高度兜着，份额改在它上面看不见）。
 */
export function paneKeyboardStep(
  base: number,
  collapsed: boolean,
  growGift: boolean,
): PaneKeyboardStep {
  const from = clampPaneRatio(base);
  if (!growGift && from <= PANE_RATIO_MIN) {
    return { ratio: null, fold: collapsed ? null : "collapse" };
  }
  const next = roundPaneRatio(clampPaneRatio(from + (growGift ? PANE_KEY_STEP : -PANE_KEY_STEP)));
  if (next === from) return { ratio: null, fold: null };
  return { ratio: next, fold: collapsed ? "expand" : null };
}
