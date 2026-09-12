import { useEffect, useState } from "react";

import styles from "../app.module.css";

interface Props {
  /** 头像 URL（`Message.face`）。空串 = 该条没有头像，不渲染。 */
  url?: string;
  /** 昵称，用于加载失败时的首字符占位与 title。 */
  name: string;
}

/**
 * 发言用户头像（需求 §2.6 / 契约 §5 `Message.face`）。
 *
 * - `face` 为空串时不渲染任何东西：上游没给头像就没有这一列，不画假图。
 * - 加载失败（CDN 404 / 防盗链）时退化成昵称首字符的圆形占位，行高与列宽不跳。
 */
export function Avatar({ url, name }: Props) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (url === undefined || url.length === 0) return null;

  if (failed) {
    return (
      <span className={styles.avatarFallback} data-testid="db-msg-avatar" title={name}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className={styles.avatar}
      data-testid="db-msg-avatar"
      src={url}
      alt=""
      title={name}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
