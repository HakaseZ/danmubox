// 冒烟夹具 → 页内数据（Node 侧）。
//
// 这是整份冒烟里**唯一**读 `smoke/fixtures/*.json` 的地方：把真实载荷（或按协议文档字段表构造的
// 礼物 / SC / 大航海样本）派生成页内 mock 用的形状。夹具的出处与脱敏口径见 docs/testing.md §9.1；
// 页内那条「夹具必须能失败」的纪律见 docs/ui.md §15 运行纪律第 6 条。
//
// 出口只有一个：下面的 `pageData` —— 由 smoke/room-page.mjs 序列化成页内 `__SMOKE_DATA`。
// 页内的断言块只认 mock 里那几个别名（EMOTES / ROW_FIXTURES / fixtureRoom / …），不直接读这一份。

import { readFileSync } from "node:fs";

/* 房间信息夹具（真实载荷，只读抓取 2026-09-12）：**mock 与断言都从这里派生，不许手写**。
   手写的「测试主播 · 测试房间」正是 #17/#18 的病因：解析把 `anchor_info` 挂在
   `getRoomPlayInfo` 上（真实响应里根本没有这个键），手写夹具照样绿，界面却显示占位词。
   两份夹具各是一次真实响应（公开测试房间 1 = room_id 5440）：
     fixtures/room-play-info.json  GET /xlive/web-room/v1/index/getRoomPlayInfo?room_id=5440
     fixtures/room-h5-info.json    GET /xlive/web-room/v1/index/getH5InfoByRoom?room_id=5440
   房间名（主播名 · 标题）只存在于后者：`data.anchor_info.base_info.uname` / `data.room_info.title`。 */
const roomPlayFixture = JSON.parse(
  readFileSync(new URL("../fixtures/room-play-info.json", import.meta.url), "utf8"),
);
const roomH5Fixture = JSON.parse(
  readFileSync(new URL("../fixtures/room-h5-info.json", import.meta.url), "utf8"),
);
/** 真实载荷派生的房间（`RoomView` 形状）：`connected` / `buffered` 是冒烟的会话态。 */
const FIXTURE_ROOM = {
  room_id: roomPlayFixture.data.room_id,
  short_id: roomPlayFixture.data.short_id,
  anchor_uid: roomPlayFixture.data.uid,
  anchor_uname: roomH5Fixture.data.anchor_info.base_info.uname,
  title: roomH5Fixture.data.room_info.title,
  live_status: roomPlayFixture.data.live_status,
  connected: true,
  buffered: 1,
};


/** 真实表情载荷（只读 GET 固化的上游响应），见该文件自己的 `_note`。 */
const EMOTE_FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/emotes.json", import.meta.url), "utf8"),
);

/**
 * 礼物 / SC / 大航海的夹具（**按协议文档字段表构造**，不是真实抓包派生；
 * 依据与脱敏口径见该文件自己的 `_note` 与 docs/testing.md §9.1）。
 * 构造而非实测的原因：`AGENT.md` §8 第 16 条禁止为测试发送礼物 / 醒目留言 / 大航海，
 * 这类事件在本项目里拿不到授权样本；而留给它的三类新行为（礼物栏一条一行、金额带单位、
 * SC 卡片）不能零断言。
 */
const GIFT_FIXTURE = JSON.parse(
  readFileSync(
    new URL("../fixtures/gift-sc-guard-rows.json", import.meta.url),
    "utf8",
  ),
);

/** 表情替身的底色（`#` 必须写成 `%23`，否则 `#` 会被当成 data URI 的片段起始、图直接坏掉）。 */
const EMOTE_FILL = ["%23f09300", "%2300aeec", "%23e67e22", "%238e44ad", "%232980b9", "%234ade80"];

/**
 * 真实图的内联替身：**固有尺寸与真实图逐张一致**（`width`/`height` 就是上游给的那两个数），
 * 只把像素内容换成纯色块。
 *
 * 这一条是整份冒烟的关键：真实图在 `i0.hdslb.com`（离线跑不到），但**尺寸特征必须一样** ——
 * 手写的 64×64 正方形表情永远撞不出「图比格子宽」，而真站的通用表情是 200×60 的横条
 * （只给 `height` 的话宽度会按 3.33:1 算出 5em，撑出 3em 的格子）。
 */
function emoteImage(width, height, seed) {
  const fill = EMOTE_FILL[seed % EMOTE_FILL.length];
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='" +
    width +
    "' height='" +
    height +
    "' viewBox='0 0 " +
    width +
    " " +
    height +
    "'><rect width='" +
    width +
    "' height='" +
    height +
    "' fill='" +
    fill +
    "'/></svg>"
  );
}

/**
 * 包分类：逐条照搬 `crates/danmubox-bili/src/emote.rs` 的 `classify_package`
 * （包名关键字 → 表情级解锁字段 → `pkg_type`）。
 */
function classifyFixturePackage(pkg) {
  const name = pkg.pkg_name ?? "";
  const items = pkg.emoticons ?? [];
  if (/舰|航海|提督|总督/.test(name)) return "guard";
  if (/粉丝|勋章/.test(name)) return "medal";
  const gated = items.some((item) => {
    const level = item.unlock_need_level ?? 0;
    const identity = item.identity ?? 99;
    return level > 0 || (identity >= 1 && identity <= 4);
  });
  if (gated) return "medal";
  return pkg.pkg_type === 2 ? "room" : "common";
}

/** 一个真实包的 `emoticons[]` → `Emote[]`（照搬 `map_packages` 的字段口径）。 */
function mapFixturePackage(roomId, pkg, seedBase) {
  const kind = classifyFixturePackage(pkg);
  return (pkg.emoticons ?? []).map((item, index) => {
    const seed = seedBase + index;
    return {
      key: `${pkg.pkg_id ?? 0}:${item.emoticon_unique ?? index}`,
      emoticon_unique: item.emoticon_unique ?? "",
      width: item.width ?? 0,
      height: item.height ?? 0,
      is_dynamic: item.is_dynamic !== 0,
      in_player_area: item.in_player_area !== 0,
      bulge_display: item.bulge_display !== 0,
      package_kind: kind,
      text: item.emoji ?? item.descript ?? "",
      url: emoteImage(item.width ?? 0, item.height ?? 0, seed),
      room_id: kind === "room" ? roomId : 0,
      locked: item.perm === 0,
    };
  });
}

/** 一份真实响应 → `Emote[]`（展平全部包）。 */
function mapFixtureResponse(roomId, response, seedBase) {
  const out = [];
  for (const pkg of response.data.data) {
    out.push(...mapFixturePackage(roomId, pkg, seedBase + out.length));
  }
  return out;
}

/** 主站「我的表情」→ `Emote[]`（照搬 `map_owned_packages`：唯一键 `upower_` + 文本）。 */
function mapFixtureOwned(response, seedBase) {
  const out = [];
  for (const pkg of response.data.packages) {
    for (const item of pkg.emote ?? []) {
      if (!item.text || !item.url) continue;
      const seed = seedBase + out.length;
      // 主站表情不给宽高（实测：`width`/`height` 字段不存在），真实图是 162×162 见方。
      out.push({
        key: `${pkg.id}:${item.id}`,
        emoticon_unique: `upower_${item.text}`,
        width: 1,
        height: 1,
        is_dynamic: false,
        in_player_area: false,
        bulge_display: false,
        package_kind: "owned",
        text: item.text,
        url: emoteImage(162, 162, seed),
        room_id: 0,
        locked: false,
      });
    }
  }
  return out;
}

/**
 * 冒烟的 `emotes_list` 替身 = 两份真实载荷并起来：
 * 公开测试房间（`room_id 5440`）只下发「通用表情」一个包，粉丝牌 / 本房间那两包要有在播房间才有，
 * 因此把 `live_rich` 的两个包也一并按**替身房间 5440** 呈现（房间号按仓库规矩不入库）。
 */
const FIXTURE_EMOTES = {
  live: [
    ...mapFixtureResponse(5440, EMOTE_FIXTURE.live, 0),
    ...mapFixtureResponse(5440, EMOTE_FIXTURE.live_rich, 7),
  ],
  owned: mapFixtureOwned(EMOTE_FIXTURE.owned, 3),
};

/** 弹幕行里的表情样本也取自真实载荷：行内一条通用（200×60）、独占一行一条 `bulge_display`。 */
const ROW_EMOTE_SAMPLES = {
  inline: FIXTURE_EMOTES.live.find(
    (emote) => emote.package_kind === "common" && emote.bulge_display === false,
  ),
  bulge: FIXTURE_EMOTES.live.find((emote) => emote.bulge_display === true),
};

/**
 * 弹幕行的**真实载荷**（`DANMU_MSG`，见该文件自己的 `_note`）：用户 2026-09-12 报的那条正文行
 * 与一条真实表情包弹幕。冒烟里这两行**不许手写** —— 手写的「测试主播 / 64×64 表情」正是
 * 「表情把格子撑破」这类 bug 逃过验证的根因（同 emotes.json 的口径）。
 */
const ROW_FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/danmaku-rows.json", import.meta.url), "utf8"),
);

/**
 * 关注列表的**真实取样**（用户 2026-09-13 报的「看不到未开播的关注」）：
 * 由 `fixtures/follow-status-raw.json`（真实响应，已脱敏）派生，**70 条、取样当时全部未开播**。
 *
 * 为什么用这份而不是手写：此前冒烟里的「离线甲 / 离线乙」是**手造的**，于是
 * 「上游只给在播房间、未开播的一个都不返回」这个真实故障在冒烟里从来照不出来。
 * 现在列表里绝大多数条目都是真实取样，未开播项一旦丢掉（过滤 / 分页 / 渲染），冒烟必红。
 */
const FOLLOW_FIXTURE = JSON.parse(
  readFileSync(new URL("../fixtures/follow-list.json", import.meta.url), "utf8"),
);

/** 真实 CDN 图的**内联替身**：固有尺寸与真图一样（头像原图直出，见 app.module.css 的 512 事故）。 */
function inlineImage(width, height, fill) {
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='" +
    width +
    "' height='" +
    height +
    "'><rect width='" +
    width +
    "' height='" +
    height +
    "' fill='" +
    fill +
    "'/></svg>"
  );
}

/**
 * 一条 `DANMU_MSG` 载荷 → `Message`：取值路径**照搬** `crates/danmubox-bili/src/cmd.rs::danmaku`
 * —— 正文 `info[1]`、颜色 `info[0][3]`、时间戳 `info[0][4]`、本房间舰长 `info[7]`、
 * 用户 `info[0][15].user`（粉丝牌取 `medal.{level,name,v2_medal_color_*}`）、
 * 表情 `info[0][13]`（**对象**才算，字符串 `"{}"` 不算）、`extra`（JSON 字符串）里的
 * `id_str` 与回复关系。
 *
 * 只有两类值不照搬：① 图床地址换成本地替身（真图在 i0.hdslb.com，离线跑不到，
 * 但**固有尺寸必须一致**——162×162 的方图只给 height 就会「看起来没问题」）；
 * ② 夹具里被脱敏成 `<redacted>` 的字段（uid 等）按「上游没给」处理，与 Rust 侧的
 * `unwrap_or(0)` / `unwrap_or_default()` 同一语义。
 */
function messageFromDanmakuPayload(payload, roomId = 5440) {
  const info = payload.info;
  const meta = Array.isArray(info[0]) ? info[0] : [];
  const slot = meta[15] ?? {};
  const user = slot.user ?? {};
  let extra = {};
  try {
    extra = JSON.parse(slot.extra ?? "{}");
  } catch {
    extra = {};
  }
  const num = (value) => (typeof value === "number" ? value : 0);
  const str = (value) => (typeof value === "string" && value !== "<redacted>" ? value : "");
  const pointer = (root, path) =>
    path.split("/").reduce((node, key) => (node == null ? undefined : node[key]), root);
  // 表情：`info[0][13]` 是对象、且有非空 url 时才算（非表情弹幕这一格是字符串 "{}"）
  const rawEmote = meta[13];
  const emote =
    rawEmote && typeof rawEmote === "object" && typeof rawEmote.url === "string" && rawEmote.url
      ? {
          emoticon_unique: rawEmote.emoticon_unique ?? "",
          // 上游给 http，实现侧会升到 https（crates/danmubox-bili/src/asset.rs），这里照搬
          url: inlineImage(rawEmote.width ?? 0, rawEmote.height ?? 0, "%23c08a2e"),
          width: num(rawEmote.width),
          height: num(rawEmote.height),
          is_dynamic: num(rawEmote.is_dynamic) !== 0,
          in_player_area: num(rawEmote.in_player_area) !== 0,
          bulge_display: num(rawEmote.bulge_display) !== 0,
        }
      : null;
  const rawFace = str(user.base?.face);
  return {
    local_id: 1,
    room_id: roomId,
    kind: "danmaku",
    ts: num(meta[4]) || Date.now(),
    uid: num(user.uid),
    uname: str(pointer(user, "base/name")),
    // 头像原图直出（512 见方）：替身保持同样的固有尺寸，否则「没给宽高就顶爆」量不出来
    face: rawFace.length > 0 ? inlineImage(512, 512, "%2300aeec") : "",
    content: typeof info[1] === "string" ? info[1] : "",
    color: num(meta[3]),
    medal_level: num(pointer(user, "medal/level")),
    medal_name: str(pointer(user, "medal/name")),
    // 缺键按「亮」（与后端 parse 同一口径）：is_light 是官方画不画牌的唯一判据。
    medal_lit: num(pointer(user, "medal/is_light") ?? 1) !== 0,
    medal_color_start: str(pointer(user, "medal/v2_medal_color_start")),
    medal_color_end: str(pointer(user, "medal/v2_medal_color_end")),
    medal_color_border: str(pointer(user, "medal/v2_medal_color_border")),
    medal_color_text: str(pointer(user, "medal/v2_medal_color_text")),
    medal_guard_level: num(pointer(user, "medal/guard_level")),
    guard_level: num(info[7]),
    is_admin: num(info[2]?.[2]) === 1,
    reply_to_uid: num(extra.reply_mid),
    reply_to_uname: str(extra.reply_uname),
    reply_type_enum: num(extra.reply_type_enum),
    show_reply: extra.show_reply === true,
    reply_uname_color: str(extra.reply_uname_color),
    emote,
    is_history: false,
    amount: 0,
    combo_id: "",
    upstream_id: str(extra.id_str),
  };
}

/** 夹具里那两条真实弹幕（用户报的正文行 + 一条真实表情包弹幕）。 */
const ROW_FIXTURES = {
  text: messageFromDanmakuPayload(ROW_FIXTURE.text),
  emoticon: messageFromDanmakuPayload(ROW_FIXTURE.emoticon),
};

/**
 * 一条**无空格的长 ASCII 串**的取证样本（用户 2026-09-13：长文本要能好好折行）：
 * 直接取夹具那条真实载荷里的 CDN 地址（`info[0][15].user.base.face`，只脱敏哈希段），
 * **不手写**。别人在弹幕里贴链接就是这个形状：一整串没有空格、没有可断点，
 * 只能靠 `overflow-wrap` 就地断开。它在 360 宽下必然超出一行的宽度
 * （45 个 ASCII 字符 ≈ 300px+，而正文可用宽度不到 300px），所以「有没有断」是量得出来的。
 */
const ROW_ASCII_TOKEN = ROW_FIXTURE.text.info[0][15].user.base.face;


/**
 * 页内数据前奏要注入的那一份（`smoke/room-page.mjs` 把它序列化成页内 `__SMOKE_DATA`）。
 * 键名是页内变量名的语义化写法：mock 里的 `var EMOTES = __SMOKE_DATA.emotes` 这一层别名照旧保留
 * —— 断言读的还是 `EMOTES` / `ROW_FIXTURES` / `fixtureRoom` 这些老名字，快照与断言一字未动。
 *
 * `theme` 与 `recentRoomId` 不是夹具本体：前者是本次运行的档位（`SMOKE_THEME`），
 * 后者是「最近观看」排序断言要用的那个房间号 —— 它们以前是散在模板串里的 `${...}` 插值点。
 */
export const pageData = {
  emotes: FIXTURE_EMOTES,
  rowEmotes: ROW_EMOTE_SAMPLES,
  rowFixtures: ROW_FIXTURES,
  giftRows: GIFT_FIXTURE.rows,
  rowAscii: ROW_ASCII_TOKEN,
  followed: FOLLOW_FIXTURE,
  room: FIXTURE_ROOM,
  recentRoomId: FOLLOW_FIXTURE[0].room_id,
};
