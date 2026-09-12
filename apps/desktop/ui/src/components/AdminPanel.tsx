import { useState } from "react";

import type { AdminAction, AdminUser } from "../types";
import styles from "../app.module.css";

interface Props {
  /** 是不是本直播间房管。只影响提示文案——只读列表无权限也允许打开看上游回应。 */
  isAdmin: boolean;
  silent: AdminUser[];
  blacklist: AdminUser[];
  keywords: string[];
  /** 三块各自的读取错误：原样 code + message（不翻译、不猜测上游语义）。 */
  errors: { silent?: string; blacklist?: string; keywords?: string };
  busy: boolean;
  onRefresh: () => void;
  /** 面板只负责发起动作，二次确认与执行都在上层。 */
  onConfirm: (action: AdminAction) => void;
  onClose: () => void;
}

function name(user: AdminUser): string {
  return user.uname.length > 0 ? user.uname : `uid ${user.uid}`;
}

function parseUid(value: string): number | undefined {
  const uid = Number(value.trim());
  return Number.isInteger(uid) && uid > 0 ? uid : undefined;
}

/**
 * 房管面板（issue #3）：禁言名单 / 黑名单 / 屏蔽词三块，每块都有列表与增删。
 *
 * 三条规则来自需求：
 * - 三块**都允许无权限时打开**：上游会拒绝并给出 `code` + `message`，界面原样展示，
 *   不翻译成自造文案、也不在本地假装成功。
 * - 所有写操作（禁言 / 拉黑 / 解除 / 增删词）都只提交给上层，由那里出**二次确认**——
 *   这些动作会不可逆地影响他人。
 * - 增删的输入沿用输入区已有的样式（input + 按钮，屏蔽词回车即可添加）。
 */
export function AdminPanel({
  isAdmin,
  silent,
  blacklist,
  keywords,
  errors,
  busy,
  onRefresh,
  onConfirm,
  onClose,
}: Props) {
  const [muteUid, setMuteUid] = useState("");
  const [blackUid, setBlackUid] = useState("");
  const [word, setWord] = useState("");

  return (
    <div className={styles.adminPanel} data-testid="db-admin-panel">
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>房管面板</span>
        <span className={styles.previewLabel}>
          {isAdmin
            ? "你是本直播间房管"
            : "只读：你不是本直播间房管；列表可以看上游回应，写操作会被上游拒绝"}
        </span>
        <span className={styles.composerSpacer} />
        <button onMouseDown={(event) => event.preventDefault()} onClick={onRefresh} disabled={busy}>
          刷新
        </button>
        <button
          data-testid="db-admin-close"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <section className={styles.adminSection}>
        <div className={styles.adminSectionHead}>
          <span className={styles.panelTitle}>禁言名单（{silent.length}）</span>
        </div>
        {errors.silent !== undefined && (
          <div className={styles.adminError} data-testid="db-admin-error">
            {errors.silent}
          </div>
        )}
        <div className={styles.adminList}>
          {silent.length === 0 ? (
            <span className={styles.previewLabel}>（名单为空）</span>
          ) : (
            silent.map((user) => (
              <div
                key={user.uid}
                className={styles.adminItem}
                data-testid="db-admin-silent-item"
              >
                <span>{name(user)}</span>
                <button
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={busy}
                  onClick={() =>
                    onConfirm({ kind: "unmute", uid: user.uid, uname: user.uname })
                  }
                >
                  解除禁言
                </button>
              </div>
            ))
          )}
        </div>
        <div className={styles.adminForm}>
          <input
            className={styles.adminInput}
            value={muteUid}
            placeholder="观众 uid"
            onChange={(event) => setMuteUid(event.target.value)}
          />
          <button
            disabled={busy || parseUid(muteUid) === undefined}
            title="时长在确认条上选"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const uid = parseUid(muteUid);
              if (uid !== undefined) {
                onConfirm({ kind: "mute", uid, uname: "", hour: 0 });
              }
            }}
          >
            禁言
          </button>
        </div>
      </section>

      <section className={styles.adminSection}>
        <div className={styles.adminSectionHead}>
          <span className={styles.panelTitle}>黑名单（{blacklist.length}）</span>
        </div>
        {errors.blacklist !== undefined && (
          <div className={styles.adminError} data-testid="db-admin-error">
            {errors.blacklist}
          </div>
        )}
        <div className={styles.adminList}>
          {blacklist.length === 0 ? (
            <span className={styles.previewLabel}>（名单为空）</span>
          ) : (
            blacklist.map((user) => (
              <div
                key={user.uid}
                className={styles.adminItem}
                data-testid="db-admin-blacklist-item"
              >
                <span>{name(user)}</span>
                <button
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={busy}
                  onClick={() =>
                    onConfirm({
                      kind: "blacklist_del",
                      uid: user.uid,
                      uname: user.uname,
                    })
                  }
                >
                  移出黑名单
                </button>
              </div>
            ))
          )}
        </div>
        <div className={styles.adminForm}>
          <input
            className={styles.adminInput}
            value={blackUid}
            placeholder="观众 uid"
            onChange={(event) => setBlackUid(event.target.value)}
          />
          <button
            disabled={busy || parseUid(blackUid) === undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const uid = parseUid(blackUid);
              if (uid !== undefined) {
                onConfirm({ kind: "blacklist_add", uid, uname: "" });
              }
            }}
          >
            拉黑
          </button>
        </div>
      </section>

      <section className={styles.adminSection}>
        <div className={styles.adminSectionHead}>
          <span className={styles.panelTitle}>屏蔽词（{keywords.length}）</span>
        </div>
        {errors.keywords !== undefined && (
          <div className={styles.adminError} data-testid="db-admin-error">
            {errors.keywords}
          </div>
        )}
        <div className={styles.adminList}>
          {keywords.length === 0 ? (
            <span className={styles.previewLabel}>（还没有屏蔽词）</span>
          ) : (
            keywords.map((item) => (
              <div
                key={item}
                className={styles.adminItem}
                data-testid="db-admin-keyword-item"
              >
                <span>{item}</span>
                <button
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={busy}
                  onClick={() => onConfirm({ kind: "keyword_del", word: item })}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </div>
        <div className={styles.adminForm}>
          <input
            className={styles.adminInput}
            value={word}
            placeholder="屏蔽词，回车添加"
            onChange={(event) => setWord(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const value = word.trim();
              if (value.length === 0) return;
              onConfirm({ kind: "keyword_add", word: value });
              setWord("");
            }}
          />
          <button
            disabled={busy || word.trim().length === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const value = word.trim();
              if (value.length === 0) return;
              onConfirm({ kind: "keyword_add", word: value });
              setWord("");
            }}
          >
            添加屏蔽词
          </button>
        </div>
      </section>
    </div>
  );
}
