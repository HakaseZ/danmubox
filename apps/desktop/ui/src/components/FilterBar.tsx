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

interface Props {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
}

/**
 * 筛选与显示面板（issue #8 第一条：不再常驻占一行，收进工具栏弹出的面板）。
 *
 * 两块：消息类型白名单 / 显示开关。键名全部来自契约 §8 的权威清单。
 * 主题开关**不在**这里 —— 它在主界面「弹幕框」右侧，全局切换（docs/ui.md §8.3）。
 */
export function FilterBar({ prefs, onChange }: Props) {
  const toggleKind = (kind: MessageKind) => {
    const current = prefs["filter.kinds"];
    const next = current.includes(kind)
      ? current.filter((item) => item !== kind)
      : [...current, kind];
    // 全选等于不过滤；一个都不选则什么都看不到，因此至少保留一项。
    onChange({ "filter.kinds": next.length === 0 ? ALL_KINDS : next });
  };

  return (
    <div className={styles.filterGrid}>
      <section className={styles.filterSection}>
        <h3>消息类型</h3>
        <div className={styles.filterKinds}>
          {ALL_KINDS.map((kind) => (
            <label key={kind}>
              <input
                type="checkbox"
                checked={prefs["filter.kinds"].includes(kind)}
                onChange={() => toggleKind(kind)}
              />
              {KIND_LABEL[kind]}
            </label>
          ))}
        </div>
      </section>

      <section className={styles.filterSection}>
        <h3>显示</h3>
        {/* 整行的两格（字号滑杆 / 礼物栏下拉）各自占满一行，其余开关同排换行：
            竖屏 360 下它们是两行，宽屏下并成一行 —— 同一份 DOM（docs/ui.md §9.1）。 */}
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
          <label title="互动消息自动消失">
            <input
              type="checkbox"
              checked={prefs["ui.interact_auto_hide"]}
              onChange={(event) =>
                onChange({ "ui.interact_auto_hide": event.target.checked })
              }
            />
            互动消息自动消失
          </label>
          <label title="系统通知">
            <input
              type="checkbox"
              checked={prefs["ui.system_notice"]}
              onChange={(event) =>
                onChange({ "ui.system_notice": event.target.checked })
              }
            />
            系统通知
          </label>
          <label className={styles.filterSelect}>
            礼物栏
            <select
              value={prefs["ui.gift_panel_mode"]}
              onChange={(event) =>
                onChange({
                  "ui.gift_panel_mode": event.target.value as Prefs["ui.gift_panel_mode"],
                })
              }
            >
              <option value="merged">混在弹幕栏</option>
              <option value="separate">输入框下方独立栏</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}
