// 页内片段（在运行器**之前**）：IPC 替身 `__TAURI_INTERNALS__`。
//   mock 全部 invoke 命令与事件通道（契约 §7 的形状）、__emit / __mk / __addRoom(s) / __setSendOutcome 等测试钩子
//   夹具数据只从 __SMOKE_DATA 取（由 smoke/room-page.mjs 注入），本文件不读盘
//
// 本文件是**页内脚本的原文**：由 smoke/room-page.mjs 原样拼进页内 IIFE（在 10-harness 与运行器之前，
// 与它们共用同一条作用域），**不要**把它塞回模板字符串（转义坑见 docs/testing.md §9.3）。

  var EMOTES = __SMOKE_DATA.emotes;
  var ROW_EMOTES = __SMOKE_DATA.rowEmotes;
  var ROW_FIXTURES = __SMOKE_DATA.rowFixtures;
  // 礼物 / SC / 大航海的夹具行（按协议文档字段表构造，见 Node 侧 GIFT_FIXTURE 的说明）：
  // 每一项的 message 字段已经是归一化后的形状，冒烟只做字段搬运（上游载荷 → Message 在 Rust 侧）。
  var GIFT_ROWS = __SMOKE_DATA.giftRows;
  // 无空格的长 ASCII 串（真实载荷里的 CDN 地址，见 Node 侧 ROW_ASCII_TOKEN 的说明）
  var ROW_ASCII = __SMOKE_DATA.rowAscii;
  var FOLLOW_FIXTURE_ROWS = __SMOKE_DATA.followed;
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
    "ui.font_scale": 1, "ui.theme": __SMOKE_DATA.theme, "ui.auto_scroll": true,
    "ui.pause_on_hover": false,
    // 礼物类消息的两枚开关（契约 §8，issue 2609152029 第 1 条把旧的
    // 「ui.gift_panel_mode」这个字符串键拆成了这两枚布尔键）：管弹幕流的那枚与管独立礼物栏的
    // 那枚各管一头，**默认都是 true**（两处都渲染）。
    "ui.gift_in_danmaku": true, "ui.gift_panel": true, "ui.interact_auto_hide": true,
    // 共享分区的顺序与份额（issue #8，契约 §8 新增的两枚键）：默认「礼物在下、份额 0.35」。
    // 替身里必须与 prefs_get 同形（真实命令返回的是**合并过默认值的全集**），否则界面拿到的
    // 是 undefined、断言也就量不到「默认值」这件事。
    "ui.gift_pane_on_top": false, "ui.gift_pane_ratio": 0.35,
    // 低价礼物两枚开关（issue 2609162056 第 3 / 4 条，契约 §8）：**默认都是 false**（改前的
    // 形态就是「不折叠、不剔除」）。替身里必须与 prefs_get 同形，界面才量得到「默认关」这件事。
    "ui.gift_collapse_cheap": false, "ui.gift_exclude_cheap_stats": false,
    "ui.show_timestamp": false,
    // 刷屏弹幕聚合（issue 202609211940 第 3 条，契约 §8）：**默认 true**（改前的形态就是
    // 折着的，只是门槛从「两位观众」改成了 3 条以上）。替身里必须与 prefs_get 同形，
    // 界面才量得到「默认开」这件事 —— aggregate 那一段还要现场点掉它量「关掉不折」。
    "ui.danmaku_aggregate": true,
    // 键清单照抄契约 §8：ui.system_notice 随「系统类只由 filter.kinds 把关」
    // 一起删掉（两个门盖的消息集合逐字相同），关键词命中那三键随 item 9 一起删掉了，
    // 房管屏蔽词走 admin_keywords_*（IPC 命令，不是偏好键），不在这一份里。
    "composer.phrases": ["早上好"], "filter.uids": [],
    // 默认白名单**不含 system**（契约 §8.1 / §4.8）：系统行默认不渲染，
    // 要看就现场勾「消息类型 → 系统」那一项（step4）。
    "filter.kinds": ["danmaku", "gift", "superchat", "interact", "guard"],
    "filter.medal_level_min": 0,
    // 会话缓冲的六档上限（契约 §4.3 / §8，issue 2609171849 第 3 条）：旧的单一键
    // history.buffer_rows 已删除，替身跟着换成六枚。这几枚界面不读（裁剪在 Rust 侧），
    // 但替身必须与 prefs_get 同形 —— 否则它就不再是「照抄契约 §8」的那一份。
    "history.buffer_rows_danmaku": 5000, "history.buffer_rows_gift": 2000,
    "history.buffer_rows_superchat": 500, "history.buffer_rows_guard": 200,
    "history.buffer_rows_interact": 300, "history.buffer_rows_system": 200,
    // 「最近观看」（契约 §8）：离线甲（room 300）先看过，**夹具第 1 条**（真实取样）后看过 ——
    // 用来看排序是否真的按它降序（见场景 step1 的 #16 断言）。
    "ui.recent_watched": { "300": 1789900000000, [String(__SMOKE_DATA.recentRoomId)]: 1789990000000 }
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
  var fixtureRoom = __SMOKE_DATA.room;
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
  // 标签条那一段要「开一堆房间」：__addRooms(n) 追加 n 个**上游没给名字**的房间
  // （与 5555 同款：标签只能报房间号），标签条因此一定横向溢出 ——
  // 「开多了不挤在一起」才有可观察面。幂等：同一号不会重复登记。
  window.__addRooms = function (count) {
    for (var added = 1; added <= count; added += 1) {
      var id = 6000 + added;
      if (rooms.some(function (r) { return r.room_id === id; })) continue;
      rooms.push({
        room_id: id, short_id: 0, anchor_uid: 0, anchor_uname: "",
        title: "", live_status: 0, connected: false, buffered: 0
      });
    }
  };
  // 反向：把某个房间从替身的 rooms_list 里删掉（下一次重拉就不再返回它）——
  // 用来验「拖动中被拖的那个房间被关掉」。
  window.__dropRoom = function (roomId) {
    rooms = rooms.filter(function (r) { return r.room_id !== roomId; });
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
  // 列表页那一拍（rooms_refresh_status）的调用次数与失败开关：定期刷新 / 不可见不拉 / 退避
  // 三条断言都数它。__statusFlip 让替身在每次刷新时把 live_status 翻过去，用来证明
  // 「界面真的按上游那份重画了」，而不是只证明「命令被调用了」。
  window.__statusRefreshes = 0;
  window.__statusFail = false;
  window.__statusFlip = false;
  window.__statusNext = null;
  window.__qrPolls = 0;
  window.__qrTarget = null;
  // 轮询失败开关：验证「失败要能重试」（面板留在原地 + 重新获取按钮）
  window.__qrFail = false;
  // ---- 「我的直播间」（契约 §7 anchor_*）的替身状态与开关
  //   __anchor        = null 时表示「该账号没开通直播间」（**不是错误**，界面据此整块不渲染）
  //   __anchorGate    = 开播被身份校验挡住（默认关）；__anchorGateKind 切 `qrconfirm` / `faceauth`
  //   __anchorFail    = 读取失败（验证「失败不静默」，只渲染错误行）
  //   __anchorAreas   = 两级分区树；`children` 末端的 id 即 anchor_live_set 的 area_v2
  window.__anchor = {
    room_id: 515151, title: "冒烟直播间", live_status: 0, area_id: 371, area_name: "虚拟主播",
  };
  window.__anchorGate = false;
  window.__anchorGateKind = "qrconfirm";
  window.__anchorFail = false;
  window.__anchorAreas = [
    { id: 9, name: "虚拟主播", children: [{ id: 371, name: "虚拟主播" }, { id: 372, name: "电台" }] },
    { id: 1, name: "娱乐", children: [{ id: 21, name: "生活" }, { id: 22, name: "美食" }] },
  ];
  window.__mk = msg;
  /**
   * 夹具里的一条礼物 / SC / 大航海 → Message 并广播（**归一化层**：夹具给的已经是 Message
   * 形状，上游载荷 → Message 的解析在 Rust 侧 —— SEND_GIFT_V2 的 protobuf 冒烟不解，见
   * fixtures/gift-sc-guard-rows.json 的 _note）。
   *
   * 头像：夹具里只写脱敏后的 CDN 地址形状（真去请求只会挂网），这里换成本地内联替身 ——
   * 与弹幕行同一条口径。face 为空串的那两条（V1 礼物 / 大航海）保持空串：上游没有头像源，
   * 界面就不画假图（这正是要断言的那件事，不能在夹具这一层补上）。
   */
  var emitGiftRow = function (key) {
    var row = GIFT_ROWS.filter(function (r) { return r.key === key; })[0];
    if (!row) return false;
    var spec = row.message;
    var extra = {};
    for (var field in spec) {
      if (field !== "kind" && field !== "content") extra[field] = spec[field];
    }
    extra.face = spec.face ? FACE_512 : "";
    window.__emit("danmubox://message", msg(spec.kind, spec.content, false, extra));
    return true;
  };
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
        // 列表页的定期刷新（契约 §4）：替身按调用次数把状态翻过去 —— 界面「到点自己重拉」
        // 与「不可见不拉」两条都靠 __statusRefreshes 数出来（见 roomStatus* 断言）。
        case "rooms_refresh_status": {
          window.__statusRefreshes += 1;
          if (window.__statusFail) {
            return Promise.reject({ code: "UPSTREAM_ERROR", message: "刷新房间状态失败（冒烟替身）" });
          }
          if (window.__statusFlip) {
            rooms.forEach(function (r) { r.live_status = r.live_status === 1 ? 0 : 1; });
          }
          // **一次性**覆盖：只对下一次刷新生效，用来证明「拉回来的那个值真的落到了卡片上」
          // （而不是只证明了「命令被调用过」）。用完即清，后续各拍照旧。
          if (window.__statusNext !== null) {
            rooms.forEach(function (r) { r.live_status = window.__statusNext; });
            window.__statusNext = null;
          }
          return Promise.resolve(rooms.map(function (r) { return Object.assign({}, r); }));
        }
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
        // ---- 「我的直播间」（契约 §7）：房间号一律后端现取，这四条命令都**不接受房间号参数**
        case "anchor_room": {
          if (window.__anchorFail) {
            return Promise.reject({ code: "UPSTREAM_ERROR", message: "读取直播间失败（冒烟替身）" });
          }
          return Promise.resolve(window.__anchor ? Object.assign({}, window.__anchor) : null);
        }
        case "anchor_title_set": {
          // 空标题由后端拒（`BAD_REQUEST`）；界面侧那枚「保存」键同时也该是禁用的
          if (String(args.title || "").trim().length === 0) {
            return Promise.reject({ code: "BAD_REQUEST", message: "直播间标题不能为空" });
          }
          window.__anchor.title = args.title;
          return Promise.resolve(Object.assign({}, window.__anchor));
        }
        case "anchor_area_list": {
          return Promise.resolve(window.__anchorAreas.map(function (a) {
            return { id: a.id, name: a.name, children: (a.children || []).map(function (c) {
              return { id: c.id, name: c.name, children: [] };
            }) };
          }));
        }
        case "anchor_live_set": {
          if (!args.live) {
            window.__anchor.live_status = 0;
            return Promise.resolve(null);
          }
          if (window.__anchorGate) {
            return Promise.resolve(window.__anchorGateKind === "faceauth"
              ? {
                  code: 60043, message: "本次开播需要身份验证", kind: "faceauth",
                  url: "https://example.invalid/face-auth", qr: "", qr_svg: null,
                }
              : {
                  code: 60024, message: "本次开播需要身份验证", kind: "qrconfirm",
                  url: "", qr: "https://example.invalid/face-qr", qr_svg: qrSvg,
                });
          }
          // 成功：area_v2 缺省沿用直播间当前分区，Some 则按界面所选覆盖（并记进房间状态）
          if (args.area_v2 !== undefined) window.__anchor.area_id = args.area_v2;
          window.__anchor.live_status = 1;
          return Promise.resolve({
            rtmp: { addr: "rtmp://live-push.example/live", code: "smoke-stream-key-0001" },
            rtmp_backup: null,
            srt: null,
          });
        }
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
