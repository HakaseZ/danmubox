import { KIND_LABEL, type MessageKind, type Prefs } from "../types";
import styles from "../app.module.css";

const ALL_KINDS: MessageKind[] = [
  "danmaku",
  "gift",
  "superchat",
  "interact",
  "guard",
  "system",
];
/**
 * 真正走 `filter.kinds` 白名单的那几种。
 *
 * `interact` **不在此列**：它的勾选框绑的是 `ui.interact_single_slot`（互动消息一律不进
 * 弹幕列表，改由底部浮层呈现，见 `docs/ui.md` §4.8）。取消到一项不剩时的兜底因此只恢复
 * 这五种，不把 `interact` 塞回去。
 */
const LIST_KINDS: MessageKind[] = ALL_KINDS.filter((kind) => kind !== "interact");

interface Props {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
}

/**
 * 筛选与显示面板（issue #8 第一条：不再常驻占一行，收进工具栏弹出的面板）。
 *
 * 两块：消息类型白名单 / 辅助功能（字号滑杆 + 七枚显示开关），键名全部来自契约 §8 的
 * 权威清单。两块的表单**同一形态**：两列勾选清单（issue 2609160959 第 3、4 条 ——
 * 消息类型原先是一排按钮样的芯片，用户要的是勾选清单；辅助开关跟随同一形态）。
 *
 * 「辅助功能」块里**没有**系统类消息的开关：要不要看开播 / 下播 / 标题变更 / 公告，
 * 就是「消息类型」里的「系统」勾选项（原先另有一个 `ui.system_notice` 开关，
 * 两个门盖的消息集合逐字相同，已按用户裁决删除，见 issue 2609140651 #1）。
 * 主题开关**不在**这里 —— 它在主界面「弹幕框」右侧，全局切换（docs/ui.md §8.3）。
 */
export function FilterBar({ prefs, onChange }: Props) {
  const toggleKind = (kind: MessageKind) => {
    const current = prefs["filter.kinds"];
    const next = current.includes(kind)
      ? current.filter((item) => item !== kind)
      : [...current, kind];
    // 全选等于不过滤；一个都不选则什么都看不到，因此至少保留一项。
    // 兜底里**不含 `interact`**：那一枚勾选框绑的是 `ui.interact_single_slot`（见下面
    // 清单里的分支），不归 `filter.kinds` 管 —— 塞回白名单只会让它躺一个自己控制不了的
    // kind（存量 `prefs.json` 里 `filter.kinds` 带 `interact` 的那些值仍照原样保留）。
    onChange({ "filter.kinds": next.length === 0 ? LIST_KINDS : next });
  };

  return (
    <div className={styles.filterGrid}>
      <section className={styles.filterSection} data-testid="db-filter-kinds">
        <h3>消息类型</h3>
        {/* 六种 kind 的勾选清单：**两列**（左列 1/3/5、右列 2/4/6，DOM 序 = 阅读序），
            窄屏 360 也放得下（docs/ui.md §8.5）。 */}
        <div className={styles.filterKinds}>
          {/* 互动/进场那一项**不进 `filter.kinds` 白名单**：它绑的是 `ui.interact_single_slot`
              —— 勾上 = 互动消息由弹幕区底部那处浮层槽位呈现（弹幕区为它留一段预留高度）；
              不勾 = 互动消息完全不显示（列表与浮层都不画，预留高度一并收回）。
              两种状态下互动消息都**不进弹幕列表**（`filtering.toDisplayRows`），
              所以这一项就是「看不看互动」的总开关（docs/ui.md §4.8）。
              `filter.kinds` 的取值域仍保留 `interact`（存量 `prefs.json` 里可能有它），
              只是这一枚勾选框不再读写它。 */}
          {ALL_KINDS.map((kind) =>
            kind === "interact" ? (
              <label key={kind} title="互动消息（底部浮层显示最新一条，不勾则完全不显示）">
                <input
                  type="checkbox"
                  checked={prefs["ui.interact_single_slot"]}
                  onChange={(event) =>
                    onChange({ "ui.interact_single_slot": event.target.checked })
                  }
                />
                {KIND_LABEL[kind]}
              </label>
            ) : (
              <label key={kind}>
                <input
                  type="checkbox"
                  checked={prefs["filter.kinds"].includes(kind)}
                  onChange={() => toggleKind(kind)}
                />
                {KIND_LABEL[kind]}
              </label>
            ),
          )}
        </div>
      </section>

      <section className={styles.filterSection} data-testid="db-filter-aux">
        <h3>辅助功能</h3>
        {/* 字号滑杆占满一整行（它需要宽度），六枚开关与「消息类型」同款两列清单：
            窄屏 360 与宽屏都是同一份 DOM（docs/ui.md §8.5、§9.1）。
            中间两枚是低价礼物（单个价值 ≤ 0.1 元）的开关（issue 2609162056 第 3、4 条）：
            「折叠低价礼物」只改礼物栏的分组形状、「剔除低价礼物统计」只改折叠头的统计口径，
            两枚**默认都关**（契约 §8）—— 默认形态因此与改前一致。
            最后一枚是**刷屏弹幕聚合**（issue 202609211940 第 3 条，`ui.danmaku_aggregate`）：
            **默认开**（改前的形态就是折着的），关掉即逐条显示（`aggregate.ts`）。 */}
        <div className={styles.filterFields}>
          <label className={styles.filterRange}>
            字号
            <input
              type="range"
              min={0.8}
              max={2}
              step={0.02}
              value={prefs["ui.font_scale"]}
              onChange={(event) =>
                onChange({ "ui.font_scale": Number(event.target.value) })
              }
            />
          </label>
          <label title="时间戳">
            <input
              type="checkbox"
              checked={prefs["ui.show_timestamp"]}
              onChange={(event) =>
                onChange({ "ui.show_timestamp": event.target.checked })
              }
            />
            时间戳
          </label>
          <label title="弹幕包含礼物">
            <input
              type="checkbox"
              checked={prefs["ui.gift_in_danmaku"]}
              onChange={(event) =>
                onChange({ "ui.gift_in_danmaku": event.target.checked })
              }
            />
            弹幕包含礼物
          </label>
          <label title="独立礼物栏">
            <input
              type="checkbox"
              checked={prefs["ui.gift_panel"]}
              onChange={(event) =>
                onChange({ "ui.gift_panel": event.target.checked })
              }
            />
            独立礼物栏
          </label>
          <label title="折叠低价礼物">
            <input
              type="checkbox"
              checked={prefs["ui.gift_collapse_cheap"]}
              onChange={(event) =>
                onChange({ "ui.gift_collapse_cheap": event.target.checked })
              }
            />
            折叠低价礼物
          </label>
          <label title="剔除低价礼物统计">
            <input
              type="checkbox"
              checked={prefs["ui.gift_exclude_cheap_stats"]}
              onChange={(event) =>
                onChange({ "ui.gift_exclude_cheap_stats": event.target.checked })
              }
            />
            剔除低价礼物统计
          </label>
          <label title="刷屏弹幕聚合">
            <input
              type="checkbox"
              checked={prefs["ui.danmaku_aggregate"]}
              onChange={(event) =>
                onChange({ "ui.danmaku_aggregate": event.target.checked })
              }
            />
            刷屏弹幕聚合
          </label>
        </div>
      </section>
    </div>
  );
}
