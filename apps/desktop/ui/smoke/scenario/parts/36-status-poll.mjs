// 场景块：开播 / 下播的状态自动更新
//   实时那条：一个 danmubox://room 事件让房间头状态点与标签页圆点一起变（含下播回红）
//   列表那条：进列表页立即拍一拍、进房间就停、拉回来的值真的落到卡片与关注行上
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    /* ---- 开播 / 下播的状态自动更新（用户 2026-09-16：「在开播下播时，状态不会自动更新，
       打开的房间应该实时更新状态，列表应该定期查询状态」）。

       ① **实时那条**：长连接里的 LIVE / PREPARING 到达时，后端把房间的 live_status 改掉并推
          一条 danmubox://room（契约 §6/§7）。界面这一侧要证明的是「一个事件 → 看得见的地方
          **全都**跟着变」：房间头那颗状态点、房间标签页那颗圆点（同一个 liveKindOf，两处必然
          同色）。这一块**只推事件** —— 不重连、不点任何刷新、不重开房间。
       ② **列表那条**：停在列表页时界面自己按周期问上游（周期 / 不可见不拉 / 失败退避的数值
          由探针实测，本场景不引入 30 秒级等待 —— 那会把每次冒烟都拖长一分钟以上）。这里钉的是
          机制：进列表页会立即拍一拍、进房间就停、拉回来的值真的落到卡片与关注行上。

       前提：账号那一段最后**退成了游客态**（那是有意为之，见 accountBackToGuest），而这两条
       都要在登录态下才完整（关注那一份要登录）。所以先走一次真实的新增账号流程 --
       替身会在第 2 次轮询（2 秒一次）时确认，和用户自己扫出来的那条路完全一样。 */
    /* 【本票代修 · LiveStatus 票（批次 2609162141）那一段的准入前提】这一整段的前提是「界面停在
       **列表页**」（db-account / db-account-add 只渲染在 RoomList 里），但上一段（cheapgift）的收尾
       是切回房间标签、界面此时在**房间页** —— 直接点 db-account 会抛 TypeError，而这一段此前没有
       try/catch 包着，整场场景当场死掉（表现是 run-headless 报「视口未跑完（超时）」，本轮实测）。
       两处修补都只动**前提与兜底**、断言一行未动（按 LiveStatus 作者给的口径）：
       ① 先确保停在列表页（回列表页只有「返回键」这一条路，它在房间页里必然存在）；
       ② 同款 try/catch + roomStatusBlockRan —— 它**要求为真**，块中途抛错时显式置 false，
          不许「块没跑」静默通过；catch 落在 __smoke_run 之内、out.done 之前，抛错也要产出快照。
       留 LiveStatus 复核。 */
    try {
      // 前提：这一段全部从**列表页**开始量 —— 上一段收尾停在房间页，先退回去。
      if (!byTestId("db-list-page")) {
        byTestId("db-header-back").click();
        await sleep(600);
      }
      byTestId("db-account").click();
      await sleep(400);
      byTestId("db-account-add").click();
      await sleep(5200);
      out.roomStatusReloggedIn = !!byTestId("db-list-page") &&
        (byTestId("db-account-name") || { innerText: "" }).innerText.indexOf("扫码新用户") >= 0;

      // ---- 进房间：房间头那颗点与标签页那颗点**同一个事件一起变**。
      byTestId("db-room-card").click();
      await sleep(900);
      var statusDotState = function () {
        var box = byTestId("db-live-dot-box");
        return box ? box.getAttribute("data-state") : null;
      };
      var tabDotState = function (roomId) {
        var btn = allByTestId("db-room-tab").filter(function (t) {
          return t.getAttribute("data-room-id") === String(roomId);
        })[0];
        var dot = btn ? btn.querySelector('[data-testid="db-tab-dot"]') : null;
        return dot ? dot.getAttribute("data-state") : null;
      };
      // 先置成「已连接 + 未开播」（红），再只推一条开播事件。
      window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 0 });
      await sleep(400);
      var dotsBeforeLive = statusDotState() === "off" && tabDotState(fixtureRoom.room_id) === "off";
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 1 });
      await sleep(400);
      out.roomStatusLiveHeaderDot = statusDotState() === "on";
      out.roomStatusLiveTabDot = tabDotState(fixtureRoom.room_id) === "on";
      // 下播（PREPARING 在 Rust 侧归一成 0，界面收到的就是这一条载荷）：两处一起回红。
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 0 });
      await sleep(400);
      out.roomStatusOfflineBothDots =
        statusDotState() === "off" && tabDotState(fixtureRoom.room_id) === "off";
      out.roomStatusLiveEventUpdatesBothDots = dotsBeforeLive && out.roomStatusLiveHeaderDot &&
        out.roomStatusLiveTabDot && out.roomStatusOfflineBothDots;

      // ---- 房间页里**不该**有列表那一拍（进房就停）：先等一拍可能在途的落地，再观察一段窗口。
      await sleep(1200);
      var refreshesInRoom = window.__statusRefreshes;
      await sleep(3000);
      out.roomStatusStopsPollingInRoom = window.__statusRefreshes === refreshesInRoom;

      // ---- 回列表页：**没有人点刷新**，界面自己拍一拍；一次性的替身覆盖（把房间报成「直播中」）
      //      用来证明拉回来的值**真的落到了卡片上**（只证明「命令被调用过」是不够的）。
      window.__statusNext = 1;
      var refreshesBeforeBack = window.__statusRefreshes;
      var followCallsBeforeBack = window.__followCalls;
      byTestId("db-header-back").click();
      await sleep(1200);
      out.roomStatusListRefreshAutomatic = window.__statusRefreshes > refreshesBeforeBack;
      out.roomStatusListRefreshFetchesFollowed = window.__followCalls > followCallsBeforeBack;
      var homeCard = allByTestId("db-room-card").filter(function (c) {
        return c.innerText.indexOf(fixtureRoom.anchor_uname) >= 0;
      })[0];
      out.roomStatusListCardFollowsUpstream = !!homeCard &&
        homeCard.innerText.indexOf("直播中") >= 0;

      // ---- 同一份状态也要落到**关注行**上（同号的那一条）：推一条下播事件，「在播主播」那一行
      //      从「直播中」变「未开播」—— 列表页两处状态不再自相矛盾。
      var followRowNamed = function () {
        return allByTestId("db-follow-item").filter(function (r) {
          return r.innerText.indexOf("在播主播") >= 0;
        })[0];
      };
      var followStatusOf = function (row) {
        var span = row ? row.querySelector('[data-testid="db-follow-status"]') : null;
        return span ? span.innerText : null;
      };
      var followStatusBefore = followStatusOf(followRowNamed());
      window.__emit("danmubox://room", { room_id: 100, live_status: 0 });
      await sleep(400);
      out.roomStatusFollowRowFollowsEvent = followStatusBefore === "直播中" &&
        followStatusOf(followRowNamed()) === "未开播";

      out.roomStatusListAutorefresh = out.roomStatusListRefreshAutomatic &&
        out.roomStatusListRefreshFetchesFollowed && out.roomStatusListCardFollowsUpstream &&
        out.roomStatusFollowRowFollowsEvent;
      out.roomStatusBlockRan = true;
    } catch (e) {
      out.roomStatusBlockError = String((e && e.stack) || e);
      // 块没跑完 = 明确红：这一批 roomStatus* 会全是 undefined，而运行器只查布尔值、
      // 非布尔直接跳过 —— 不显式置 false 就什么都拦不住。
      out.roomStatusBlockRan = false;
    }

