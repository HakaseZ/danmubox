import { useEffect, useState } from "react";

import styles from "../app.module.css";

interface Props {
  /** 头像 URL（`Message.face`）。空串 = 该条没有头像，不渲染。 */
  url?: string;
  /** 昵称，用于加载失败时的首字符占位与 title。 */
  name: string;
  /**
   * 头像的 `data-testid`（默认 `db-msg-avatar`）。
   * 礼物栏那一份走 `db-gift-avatar` —— 弹幕区与礼物栏共用这一个组件（docs/ui.md §5.3），
   * 两处的头像必须能被分别选中：否则「弹幕流里还有没有这条」的断言会被礼物栏那一份蒙混过去。
   */
  testId?: string;
}

/**
 * 发言用户头像（需求 §2.6 / 契约 §5 `Message.face`）。
 *
 * - `face` 为空串时不渲染任何东西：上游没给头像就没有这一列，不画假图。
 * - 加载失败（CDN 404 / 防盗链）时退化成昵称首字符的圆形占位，行高与列宽不跳。
 */
export function Avatar({ url, name, testId }: Props) {
  const [failed, setFailed] = useState(false);
  const id = testId ?? "db-msg-avatar";

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (url === undefined || url.length === 0) return null;

  if (failed) {
    return (
      <span className={styles.avatarFallback} data-testid={id} title={name}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className={styles.avatar}
      data-testid={id}
      src={url}
      alt=""
      title={name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
