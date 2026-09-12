import { useEffect, useState } from "react";

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

/** 过滤与样式控制条。键名全部来自 docs/contract.md §8 的权威清单。 */
export function FilterBar({ prefs, onChange }: Props) {
  const [keywords, setKeywords] = useState(prefs["filter.keywords"].join(" "));
  const committedKeywords = prefs["filter.keywords"].join(" ");

  // 只在「已保存的关键词」变化时回填输入框，避免拖动滑块时把正在输入的内容冲掉。
  useEffect(() => {
    setKeywords(committedKeywords);
  }, [committedKeywords]);

  const commitKeywords = () => {
    const next = keywords
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 0);
    if (next.join(" ") !== prefs["filter.keywords"].join(" ")) {
      onChange({ "filter.keywords": next });
    }
  };

  const toggleKind = (kind: MessageKind) => {
    const current = prefs["filter.kinds"];
    const next = current.includes(kind)
      ? current.filter((item) => item !== kind)
      : [...current, kind];
    // 全选等于不过滤；一个都不选则什么都看不到，因此至少保留一项。
    onChange({ "filter.kinds": next.length === 0 ? ALL_KINDS : next });
  };

  return (
    <div className={styles.toolbar}>
      <label>
        关键词
        <input
          value={keywords}
          size={12}
          placeholder="空格分隔"
          onChange={(event) => setKeywords(event.target.value)}
          onBlur={commitKeywords}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitKeywords();
          }}
        />
      </label>
      <label>
        <select
          value={prefs["filter.keywords_mode"]}
          onChange={(event) =>
            onChange({
              "filter.keywords_mode": event.target.value as Prefs["filter.keywords_mode"],
            })
          }
        >
          <option value="hide">命中隐藏</option>
          <option value="only">仅显示命中</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={prefs["filter.keywords_alert"]}
          onChange={(event) =>
            onChange({ "filter.keywords_alert": event.target.checked })
          }
        />
        命中高亮
      </label>

      <span>|</span>
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

      <span>|</span>
      <label>
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
      <label title="进场/互动消息显示一会儿就淡出；关掉则一直显示">
        <input
          type="checkbox"
          checked={prefs["ui.interact_auto_hide"]}
          onChange={(event) =>
            onChange({ "ui.interact_auto_hide": event.target.checked })
          }
        />
        互动消息自动消失
      </label>
      <label title="开播 / 下播 / 标题变更 / 公告">
        <input
          type="checkbox"
          checked={prefs["ui.system_notice"]}
          onChange={(event) =>
            onChange({ "ui.system_notice": event.target.checked })
          }
        />
        系统通知
      </label>
      <label>
        <input
          type="checkbox"
          checked={prefs["ui.merge_similar"]}
          onChange={(event) =>
            onChange({ "ui.merge_similar": event.target.checked })
          }
        />
        合并相似
      </label>
      <label>
        <select
          value={prefs["ui.gift_panel_mode"]}
          onChange={(event) =>
            onChange({
              "ui.gift_panel_mode": event.target.value as Prefs["ui.gift_panel_mode"],
            })
          }
        >
          <option value="merged">礼物混在弹幕栏</option>
          <option value="separate">独立礼物栏</option>
        </select>
      </label>
    </div>
  );
}
