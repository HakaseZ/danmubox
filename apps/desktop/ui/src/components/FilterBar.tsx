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
 * 两块：消息类型白名单 / 辅助功能（字号滑杆 + 六枚显示开关），键名全部来自契约 §8 的
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
    onChange({ "filter.kinds": next.length === 0 ? ALL_KINDS : next });
  };

  return (
    <div className={styles.filterGrid}>
      <section className={styles.filterSection} data-testid="db-filter-kinds">
        <h3>消息类型</h3>
        {/* 六种 kind 的勾选清单：**两列**（左列 1/3/5、右列 2/4/6，DOM 序 = 阅读序），
            窄屏 360 也放得下（docs/ui.md §8.5）。 */}
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

      <section className={styles.filterSection} data-testid="db-filter-aux">
        <h3>辅助功能</h3>
        {/* 字号滑杆占满一整行（它需要宽度），六枚显示开关与「消息类型」同款两列清单：
            窄屏 360 与宽屏都是同一份 DOM（docs/ui.md §8.5、§9.1）。
            末两枚是低价礼物（单个价值 ≤ 0.1 元）的两枚开关（issue 2609162056 第 3、4 条）：
            「折叠低价礼物」只改礼物栏的分组形状、「剔除低价礼物统计」只改折叠头的统计口径，
            两枚**默认都关**（契约 §8）—— 默认形态因此与改前一致。 */}
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
        </div>
      </section>
    </div>
  );
}
