/**
 * 缺头像的消息：行内**惰性补取**的纯逻辑（需求 §三 3.2 / 3.4 / 3.6）。
 *
 * 为什么单独一层：这里的判据（**哪些行**该去问、**同一个 uid 只问一次**）没法从界面上
 * 「看着像对」推出来 —— 判错的表现分别是「大航海永远没头像」与「一场直播打上游上千次」，
 * 两者都不会报错。`store.ts` 只负责把结论落到状态、`RoomView` 只负责触发一次，
 * 判定本身收在这里，由 `node --test src/faces.test.ts` 直接钉住。
 */
import type { DisplayRow, SenderRef } from "./filtering";
import type { MessageKind } from "./types";

/**
 * 载荷里**没有**头像字段、需要按 uid 现取的那几类（契约 §5 / `docs/protocol.md` §10.6）。
 *
 * - `guard`：大航海（舰长 / 提督 / 总督）—— 需求 3.1 / 3.2 要求它必须有头像；
 * - `gift`：V1 礼物没有头像字段（V2 的头像来自 protobuf，通常非空）；
 *   界面这一层**分不出 V1 / V2**，所以按 kind 判：载荷给了头像的行根本不会进这里，
 *   没给的就补 —— 这正是「缺头像才补」；
 * - `superchat`：SC 的头像取 `uinfo.base.face`，实测里那个键本身未逐项观测到（附录 A9）。
 */
const FACE_KINDS: readonly MessageKind[] = ["guard", "gift", "superchat"];

/**
 * 头像查表：uid → 头像地址。
 *
 * **空串也是一条结论**（问过了、上游没给）：它是「不要再问」的标记，
 * 与「还没问过」（键不存在）不是一回事。
 */
export type FaceTable = Readonly<Record<number, string>>;

/**
 * 缺省的「在途集合」：空集。
 *
 * 调用方（`RoomView`）只算候选，**在途去重由 `store.ensureFaces` 收口**（那里才是在途标记的
 * 持有者），所以它不传第三个参数；测试与需要按在途过滤的场合自己传一份。
 */
const EMPTY_UIDS: ReadonlySet<number> = new Set();

/**
 * 从显示行里收集**还缺头像、且还没问过上游**的 uid（去重、按出现顺序）。
 *
 * 判据：行代表消息的 `kind` 属于 {@link FACE_KINDS}，且这一行的头像位取不到地址。
 * - 聚合行（`row.senders`，低价礼物桶那几位赠送者）一并收：那几张头像同样是从被折掉的
 *   礼物行来的，缺哪张补哪张（弹幕聚合行的 kind 是 `danmaku`，整行不进这里）。
 * - `known` 里已有该 uid（**含空串**）或 `inflight` 里的都跳过 —— 同一 uid 只发一次请求
 *   （需求 3.4；引擎侧也有一层进程级去重，这里是界面这一层的那一份）。
 * - `uid <= 0` 没有来源（系统消息、游客弹幕）：不问。
 */
export function missingFaceUids(
  rows: readonly DisplayRow[],
  known: FaceTable,
  inflight: ReadonlySet<number> = EMPTY_UIDS,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const consider = (sender: { uid: number; face?: string }) => {
    const { uid, face } = sender;
    if (uid <= 0) return;
    if ((face ?? "").length > 0) return;
    if (known[uid] !== undefined || inflight.has(uid) || seen.has(uid)) return;
    seen.add(uid);
    out.push(uid);
  };

  for (const row of rows) {
    if (!FACE_KINDS.includes(row.message.kind)) continue;
    consider(row.message);
    for (const sender of row.senders ?? []) consider(sender);
  }
  return out;
}

/**
 * 一行该画哪个头像地址：**载荷自带的优先**，否则查补取表；都没有则空串。
 *
 * 取到的空串与「没有」同解（`Avatar` 对空串不渲染任何东西），因此调用方不必分支。
 */
export function displayFace(
  face: string | undefined,
  uid: number,
  faces: FaceTable,
): string {
  if (face !== undefined && face.length > 0) return face;
  return faces[uid] ?? "";
}

/** 聚合 / 低价礼物桶行里某一位赠送者的头像地址（口径与 {@link displayFace} 相同）。 */
export function senderFace(sender: SenderRef, faces: FaceTable): string {
  return displayFace(sender.face, sender.uid, faces);
}
