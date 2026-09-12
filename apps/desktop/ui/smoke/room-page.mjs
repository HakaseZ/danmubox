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
//          回复关系可见；舰长标只认本房间的 guard_level
//   emotes 主站「我的表情」分组可见、能选中、发出去带的是唯一键
//   menu   右键出菜单（复制 / ＠TA / 回复 / 屏蔽 / 主页 / 举报）并能关掉
//   mention＠ 目标与文本同源：文本里的 @名字 被删掉后发送就不带目标；回复的引用条照旧带目标
//   time   时间戳默认不渲染；开关打开后每行一列且等宽（纵向对齐）
//   gift   礼物栏在输入区下方、全宽、可折叠，展开不改变弹幕宽度
//   admin  房管权限前置（是房管才可用 / 不是则置灰并说明）、写操作二次确认与请求形状、
//          面板三块列表增删、无权限时只读面板仍可打开且原样展示上游 code + message
//   follow 未开播也列出、按最后开播时间排序、>30 条分页
//   account 账号区只留一行身份 + 「账号」按钮（不再有下拉——单条目下拉会被读成功能坏了）；
//          对话框里一行一个账号（昵称 + uid + 状态 + 操作）；单账号也能看到「＋ 添加账号」；
//          添加 = account_qr_start（不带 target，永不覆盖）+ 2 秒轮询到 confirmed 后多一行且标为当前；
//          「重新登录」要二次确认且文案写明会覆盖谁；删除当前账号后自动切走、只剩一个时禁止删除；
//          退出登录后退回游客态；手填 Cookie 入口可达

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
  // 账号（契约 §7 accounts_list）：条目自带登录状态与身份。
  var accounts = [
    {
      name: "default", nickname: "本地测试", uid: 1000, logged_in: true, active: true,
      face: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%2300aeec'/></svg>"
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
        case "account_login_cookie": {
          var cname = args.name || "cookie账号";
          accounts.forEach(function (a) { a.active = false; });
          accounts.push({ name: cname, nickname: args.name || "Cookie用户", uid: 3000, face: "", logged_in: true, active: true });
          syncSession();
          return Promise.resolve(accounts[accounts.length - 1]);
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

  window.__smoke_run = async function () {
    // 视口：390×844（窄屏，竖屏手机比例）与 1440×900（宽屏）各跑一遍。
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
    out.followNonLiveListed = followNames.indexOf("离线乙") >= 0 && followNames.indexOf("离线甲") >= 0;
    out.accountArea = !!byTestId("db-account");
    // 列表页在窄屏也不许横向滚动（关注项一行放不下要换行）
    var listPage = byTestId("db-list-page");
    put("listNoHorizontalScroll", !!listPage &&
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      listPage.scrollWidth <= listPage.clientWidth);
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
    // 窄屏：头部（在线 / 看过 / 电池）与弹幕列表都不许横向滚动——放不下就换行，不许溢出
    var headerEl0 = byTestId("db-room-header");
    var scrollerEl0 = byTestId("db-chat-scroll");
    put("headerNoHorizontalScroll", headerEl0.scrollWidth <= headerEl0.clientWidth);
    put("chatNoHorizontalScroll", scrollerEl0.scrollWidth <= scrollerEl0.clientWidth + 1);
    put("pageNoHorizontalScroll",
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.body.scrollWidth <= document.body.clientWidth);
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
    window.__emit("danmubox://message", window.__mk("danmaku", "这条是回复", false, {
      reply_to_uid: 777, reply_to_uname: "被回复的人", reply_uname_color: "#FB7299"
    }));
    // 上游没给配色（空串）时不上色：**空串不是颜色**，与粉丝牌真彩色同一口径
    window.__emit("danmubox://message", window.__mk("danmaku", "没有配色的回复", false, {
      reply_to_uid: 778, reply_to_uname: "另一个被回复的人", reply_uname_color: ""
    }));
    // 排版样本（issue #8 的「一条弹幕要像一个整体」）：
    // ① 长正文：在 390 与 1440 两个视口都会折行，用来量折行后的首字位置；
    // ② 带徽标 + 昵称 + 正文的行：用来量「徽标组→昵称」与「昵称→正文」两道间距。
    window.__emit("danmubox://message", window.__mk("danmaku",
      "折行样本：" + "身份属于人名，正文属于内容，两者之间要分开；折行之后每一行都要与首行文字左对齐，而不是回到头像下面。".repeat(3)));
    window.__emit("danmubox://message", window.__mk("danmaku", "紧贴昵称的徽标弹幕", false, {
      uname: "身份样本", medal_level: 7, medal_name: "紧贴牌", guard_level: 3
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
    // 被 @ 的名字用上游给的 reply_uname_color 上色；空串则保持标记自身的弱化色（不上色）
    var replyNameEl = replyRow ? replyRow.querySelector('[data-testid="db-msg-reply-name"]') : null;
    var replyNamePaint = replyNameEl
      ? (replyNameEl.getAttribute("style") || "") + "|" + getComputedStyle(replyNameEl).color
      : "";
    out.replyNameColorApplied =
      replyNamePaint.indexOf("#FB7299") >= 0 || replyNamePaint.indexOf("251, 114, 153") >= 0;
    var noColorRow = rowWith("没有配色的回复");
    var noColorNameEl = noColorRow ? noColorRow.querySelector('[data-testid="db-msg-reply-name"]') : null;
    out.replyNameColorAbsentWhenEmpty = !!noColorNameEl &&
      (noColorNameEl.getAttribute("style") || "") === "";
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

    // ---- 排版的「整体感」：一行里的间距只有两种（贴 / 分）
    // 徽标组属于人名（紧贴昵称），昵称与正文之间才是「分」。
    var badgeRow = rowWith("紧贴昵称的徽标弹幕");
    var badgesEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-badges"]') : null;
    var badgeNameEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-name"]') : null;
    var badgeBodyEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-body"]') : null;
    out.layoutBadgeNameGap = badgesEl && badgeNameEl
      ? Math.round((rect(badgeNameEl).left - rect(badgesEl).right) * 10) / 10
      : null;
    out.layoutNameBodyGap = badgeNameEl && badgeBodyEl
      ? Math.round((rect(badgeBodyEl).left - rect(badgeNameEl).right) * 10) / 10
      : null;
    out.layoutBadgeGroupTightWithName =
      out.layoutBadgeNameGap !== null && out.layoutNameBodyGap !== null &&
      out.layoutBadgeNameGap < out.layoutNameBodyGap;

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
    // 行数 ≥ 2 才算真的折了行，否则这条断言是「空对空」
    out.layoutHangIndentAligned = lineRects.length >= 2 &&
      Math.abs(lineRects[lineRects.length - 1].left - lineRects[0].left) < 1;

    // ---- 头像对齐口径：**垂直居中于首行**（钉在首行，不随折行掉到行的中间）
    var avatarColEl = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-avatar-col"]') : null;
    var wrapRowRect = rect(wrapRow);
    var avatarRect = rect(avatarColEl);
    var firstLine = lineRects[0];
    out.layoutAvatarFirstLineDelta = firstLine && avatarRect
      ? Math.round(((avatarRect.top + avatarRect.height / 2) -
          (firstLine.top + firstLine.height / 2)) * 10) / 10
      : null;
    out.layoutAvatarAlignedToFirstLine = out.layoutAvatarFirstLineDelta !== null &&
      Math.abs(out.layoutAvatarFirstLineDelta) < 3;
    // 反面对照：这一行折了 3 行左右，头像若按「整行居中」会明显更低
    out.layoutAvatarNotRowCentered = !!firstLine && !!avatarRect && !!wrapRowRect &&
      (avatarRect.top + avatarRect.height / 2) <
        (wrapRowRect.top + wrapRowRect.height / 2) - 4;

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
    // 面板在**两个视口**都是文档流里的一块（不是浮层）——「只挤列表、不遮最新一条」
    // 由上面的 layoutOnlyChatShrank / layoutNewestNotCovered 按同一口径断言。
    out.panelInline = getComputedStyle(panel).position !== "fixed";
    clickTool("表情");
    await sleep(300);

    // ---- 面板展开 → 收起一轮之后，「跟随最新」必须还活着
    // 修复前：收起面板会让容器变高、可滚区间变大，onScroll 只看几何就把 following 判成 false，
    // 于是列表停在半路、最新一条被推出视口，界面上只剩「回到最新」按钮在提示。
    // 判据取两条：几何上仍贴底（bottomGap < 8），且 UI 自己说的状态按钮不出现
    // （db-bottom-anchor 只在 !following 时渲染，是 following 的对外可观察面）。
    out.layoutFollowingAfterPanelToggle = bottomGap(byTestId("db-chat-scroll")) < 8;
    out.layoutNoJumpButtonAfterPanelToggle = !byTestId("db-bottom-anchor");

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
      put("panelScrollsInternally", getComputedStyle(narrowPanel).overflowY === "auto");
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
      put("panelClosable", !!byTestId("db-panel-close"));
      var panelCloseBtn = byTestId("db-panel-close");
      if (panelCloseBtn) {
        panelCloseBtn.click();
        await sleep(300);
      }
      put("panelCloseWorks", !byTestId("db-panel"));
    }

    // ---- 面板展开会改可视高度：**正在看的位置不能被弹走**
    // 先把列表停在中间（此时不在底部 = 非跟随模式），再展开面板，量同一个行在视口里的
    // 位置变化。跟随模式下重新贴底是**有意**的（见 MessageList 的 ResizeObserver），
    // 所以这里量的是「用户自己滚上去看历史」时的行为。
    var stableScroll = byTestId("db-chat-scroll");
    stableScroll.scrollTop = Math.round((stableScroll.scrollHeight - stableScroll.clientHeight) * 0.55);
    await sleep(300);
    out.layoutPausedBeforePanel = stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight > 8;
    // 另一半：**用户自己往上滚**必须真的降为「不跟随」——判据同样是状态按钮出现
    out.layoutPausedShowsJumpButton = !!byTestId("db-bottom-anchor");
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
    buttonWith(null, "返回").click();
    await sleep(500);
    var account = byTestId("db-account");
    out.accountShown = !!account;
    // 下拉整块删掉了：单条目下拉会被读成「切换功能坏了」（用户原话「好像没法选」）
    out.accountNoDropdown = !!account && account.querySelector("select") === null;
    out.accountShowsIdentity = !!byTestId("db-account-name") &&
      byTestId("db-account-name").innerText.indexOf("本地测试") >= 0 &&
      byTestId("db-account-uid").innerText.indexOf("1000") >= 0;
    out.accountOpenButtonShown = !!byTestId("db-account-open");
    var followBefore = window.__followCalls;
    // 停一下让跑脚本的进程抓一张「账号区只留一行」的截图
    out.accountAreaReady = out.accountShown;
    snap();
    await sleep(900);

    byTestId("db-account-open").click();
    await sleep(400);
    out.accountDialogShown = !!byTestId("db-account-dialog");
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
    // 手填 Cookie（需求 §2.5 三种方式之一）：折叠着，但可达；输入框必须是密码型
    byTestId("db-account-cookie-toggle").click();
    await sleep(200);
    var cookieInput = byTestId("db-account-cookie-input");
    out.accountCookieEntryReachable = !!cookieInput && cookieInput.type === "password" &&
      !!byTestId("db-account-cookie-submit");
    byTestId("db-account-cookie-toggle").click();
    await sleep(150);
    snap();
    await sleep(800);

    // 添加账号 = 默认入口：account_qr_start 不带 target，永不覆盖任何凭据
    byTestId("db-account-add").click();
    await sleep(400);
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

    // 切换：走 account_switch，界面重拉会话并把「当前」标记挪过去
    buttonWith(rowsAfterAdd[0], "切换").click();
    await sleep(600);
    var switchCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchCalled = switchCalls.length === 1 && switchCalls[0].args.name === "default";
    var rowsAfterSwitch = allByTestId("db-account-row");
    out.accountCurrentMarkMoved = rowsAfterSwitch[0].innerText.indexOf("已登录 · 当前") >= 0 &&
      rowsAfterSwitch[1].innerText.indexOf("已登录 · 当前") < 0;
    out.accountIdentityAfterSwitch = byTestId("db-account-name").innerText.indexOf("本地测试") >= 0;
    // 切回来，让「删除当前账号」这一步删的确实是当前那一个
    buttonWith(rowsAfterSwitch[1], "切换").click();
    await sleep(600);

    // 重新登录 = 覆盖路径：先二次确认，且文案写清覆盖谁的凭据（原账号就是这样被顶掉的）
    var rowsNow = allByTestId("db-account-row");
    var startsBefore = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    buttonWith(rowsNow[0], "重新登录").click();
    await sleep(250);
    var overwriteConfirm = byTestId("db-account-confirm");
    out.accountRescanNeedsConfirm = !!overwriteConfirm &&
      overwriteConfirm.innerText.indexOf("覆盖") >= 0 &&
      overwriteConfirm.innerText.indexOf("default") >= 0;
    out.accountRescanNotStartedBeforeConfirm =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length === startsBefore;
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
