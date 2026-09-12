// 房间页 UI 冒烟：无头 Chromium + mock IPC，把整套断言跑在真实的 dist 产物上。
//
// 复现（一条命令，自己起 Chrome，不依赖 relay 标签页）：
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs
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
//          回复关系可见；舰长标只认本房间的 guard_level
//   emotes 主站「我的表情」分组可见、能选中、发出去带的是唯一键
//   menu   右键出菜单（复制 / ＠TA / 回复 / 屏蔽 / 主页 / 举报）并能关掉
//   mention＠ 目标与文本同源：文本里的 @名字 被删掉后发送就不带目标；回复的引用条照旧带目标
//   time   时间戳默认不渲染；开关打开后每行一列且等宽（纵向对齐）
//   gift   礼物栏在输入区下方、全宽、可折叠，展开不改变弹幕宽度
//   admin  房管权限前置（是房管才可用 / 不是则置灰并说明）、写操作二次确认与请求形状、
//          面板三块列表增删、无权限时只读面板仍可打开且原样展示上游 code + message
//   follow 未开播也列出、按最后开播时间排序、>30 条分页
//   account 新增账号 = profiles_create + 自动扫码；单 profile 时禁止删除

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MOCK = `(function () {
  var listeners = {};
  var calls = [];
  // 带参数的调用记录（看请求形状，如 chat_send 的表情唯一键）；calls 只有命令名，保持原样。
  var callsWithArgs = [];
  var nextId = 1;
  var prefs = {
    "ui.font_scale": 1, "ui.theme": "system", "ui.auto_scroll": true,
    "ui.pause_on_hover": false, "ui.merge_similar": true, "ui.merge_window_ms": 8000,
    "ui.gift_panel_mode": "merged", "ui.interact_auto_hide": true, "ui.system_notice": false,
    "ui.show_timestamp": false,
    "composer.phrases": ["早上好"], "filter.keywords": [], "filter.keywords_mode": "hide",
    "filter.keywords_alert": false, "filter.uids": [],
    "filter.kinds": ["danmaku", "gift", "superchat", "interact", "guard", "system"],
    "filter.medal_level_min": 0, "history.buffer_rows": 5000
  };
  var nextLocal = 1;
  function msg(kind, content, isHistory, extra) {
    nextLocal += 1;
    var base = {
      local_id: nextLocal, room_id: 5440, kind: kind, ts: Date.now(),
      uid: 500 + nextLocal, uname: kind === "interact" ? "进场观众" + nextLocal : "观众" + nextLocal,
      content: content, color: 0, medal_level: 0, medal_name: "", guard_level: 0,
      medal_guard_level: 0, reply_to_uid: 0, reply_to_uname: "",
      is_admin: false, face: "", is_history: !!isHistory, amount: 0, combo_id: "",
      emote: null, upstream_id: "smoke-" + nextLocal
    };
    for (var key in (extra || {})) base[key] = extra[key];
    return base;
  }
  // 关注列表：上游顺序刻意打乱，用来看排序是否真按最后开播时间生效；
  // 再补 28 条凑够 31 条，验证「>30 条才出现分页」。
  var followed = [
    { room_id: 300, uname: "离线甲", face: "", live_status: 0, group_name: "", live_start_at: 1700000000, online: 0 },
    { room_id: 100, uname: "在播主播", face: "", live_status: 1, group_name: "", live_start_at: 1789000000, online: 500 },
    { room_id: 200, uname: "离线乙", face: "", live_status: 0, group_name: "", live_start_at: 1789500000, online: 0 }
  ];
  for (var i = 1; i <= 28; i += 1) {
    followed.push({
      room_id: 400 + i, uname: "填充" + (i < 10 ? "0" + i : i), face: "",
      live_status: 0, group_name: "", live_start_at: 1000000000 + i, online: 0
    });
  }
  var profiles = ["default"];
  var session = { logged_in: true, uid: 1000, nickname: "本地测试", active_profile: "default" };
  var history = msg("danmaku", "这是进场回填的历史弹幕", true);
  window.__smoke_next = function () { return msg; };
  window.__calls = calls;
  window.__callsWithArgs = callsWithArgs;
  window.__prefs = prefs;
  window.__followCalls = 0;
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
        case "profiles_list": return Promise.resolve(profiles.slice());
        case "profiles_switch": { session = { logged_in: true, uid: 1000, nickname: args.name, active_profile: args.name }; return Promise.resolve(session); }
        case "profiles_create": { if (profiles.indexOf(args.name) < 0) profiles.push(args.name); session = { logged_in: false, uid: 0, nickname: "", active_profile: args.name }; return Promise.resolve(session); }
        case "profiles_remove": { profiles = profiles.filter(function (n) { return n !== args.name; }); session = { logged_in: true, uid: 1000, nickname: "本地测试", active_profile: profiles[0] || "default" }; return Promise.resolve(session); }
        case "session_qr_start": return Promise.resolve({ key: "k", url: "https://example.invalid/qr", svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fff"/></svg>' });
        case "session_qr_poll": return Promise.resolve({ state: "pending", session: session });
        case "rooms_list": return Promise.resolve([{ room_id: 5440, short_id: 0, anchor_uid: 2, title: "测试房间", live_status: 1, connected: true, buffered: 1 }]);
        case "prefs_get": return Promise.resolve(Object.assign({}, prefs));
        case "prefs_set": Object.assign(prefs, args.patch); return Promise.resolve(Object.assign({}, prefs));
        case "follow_list": window.__followCalls += 1; return Promise.resolve(followed.slice());
        case "history_query": return Promise.resolve([history]);
        case "emotes_list": return Promise.resolve([
          { key: "common:1", emoticon_unique: "official_1", width: 20, height: 20, is_dynamic: false, in_player_area: false, bulge_display: false, package_kind: "common", text: "[大笑]", url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%23f09300'/></svg>", room_id: 0 },
          { key: "room:1", emoticon_unique: "room_5440_1", width: 60, height: 60, is_dynamic: false, in_player_area: false, bulge_display: false, package_kind: "room", text: "[房间专属]", url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%23f09300'/></svg>", room_id: 5440 }
        ]);
        case "report_reasons": return Promise.resolve([{ id: 1, reason: "垃圾广告" }]);
        // 主站「我的表情」：用户点名要的那条必须能从面板发回去（issue #8）。
        case "emotes_owned": return Promise.resolve([
          { key: "owned:1", emoticon_unique: "upower_[Kirikosama_吃瓜]", width: 1, height: 1, is_dynamic: false, in_player_area: false, bulge_display: false, package_kind: "owned", text: "[Kirikosama_吃瓜]", url: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='%23e67e22'/></svg>", room_id: 0 }
        ]);
        case "chat_send": return Promise.resolve({ room_id: args.roomId, content: args.content, outcome: "ok", detail: null });
        // 房内身份（房管权限前置）+ 房管只读三块 + 写操作（替身只记调用，不动真上游）。
        case "room_session": return Promise.resolve({ room_id: args.roomId, my_medal_level: 0, my_medal_name: "", my_guard_level: 0, is_admin: window.__admin });
        case "admin_silent_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve([{ uid: 900, uname: "被禁言的观众", face: "" }]);
        case "admin_blacklist_list": return Promise.resolve([{ uid: 901, uname: "黑名单观众", face: "" }]);
        case "admin_keywords_list": return Promise.resolve(["刷屏", "广告"]);
        case "admin_mute":
        case "admin_unmute":
        case "admin_blacklist_add":
        case "admin_blacklist_del":
        case "admin_keywords_add":
        case "admin_keywords_del": return Promise.resolve(null);
        case "wallet_balance": return Promise.resolve(150);
        case "rooms_connect": return Promise.resolve(null);
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
  var clickTool = function (label) {
    var b = buttonWith(null, label);
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

  window.__smoke_run = async function () {
    // ---- step1 关注列表自动加载 + 列表页展示关注项（语义不得改）
    await sleep(900);
    out.step1_followCalls = window.__followCalls;
    out.step1_roomListShowsFollowed = text().indexOf("在播主播") >= 0;
    // follow：未开播也列出、按最后开播时间排序、分页
    var followNames = allByTestId("db-follow-item").map(function (el) { return el.innerText.split("\\n")[0]; });
    out.followOrder = followNames.slice(0, 3);
    out.followPage1Count = followNames.length;
    out.followPagerShown = !!document.querySelector('[class*="pager"]');
    out.followNonLiveListed = followNames.indexOf("离线乙") >= 0 && followNames.indexOf("离线甲") >= 0;
    out.accountArea = !!byTestId("db-account");
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
    window.__emit("danmubox://message", window.__mk("interact", ""));
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
    window.__emit("danmubox://message", window.__mk("danmaku", "这条是回复", false, {
      reply_to_uid: 777, reply_to_uname: "被回复的人"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "他房间的牌子弹幕", false, {
      medal_level: 7, medal_name: "外间牌", medal_guard_level: 3, guard_level: 0
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "本房间的大航海弹幕", false, {
      guard_level: 3
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
    // 回复关系可见（issue #13b）：只有真正的回复才画「回复 @昵称」
    var replyRow = rowWith("这条是回复");
    var replyLabel = replyRow ? replyRow.querySelector('[data-testid="db-msg-reply"]') : null;
    out.replyLabelShown = !!replyLabel && replyLabel.innerText.indexOf("被回复的人") >= 0;
    var plainRow = rowWith("无头像的弹幕");
    out.replyLabelAbsentWhenNotReply = !!plainRow &&
      !plainRow.querySelector('[data-testid="db-msg-reply"]');
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
    out.layoutPanelAboveComposer = !!panel && !!document.querySelector("textarea") &&
      (panel.compareDocumentPosition(document.querySelector("textarea")) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    out.layoutChatShrankPx = Math.round(before.height - after.height);
    // 「唯一生长区」的双向判：面板展开时只有弹幕列表变矮，头部与输入区纹丝不动
    out.layoutOnlyChatShrank =
      Math.abs(rect(headerEl).height - headerBefore) < 1 &&
      Math.abs(rect(composerEl).height - composerBefore) < 1 &&
      before.height - after.height > 50;
    out.layoutNewestNotCovered = !!newestAfter && rect(newestAfter).bottom <= rect(panel).top + 1;
    // 更硬的两条：视口仍在底部（跟随模式重新贴底），且渲染出的最后一行确实是最后一条消息
    out.layoutFollowingAtBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    out.layoutLastRowIsNewest = !!newestAfter && newestAfter.innerText.indexOf("无头像的弹幕") >= 0;
    // 通用表情与非通用表情的尺寸分级（issue #8：非通用放大）
    out.layoutEmoteSizes = [].slice.call(panel.querySelectorAll("button img")).map(function (img) {
      return {
        height: Math.round(img.getBoundingClientRect().height),
        big: img.parentElement.className.indexOf("pickerItemBig") >= 0
      };
    });
    var commonH = out.layoutEmoteSizes.filter(function (x) { return !x.big; })[0];
    var bigH = out.layoutEmoteSizes.filter(function (x) { return x.big; })[0];
    out.layoutNonCommonEmoteBigger = !!commonH && !!bigH && bigH.height >= commonH.height * 1.4;
    // 面板还开着就先把快照写进去、并多停 1.5s：跑脚本的进程据此抓一张「面板已展开」的截图
    snap();
    await sleep(1500);
    clickTool("表情");
    await sleep(200);

    // ---- emotes 主站「我的表情」：分组可见、选得到、发出去带的是唯一键（issue #8）
    out.emotesOwnedCalled = calls.indexOf("emotes_owned") >= 0;
    clickTool("表情");
    await sleep(400);
    var emotePanel = byTestId("db-panel");
    out.ownedGroupShown = !!emotePanel && emotePanel.innerText.indexOf("我的表情") >= 0;
    var ownedPicker = emotePanel
      ? emotePanel.querySelector('button[title="[Kirikosama_吃瓜]"]')
      : null;
    out.ownedEmoteShown = !!ownedPicker;
    if (ownedPicker) {
      ownedPicker.click();
      await sleep(250);
    }
    out.ownedEmoteInserted = document.querySelector("textarea").value === "[Kirikosama_吃瓜]";
    // 预览把表情名换成图片，说明「我的表情」确实在接口那一侧（学到的表情只是补漏）
    var sendPreview = byTestId("db-send-preview");
    out.ownedEmotePreviewImage = !!sendPreview &&
      [].slice.call(sendPreview.querySelectorAll("img")).some(function (img) {
        return img.alt === "[Kirikosama_吃瓜]";
      });
    buttonWith(null, "发送").click();
    await sleep(400);
    var chatSends = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
    var lastChatSend = chatSends[chatSends.length - 1];
    // 表情弹幕上游收到的 msg 就是 emoticon_unique（crates/danmubox-bili/src/send.rs），
    // 因此这两条断言等于「上游会收到 upower_[Kirikosama_吃瓜]」。
    out.ownedEmoteSendUnique = !!lastChatSend && !!lastChatSend.args.emote &&
      lastChatSend.args.emote.emoticon_unique === "upower_[Kirikosama_吃瓜]";
    out.ownedEmoteSendContent = !!lastChatSend && lastChatSend.args.content === "[Kirikosama_吃瓜]";
    out.ownedEmoteDraftCleared = document.querySelector("textarea").value === "";
    snap();

    // ---- menu 右键菜单
    var target = rows()[rows().length - 1];
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

    // ---- time 时间戳（默认关 → 打开后等宽对齐）
    out.timeCellsDefault = allByTestId("db-msg-time").length;
    clickTool("筛选");
    await sleep(300);
    var filterPanel = byTestId("db-panel");
    out.filterPanelShown = !!filterPanel;
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

    // ---- step5 互动行 8 秒后自动消失（语义不得改）
    await sleep(8600);
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
    clickTool("短语");
    await sleep(200);

    buttonWith(null, "⋯").click();
    await sleep(250);
    var headerMenu = byTestId("db-context-menu");
    out.headerMenuItems = headerMenu ? [].slice.call(headerMenu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.headerMenuClosed = !byTestId("db-context-menu");
    snap();

    // ---- admin 房管（issue #3）：权限前置、写操作二次确认、面板三块与错误原样展示
    out.adminIdentityFetched = calls.indexOf("room_session") >= 0;
    var adminTarget = rows()[rows().length - 1];
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

    // 面板：三块列表；增删同样先二次确认
    buttonWith(null, "⋯").click();
    await sleep(250);
    var headerMenu2 = byTestId("db-context-menu");
    out.adminPanelMenuItemShown = !!buttonWith(headerMenu2, "房管面板");
    buttonWith(headerMenu2, "房管面板").click();
    await sleep(600);
    var adminPanel = byTestId("db-admin-panel");
    out.adminPanelShown = !!adminPanel;
    out.adminPanelSections = adminPanel
      ? ["禁言名单（1）", "黑名单（1）", "屏蔽词（2）"].filter(function (t) {
          return adminPanel.innerText.indexOf(t) >= 0;
        })
      : [];
    out.adminPanelListsRendered = out.adminPanelSections.length === 3;
    out.adminPanelItemCounts = [
      allByTestId("db-admin-silent-item").length,
      allByTestId("db-admin-blacklist-item").length,
      allByTestId("db-admin-keyword-item").length
    ];
    // 停一下让跑脚本的进程抓一张「房管面板三块」的截图
    snap();
    await sleep(1200);
    buttonWith(allByTestId("db-admin-keyword-item")[0], "删除").click();
    await sleep(300);
    var wordConfirm = byTestId("db-admin-confirm");
    out.adminKeywordConfirmShown = !!wordConfirm && wordConfirm.innerText.indexOf("刷屏") >= 0;
    buttonWith(wordConfirm, "确认删除").click();
    await sleep(600);
    var wordDels = callsWithArgs.filter(function (c) { return c.cmd === "admin_keywords_del"; });
    var lastWordDel = wordDels[wordDels.length - 1];
    out.adminKeywordDelRequestShape = !!lastWordDel &&
      lastWordDel.args.roomId === 5440 && lastWordDel.args.word === "刷屏";

    // 无权限：菜单三项置灰并说明原因；只读面板照常打开，上游错误原样展示 code + message
    window.__setAdmin(false);
    window.__setAdminFail(true);
    buttonWith(byTestId("db-admin-panel"), "刷新").click();
    await sleep(700);
    var panelText = byTestId("db-admin-panel").innerText;
    out.adminPanelErrorRaw = panelText.indexOf("不是管理员") >= 0 && panelText.indexOf("UPSTREAM_ERROR") >= 0;
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    adminTarget = rows()[rows().length - 1];
    adminTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(300);
    var noPermItems = adminItemsOf(byTestId("db-context-menu"));
    out.adminMenuItemsDisabledWithoutPermission =
      noPermItems.length === 3 && noPermItems.every(function (b) { return b.disabled; });
    out.adminMenuHintExplainsWhy = noPermItems.length === 3 &&
      noPermItems.every(function (b) { return (b.title || "").indexOf("房管") >= 0; });
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.adminReadOnlyPanelStillOpen = !!byTestId("db-admin-panel");
    snap();

    // ---- account 新增账号 = profiles_create + 自动扫码；单 profile 禁止删除
    document.querySelector("button").click();
    await sleep(500);
    var account = byTestId("db-account");
    out.accountShown = !!account;
    if (account) {
      var removeBtn = buttonWith(account, "删除该账号");
      out.accountRemoveDisabledWithOneProfile = !!removeBtn && removeBtn.disabled;
      var nameInput = account.querySelector("input");
      var createBtn = buttonWith(account, "新建并扫码");
      typeInto(nameInput, "账号二");
      await sleep(150);
      createBtn.click();
      await sleep(700);
      out.accountProfilesCreateCalled = calls.indexOf("profiles_create") >= 0;
      out.accountQrAutoStarted = calls.indexOf("session_qr_start") >= 0;
      out.accountProfileOptions = account.querySelectorAll("select option").length;
    }
    out.done = true;
    snap();
  };
  document.addEventListener("__smoke-cmd", function (e) {
    if ((e.detail || {}).type === "run") window.__smoke_run();
  });
})();`;

export function buildSmokeHtml() {
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
    MOCK +
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
