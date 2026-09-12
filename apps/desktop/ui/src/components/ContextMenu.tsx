import { useEffect, useLayoutEffect, useRef, useState } from "react";

import styles from "../app.module.css";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** 置灰原因，作为 `title` 显示（docs/ui.md §4.5 要求说明为什么不可用）。 */
  hint?: string;
  /** 破坏性操作（删除等），用警示色。 */
  danger?: boolean;
}

export interface MenuPoint {
  x: number;
  y: number;
}

interface Props {
  /** 触发点（右键坐标或按钮右下角），菜单以它为左上角并在视口内收敛。 */
  at: MenuPoint;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * 右键菜单（docs/ui.md §4.5）：消息行的复制 / @ / 回复 / 举报、短语的改名 / 删除都用它。
 *
 * 用 fixed 定位 + 视口收敛：菜单贴右下角弹出时不至于被裁掉。
 * 菜单本身不抢焦点（工具按钮的 `mousedown` 被 preventDefault），关闭后输入框的光标还在。
 */
export function ContextMenu({ at, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPoint>(at);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(at.y, window.innerHeight - height - 4)),
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      // 菜单内的点击交给按钮自己处理；只有点到别处才关。
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="db-context-menu"
      className={styles.contextMenu}
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? styles.menuItemDanger : undefined}
          disabled={item.disabled}
          title={item.hint}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
