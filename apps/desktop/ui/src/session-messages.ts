// **房内会话消息列表的规则**：一条实时消息能不能进列表、快照怎么落地、会话换代时列表怎么换。
//
// 为什么不放在 `store.ts` 里：这几条规则要能被 `node --test src/session-messages.test.ts` 直接钉住，
// 而 store 的值导入不带 `.ts` 后缀（Node 的类型擦除解析不了 `./ipc` 那种写法），`node --test`
// 根本 import 不进来。规则住在这里 = 不 import 任何运行时依赖的纯函数，与 `filtering.ts` 同一条口径。
// 它们不是渲染派生（那是 `filtering.ts` 的事），而是「哪些消息在列表里」这一层。
//
// 契约依据：`local_id` 是**会话内**自增序号（`docs/contract.md` §5）；缓冲的生命周期 = 一次房内会话
// （§4.3：离开房间即销毁、重进是全新会话）。

import type { Message, MessageKind, RoomView } from "./types.ts";

/**
 * 前端**按 `kind` 分档**的显示上限（`docs/contract.md` §4.3，用户 2026-09-22 第 5 条）。
 *
 * 取值与后端 `BufferCaps::default()` 的六档**逐项一致**：真正的会话缓冲在后端，
 * 前端这一层只是「不超过后端」的保险 —— 取更小会先于后端丢内容，取更大则等于没设。
 *
 * 为什么**不能**再有一个不分类型的统一上限：改前这里是一个 `CLIENT_MESSAGE_CAP = 2000`
 * 的**总数**上限，它在前端按总数丢最旧，等于把后端那六条道重新铺成一条队 ——
 * 礼物没到礼物档上限（2000）就被弹幕挤掉，正是用户报的「缓存好像没生效」。
 *
 * 礼物档内部**不再**按金额切三档（那三档是后端 `session.rs` 的保留策略）：
 * 分档的意义是**互不挤占**，按 `kind` 分开已经达到；再细分只会在前端多一套口径。
 */
export const KIND_CAPS: Record<MessageKind, number> = {
  danmaku: 5000,
  gift: 2000,
  superchat: 500,
  guard: 200,
  interact: 300,
  system: 200,
};

/**
 * 追加一条并守住**各档自己的**上限 —— 实时消息与本地待确认行（乐观渲染）都从这条进列表。
 *
 * 超出时只丢**这一个 `kind` 里最旧的那几条**，其它 `kind` 一条不动：互动 / 进场的洪水
 * 因此再也挤不掉弹幕与礼物（与后端 `MessageBuffer` 各道 FIFO 同一条口径）。
 * 单趟过滤（从旧到新）即可，不需要先分桶再拼回。
 */
export function appended(messages: Message[], message: Message): Message[] {
  const next = [...messages, message];
  const counts = new Map<MessageKind, number>();
  for (const item of next) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const overflow = new Map<MessageKind, number>();
  for (const [kind, count] of counts) {
    const cap = KIND_CAPS[kind] ?? 0;
    if (count > cap) overflow.set(kind, count - cap);
  }
  if (overflow.size === 0) return next;
  return next.filter((item) => {
    const left = overflow.get(item.kind) ?? 0;
    if (left > 0) {
      overflow.set(item.kind, left - 1);
      return false;
    }
    return true;
  });
}

/**
 * 这条弹幕是不是列表里已经有的**同一条**（`docs/ui.md` §4.7）？
 *
 * `(kind, uid, 正文, ts)` 逐字相同 = 上游给的**同一条**，不是「同一个人说了同样的话」：
 * 真人重复发言每条各有自己的上游 `ts`，合并判据（`filtering.ts` 的 `toDisplayRows`）
 * 照旧把它们合成 ×2 —— 那正是合并该管的事。只有「同一条被送了两遍」才会命中这里，
 * 实测来源是**上游的两条路**：同一条弹幕既在进场回填里、又从实时路径来
 * （`gethistory` 与 WS，或同一帧里压缩子包与明文子包各一份）。
 *
 * 只认 `danmaku`：它是唯一有「回填 + 实时回推」两条路进来的类型；礼物/互动本来就允许
 * 同一条被上游反复推（连击、榜单刷新），按内容去重会误伤。
 */
function alreadyListed(messages: Message[], incoming: Message): boolean {
  if (incoming.kind !== "danmaku") return false;
  return messages.some(
    (item) =>
      item.kind === incoming.kind &&
      item.uid === incoming.uid &&
      item.ts === incoming.ts &&
      item.content === incoming.content,
  );
}

/**
 * **实时消息入列的全部判据**（`store.onMessage` 落地那一半）。返回 `null` = 这条不该进列表。
 *
 * 两道判据，各有各的职责：
 * - **同一条已经在列**（`alreadyListed`）：上游两条路都会带它。只认 `danmaku`。
 * - **号不比列表末尾更大**：`local_id` 是**会话内**的单调序号（契约 §5）。进场时我们用
 *   `history_query` 整批覆盖一次，其间到达的事件可能已经包含在那批快照里，因此只接受「比列表
 *   末尾更新的」—— 否则同一个号会进列表两次（React 会报重复 key，渲染也会错乱）。
 *   `local_id === 0` 是「后端尚未分配」（契约 §5：出现在界面即缺陷），照既有口径放行。
 *
 * **它只保证「同一次会话内不重复」**：会话换代（「断开连接」之后再点「刷新连接」）时号会从 1
 * 重来，那种情况必须换列表 —— 见 `dropSessionMessages` / `adoptSessionSnapshot` 与 `refreshMode`。
 */
export function insertIncoming(messages: Message[], incoming: Message): Message[] | null {
  if (alreadyListed(messages, incoming)) return null;
  const last = messages.length > 0 ? messages[messages.length - 1].local_id : 0;
  if (incoming.local_id !== 0 && incoming.local_id <= last) return null;
  return appended(messages, incoming);
}

/**
 * 会话换代时把上一个会话的行摘掉，只留**本地待确认行**（`local_id` 为负，见 store 的 `insertPending`）。
 *
 * 留负数那几条：它们是本地乐观渲染出来的、后端缓冲里没有，用户刚发出去的那条不该因为一次刷新
 * 就消失 —— 上游回播的 `local_id` 照旧是那个负数，对账（`store` 的 `matchPending`）与超时兜底
 * 因此都还找得到它。
 */
export function dropSessionMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.local_id < 0);
}

/**
 * 把一份 `history_query` 快照落进列表：**整批换成快照**（它是该会话的事实），外加两类不属于这份快照的行 ——
 *
 * - **本地待确认行**（负数号）：见 `dropSessionMessages`；
 * - **号比快照最大的那个还大的行**：快照之后才到、已经上屏的那几条。总线到界面与缓冲
 *   （`core` 的 `session.rs` 里 collector 是另一个任务）是**两条路**，到达顺序不保证，
 *   丢掉它们等于静默少一条 —— 同一个号不会再发第二遍。
 */
export function adoptSessionSnapshot(snapshot: Message[], messages: Message[]): Message[] {
  const newest = snapshot.reduce((max, message) => Math.max(max, message.local_id), 0);
  const stragglers = messages.filter(
    (message) => message.local_id < 0 || message.local_id > newest,
  );
  return [...snapshot, ...stragglers];
}

/**
 * 这一次「刷新连接」（`rooms_reconnect`，契约 §7）要从哪一档走？
 *
 * - `"reconnect"`：**会话还在** —— 外壳只把当前连接掐了重连，缓冲与界面列表都不动
 *   （契约 §4.3 / `ui.md` §3.2「保留已收消息与滚动位置」）。
 * - `"reenter"`：**会话已结束**（用户点过「断开连接」，或房间被移除后又加回来）——
 *   外壳当场**重建一次会话**（`lib.rs::refresh_room`），缓冲从空开始、`local_id` 也从 1
 *   重新编号。这一档对界面就是**重新进房**：不换列表的话，末尾那个号是**另一个会话的号**，
 *   新消息全被判成「不比末尾更大」丢掉 —— 房间看着已连接却再也不上屏。
 *
 * 判据只认 `rooms[].connected`：它就是「外壳里还有没有这个房间的运行时」（`lib.rs` 的
 * `rooms_list`，契约 §5 `RoomView`），而「刷新」的行为正是由它分档。**不能拿
 * `status[room_id]` 判**：长连接掉线、即将退避重连时推的也是 `disconnected`
 * （`danmubox-bili/src/ws.rs`），那一次**会话还在**、缓冲还在，按「重新进房」处理会白白
 * 清掉用户正看着的弹幕。
 *
 * 列表里没有这个房间（理论上不该发生：房间页要求它在）→ 按 `"reconnect"`：拿不准时不动手，
 * 误换一次列表是**丢内容**，而漏换只是这一个房间继续保持现状。
 */
export function refreshMode(rooms: RoomView[], roomId: number): "reconnect" | "reenter" {
  const room = rooms.find((item) => item.room_id === roomId);
  return room !== undefined && !room.connected ? "reenter" : "reconnect";
}
