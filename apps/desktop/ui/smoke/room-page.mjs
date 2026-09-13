// 房间页 UI 冒烟：mock IPC + 真实 dist 产物，同一份场景与断言跑在**两个引擎**上
// （Chromium 与 WebKit；后者就是 macOS 上 Tauri 用的 WKWebView —— 见 run-headless.mjs）。
// 宿主引擎必须在验证链里，否则「全绿」只对 Chromium 成立（2026-09-12 的教训）。
//
// 复现（一条命令，自己起浏览器，不依赖 relay 标签页）：
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs                 # Chromium
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs --engine webkit # 宿主引擎
// 只要快照（不跑浏览器）：
//   node smoke/room-page.mjs            # 生成 /tmp/danmubox-ui-smoke.html
//
// 场景自己跑完（含两段 8.6s 等待）后把断言快照写进 document.documentElement 的 data-smoke
// 属性（JSON）并 console.log 一份。
//
// 三条维护约定：
//   1) 断言只依赖对外可观察的行为（DOM 文本 / 几何 / 副作用记录），**不依赖 CSS-module 类名**；
//      定位一律走 `data-testid`（db-chat-scroll / db-msg-row / db-msg-time / db-context-menu /
//      db-account / db-panel / db-gift-dock / db-follow-item），那是稳定的对外契约。
//   2) 快照字段名是契约：`step1_*` … `step6_*` 的语义不得改（Main 按这套闭环），
//      新增断言另起字段名（layout* / menu* / time* / gift* / follow* / account*）。
//   3) **断「某个元素在不在」必须定位到那个元素自身**，不要拿整行 / 整块的 innerText 找关键词：
//      行的正文里恰好出现同样两个字就会让断言说谎（#12 那次的样本正文含「舰长」两字，
//      于是「不该有舰长标」的断言假失败——它反过来也会让真 bug 混过去）。
//      例：判徽标看 `span.innerText.trim() === "舰长"`，而不是 `row.innerText.indexOf("舰长")`。
//   4) 场景代码整段是一个模板字符串（MOCK）：里面的注释**不要写反引号**，否则字符串提前结束、语法直接崩。
//
// 覆盖：docs/ui.md §2、§3、§4、§6、§8。
//   step1  关注列表自动加载、列表页展示关注项
//   step2  进房间、历史回填可见
//   step3  头部在线/看过且无人气；系统/互动行的渲染与弱化；历史与实时同款
//   step4  系统通知开关
//   step5  互动行 8 秒后自动消失
//   step6  关掉自动消失后互动行常驻
//   layout 弹幕列表是唯一生长区；面板向上展开时列表上弹且最新一条不被遮挡；表情尺寸分级；
//          内容不足视口时整体贴底；头像列永远占位（昵称三列纵向对齐）；粉丝牌真彩色与兜底色；
//          回复关系可见；舰长标只认本房间的 guard_level；「回到最新」是**圆形图标钮**（下箭头，
//          与返回键同源矢量几何、同尺寸，无可见文字、可访问名走 aria-label）
//   emotes 主站「我的表情」分组可见、能选中、发出去带的是唯一键
//   menu   右键出菜单（复制 / ＠TA / 回复 / 屏蔽 / 主页 / 举报）并能关掉
//   mention＠ 目标与文本同源：文本里的 @名字 被删掉后发送就不带目标；回复的引用条照旧带目标
//   time   时间戳默认不渲染；开关打开后每行一列且等宽（纵向对齐）
//   limit  弹幕字数上限：上限来自 room_session.danmaku_length（40）；超限即截断并提示；
//          工具行常显 已用/上限；@昵称 前缀不计入有效上限
//   theme  主题**按钮**在**房间列表页页头**（点一下前进一档：亮 → 暗 → 自动，三下一轮回到原档；
//          图标随档变且三档同一套矢量规范、切档真的落到 <html data-theme>、深浅对比度达标）
//   gift   礼物栏在输入区下方、全宽、可折叠，展开不改变弹幕宽度
//   admin  房管权限前置（**有房管身份才有入口**；不是房管时菜单里没有这一项）、写操作二次确认与
//          请求形状、身份就绪即预载三块名单、面板三块收成三个 tab（roving tabindex + ←→/Home/End）、
//          单点动作走行右键菜单、批量一次确认按序执行、上游 code + message 原样展示、
//          身份被撤销后面板自动收起；面板里没有「刷新」按钮（重拉 = 关掉再开）
//   panels 五面板互斥：房管面板 / 表情 / 短语 / 筛选 / 独立礼物栏同时最多开一个
//   tabs   多标签隔离：切房间把面板 / 菜单 / 滚动跟随重置，草稿按「身份 × 房间」各留一份
//   follow 未开播也列出（**真实取样夹具**：未开播项第 1 页可见且翻页到底一条不少）、按最后开播时间排序、>30 条分页
//   account 账号区只留一行身份、**整行即入口**（独立的「账号」按钮已删；游客态同样可点，
//          键盘 Enter / Space 等价）；对话框里一行一个账号（昵称 + uid + 状态 + 操作），
//          **非当前账号整行可点即切换**
//          （role=button / tabIndex=0 / 键盘 Enter·Space 等价、行内动作按钮不冒泡、当前行不可点）；
//          对话框排版：二维码卡片与上方一级块同宽、间距 = 对话框统一行间距、「＋ 添加账号」居中；
//          切换后按新身份重拉 rooms_list / follow_list 并回到房间列表页（切号隔离）；
//          单账号也能看到「＋ 添加账号」；
//          添加 = account_qr_start（不带 target，永不覆盖）+ 2 秒轮询到 confirmed 后多一行且标为当前；
//          「重新登录」要二次确认且文案写明会覆盖谁；删除当前账号后自动切走、只剩一个时禁止删除；
//          退出登录后退回游客态

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/* 房间信息夹具（真实载荷，只读抓取 2026-09-12）：**mock 与断言都从这里派生，不许手写**。
   手写的「测试主播 · 测试房间」正是 #17/#18 的病因：解析把 `anchor_info` 挂在
   `getRoomPlayInfo` 上（真实响应里根本没有这个键），手写夹具照样绿，界面却显示占位词。
   两份夹具各是一次真实响应（公开测试房间 1 = room_id 5440）：
     fixtures/room-play-info.json  GET /xlive/web-room/v1/index/getRoomPlayInfo?room_id=5440
     fixtures/room-h5-info.json    GET /xlive/web-room/v1/index/getH5InfoByRoom?room_id=5440
   房间名（主播名 · 标题）只存在于后者：`data.anchor_info.base_info.uname` / `data.room_info.title`。 */
const roomPlayFixture = JSON.parse(
  readFileSync(new URL("./fixtures/room-play-info.json", import.meta.url), "utf8"),
);
const roomH5Fixture = JSON.parse(
  readFileSync(new URL("./fixtures/room-h5-info.json", import.meta.url), "utf8"),
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
  readFileSync(new URL("./fixtures/emotes.json", import.meta.url), "utf8"),
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
  readFileSync(new URL("./fixtures/danmaku-rows.json", import.meta.url), "utf8"),
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
  readFileSync(new URL("./fixtures/follow-list.json", import.meta.url), "utf8"),
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

/** 把值嵌进 MOCK 模板字符串：反引号与 `${` 必须先转义，否则场景代码会提前结束。 */
function embed(value) {
  return JSON.stringify(value).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
/**
 * 本次运行的档位：`SMOKE_THEME`（dark / light / system，默认 dark）。
 * 它写进 mock 的 `ui.theme`，由 App 的主题 effect 落到 <html data-theme> —— 也就是说
 * 深浅两套的截图与断言是**同一份场景**跑两遍，不是两套场景（docs/ui.md §15）。
 */
const THEME = process.env.SMOKE_THEME ?? "dark";
const MOCK = (theme) => `(function () {
  var EMOTES = ${embed(FIXTURE_EMOTES)};
  var ROW_EMOTES = ${embed(ROW_EMOTE_SAMPLES)};
  var ROW_FIXTURES = ${embed(ROW_FIXTURES)};
  // 无空格的长 ASCII 串（真实载荷里的 CDN 地址，见 Node 侧 ROW_ASCII_TOKEN 的说明）
  var ROW_ASCII = ${embed(ROW_ASCII_TOKEN)};
  var FOLLOW_FIXTURE_ROWS = ${embed(FOLLOW_FIXTURE)};
  var listeners = {};
  var calls = [];
  // 带参数的调用记录（看请求形状，如 chat_send 的表情唯一键）；calls 只有命令名，保持原样。
  var callsWithArgs = [];
  // 发送结果替身：默认 ok；用 __setSendOutcome 改成失败态，验证「浮动提示」那一套
  var sendOutcome = { outcome: "ok", detail: null };
  window.__setSendOutcome = function (outcome, detail) {
    sendOutcome = { outcome: outcome, detail: detail || null };
  };
  // 「上游还没回」的那一刻：扣住 chat_send 的回执，直到 __releaseSend 才 resolve。
  // 用来断言「失败标记只在（且必然在）上游明确拒绝之后才出现」—— 回执没到之前，
  // 那条本地行必须与已确认行逐项相同（用户 2026-09-13：上游返回只做校验）。
  var sendGate = null;
  window.__holdSend = function () { sendGate = { release: null }; };
  window.__releaseSend = function () {
    var gate = sendGate;
    sendGate = null;
    if (gate && gate.release) gate.release();
  };
  var nextId = 1;
  var prefs = {
    "ui.font_scale": 1, "ui.theme": "${theme}", "ui.auto_scroll": true,
    "ui.pause_on_hover": false,
    "ui.gift_panel_mode": "merged", "ui.interact_auto_hide": true, "ui.system_notice": false,
    "ui.show_timestamp": false,
    // 键清单照抄契约 §8（14 键）：关键词命中那三键随 item 9 一起删掉了，
    // 房管屏蔽词走 admin_keywords_*（IPC 命令，不是偏好键），不在这一份里。
    "composer.phrases": ["早上好"], "filter.uids": [],
    "filter.kinds": ["danmaku", "gift", "superchat", "interact", "guard", "system"],
    "filter.medal_level_min": 0, "history.buffer_rows": 5000,
    // 「最近观看」（契约 §8）：离线甲（room 300）先看过，**夹具第 1 条**（真实取样）后看过 ——
    // 用来看排序是否真的按它降序（见场景 step1 的 #16 断言）。
    "ui.recent_watched": { "300": 1789900000000, "${FOLLOW_FIXTURE[0].room_id}": 1789990000000 }
  };
  var nextLocal = 1;
  function msg(kind, content, isHistory, extra) {
    nextLocal += 1;
    var base = {
      local_id: nextLocal, room_id: 5440, kind: kind, ts: Date.now(),
      uid: 500 + nextLocal, uname: kind === "interact" ? "进场观众" + nextLocal : "观众" + nextLocal,
      content: content, color: 0, medal_level: 0, medal_name: "", medal_lit: true, guard_level: 0,
      medal_guard_level: 0, reply_to_uid: 0, reply_to_uname: "",
      is_admin: false, face: "", is_history: !!isHistory, amount: 0, combo_id: "",
      emote: null, upstream_id: "smoke-" + nextLocal
    };
    for (var key in (extra || {})) base[key] = extra[key];
    return base;
  }
  // 头像样本刻意用**原图尺寸 512×512**：上游 CDN 的头像是原图直出（没有尺寸后缀），
  // 一旦 CSS 没给出宽高，<img> 就按 512 渲染、把整页顶爆。32×32 的小图看不见这个毛病。
  var FACE_512 = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><rect width='512' height='512' fill='%2300aeec'/></svg>";
  // 房间字段来自**真实载荷夹具**（见文件头的 room-play-info.json / room-h5-info.json 说明），
  // 默认只有 1 个：标签条只在**多于一个**房间时渲染（App 既有语义），
  // 场景末尾用 __addSecondRoom() 补登记第二个，好把 #18（标签条显示主播名、不显示房间号）
  // 也验到——不然那一段永远没有可观察面。
  var fixtureRoom = ${JSON.stringify(FIXTURE_ROOM)};
  var rooms = [Object.assign({}, fixtureRoom)];
  // 第二个房间刻意是「**上游没给主播名与标题**」的形态：getH5InfoByRoom 到不了、
  // 或字段缺失时就是这样。它让「取不到名字」这条路在冒烟里真实可见——房间卡与标签
  // 都只能报房间号，**不许**渲染「未命名直播间」那种占位词（docs/ui.md §2.2）。
  // 幂等：场景在房间页里先登记一次（多标签隔离那一段），末尾再调一次也不会多出一条。
  window.__addSecondRoom = function () {
    if (rooms.some(function (r) { return r.room_id === 5555; })) return;
    rooms.push({
      room_id: 5555, short_id: 0, anchor_uid: 0, anchor_uname: "",
      title: "", live_status: 0, connected: false, buffered: 0
    });
  };
  // 关注列表（用户 2026-09-13：「关注但未开播的也一直没加载到主界面」）：
  // **70 条真实取样**直接来自夹具（fixtures/follow-list.json ← follow-status-raw.json，
  // 取证当天全部未开播）。此前这里只有手造的「离线甲 / 离线乙」，于是「上游只给在播房间、
  // 未开播一个都不返回」这个真实故障在冒烟里永远照不出来。
  // 只有下面 3 条是自造的：取证当天该账号无人开播，live_status == 1 的真实样本拿不到，
  // 而「在播置顶 / 标题行 / 最后开播时间」必须有条目可断言。字段名仍按 A28 实测
  // （liveTime → live_start_at）。
  var followed = FOLLOW_FIXTURE_ROWS.map(function (row, index) {
    // 头像位换成冒烟的内联替身：夹具里是脱敏后的 CDN 地址，真去请求只会挂网。
    return Object.assign({}, row, { face: index % 3 === 0 ? FACE_512 : "" });
  });
  followed = followed.concat([
    { room_id: 100, uname: "在播主播", face: FACE_512, title: "在播中的直播间标题", live_status: 1, group_name: "", live_start_at: 1789000000, online: 500 },
    { room_id: 200, uname: "离线乙", face: "", title: "离线乙的直播间标题", live_status: 0, group_name: "", live_start_at: 1789500000, online: 0 },
    { room_id: 300, uname: "离线甲", face: "", title: "", live_status: 0, group_name: "", live_start_at: 1700000000, online: 0 }
  ]);
  // 账号（契约 §7 accounts_list）：条目自带登录状态与身份。
  var accounts = [
    {
      name: "default", nickname: "本地测试", uid: 1000, logged_in: true, active: true,
      face: FACE_512
    }
  ];
  // 假二维码（21×21 图案）：真二维码由后端离线渲染，这里只要截图里**看得到图案**，
  // 免得「二维码是空白」被误读成界面 bug。
  var qrSvg = (function () {
    var cells = "";
    for (var y = 0; y < 21; y += 1) {
      for (var x = 0; x < 21; x += 1) {
        var finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
        if (finder || ((x * 7 + y * 13) % 5) < 2) {
          cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="21" height="21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/><g fill="#000">' + cells + '</g></svg>';
  })();
  var session = { logged_in: true, uid: 1000, nickname: "本地测试", active_profile: "default" };
  // 会话由账号表派生：谁 active 且 logged_in 就是当前会话，切换/登出/删除后都靠它同步。
  var syncSession = function () {
    var active = accounts.filter(function (a) { return a.active; })[0];
    var who = active && active.logged_in ? active : null;
    session = {
      logged_in: !!who, uid: who ? who.uid : 0, nickname: who ? who.nickname : "",
      active_profile: active ? active.name : ""
    };
    return session;
  };
  var history = msg("danmaku", "这是进场回填的历史弹幕", true);
  window.__smoke_next = function () { return msg; };
  window.__calls = calls;
  window.__callsWithArgs = callsWithArgs;
  window.__prefs = prefs;
  window.__followCalls = 0;
  window.__qrPolls = 0;
  window.__qrTarget = null;
  // 轮询失败开关：验证「失败要能重试」（面板留在原地 + 重新获取按钮）
  window.__qrFail = false;
  window.__mk = msg;
  window.__history = history;
  // 房管身份开关：默认是房管；冒烟中途翻成 false 验证「无权限时置灰 + 说明原因」。
  window.__admin = true;
  window.__adminFail = false;
  window.__setAdmin = function (value) { window.__admin = value; };
  window.__setAdminFail = function (value) { window.__adminFail = value; };
  window.__emit = function (event, payload) {
    (listeners[event] || []).forEach(function (id) {
      window["_" + id]({ event: event, id: id, payload: payload });
    });
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: function (cb, once) {
      var id = nextId++;
      Object.defineProperty(window, "_" + id, {
        value: function (result) { if (once) delete window["_" + id]; cb(result); },
        writable: false, configurable: true, enumerable: true
      });
      return id;
    },
    invoke: function (cmd, args) {
      calls.push(cmd);
      args = args || {};
      callsWithArgs.push({ cmd: cmd, args: args });
      switch (cmd) {
        case "app_info": return Promise.resolve({ version: "0.0.0-smoke", data_dir: "/tmp", config_path: "/tmp/config.toml", logged_in: true });
        case "session_status": return Promise.resolve(session);
        case "accounts_list": return Promise.resolve(accounts.map(function (a) {
          return { name: a.name, nickname: a.nickname, uid: a.uid, face: a.face, logged_in: a.logged_in, active: a.active };
        }));
        case "account_switch": {
          accounts.forEach(function (a) { a.active = a.name === args.name; });
          return Promise.resolve(syncSession());
        }
        case "account_qr_start": {
          window.__qrTarget = args.target === undefined ? null : args.target;
          window.__qrPolls = 0;
          return Promise.resolve({ key: "k1", url: "https://example.invalid/qr", svg: qrSvg });
        }
        // 第 1 次问 = 已扫待确认，第 2 次 = 确认：两条状态文案都要能在界面上看到。
        case "account_qr_poll": {
          if (window.__qrFail) {
            return Promise.reject({ code: "INTERNAL", message: "轮询扫码状态失败（冒烟替身）" });
          }
          window.__qrPolls += 1;
          if (window.__qrPolls < 2) return Promise.resolve({ state: "scanned", account: null });
          var name = window.__qrTarget || "扫码新用户";
          var existing = accounts.filter(function (a) { return a.name === name; })[0];
          accounts.forEach(function (a) { a.active = false; });
          if (existing) {
            existing.logged_in = true;
            existing.active = true;
          } else {
            existing = {
              name: name, nickname: "扫码新用户", uid: 2000, face: "", logged_in: true, active: true
            };
            accounts.push(existing);
          }
          syncSession();
          return Promise.resolve({ state: "confirmed", account: existing });
        }
        case "account_logout": {
          var lname = args.name;
          if (lname === undefined) {
            var act = accounts.filter(function (a) { return a.active; })[0];
            lname = act ? act.name : "";
          }
          accounts.forEach(function (a) { if (a.name === lname) a.logged_in = false; });
          return Promise.resolve(syncSession());
        }
        case "account_remove": {
          var wasActive = accounts.filter(function (a) { return a.name === args.name && a.active; }).length > 0;
          accounts = accounts.filter(function (a) { return a.name !== args.name; });
          if (wasActive && accounts.length > 0) accounts[0].active = true;
          return Promise.resolve(syncSession());
        }
        case "rooms_list": return Promise.resolve(rooms.map(function (r) { return Object.assign({}, r); }));
        case "prefs_get": return Promise.resolve(Object.assign({}, prefs));
        case "prefs_set": Object.assign(prefs, args.patch); return Promise.resolve(Object.assign({}, prefs));
        case "follow_list": window.__followCalls += 1; return Promise.resolve(followed.slice());
        case "history_query": return Promise.resolve([history]);
        // 表情替身：**全部由 「smoke/fixtures/emotes.json」（真实响应固化）派生**，
        // 见文件头的 EMOTES 构造。这里不许再出现手写的表情 JSON。
        case "emotes_list": return Promise.resolve(EMOTES.live);
        case "report_reasons": return Promise.resolve([{ id: 1, reason: "垃圾广告" }]);
        // 主站「我的表情」：用户点名要的那条必须能从面板发回去（issue #8）。
        case "emotes_owned": return Promise.resolve(EMOTES.owned);
        case "chat_send": {
          var sendPayload = Object.assign(
            { room_id: args.roomId, content: args.content }, sendOutcome);
          if (sendGate) {
            // 回执被扣住：把 release 挂到这一次调用上，__releaseSend 时才 resolve。
            var gate = sendGate;
            return new Promise(function (resolve) { gate.release = function () { resolve(sendPayload); }; });
          }
          return Promise.resolve(sendPayload);
        }
        // 房内身份（房管权限前置 + item 12 的字数上限）+ 房管只读三块 + 写操作（替身只记调用，不动真上游）。
        // danmaku_length 是契约 §5 的字段（上游 getInfoByUser 的 data.property.danmu.length，
        // 实测 40 / 缺省 20）：缺了它界面会按 20 回落，item 12 的上限断言就量不到真值。
        case "room_session": return Promise.resolve({
          room_id: args.roomId,
          my_medal_level: 0,
          my_medal_name: "",
          my_medal_worn: false,
          my_guard_level: 0,
          danmaku_length: 40,
          is_admin: window.__admin
        });
        // 三块各自的读取失败开关：__setAdminFail(true) 时**三块一起**拒绝 —— 面板里的错误条
        // 按当前 tab 只渲染一条（issue #1 之后一次只渲染一块），冒烟因此能逐 tab 各断一次。
        case "admin_silent_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve([{ uid: 900, uname: "被禁言的观众", face: "" }]);
        case "admin_blacklist_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve([{ uid: 901, uname: "黑名单观众", face: "" }]);
        case "admin_keywords_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve(["刷屏", "广告"]);
        case "admin_mute":
        case "admin_unmute":
        case "admin_blacklist_add":
        case "admin_blacklist_del":
        case "admin_keywords_add":
        case "admin_keywords_del": return Promise.resolve(null);
        case "wallet_balance": return Promise.resolve(150);
        case "rooms_connect": return Promise.resolve(null);
        // 「刷新连接」：替身按后端语义回一条状态流（connecting → connected），并记下
        // 「有没有真的发这条命令」——断连之后菜单里那颗键必须是活的（见下面的断言）。
        case "rooms_reconnect":
          window.__reconnectCalls = (window.__reconnectCalls || 0) + 1;
          window.__lastReconnectRoom = args.roomId;
          window.__emit("danmubox://status", { room_id: args.roomId, state: "connecting", detail: "手动重连" });
          window.__emit("danmubox://status", { room_id: args.roomId, state: "connected", detail: "verified" });
          return Promise.resolve(null);
        case "plugin:event|listen": (listeners[args.event] = listeners[args.event] || []).push(args.handler); return Promise.resolve(nextId);
        case "plugin:event|unlisten": return Promise.resolve(null);
        default: return Promise.resolve(null);
      }
    }
  };

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  var snap = function () { document.documentElement.setAttribute("data-smoke", JSON.stringify(out)); };
  var byTestId = function (id) { return document.querySelector('[data-testid="' + id + '"]'); };
  var allByTestId = function (id) { return [].slice.call(document.querySelectorAll('[data-testid="' + id + '"]')); };
  var rows = function () { return allByTestId("db-msg-row"); };
  var rect = function (el) { return el ? el.getBoundingClientRect() : null; };
  var text = function () { return document.body.innerText; };
  var rowWith = function (needle) {
    return rows().filter(function (r) { return r.innerText.indexOf(needle) >= 0; })[0];
  };
  var buttonWith = function (root, label) {
    return [].slice.call((root || document).querySelectorAll("button")).filter(function (b) {
      return b.innerText.trim().indexOf(label) >= 0;
    })[0];
  };
  var clickLabelIn = function (root, label) {
    var l = [].slice.call((root || document).querySelectorAll("label")).filter(function (x) {
      return x.innerText.indexOf(label) >= 0;
    })[0];
    if (!l) return false;
    var input = l.querySelector("input");
    if (!input) return false;
    input.click();
    return true;
  };
  // 只认工具行里的按钮：面板里也有带「表情」二字的按钮（「我的表情」tab 在文档序上更靠前），
  // 按 document.querySelectorAll 取首个会点错。
  var clickTool = function (label) {
    var b = buttonWith(byTestId("db-composer-tools"), label);
    if (!b) return false;
    b.click();
    return true;
  };
  // React 在元素上包了取值追踪器：直接改 .value 再派发 input 事件不会触发 onChange，
  // 必须走原生 setter（否则「新增账号」这类受控输入在冒烟里永远点不动）。
  var typeInto = function (input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // textarea 用的是另一个原型上的 setter：直接改 .value 不会触发 React 的 onChange
  var typeIntoArea = function (area, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };
  var lastSendCall = function () {
    var all = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
    return all[all.length - 1];
  };
  var openRowMenu = function (row) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
  };
  // 「别人的最新一条」：**乐观渲染之后最后一行不再保证是别人**——自己刚发的那条就排在末尾
  // （uid == 我，房管项与 @/回复按设计置灰）。凡是要拿「最新的一条弹幕」当目标的地方都走这里：
  // 显式推一条上游来的行（uid ≠ 我、有昵称、有 upstream_id），目标因此是确定的。
  var emitOtherRow = async function (label) {
    window.__emit("danmubox://message", window.__mk("danmaku", label, false, {
      uid: 77001, uname: "隔壁观众"
    }));
    await sleep(300);
    return rowWith(label);
  };
  // 离底部还有多远（0 = 贴底）。「跟随最新」是否还活着，看这个数就知道。
  var bottomGap = function (el) {
    return Math.round((el.scrollHeight - el.scrollTop - el.clientHeight) * 10) / 10;
  };
  var pickGiftMode = function () {
    var panel = byTestId("db-panel");
    if (!panel) return false;
    var pick = [].slice.call(panel.querySelectorAll("select")).filter(function (s) {
      return s.innerText.indexOf("输入框下方独立栏") >= 0;
    })[0];
    if (!pick) return false;
    pick.value = "separate";
    pick.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  // 键事件：焦点先落到目标上，再派发 keydown / keyup —— 与「Tab 到它、再按键」同一条路径
  // （React 的 onKeyDown 收到的就是这一个事件）。**场景跑在一次 evaluate 里**，运行器没有把
  // 真实键盘事件送进来的通道（它只发 click 与取快照），所以这是页面内能给出的最接近的一次；
  // 原生 <button> 的 Enter / Space 是浏览器默认动作换出来的 click，派发键事件换不出来 ——
  // 凡是判「原生按钮的键盘激活」，判据因此落在「它确实是一枚原生按钮 + 可聚焦 + 未禁用」上。
  var pressKey = function (el, key) {
    if (!el) return false;
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true, cancelable: true }));
    return true;
  };
  // 图标几何取证（房间头两枚 / 「回到最新」/ 主题按钮三档共用）：getBBox() 给的是**几何**
  // 包围盒（不含描边），四周各外扩半个墨迹厚度才是墨迹外接盒。定义在场景开头是因为
  // **step1 的主题按钮**就要用它（后面的房间头那一段只负责调用与断言）。
  var iconGeomOf = function (btn) {
    var svg = btn ? btn.querySelector("svg") : null;
    var shapes = svg ? [].slice.call(svg.querySelectorAll("path, circle")) : [];
    if (!svg || shapes.length === 0) return null;
    var vb = (svg.getAttribute("viewBox") || "").split(" ").map(parseFloat);
    var box = rect(svg);
    if (!box || !(vb[2] > 0)) return null;
    var scale = box.width / vb[2];
    // 墨迹厚度：描边 = stroke-width，圆点 = 直径（一个圆点就是一个零长度描边段的圆头）。
    // ⚠ 两者对**外接盒**的贡献不同：描边的几何包围盒是**路径中心线**，四周各要外扩半个笔画；
    //    实心圆的包围盒**本身就是墨迹**，一点都不用外扩（第一版两边都外扩，于是 ⋯ 的墨迹范围
    //    被算成 19.5 × 7，与箭头那 16 对不上 —— 冒烟当场把这条抓住了）。
    var thicknessOf = function (s) {
      if (s.tagName.toLowerCase() === "circle") return parseFloat(s.getAttribute("r")) * 2;
      var w = s.getAttribute("stroke-width");
      return w === null ? 0 : parseFloat(w);
    };
    var padOf = function (s) {
      return s.tagName.toLowerCase() === "circle" ? 0 : thicknessOf(s) / 2;
    };
    var lo = { x: Infinity, y: Infinity };
    var hi = { x: -Infinity, y: -Infinity };
    var thickness = 0;
    shapes.forEach(function (s) {
      var b = s.getBBox();
      var t = thicknessOf(s);
      var pad = padOf(s);
      thickness = Math.max(thickness, t);
      lo.x = Math.min(lo.x, b.x - pad);
      lo.y = Math.min(lo.y, b.y - pad);
      hi.x = Math.max(hi.x, b.x + b.width + pad);
      hi.y = Math.max(hi.y, b.y + b.height + pad);
    });
    var round1 = function (v) { return Math.round(v * 100) / 100; };
    return {
      viewBox: svg.getAttribute("viewBox"),
      scale: Math.round(scale * 1000) / 1000,
      boxPx: round1(box.width),
      inkThicknessPx: round1(thickness * scale),
      inkW: round1(hi.x - lo.x),
      inkH: round1(hi.y - lo.y),
      inkCenterX: round1((lo.x + hi.x) / 2),
      inkCenterY: round1((lo.y + hi.y) / 2),
      linecap: shapes[0].getAttribute("stroke-linecap"),
      linejoin: shapes[0].getAttribute("stroke-linejoin"),
      shapeCount: shapes.length,
    };
  };
  // WCAG 相对亮度：把「正文 / 次级文字对背景 ≥ 4.5:1」这条纪律写成可判定的数字，
  // 不靠人眼判（两套主题各判一次，浅色尤其容易在绿 / 灰上翻车）。
  var luminance = function (css) {
    var open = css.indexOf("(");
    var close = css.indexOf(")");
    if (open < 0 || close < 0) return null;
    var parts = css.slice(open + 1, close).split(",");
    if (parts.length < 3) return null;
    var lin = parts.slice(0, 3).map(function (v) {
      var c = parseFloat(v) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  var contrastRatio = function (fg, bg) {
    var a = luminance(fg);
    var b = luminance(bg);
    if (a === null || b === null) return 0;
    var hi = Math.max(a, b);
    var lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  window.__smoke_run = async function () {
    // 视口：360×844（窄屏，取窗口最小宽度；竖屏是默认形态）与 1440×900（宽屏）各跑一遍。
    // 视口专属的断言只写进对应视口的快照（narrow_* / wide_*），
    // 否则「宽屏的面板在文档流里」这类口径会在窄屏那边假失败。
    var NARROW = window.innerWidth <= 520;
    out.viewport = NARROW ? "narrow" : "wide";
    var put = function (name, value) { out[(NARROW ? "narrow_" : "wide_") + name] = value; };
    // 触屏热区体检：sheet / 对话框里凡是可点的东西都必须 ≥ 40px。
    // 复选框与滑杆本身不撑高（会变形），它们的热区由各自的 label 承担，所以按 label 计。
    var shortHotspots = function (root) {
      var els = [].slice.call(root.querySelectorAll("button, select, label, input"));
      var bad = [];
      els.forEach(function (el) {
        if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "range")) return;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 39.5) bad.push(el.tagName + "=" + Math.round(r.height) + "×" + Math.round(r.width));
      });
      return bad;
    };
    // ---- step1 关注列表自动加载 + 列表页展示关注项（语义不得改）
    await sleep(900);
    out.step1_followCalls = window.__followCalls;
    out.step1_roomListShowsFollowed = text().indexOf("在播主播") >= 0;
    // follow：未开播也列出、按最后开播时间排序、分页
    var followNames = allByTestId("db-follow-item").map(function (el) { return el.innerText.split("\\n")[0]; });
    out.followOrder = followNames.slice(0, 3);
    out.followPage1Count = followNames.length;
    out.followPagerShown = !!document.querySelector('[class*="pager"]');
    // 夹具里真实取样的名字（全部 live_status != 1：取证当天那 70 条没人开播）。
    var fixtureNames = FOLLOW_FIXTURE_ROWS.map(function (row) { return row.uname; });
    var fixtureOfflineNames = FOLLOW_FIXTURE_ROWS
      .filter(function (row) { return row.live_status !== 1; })
      .map(function (row) { return row.uname; });
    out.followOfflineFixtureTotal = fixtureOfflineNames.length;
    var followHeaderEl = document.querySelector('[class*="followSection"] h2') ||
      document.querySelector('[class*="followHeader"] h2');
    out.followHeaderText = followHeaderEl ? followHeaderEl.innerText : "";
    // 列表头报出的总数 = 真实取样 70 + 自造 3：**一条都没被过滤掉**（第 1 页只画 30 条）。
    out.followHeaderCountsAll = out.followHeaderText.indexOf(
      "（" + (fixtureNames.length + 3) + "）") >= 0;
    // 关注项带出直播间标题（上游 title 字段）：非空的渲染出文本，空串的不渲染该元素
    // （不留空框、不用占位符）。
    var followItemNamed = function (name) {
      return allByTestId("db-follow-item").filter(function (el) {
        return el.innerText.indexOf(name) >= 0;
      })[0];
    };
    var liveFollowItem = followItemNamed("在播主播");
    var liveFollowTitle = liveFollowItem
      ? liveFollowItem.querySelector('[data-testid="db-follow-title"]')
      : null;
    out.step1_followTitleShown = !!liveFollowTitle &&
      liveFollowTitle.innerText.indexOf("在播中的直播间标题") >= 0;
    var emptyTitleItem = followItemNamed("离线甲");
    out.step1_followEmptyTitleHidden = !!emptyTitleItem &&
      !emptyTitleItem.querySelector('[data-testid="db-follow-title"]');

    // ---- 用户 2026-09-13：「关注但未开播的也一直没加载到主界面」。
    // 判据分两层，都用**真实取样**的条目：
    //   ① 第 1 页里必须真的有夹具里的未开播条目，并且**真的布了局**（有尺寸、没被藏掉）；
    //   ② 翻完所有页，夹具里的每一条未开播取样都必须出现过（谁都没在过滤 / 分页里掉队）。
    // 「可见」不写成「在视口内」：窄屏第 1 页的关注列表本来就在折线以下，滚过去才看得到
    // （截图那一步会滚），能判的是「布局出来了、不是被隐藏」。
    var offlineOnPage1 = followNames.filter(function (name) {
      return fixtureOfflineNames.indexOf(name) >= 0;
    });
    out.followOfflineOnPage1 = offlineOnPage1.length;
    out.followOfflineVisibleOnPage1 = offlineOnPage1.filter(function (name) {
      var el = followItemNamed(name);
      return !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 8;
    }).length;
    out.followNonLiveListed = offlineOnPage1.length > 0 && out.followOfflineVisibleOnPage1 > 0;
    put("followOfflineVisibleOnPage1", out.followOfflineVisibleOnPage1 > 0);

    // ---- #16 排序：直播中置顶 → **最近观看降序** → 最后开播时间降序。
    // 「最近观看」的样本换成了**真实取样**的那条（prefs 的 ui.recent_watched 指向夹具第 1 条）：
    // 它比离线甲后看过，因此必须排在最前——看过的那些按时间降序。
    var watchedFixtureName = FOLLOW_FIXTURE_ROWS[0].uname;
    out.followLivePinnedFirst = followNames.length > 0 && followNames[0] === "在播主播";
    out.followWatchedDesc =
      followNames.indexOf(watchedFixtureName) >= 0 &&
      followNames.indexOf(watchedFixtureName) < followNames.indexOf("离线甲");
    out.followWatchedBeforeUnwatched =
      followNames.indexOf("离线甲") >= 0 && followNames.indexOf("离线甲") < followNames.indexOf("离线乙");
    // 没看过的按「最后开播时间」降序：只有自造条目带 live_start_at（真实取样的未开播条目
    // 拿不到这个量——上游未开播时不给，见 A28），所以它们整体排在离线乙之后。
    var unwatchedFixtureName = followNames.filter(function (name) {
      return fixtureNames.indexOf(name) >= 0 && name !== watchedFixtureName;
    })[0] || "";
    out.followUnwatchedKeepsLiveStartOrder =
      followNames.indexOf("离线乙") >= 0 && !!unwatchedFixtureName &&
      followNames.indexOf("离线乙") < followNames.indexOf(unwatchedFixtureName);

    // ---- #14/#15 排布：宽屏一排（左 头像·主播名·直播标题 / 右 状态·最后开播时间），
    // 窄屏两排（第二排 左标题 / 右最后开播时间）；两档都不得出现房间号。
    var followPart = function (item, testid) {
      return item ? item.querySelector('[data-testid="' + testid + '"]') : null;
    };
    var centerY = function (el) {
      var r = rect(el);
      return (r.top + r.bottom) / 2;
    };
    var partsName = followPart(liveFollowItem, "db-follow-name");
    var partsStatus = followPart(liveFollowItem, "db-follow-status");
    var partsTime = followPart(liveFollowItem, "db-follow-last-live");
    out.followItemHasAllParts = !!(partsName && liveFollowTitle && partsStatus && partsTime);
    if (out.followItemHasAllParts) {
      if (NARROW) {
        // 窄屏：主播名与状态同一排；标题与最后开播时间在第二排，且标题在左、时间在右。
        put("followRow1NameWithStatus", Math.abs(centerY(partsName) - centerY(partsStatus)) < 6);
        put("followRow2TitleWithTime", Math.abs(centerY(liveFollowTitle) - centerY(partsTime)) < 6);
        put("followTitleOnSecondRow", rect(liveFollowTitle).top >= rect(partsName).bottom - 2);
        put("followRow2BelowStatus", rect(liveFollowTitle).top > rect(partsStatus).bottom - 2);
        put("followTitleLeftOfTime", rect(liveFollowTitle).left < rect(partsTime).left);
        // 第一排的状态与第二排的时间都贴右边缘（同一列、同一条右边界）
        put("followRowRightsAligned", Math.abs(rect(partsStatus).right - rect(partsTime).right) < 2);
        put("followStatusInRightHalf",
          rect(partsStatus).left > rect(liveFollowItem).left + rect(liveFollowItem).width / 2);
        // 标题与主播名同一起点（悬挂缩进）：不顶到头像下面，也不越到状态右边。
        put("followTitleAlignedWithName",
          Math.abs(rect(liveFollowTitle).left - rect(partsName).left) < 2);
      } else {
        // 宽屏：四项在同一排；标题在两簇之间（名字之后、状态之前），最后开播时间在最右。
        put("followSingleRow",
          Math.abs(centerY(partsName) - centerY(liveFollowTitle)) < 8 &&
          Math.abs(centerY(partsName) - centerY(partsStatus)) < 8 &&
          Math.abs(centerY(partsName) - centerY(partsTime)) < 8);
        put("followNameLeftOfTitle", rect(partsName).left < rect(liveFollowTitle).left);
        put("followTitleBeforeStatus", rect(liveFollowTitle).right <= rect(partsStatus).left + 1);
        put("followTimeAtRightEdge", rect(partsTime).right >= rect(partsStatus).right);
      }
    }
    // ---- 翻完所有页：夹具里的每一条未开播取样都必须出现过（谁都没在过滤 / 分页里掉队）。
    //      跑完翻回第 1 页：后面的排布断言与截图都按第 1 页来。
    var pagerButton = function (label) {
      var pager = document.querySelector('[class*="pager"]');
      if (!pager) return null;
      return [].slice.call(pager.querySelectorAll("button")).filter(function (b) {
        return b.innerText.indexOf(label) >= 0;
      })[0] || null;
    };
    var seenFollowNames = followNames.slice();
    var collectNames = function () {
      allByTestId("db-follow-item").forEach(function (el) {
        var name = el.innerText.split("\\n")[0];
        if (seenFollowNames.indexOf(name) < 0) seenFollowNames.push(name);
      });
    };
    var forwardPages = 0;
    for (var step = 0; step < 8; step += 1) {
      var next = pagerButton("下一页");
      if (!next || next.disabled) break;
      next.click();
      await sleep(160);
      collectNames();
      forwardPages += 1;
    }
    var missingFollowed = fixtureOfflineNames.filter(function (name) {
      return seenFollowNames.indexOf(name) < 0;
    });
    out.followWindowPages = forwardPages;
    out.followOfflineSeen = fixtureOfflineNames.length - missingFollowed.length;
    out.followOfflineAllListed = missingFollowed.length === 0;
    out.followOfflineMissing = missingFollowed.slice(0, 3);
    for (var back = 0; back < 8; back += 1) {
      var prev = pagerButton("上一页");
      if (!prev || prev.disabled) break;
      prev.click();
      await sleep(140);
    }
    out.followBackOnFirstPage =
      allByTestId("db-follow-item").length === out.followPage1Count;
    // 翻页会重建关注项的 DOM 节点：后面还用 liveFollowItem / emptyTitleItem（房间号不得出现
    // 那条断言），必须重新取，否则是拿脱离文档的旧节点在判（innerText 为空 → 断言假绿）。
    liveFollowItem = followItemNamed("在播主播");
    emptyTitleItem = followItemNamed("离线甲");
    await sleep(200);

    // 房间号不得出现在关注项里（用户 #14/#15：两档都「不要房间号」）：
    // #100 是「有标题 + 直播中」那条，#300 是「无标题 + 未开播且看过」那条，两类都查。
    out.followItemHidesRoomNumber = !!liveFollowItem && !!emptyTitleItem &&
      liveFollowItem.innerText.indexOf("100") < 0 &&
      emptyTitleItem.innerText.indexOf("300") < 0;
    // 连接中的房间列表同样不报房间号（#17）：卡片报「主播名 · 直播间名」，
    // 且名字取的是**真实载荷**里的值（fixtureRoom，见文件头夹具说明）。
    // 这两条就是「不许出现占位词」的回归断言：解析路径写错时 anchor_uname 是空串，
    // 卡片会退成「未命名直播间」或「房间 5440」，两条都会失败。
    var roomCard = byTestId("db-room-card");
    out.roomCardShowsAnchorAndTitle = !!roomCard &&
      roomCard.innerText.indexOf(fixtureRoom.anchor_uname) >= 0 &&
      roomCard.innerText.indexOf(fixtureRoom.title) >= 0;
    out.roomCardHidesRoomNumber = !!roomCard && roomCard.innerText.indexOf("5440") < 0;
    out.roomCardHidesPlaceholder = !!roomCard &&
      roomCard.innerText.indexOf("未命名直播间") < 0;
    // 把卡片滚进画面并停一下：跑脚本的进程据此抓一张「连接中的房间列表」截图（#17）。
    // 下一段会把关注项滚到顶，那时卡片已不在画面里，所以这一步必须在它前面。
    if (roomCard && roomCard.scrollIntoView) {
      roomCard.scrollIntoView({ block: "start" });
    }
    out.roomsListRendered = !!roomCard;
    // ---- 主页左右边距对称（用户 2026-09-12：「主页好像没有居中？右边的边距好像稍微宽一些」）。
    //      根因：经典滚动条（index.css 把它定制成 10px）只吃内容盒的**右侧**，
    //      max-width + margin: 0 auto 的居中块因此右宽左窄正好一个滚动条宽
    //      （改前实测 4 档：宽屏 24 / 34，窄屏 16 / 26）。判据取「到内容的左右距离相等」（容差 1px），
    //      并**同时**要求容器真的在滚 —— 没有滚动条时这条断言会假绿。
    var listEl = byTestId("db-list-page");
    var listBox = rect(listEl);
    var listAnchorBox = rect(byTestId("db-account") || listEl.querySelector("h1"));
    out.listPageScrolls = listEl.scrollHeight > listEl.clientHeight + 1;
    out.listPageScrollbarPx = listEl.offsetWidth - listEl.clientWidth;
    out.listPageLeftGapPx = Math.round((listAnchorBox.left - listBox.left) * 10) / 10;
    out.listPageRightGapPx = Math.round((listBox.right - listAnchorBox.right) * 10) / 10;
    out.listPageMarginsSymmetric = out.listPageScrolls &&
      Math.abs(out.listPageLeftGapPx - out.listPageRightGapPx) <= 1;
    // ---- 「高度缩到出现滚动条之后，元素右侧往中间回缩」（用户 2026-09-12 的决定性复现）。
    //      判据：**同一个元素**的右缘 x 在「内容装得下（不出滚动条）」与「装不下（出滚动条）」
    //      两态下相等（容差 1px）。根因是 index.css 里那条自定义滚动条样式 —— 它把 macOS 的
    //      **覆盖式**滚动条（不占宽）换成**经典**滚动条（占宽），一出现就吃掉内容右侧一条；
    //      现已删除那些样式（同一个改动也把「窗口右边缘拖不动」一起解了）。
    var stableProbe = byTestId("db-account");
    var followRowsProbe = allByTestId("db-follow-item");
    var rightWhenScrolling = rect(stableProbe).right;
    var savedRowDisplay = followRowsProbe.map(function (el) { return el.style.display; });
    followRowsProbe.forEach(function (el) { el.style.display = "none"; });
    await sleep(300);
    var shortListEl = byTestId("db-list-page");
    out.listPageShortStateHasNoScrollbar = shortListEl.scrollHeight <= shortListEl.clientHeight + 1;
    var rightWhenShort = rect(stableProbe).right;
    followRowsProbe.forEach(function (el, index) { el.style.display = savedRowDisplay[index]; });
    await sleep(300);
    out.listPageRightEdgeDeltaPx = Math.round(Math.abs(rightWhenShort - rightWhenScrolling) * 10) / 10;
    out.listPageRightEdgeStable = out.listPageShortStateHasNoScrollbar &&
      out.listPageRightEdgeDeltaPx <= 1;
    snap();
    await sleep(900);

    // 让跑脚本的进程抓一张「关注列表排布」的截图（宽屏单排 / 窄屏两排各一张）。
    var firstFollowItem = byTestId("db-follow-item");
    if (firstFollowItem && firstFollowItem.scrollIntoView) {
      firstFollowItem.scrollIntoView({ block: "start" });
    }
    out.followListRendered = allByTestId("db-follow-item").length > 0;

    out.accountArea = !!byTestId("db-account");
    // 列表页的头像（账号区 / 关注项）尺寸必须由 CSS 给，不能落到「原图尺寸」：
    // 夹具是 512×512，一旦 var(--avatar) 解析不出来，头像会按 512 渲染、把主页顶爆
    // （用户 2026-09-12：「主页的内容都没了啊，只能看到一个头像的角落」）。
    var listAvatars = allByTestId("db-msg-avatar");
    out.listAvatarCount = listAvatars.length;
    out.listAvatarsSized = listAvatars.length >= 2 && listAvatars.every(function (el) {
      var r = rect(el);
      return r.width > 8 && r.width <= 40 && r.height > 8 && r.height <= 40;
    });
    // 失败时把「为什么」也带出来：--avatar 算成什么、img 实际渲染多大（那次主页被顶爆，
    // 就是这个字段把根因钉死的：--avatar 取不到值 → computed width 变成原图的 512px）。
    out.listAvatarBoxes = listAvatars.map(function (el) {
      var r = rect(el);
      var cs = getComputedStyle(el);
      return [Math.round(r.width), Math.round(r.height), cs.width, cs.height,
        cs.getPropertyValue("--avatar").trim() || "(未解析)"];
    });
    // 列表页在窄屏也不许横向滚动（关注项一行放不下要换行）
    var listPage = byTestId("db-list-page");
    put("listNoHorizontalScroll", !!listPage &&
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      listPage.scrollWidth <= listPage.clientWidth);
    snap();
    // 停一下让跑脚本的进程抓一张「关注列表排布」（宽屏单排 / 窄屏两排）：
    // 过了这一步就点进房间了，列表页那两排只在这一刻可见。
    await sleep(900);

    // ---- theme 主题按钮（item 10 + issue #7）：控件在**房间列表页页头**（标题「弹幕框」右侧），
    //      形态是**按钮**（用户 2026-09-13 #7：「模仿安卓 / iOS 的日月按钮，分亮、暗、自动三态，
    //      是按钮非滑块」）：点一下前进一档（亮 → 暗 → 自动 → 亮），图标随档变；档位落到
    //      window.__prefs["ui.theme"] 与 <html data-theme>，两档下正文 / 昵称的对比度都达标。
    //      **自动**档的 data-theme 由环境偏好决定（跟随系统），所以那一档只判「是个合法主题名」、
    //      不写死 light / dark。（模板串里不许出现反引号与反斜杠，见文件头 —— 这里一条正则都不写。）
    var themeBtn = byTestId("db-pref-theme");
    out.themeControlShown = Boolean(themeBtn);
    // ① 控件是一枚**原生按钮**、可聚焦（原生按钮的 Enter / Space 由浏览器默认动作换成 click，
    //     所以「是按钮 + 能聚焦 + 没禁用」就是它的键盘契约），里面不再是下拉。
    out.themeControlIsButton = !!themeBtn && themeBtn.tagName === "BUTTON";
    out.themeControlHasNoSelect = !!themeBtn && themeBtn.querySelector("select") === null;
    out.themeControlInListHeader = !!themeBtn && !!byTestId("db-list-page") &&
      byTestId("db-list-page").contains(themeBtn);
    if (themeBtn) themeBtn.focus();
    out.themeControlFocusable = !!themeBtn && themeBtn.disabled !== true &&
      document.activeElement === themeBtn;
    var THEME_ORDER = ["light", "dark", "system"];
    var THEME_NAMES = { light: "亮", dark: "暗", system: "自动" };
    var themeModeOf = function () { return window.__prefs["ui.theme"]; };
    var themeNextOf = function (mode) {
      var at = THEME_ORDER.indexOf(mode);
      return THEME_ORDER[(at + 1) % THEME_ORDER.length];
    };
    // 图标没有可见文字：可访问名必须自带「现在是哪一档、点一下去哪一档」（title 同一句话）
    var themeHintOf = function (mode) {
      return "主题：" + THEME_NAMES[mode] + "（点一下切到" + THEME_NAMES[themeNextOf(mode)] + "）";
    };
    var themeApplied = document.documentElement.getAttribute("data-theme");
    var themeStart = themeModeOf();
    out.themeApplied = themeApplied;
    out.themeStartMode = themeStart;
    out.themeMatchesPref = themeApplied === themeStart || themeStart === "system";
    out.themeAccessibleName = themeBtn ? (themeBtn.getAttribute("aria-label") || "") : null;
    out.themeAccessibleNameIsHint = !!themeBtn &&
      out.themeAccessibleName === themeHintOf(themeStart) &&
      (themeBtn.getAttribute("title") || "") === out.themeAccessibleName;
    // 三档图标都走 §3.1 那一套矢量规范：24 盒 / 1.75 描边 / 墨迹居中 (12,12) / 主轴 16 单位
    var themeIconSpecOk = function () {
      var g = iconGeomOf(themeBtn);
      var svg = themeBtn ? themeBtn.querySelector("svg") : null;
      return !!g && !!svg && svg.getAttribute("aria-hidden") === "true" &&
        g.viewBox === "0 0 24 24" &&
        Math.abs(g.inkCenterX - 12) < 0.2 && Math.abs(g.inkCenterY - 12) < 0.2 &&
        Math.abs(Math.max(g.inkW, g.inkH) - 16) < 0.2 &&
        Math.abs(g.inkThicknessPx / g.scale - 1.75) < 0.01;
    };
    out.themeIcon = iconGeomOf(themeBtn);
    out.themeIconSpecOk = themeIconSpecOk();
    // 列表页能测的两处文字：正文色（关注项昵称，继承 --fg）与**次级色**（账号区的
    // uid 那一格 .accountMeta，取 --fg-dim）—— 正是硬纪律里那两个 token。
    var listContrast = function () {
      var bg = getComputedStyle(document.body).backgroundColor;
      var bodyText = byTestId("db-follow-name");
      var dimText = byTestId("db-account-uid");
      return {
        bg: bg,
        body: contrastRatio(getComputedStyle(document.body).color, bg),
        name: contrastRatio(bodyText ? getComputedStyle(bodyText).color : "", bg),
        dim: contrastRatio(dimText ? getComputedStyle(dimText).color : "", bg),
      };
    };
    out.listThemeContrast = listContrast();
    out.listThemeContrastOk = out.listThemeContrast.body >= 4.5 &&
      out.listThemeContrast.name >= 4.5 && out.listThemeContrast.dim >= 4.5;
    if (themeBtn) {
      // 走完**亮 → 暗 → 自动**一轮（三下回到原档）：每一步都验档位本身、<html data-theme>、
      // 可访问名与图标规范；路过**与起始档相反**的那一档时，把对比度也量一遍。
      var themeOtherMode = themeStart === "light" ? "dark" : "light";
      var themeSteps = [];
      var themeSwitchedContrast = null;
      for (var ts = 0; ts < THEME_ORDER.length; ts += 1) {
        themeBtn.click();
        await sleep(350);
        var themeNow = themeModeOf();
        var themeDom = document.documentElement.getAttribute("data-theme");
        themeSteps.push({
          mode: themeNow,
          dom: themeDom,
          nameOk: (themeBtn.getAttribute("aria-label") || "") === themeHintOf(themeNow),
          iconOk: themeIconSpecOk(),
          // 亮 / 暗是确定的；自动档由环境偏好定，只要落在两套主题里即可
          domOk: themeNow === "system"
            ? (themeDom === "light" || themeDom === "dark")
            : themeDom === themeNow,
          prefOk: window.__prefs["ui.theme"] === themeNow
        });
        if (themeNow === themeOtherMode) themeSwitchedContrast = listContrast();
      }
      out.themeCycleModes = themeSteps.map(function (s) { return s.mode; });
      out.themeAdvanceOneStep = themeSteps.length === 3 &&
        themeSteps[0].mode === themeNextOf(themeStart) &&
        themeSteps[1].mode === themeNextOf(themeSteps[0].mode) &&
        themeSteps[2].mode === themeStart;
      out.themeCycleStepsOk = themeSteps.length === THEME_ORDER.length &&
        themeSteps.every(function (s) {
          return s.nameOk && s.iconOk && s.domOk && s.prefOk;
        });
      out.themeSwitchChangesBackground = !!themeSwitchedContrast &&
        themeSwitchedContrast.bg !== out.listThemeContrast.bg;
      out.themeSwitchedContrast = themeSwitchedContrast;
      out.themeSwitchedContrastBodyOk = !!themeSwitchedContrast &&
        themeSwitchedContrast.body >= 4.5 && themeSwitchedContrast.name >= 4.5;
      out.themeSwitchedContrastDimOk = !!themeSwitchedContrast &&
        themeSwitchedContrast.dim >= 4.5;
      // 一轮走完必须回到本次运行的档位：后面的步骤与截图仍按这一档走
      out.themeRestored = themeModeOf() === themeStart &&
        document.documentElement.getAttribute("data-theme") === themeApplied;
    }
    snap();

    // ---- step2 进房间 + 历史回填可见
    byTestId("db-room-card").click();
    await sleep(800);
    window.__emit("danmubox://status", { room_id: 5440, state: "connected", detail: "" });
    out.step2_roomPage = text().indexOf("发送") >= 0;
    out.step2_historyVisible = !!rowWith("这是进场回填的历史弹幕");
    out.chatScroll = !!byTestId("db-chat-scroll");
    snap();

    // 铺 2 条实时弹幕 + 互动 + 系统（step3 需要历史行与实时行同时在场）
    window.__emit("danmubox://message", window.__mk("danmaku", "这是实时弹幕"));
    // 进场行的自动摘除定时器 = 这条消息的 ts + 8s（store.scheduleInteractHide）。
    // 后面「面板展开不弹走视口」那条断言必须先等它落定：摘掉一行会把下面整体顶上去一行高。
    var interactMsg = window.__mk("interact", "");
    window.__interactAt = interactMsg.ts;
    window.__emit("danmubox://message", interactMsg);
    window.__emit("danmubox://message", window.__mk("system", "标题或分区变更"));
    window.__emit("danmubox://room_stats", { room_id: 5440, online: 12345, watched: 345678 });
    await sleep(600);

    // ---- step3 头部数字 / 渲染与弱化（语义不得改）
    var hist = rowWith("这是进场回填的历史弹幕");
    var live = rowWith("这是实时弹幕");
    var interact = rowWith("进入直播间");
    out.step3_headerHasOnline = text().indexOf("在线 1.2万") >= 0;
    out.step3_headerHasWatched = text().indexOf("看过 34.6万") >= 0;
    out.step3_headerHasPopularity = text().indexOf("人气") >= 0;
    out.step3_systemRendered = text().indexOf("标题或分区变更") >= 0;
    out.step3_interactRendered = !!interact;
    out.step3_historyOpacity = hist ? getComputedStyle(hist).opacity : null;
    out.step3_liveOpacity = live ? getComputedStyle(live).opacity : null;
    out.step3_dividerTextPresent = text().indexOf("以上为进场前的最新弹幕") >= 0;
    out.step3_interactAnimation = interact ? getComputedStyle(interact).animationName : null;
    // 窄屏：头部（在线 / 看过 / 电池）与弹幕列表都不许横向滚动——放不下就换行，不许溢出
    var headerEl0 = byTestId("db-room-header");
    var scrollerEl0 = byTestId("db-chat-scroll");
    put("headerNoHorizontalScroll", headerEl0.scrollWidth <= headerEl0.clientWidth);
    put("chatNoHorizontalScroll", scrollerEl0.scrollWidth <= scrollerEl0.clientWidth + 1);
    put("pageNoHorizontalScroll",
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.body.scrollWidth <= document.body.clientWidth);

    // ---- 房间头（用户 2026-09-12 反馈 1）：**两排**（控件一排、标题另一排）、
    //      返回 / ⋯ 两枚**圆形控件**、直播状态点（红 = 下播 / 绿 = 开播 / 橙 = 未连接）、
    //      标题在状态点右侧同一排、顶栏两个数值、不再有「已连接（缓冲 N）」文字与 verified 徽标。
    var headerEl1 = byTestId("db-room-header");
    // 圆形控件只剩**返回**与 **⋯**（用户 2026-09-13：「电池不要圆形，仅 3 点选项需要」）。
    // 电池挪去输入区、发送按钮左侧，形状也不同（圆角矩形，见下面的 battery* 断言）。
    var roundCtl = [byTestId("db-header-back"), byTestId("db-header-more")];
    var circleOf = function (el) {
      if (!el) return null;
      var box = rect(el);
      var radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      return {
        w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10, r: radius,
        // 「圆角 = 半径」：正方盒 + 圆角不小于半边长 = 正圆（--r-full 在正方盒上被夹到半边长）
        round: Math.abs(box.width - box.height) < 0.6 && radius >= box.width / 2 - 0.6,
      };
    };
    out.headerControls = roundCtl.map(circleOf);
    out.headerControlsAllRound = roundCtl.every(function (el) { return !!circleOf(el) && circleOf(el).round; });
    out.headerControlsSameSize = roundCtl.every(function (el) {
      return !!el && Math.abs(rect(el).width - rect(roundCtl[0]).width) < 0.6;
    });
    out.headerBackIsArrowOnly = !!roundCtl[0] && roundCtl[0].innerText.trim() === "" &&
      !!roundCtl[0].querySelector("svg") &&
      (roundCtl[0].getAttribute("aria-label") || "").indexOf("返回") >= 0;
    out.headerNoConnectedText = headerEl1.innerText.indexOf("已连接") < 0 &&
      headerEl1.innerText.indexOf("缓冲") < 0 && headerEl1.innerText.indexOf("连接中") < 0 &&
      headerEl1.innerText.indexOf("已断开") < 0;
    // verified 徽标：类名与 testid 两种命名都不许出现（本仓库本来就没有，这条是防它被加回来）
    out.headerNoVerifiedBadge =
      document.querySelectorAll('[data-testid*="verified"], [class*="verified"], [class*="Verified"]').length === 0;
    var barBox = rect(byTestId("db-room-header-bar"));
    var titleBox = rect(byTestId("db-room-title"));
    var dotBox0 = rect(byTestId("db-live-dot"));
    // 标题回到**状态点右侧、同一排**（用户 2026-09-13 第 3 条的纠正：上一版「标题另起一排」理解错了）。
    // 判据：① 标题左边缘在状态点右边缘之右；② 两者的竖直中心对齐（同一排）；
    // ③ 标题整个落在头部那一排的盒子里（没有掉到第二排）。
    out.headerTitleWithDot = !!titleBox && !!dotBox0 && !!barBox &&
      titleBox.left >= dotBox0.right - 0.5 &&
      Math.abs((titleBox.top + titleBox.height / 2) - (dotBox0.top + dotBox0.height / 2)) <= 3 &&
      titleBox.top >= barBox.top - 0.5 && titleBox.bottom <= barBox.bottom + 0.5;
    // 顶栏腾出来的位置给**两个数值**：当前在线 / 看过（用户 2026-09-13）；电池**不在**顶栏。
    var headerText = headerEl1.innerText;
    out.headerHasBothStats = headerText.indexOf("在线") >= 0 && headerText.indexOf("看过") >= 0;
    out.headerNoBattery = !headerEl1.querySelector('[data-testid="db-battery"]') &&
      headerText.indexOf("电池") < 0 && headerText.indexOf("150") < 0;
    // 直播状态点：颜色必须等于令牌值，且**随 live_status 变**（发一条 room 事件翻成未开播再翻回来）
    var cssColorOf = function (name) {
      var probe = document.createElement("span");
      probe.style.color = "var(" + name + ")";
      document.body.appendChild(probe);
      var value = getComputedStyle(probe).color;
      probe.parentNode.removeChild(probe);
      return value;
    };
    var liveOnColor = cssColorOf("--live-on");
    var liveOffColor = cssColorOf("--live-off");
    var dotColor = function () {
      var dot = byTestId("db-live-dot");
      return dot ? getComputedStyle(dot).backgroundColor : null;
    };
    var liveIdleColor = cssColorOf("--live-idle");
    // 三态口径（用户 2026-09-13）：**红 = 下播 / 绿 = 开播 / 橙 = 未连接**，三条色值互不相同
    out.liveDotTokensDistinct = liveOnColor !== liveOffColor &&
      liveOffColor !== liveIdleColor && liveOnColor !== liveIdleColor;
    // 夹具里的 live_status 是多少就按哪个色验（不写死 1 —— 真实载荷是轮播（live_status = 2），
    // 它不是「开播」，落到红那一档）。
    var liveIsOn = fixtureRoom.live_status === 1;
    var liveExpectedColor = liveIsOn ? liveOnColor : liveOffColor;
    out.liveDotMatchesStatus = dotColor() === liveExpectedColor &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    // ① 上游把 live_status 翻过去 → 颜色跟着变（这才是「随它变」的可验形式）
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: liveIsOn ? 0 : 1 });
    await sleep(350);
    var toggledDot = byTestId("db-live-dot");
    out.liveDotFollowsStatus = dotColor() === (liveIsOn ? liveOffColor : liveOnColor) && !!toggledDot &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "off" : "on");
    // ② 连接态掉线 → **未连接**（灰），与在不在播无关（这一档的来源是「danmubox://status」，
    //    与房间标签页上的圆点同源）
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "disconnected", detail: "" });
    await sleep(350);
    out.liveDotIdleWhenDisconnected = dotColor() === liveIdleColor &&
      byTestId("db-live-dot-box").getAttribute("data-state") === "idle";
    // ③ 连回来 → 回到上游那一档
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: fixtureRoom.live_status });
    await sleep(350);
    out.liveDotRestored = dotColor() === liveExpectedColor && !!byTestId("db-live-dot") &&
      byTestId("db-live-dot-box").getAttribute("data-live") === String(fixtureRoom.live_status) &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    // ---- 状态点**逐档缩小**（用户 2026-09-13：先「稍微缩小一点」12 → 10，本次第 5 条「改小一点」
    //      再降一档到 8）。
    //      两层：看得见的那颗点（db-live-dot，--live-dot）画在外壳（db-live-dot-box，
    //      仍是旧的 --sp-3 12px）里面；悬停 / 热区**不跟着缩**（用户明确要求「别让可点面积变小」）。
    //      两个数都记进快照：改的是**数字**，不是删断言。
    var liveDotEl = byTestId("db-live-dot");
    var liveDotBoxEl = byTestId("db-live-dot-box");
    var liveDotBox = rect(liveDotEl);
    var cssLengthOf = function (name) {
      var probe = document.createElement("span");
      probe.style.display = "block";
      probe.style.width = "var(" + name + ")";
      document.body.appendChild(probe);
      var value = parseFloat(getComputedStyle(probe).width);
      probe.parentNode.removeChild(probe);
      return value;
    };
    out.liveDotVisualPx = liveDotBox ? Math.round(liveDotBox.width * 10) / 10 : null;
    out.liveDotHitPx = liveDotBoxEl ? Math.round(rect(liveDotBoxEl).width * 10) / 10 : null;
    // 看得见的那颗点 = --live-dot（8px）；热区 / 悬停面（外壳）仍是改前的 12px，没跟着缩
    out.liveDotVisualIsToken = !!liveDotBox &&
      Math.abs(liveDotBox.width - cssLengthOf("--live-dot")) < 0.6;
    // 用户 2026-09-13 第 5 条：「并且要改小一点」——**再小一档**（12 → 10 → 8）。
    // 判据里的 10 是**上一档**：这回必须比它更小；外壳（热区 / 悬停面）仍是 12px 不动。
    out.liveDotShrunk = !!liveDotBox && !!liveDotBoxEl && liveDotBox.width < 10 &&
      rect(liveDotBoxEl).width > liveDotBox.width &&
      Math.abs(rect(liveDotBoxEl).width - 12) < 0.6;
    // ---- 三态语义（用户 2026-09-13 第 5 条 + 当天的更正）：**灰 = 断连 / 红 = 已连接但未开播 / 绿 = 已连接且开播**。
    //      逐状态发真实事件把三种状态各走一遍（status + room 两个来源），把「状态名 → 颜色」记下来，
    //      再判两件事：① 三个色互不相同；② 每个状态的颜色等于它该有的那个令牌。
    var liveStates = [];
    var recordLive = function () {
      liveStates.push({
        state: byTestId("db-live-dot-box").getAttribute("data-state"),
        color: dotColor(),
      });
    };
    // ① 已连接 & 未开播 → 红
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 0 });
    await sleep(300);
    recordLive();
    // ② 已连接 & 开播 → 绿
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 1 });
    await sleep(300);
    recordLive();
    // ③ 断连 → 灰（与在不在播无关：连接态掉线时根本不知道播没播）
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "disconnected", detail: "" });
    await sleep(300);
    recordLive();
    // 复位到夹具那一档，后面的断言按同一口径继续
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: fixtureRoom.live_status });
    await sleep(300);
    out.liveDotStates = liveStates;
    out.liveDotStatesDistinct = liveStates.length === 3 &&
      liveStates[0].color !== liveStates[1].color &&
      liveStates[1].color !== liveStates[2].color &&
      liveStates[0].color !== liveStates[2].color;
    out.liveDotStateMapping = liveStates.length === 3 &&
      liveStates[0].state === "off" && liveStates[0].color === liveOffColor &&
      liveStates[1].state === "on" && liveStates[1].color === liveOnColor &&
      liveStates[2].state === "idle" && liveStates[2].color === liveIdleColor;
    out.liveDotRestoredAfterStates = dotColor() === liveExpectedColor &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    // ---- 断连那一档**必须是灰的**（用户 2026-09-13：「我觉得灰色也不错，橙色的需求改成灰色」）。
    //      判据用 **HSL 饱和度**，不硬编码色值：三档色在两套主题里本来就不同值，而「绿 / 红有彩、
    //      灰没彩」是语义本身。阈值 0.2 —— 改前的橙（#e9a038 / #c2410c）是 80% / 88%，
    //      红 / 绿都在 65% 以上，灰（--fg-dim：#8696a0 / #54656f）只有 12% / 14%。
    //      ⚠ 解析**不用正则**：MOCK 是模板字符串，反斜杠在模板求值时就没了 —— 实测写
    //      /rgba?\(([^)]+)\)/ 经过模板会变成 /rgba?(([^)]+))/，捕获到的是带括号的 "(37, 211, 102)"，
    //      parseFloat 直接 NaN（第一版就是这么红的）—— 与上面 luminance 同一个理由，那里也是 indexOf 切的。
    var saturationOf = function (css) {
      if (!css) return null;
      var open = css.indexOf("(");
      var close = css.indexOf(")");
      if (open < 0 || close < 0) return null;
      var parts = css.slice(open + 1, close).split(",");
      if (parts.length < 3) return null;
      var ch = parts.slice(0, 3).map(function (v) { return parseFloat(v) / 255; });
      if (ch.some(isNaN)) return null;
      var max = Math.max(ch[0], ch[1], ch[2]);
      var min = Math.min(ch[0], ch[1], ch[2]);
      var delta = max - min;
      if (delta === 0) return 0;
      return Math.round((delta / (1 - Math.abs(2 * ((max + min) / 2) - 1))) * 1000) / 1000;
    };
    out.liveDotTheme = document.documentElement.getAttribute("data-theme");
    out.liveDotColors = { on: liveOnColor, off: liveOffColor, idle: liveIdleColor };
    out.liveIdleSaturation = saturationOf(liveIdleColor);
    out.liveIdleIsGray = out.liveIdleSaturation !== null && out.liveIdleSaturation < 0.2;
    // 另两档必须**有彩**：否则「灰」这个判据本身没有区分力（三档都灰也能骗过上面一条）
    out.liveVividStatesKeepColor = saturationOf(liveOnColor) > 0.4 && saturationOf(liveOffColor) > 0.4;
    // 清晰度：状态点是**非文字图形要素**（WCAG 1.4.11 要 3:1）。顶栏是半透明的一层，
    // 标签页坐在画布 / 面板上，所以对 --bg 与 --bg-elevated 两面各量一次。
    out.liveIdleContrastOnCanvas = contrastRatio(liveIdleColor, cssColorOf("--bg"));
    out.liveIdleContrastOnSurface = contrastRatio(liveIdleColor, cssColorOf("--bg-elevated"));
    out.liveIdleContrastOk = out.liveIdleContrastOnCanvas >= 3 && out.liveIdleContrastOnSurface >= 3;
    // ---- 图标**规范**取证（用户 2026-09-13 第 4 条 → 追加：「可能他们本就不一致，只调 size 没用？」）。
    //      上一版只把两枚的**墨迹粗细**都调成 1.5px，形状 / 光学尺寸仍各走各的（箭头墨迹 9 × 16.5
    //      且偏左 0.75，⋯ 跨度只有 11.5、圆点 1.5）—— 所以「整体粗细不一致」还在。现在两枚共用
    //      **一套**规范（见 RoomView.tsx / app.module.css 的注释）：同一个 24 × 24 盒与 viewBox、
    //      同一条 stroke-width（1.75）、同一套 round 线帽 / 接合、墨迹都居中于 (12,12)、
    //      主轴尺寸都是 16 单位（箭头的**高** = ⋯ 的**宽**）、⋯ 的圆点直径 = 2 × 描边宽。
    //      量法（iconGeomOf）定义在场景开头：**step1 的主题按钮**三档也走同一把尺子。
    out.iconBack = iconGeomOf(roundCtl[0]);
    out.iconMore = iconGeomOf(roundCtl[1]);
    out.iconBackInkThicknessPx = out.iconBack ? out.iconBack.inkThicknessPx : null;
    out.iconMoreInkThicknessPx = out.iconMore ? out.iconMore.inkThicknessPx : null;
    // ① ⋯ 的圆点直径 = 2 × 返回那一笔的描边宽（同一套规范里唯一的比例关系）
    out.iconDotsTwiceStroke = !!out.iconBack && !!out.iconMore &&
      Math.abs(out.iconMore.inkThicknessPx - out.iconBack.inkThicknessPx * 2) < 0.2;
    // ② 同一个渲染盒（24 × 24、缩放系数 1）与同一个 viewBox
    out.iconSameBox = !!out.iconBack && !!out.iconMore &&
      out.iconBack.viewBox === out.iconMore.viewBox && out.iconBack.viewBox === "0 0 24 24" &&
      Math.abs(out.iconBack.boxPx - out.iconMore.boxPx) < 0.6 &&
      Math.abs(out.iconBack.scale - 1) < 0.01;
    // ③ 同一套线帽 / 接合（返回是描边路径，⋯ 是实心圆点：端点形状由「圆」本身保证）
    out.iconCapsShared = !!out.iconBack && out.iconBack.linecap === "round" &&
      out.iconBack.linejoin === "round" && out.iconMore.shapeCount === 3;
    // ④ 两枚的墨迹都**居中**于 (12,12)（改前箭头偏左 0.75 —— 这就是「看着不一样」的一半原因）
    out.iconInkCentered = !!out.iconBack && !!out.iconMore &&
      Math.abs(out.iconBack.inkCenterX - 12) < 0.2 && Math.abs(out.iconBack.inkCenterY - 12) < 0.2 &&
      Math.abs(out.iconMore.inkCenterX - 12) < 0.2 && Math.abs(out.iconMore.inkCenterY - 12) < 0.2;
    // ⑤ 主轴尺寸相同（箭头的高 = ⋯ 的宽 = 16 单位）：两枚的**视觉尺寸**一致，而不是各调一个数
    out.iconSameDominantExtent = !!out.iconBack && !!out.iconMore &&
      Math.abs(Math.max(out.iconBack.inkW, out.iconBack.inkH) -
        Math.max(out.iconMore.inkW, out.iconMore.inkH)) < 0.2;
    // 控件本身尺寸不变（40 × 40 正圆，两枚同尺寸）
    out.iconControlsSameSize = !!roundCtl[0] && !!roundCtl[1] &&
      Math.abs(rect(roundCtl[0]).width - rect(roundCtl[1]).width) < 0.6 &&
      Math.abs(rect(roundCtl[0]).width - 40) < 0.6;
    // 圆点仍是**正圆**（圆角 = 半径）
    out.liveDotIsCircle = !!liveDotEl &&
      Math.abs(liveDotEl.getBoundingClientRect().width -
        liveDotEl.getBoundingClientRect().height) < 0.6 &&
      (parseFloat(getComputedStyle(liveDotEl).borderTopLeftRadius) || 0) >=
        liveDotEl.getBoundingClientRect().width / 2 - 0.6;
    // ---- 标题放不下就**循环滚动**（用户 2026-09-13 第 3 条）。判据不靠「看起来在动」：
    //      「data-scroll」由「一份文字的宽度 > 可视宽度」量出来，动画挂在轨道上。
    //      三种标题各量一次（超长 / 短 / 夹具原名），另外量「滚动不许引起布局跳动」。
    var trackScrolling = function () {
      var trackEl = byTestId("db-title-track");
      return !!trackEl && trackEl.getAttribute("data-scroll") === "true" &&
        getComputedStyle(trackEl).animationName !== "none";
    };
    var longTitle = new Array(40).join("很长的直播间标题");
    var headerBoxBeforeScroll = rect(byTestId("db-room-header"));
    var titleBoxBeforeScroll = rect(byTestId("db-room-title"));
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: longTitle });
    await sleep(400);
    // 「放不下」是**量出来的**（一份文字的宽度 vs 可视宽度），不是一个开关：把两个数都记进快照
    var titleOverflowMeasured = function () {
      var copyEl = byTestId("db-title-copy");
      var viewEl = byTestId("db-room-title");
      return !!copyEl && !!viewEl && copyEl.offsetWidth > viewEl.clientWidth + 0.5;
    };
    out.titleMarqueeOnOverflow = trackScrolling() && titleOverflowMeasured();
    out.titleOverflowPx = (function () {
      var copyEl = byTestId("db-title-copy");
      var viewEl = byTestId("db-room-title");
      return copyEl && viewEl ? Math.round((copyEl.offsetWidth - viewEl.clientWidth) * 10) / 10 : null;
    })();
    // 轨道滚起来之后布局**一点都不许动**：头部 / 标题的盒子与滚动前逐项相同
    var headerBoxAfterScroll = rect(byTestId("db-room-header"));
    var titleBoxAfterScroll = rect(byTestId("db-room-title"));
    out.titleMarqueeNoLayoutJump = !!headerBoxAfterScroll && !!titleBoxAfterScroll &&
      Math.abs(headerBoxAfterScroll.height - headerBoxBeforeScroll.height) < 0.6 &&
      Math.abs(titleBoxAfterScroll.left - titleBoxBeforeScroll.left) < 0.6 &&
      Math.abs(titleBoxAfterScroll.top - titleBoxBeforeScroll.top) < 0.6 &&
      Math.abs(titleBoxAfterScroll.width - titleBoxBeforeScroll.width) < 0.6;
    // 标题仍与状态点同一排（滚动没有把它挤走）。**比中心不比顶边**：标题是整行文本盒
    // （行高 ~22px）、状态点只有 10px，顶边天然差半个行高，那不是「不同排」。
    var dotBoxAfterScroll = rect(byTestId("db-live-dot"));
    out.titleRowGapPx = titleBoxAfterScroll && dotBoxAfterScroll
      ? Math.round((titleBoxAfterScroll.left - dotBoxAfterScroll.right) * 10) / 10 : null;
    out.titleMarqueeKeepsRow = !!titleBoxAfterScroll && !!dotBoxAfterScroll &&
      titleBoxAfterScroll.left >= dotBoxAfterScroll.right - 0.5 &&
      Math.abs((titleBoxAfterScroll.top + titleBoxAfterScroll.height / 2) -
        (dotBoxAfterScroll.top + dotBoxAfterScroll.height / 2)) <= 3;
    // 短标题**不滚**（不是「一律滚」）
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: "短" });
    await sleep(400);
    out.titleShortNoMarquee = !trackScrolling() && !titleOverflowMeasured() &&
      byTestId("db-title-track").getAttribute("data-scroll") === "false";
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: fixtureRoom.title });
    await sleep(400);
    // 标题在 DOM 里有两份拷贝（循环滚动要的），因此按**属性**而不是 innerText 认它。
    // 这里不判滚不滚：宽屏下夹具标题放得下、窄屏（可视宽 ~83px）下放不下，两边本来就不同档
    out.titleRestored = byTestId("db-room-title").getAttribute("title") === fixtureRoom.title;

    // ---- 电池：**发送按钮左侧**、**不是圆形**（用户 2026-09-13：「电池不要圆形，仅 3 点选项需要」+
    //      「电池数量挪到底部发送按钮左侧」）。
    var batteryEl = byTestId("db-battery");
    var batteryBox = rect(batteryEl);
    var batteryRadius = batteryEl
      ? parseFloat(getComputedStyle(batteryEl).borderTopLeftRadius) || 0 : 0;
    var sendButtonEl = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .filter(function (b) { return b.innerText.trim() === "发送"; })[0];
    var sendBox = rect(sendButtonEl);
    out.batteryInComposer = !!batteryEl && !!byTestId("db-composer-tools") &&
      byTestId("db-composer-tools").contains(batteryEl);
    out.batteryLeftOfSend = !!batteryBox && !!sendBox && batteryBox.right <= sendBox.left + 1;
    out.batteryRadiusPx = Math.round(batteryRadius * 10) / 10;
    out.batteryBoxPx = batteryBox
      ? [Math.round(batteryBox.width * 10) / 10, Math.round(batteryBox.height * 10) / 10] : null;
    // 「不是圆形」= 圆角**不**等于半边长（正圆与胶囊都会等于半短边，都算圆）
    out.batteryNotRound = !!batteryBox && batteryRadius > 0 &&
      batteryRadius < Math.min(batteryBox.width, batteryBox.height) / 2 - 1;
    out.batteryText = batteryEl ? batteryEl.innerText.trim() : null;
    // ---- 电池图标形状取证（用户 2026-09-13 第 3 条：官方是**竖**着的电池，横着像电量条）。
    //      量图标盒的宽高比 + SVG 里那个矩形与极柱的**朝向**（宽 > 高 = 横着）。
    var batterySvgEl = batteryEl ? batteryEl.querySelector("svg") : null;
    var batteryRects = batterySvgEl ? [].slice.call(batterySvgEl.querySelectorAll("rect")) : [];
    out.batteryIconBoxPx = batterySvgEl
      ? [Math.round(rect(batterySvgEl).width * 10) / 10, Math.round(rect(batterySvgEl).height * 10) / 10]
      : null;
    out.batteryIconShape = batteryRects.length > 0 ? {
      rectW: parseFloat(batteryRects[0].getAttribute("width")),
      rectH: parseFloat(batteryRects[0].getAttribute("height")),
      viewBox: batterySvgEl.getAttribute("viewBox"),
    } : null;

    // 输入区：输入框占满宽度；工具行放不下就换行，不许挤成小方块
    var composerEl0 = document.querySelector("textarea").parentElement;
    var toolsEl0 = byTestId("db-composer-tools");
    put("textareaFullWidth",
      Math.abs(rect(document.querySelector("textarea")).width - composerEl0.clientWidth) < 26);
    put("toolsRowNoOverflow", !!toolsEl0 &&
      toolsEl0.scrollWidth <= toolsEl0.clientWidth + 1);
    snap();

    // ---- 几何：内容不足视口高度时整体贴底（直播弹幕自下往上读，最新一条紧贴输入区）
    // 此刻列表只有历史 1 条 + 实时 3 条，远未填满视口，正好测「富余空间去了哪」。
    // 贴底时 未尾行.bottom 与滚动容器.bottom 之间只剩容器的 padding-bottom（8px）。
    var scrollerShort = byTestId("db-chat-scroll");
    var lastRowShort = rows()[rows().length - 1];
    out.layoutShortContentBottomGap = lastRowShort
      ? Math.round(scrollerShort.getBoundingClientRect().bottom - lastRowShort.getBoundingClientRect().bottom)
      : null;
    out.layoutShortContentPinnedBottom =
      out.layoutShortContentBottomGap !== null && out.layoutShortContentBottomGap <= 12;
    // 停一下让跑脚本的进程抓一张「内容不足视口时贴底」的截图
    snap();
    await sleep(900);

    // 再补 60 条，让列表真的会滚（后面的几何断言才有意义）
    for (var i = 0; i < 60; i += 1) {
      window.__emit("danmubox://message", window.__mk("danmaku", "实时弹幕 " + i));
    }
    await sleep(700);
    out.rowCount = rows().length;
    snap();

    // 粉丝牌配色：上游真彩色优先；空串不是颜色，回退按牌名派生的色相（issue #6 / 契约 §5）
    window.__emit("danmubox://message", window.__mk("danmaku", "带真彩牌弹幕", false, {
      medal_level: 7, medal_name: "真彩牌",
      medal_color_start: "#3FB4F699", medal_color_end: "#1E6FD9",
      medal_color_border: "#FFFFFF", medal_color_text: "#FFFFFF"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "无真彩牌弹幕", false, {
      medal_level: 3, medal_name: "兜底牌"
    }));
    // 回复关系（issue #13b）与「舰长标只认本房间」（issue #12）的样本行
    window.__emit("danmubox://message", window.__mk("danmaku", "这条是回复 @被回复的人 你好", false, {
      // 上游自定义颜色的弹幕（舰长/老爷常见金黄）。用户名与正文都不许被它染色——
      // 用户 2026-09-12 的原始反馈：用户名被染成白色看不见、正文偏黄。
      color: 16776960,
      reply_to_uid: 777, reply_to_uname: "被回复的人", reply_uname_color: "#FB7299"
    }));
    // 上游没给配色（空串）时不上色：**空串不是颜色**，与粉丝牌真彩色同一口径
    window.__emit("danmubox://message", window.__mk("danmaku", "没有配色的回复 @另一个被回复的人 哦", false, {
      reply_to_uid: 778, reply_to_uname: "另一个被回复的人", reply_uname_color: ""
    }));
    // 正文里的 @ 与「回复关系」**不是一回事**（用户 2026-09-13 第 1 条）：这条没有任何
    // reply_* 字段，正文里的 @ 照样高亮——高亮认的是正文，不是回复标记。
    window.__emit("danmubox://message", window.__mk("danmaku", "没有回复关系也 @路人乙 高亮", false, {
      uname: "路人甲"
    }));
    // 排版样本（issue #8 的「一条弹幕要像一个整体」）：
    // ① 长正文：在 360 与 1440 两个视口都会折行，用来量折行后的首字位置；
    // ② 带徽标 + 昵称 + 正文的行：用来量「徽标组→昵称」与「昵称→正文」两道间距。
    window.__emit("danmubox://message", window.__mk("danmaku",
      "折行样本：" + "身份属于人名，正文属于内容，两者之间要分开；折行之后每一行都要与首行文字左对齐，而不是回到头像下面。".repeat(3)));
    // ③ 无空格的长 ASCII 串（真实载荷里的 CDN 地址）：必须就地断开，不许把行撑出横向滚动。
    window.__emit("danmubox://message", window.__mk("danmaku", ROW_ASCII, false, {
      uname: "贴链接的观众"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "紧贴昵称的徽标弹幕", false, {
      uname: "身份样本", medal_level: 7, medal_name: "紧贴牌", guard_level: 3
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "他房间的牌子弹幕", false, {
      medal_level: 7, medal_name: "外间牌", medal_guard_level: 3, guard_level: 0
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "本房间的大航海弹幕", false, {
      guard_level: 3
    }));
    // 弹幕自己的颜色**只属于正文**（用户 #2 的根因）：一条真彩色、一条普通白。
    // 上游给普通弹幕的颜色就是 16777215（白），名字吃这条颜色时白字人名在浅色主题下就是「看不见」。
    window.__emit("danmubox://message", window.__mk("danmaku", "红字弹幕正文", false, {
      color: 0xff0000, uname: "红字观众"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "白字弹幕正文", false, {
      color: 16777215, uname: "白字观众"
    }));
    // 表情弹幕：身份簇 / 头像 / 表情图三者对齐的样本（用户 #1/#2 的「发表情时错开」）。
    // ① 行内表情 ② 独占一行的大表情（bulge）——旧版在 ② 上错开 32px（身份簇被拽到图片底边）。
    var faceUrl = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%2300aeec'/></svg>";
    // 这两条表情也**取自真实载荷**（固有尺寸 200×60 的通用表情、162×162 的 bulge 表情），
    // 不再是手写的 64×64 正方形：尺寸特征与真站一致，行内的缩放关系才量得准。
    var rowEmote = function (sample) {
      return {
        emoticon_unique: sample.emoticon_unique, url: sample.url, width: sample.width,
        height: sample.height, is_dynamic: sample.is_dynamic,
        in_player_area: sample.in_player_area, bulge_display: sample.bulge_display
      };
    };
    window.__emit("danmubox://message", window.__mk("danmaku", "行内表情样本", false, {
      face: faceUrl, uname: "表情君", emote: rowEmote(ROW_EMOTES.inline)
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "大表情样本", false, {
      face: faceUrl, uname: "大表情君", emote: rowEmote(ROW_EMOTES.bulge)
    }));
    // 头像（Message.face）：有头像画图、没头像不渲染、加载失败退化成首字符占位
    window.__emit("danmubox://message", window.__mk("danmaku", "带头像的弹幕", false, {
      face: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%2300aeec'/></svg>",
      uname: "有头像"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "坏头像的弹幕", false, {
      face: "data:image/png;base64,AAAA",
      uname: "坏头像"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "无头像的弹幕", false, {
      face: "",
      uname: "无头像"
    }));
    // 自己发的那条：uid 必须等于 session.uid（mock 的账号表里 default = 1000），
    // 用来验「我方弹幕」的行级标记（整行底色 + 行首 2px 竖条，不做气泡）
    window.__emit("danmubox://message", window.__mk("danmaku", "我自己发的弹幕", false, {
      uid: 1000,
      uname: "本地测试"
    }));
    // 真实夹具的两行（用户 2026-09-12 报的那条正文行 + 一条真实表情包弹幕）：
    // 消息对象由 Node 侧从 smoke/fixtures/danmaku-rows.json 按 cmd.rs 的口径派生，这里只负责发。
    // local_id 必须由本地计数器分配 —— store 只接受比末尾更大的 local_id（契约 §5），
    // 所以先借 __mk 拿一个号，再把夹具字段盖上去（local_id 除外）。
    var fixtureMessage = function (fixture) {
      var m = window.__mk("danmaku", fixture.content, false);
      var allocated = m.local_id;
      for (var key in fixture) if (key !== "local_id") m[key] = fixture[key];
      m.local_id = allocated;
      return m;
    };
    window.__emit("danmubox://message", fixtureMessage(ROW_FIXTURES.text));
    window.__emit("danmubox://message", fixtureMessage(ROW_FIXTURES.emoticon));
    await sleep(600);
    var withFace = rowWith("带头像的弹幕");
    var badFace = rowWith("坏头像的弹幕");
    var noFace = rowWith("无头像的弹幕");
    var avatarOf = function (row) {
      return row ? row.querySelector('[data-testid="db-msg-avatar"]') : null;
    };
    out.avatarImageRendered = !!avatarOf(withFace) && avatarOf(withFace).tagName === "IMG";
    out.avatarAbsentWhenNoFace = !avatarOf(noFace);
    out.avatarFallbackOnError = !!avatarOf(badFace) && avatarOf(badFace).tagName === "SPAN";
    // 头像列永远占位：三行的昵称左边缘必须一致（没头像的那行不许整体左移）
    var nameLefts = [withFace, badFace, noFace].map(function (row) {
      var name = row ? row.querySelector('[data-testid="db-msg-name"]') : null;
      return name ? Math.round(name.getBoundingClientRect().left * 10) / 10 : null;
    });
    out.layoutNameLefts = nameLefts;
    // ---- 真实夹具派生行的排版取证（用户 2026-09-12：「文字全挤在右边，没法往用户名 / 身份牌
    //      下方换行」，并判断「是之前调表情的格式导致的」）。
    // 量四件事：① 行可用宽度与正文列宽度；② 正文起点 x 与折行行数（Range 按**行盒**返回矩形）；
    // ③ 行内表情图的**渲染盒**与**原图尺寸**（渲染盒跟着原图走 = 第三次同款错误）；
    // ④ 行 / 正文列有没有横向溢出。
    var f1 = function (v) { return Math.round(v * 10) / 10; };
    var fixtureMetricsOf = function (row) {
      if (!row) return null;
      var body = row.querySelector('[data-testid="db-msg-body"]');
      var identity = row.querySelector('[data-testid="db-msg-identity"]');
      var img = body ? body.querySelector("img") : null;
      var rowBox = rect(row);
      var bodyBox = rect(body);
      var lines = [];
      if (body) {
        var range = document.createRange();
        range.selectNodeContents(body);
        lines = [].slice.call(range.getClientRects());
      }
      var imgBox = rect(img);
      var imgStyle = img ? getComputedStyle(img) : null;
      return {
        rowW: f1(rowBox ? rowBox.width : 0),
        rowLeft: f1(rowBox ? rowBox.left : 0),
        bodyLeft: f1(bodyBox ? bodyBox.left : 0),
        bodyRight: f1(bodyBox ? bodyBox.right : 0),
        bodyTop: f1(bodyBox ? bodyBox.top : 0),
        bodyW: f1(bodyBox ? bodyBox.width : 0),
        identityW: identity ? f1(rect(identity).width) : null,
        identityLeft: identity ? f1(rect(identity).left) : null,
        identityTop: identity ? f1(rect(identity).top) : null,
        identityH: identity ? f1(rect(identity).height) : null,
        lines: lines.length,
        lineLefts: lines.map(function (l) { return f1(l.left); }),
        firstLineLeft: lines.length > 0 ? f1(lines[0].left) : null,
        lastLineLeft: lines.length > 0 ? f1(lines[lines.length - 1].left) : null,
        imgW: imgBox ? f1(imgBox.width) : null,
        imgH: imgBox ? f1(imgBox.height) : null,
        // 原图尺寸：渲染盒若与它同进同退，说明尺寸还是被原图牵着走
        imgNaturalW: img ? img.naturalWidth : null,
        imgNaturalH: img ? img.naturalHeight : null,
        imgCssW: imgStyle ? imgStyle.width : null,
        imgCssH: imgStyle ? imgStyle.height : null,
        imgFit: imgStyle ? imgStyle.objectFit : null,
        rowOverflowPx: f1(Math.max(0, row.scrollWidth - row.clientWidth)),
        bodyOverflowPx: body ? f1(Math.max(0, body.scrollWidth - body.clientWidth)) : null
      };
    };
    var fixtureTextRow = rowWith(ROW_FIXTURES.text.content);
    // 表情包弹幕那一条没有可搜索的正文文本（正文被画成了图），按**图的 alt** 找它：
    // alt 就是表情名，也就是这条弹幕的「正文」。
    var fixtureEmoteRow = rows().filter(function (r) {
      var img = r.querySelector('[data-testid="db-msg-body"] img');
      return !!img && img.alt === ROW_FIXTURES.emoticon.content;
    })[0];
    out.fixtureTextRow = fixtureMetricsOf(fixtureTextRow);
    out.fixtureEmoteRow = fixtureMetricsOf(fixtureEmoteRow);
    out.fixtureRowsRendered = !!fixtureTextRow && !!fixtureEmoteRow;
    // 正文不许越出自己那一列（「挤到右边 / 撑出去」的判据）：行与正文列都不得横向溢出
    out.fixtureTextNoOverflow = !!out.fixtureTextRow &&
      out.fixtureTextRow.rowOverflowPx === 0 && out.fixtureTextRow.bodyOverflowPx === 0;
    // 正文必须拿到**整行宽度**（≥ 视口的一半，用户 2026-09-13）：
    // 改前是「身份簇 ｜ 正文」两列，360 宽下身份簇列 182.7px（占正文块 56%）、正文列只剩
    // 112.4px —— 用户的「长文本弹幕自动换行还是没有实现好」就是它。改后正文另起一行。
    // 量的是**视口**的一半（不是「正文块的一半」）：那才是用户眼睛看到的宽度。
    var fixtureBodyEl = fixtureTextRow
      ? fixtureTextRow.querySelector('[data-testid="db-msg-body"]')
      : null;
    var fixtureBlockEl = fixtureBodyEl ? fixtureBodyEl.parentElement : null;
    var fixtureBlockBox = rect(fixtureBlockEl);
    out.fixtureTextBlockPx = fixtureBlockBox ? f1(fixtureBlockBox.width) : null;
    out.fixtureTextBodyShareOfViewport = out.fixtureTextRow
      ? f1(out.fixtureTextRow.bodyW / window.innerWidth)
      : null;
    out.fixtureTextBodyKeepsHalfViewport = !!out.fixtureTextRow &&
      out.fixtureTextRow.bodyW >= window.innerWidth / 2;
    // 正文的行宽 = 正文块的宽度减去那一道行内左边距（--sp-1 已经在头像列上，这里应是 0）
    out.fixtureTextBodyFillsBlock = !!out.fixtureTextRow && out.fixtureTextBlockPx !== null &&
      out.fixtureTextBlockPx - out.fixtureTextRow.bodyW < 1;
    // 悬挂缩进 = 正文左边缘与**用户名**左边缘一致（上下两行共用同一个左起点）
    out.fixtureBodyAlignedWithName = !!out.fixtureTextRow &&
      out.fixtureTextRow.identityLeft !== null &&
      Math.abs(out.fixtureTextRow.bodyLeft - out.fixtureTextRow.identityLeft) < 1;
    // 正文在身份行**下面**（另起一行）：正文顶边 ≥ 身份行底边
    out.fixtureBodyOnSecondRow = !!out.fixtureTextRow &&
      out.fixtureTextRow.identityTop !== null && out.fixtureTextRow.identityH !== null &&
      out.fixtureTextRow.bodyTop >= out.fixtureTextRow.identityTop + out.fixtureTextRow.identityH - 1;
    // 「能换行」在**窄屏**上量（360 = 窗口最小宽度，也就是可达面的边界）：折成 ≥2 个行盒，
    // 且**每一行**都与首行左对齐（悬挂缩进）——不是被挤到右侧去、也不是回到头像下面。
    out.fixtureTextWrapLineLefts = out.fixtureTextRow
      ? [out.fixtureTextRow.firstLineLeft, out.fixtureTextRow.lastLineLeft]
      : null;
    // 真实夹具那条正文只有 21 个字：正文拿到整行宽后，窄屏下一行就放得下了 —— 那不是失败，
    // 所以这里只断言「折行时每一行都与首行左对齐」；「窄屏下长正文折 ≥2 行」由下面
    // layoutHangIndent* 那组在**足够长**的样本上断言（用户 2026-09-13 的第 ② 条）。
    out.fixtureTextLinesAlignWhenWrapped = !!out.fixtureTextRow &&
      out.fixtureTextRow.lineLefts.every(function (l) {
        return Math.abs(l - out.fixtureTextRow.firstLineLeft) < 1;
      });
    // ---- 无空格的长 ASCII 串（真实载荷里的 CDN 地址，用户 2026-09-13）：就地断开、
    //      不许把行撑出横向滚动。窄屏下它必然放不进一行，所以「断了」是量得出来的；
    //      宽屏下放得下就不断——两种情形都只要求**不溢出**。
    var asciiRow = rowWith(ROW_ASCII);
    out.fixtureAsciiRow = fixtureMetricsOf(asciiRow);
    out.fixtureAsciiNoOverflow = !!out.fixtureAsciiRow &&
      out.fixtureAsciiRow.rowOverflowPx === 0 && out.fixtureAsciiRow.bodyOverflowPx === 0;
    // 正文的右边缘不许越出行（行盒 scrollWidth ≤ clientWidth 的另一半：几何上也在里面）
    out.fixtureAsciiInsideRow = !!out.fixtureAsciiRow &&
      out.fixtureAsciiRow.bodyRight <= out.fixtureAsciiRow.rowLeft + out.fixtureAsciiRow.rowW + 1;
    // 断开点必须落在正文块内部：行内最长的一行长（= 正文宽度）不超出行宽
    out.fixtureAsciiWrapsWhenNarrow = !NARROW || (!!out.fixtureAsciiRow &&
      out.fixtureAsciiRow.lines >= 2);


    // 行内表情图的**盒子**不许跟着原图走：同一个尺寸档里，200×60 的横条（通用表情样本，
    // 取自 emotes.json 的真实尺寸）与 162×162 的方图（夹具里的表情包弹幕）必须渲染成同一个盒。
    // 只给 height 的话宽度会按原图比例算出来 —— 改前实测：横条那条 23.1px 高 / 77px 宽。
    // 样本行按**图的 alt** 找（它的正文被画成了图，innerText 里没有那条文本）。
    var inlineSampleRow = rows().filter(function (r) {
      var img = r.querySelector('[data-testid="db-msg-body"] img');
      return !!img && img.alt === "行内表情样本";
    })[0];
    var inlineSampleImg = inlineSampleRow
      ? inlineSampleRow.querySelector('[data-testid="db-msg-body"] img')
      : null;
    var inlineSampleBody = inlineSampleRow
      ? inlineSampleRow.querySelector('[data-testid="db-msg-body"]')
      : null;
    var lineBoxPxHere = inlineSampleBody
      ? parseFloat(getComputedStyle(inlineSampleBody).lineHeight)
      : NaN;
    var inlineSampleBox = rect(inlineSampleImg);
    out.rowInlineEmoteBox = inlineSampleBox
      ? { w: f1(inlineSampleBox.width), h: f1(inlineSampleBox.height), naturalW: inlineSampleImg.naturalWidth,
          naturalH: inlineSampleImg.naturalHeight, fit: getComputedStyle(inlineSampleImg).objectFit }
      : null;
    // ---- 行内通用表情的**渲染盒 vs 文字高**取证（用户 2026-09-13 第 7 条：
    //      「通用表情在弹幕里渲染得有点小，看起来是当成文本渲染了」）。
    //      通用表情的原图是 200×60 的**横条**：见方盒 + contain 之后，可见高度只有盒宽的 30%。
    //      这里把「盒」「原图」「正文行高」「一行文字的墨迹高」四个数一起记下来。
    var textInkProbe = (function () {
      var probe = document.createElement("span");
      probe.textContent = "字";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      inlineSampleBody.appendChild(probe);
      var box = rect(probe);
      var result = { h: f1(box.height), fontSize: getComputedStyle(probe).fontSize };
      probe.parentNode.removeChild(probe);
      return result;
    })();
    out.rowInlineEmoteContext = inlineSampleBox ? {
      boxW: f1(inlineSampleBox.width),
      boxH: f1(inlineSampleBox.height),
      naturalW: inlineSampleImg.naturalWidth,
      naturalH: inlineSampleImg.naturalHeight,
      visibleRatioW: Math.round((inlineSampleBox.width / inlineSampleImg.naturalWidth) * 1000) / 1000,
      bodyLinePx: Math.round(lineBoxPxHere * 10) / 10,
      // 1em 在这里是多少：字号的 px 值（「比普通文字高」的基准）
      emPx: parseFloat(getComputedStyle(inlineSampleBody).fontSize),
      // 图**画出来**的高度（contain 之后）：盒与横条同比例时它就等于盒高
      visibleH: f1(Math.min(
        inlineSampleBox.height,
        inlineSampleBox.width / (inlineSampleImg.naturalWidth / inlineSampleImg.naturalHeight),
      )),
      emTokenPx: (function () {
        var v = getComputedStyle(inlineSampleBody).getPropertyValue("--emote");
        return v.trim();
      })(),
      textInkPx: textInkProbe.h,
      imgTop: f1(rect(inlineSampleImg).top),
      bodyTop: f1(rect(inlineSampleBody).top),
      bodyBottom: f1(rect(inlineSampleBody).bottom),
      rowH: f1(rect(inlineSampleRow).height),
    } : null;
    // 改后（用户 2026-09-13 第 7 条）：通用表情在行内拿到**与它原图长宽比相称的宽盒** ——
    // 高度仍是 --emote（= 1.1 × 行盒），宽度写成固定的 10:3 算式。三条一起判：
    // ① 盒高 = 1.1 × 行盒（不是 1em，也不是原图高度）；② 宽高比 = 10:3（横条正好填满盒）；
    // ③ 画出来的高度**大于 1em**（= 字号）—— 这就是「别当成文本渲染」的可验形式。
    out.rowInlineEmoteWideBox = !!inlineSampleBox && !isNaN(lineBoxPxHere) &&
      Math.abs(inlineSampleBox.height - lineBoxPxHere * 1.1) < 0.6 &&
      Math.abs(inlineSampleBox.width / inlineSampleBox.height - 10 / 3) < 0.06;
    out.rowInlineEmoteTallerThanText = !!out.rowInlineEmoteContext &&
      out.rowInlineEmoteContext.visibleH > out.rowInlineEmoteContext.emPx + 1 &&
      out.rowInlineEmoteContext.visibleH >= out.rowInlineEmoteContext.bodyLinePx - 0.6;
    // 宽盒也不许撑破行：盒右边缘仍在行内，行与正文块都没有横向溢出
    out.rowInlineEmoteFitsRow = !!inlineSampleRow && !!inlineSampleBox &&
      inlineSampleBox.right <= rect(inlineSampleRow).right + 1 &&
      Math.max(0, inlineSampleRow.scrollWidth - inlineSampleRow.clientWidth) === 0 &&
      Math.max(0, inlineSampleBody.scrollWidth - inlineSampleBody.clientWidth) === 0 &&
      getComputedStyle(inlineSampleImg).objectFit === "contain";
    // 夹具那条表情包弹幕（bulge：2 倍档）：同样是**见方 + contain** 的显式盒
    out.fixtureEmoteImgExplicitBox = !!out.fixtureEmoteRow && !isNaN(lineBoxPxHere) &&
      out.fixtureEmoteRow.imgFit === "contain" && out.fixtureEmoteRow.imgW !== null &&
      Math.abs(out.fixtureEmoteRow.imgW - out.fixtureEmoteRow.imgH) < 0.6 &&
      Math.abs(out.fixtureEmoteRow.imgH - lineBoxPxHere * 1.1 * 2) < 0.6;
    out.fixtureEmoteImgInsideColumn = !!out.fixtureEmoteRow &&
      out.fixtureEmoteRow.imgW !== null &&
      out.fixtureEmoteRow.imgW <= out.fixtureEmoteRow.bodyW + 1 &&
      out.fixtureEmoteRow.rowOverflowPx === 0;

    out.layoutAvatarColumnAligned =
      nameLefts.every(function (v) { return v !== null && Math.abs(v - nameLefts[0]) < 0.6; });
    // 粉丝牌配色：可观察面是行内 style 与计算样式（不依赖 CSS-module 类名）
    var medalBadgeOf = function (needle) {
      var row = rowWith(needle);
      if (!row) return null;
      var spans = [].slice.call(row.querySelectorAll("span"));
      for (var i = 0; i < spans.length; i += 1) {
        if ((spans[i].getAttribute("style") || "").indexOf("linear-gradient") >= 0) return spans[i];
      }
      return null;
    };
    var medalStyleText = function (badge) {
      if (!badge) return "";
      return (badge.getAttribute("style") || "") + "|" + getComputedStyle(badge).backgroundImage;
    };
    var trueMedalText = medalStyleText(medalBadgeOf("带真彩牌弹幕"));
    var fallbackMedalText = medalStyleText(medalBadgeOf("无真彩牌弹幕"));
    out.medalTrueColorApplied = trueMedalText.indexOf("#3FB4F699") >= 0 ||
      trueMedalText.indexOf("63, 180, 246") >= 0;
    out.medalFallbackGradientApplied = fallbackMedalText.indexOf("linear-gradient") >= 0 &&
      fallbackMedalText !== trueMedalText;
    // ---- @ 高亮（用户 2026-09-13 第 1 条）：身份行最后那枚「回复 @某人」的牌子与正文里
    //      自带的 @ 重复，牌子**删掉**；@ 改在**正文里**就地强调，配色**参照身份牌**的字符色。
    //      改前的取证：那枚牌子是 .replyTo 一格（文案「回复 @昵称」、弱化色 + 14% 灰底 +
    //      4px 圆角，排在身份牌右侧）—— 改前快照里的 replyLabelBox 就是它的几何。
    out.replyChipGone =
      document.querySelectorAll('[data-testid="db-msg-reply"], [data-testid="db-msg-reply-name"]')
        .length === 0;
    var replyRow = rowWith("这条是回复");
    var mentionOf = function (row) {
      return row ? row.querySelector('[data-testid="db-msg-mention"]') : null;
    };
    var replyMention = mentionOf(replyRow);
    out.mentionHighlighted = !!replyMention && replyMention.innerText === "@被回复的人";
    // 颜色 = **正文里的醒目可读色**（令牌 --mention），**不是**身份牌的文字色：用户 2026-09-13
    // 第二次实测「@的颜色之前不是粉色吗，白色看不清啊」—— 身份牌那枚白字是「彩底上的文字色」，
    // 照抄到正文里在深色下与正文近乎同色、在浅色下白压米色（1.2:1）干脆看不见。
    // 判据按「这件事在用户眼里成不成立」写，不用硬编码色值：
    // ① 两套主题下都对**所在面**（画布 --bg / 表面 --bg-elevated）≥ 4.5:1（正文档，深浅各跑一遍
    //    由 runner 的主题维度保证）；② 与正文色**不同**且**有彩**——「醒目」不能靠加底色或加粗。
    var mentionTokenColor = cssColorOf("--mention");
    var mentionColor = replyMention ? getComputedStyle(replyMention).color : "";
    var replyBodyEl = replyRow ? replyRow.querySelector('[data-testid="db-msg-body"]') : null;
    var mentionBodyColor = replyBodyEl ? getComputedStyle(replyBodyEl).color : "";
    out.mentionColor = mentionColor;
    out.mentionBodyColor = mentionBodyColor;
    out.mentionContrastOnCanvas = contrastRatio(mentionColor, cssColorOf("--bg"));
    out.mentionContrastOnSurface = contrastRatio(mentionColor, cssColorOf("--bg-elevated"));
    out.mentionSaturation = saturationOf(mentionColor);
    out.mentionColorVisible = mentionColor === mentionTokenColor &&
      out.mentionContrastOnCanvas >= 4.5 && out.mentionContrastOnSurface >= 4.5 &&
      mentionColor !== mentionBodyColor && out.mentionSaturation > 0.4;
    // 用户 2026-09-13 的更正：「高亮我要求的是使用字体颜色，不是背景」—— @ 那一格**只许有颜色**：
    // 底色 / 背景图都没有（上一版那层 45° 强调色渐变底已删），内边距与圆角也没加回来。
    var mentionStyle = replyMention ? getComputedStyle(replyMention) : null;
    // 同样不用正则（见上面 saturationOf 那条注）：这三种写法都是「没有底色」。
    var noPaint = function (value) {
      return value === "none" || value === "transparent" || value === "rgba(0, 0, 0, 0)" ||
        value.indexOf("0, 0, 0, 0") >= 0;
    };
    out.mentionNoBackground = !!mentionStyle &&
      noPaint(mentionStyle.backgroundImage) && noPaint(mentionStyle.backgroundColor) &&
      parseFloat(mentionStyle.paddingLeft) === 0 && parseFloat(mentionStyle.paddingRight) === 0 &&
      parseFloat(mentionStyle.borderTopLeftRadius) === 0;
    // 高亮认的是**正文**，不是回复关系：没有任何 reply_* 字段的那条照样高亮
    var plainMentionRow = rowWith("没有回复关系也");
    out.mentionWorksWithoutReply = !!mentionOf(plainMentionRow) &&
      mentionOf(plainMentionRow).innerText === "@路人乙";
    // 切分只加壳、不改字：正文的文字一个不丢（正文元素在上面量过一次，复用同一个）
    out.mentionBodyTextIntact = !!replyBodyEl &&
      replyBodyEl.innerText === "这条是回复 @被回复的人 你好";
    // 另一条回复（上游没给配色）也跟着高亮，且**没有**被上游色染过
    var noColorRow = rowWith("没有配色的回复");
    var noColorMention = mentionOf(noColorRow);
    out.mentionHighlightedWithoutUpstreamColor = !!noColorMention &&
      noColorMention.innerText === "@另一个被回复的人" &&
      getComputedStyle(noColorMention).color === mentionTokenColor;
    // 舰长标只认本房间的 guard_level：戴着别的房间舰长牌（medal_guard_level=3）不亮舰长标（issue #12）
    // 判据看**徽标元素本身**的文本（正文里出现「舰长」两字不算）
    var hasGuardBadge = function (row) {
      if (!row) return false;
      return [].slice.call(row.querySelectorAll("span")).some(function (s) {
        return s.innerText.trim() === "舰长";
      });
    };
    var outsideGuardRow = rowWith("他房间的牌子弹幕");
    var roomGuardRow = rowWith("本房间的大航海弹幕");
    out.guardBadgeNotFromMedalGuardLevel = !!outsideGuardRow && !hasGuardBadge(outsideGuardRow);
    out.guardBadgeShownForRoomGuard = hasGuardBadge(roomGuardRow);

    // ---- 身份行：**昵称在前、身份牌在昵称右侧**（参考图口径，用户 2026-09-13）；
    //      正文另起一行、左起点与昵称一致（不是被牌挤到右边去）。
    var badgeRow = rowWith("紧贴昵称的徽标弹幕");
    var badgesEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-badges"]') : null;
    var badgeNameEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-name"]') : null;
    var badgeBodyEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-body"]') : null;
    out.layoutNameBadgeGap = badgesEl && badgeNameEl
      ? Math.round((rect(badgesEl).left - rect(badgeNameEl).right) * 10) / 10
      : null;
    // ---- 身份牌圆角取证（用户 2026-09-13 第 6 条：「圆角大一些，现在看着有点方」）。
    //      两族都量：房间牌（.badge，圆角 0.25em）与粉丝牌（同样挂在 .badge 上）。
    var cornerRadiusOf = function (el) {
      if (!el) return null;
      var cs = getComputedStyle(el);
      var box = rect(el);
      return {
        radiusPx: Math.round((parseFloat(cs.borderTopLeftRadius) || 0) * 10) / 10,
        heightPx: Math.round(box.height * 10) / 10,
        raw: cs.borderTopLeftRadius,
      };
    };
    out.badgeRadius = badgesEl ? cornerRadiusOf(badgesEl.children[0]) : null;
    out.medalBadgeRadius = badgesEl
      ? cornerRadiusOf([].slice.call(badgesEl.children).filter(function (el) {
          return (el.getAttribute("style") || "").indexOf("linear-gradient") >= 0;
        })[0])
      : null;
    // 用户 2026-09-13 第 6 条：「身份标识的圆角大一些，现在看着有点方」。
    // 改前圆角 0.25em（≈ 牌高的 18.5%，实测 3.5px / 牌高 18.9px），改后 0.45em（≈ 33%）。
    // 两条一起判：① 圆角**比改前大**（> 牌高的 25%）；② 仍是矩形不是胶囊（< 半高）。
    out.badgeRadiusGrew = (function () {
      var b = out.badgeRadius;
      if (!b || b.heightPx === 0) return false;
      var ratio = b.radiusPx / b.heightPx;
      return ratio > 0.25 && b.radiusPx > 4 && ratio < 0.5;
    })();
    out.badgeRadiusRatio = out.badgeRadius && out.badgeRadius.heightPx > 0
      ? Math.round((out.badgeRadius.radiusPx / out.badgeRadius.heightPx) * 1000) / 1000
      : null;
    out.layoutBadgeAfterName = !!badgesEl && !!badgeNameEl &&
      rect(badgesEl).left >= rect(badgeNameEl).right - 1;
    // 牌与名字之间是「贴」（--sp-1 = 4px），不许出现第三种间距
    out.layoutBadgeTightWithName = out.layoutNameBadgeGap !== null &&
      out.layoutNameBadgeGap <= 4.01 && out.layoutNameBadgeGap >= 0;
    // 身份行独占一行：正文顶边在身份行底边**之下**（同一行的两列排法已删除）
    out.layoutBodyBelowIdentity = !!badgeBodyEl && !!badgesEl &&
      rect(badgeBodyEl).top >= rect(badgesEl).bottom - 1;
    // 正文与昵称共用左边缘（悬挂缩进的另一半：正文不是接在牌后面）
    out.layoutBodyLeftAlignedWithName = !!badgeBodyEl && !!badgeNameEl &&
      Math.abs(rect(badgeBodyEl).left - rect(badgeNameEl).left) < 1;

    // ---- 悬挂缩进：折行后每一行的首字都与首行的文字左对齐（不是回到头像下面）
    // 量法用 Range.getClientRects()：它按**行盒**返回矩形，正好能拿到每一行的左边缘。
    var wrapRow = rowWith("折行样本");
    var wrapBody = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-body"]') : null;
    var lineRects = [];
    if (wrapBody) {
      var range = document.createRange();
      range.selectNodeContents(wrapBody);
      lineRects = [].slice.call(range.getClientRects());
    }
    out.layoutHangIndentLines = lineRects.length;
    out.layoutHangIndentFirstLeft = lineRects.length > 0 ? Math.round(lineRects[0].left * 10) / 10 : null;
    out.layoutHangIndentLastLeft = lineRects.length > 0
      ? Math.round(lineRects[lineRects.length - 1].left * 10) / 10
      : null;
    // 行数 ≥ 2 才算真的折了行，否则这条断言是「空对空」。
    // 用户 2026-09-13 的第 ② 条：**每一行**（不只是末行）的左边界都要与首行一致（悬挂缩进）。
    out.layoutHangIndentLineLefts = lineRects.map(function (r) {
      return Math.round(r.left * 10) / 10;
    });
    out.layoutHangIndentAligned = lineRects.length >= 2 &&
      out.layoutHangIndentLineLefts.every(function (l) {
        return Math.abs(l - out.layoutHangIndentLineLefts[0]) < 1;
      });

    // ---- 头像对齐口径：**顶部与身份行对齐**（参考图），且头像比身份行**稍高**
    //      （用户 2026-09-13：「头像需要比身份簇稍微高一些，太小了看不清」）。
    //      旧口径是「垂直居中于首行盒」——两行布局下首行就是身份行，居中会让头像整体下沉，
    //      所以这里改为量**顶边**：头像列/头像图的顶边与身份行顶边一致。
    var wrapIdentityEl = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-identity"]') : null;
    var avatarColEl = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-avatar-col"]') : null;
    var wrapRowRect = rect(wrapRow);
    var avatarRect = rect(avatarColEl);
    var wrapIdentityRect = rect(wrapIdentityEl);
    var firstLine = lineRects[0];
    out.layoutAvatarTopDelta = wrapIdentityRect && avatarRect
      ? Math.round((avatarRect.top - wrapIdentityRect.top) * 10) / 10
      : null;
    out.layoutAvatarTopAlignedWithIdentity = out.layoutAvatarTopDelta !== null &&
      Math.abs(out.layoutAvatarTopDelta) < 1.5;
    // 反面对照：这一行折了好几行，头像若按「整行居中」会明显更低
    out.layoutAvatarNotRowCentered = !!firstLine && !!avatarRect && !!wrapRowRect &&
      (avatarRect.top + avatarRect.height / 2) <
        (wrapRowRect.top + wrapRowRect.height / 2) - 4;

    // ---- 头像顶边 = 身份行顶边，正文在身份行**下面**（用户 #1/#2：发表情时「错开」）
    // 量的是两条**表情弹幕**：行内表情与大表情（bulge）。旧版在这两行上分别错开 1.8px / 32px。
    var emoteRows = rows().filter(function (r) {
      return !!r.querySelector('[data-testid="db-msg-body"] img');
    });
    var firstLineTops = function (row) {
      var col = row.querySelector('[data-testid="db-msg-avatar-col"]');
      var identity = row.querySelector('[data-testid="db-msg-identity"]');
      var body = row.querySelector('[data-testid="db-msg-body"]');
      if (!col || !identity || !body) return null;
      var round = function (v) { return Math.round(v * 10) / 10; };
      return {
        avatarTop: round(rect(col).top),
        identityTop: round(rect(identity).top),
        identityBottom: round(rect(identity).bottom),
        bodyTop: round(rect(body).top)
      };
    };
    out.rowEmoteFirstLineTops = emoteRows.map(firstLineTops);
    out.rowIdentityOnFirstLineBox = emoteRows.length >= 2 && emoteRows.every(function (row) {
      var t = firstLineTops(row);
      return !!t && Math.abs(t.identityTop - t.avatarTop) < 1.5 &&
        t.bodyTop >= t.identityBottom - 0.5;
    });
    // 反面对照：大表情那一行折不了行（图是块级），头像按「行容器 flex-start + 行容器居中」会明显更低
    out.rowAvatarNotDroppedByTallEmote = emoteRows.length >= 2 && emoteRows.every(function (row) {
      var t = firstLineTops(row);
      return !!t && Math.abs(t.avatarTop - Math.min(t.avatarTop, t.bodyTop)) < 1.5;
    });

    // ---- 尺度：头像 / 身份牌 / 表情图同出一条基准（用户 #3），但**头像单独一档**
    //      （用户 2026-09-13：「头像需要比身份簇稍微高一些，太小了看不清」）：
    //      头像 = 1.25 × 行盒、身份牌 = 0.9 × 行盒（**不跟头像走**）、表情 = 1.1 × 行盒。
    var bodyForScale = byTestId("db-msg-body");
    var lineBoxPx = bodyForScale ? parseFloat(getComputedStyle(bodyForScale).lineHeight) : NaN;
    var avatarImgEl = avatarOf(withFace);
    var badgeForScale = byTestId("db-msg-badges") ? byTestId("db-msg-badges").children[0] : null;
    var emoteImgEl = emoteRows[0] ? emoteRows[0].querySelector('[data-testid="db-msg-body"] img') : null;
    var sizeOf = function (el) { return el ? Math.round(rect(el).height * 10) / 10 : null; };
    out.rowScale = {
      line: lineBoxPx,
      avatar: sizeOf(avatarImgEl),
      badge: sizeOf(badgeForScale),
      emote: sizeOf(emoteImgEl)
    };
    // 身份行的高度：身份是「用户名 + 身份牌」那一行，它的行盒就是 --row-line
    var identityForScale = byTestId("db-msg-identity");
    out.rowIdentityBoxPx = identityForScale ? Math.round(rect(identityForScale).height * 10) / 10 : null;
    out.rowScaleCoherent = !isNaN(lineBoxPx) &&
      out.rowScale.avatar !== null && out.rowScale.badge !== null && out.rowScale.emote !== null &&
      Math.abs(out.rowScale.avatar / lineBoxPx - 1.25) < 0.06 &&
      Math.abs(out.rowScale.badge / lineBoxPx - 0.9) < 0.06 &&
      Math.abs(out.rowScale.emote / lineBoxPx - 1.1) < 0.06;
    // 用户 2026-09-13 的正题：头像**比身份簇稍高**（不是等高、更不是更小），高度差 ≥ 15%
    out.rowAvatarTallerThanIdentity =
      out.rowScale.avatar !== null && out.rowIdentityBoxPx !== null &&
      out.rowScale.avatar > out.rowIdentityBoxPx &&
      out.rowScale.avatar / out.rowIdentityBoxPx >= 1.15;
    // 反面：身份牌**不**跟着头像放大（复用时它就 1.25 × 行盒了）
    out.rowBadgeNotFollowingAvatar =
      out.rowScale.badge !== null && out.rowScale.avatar !== null &&
      out.rowScale.avatar - out.rowScale.badge > 1;

    // ---- 字号滑杆联动（用户 2026-09-13：头像放大后，三种字号下都得成立）。
    //      弹幕区把 ui.font_scale 写成 scroller 上的 font-size: <scale>em（MessageList），
    //      行内尺寸全部由行盒按 em 派生，所以换三档字号量比值：头像/行盒恒 = 1.25、
    //      头像恒比身份行高 ≥ 15%。把尺寸写死成 px 的实现会在这里露出（比值随字号漂）。
    var scrollerEl = byTestId("db-chat-scroll");
    var probeAvatar = avatarOf(withFace);
    var probeIdentity = withFace ? withFace.querySelector('[data-testid="db-msg-identity"]') : null;
    var probeBody = withFace ? withFace.querySelector('[data-testid="db-msg-body"]') : null;
    var prevFontSize = scrollerEl.style.fontSize;
    var scaleProbe = [];
    // 比值记到 3 位小数：f1 那种 1 位小数会把 1.252 记成 1.3，容差就没意义了
    var f3 = function (v) { return Math.round(v * 1000) / 1000; };
    [0.85, 1, 1.6].forEach(function (scale) {
      scrollerEl.style.fontSize = scale + "em";
      var line = parseFloat(getComputedStyle(probeBody).lineHeight);
      var av = rect(probeAvatar).height;
      var idH = rect(probeIdentity).height;
      scaleProbe.push({
        scale: scale, line: f1(line), avatar: f1(av), identity: f1(idH),
        avatarPerLine: f3(av / line), avatarOverIdentity: f3(av / idH)
      });
    });
    scrollerEl.style.fontSize = prevFontSize;
    out.rowScaleProbe = scaleProbe;
    out.rowScaleFollowsFontSlider = scaleProbe.length === 3 && scaleProbe.every(function (p) {
      return Math.abs(p.avatarPerLine - 1.25) < 0.01 && p.avatarOverIdentity >= 1.15;
    });

    // ---- 昵称不吃弹幕颜色，颜色只落正文（用户 #2）
    var redRow = rowWith("红字弹幕正文");
    var redNameEl = redRow ? redRow.querySelector('[data-testid="db-msg-name"]') : null;
    var redBodyEl = redRow ? redRow.querySelector('[data-testid="db-msg-body"]') : null;
    var paintOf = function (el) {
      return el ? (el.getAttribute("style") || "") + "|" + getComputedStyle(el).color : "";
    };
    out.rowNameNotPaintedByDanmakuColor = !!redNameEl &&
      paintOf(redNameEl).indexOf("255, 0, 0") < 0 &&
      paintOf(redNameEl).indexOf("#ff0000") < 0;
    // 用户 2026-09-12：所有文本统一，正文不再照搬上游弹幕的自定义颜色
    out.rowBodyNotPaintedByDanmakuColor = !!redBodyEl &&
      paintOf(redBodyEl).indexOf("rgb(255, 0, 0)") < 0 &&
      paintOf(redBodyEl).indexOf("#ff0000") < 0;
    var whiteRow = rowWith("白字弹幕正文");
    var whiteBodyEl = whiteRow ? whiteRow.querySelector('[data-testid="db-msg-body"]') : null;
    // 16777215 是上游给普通弹幕的「白」= 未指定：不许照搬到正文（浅色主题下正文会瞎）
    out.rowDefaultWhiteTreatedAsUnset = !!whiteBodyEl &&
      (whiteBodyEl.getAttribute("style") || "") === "" &&
      getComputedStyle(whiteBodyEl).color !== "rgb(255, 255, 255)";

    // ---- 同一个颜色规则在**两种主题**下都要能读（用户报的「用户名是白色、看不见」发生在浅色主题）
    // 直接拨文档属性（app 的主题最终也落在这个属性上），量完立刻拨回去。
    var themeBefore = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "light");
    await sleep(250);
    var lightRed = rowWith("红字弹幕正文");
    var lightWhite = rowWith("白字弹幕正文");
    var lightNameColor = lightRed
      ? getComputedStyle(lightRed.querySelector('[data-testid="db-msg-name"]')).color
      : "";
    var lightBodyColor = lightRed
      ? getComputedStyle(lightRed.querySelector('[data-testid="db-msg-body"]')).color
      : "";
    var lightWhiteBodyColor = lightWhite
      ? getComputedStyle(lightWhite.querySelector('[data-testid="db-msg-body"]')).color
      : "";
    var lightPageBg = getComputedStyle(document.body).backgroundColor;
    out.rowLightNameReadable = lightNameColor.length > 0 &&
      lightNameColor !== "rgb(255, 255, 255)" && lightNameColor !== lightPageBg;
    out.rowLightBodyNotPaintedByDanmakuColor = lightBodyColor.length > 0 &&
      lightBodyColor !== "rgb(255, 0, 0)" && lightBodyColor !== lightPageBg;
    // 最强的一条：同一屏里所有正文颜色必须完全一致（用户要的是「统一」）
    var allBodyColors = Array.from(document.querySelectorAll('[data-testid="db-msg-body"]'))
      .map(function (el) { return getComputedStyle(el).color; });
    out.rowAllBodiesSameColor = allBodyColors.length >= 3 &&
      allBodyColors.every(function (c) { return c === allBodyColors[0]; });
    // ---- 同一屏里所有昵称也必须是一个颜色，且既不是上游给的自定义色、也不是白
    // （白在浅色主题里等于看不见；这两条是用户 2026-09-12 那条反馈的最强口径）
    var screenNames = Array.from(document.querySelectorAll('[data-testid="db-msg-name"]'))
      .map(function (el) { return getComputedStyle(el).color; });
    out.namesAllSameColor = screenNames.length >= 3 &&
      screenNames.every(function (c) { return c === screenNames[0]; });
    out.namesNotPaintedByCustomColor = screenNames.length >= 3 && screenNames.every(function (c) {
      return c.indexOf("255, 255, 0") < 0 && c !== "rgb(255, 255, 255)";
    });
    out.rowLightDefaultWhiteTreatedAsUnset = lightWhiteBodyColor.length > 0 &&
      lightWhiteBodyColor !== "rgb(255, 255, 255)" && lightWhiteBodyColor !== lightPageBg;
    out.rowLightColors = [lightNameColor, lightBodyColor, lightWhiteBodyColor, lightPageBg];
    if (themeBefore === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", themeBefore);
    await sleep(150);

    // ---- 行尾「⋯」删掉（用户 #5：与右键菜单重复）；房间头那一个保留
    out.rowMenuTriggerGone = rows().length > 0 && rows().every(function (r) { return !buttonWith(r, "⋯"); });
    // 房间头那个 ⋯ 现在画的是**矢量三点**（不再是文字字形，见 RoomView 里那条注释）：
    // 判据改成「按钮还在、里面有图、aria-label 说明它是更多菜单」
    out.headerMenuTriggerKept = (function () {
      var more = byTestId("db-header-more");
      return !!more && !!more.querySelector("svg") &&
        (more.getAttribute("aria-label") || "").indexOf("更多") >= 0 &&
        !buttonWith(byTestId("db-room-header"), "⋯");
    })();

    // ---- 工具行只剩三个面板入口：表情 / 短语 / 筛选（用户 #7：「最近」整条链路删掉）
    var toolLabels = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .map(function (b) { return b.innerText.trim(); });
    out.toolsPanelButtons = toolLabels;
    out.toolsOnlyThreePanels = ["表情", "短语", "筛选"].every(function (t) {
      return toolLabels.indexOf(t) >= 0;
    }) && toolLabels.indexOf("最近") < 0;

    // ---- layout 弹幕列表是唯一生长区；面板向上展开不遮挡最新弹幕
    var scroller = byTestId("db-chat-scroll");
    var before = rect(scroller);
    var headerEl = byTestId("db-room-header");
    var composerEl = document.querySelector("textarea").closest('[class*="composer"]');
    var headerBefore = rect(headerEl).height;
    var composerBefore = rect(composerEl).height;
    var newestBefore = rows()[rows().length - 1];
    out.layoutNewestVisibleBeforePanel =
      rect(newestBefore).bottom <= before.bottom + 1 && rect(newestBefore).bottom >= before.bottom - 40;
    clickTool("表情");
    await sleep(500);
    var panel = byTestId("db-panel");
    var after = rect(scroller);
    var newestAfter = rows()[rows().length - 1];
    out.layoutPanelShown = !!panel;
    // 面板内部的左右边距只有一条：面板头（搜索框所在行）、每个分区标题与表情格容器
    // 都是面板的直接子元素，左边缘必须完全一致（不然看着就是「有的顶格、有的缩进」）
    var panelChildLefts = [].slice.call(panel.children).map(function (el) {
      return Math.round(el.getBoundingClientRect().left * 10) / 10;
    });
    out.panelChildLefts = panelChildLefts;
    out.panelContentAligned = panelChildLefts.length > 0 && panelChildLefts.every(function (x) {
      return Math.abs(x - panelChildLefts[0]) < 0.6;
    });
    out.layoutPanelAboveComposer = !!panel && !!document.querySelector("textarea") &&
      (panel.compareDocumentPosition(document.querySelector("textarea")) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    out.layoutChatShrankPx = Math.round(before.height - after.height);
    // 「唯一生长区」的双向判：面板展开时只有弹幕列表变矮，头部与输入区纹丝不动
    out.layoutOnlyChatShrank =
      Math.abs(rect(headerEl).height - headerBefore) < 1 &&
      Math.abs(rect(composerEl).height - composerBefore) < 1 &&
      before.height - after.height > 50;
    out.layoutNewestNotCovered = !!newestAfter && rect(newestAfter).bottom <= rect(panel).top + 1;
    // 容器下内边距的计算值：既是「贴底时的呼吸空间」，也是下面几条断言的右值。
    // 不写死 8px：它属于排版令牌（app.module.css），RowRedesign 调它时断言自动跟着走。
    out.layoutScrollerPaddingBottomPx =
      Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    // 贴底时的呼吸空间：末行底边 ↔ 面板（= 滚动容器）顶边的间距必须 == 那个内边距
    out.layoutNewestPanelGapPx = newestAfter
      ? Math.round((rect(panel).top - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutNewestGapIsPadding = out.layoutNewestPanelGapPx !== null &&
      Math.abs(out.layoutNewestPanelGapPx - out.layoutScrollerPaddingBottomPx) <= 1;
    // 贴底时的精确几何：为什么最新一条会紧贴容器底边（而不是留出容器下内边距）？
    // scrollHeight - scrollTop - clientHeight = 0 表示已经滚到物理最大位置；
    // 若此时末行底边仍在内容块底边之下（msgListBottomGapPx 为负），说明行高溢出了虚拟高度块。
    out.layoutScrollBottomGapPx = Math.round(
      (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) * 10,
    ) / 10;
    out.layoutMsgListBottomGapPx = newestAfter
      ? Math.round((rect(byTestId("db-msg-list")).bottom - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutLastRowHeightPx = newestAfter ? Math.round(rect(newestAfter).height * 10) / 10 : null;
    out.layoutMsgListHeightPx = Math.round(rect(byTestId("db-msg-list")).height * 10) / 10;
    // 更硬的两条：视口仍在底部（跟随模式重新贴底），且渲染出的最后一行确实是最后一条消息
    // （此刻最后一条是**真实夹具里那条表情包弹幕**，所以按它的表情图 alt 认）
    out.layoutFollowingAtBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    out.layoutLastRowIsNewest = !!newestAfter &&
      [].slice.call(newestAfter.querySelectorAll('[data-testid="db-msg-body"] img'))
        .some(function (img) { return img.alt === ROW_FIXTURES.emoticon.content; });
    // ---- 表情面板 = **竖向 tab 轨道 + 表情网格**（用户 2026-09-12：「给表情的全是按钮，
    //      根本框不住表情图标，可以直接仿照官方实现」）。
    // 表情全部来自固化的真实载荷（「smoke/fixtures/emotes.json」）：通用那 38 条是 200×60 的横条、
    // 粉丝牌那 17 条是 162×162 的方图 —— 手写的 64×64 正方形永远撞不出下面这条「图比格子宽」。
    var emoteTabsOf = function () {
      return [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-tab"]'));
    };
    var emoteGroupsOf = function () {
      return [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-group"]'));
    };
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    /** 每一格：格子（按钮）与里面的图各自的盒子，以及「图有没有跑出格子」。 */
    var emoteMetrics = function () {
      return [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-item"]')).map(function (cell) {
        var box = cell.getBoundingClientRect();
        var img = cell.querySelector("img");
        var ib = img ? img.getBoundingClientRect() : null;
        var cs = img ? getComputedStyle(img) : null;
        return {
          // 「height」 一直是**图**的高度（「layoutEmoteSizes」 / 「layoutNonCommonEmoteBigger」 的旧口径），
          // 尺子换成格子会把「非通用放大档」比成格子高度，比错了东西。
          height: ib ? Math.round(ib.height) : Math.round(box.height),
          big: cell.className.indexOf("pickerItemBig") >= 0,
          cellW: r1(box.width), cellH: r1(box.height),
          imgW: ib ? r1(ib.width) : null, imgH: ib ? r1(ib.height) : null,
          // 溢出量：图越过格子四边的最大值（0 = 完整落在格子里）
          overflow: ib ? r1(Math.max(0, ib.right - box.right, ib.bottom - box.bottom,
            box.left - ib.left, box.top - ib.top)) : 0,
          // 宽高必须是 CSS 给的（「auto」 就是按原图尺寸渲染 = 200×60 会算出 5em 宽）
          explicit: !!cs && cs.width !== "auto" && cs.height !== "auto" && cs.objectFit === "contain"
        };
      });
    };
    var tabOf = function (kind) {
      return emoteTabsOf().filter(function (b) { return b.getAttribute("data-kind") === kind; })[0];
    };
    out.panelEmoteTabs = emoteTabsOf().map(function (b) { return b.innerText.trim(); });
    out.panelEmoteTabCount = emoteTabsOf().length;
    // 一屏只画一组：tab 的代价是「非通用放大档」不能在同一个快照里量，必须切过去量
    out.panelEmoteOneGroupAtATime = emoteGroupsOf().length === 1 &&
      emoteGroupsOf()[0].getAttribute("data-kind") === "common";
    out.panelEmoteTabSelectedOne = emoteTabsOf().filter(function (b) {
      return b.getAttribute("aria-selected") === "true";
    }).length === 1;

    // ---- tab 是**轨道**不是一排按钮：竖向排列、在网格左侧、选中态在视觉上分得出来
    var rail = byTestId("db-emote-tabs");
    var railBox = rect(rail);
    var tabBoxes = emoteTabsOf().map(rect);
    var gridBox = rect(byTestId("db-emote-group"));
    out.panelEmoteRailStacked = tabBoxes.length >= 3 && tabBoxes.every(function (b, i) {
      return i === 0 || b.top >= tabBoxes[i - 1].bottom - 0.5;
    }) && !!railBox && railBox.height > tabBoxes[0].height * 1.5;
    out.panelEmoteRailLeftOfGrid = !!railBox && !!gridBox && railBox.right <= gridBox.left + 1;
    out.panelEmoteTabIsRealTab = !!rail &&
      rail.getAttribute("role") === "tablist" &&
      rail.getAttribute("aria-orientation") === "vertical" &&
      emoteGroupsOf()[0].getAttribute("role") === "tabpanel" &&
      emoteTabsOf().every(function (b) {
        return b.getAttribute("role") === "tab" &&
          b.getAttribute("aria-controls") === emoteGroupsOf()[0].id;
      }) &&
      emoteGroupsOf()[0].getAttribute("aria-labelledby") === tabOf("common").id;
    // 选中态的「明确」= 计算样式真的不一样（不依赖 CSS-module 类名）
    var styleOf = function (el) {
      var cs = getComputedStyle(el);
      return [cs.backgroundColor, cs.color, cs.borderLeftColor, cs.fontWeight].join("|");
    };
    out.panelEmoteTabSelectedStyleDistinct =
      styleOf(tabOf("common")) !== styleOf(tabOf("room"));
    // 键盘可达：↑↓ 在轨道里换组，焦点跟着走（roving tabindex，WAI-ARIA tabs 口径）
    var firstTab = emoteTabsOf()[0];
    firstTab.focus();
    firstTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await sleep(250);
    var afterDown = emoteTabsOf().filter(function (b) {
      return b.getAttribute("aria-selected") === "true";
    })[0];
    out.panelEmoteTabArrowKeys = !!afterDown && afterDown.getAttribute("data-kind") === "owned" &&
      document.activeElement === afterDown &&
      emoteGroupsOf()[0].getAttribute("data-kind") === "owned" &&
      firstTab.getAttribute("tabindex") === "-1" && afterDown.getAttribute("tabindex") === "0";
    afterDown.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await sleep(250);
    var afterUp = emoteTabsOf().filter(function (b) {
      return b.getAttribute("aria-selected") === "true";
    })[0];
    out.panelEmoteTabArrowUpReturns = !!afterUp &&
      afterUp.getAttribute("data-kind") === "common" && document.activeElement === afterUp;

    var commonMetrics = emoteMetrics();
    var commonSizes = commonMetrics;
    // ---- 「上方的搜索也没必要」（用户 2026-09-12）：面板里**不再有输入框**
    out.panelNoSearch = !!panel && panel.querySelectorAll("input").length === 0;
    // ---- 「表情行数改到 3 行、按大表情的高度固定下来」（用户 2026-09-13 第 2 条）：
    //      网格区高度 = **三行大表情格** + 两道行距，**与当前是哪一组无关**（通用组同一个高度），
    //      内容超出就在网格里滚。两个数都在快照里：通用组一个、大表情组一个，再比它们相等。
    var gridEl = byTestId("db-emote-group");
    var gridStyle = getComputedStyle(gridEl);
    var rowGapOf = function (el) { return parseFloat(getComputedStyle(el).rowGap) || 0; };
    out.panelEmoteGridHeightPx = f1(rect(gridEl).height);
    // ---- 面板顶上**没有「表情」标题、也没有「关闭」**（用户 2026-09-12：两样都不需要；
    //      item 8 之后**三个面板都不带**标题与关闭，db-panel-close 钩子整个界面都不再提供）。
    //      判据分三半：① 面板里没有关闭按钮（testid 契约）；② 没有任何元素**只**写着「表情」
    //      （分组名叫「我的表情」，不是同一个字符串，不会撞上）；③ 整份文档里都没有那个钩子。
    out.panelEmoteSpace = {
      closeButtons: panel.querySelectorAll('[data-testid="db-panel-close"]').length,
      documentCloseButtons: document.querySelectorAll('[data-testid="db-panel-close"]').length,
      headlineOnly: [].slice.call(panel.querySelectorAll("*")).filter(function (el) {
        return el.children.length === 0 && el.textContent.trim() === "表情";
      }).length,
      hasCloseWord: panel.innerText.indexOf("关闭") >= 0,
    };
    out.panelEmoteHeaderGone = out.panelEmoteSpace.closeButtons === 0 &&
      out.panelEmoteSpace.headlineOnly === 0 && !out.panelEmoteSpace.hasCloseWord;
    // 关闭钩子**整个界面都不再提供**（item 8：短语与筛选面板同样没有关闭按钮）：
    // 展开中的这一个面板之外，文档里也不许别处还挂着它。
    out.panelCloseHookGone = out.panelEmoteSpace.documentCloseButtons === 0;
    // 通用组的网格高（它是**三行大表情格**，与当前是哪一组无关）：
    // 数字进快照，下面的 panelEmoteGridSameHeightForBothGroups 拿它和大表情组那个数比相等。
    var commonCellH = commonMetrics.length > 0
      ? Math.max.apply(null, commonMetrics.map(function (m) { return m.cellH; })) : 0;
    out.panelEmoteCommonCellHeightPx = f1(commonCellH);
    out.panelEmoteCommonGridHeightPx = f1(rect(gridEl).height);
    var panelPad = getComputedStyle(panel);
    out.panelHeightPx = f1(rect(panel).height);
    // 三个面板共用同一个定高（--panel-h）：这里是表情面板那一份，短语 / 筛选各自那份在
    // 打开它们的那一步量，最后比三者相等（见 panelHeightsMatch）。
    // 面板高 = 网格高 + 上下内边距（面板里除了网格没有别的行）
    out.panelEmoteHeightIsGridPlusPadding = Math.abs(rect(panel).height -
      (parseFloat(panelPad.paddingTop) + rect(gridEl).height + parseFloat(panelPad.paddingBottom))) <= 1;
    // ---- 左侧 tab 轨道**自己能上下滚**（用户 2026-09-12：「左边也加入上下滚动」），
    //      而且滚动条的槽不挤窄右边的网格（scrollbar-gutter: stable）。
    var railEl = byTestId("db-emote-tabs");
    var gridWidthBefore = rect(gridEl).width;
    out.panelEmoteRailScrollable = getComputedStyle(railEl).overflowY === "auto";
    railEl.scrollTop = railEl.scrollHeight;
    await sleep(250);
    // 「轨道自己能上下滚」= **超出时滚得动**，不是「一定要超出」：用户 2026-09-13 第 2 条把网格区
    // 从两行改到三行大表情格（152.1px）之后，5 个分组（约 140px）在宽屏下**放得下了** —— 轨道
    // 本来就不再溢出，硬要求 scrollTop > 1 等于要求「必须溢出」，那是把改前的偶然当契约。
    // 判据因此写成两支：① 内容没超出 → 不滚是正确行为；② 超出 → 必须真的滚起来。
    // 溢出量进快照（panelEmoteRailOverflowPx），下次谁再改高度，这两个数一起看。
    var railOverflowPx = railEl.scrollHeight - railEl.clientHeight;
    out.panelEmoteRailOverflowPx = railOverflowPx;
    out.panelEmoteRailScrolled = railOverflowPx > 1 ? railEl.scrollTop > 1 : true;
    out.panelEmoteRailKeepsGridWidth = Math.abs(rect(gridEl).width - gridWidthBefore) < 0.6;
    railEl.scrollTop = 0;
    await sleep(200);
    out.panelEmoteGridKind = gridEl.getAttribute("data-kind");
    out.panelEmoteGridScrollHeightPx = gridEl.scrollHeight;
    // 网格是面板里**唯一会滚的部分**（固定高度 + overflow-y: auto）；
    // 「内容真的超出」在窄屏量：38 条通用表情在 360 宽下必然塞不进两行（宽屏一行放得下就是放得下）。
    out.panelEmoteGridScrollable = gridStyle.overflowY === "auto";
    if (NARROW) {
      put("panelEmoteGridOverflows", gridEl.scrollHeight > gridEl.clientHeight + 1);
    }
    var roomTab = tabOf("room");
    if (roomTab) {
      roomTab.click();
      await sleep(300);
      out.panelEmoteTabSwitchWorks = emoteGroupsOf().length === 1 &&
        emoteGroupsOf()[0].getAttribute("data-kind") === "room";
    }
    var bigMetrics = emoteMetrics();
    var bigSizes = bigMetrics;
    var allMetrics = commonMetrics.concat(bigMetrics);
    var commonH = commonMetrics.filter(function (x) { return !x.big; })[0];
    var bigH = bigMetrics.filter(function (x) { return x.big; })[0];
    out.layoutEmoteSizes = commonSizes;
    out.layoutEmoteSizesBig = bigSizes;
    out.layoutNonCommonEmoteBigger = !!commonH && !!bigH && bigH.height >= commonH.height * 1.4;
    // ---- 网格区高度 = **三行大表情** + 两道行距（用户 2026-09-13 第 2 条）。
    //      大表情那一档的高度从**格子**量（--emote-size-big 注册成 <length>，格子与网格区
    //      因此用的是同一个绝对值；不注册的话格子会再乘一次自己的字号、差 1.3 倍）。
    var bigRowH = Math.max.apply(null, bigMetrics.map(function (m) { return m.cellH; }));
    var gridRowGap = parseFloat(getComputedStyle(gridEl).rowGap) || 0;
    out.panelEmoteBigRowHeightPx = f1(bigRowH);
    out.panelEmoteGridRowGapPx = f1(gridRowGap);
    out.panelEmoteBigGridHeightPx = f1(rect(gridEl).height);
    out.panelEmoteGridThreeBigRows = bigMetrics.length > 0 &&
      Math.abs(rect(gridEl).height - (bigRowH * 3 + gridRowGap * 2)) <= 1;
    // 两组**同一个高度**（用户 2026-09-13 第 2 条：大表情那一档的高度固定下来，通用组也用它）：
    // 换了分组面板不忽高忽低，通用组也正好看到三行大格。
    out.panelEmoteGridSameHeightForBothGroups =
      out.panelEmoteCommonGridHeightPx !== null &&
      Math.abs(out.panelEmoteCommonGridHeightPx - out.panelEmoteBigGridHeightPx) < 0.6;
    // ---- 用户报的那条：表情**溢出了格子边框**。改前实测（WebKit，360×844，通用组）：
    //      格子 47.6 × 32，图 80.7 × 24.2 → 右边越出格子 33.1px。
    //      改后：图必须完整落在格子里（溢出 0），且宽高由 CSS 显式给出（「object-fit: contain」）。
    out.panelEmoteMetrics = commonMetrics.slice(0, 3).map(function (m) {
      return { cellW: m.cellW, cellH: m.cellH, imgW: m.imgW, imgH: m.imgH };
    });
    out.panelEmoteOverflowPx = Math.max.apply(null, allMetrics.map(function (m) { return m.overflow; }));
    out.panelEmoteFitsCell = allMetrics.length > 0 && allMetrics.every(function (m) {
      return m.overflow === 0;
    });
    out.panelEmoteImgExplicitBox = allMetrics.length > 0 && allMetrics.every(function (m) {
      return m.explicit;
    });
    // 窄屏 360 下不许横向溢出：面板 / 轨道 / 网格三块都不许出现横向滚动
    out.panelNoHorizontalOverflow = (function () {
      var parts = [byTestId("db-panel"), rail, byTestId("db-emote-group")];
      return parts.every(function (el) {
        return !!el && el.scrollWidth <= el.clientWidth + 1;
      });
    })();

    // ---- 无权限的表情：置灰、但不隐藏、不禁用（用户 #6；契约 §5 Emote.locked）
    // 真实载荷里 locked 的那一组是**粉丝牌**（「UP主大表情」：17 条 「perm」 全为 0），
    // 对照组用「本房间」那 10 条（「perm = 1」）——两族都是 162×162 的大表情，比尺寸才公平。
    var medalGroup = EMOTES.live.filter(function (e) { return e.package_kind === "medal"; });
    var medalText = medalGroup[0].text;
    var medalUnique = medalGroup[0].emoticon_unique;
    var lockedImgH = null;
    var lockedCount = 0;
    var medalTab = tabOf("medal");
    if (medalTab) {
      medalTab.click();
      await sleep(300);
      var lockedItems = [].slice.call(byTestId("db-panel")
        .querySelectorAll('[data-testid="db-emote-item"][data-locked="true"]'));
      lockedCount = lockedItems.length;
      out.panelLockedEmoteListed = lockedItems.length === 17;
      out.panelLockedEmoteDimmed = lockedItems.length > 0 && lockedItems.every(function (el) {
        var cs = getComputedStyle(el);
        return parseFloat(cs.opacity) < 0.8 && cs.filter.indexOf("grayscale") >= 0;
      });
      // 尺寸要在**这一组还挂在文档里**的时候量：切走之后 React 会把它们卸载，脱链元素的 rect 全是 0
      lockedImgH = lockedItems.length > 0 ? rect(lockedItems[0].querySelector("img")).height : null;
      // 置灰是提示不是闸门：照样点得动、照样**直接发出去**（真正拦的是上游发送侧）。
      // 判据取 chat_send 的载荷：emoticon_unique 就是点中的那一个。
      lockedItems[0].click();
      await sleep(350);
      var lockedSends = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
      var lockedSend = lockedSends[lockedSends.length - 1];
      var stillMedal = medalTab.getAttribute("aria-selected") === "true";
      out.panelLockedEmoteSelectable = !!lockedSend && !!lockedSend.args.emote &&
        lockedSend.args.emote.emoticon_unique === medalUnique &&
        lockedSend.args.content === medalText && stillMedal &&
        document.querySelector("textarea").value === "";
    }
    // 对照：可用的那一组（本房间 10 条 「perm = 1」）不灰、尺寸与灰的那组一样
    // （「字段缺失的 perm 视为可用」那一条由 「crates/danmubox-bili/src/emote.rs」 的单测覆盖，
    //  界面这一侧只消费 「locked」 布尔值）。
    if (roomTab) {
      roomTab.click();
      await sleep(300);
      var freeItems = [].slice.call(byTestId("db-panel")
        .querySelectorAll('[data-testid="db-emote-item"][data-locked="false"]'));
      out.panelUnlockedEmoteNotDimmed = freeItems.length === 10 && freeItems.every(function (el) {
        return parseFloat(getComputedStyle(el).opacity) >= 0.99;
      });
      out.panelLockedEmoteSameSize = lockedCount > 0 && lockedImgH !== null && freeItems.length > 0 &&
        Math.abs(lockedImgH - rect(freeItems[0].querySelector("img")).height) < 0.6;
      if (tabOf("common")) {
        tabOf("common").click();
        await sleep(200);
      }
    }
    // 面板还开着就先把快照写进去、并多停 1.5s：跑脚本的进程据此抓一张「面板已展开」的截图
    snap();
    await sleep(1500);
    // 面板在**两个视口**都是文档流里的一块（不是浮层）——「只挤列表、不遮最新一条」
    // 由上面的 layoutOnlyChatShrank / layoutNewestNotCovered 按同一口径断言。
    out.panelInline = getComputedStyle(panel).position !== "fixed";

    // ---- 切 tab **不许**把面板关掉（用户 2026-09-13 报的真 bug：「展开表情包面板后切换 tab，
    //      面板就自动关闭了」）。这是本批新增的「点输入区外面收起面板」监听把它自己踩了：
    //      面板与输入区是**兄弟**节点，只判输入区就会把面板内部的按下当成外面。
    //      复现必须补一次真实的「pointerdown」—— 「.click()」只发 click 事件、绕过那条监听，
    //      这正是它当初没被测出来的原因（真鼠标点 tab 一定先有 pointerdown）。
    var pressLike = function (el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.click();
    };
    var pressedOnly = function (el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    };
    var selectedKind = function () {
      var hit = [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-tab"]'))
        .filter(function (b) { return b.getAttribute("aria-selected") === "true"; })[0];
      return hit ? hit.getAttribute("data-kind") : null;
    };
    // ① 切 tab：面板还在，且选中的那一组确实换了（两条一起判，缺一条都可能是假通过）
    var tabBefore = selectedKind();
    var tabTarget = tabOf(tabBefore === "room" ? "medal" : "room");
    var targetKind = tabTarget.getAttribute("data-kind");
    pressLike(tabTarget);
    await sleep(350);
    out.panelSurvivesTabSwitch = !!byTestId("db-panel") &&
      !!document.getElementById("db-emote-panel") &&
      selectedKind() === targetKind && targetKind !== tabBefore;
    // ② 面板内部**其它**按下（滚 tab 轨道、按表情格）也不关
    pressedOnly(byTestId("db-emote-tabs"));
    var emotePanelEl = document.getElementById("db-emote-panel");
    var firstCell = emotePanelEl
      ? emotePanelEl.querySelector('[data-testid="db-emote-item"]') : null;
    if (firstCell) pressedOnly(firstCell);
    await sleep(250);
    out.panelStaysOnInsidePress = !!byTestId("db-panel") && selectedKind() === targetKind;
    // ③ 点输入区**外面**（弹幕列表）仍然关 —— 收窄的是「哪里算外面」，不是「还能不能关」
    pressedOnly(byTestId("db-chat-scroll"));
    await sleep(350);
    out.panelClosesOnChatPress = !byTestId("db-panel");
    clickTool("表情");
    await sleep(450);
    out.panelReopensAfterOutsidePress = !!byTestId("db-panel") &&
      selectedKind() === targetKind;
    // 复原到「通用」组：后面的表情格度量与它前面的口径一致
    if (tabOf("common")) pressLike(tabOf("common"));
    await sleep(300);
    out.panelBackOnCommon = selectedKind() === "common";

    clickTool("表情");
    await sleep(300);

    // ---- 面板展开 → 收起一轮之后，「跟随最新」必须还活着
    // 修复前：收起面板会让容器变高、可滚区间变大，onScroll 只看几何就把 following 判成 false，
    // 于是列表停在半路、最新一条被推出视口，界面上只剩「回到最新」按钮在提示。
    // 判据取两条：几何上仍贴底（bottomGap < 8），且 UI 自己说的状态按钮不出现
    // （db-bottom-anchor 只在 !following 时渲染，是 following 的对外可观察面）。
    out.layoutFollowingAfterPanelToggle = bottomGap(byTestId("db-chat-scroll")) < 8;
    out.layoutNoJumpButtonAfterPanelToggle = !byTestId("db-bottom-anchor");
    // 面板收起后，列表下面是输入区：同一口径再量一次（末行底边 ↔ 输入区顶边 == 容器下内边距）
    var afterCloseScroller = byTestId("db-chat-scroll");
    var afterCloseBox = rect(afterCloseScroller);
    var afterCloseRows = rows().filter(function (r) {
      var box = rect(r);
      return box.bottom <= afterCloseBox.bottom + 1 && box.top >= afterCloseBox.top - 1;
    });
    var afterCloseLast = afterCloseRows[afterCloseRows.length - 1] || null;
    out.layoutNewestGapNoPanelPx = afterCloseLast
      ? Math.round((rect(document.querySelector("textarea").parentElement).top -
          rect(afterCloseLast).bottom) * 10) / 10
      : null;
    out.layoutNewestGapIsPaddingNoPanel = out.layoutNewestGapNoPanelPx !== null &&
      Math.abs(out.layoutNewestGapNoPanelPx - out.layoutScrollerPaddingBottomPx) <= 1;

    // ---- 面板形态（窄屏）：限高（视口份额）+ 内容超出时**面板内部**滚动 + 关闭入口 + 热区 ≥ 40px，
    //      同时列表仍要剩下可观的高度（不遮最新一条，也不把列表挤成一条缝）
    if (NARROW) {
      clickTool("表情");
      await sleep(400);
      var narrowPanel = byTestId("db-panel");
      var narrowPanelRect = rect(narrowPanel);
      var narrowScrollerRect = rect(byTestId("db-chat-scroll"));
      var narrowNewest = rows()[rows().length - 1];
      put("panelInFlow", getComputedStyle(narrowPanel).position !== "fixed");
      put("panelHeightPx", Math.round(narrowPanelRect.height));
      put("panelCappedToViewportShare", narrowPanelRect.height <= window.innerHeight * 0.5 + 1);
      // 会滚的是**面板内部的那一块**（表情格）：面板整体不滚，所以面板头与分组 tab 常驻。
      // 这个字段的意思没变——「内容超出在面板内部滚动，不去吃列表空间」——只是换了量哪个元素。
      var narrowGrid = byTestId("db-emote-group");
      put("panelScrollsInternally", !!narrowGrid &&
        getComputedStyle(narrowGrid).overflowY === "auto" &&
        narrowGrid.scrollHeight > narrowGrid.clientHeight + 1);
      // 分组 tab 不许被表情格滚走（用户 #6：tab 是切组的唯一入口）
      var tabsBoxBefore = rect(byTestId("db-emote-tabs"));
      if (narrowGrid) {
        narrowGrid.scrollTop = narrowGrid.scrollHeight;
        await sleep(250);
      }
      var tabsBoxAfter = rect(byTestId("db-emote-tabs"));
      put("panelTabsStayVisible", !!tabsBoxBefore && !!tabsBoxAfter &&
        Math.abs(tabsBoxAfter.top - tabsBoxBefore.top) < 1 &&
        tabsBoxAfter.top >= narrowPanelRect.top - 1 &&
        tabsBoxAfter.bottom <= narrowPanelRect.bottom + 1);
      if (narrowGrid) {
        narrowGrid.scrollTop = 0;
        await sleep(150);
      }
      put("panelListStillTall", narrowScrollerRect.height >= 240);
      put("panelListHeightPx", Math.round(narrowScrollerRect.height));
      put("panelRowHeightPx", rows().length > 1
        ? Math.round((rect(rows()[1]).top - rect(rows()[0]).top) * 10) / 10
        : null);
      put("panelNewestNotCovered", !!narrowNewest &&
        rect(narrowNewest).bottom <= narrowPanelRect.top + 1);
      var narrowHotspots = shortHotspots(narrowPanel);
      put("panelHotspotsBad", narrowHotspots);
      put("panelHotspotsAtLeast40", narrowHotspots.length === 0);
      // 关面板的两条路（用户 2026-09-12：顶上不再有「关闭」）：① 再点一次「表情」；
      // ② 点输入区**外面**的任何地方（Composer 的 pointerdown 监听）。
      clickTool("表情");
      await sleep(300);
      put("panelClosesOnToolToggle", !byTestId("db-panel"));
      clickTool("表情");
      await sleep(300);
      put("panelReopenWorks", !!byTestId("db-panel"));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
      put("panelClosesOnOutsideClick", !byTestId("db-panel"));
    }

    // ---- 发送失败 = **浮动提示**（用户 2026-09-12：「发送失败也不要在最下出提示，弹窗提示
    //      然后渐隐消失（这个过程不要挡住滚动的弹幕）即可」）。四条一起量：
    //      ① 最下方**没有**常驻提示行；② 浮片在且 pointer-events 为 none（弹幕照常滚、照常点）；
    //      ③ 浮片的矩形与弹幕列表区域**不相交**（这才是「不挡弹幕」的可验形式）；
    //      ④ 渐隐之后元素被摘掉（不是「透明地占着位置」）。
    window.__setSendOutcome("failed", "上游拒绝：弹幕被吞");
    // 回执先**扣住**：这一步要看的正是「上游还没回的」那一瞬间 —— 那条行此时必须与已确认行
    // 一模一样（无标记、无弱化），失败标记只允许在回执明确说没发出去之后才出现。
    window.__holdSend();
    typeIntoArea(document.querySelector("textarea"), "这条会发失败");
    await sleep(250);
    var sendButton = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .filter(function (b) { return b.innerText.trim() === "发送"; })[0];
    if (sendButton) sendButton.click();
    await sleep(250);
    var heldFailRow = rowWith("这条会发失败");
    out.sendFailRowNoMarkBeforeOutcome = !!heldFailRow &&
      !heldFailRow.querySelector('[data-testid="db-msg-send-state"]');
    // 用户 2026-09-13：「发出去就是和已发送一样的状态」—— 回执没回之前那一行不许有任何弱化
    // （被删掉的那档弱化是 opacity: .6，这里逐位钉回 1）。
    out.sendFailRowNoFadeBeforeOutcome = !!heldFailRow &&
      getComputedStyle(heldFailRow).opacity === "1";
    window.__releaseSend();
    await sleep(500);
    var toastEl = byTestId("db-toast");
    var toastBox = rect(toastEl);
    var chatBoxForToast = rect(byTestId("db-chat-scroll"));
    out.sendFailNoBottomHint = !byTestId("db-send-hint");
    out.sendFailToastShown = !!toastEl && toastEl.innerText.indexOf("发送失败") >= 0;
    out.sendFailToastText = toastEl ? toastEl.innerText : null;
    out.sendFailToastPassive = !!toastEl &&
      getComputedStyle(toastEl).pointerEvents === "none";
    out.sendFailToastClearsList = !!toastEl && !!chatBoxForToast &&
      !(toastBox.bottom > chatBoxForToast.top + 1 && toastBox.top < chatBoxForToast.bottom - 1 &&
        toastBox.right > chatBoxForToast.left + 1 && toastBox.left < chatBoxForToast.right - 1);
    out.sendFailToastAboveComposer = !!toastEl &&
      toastBox.bottom <= rect(document.querySelector("textarea")).top + 1;
    // 失败修正（用户 2026-09-13）：上游说没发出去时，**那一条本地行**要就地标成失败，
    // 而既有的浮动提示一并保留（提示是用户此前明确要求的，不许为了加行标记把它删掉）。
    var failRow = rowWith("这条会发失败");
    var failMark = failRow
      ? failRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    // 被拒的那条**留在列表里**（用户 2026-09-13：「那行消失我希望能得到保留，划线并标注一下被 ban
    // 的原因，便于我对照修改」），行尾那枚标记写的是**原因**（与浮片同一句，见 sendOutcomeText）。
    out.sendFailRowMarked = !!failMark &&
      failMark.getAttribute("data-state") === "rejected" &&
      failMark.innerText.indexOf("上游拒绝：弹幕被吞") >= 0;
    out.sendFailRowReason = failMark ? failMark.innerText : null;
    // 行上那句话与浮片上那句话**必须逐字相同**：两处说的是同一件事，不许各自表述。
    out.sendFailRowReasonMatchesToast = !!failMark && !!toastEl &&
      failMark.innerText === toastEl.innerText;
    // 正文划线（.rejectedText 的 line-through）：这是「对照着改」的锚点。
    var failBody = failRow ? failRow.querySelector('[data-testid="db-msg-body"] span') : null;
    out.sendFailRowStruckThrough = !!failBody &&
      getComputedStyle(failBody).textDecorationLine.indexOf("line-through") >= 0;
    // 但整行**不弱化**：划掉的是那条弹幕，不是「把整行淡化到看不清」。
    out.sendFailRowNotFaded = !!failRow && getComputedStyle(failRow).opacity === "1";
    // 被拒的那条**只有一条**：标被拒不是「再插一条」。
    out.sendFailRowSingle = rows().filter(function (r) {
      return r.innerText.indexOf("这条会发失败") >= 0;
    }).length === 1;
    out.sendFailRowMarkedWithToast = out.sendFailRowMarked && out.sendFailToastShown === true;
    // 草稿留着：被拒之后要能照着行上划掉的正文 + 原因自己改一条再发（用户 2026-09-13：
    // 「便于我对照修改」）—— 发出去（outcome 为 ok）才清空。
    out.sendFailKeepsDraft = document.querySelector("textarea").value === "这条会发失败";
    // **被吞写明理由**（用户 2026-09-13：「被吞写明理由，如 发送失败 · 全局屏蔽词 /
    //  发送失败 · 房间屏蔽词」）：两档各发一条，行尾标记必须把那句话写出来
    // （上游只给 f / k 一个标记，「是哪一份词库」由界面说清）。
    // 放在草稿那条断言**之后**：这两次发送会把草稿清空，插在前面会把上面那条弄红。
    window.__setSendOutcome("blocked_platform", "msg=f");
    typeIntoArea(document.querySelector("textarea"), "被平台吞的样本");
    await sleep(200);
    sendButton.click();
    await sleep(400);
    var blockedRow = rowWith("被平台吞的样本");
    var blockedMark = blockedRow
      ? blockedRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.blockedRowNamesGlobalWords = !!blockedMark &&
      blockedMark.innerText.indexOf("发送失败 · 全局屏蔽词") >= 0;
    window.__setSendOutcome("blocked_room", "msg=k");
    typeIntoArea(document.querySelector("textarea"), "被房间吞的样本");
    await sleep(200);
    sendButton.click();
    await sleep(400);
    var roomBlockedRow = rowWith("被房间吞的样本");
    var roomBlockedMark = roomBlockedRow
      ? roomBlockedRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.blockedRowNamesRoomWords = !!roomBlockedMark &&
      roomBlockedMark.innerText.indexOf("发送失败 · 房间屏蔽词") >= 0;
    typeIntoArea(document.querySelector("textarea"), "");
    window.__setSendOutcome("ok", null);
    await sleep(200);
    snap();
    await sleep(3200);
    out.sendFailToastGone = !byTestId("db-toast");
    typeIntoArea(document.querySelector("textarea"), "");
    window.__setSendOutcome("ok", null);
    await sleep(200);
    snap();

    // ---- 乐观渲染 + 回执校验（用户 2026-09-13：「发送应该即刻响应，上游只校验发送成功与否，
    //      无论成功与否我都是发了；失败再修正弹幕状态」；同一天再更正：「我不需要发送中这个状态，
    //      发出去就是和已发送一样的状态，上游返回的数据只做校验」）。四步各自取证：
    //      ① 点击后**本地那条立刻在列表里**（量「点击 → 行出现」的毫秒数；改前要等上游回推 ≈1.36s）；
    //      ② 这条行与**已确认行渲染逐项相同** —— 不透明度 / 行、昵称、正文的字色 / 字号逐项相等，
    //         且两边都没有修正标记（本次要钉的契约：不许有「发送中」那类待确认视觉）；
    //      ③ 上游把自己那条回推回来 → 本地那条**转正**：仍然只有一条，且各项与普通行无差别；
    //      ④ 「转正」是**换掉**不是「再插一条」——总量也不许多出来。
    // 对照行：先显式推一条**上游来的、本人的**弹幕（uid 与本地行相同、走的是同一条渲染路径），
    // 它就是「已确认行」的样本；下面拿它与点击后插进来的那条逐项比对。
    var confirmedText = "已确认对照行";
    window.__emit("danmubox://message", window.__mk("danmaku", confirmedText, false, {
      uid: 1000, uname: "本地测试"
    }));
    await sleep(300);
    var optimisticText = "乐观渲染样本弹幕";
    var optimisticRow = function () { return rowWith(optimisticText); };
    var optimisticRowCount = function () {
      return rows().filter(function (r) { return r.innerText.indexOf(optimisticText) >= 0; }).length;
    };
    typeIntoArea(document.querySelector("textarea"), optimisticText);
    await sleep(200);
    var optimisticT0 = performance.now();
    sendButton.click();
    var optimisticAppearMs = null;
    for (var optimisticTry = 0; optimisticTry < 60 && optimisticAppearMs === null; optimisticTry += 1) {
      if (optimisticRow()) optimisticAppearMs = performance.now() - optimisticT0;
      else await sleep(8);
    }
    out.sendOptimisticAppearMs = optimisticAppearMs === null
      ? null : Math.round(optimisticAppearMs * 10) / 10;
    // 「立刻」的判据取 250ms 这个宽松档（含一帧渲染 + WebKit 的抖动）：改前实测是 1820ms，
    // 两者差一个数量级，所以这个阈值能拦住「又回去等上游回播」的退步。
    out.sendOptimisticAppearsImmediately = optimisticAppearMs !== null && optimisticAppearMs <= 250;
    // **按正文数行**，不按渲染行数：虚拟列表的渲染窗口是定长的（可视 + overscan），
    // 在末尾插一行时「渲染出来的行数」可能一个都不变（窗口上沿丢一行、下沿进一行），
    // 拿它当「插了几条」的判据会假失败。
    out.sendOptimisticRowsBeforeEcho = optimisticRowCount();
    out.sendOptimisticSingleRow = optimisticRowCount() === 1;
    var optimisticEl = optimisticRow();
    // 「与已确认行渲染逐项相同」的可验形式：取**同一组计算样式**逐项比对，并各自确认
    // 没有修正标记。两条都是本人（uid 1000）的 danmaku 行（同 kind、同身份来源），
    // 这一组值本就该等价；任何「待确认」弱化（不透明度 / 字色 / 字号）或标记都会当场露出来。
    var lookOf = function (el) {
      if (!el) return null;
      var nameEl = el.querySelector('[data-testid="db-msg-name"]');
      var bodyEl = el.querySelector('[data-testid="db-msg-body"]');
      var rowStyle = getComputedStyle(el);
      return {
        opacity: rowStyle.opacity,
        color: rowStyle.color,
        fontSize: rowStyle.fontSize,
        nameColor: nameEl ? getComputedStyle(nameEl).color : null,
        bodyColor: bodyEl ? getComputedStyle(bodyEl).color : null,
        hasState: !!el.querySelector('[data-testid="db-msg-send-state"]')
      };
    };
    out.sendOptimisticLook = lookOf(optimisticEl);
    out.sendOptimisticConfirmedLook = lookOf(rowWith(confirmedText));
    out.sendOptimisticRendersLikeConfirmed = !!optimisticEl &&
      out.sendOptimisticConfirmedLook !== null &&
      JSON.stringify(out.sendOptimisticLook) === JSON.stringify(out.sendOptimisticConfirmedLook) &&
      out.sendOptimisticLook.hasState === false;
    // **第一帧就带头像**（用户 2026-09-13：「含身份牌 / 等级 / 头像 / 表情 / 间距等上游行会显示的
    // 一切」）：插入的那一行必须已经有头像图。改前它不带 face，头像要等回播换上来才出现 ——
    // 那就是用户看见的那次「修正」。（这里只钉「有头像」，不比 URL：那份 URL 属于当前账号。）
    var optimisticAvatar = optimisticEl
      ? optimisticEl.querySelector('[data-testid="db-msg-avatar"]') : null;
    out.sendOptimisticHasFace = !!optimisticAvatar &&
      (optimisticAvatar.getAttribute("src") || "").length > 0;
    // 停下让跑脚本的进程抓一张截图：同一屏里上下两条（刚发的 + 已确认的）外观应当一致，
    // 这张图就是「两者无法区分」的证据（它每 250ms 读一次 data-smoke）。
    out.sendOptimisticShown = out.sendOptimisticRendersLikeConfirmed;
    snap();
    await sleep(700);
    // 上游把自己那条回播回来（uid 与正文对得上，见 store.matchPending 的对账规则）。
    // **故意带一张不同的头像**：本地行插入时的头像取自当前账号（Account.face，取自 nav），回播那条带的是
    // 上游权威值 —— 换进来才算「我用别的客户端看到的样子」。真机上两者是同一张图（都是我的头像），
    // 所以看不出变化；这里用一张不同的，证明字段确实换进来了（而不是被忽略）。
    var echoFace =
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%23e05b7a'/></svg>";
    window.__emit("danmubox://message", window.__mk("danmaku", optimisticText, false, {
      uid: 1000, uname: "本地测试", face: echoFace
    }));
    await sleep(300);
    var convertedRow = optimisticRow();
    out.sendOptimisticRowsAfterEcho = optimisticRowCount();
    out.sendOptimisticEchoSingleRow = optimisticRowCount() === 1;
    // 「看不出有回播」的可验形式（用户 2026-09-13：「那个时候根本看不出来有回播，只知道如果被 ban 了
    // 那个弹幕会消失然后弹个提示」），分三件量：
    // ① **同一个 DOM 节点**：回播前取的句柄 === 回播后按正文重新查到的那个（节点没被重建）；
    // ② **样式逐项不变**：lookOf 快照与回播前那一次相等（不是「与对照行相同」）；
    // ③ **字段换成上游的**：头像 src 变成回播那条给的那张。
    // ①②保证「不重建、不闪」，③保证「以上游为准」—— 两件事必须同时成立，缺一个都不算对。
    out.sendOptimisticEchoSameNode = !!optimisticEl && optimisticEl === convertedRow &&
      optimisticEl.isConnected === true;
    out.sendOptimisticEchoLookUnchanged = !!convertedRow &&
      JSON.stringify(lookOf(convertedRow)) === JSON.stringify(out.sendOptimisticLook);
    var echoAvatar = convertedRow
      ? convertedRow.querySelector('[data-testid="db-msg-avatar"]') : null;
    out.sendOptimisticEchoAdoptsFace = !!echoAvatar &&
      echoAvatar.getAttribute("src") === echoFace;
    // 回播后：状态标记没了（这条已经是上游的事实），昵称/正文以远端那条为准。
    out.sendOptimisticEchoConverted = !!convertedRow &&
      !convertedRow.querySelector('[data-testid="db-msg-send-state"]') &&
      convertedRow.innerText.indexOf("本地测试") >= 0;
    // 本地那一条**留在原位**而不是又插一条：同一正文的行数回播前后都是 1（不是 2），
    // 而且它身上不再挂标记（字段已经换成上游那条）。
    out.sendOptimisticEchoAbsorbedLocal = optimisticRowCount() === 1 && !!convertedRow &&
      !convertedRow.querySelector('[data-testid="db-msg-send-state"]');
    // 换过字段的那条与**已确认行**同样逐项相同（它现在就是上游那条的字段 + 本地那个 key）。
    var echoLook = lookOf(convertedRow);
    var confirmedLookAfterEcho = lookOf(rowWith(confirmedText));
    out.sendOptimisticEchoRendersLikeConfirmed = !!echoLook && !!confirmedLookAfterEcho &&
      JSON.stringify(echoLook) === JSON.stringify(confirmedLookAfterEcho);
    typeIntoArea(document.querySelector("textarea"), "");
    snap();

    // ---- 粉丝牌只在**佩戴着 / 亮着**时才画（用户 2026-09-13：「还是有区别，刚发出去会有一个
    //      1级本直播间粉丝牌，但是不应该有才对」）。官方判据（2026-09-13 读官方前端产物取证）：
    //      弹幕侧看 medal.is_light（官方分支 if (F?.is_lighted) { 追加粉丝牌 }），
    //      身份侧看 data.medal.is_weared —— **持有 ≠ 佩戴**，没戴就不画。
    // 这块整体包一层：里面一次发送 / 一次身份事件出岔子时要**让断言红**，而不是把整个场景
    // 卡到 300s（那样只能看到「未跑完」这一句、定位不到原因）。异常文本一并进快照。
    var medalBlockOk = false;
    try {
    //      ① 上游行：同一正文、同一牌名，只差 medal_lit 一个布尔，看画不画。
    window.__emit("danmubox://message", window.__mk("danmaku", "没点亮的牌样本", false, {
      uname: "灰牌观众", medal_level: 7, medal_name: "本房间牌", medal_lit: false
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "亮着的牌样本", false, {
      uname: "亮牌观众", medal_level: 7, medal_name: "本房间牌", medal_lit: true
    }));
    await sleep(300);
    var unlitRow = rowWith("没点亮的牌样本");
    var litRow = rowWith("亮着的牌样本");
    out.medalHiddenWhenNotLit = !!unlitRow &&
      !unlitRow.querySelector('[data-testid="db-msg-badges"]');
    out.medalShownWhenLit = !!litRow &&
      !!litRow.querySelector('[data-testid="db-msg-badges"]') &&
      litRow.innerText.indexOf("本房间牌") >= 0;
    //      ② 本地乐观行：身份说「持有 Lv1 但没佩戴」→ 一行里**不许**出现牌；
    //         改成「佩戴」后同一条路径必须画出来（正面对照，防止过滤过头）。
    window.__setSendOutcome("ok", null);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 1, my_medal_name: "本房间牌",
      my_medal_worn: false, my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(200);
    typeIntoArea(document.querySelector("textarea"), "持有但没戴牌");
    await sleep(150);
    sendButton.click();
    await sleep(250);
    var unwornLocal = rowWith("持有但没戴牌");
    out.sendLocalHidesUnwornMedal = !!unwornLocal &&
      !unwornLocal.querySelector('[data-testid="db-msg-badges"]');
    typeIntoArea(document.querySelector("textarea"), "");
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 1, my_medal_name: "本房间牌",
      my_medal_worn: true, my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(200);
    typeIntoArea(document.querySelector("textarea"), "戴着牌发的");
    await sleep(150);
    sendButton.click();
    await sleep(250);
    var wornLocal = rowWith("戴着牌发的");
    out.sendLocalShowsWornMedal = !!wornLocal &&
      !!wornLocal.querySelector('[data-testid="db-msg-badges"]') &&
      wornLocal.innerText.indexOf("本房间牌") >= 0;
    typeIntoArea(document.querySelector("textarea"), "");
      medalBlockOk = true;
    } catch (e) {
      out.medalBlockError = String((e && e.stack) || e);
    }
    out.medalBlockRan = medalBlockOk;
    snap();

    // ---- 面板展开会改可视高度：**正在看的位置不能被弹走**
    // 先把列表停在中间（此时不在底部 = 非跟随模式），再展开面板，量同一个行在视口里的
    // 位置变化。跟随模式下重新贴底是**有意**的（见 MessageList 的 ResizeObserver），
    // 所以这里量的是「用户自己滚上去看历史」时的行为。
    var stableScroll = byTestId("db-chat-scroll");
    // 先等列表**静止**：进场行的自动摘除会少掉一行，上面少一行会把下面整体顶上去整整一行高
    // （实测 29px）——那是「自动消失」的既定行为，不是面板把视口弹走了。判据必须用
    // 「发出时刻 + 8s」这个时钟，**不能**用「列表里还在不在那一行」：列表这会儿滚在中间，
    // 那一行根本不在渲染窗口里，rowWith 看不见它，等它等于没等。
    var settleWait = (window.__interactAt || 0) + 8000 + 250 - Date.now();
    if (settleWait > 0) await sleep(settleWait);
    await sleep(400);
    stableScroll.scrollTop = Math.round((stableScroll.scrollHeight - stableScroll.clientHeight) * 0.55);
    await sleep(300);
    out.layoutPausedBeforePanel = stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight > 8;
    // 另一半：**用户自己往上滚**必须真的降为「不跟随」——判据同样是状态按钮出现
    out.layoutPausedShowsJumpButton = !!byTestId("db-bottom-anchor");
    // ---- item 1 + issue #2：「回到最新」那枚图标是**下箭头**，与房间头返回键**同源几何**
    //      （docs/ui.md §3.1 的矢量规范 + §7.4）：同一个 24 × 24 viewBox、同一条 stroke-width 1.75、
    //      round 线帽 / 接合、墨迹居中 (12,12)、主轴 16 单位；箭头朝下 ⇒ 宽 > 高。
    //      issue #2 之后它是一枚**圆形图标钮**（与返回键共用 .ctlRound / .ctlIcon）：可见文字
    //      一个都没有 ⇒ 可访问名只能由 aria-label / title 给（innerText 必须为空）。
    var anchorBtn = byTestId("db-bottom-anchor");
    var anchorSvg = anchorBtn ? anchorBtn.querySelector("svg") : null;
    out.jumpIconSvgShown = !!anchorSvg;
    out.jumpIconAriaHidden = !!anchorSvg && anchorSvg.getAttribute("aria-hidden") === "true";
    out.jumpButtonAccessibleName = anchorBtn ? (anchorBtn.getAttribute("aria-label") || "") : null;
    out.jumpButtonNamesPurpose = !!anchorBtn &&
      out.jumpButtonAccessibleName.indexOf("回到最新") >= 0 &&
      (anchorBtn.getAttribute("title") || "") === out.jumpButtonAccessibleName;
    out.jumpButtonHasNoText = !!anchorBtn && anchorBtn.innerText.trim() === "";
    // 与返回键**同尺寸**：控件都 40 × 40 正圆，图标盒都 24
    out.jumpControlSameSizeAsBack = !!anchorBtn && !!roundCtl[0] && !!anchorSvg &&
      !!out.iconBack &&
      Math.abs(rect(anchorBtn).width - rect(roundCtl[0]).width) < 0.6 &&
      Math.abs(rect(anchorBtn).width - 40) < 0.6 &&
      Math.abs(rect(anchorSvg).width - out.iconBack.boxPx) < 0.6;
    out.jumpIcon = iconGeomOf(anchorBtn);
    out.jumpIconInkCentered = !!out.jumpIcon &&
      Math.abs(out.jumpIcon.inkCenterX - 12) < 0.2 && Math.abs(out.jumpIcon.inkCenterY - 12) < 0.2;
    out.jumpIconSameViewBox = !!out.jumpIcon && out.jumpIcon.viewBox === "0 0 24 24";
    out.jumpIconBackArrowExtent = !!out.jumpIcon &&
      Math.abs(Math.max(out.jumpIcon.inkW, out.jumpIcon.inkH) - 16) < 0.2;
    out.jumpIconPointsDown = !!out.jumpIcon && out.jumpIcon.inkW > out.jumpIcon.inkH;
    // 与返回键量到的**同一套规范**逐项相同：描边宽度 / 线帽 / 接合 / 形状数（只有朝向不同）。
    // issue #2 之后两枚的渲染盒也一样（都 24），但描边仍比**用户单位**（SVG 里写死的数），
    // 缩放系数不算规范的一部分 —— 同一套规范因此不该被盒子的换算方式带偏。
    out.jumpIconStrokeUnits = out.jumpIcon
      ? Math.round((out.jumpIcon.inkThicknessPx / out.jumpIcon.scale) * 100) / 100
      : null;
    out.jumpIconSameStrokeAsBack = out.jumpIconStrokeUnits !== null &&
      Math.abs(out.jumpIconStrokeUnits - 1.75) < 0.01 && !!out.iconBack &&
      Math.abs(out.iconBack.inkThicknessPx / out.iconBack.scale - out.jumpIconStrokeUnits) < 0.01 &&
      out.jumpIcon.linecap === "round" && out.jumpIcon.linejoin === "round" &&
      out.jumpIcon.shapeCount === 1;
    var anchorRow = rows()[4];
    var anchorTopBefore = anchorRow ? Math.round(rect(anchorRow).top * 10) / 10 : null;
    clickTool("表情");
    await sleep(600);
    var anchorTopAfter = anchorRow && anchorRow.isConnected
      ? Math.round(rect(anchorRow).top * 10) / 10
      : null;
    out.layoutPanelScrollStablePx = anchorTopBefore !== null && anchorTopAfter !== null
      ? Math.round((anchorTopAfter - anchorTopBefore) * 10) / 10
      : null;
    out.layoutPanelScrollStable = out.layoutPausedBeforePanel &&
      out.layoutPanelScrollStablePx !== null && Math.abs(out.layoutPanelScrollStablePx) < 8;
    clickTool("表情");
    await sleep(200);
    // 还原成「跟随最新」，后面的断言依赖它
    stableScroll.scrollTop = stableScroll.scrollHeight;
    await sleep(500);
    out.layoutStabilityRestored =
      stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight < 8;
    out.layoutJumpButtonGoneAfterRestore = !byTestId("db-bottom-anchor");

    // ---- emotes 主站「我的表情」：分组可见、选得到、发出去带的是唯一键（issue #8）
    out.emotesOwnedCalled = calls.indexOf("emotes_owned") >= 0;
    clickTool("表情");
    await sleep(400);
    var emotePanel = byTestId("db-panel");
    out.ownedGroupShown = !!emotePanel && emotePanel.innerText.indexOf("我的表情") >= 0;
    // tab 化之后「我的表情」不默认在场：先切过去，再找那一格
    var ownedTab = emotePanel
      ? [].slice.call(emotePanel.querySelectorAll('[data-testid="db-emote-tab"]')).filter(function (b) {
          return b.getAttribute("data-kind") === "owned";
        })[0]
      : null;
    if (ownedTab) {
      ownedTab.click();
      await sleep(300);
    }
    // 取哪一条：**从真实载荷里挑**（用户命名的那条自定义表情），不在断言里写死名字
    var ownedSample = EMOTES.owned.filter(function (e) { return e.text.indexOf("吃瓜") >= 0; })[0];
    var ownedPicker = byTestId("db-panel")
      ? byTestId("db-panel").querySelector('button[title="' + ownedSample.text + '"]')
      : null;
    out.ownedEmoteShown = !!ownedPicker;
    // ---- 「点选某个表情直接发送出去就行」（用户 2026-09-12）：**点一下就发**，没有第二步。
    // 判据：点完立刻有一次 chat_send（带的就是点中那一个的唯一键），草稿一个字符都不动，
    // 面板也不关（连发几个不必反复开面板）。
    if (ownedPicker) {
      ownedPicker.click();
      await sleep(400);
    }
    var chatSends = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
    var lastChatSend = chatSends[chatSends.length - 1];
    // 表情弹幕上游收到的 msg 就是 emoticon_unique（crates/danmubox-bili/src/send.rs），
    // 因此这两条断言等于「上游会收到 upower_<表情名>」。
    out.ownedEmoteSendUnique = !!lastChatSend && !!lastChatSend.args.emote &&
      lastChatSend.args.emote.emoticon_unique === ownedSample.emoticon_unique;
    out.ownedEmoteSendContent = !!lastChatSend && lastChatSend.args.content === ownedSample.text;
    out.ownedEmoteSentOnClick = out.ownedEmoteSendUnique && out.ownedEmoteSendContent;
    out.ownedEmoteNoSecondStep = document.querySelector("textarea").value === "" &&
      !!byTestId("db-panel");
    // 预览（「将发送」条）是**草稿**那一侧的功能：把表情名打进草稿仍会显示成图片
    // （面板点选不再往草稿里插名字，这条路径与面板无关）。
    typeIntoArea(document.querySelector("textarea"), ownedSample.text);
    await sleep(250);
    var sendPreview = byTestId("db-send-preview");
    out.ownedEmotePreviewImage = !!sendPreview &&
      [].slice.call(sendPreview.querySelectorAll("img")).some(function (img) {
        return img.alt === ownedSample.text;
      });
    typeIntoArea(document.querySelector("textarea"), "");
    await sleep(200);
    // 面板**点选后不关**（上面那条断言），但后面几步要用满屏的列表，这里把它收起来。
    clickTool("表情");
    await sleep(250);
    // 发送成功不再占一行说「上次发送：已发出」（用户 #4：没意义且不协调）——弹幕已经出现在列表里
    out.sendHintAbsentOnSuccess = !byTestId("db-send-hint") &&
      text().indexOf("上次发送") < 0;
    snap();

    // ---- menu 右键菜单（目标行显式造：见 emitOtherRow 的注释）
    var target = await emitOtherRow("菜单目标样本");
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(250);
    var menu = byTestId("db-context-menu");
    out.menuShown = !!menu;
    out.menuItems = menu ? [].slice.call(menu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.menuClosed = !byTestId("db-context-menu");
    snap();

    // ---- mention ＠ 与文本同源（issue #13a）：文本里没有 @名字 就不许带目标
    var mentionRow = rowWith("无头像的弹幕");
    openRowMenu(mentionRow);
    await sleep(250);
    buttonWith(byTestId("db-context-menu"), "＠TA").click();
    await sleep(300);
    out.mentionInsertedIntoCaret = document.querySelector("textarea").value.indexOf("@无头像 ") >= 0;
    out.mentionHintShown = !!byTestId("db-mention-hint");
    buttonWith(null, "发送").click();
    await sleep(400);
    var sendWithMention = lastSendCall();
    out.mentionSendCarriesTarget = !!sendWithMention && !!sendWithMention.args.reply &&
      sendWithMention.args.reply.uname === "无头像" && sendWithMention.args.reply.mid > 0;
    // 再 @ 一次，然后把文本里的 @名字 换掉再发：目标必须跟着消失
    openRowMenu(mentionRow);
    await sleep(250);
    buttonWith(byTestId("db-context-menu"), "＠TA").click();
    await sleep(300);
    typeIntoArea(document.querySelector("textarea"), "你好呀");
    await sleep(200);
    out.mentionHintGoneAfterEdit = !byTestId("db-mention-hint");
    buttonWith(null, "发送").click();
    await sleep(400);
    var sendWithoutMention = lastSendCall();
    out.mentionTargetDroppedWithText = !!sendWithoutMention &&
      sendWithoutMention.args.content === "你好呀" && !sendWithoutMention.args.reply;

    // 回复是显式的引用条（可见、可取消），不靠文本，因此照旧带目标
    openRowMenu(mentionRow);
    await sleep(250);
    buttonWith(byTestId("db-context-menu"), "回复").click();
    await sleep(300);
    out.replyBarShown = !!byTestId("db-reply-bar");
    typeIntoArea(document.querySelector("textarea"), "收到");
    await sleep(150);
    buttonWith(null, "发送").click();
    await sleep(400);
    var sendWithReply = lastSendCall();
    out.replySendCarriesTarget = !!sendWithReply && !!sendWithReply.args.reply &&
      sendWithReply.args.reply.dmid.length > 0 && sendWithReply.args.content === "收到";
    snap();

    // 整块包一层（同粉丝牌与 tabs 那两段的手法）：互动步骤在一次真实运行里出岔子时
    // 要**让断言红**（limitBlockRan），而不是把整个场景卡到 300s（那样只剩「未跑完」
    // 一句、定位不到原因）。
    var limitBlockRan = false;
    try {
      // ---- limit 弹幕字数上限（item 12）：上限来自 room_session 的 danmaku_length（契约 §5，
      //      上游 getInfoByUser 的 data.property.danmu.length），缺了才按官方缺省 20 回落 ——
      //      mock 给的是 40，因此这里量到的必须是 40（回落到 20 就说明字段没透传）。
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(150);
      var limitCount = byTestId("db-input-count");
      out.inputCountShown = !!limitCount && limitCount.innerText.trim() === "0/40";
      // 41 个字的正文：超限即**截断**到上限（不是等发出去才发现），并按官方文案弹提示
      var overLimit = new Array(42).join("超");
      typeIntoArea(document.querySelector("textarea"), overLimit);
      await sleep(250);
      out.inputTruncatedToLimit = document.querySelector("textarea").value.length === 40 &&
        document.querySelector("textarea").value === overLimit.slice(0, 40);
      out.inputCountAtLimit =
        (byTestId("db-input-count") || { innerText: "" }).innerText.trim() === "40/40";
      out.inputLimitToastShown = (byTestId("db-toast") || { innerText: "" })
        .innerText.indexOf("最多输入 40 个字哦~") >= 0;
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(200);
      // @昵称 前缀**不计入**上限（官方 inputLengthLimit = 上限 + at 前缀长度，docs/ui.md §6.1）：
      // 先从行菜单拿一个确定的目标（「隔壁观众」4 个字，前缀 @隔壁观众 + 空格共 6 个码元），
      // 再补 44 个字共 50；若前缀计入会被截到 40，实测必须是 46。
      var limitTarget = await emitOtherRow("上限目标样本");
      openRowMenu(limitTarget);
      await sleep(250);
      buttonWith(byTestId("db-context-menu"), "＠TA").click();
      await sleep(300);
      out.inputAtPrefixInserted = document.querySelector("textarea").value === "@隔壁观众 ";
      var withPrefix = document.querySelector("textarea").value + new Array(45).join("a");
      typeIntoArea(document.querySelector("textarea"), withPrefix);
      await sleep(250);
      var afterLimit = document.querySelector("textarea").value;
      out.inputAtPrefixExcludedFromLimit = withPrefix.length === 50 && afterLimit.length === 46 &&
        afterLimit === withPrefix.slice(0, 46);
      out.inputCountWithAtPrefix =
        (byTestId("db-input-count") || { innerText: "" }).innerText.trim() === "46/46";
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(200);
      snap();
      // 上限提示那张浮片自己渐隐掉再往下走：后面的截图不该带着它
      await sleep(2800);
      limitBlockRan = true;
    } catch (e) {
      out.limitBlockError = String((e && e.stack) || e);
    }
    out.limitBlockRan = limitBlockRan;

    // ---- 超时兜底（用户 2026-09-13：不要永远停在「发送中」）：这条**故意不回推**，
    //      看它在 SEND_CONFIRM_TIMEOUT_MS（8s）到点后是否被标成失败族的「未确认」。
    //      点击后那一瞬间它**不带任何标记**（与已确认行同款）——「发送中」那档已按用户
    //      当天的更正删掉，因此这里钉的是「没有待确认视觉」，8s 后才出现修正标记。
    //      发送放在这里（而不是紧挨着 step5 那段 8.6s 等待）有个必须的理由：**成功的发送会把
    //      编辑面板收起**（Composer 的成功路径 setPanel(null)），而紧接着的 step5 / step6 /
    //      礼物栏三块都要在**同一个筛选面板节点**上操作 —— 面板一关一开，旧节点就成了游离节点，
    //      后续 clickLabelIn(filterPanel, …) 会静默失效（改前实测：step6 的开关点了不生效、
    //      礼物栏根本不出现）。这里发送时面板还没开，因此不碰它。
    var timeoutText = "超时兜底样本弹幕";
    typeIntoArea(document.querySelector("textarea"), timeoutText);
    await sleep(150);
    sendButton.click();
    await sleep(150);
    var timeoutRow = rowWith(timeoutText);
    out.sendTimeoutStartsUnmarked = !!timeoutRow &&
      !timeoutRow.querySelector('[data-testid="db-msg-send-state"]');

    // ---- time 时间戳（默认关 → 打开后等宽对齐）
    out.timeCellsDefault = allByTestId("db-msg-time").length;
    clickTool("筛选");
    await sleep(300);
    var filterPanel = byTestId("db-panel");
    out.filterPanelShown = !!filterPanel;
    // ---- 筛选面板重排（item 11）：只剩「消息类型」与「显示」两块 —— 关键词那一整块随 item 9
    //      删除，主题下拉随 item 10 搬到列表页页头，因此面板里**没有**关键词、也没有主题控件。
    out.filterPanelSections = filterPanel
      ? [].slice.call(filterPanel.querySelectorAll("h3")).map(function (h) { return h.innerText.trim(); })
      : [];
    out.filterPanelTwoBlocks = out.filterPanelSections.join(",") === "消息类型,显示";
    out.filterPanelNoKeywords = !!filterPanel && filterPanel.innerText.indexOf("关键词") < 0;
    out.filterPanelNoThemeSelect = !!filterPanel &&
      !filterPanel.querySelector('[data-testid="db-pref-theme"]');
    // 两块的内容都还在（都按**各自的 section** 数，不拿整块的 label 当分母）：
    // 「消息类型」6 枚芯片（契约 §8 的 kind 全集）、「显示」= 字号滑杆 + 三枚开关 + 礼物栏下拉。
    // 开关的**文案**由下面的 step4 / step6 用 clickLabelIn 点到（点得到就说明文案在），
    // 这里只数控件、不解析 label 的 innerText（select 的 innerText 会把选项文本也算进来）。
    var filterSections = filterPanel ? [].slice.call(filterPanel.querySelectorAll("section")) : [];
    var kindsSection = filterSections[0] || null;
    var displaySection = filterSections[1] || null;
    out.filterPanelKindChips = kindsSection
      ? [].slice.call(kindsSection.querySelectorAll("label")).map(function (l) {
          return l.innerText.trim();
        })
      : [];
    out.filterPanelKindChipsComplete = out.filterPanelKindChips.length === 6;
    var displayHas = function (selector) {
      return !!displaySection && !!displaySection.querySelector(selector);
    };
    out.filterPanelDisplayControls = {
      fontScale: displayHas('input[type="range"]'),
      switches: displaySection
        ? displaySection.querySelectorAll('input[type="checkbox"]').length : 0,
      giftMode: displayHas("select"),
    };
    out.filterPanelDisplayComplete = out.filterPanelDisplayControls.fontScale &&
      out.filterPanelDisplayControls.switches === 3 &&
      out.filterPanelDisplayControls.giftMode;
    // ---- item 8：短语与筛选面板同样没有标题与关闭按钮（db-panel-close 钩子整个界面不再提供），
    //      高度与表情面板同源（--panel-h）——逐个数进快照，最后比三者相等。
    out.filterPanelCloseGone = !!filterPanel &&
      filterPanel.querySelectorAll('[data-testid="db-panel-close"]').length === 0 &&
      document.querySelectorAll('[data-testid="db-panel-close"]').length === 0;
    out.filterPanelHeightPx = filterPanel ? f1(rect(filterPanel).height) : null;
    // ---- theme 对比度（房间页这一档）：主题开关已搬到列表页页头（item 10，见 step1），
    //      房间页不再切档，只按**本次运行的那一档**判「正文 / 昵称对背景 ≥ 4.5:1」。
    //      SMOKE_THEMES 深浅各跑一遍，两档因此都成立；开关本身的断言在 step1 那一步。
    var themeBodyBg = getComputedStyle(document.body).backgroundColor;
    var themeBodyColor = getComputedStyle(document.body).color;
    var themeNameEl = document.querySelector('[data-testid="db-msg-name"]');
    out.themeBaseContrastBody = contrastRatio(themeBodyColor, themeBodyBg);
    out.themeBaseContrastDim = contrastRatio(
      themeNameEl ? getComputedStyle(themeNameEl).color : "", themeBodyBg);
    out.themeContrastBodyOk = out.themeBaseContrastBody >= 4.5;
    out.themeContrastDimOk = out.themeBaseContrastDim >= 4.5;
    clickLabelIn(filterPanel, "时间戳");
    await sleep(400);
    var cells = allByTestId("db-msg-time").map(function (el) { return el.getBoundingClientRect(); });
    out.timeCellsShown = cells.length;
    out.timeWidthsEqual = cells.length > 0 && cells.every(function (r) { return Math.abs(r.width - cells[0].width) < 0.6; });
    out.timeRightEdgesEqual = cells.length > 0 && cells.every(function (r) { return Math.abs(r.right - cells[0].right) < 0.6; });
    snap();

    // ---- step4 系统通知开关（语义不得改）：打开后**新来**的系统行要出现。
    // 这里不拿很早以前那条（它已滚出虚拟列表的渲染范围），改发一条新的，断言更硬。
    out.step4_toggledSystem = clickLabelIn(filterPanel, "系统通知");
    await sleep(400);
    window.__emit("danmubox://message", window.__mk("system", "分区变更二号"));
    await sleep(300);
    out.step4_prefSystemNotice = window.__prefs["ui.system_notice"];
    out.step4_systemRenderedAfterToggle = text().indexOf("分区变更二号") >= 0;
    snap();

    // ---- step5 互动行 8 秒后自动消失（语义不得改）。这段等待同时也盖过了前面那条超时兜底
    //      （发送 → 这里 ≈ 14s > 8s），所以「未确认」在同一格验掉，不额外增加一轮的墙钟时间。
    await sleep(8600);
    timeoutRow = rowWith(timeoutText);
    var timeoutMark = timeoutRow
      ? timeoutRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.sendTimeoutMarkedUnconfirmed = !!timeoutMark &&
      timeoutMark.getAttribute("data-state") === "unconfirmed" &&
      timeoutMark.innerText.indexOf("未确认") >= 0;
    out.step5_interactGoneAfter8s = text().indexOf("进入直播间") < 0;
    snap();

    // ---- step6 关掉开关则常驻（语义不得改）
    out.step6_toggledAutoHide = clickLabelIn(filterPanel, "互动消息自动消失");
    await sleep(300);
    window.__emit("danmubox://message", window.__mk("interact", ""));
    await sleep(8600);
    out.step6_prefAutoHide = window.__prefs["ui.interact_auto_hide"];
    out.step6_interactPersistsWhenOff = text().indexOf("进入直播间") >= 0;
    snap();

    // ---- gift 礼物栏在输入区下方、可折叠、不抢宽度
    var chatWidthBefore = rect(byTestId("db-chat-scroll")).width;
    out.giftModePicked = pickGiftMode();
    await sleep(500);
    var dock = byTestId("db-gift-dock");
    var composer = document.querySelector("textarea").closest('[class*="composer"]');
    out.giftDockAfterComposer = !!dock && !!composer &&
      (composer.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    out.giftDockCollapsed = !!dock && !byTestId("db-gift-body");
    out.giftDockFullWidth = !!dock && Math.abs(rect(dock).width - document.body.clientWidth) < 2;
    // 窄屏：折叠条只占一行，弹幕列表不被它挤掉
    put("giftDockCompact", !!dock && rect(dock).height <= 56);
    put("giftListKeptTall", rect(byTestId("db-chat-scroll")).height >= 200);
    buttonWith(dock, "礼物 / SC").click();
    await sleep(300);
    out.giftDockExpands = !!byTestId("db-gift-body");
    out.giftChatWidthUnchanged = Math.abs(rect(byTestId("db-chat-scroll")).width - chatWidthBefore) < 2;
    snap();

    // ---- panel 层：短语右键增删改、点选插入到光标处、头部 ⋯ 菜单
    clickTool("筛选"); // 收起筛选面板，避免两个面板互相干扰
    out.toolsPhrasesOpen = clickTool("短语");
    await sleep(300);
    var phrasesPanel = byTestId("db-panel");
    out.phrasesPanelShown = !!phrasesPanel;
    // ---- item 8：短语面板与筛选 / 表情面板**同一副骨架** —— 顶上没有标题、没有关闭按钮，
    //      高度同源（--panel-h），首行就是「加一条」（见下面 phraseAddRow* 那几条）。
    out.phrasesPanelFirstRow = phrasesPanel && phrasesPanel.firstElementChild
      ? phrasesPanel.firstElementChild.getAttribute("data-testid") : null;
    out.phrasesPanelStartsAtAddRow = out.phrasesPanelFirstRow === "db-phrase-add";
    out.phrasesPanelCloseGone = !!phrasesPanel &&
      phrasesPanel.querySelectorAll('[data-testid="db-panel-close"]').length === 0;
    out.phrasesPanelHeightPx = phrasesPanel ? f1(rect(phrasesPanel).height) : null;
    // 三个面板展开高度**口径一致**（item 8：短语 / 筛选「展开高度看齐表情界面」）：
    // 表情那一份在上面量过（panelHeightPx），筛选那一份在时间戳那一步量过（filterPanelHeightPx）。
    out.panelHeightsMatch = out.panelHeightPx !== null && out.filterPanelHeightPx !== null &&
      out.phrasesPanelHeightPx !== null &&
      Math.abs(out.phrasesPanelHeightPx - out.panelHeightPx) < 1 &&
      Math.abs(out.filterPanelHeightPx - out.panelHeightPx) < 1;
    var phraseChip = buttonWith(phrasesPanel, "早上好");
    phraseChip.click();
    await sleep(200);
    out.phraseInsertsAtCaret = document.querySelector("textarea").value.indexOf("早上好") >= 0;
    phraseChip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
    await sleep(250);
    var phraseMenu = byTestId("db-context-menu");
    out.phraseMenuItems = phraseMenu ? [].slice.call(phraseMenu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    buttonWith(phraseMenu, "删除").click();
    await sleep(300);
    out.phraseDeleted = window.__prefs["composer.phrases"].length === 0 && !buttonWith(byTestId("db-panel"), "早上好");
    var phraseInput = [].slice.call(byTestId("db-panel").querySelectorAll("input")).filter(function (i) {
      return (i.placeholder || "").indexOf("新短语") >= 0;
    })[0];
    typeInto(phraseInput, "晚上好");
    await sleep(150);
    buttonWith(byTestId("db-panel"), "添加").click();
    await sleep(300);
    out.phraseAdded = window.__prefs["composer.phrases"].join(",") === "晚上好" && !!buttonWith(byTestId("db-panel"), "晚上好");

    // ---- 「加一条」是固定的一行：短语再多也顶不掉它，聊天输入框也还在（用户 #8）
    var phraseAddRow = byTestId("db-phrase-add");
    var phraseAddInput = phraseAddRow ? phraseAddRow.querySelector("input") : null;
    out.phraseAddRowShown = !!phraseAddInput;
    var addTopBefore = phraseAddInput ? Math.round(rect(phraseAddInput).top * 10) / 10 : null;
    var panelTopBefore = Math.round(rect(byTestId("db-panel")).top * 10) / 10;
    for (var extra = 0; extra < 5; extra += 1) {
      if (!phraseAddInput) break;
      typeInto(phraseAddInput, "追加短语" + extra);
      await sleep(120);
      buttonWith(byTestId("db-panel"), "添加").click();
      await sleep(220);
    }
    var addRowAfter = byTestId("db-phrase-add");
    var addInputAfter = addRowAfter ? addRowAfter.querySelector("input") : null;
    var panelBox = rect(byTestId("db-panel"));
    var addBox = rect(addInputAfter);
    var chatAreaEl = document.querySelector("textarea");
    var chatBox = rect(chatAreaEl);
    out.phraseAddRowY = addTopBefore;
    out.phraseAddRowYAfter = addInputAfter ? Math.round(addBox.top * 10) / 10 : null;
    // 判据是「相对面板顶的偏移不变」：窄屏下面板向上长，绝对位置本来就会跟着动
    out.phraseAddRowStaysPut = addTopBefore !== null && panelTopBefore !== null && !!addInputAfter &&
      Math.abs((addBox.top - panelBox.top) - (addTopBefore - panelTopBefore)) < 1;
    out.phraseAddRowInsidePanel = !!addInputAfter &&
      addBox.top >= panelBox.top - 1 && addBox.bottom <= panelBox.bottom + 1;
    out.phraseAddRowWideEnough = !!addInputAfter && addBox.width >= 120;
    // 聊天输入框：仍然完整落在视口里，且被面板**顶到下面**而不是被它盖住 / 挤没
    out.phraseChatInputStillVisible = chatBox.bottom <= window.innerHeight + 1 &&
      chatBox.height >= 38 && chatBox.top >= panelBox.bottom - 1;
    clickTool("短语");
    await sleep(200);

    byTestId("db-header-more").click();
    await sleep(250);
    var headerMenu = byTestId("db-context-menu");
    out.headerMenuItems = headerMenu ? [].slice.call(headerMenu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.headerMenuClosed = !byTestId("db-context-menu");
    snap();

    // ---- 「断开连接」之后再点「刷新连接」必须能把连接拉回来（用户 2026-09-13：
    //      「现在断连后再刷新无法直接重连了？」）。走的是**用户看得见的那条路**：
    //      断连时这颗键必须可点 → 点了真的发出 rooms_reconnect → 状态点从灰回到上游那一档。
    //      改前后端直接报 ROOM_NOT_FOUND（rooms_disconnect 把会话摘掉了），
    //      界面只弹一条错误、连接回不来 —— 这三条断言都会红。
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "disconnected", detail: "会话已关闭" });
    await sleep(250);
    out.reconnectDotIdleAfterDrop = byTestId("db-live-dot-box").getAttribute("data-state") === "idle";
    // 多标签隔离（item 2）要有两个房间才有标签条：把第二个房间登记进替身的 rooms_list ——
    // **紧挨着**下面这次「刷新连接」，它会重拉 rooms_list，界面随后就看到第二个房间。
    window.__addSecondRoom();
    byTestId("db-header-more").click();
    await sleep(250);
    var refreshItem = buttonWith(byTestId("db-context-menu"), "刷新连接");
    out.reconnectItemOffered = !!refreshItem && refreshItem.disabled !== true;
    var reconnectBefore = window.__reconnectCalls || 0;
    refreshItem.click();
    await sleep(400);
    out.reconnectCommandSent = (window.__reconnectCalls || 0) === reconnectBefore + 1 &&
      window.__lastReconnectRoom === fixtureRoom.room_id;
    // 连上之后状态点回到上游 live_status 那一档（灰只表示「还没连上」，见 docs/ui.md §3.3）。
    out.reconnectDotRestored = byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(150);
    snap();

    // ---- tabs 多标签隔离（item 2，契约 C1 / docs/ui.md §2.3「多标签共存」）：
    //      切房间 = 换掉一整套**本地临时状态**，但**输入草稿按「身份 × 房间」各留一份**。
    //      此刻有两个房间（上面那次「刷新连接」重拉 rooms_list 带进来的 5555），标签条在场。
    //      流程：A 间开面板 + 开右键菜单 + 往上滚到「不跟随」+ 留一份草稿 → 切 B 间：
    //      面板 / 菜单 / 滚动跟随全部回到初始、草稿是空的 → 在 B 间再开一次面板 → 切回 A 间：
    //      面板同样收起、A 间那份草稿还在（键 = 身份:房间，本段身份是 uid 1000）。
    // 整块包一层（同粉丝牌那段的手法）：出岔子时让断言红（tabsBlockRan），
    // 而不是把整个场景卡到 300s。
    var tabsBlockRan = false;
    try {
      var tabIsolationScroll = byTestId("db-chat-scroll");
      // 垫场：让 A 间一定滚得动（不受「此刻恰好还剩几条可见」影响），否则「滚到暂停」无从谈起
      for (var padIndex = 0; padIndex < 30; padIndex += 1) {
        window.__emit("danmubox://message", window.__mk("danmaku", "隔离垫场" + padIndex, false, {
          uid: 77003, uname: "垫场观众"
        }));
      }
      await sleep(500);
      out.tabIsolationScrollable = tabIsolationScroll.scrollHeight > tabIsolationScroll.clientHeight + 1;
      // ① 右键菜单：在**最新一条**上开 —— 此刻还在跟随、那一行一定在虚拟列表的渲染窗口里
      //    （先滚到顶再开菜单会点不到行：窗口里只剩最旧的那几条）。
      var isolationMenuTarget = await emitOtherRow("隔离菜单样本");
      openRowMenu(isolationMenuTarget);
      await sleep(300);
      // ② 面板：工具行点开（.click() 不带 pointerdown，因此不会顺带把右键菜单关掉）
      clickTool("表情");
      await sleep(400);
      // ③ 往上滚到顶 = 用户自己暂停跟随（db-bottom-anchor 只在 !following 时渲染）
      tabIsolationScroll.scrollTop = 0;
      await sleep(400);
      out.tabIsolationPausedInA = !!byTestId("db-bottom-anchor");
      out.tabIsolationStatesSet = !!byTestId("db-panel") && !!byTestId("db-context-menu") &&
        !!byTestId("db-bottom-anchor");
      // ④ 草稿：A 间这一份只属于「身份:房间」这个键
      var isolationDraft = "A 间草稿";
      typeIntoArea(document.querySelector("textarea"), isolationDraft);
      await sleep(200);
      out.tabIsolationDraftTyped = document.querySelector("textarea").value === isolationDraft;
      var tabFor = function (name) {
        return allByTestId("db-room-tab").filter(function (t) {
          return t.innerText.indexOf(name) >= 0;
        })[0];
      };
      var tabRoomA = tabFor(fixtureRoom.anchor_uname);
      var tabRoomB = tabFor("房间 5555");
      out.tabIsolationTwoTabs = allByTestId("db-room-tab").length === 2 && !!tabRoomA && !!tabRoomB;
      tabRoomB.click();
      await sleep(900);
      // 「切到了 B」以房间头报的标题为准（不认 CSS-module 类名）：5555 没有主播名与标题，退到房间号
      out.tabIsolationSwitchedToB =
        byTestId("db-room-title").getAttribute("title") === "房间 5555";
      out.tabIsolationPanelClosed = !byTestId("db-panel");
      out.tabIsolationMenuClosed = !byTestId("db-context-menu");
      out.tabIsolationDraftFreshInB = document.querySelector("textarea").value === "";
      out.tabIsolationFollowingReset = !byTestId("db-bottom-anchor") &&
        bottomGap(byTestId("db-chat-scroll")) < 8;
      // B 间再开一次面板，切回 A 间时它同样必须收起（两个方向都判，不是单向巧合）
      clickTool("表情");
      await sleep(400);
      out.tabIsolationPanelOpenInB = !!byTestId("db-panel");
      tabRoomA = tabFor(fixtureRoom.anchor_uname);
      tabRoomA.click();
      await sleep(900);
      out.tabIsolationBackInA = byTestId("db-room-title").getAttribute("title") === fixtureRoom.title;
      out.tabIsolationPanelClosedBackInA = !byTestId("db-panel");
      out.tabIsolationDraftRestored = document.querySelector("textarea").value === isolationDraft;
      // 复原：草稿清掉（后面的步骤不依赖它），快照写下这一段
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(200);
      snap();
      tabsBlockRan = true;
    } catch (e) {
      out.tabsBlockError = String((e && e.stack) || e);
    }
    out.tabsBlockRan = tabsBlockRan;

    // ---- admin 房管（issue #3）：权限前置、写操作二次确认、面板三块与错误原样展示
    out.adminIdentityFetched = calls.indexOf("room_session") >= 0;
    // **预载**（issue #4/第 5 条：连接上就有房管权限的房间时把数据加载好）：身份就绪之后
    // **不打开面板**也已经拉过三块名单 —— 数 IPC 调用即可（一次都没有 = 打开面板才拉，慢半拍）。
    var adminListCallCounts = function (cmd) {
      return calls.filter(function (c) { return c === cmd; }).length;
    };
    out.adminPreloadCalls = [
      adminListCallCounts("admin_silent_list"),
      adminListCallCounts("admin_blacklist_list"),
      adminListCallCounts("admin_keywords_list")
    ];
    out.adminPreloadedBeforeOpen = out.adminPreloadCalls.every(function (n) { return n >= 1; });
    // **反面对照**（item 3）：先把身份发成 is_admin:false，⋯ 菜单里就不该再有「房管面板」这一项 ——
    // 口径是「有房管身份才有房管界面的选项」，不是置灰让人点开再看上游报错
    // （旧的 adminReadOnlyPanelStillOpen 已删）。身份按契约 §5 的 RoomSession 全量给
    // （含 item 12 的 danmaku_length，少了它界面会按缺省 20 回落）。
    window.__setAdmin(false);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
      my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(300);
    byTestId("db-header-more").click();
    await sleep(250);
    out.adminPanelMenuItemHiddenWithoutPermission =
      !buttonWith(byTestId("db-context-menu"), "房管面板");
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    // 恢复房管身份再往下走
    window.__setAdmin(true);
    window.__setAdminFail(false);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
      my_guard_level: 0, danmaku_length: 40, is_admin: true
    });
    await sleep(300);
    var adminTarget = await emitOtherRow("房管目标样本");
    adminTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(250);
    var adminMenu = byTestId("db-context-menu");
    var adminLabels = ["禁言…", "拉黑", "解除禁言"];
    var adminItemsOf = function (menu) {
      return menu ? [].slice.call(menu.querySelectorAll("button")).filter(function (b) {
        return adminLabels.indexOf(b.innerText.trim()) >= 0;
      }) : [];
    };
    var adminItems = adminItemsOf(adminMenu);
    out.adminMenuItemsShown = adminItems.length === 3;
    out.adminMenuItemsEnabledAsAdmin = adminItems.length === 3 && adminItems.every(function (b) { return !b.disabled; });
    // 禁言必须选时长：确认条上给出对象与时长，默认「本场直播」
    buttonWith(adminMenu, "禁言…").click();
    await sleep(300);
    var muteConfirm = byTestId("db-admin-confirm");
    out.adminMuteConfirmShown = !!muteConfirm;
    // 确认文案必须说清**对象**：目标行的昵称要出现在确认条里（不能只写「确认禁言？」）。
    var targetNameEl = adminTarget ? adminTarget.querySelector('[data-testid="db-msg-name"]') : null;
    var targetNick = targetNameEl ? targetNameEl.innerText.replace(/:$/, "") : "";
    out.adminMuteTargetNick = targetNick;
    out.adminMuteConfirmNamesTarget = !!muteConfirm && targetNick.length > 0 &&
      muteConfirm.innerText.indexOf(targetNick) >= 0;
    var hourSelect = muteConfirm ? muteConfirm.querySelector("select") : null;
    // 时长默认「本场直播」（hour = 0），选「1 小时」后选择器与请求都要跟上。
    // 注意别拿确认条的 innerText 找时长文案——select 的选项文本本来就在 innerText 里，那会平凡成立。
    out.adminMuteDefaultHour = hourSelect ? hourSelect.value : null;
    out.adminMuteDefaultHourIsCurrentSession = !!hourSelect && hourSelect.value === "0";
    // 停一下让跑脚本的进程抓一张「确认条」的截图（对象 + 时长都在上面）
    snap();
    await sleep(1200);
    if (hourSelect) {
      hourSelect.value = "1";
      hourSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(200);
    }
    out.adminMuteHourSelected = !!byTestId("db-admin-confirm") &&
      byTestId("db-admin-confirm").querySelector("select").value === "1";
    buttonWith(byTestId("db-admin-confirm"), "确认禁言").click();
    await sleep(600);
    var mutes = callsWithArgs.filter(function (c) { return c.cmd === "admin_mute"; });
    var lastMute = mutes[mutes.length - 1];
    // 请求形状：房间号 + 目标 uid + 选中的时长（-1 永久 / 0 本场 / 其余小时）
    out.adminMuteRequestShape = !!lastMute && lastMute.args.roomId === 5440 &&
      lastMute.args.hour === 1 && typeof lastMute.args.uid === "number" && lastMute.args.uid > 0;
    out.adminConfirmClosedAfterWrite = !byTestId("db-admin-confirm");

    // 面板：三块名单收成**三个 tab**（issue #1）——一次只渲染当前那一块；计数读 tab 文案里的（N）。
    // 单点动作在**行右键菜单**里、批量在批量条上（issue #4）；「增删」照旧先二次确认。
    byTestId("db-header-more").click();
    await sleep(250);
    var headerMenu2 = byTestId("db-context-menu");
    out.adminPanelMenuItemShown = !!buttonWith(headerMenu2, "房管面板");
    buttonWith(headerMenu2, "房管面板").click();
    await sleep(600);
    var adminPanel = byTestId("db-admin-panel");
    out.adminPanelShown = !!adminPanel;
    // 面板里**没有**「刷新」按钮、也**没有**「你是本直播间房管」那句提示（issue #5：入口只对房管
    // 存在，面板里再说一遍身份是废话；手动重试入口随之取消，读取失败靠错误条说话），关闭入口仍在。
    out.adminPanelNoRefreshButton = !!adminPanel && !buttonWith(adminPanel, "刷新");
    out.adminPanelNoIdentityHint = !!adminPanel &&
      adminPanel.innerText.indexOf("你是本直播间房管") < 0;
    out.adminPanelClosable = !!byTestId("db-admin-close");
    // 逐 tab 的取数口径：tab 的 [data-kind] 与行级 testid 一一对应
    var ADMIN_KINDS = ["silent", "blacklist", "keywords"];
    var adminRowTestId = function (adminKind) {
      return adminKind === "silent" ? "db-admin-silent-item"
        : adminKind === "blacklist" ? "db-admin-blacklist-item" : "db-admin-keyword-item";
    };
    var adminTabEls = function () { return allByTestId("db-admin-tab"); };
    var adminTabOf = function (adminKind) {
      return adminTabEls().filter(function (b) {
        return b.getAttribute("data-kind") === adminKind;
      })[0];
    };
    var adminSelectedTab = function () {
      return adminTabEls().filter(function (b) {
        return b.getAttribute("aria-selected") === "true";
      })[0];
    };
    var adminSelectedKind = function () {
      var el = adminSelectedTab();
      return el ? el.getAttribute("data-kind") : null;
    };
    // 别跟上面那个「数右键菜单项」的 adminItemsOf 混了：这里数的是当前 tab 的行。
    var adminListItemsOf = function (adminKind) {
      return allByTestId(adminRowTestId(adminKind)).length;
    };
    // tab 文案形如「禁言（1）」：计数直接从那一枚 tab 的 innerText 里切出来（不写正则）
    var adminTabCount = function (adminKind) {
      var el = adminTabOf(adminKind);
      if (!el) return null;
      var t = el.innerText;
      var open = t.lastIndexOf("（");
      var close = t.lastIndexOf("）");
      return open >= 0 && close > open ? Number(t.slice(open + 1, close)) : null;
    };
    // 走一遍三个 tab：切过去之后**只有这一块**的列表在 DOM 里，计数与 tab 文案对得上
    var adminWalk = async function () {
      var seen = {};
      for (var wi = 0; wi < ADMIN_KINDS.length; wi += 1) {
        var walkKind = ADMIN_KINDS[wi];
        if (adminTabOf(walkKind)) adminTabOf(walkKind).click();
        await sleep(280);
        seen[walkKind] = {
          selected: adminSelectedKind() === walkKind,
          others: ADMIN_KINDS.reduce(function (sum, k) {
            return k === walkKind ? sum : sum + adminListItemsOf(k);
          }, 0),
          items: adminListItemsOf(walkKind),
          labelCount: adminTabCount(walkKind)
        };
      }
      return seen;
    };
    var adminKindsShown = adminTabEls().map(function (b) { return b.getAttribute("data-kind"); });
    out.adminTabKinds = adminKindsShown;
    out.adminTabThreeKinds = adminKindsShown.join(",") === ADMIN_KINDS.join(",");
    out.adminTabSinglePanel = allByTestId("db-admin-tabpanel").length === 1;
    out.adminTabDefaultSilent = adminSelectedKind() === "silent";
    // roving tabindex：只有选中的那一枚可 Tab 到（其余 -1），role / aria-selected / aria-controls 都在
    out.adminTabRoving = adminTabEls().length === ADMIN_KINDS.length &&
      adminTabEls().every(function (b) {
        var on = b.getAttribute("aria-selected") === "true";
        return b.getAttribute("role") === "tab" &&
          b.getAttribute("tabindex") === (on ? "0" : "-1");
      }) && !!adminSelectedTab();
    var adminTabPanel = byTestId("db-admin-tabpanel");
    out.adminTabPanelLinked = !!adminTabPanel && !!adminSelectedTab() &&
      adminTabPanel.getAttribute("aria-labelledby") === adminSelectedTab().id &&
      adminTabEls().every(function (b) {
        return b.getAttribute("aria-controls") === adminTabPanel.id;
      });
    out.adminPanelSections = adminTabEls().map(function (b) { return b.innerText.trim(); });
    var adminWalked = await adminWalk();
    out.adminPanelListsRendered = ADMIN_KINDS.every(function (k) {
      return adminWalked[k].selected && adminWalked[k].others === 0;
    });
    out.adminPanelItemCounts = {
      silent: adminWalked.silent.items,
      blacklist: adminWalked.blacklist.items,
      keywords: adminWalked.keywords.items
    };
    out.adminPanelCountsMatchLabels = ADMIN_KINDS.every(function (k) {
      return adminWalked[k].items === adminWalked[k].labelCount;
    });
    // 键盘：←→ 换 tab、Home / End 跳首尾，焦点跟着选中项走（WAI-ARIA tabs 口径）。
    // 键事件派发在**已聚焦的那一枚 tab** 上，轨道自身的 keydown 因此收到它 —— 与真实按键同一条路径。
    var adminKeyStep = async function (fromKind, key, expectKind) {
      var fromEl = adminTabOf(fromKind);
      if (!fromEl) return false;
      pressKey(fromEl, key);
      await sleep(280);
      return adminSelectedKind() === expectKind &&
        document.activeElement === adminTabOf(expectKind);
    };
    var adminKeyOk = await adminKeyStep("silent", "ArrowRight", "blacklist");
    adminKeyOk = (await adminKeyStep("blacklist", "ArrowLeft", "silent")) && adminKeyOk;
    adminKeyOk = (await adminKeyStep("silent", "End", "keywords")) && adminKeyOk;
    adminKeyOk = (await adminKeyStep("keywords", "Home", "silent")) && adminKeyOk;
    out.adminTabKeyboardFollows = adminKeyOk;
    // 房管面板是最高的一个（窄屏撞 45vh 上限），它展开时最能暴露「跟随被悄悄关掉」：
    // 修复前这里实测离底 398px，最新一条落在面板下方 318px 处。
    out.layoutAdminBottomGap = bottomGap(byTestId("db-chat-scroll"));
    out.layoutAdminFollowing = out.layoutAdminBottomGap < 8;
    out.layoutNoJumpButtonWithAdminPanel = !byTestId("db-bottom-anchor");
    // 窄屏：房管面板同样是文档流里的一块（只挤列表、不遮最新一条），限高 + 内部滚动 + 关闭入口 + 热区 ≥ 40px
    if (NARROW) {
      var adminPanelRect = rect(adminPanel);
      var adminPanelNewest = rows()[rows().length - 1];
      put("adminPanelInFlow", getComputedStyle(adminPanel).position !== "fixed");
      put("adminPanelScrollable", getComputedStyle(adminPanel).overflowY === "auto");
      put("adminPanelHeightPx", Math.round(adminPanelRect.height));
      put("adminPanelCappedToViewportShare", adminPanelRect.height <= window.innerHeight * 0.5 + 1);
      put("adminPanelNewestNotCovered", !!adminPanelNewest &&
        rect(adminPanelNewest).bottom <= adminPanelRect.top + 1);
      put("adminPanelClosable", !!byTestId("db-admin-close"));
      var adminHotspots = shortHotspots(adminPanel);
      put("adminPanelHotspotsBad", adminHotspots);
      put("adminPanelHotspotsAtLeast40", adminHotspots.length === 0);
    }
    // 停一下让跑脚本的进程抓一张「房管面板三块」的截图
    snap();
    await sleep(1200);
    // ---- 五面板互斥（issue #4）：房管面板 / 表情 / 短语 / 筛选 / 独立礼物栏**同时最多开一个**。
    //      开一个 → 其余四个同步都关；收起某一个不影响别人（panelSurvivesTabSwitch 那三条照旧成立）。
    //      礼物栏这一档要先存在它：上面 gift 那段已把 ui.gift_panel_mode 选成 separate。
    var openPanelCount = function () {
      return (byTestId("db-panel") ? 1 : 0) + (byTestId("db-admin-panel") ? 1 : 0) +
        (byTestId("db-gift-body") ? 1 : 0);
    };
    // 房管面板的开/关都只有一条路：⋯ 菜单里那一项（面板内没有开关自己的按钮）
    var toggleAdminFromHeader = async function () {
      byTestId("db-header-more").click();
      await sleep(250);
      var item = buttonWith(byTestId("db-context-menu"), "房管面板");
      if (item) item.click();
      await sleep(700);
    };
    out.panelExclusiveStart = openPanelCount() === 1 && !!byTestId("db-admin-panel");
    clickTool("表情");
    await sleep(450);
    out.panelExclusiveEmoteClosesAdmin = !!byTestId("db-panel") &&
      !byTestId("db-admin-panel") && !byTestId("db-gift-body") && openPanelCount() === 1;
    clickTool("短语");
    await sleep(350);
    out.panelExclusivePhraseReplacesEmote = allByTestId("db-panel").length === 1 &&
      !!byTestId("db-phrase-add") && openPanelCount() === 1;
    clickTool("筛选");
    await sleep(350);
    out.panelExclusiveFilterReplacesPhrase = allByTestId("db-panel").length === 1 &&
      !byTestId("db-phrase-add") && openPanelCount() === 1;
    var exclusiveDockHead = byTestId("db-gift-dock")
      ? byTestId("db-gift-dock").querySelector("button") : null;
    if (exclusiveDockHead) exclusiveDockHead.click();
    await sleep(450);
    out.panelExclusiveGiftDockClosesPanel = !!byTestId("db-gift-body") &&
      !byTestId("db-panel") && !byTestId("db-admin-panel") && openPanelCount() === 1;
    await toggleAdminFromHeader();
    out.panelExclusiveAdminClosesGiftDock = !!byTestId("db-admin-panel") &&
      !byTestId("db-panel") && !byTestId("db-gift-body") && openPanelCount() === 1;

    // ---- 上游拒绝**原样展示**（code + message）：三块各自留痕、互不清空，面板留在原地。
    //      这一档必须在**有权限**时测 —— 入口只对房管存在，身份被撤销时面板会直接收起（见下）。
    //      issue #5 之后面板里**没有**手动重试入口：重拉 = 关掉再开（⋯ →「房管面板」），
    //      所以下面这条路径本身就是「重拉」这条路的验收面。
    var reopenAdmin = async function () {
      if (byTestId("db-admin-close")) byTestId("db-admin-close").click();
      await sleep(300);
      await toggleAdminFromHeader();
    };
    window.__setAdminFail(true);
    await reopenAdmin();
    out.adminReopenRefetches = adminListCallCounts("admin_blacklist_list") >= 2;
    var adminErrCount = {};
    var adminErrRaw = {};
    for (var ae = 0; ae < ADMIN_KINDS.length; ae += 1) {
      var errKind = ADMIN_KINDS[ae];
      if (adminTabOf(errKind)) adminTabOf(errKind).click();
      await sleep(300);
      var errText = (byTestId("db-admin-tabpanel") || { innerText: "" }).innerText;
      adminErrRaw[errKind] = errText.indexOf("不是管理员") >= 0 &&
        errText.indexOf("UPSTREAM_ERROR") >= 0;
      adminErrCount[errKind] = allByTestId("db-admin-error").length;
    }
    out.adminPanelErrorRaw = ADMIN_KINDS.every(function (k) { return adminErrRaw[k]; });
    out.adminPanelErrorCount = adminErrCount;
    // 三块各自留痕、互不清空 —— 但**任一时刻只有当前 tab 那一条**在 DOM 里（切三个 tab 各看一次）
    out.adminPanelErrorsIndependent = ADMIN_KINDS.every(function (k) {
      return adminErrCount[k] === 1;
    });
    // 上游恢复之后「关掉再开」能把三块读回来、错误条随之消失
    window.__setAdminFail(false);
    await reopenAdmin();
    out.adminPanelErrorClearedAfterRetry = allByTestId("db-admin-error").length === 0;
    var adminAfterRetry = await adminWalk();
    out.adminPanelListsAfterRetry = {
      silent: adminAfterRetry.silent.items,
      blacklist: adminAfterRetry.blacklist.items,
      keywords: adminAfterRetry.keywords.items
    };
    // ---- 单点动作：行的**右键菜单**（issue #4；行内那枚「删除」按钮已删），一次确认后执行
    if (adminTabOf("keywords")) adminTabOf("keywords").click();
    await sleep(300);
    var adminKeywordRow = allByTestId(adminRowTestId("keywords"))[0];
    out.adminRowHasNoInlineAction = !!adminKeywordRow &&
      adminKeywordRow.querySelector("button") === null;
    if (adminKeywordRow) openRowMenu(adminKeywordRow);
    await sleep(250);
    var adminRowMenu = byTestId("db-context-menu");
    var adminRowDelBtn = adminRowMenu ? buttonWith(adminRowMenu, "删除") : null;
    out.adminRowMenuShown = !!adminRowDelBtn;
    if (adminRowDelBtn) adminRowDelBtn.click();
    await sleep(300);
    var wordConfirm = byTestId("db-admin-confirm");
    out.adminKeywordConfirmShown = !!wordConfirm && wordConfirm.innerText.indexOf("刷屏") >= 0;
    if (wordConfirm) buttonWith(wordConfirm, "确认删除").click();
    await sleep(600);
    var wordDels = callsWithArgs.filter(function (c) { return c.cmd === "admin_keywords_del"; });
    var lastWordDel = wordDels[wordDels.length - 1];
    out.adminKeywordDelRequestShape = !!lastWordDel &&
      lastWordDel.args.roomId === 5440 && lastWordDel.args.word === "刷屏";

    // ---- 批量（issue #4）：打开后行前出现勾选框、上方有全选、底部升起当前 tab 的动作条；
    //      选中 N 项 → **一次**确认（文案含数量）→ 按序执行（N 次调用，顺序即屏幕顺序）。
    if (adminTabOf("keywords")) adminTabOf("keywords").click();
    await sleep(300);
    if (byTestId("db-admin-batch")) byTestId("db-admin-batch").click();
    await sleep(300);
    var batchToggle = byTestId("db-admin-batch");
    out.adminBatchControlsShown = !!batchToggle &&
      batchToggle.getAttribute("aria-pressed") === "true" &&
      !!byTestId("db-admin-select-all") && !!byTestId("db-admin-batch-bar") &&
      allByTestId("db-admin-select").length === adminListItemsOf("keywords");
    var adminBoxes = allByTestId("db-admin-select");
    adminBoxes.forEach(function (box) { box.click(); });
    await sleep(300);
    var batchBar = byTestId("db-admin-batch-bar");
    out.adminBatchBarShowsCount = !!batchBar && adminBoxes.length === 2 &&
      batchBar.innerText.indexOf("已选 " + adminBoxes.length + " 项") >= 0;
    var delsBeforeBatch = callsWithArgs.filter(function (c) {
      return c.cmd === "admin_keywords_del";
    }).length;
    var batchActionBtn = byTestId("db-admin-batch-action");
    if (batchActionBtn) batchActionBtn.click();
    await sleep(300);
    var batchConfirm = byTestId("db-admin-confirm");
    var delsAtConfirm = callsWithArgs.filter(function (c) {
      return c.cmd === "admin_keywords_del";
    }).length;
    out.adminBatchOneConfirmWithCount = !!batchConfirm &&
      batchConfirm.innerText.indexOf("2 项") >= 0 &&
      batchConfirm.innerText.indexOf("刷屏") >= 0 &&
      batchConfirm.innerText.indexOf("广告") >= 0 &&
      delsAtConfirm === delsBeforeBatch;
    if (batchConfirm) buttonWith(batchConfirm, "确认批量").click();
    await sleep(800);
    var batchDels = callsWithArgs.filter(function (c) { return c.cmd === "admin_keywords_del"; });
    out.adminBatchExecutesInOrder = batchDels.length === delsBeforeBatch + 2 &&
      batchDels[batchDels.length - 2].args.word === "刷屏" &&
      batchDels[batchDels.length - 1].args.word === "广告";

    // ---- 身份被撤销（item 3，契约 C6）：面板**自动收起**、入口随之从 ⋯ 菜单里消失；
    //      行右键那三项改成置灰并说明原因（它们是「权限前置」的另一半，仍照旧可判）。
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    window.__setAdmin(false);
    window.__setAdminFail(true);
    // 身份经 danmubox://session 事件送达（面板里已没有刷新按钮，所以撤销不再靠点它触发）
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
      my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(500);
    out.adminPanelClosedAfterRevoke = !byTestId("db-admin-panel");
    byTestId("db-header-more").click();
    await sleep(250);
    out.adminPanelMenuItemHiddenAfterRevoke =
      !buttonWith(byTestId("db-context-menu"), "房管面板");
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    adminTarget = await emitOtherRow("无权限目标样本");
    adminTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(300);
    var noPermItems = adminItemsOf(byTestId("db-context-menu"));
    out.adminMenuItemsDisabledWithoutPermission =
      noPermItems.length === 3 && noPermItems.every(function (b) { return b.disabled; });
    out.adminMenuHintExplainsWhy = noPermItems.length === 3 &&
      noPermItems.every(function (b) { return (b.title || "").indexOf("房管") >= 0; });
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.adminPanelStaysClosed = !byTestId("db-admin-panel");
    snap();

    // ---- 滚到顶部时第一条不被头部压住（头部是文档流里的一行，不是 sticky/fixed 浮层）。
    // 放在最后量：改滚动位置会影响「跟随最新」，量完立刻还原。
    var headerBox = rect(byTestId("db-room-header"));
    var chatScroll = byTestId("db-chat-scroll");
    var keptScrollTop = chatScroll.scrollTop;
    chatScroll.scrollTop = 0;
    await sleep(300);
    var topRow = rows()[0];
    var chatScrollBox = rect(chatScroll);
    out.layoutHeaderOverlapPx = topRow
      ? Math.round((chatScrollBox.top - rect(topRow).top) * 10) / 10
      : null;
    out.layoutHeaderAboveList = headerBox.bottom <= chatScrollBox.top + 1;
    out.layoutTopRowNotCovered = !!topRow &&
      rect(topRow).top >= chatScrollBox.top - 0.5;
    out.layoutTopRowVisible = !!topRow &&
      rect(topRow).top >= chatScrollBox.top - 0.5 &&
      rect(topRow).bottom <= chatScrollBox.bottom + 1;
    chatScroll.scrollTop = keptScrollTop;
    await sleep(500);
    // 还原的判据是「又回到贴底 / 跟随状态」，不是 scrollTop 逐位相等：
    // 虚拟列表的高度估算落定后，可滚区间的最大值会差几像素，逐位比较是假失败。
    out.layoutScrollRestored =
      chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 8;
    snap();

    // ---- account 账号区一行身份 + 账号管理对话框（契约 §7 accounts_*）
    byTestId("db-header-back").click();
    await sleep(500);
    var account = byTestId("db-account");
    out.accountShown = !!account;
    // 下拉整块删掉了：单条目下拉会被读成「切换功能坏了」（用户原话「好像没法选」）
    out.accountNoDropdown = !!account && account.querySelector("select") === null;
    out.accountShowsIdentity = !!byTestId("db-account-name") &&
      byTestId("db-account-name").innerText.indexOf("本地测试") >= 0 &&
      byTestId("db-account-uid").innerText.indexOf("1000") >= 0;
    // ---- issue #8：**整行即入口**（独立的「账号」按钮已删）。这一行本身就是按钮语义：
    //      role=button + tabIndex=0 + aria-label「账号管理」，行内不再有别的可点元素。
    out.accountOpenButtonGone = byTestId("db-account-open") === null;
    out.accountRowIsEntry = !!account &&
      account.getAttribute("role") === "button" &&
      account.getAttribute("tabindex") === "0" &&
      (account.getAttribute("aria-label") || "").indexOf("账号管理") >= 0;
    out.accountRowHasNoInnerButton = !!account && account.querySelector("button") === null;
    var followBefore = window.__followCalls;
    // 停一下让跑脚本的进程抓一张「账号区只留一行」的截图
    out.accountAreaReady = out.accountShown;
    snap();
    await sleep(900);

    // 鼠标：点这一行开对话框；键盘：Enter / Space 等价（行是 div role=button，键事件由它的
    // keydown 处理 —— 焦点先落上去再派发，与真实「Tab 到这一行再按」同一条路径）。
    account.click();
    await sleep(400);
    out.accountDialogShown = !!byTestId("db-account-dialog");
    // ---- issue #3：对话框排版（宽屏 / 窄屏同一套断言，两档各量一次）
    // ① 「＋ 添加账号」在内容宽里**水平居中**（左右留白相等），且**不拉满整行** —— 拉满的行
    //    左右留白当然也相等，所以「比参照块窄」必须一起判。时序：开扫码时这枚按钮**不在 DOM 里**，
    //    所以只能在点它之前量。参照物取账号行：两者都是对话框里的一级块，都撑满内容宽。
    var addBtnNow = byTestId("db-account-add");
    var accountRowRef = allByTestId("db-account-row")[0];
    out.accountAddShownBeforeScan = !!addBtnNow;
    out.accountAddCenteredPx = addBtnNow && accountRowRef
      ? Math.round(((rect(addBtnNow).left - rect(accountRowRef).left) -
          (rect(accountRowRef).right - rect(addBtnNow).right)) * 10) / 10
      : null;
    out.accountAddCentered = out.accountAddCenteredPx !== null &&
      Math.abs(out.accountAddCenteredPx) <= 1;
    out.accountAddNotStretched = !!addBtnNow && !!accountRowRef &&
      rect(addBtnNow).width < rect(accountRowRef).width - 8;
    byTestId("db-account-close").click();
    await sleep(300);
    out.accountDialogClosedForKeyboard = !byTestId("db-account-dialog");
    pressKey(account, "Enter");
    await sleep(400);
    out.accountRowEnterOpensDialog = !!byTestId("db-account-dialog");
    byTestId("db-account-close").click();
    await sleep(300);
    pressKey(account, " ");
    await sleep(400);
    out.accountRowSpaceOpensDialog = !!byTestId("db-account-dialog");
    // 窄屏：账号对话框是自底部升起的 sheet（占满宽度、贴着视口底），可滚动、有关闭入口、热区 ≥ 40px
    if (NARROW) {
      var accountDlgEl = byTestId("db-account-dialog");
      var accountDlgRect = rect(accountDlgEl);
      var accountDlgHotspots = shortHotspots(accountDlgEl);
      put("accountDialogIsBottomSheet",
        Math.abs(accountDlgRect.bottom - window.innerHeight) < 2 &&
        Math.abs(accountDlgRect.width - document.documentElement.clientWidth) < 2);
      put("accountDialogScrollable", getComputedStyle(accountDlgEl).overflowY === "auto");
      put("accountDialogClosable", !!byTestId("db-account-close"));
      put("accountDialogHotspotsBad", accountDlgHotspots);
      put("accountDialogHotspotsAtLeast40", accountDlgHotspots.length === 0);
    }
    var rowsBefore = allByTestId("db-account-row");
    out.accountDialogRowsBefore = rowsBefore.length;
    out.accountRowShowsWho = rowsBefore.length === 1 &&
      rowsBefore[0].innerText.indexOf("本地测试") >= 0 &&
      rowsBefore[0].innerText.indexOf("uid 1000") >= 0;
    out.accountRowAvatarShown = rowsBefore.length === 1 &&
      !!rowsBefore[0].querySelector("img");
    // 窄屏：账号行里「昵称 / uid / 账号名」与操作按钮不许横向叠在一起（放不下就该换行）
    var rowUidEl = rowsBefore.length === 1
      ? rowsBefore[0].querySelector('[data-testid="db-account-row-uid"]')
      : null;
    var rowRemoveEl = rowsBefore.length === 1
      ? rowsBefore[0].querySelector('[data-testid="db-account-remove"]')
      : null;
    var rowActionsEl = rowRemoveEl ? rowRemoveEl.parentElement : null;
    put("accountRowNoOverlap", !!rowUidEl && !!rowActionsEl &&
      (rect(rowUidEl).right <= rect(rowActionsEl).left + 1 ||
        rect(rowActionsEl).top >= rect(rowUidEl).bottom - 1));
    out.accountCurrentMarked = rowsBefore.length === 1 &&
      byTestId("db-account-row-status").innerText.trim() === "已登录 · 当前";
    // 单账号时也必须看得到添加入口（用户卡住的就是这一步）
    out.accountAddShownWithOneAccount = !!byTestId("db-account-add");
    var onlyRemoveBtn = rowsBefore.length === 1 ? buttonWith(rowsBefore[0], "删除") : null;
    out.accountRemoveDisabledWithOneAccount = !!onlyRemoveBtn && onlyRemoveBtn.disabled &&
      (onlyRemoveBtn.title || "").indexOf("至少保留") >= 0;
    // ---- item 5：切换改成**非当前账号整行可点**（db-account-switch 按钮已删）。
    //      当前账号行因此没有按钮语义、也没有可切的目标：不带 role / tabindex / aria-label，
    //      点它也不会发出 account_switch。
    //      （item 6：手填 Cookie 整条链路已删，这里不再有 accountCookieEntryReachable。）
    var switchesBeforeCurrentClick =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length;
    rowsBefore[0].click();
    await sleep(300);
    out.accountCurrentRowNotSwitchable = rowsBefore.length === 1 &&
      !rowsBefore[0].getAttribute("role") && rowsBefore[0].getAttribute("tabindex") === null &&
      !rowsBefore[0].getAttribute("aria-label") &&
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length ===
        switchesBeforeCurrentClick;
    snap();
    await sleep(800);

    // 添加账号 = 默认入口：account_qr_start 不带 target，永不覆盖任何凭据
    byTestId("db-account-add").click();
    await sleep(400);
    // ---- issue #3 ②③：二维码卡片与上方的一级块**同宽**（撑满对话框内容宽，不再是贴左的
    //      fit-content）；它与上方块的间距 = 对话框的统一行间距（.accountDialog 的 gap），
    //      **不另加外边距**（改前是 fit-content 242px + margin-top 20px）。
    var qrCardEl = byTestId("db-account-qr");
    var qrRowRef = allByTestId("db-account-row")[0];
    var accountDlgForGap = byTestId("db-account-dialog");
    var accountDlgGap = accountDlgForGap
      ? parseFloat(getComputedStyle(accountDlgForGap).rowGap) : null;
    out.accountQrSameWidthAsRow = !!qrCardEl && !!qrRowRef &&
      Math.abs(rect(qrCardEl).width - rect(qrRowRef).width) <= 1;
    out.accountQrGapPx = qrCardEl && qrRowRef
      ? Math.round((rect(qrCardEl).top - rect(qrRowRef).bottom) * 10) / 10
      : null;
    out.accountQrGapIsDialogGap = out.accountQrGapPx !== null && accountDlgGap !== null &&
      Math.abs(out.accountQrGapPx - accountDlgGap) <= 1;
    var startCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; });
    var lastStart = startCalls[startCalls.length - 1];
    out.accountAddCallsQrStart = startCalls.length === 1;
    out.accountAddStartHasNoTarget = !!lastStart && lastStart.args.target === undefined;
    var qrImg = byTestId("db-account-qr-img");
    out.accountQrImgShown = !!qrImg &&
      String(qrImg.getAttribute("src")).indexOf("data:image/svg+xml") === 0;
    out.accountQrAddNeverOverwrites = byTestId("db-account-qr-warn") === null;
    out.accountQrPendingHintSaysScan =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("扫码") >= 0;
    snap();
    await sleep(900);
    await sleep(2300);
    out.accountQrScannedHintShown =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("确认") >= 0;
    await sleep(2300);
    out.accountQrClosedAfterConfirm = !byTestId("db-account-qr");
    var rowsAfterAdd = allByTestId("db-account-row");
    out.accountDialogRowsAfterAdd = rowsAfterAdd.length;
    out.accountNewRowIsCurrent = rowsAfterAdd.length === 2 &&
      rowsAfterAdd[1].innerText.indexOf("已登录 · 当前") >= 0;
    out.accountIdentityRefreshedAfterAdd = byTestId("db-account-name").innerText.indexOf("扫码新用户") >= 0;
    out.accountFollowReloadedAfterAdd = window.__followCalls > followBefore;

    // 轮询失败要能重试：面板留在原地（二维码还在）+ 给出错误原因 + 「重新获取」能再发一次
    byTestId("db-account-add").click();
    await sleep(400);
    window.__qrFail = true;
    await sleep(2400);
    out.accountQrFailureShown =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("失败") >= 0;
    out.accountQrRetryOffered = !!byTestId("db-account-qr-retry");
    var startsBeforeRetry =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    byTestId("db-account-qr-retry").click();
    await sleep(400);
    out.accountQrRetryRestarts =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length ===
      startsBeforeRetry + 1;
    out.accountQrRetryHintBackToScan =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("扫码") >= 0;
    window.__qrFail = false;
    byTestId("db-account-qr-cancel").click();
    await sleep(300);
    out.accountQrCancelClearsPanel = !byTestId("db-account-qr") && !!byTestId("db-account-add");

    // 切换：非当前账号**整行可点**即 account_switch（item 5；「切换」按钮已删），
    // 界面重拉会话并把「当前」标记挪过去；切换后按新身份重铺（item 4 的切号隔离）。
    var roomsListBeforeSwitch =
      calls.filter(function (c) { return c === "rooms_list"; }).length;
    var followBeforeSwitch = window.__followCalls;
    var rowSwitchable = rowsAfterAdd[0];
    out.accountRowSwitchableSemantics = !!rowSwitchable &&
      rowSwitchable.getAttribute("role") === "button" &&
      rowSwitchable.getAttribute("tabindex") === "0" &&
      (rowSwitchable.getAttribute("aria-label") || "").indexOf("切到") >= 0;
    rowSwitchable.click();
    await sleep(600);
    var switchCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchCalled = switchCalls.length === 1 && switchCalls[0].args.name === "default";
    var rowsAfterSwitch = allByTestId("db-account-row");
    out.accountCurrentMarkMoved = rowsAfterSwitch[0].innerText.indexOf("已登录 · 当前") >= 0 &&
      rowsAfterSwitch[1].innerText.indexOf("已登录 · 当前") < 0;
    out.accountIdentityAfterSwitch = byTestId("db-account-name").innerText.indexOf("本地测试") >= 0;
    // item 4 切号隔离：上一个身份的视角不许留下 —— 界面回到房间列表页、rooms_list 与
    // follow_list 都按新身份重拉（房间列表 / 关注列表 / 房内身份 / 房管三块 / 表情库先清后铺）。
    out.accountSwitchBackToList = !!byTestId("db-list-page") && !byTestId("db-room-tabs");
    out.accountSwitchRelistsRooms =
      calls.filter(function (c) { return c === "rooms_list"; }).length > roomsListBeforeSwitch;
    out.accountSwitchRelistsFollowed = window.__followCalls > followBeforeSwitch;
    // 键盘与鼠标等价（item 5）：Enter 换到另一个账号，再用 Space 换回来 —— 两次都走真实键事件
    rowsAfterSwitch[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(600);
    var switchCallsAfterEnter = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchByEnter = switchCallsAfterEnter.length === 2 &&
      switchCallsAfterEnter[1].args.name === "扫码新用户";
    rowsAfterSwitch[0].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await sleep(600);
    var switchCallsAfterSpace = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchBySpace = switchCallsAfterSpace.length === 3 &&
      switchCallsAfterSpace[2].args.name === "default";
    // 切回来（鼠标这一条路径），让「删除当前账号」这一步删的确实是当前那一个
    rowsAfterSwitch[1].click();
    await sleep(600);
    var switchCallsFinal = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchFinal = switchCallsFinal.length === 4 &&
      switchCallsFinal[3].args.name === "扫码新用户";
    out.accountCurrentIsScanUserAgain = byTestId("db-account-name").innerText.indexOf("扫码新用户") >= 0;

    // 重新登录 = 覆盖路径：先二次确认，且文案写清覆盖谁的凭据（原账号就是这样被顶掉的）
    var rowsNow = allByTestId("db-account-row");
    var startsBefore = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    var switchesBeforeRescan =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length;
    buttonWith(rowsNow[0], "重新登录").click();
    await sleep(250);
    var overwriteConfirm = byTestId("db-account-confirm");
    out.accountRescanNeedsConfirm = !!overwriteConfirm &&
      overwriteConfirm.innerText.indexOf("覆盖") >= 0 &&
      overwriteConfirm.innerText.indexOf("default") >= 0;
    out.accountRescanNotStartedBeforeConfirm =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length === startsBefore;
    // item 5 的另一半：行**内**的动作按钮不冒泡到行 —— 点「重新登录」不该顺带切号
    out.accountRowActionDoesNotSwitch =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length ===
        switchesBeforeRescan;
    buttonWith(overwriteConfirm, "取消").click();
    await sleep(200);
    out.accountRescanConfirmDismissed = !byTestId("db-account-confirm");

    // 删除当前账号：二次确认 → 后端删掉后自动切到剩下的那个
    buttonWith(rowsNow[1], "删除").click();
    await sleep(250);
    var delConfirm = byTestId("db-account-confirm");
    out.accountRemoveConfirmShown = !!delConfirm &&
      delConfirm.innerText.indexOf("不可恢复") >= 0 &&
      delConfirm.innerText.indexOf("扫码新用户") >= 0;
    buttonWith(delConfirm, "确认删除").click();
    await sleep(700);
    var delCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_remove"; });
    out.accountRemoveCalledWithCurrent = delCalls.length === 1 &&
      delCalls[0].args.name === "扫码新用户";
    var rowsAfterRemove = allByTestId("db-account-row");
    out.accountRemoveFallsBackToOther = rowsAfterRemove.length === 1 &&
      rowsAfterRemove[0].innerText.indexOf("本地测试") >= 0 &&
      rowsAfterRemove[0].innerText.indexOf("已登录 · 当前") >= 0;
    var leftRemoveBtn = rowsAfterRemove.length === 1 ? buttonWith(rowsAfterRemove[0], "删除") : null;
    out.accountRemoveDisabledWithOneLeft = !!leftRemoveBtn && leftRemoveBtn.disabled;

    // 退出登录 = 清凭据、退回游客态（账号条目保留）
    buttonWith(rowsAfterRemove[0], "退出登录").click();
    await sleep(250);
    var logoutConfirm = byTestId("db-account-confirm");
    out.accountLogoutConfirmExplains = !!logoutConfirm &&
      logoutConfirm.innerText.indexOf("游客态") >= 0 &&
      logoutConfirm.innerText.indexOf("本地测试") >= 0;
    buttonWith(logoutConfirm, "确认退出登录").click();
    await sleep(700);
    out.accountLogoutCalled = calls.indexOf("account_logout") >= 0;
    out.accountRowShowsNotLoggedIn =
      (byTestId("db-account-row-status") || { innerText: "" }).innerText.trim() === "未登录";
    byTestId("db-account-close").click();
    await sleep(400);
    out.accountBackToGuest = !!byTestId("db-account-guest") && !byTestId("db-account-dialog");
    out.accountGuestTextShown = (byTestId("db-account-guest") || { innerText: "" })
      .innerText.indexOf("游客态") >= 0;
    // 游客态那一行**同样可点**（issue #8：那时它的作用就是去登录）—— 键盘 Enter 一样开对话框
    var guestRow = byTestId("db-account");
    out.accountGuestRowIsEntry = !!guestRow &&
      guestRow.getAttribute("role") === "button" &&
      guestRow.getAttribute("tabindex") === "0" &&
      (guestRow.getAttribute("aria-label") || "").indexOf("账号管理") >= 0;
    pressKey(guestRow, "Enter");
    await sleep(400);
    out.accountGuestRowOpensDialog = !!byTestId("db-account-dialog");
    byTestId("db-account-close").click();
    await sleep(300);
    out.accountGuestDialogCloses = !byTestId("db-account-dialog");

    // ---- #18 房间标签条：显示主播名，不显示房间号。
    // 标签条只在**多于一个**房间时渲染（App 既有语义）。第二个房间在**多标签隔离**那一段
    // （房间页里）就已经登记进替身了，这里只需走一次真实路径把它带回界面：
    // 点房间卡 → openRoom → connect 会重拉 rooms_list —— 这一轮之后 store 里就有两个房间。
    // （__addSecondRoom 是幂等的，重复调用不会多出一条。）
    // 主页**不挂**弹幕页的标签条（用户 2026-09-12：与主页的「已连接房间」卡片列表重复）。
    // 这里正是「有两个房间」的状态 —— 旧实现下标签条就是在这个条件下冒出来的。
    out.listPageNoRoomTabs = !byTestId("db-room-tabs") && allByTestId("db-room-tab").length === 0;
    byTestId("db-room-card").click();
    await sleep(800);
    var tabs = allByTestId("db-room-tab");
    out.roomTabsInsideRoom = !!byTestId("db-room-tabs");
    out.tabsRendered = tabs.length === 2;
    // 有名字的那个标签：报的是**真实载荷**里的主播名，且不露房间号。
    var namedTab = tabs.filter(function (t) {
      return t.innerText.indexOf(fixtureRoom.anchor_uname) >= 0;
    })[0];
    out.tabShowsAnchorNames = !!namedTab && tabs.length === 2;
    out.tabHidesRoomNumbers = !!namedTab && namedTab.innerText.indexOf("5440") < 0;
    // 没有名字的那个标签（上游名与标题都缺）：只能报房间号——但**不许**报「未命名直播间」，
    // 那个词既不说明是哪个房间，又像真名字（用户 2026-09-12 报的就是它）。
    out.tabFallbackShowsRoomNumber = tabs.length === 2 &&
      tabs.some(function (t) { return t.innerText.indexOf("房间 5555") >= 0; }) &&
      tabs.every(function (t) { return t.innerText.indexOf("未命名直播间") < 0; });
    // ---- 两处圆点**同一状态同色**（用户 2026-09-13：「橙色的需求改成灰色，但是下面的标题栏
    //      左边还是之前的样子」+ 追加「标题旁的断连确实没变化（只有红绿）」）。房间头那颗与
    //      标签页那颗现在是**同一个判据（liveKindOf）、同一组令牌（--live-*）、同一条 .liveDot 规则**，
    //      这条断言把它钉死：三态各走一遍，量每一处的**计算色**与 data-state。
    //      两个房间发同一组事件（含载荷里的 connected ——「连没连上」是两路信号取与），
    //      所以「哪个标签是当前激活的那个」不影响结论。
    var tabDotEls = function () { return allByTestId("db-tab-dot"); };
    var headerDotNow = function () {
      var dot = byTestId("db-live-dot");
      return dot ? getComputedStyle(dot).backgroundColor : null;
    };
    var headerStateNow = function () {
      var box = byTestId("db-live-dot-box");
      return box ? box.getAttribute("data-state") : null;
    };
    var tabColorsNow = function () {
      return tabDotEls().map(function (el) { return getComputedStyle(el).backgroundColor; });
    };
    var pairAt = async function (conn, liveStatus) {
      [fixtureRoom.room_id, 5555].forEach(function (id) {
        window.__emit("danmubox://status", { room_id: id, state: conn, detail: "" });
        window.__emit("danmubox://room", {
          room_id: id, live_status: liveStatus, connected: conn === "connected",
        });
      });
      await sleep(350);
      return {
        header: headerDotNow(),
        headerState: headerStateNow(),
        tabs: tabColorsNow(),
        tabStates: tabDotEls().map(function (el) { return el.getAttribute("data-state"); }),
      };
    };
    var dotPairs = [
      { kind: "on", want: cssColorOf("--live-on"), at: await pairAt("connected", 1) },
      { kind: "off", want: cssColorOf("--live-off"), at: await pairAt("connected", 0) },
      { kind: "idle", want: cssColorOf("--live-idle"),
        at: await pairAt("disconnected", fixtureRoom.live_status) },
    ];
    out.liveDotPairColors = dotPairs.map(function (p) {
      return { kind: p.kind, want: p.want, header: p.at.header, tabs: p.at.tabs };
    });
    out.liveDotTwoSitesSameColor = dotPairs.every(function (p) {
      return p.at.tabs.length === 2 && p.at.header === p.want &&
        p.at.tabs.every(function (c) { return c === p.want; });
    });
    out.liveDotTwoSitesSameState = dotPairs.every(function (p) {
      return p.at.headerState === p.kind && p.at.tabStates.length === 2 &&
        p.at.tabStates.every(function (s) { return s === p.kind; });
    });
    // 尺寸**维持现状**：标签页那颗点换的只是配色来源（旧 .dot 的 --sp-2 → 现在这条 .liveDot
    // 的 --live-dot），看得见的那颗点仍是 8px、外壳（热区 / 悬停面）仍是 12px。
    var firstTabDot = tabDotEls()[0];
    out.tabDotSizePx = firstTabDot ? Math.round(rect(firstTabDot).width * 10) / 10 : null;
    out.tabDotSizeUnchanged = !!firstTabDot &&
      Math.abs(rect(firstTabDot).width - cssLengthOf("--live-dot")) < 0.6 &&
      Math.abs(rect(firstTabDot).width - 8) < 0.6;
    // 收尾就停在**未连接（灰）**那一档：最后那张截图因此看得到灰点（两处都是灰的）。
    snap();

    out.done = true;
    snap();
  };
  document.addEventListener("__smoke-cmd", function (e) {
    if ((e.detail || {}).type === "run") window.__smoke_run();
  });
})();`;

export function buildSmokeHtml(theme = THEME) {
  const assets = new URL("../dist/assets/", import.meta.url);
  const names = readdirSync(assets);
  const js = readFileSync(
    new URL(names.find((n) => n.endsWith(".js")), assets),
    "utf8",
  );
  const css = readFileSync(
    new URL(names.find((n) => n.endsWith(".css")), assets),
    "utf8",
  );
  // 注入顺序要紧：先装 IPC 替身，再跑 type=module 的产物
  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8" /><style>' +
    css +
    '</style></head><body><div id="root"></div><script>' +
    MOCK(theme) +
    '</script><script type="module">' +
    js +
    "</script></body></html>"
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.env.SMOKE_OUT ?? "/tmp/danmubox-ui-smoke.html";
  const html = buildSmokeHtml();
  writeFileSync(out, html);
  console.log("已生成 " + out + "（" + html.length + " 字节）");
}
