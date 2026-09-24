// 场景块：「我的直播间」—— 账号行按钮展开管理区（docs/ui.md §2.2.2，issue202609241553）
//   ① 入口：按钮只出现在「有直播间」的行、贴行右端（与账号管理组隔离）；没开通 / 未登录不渲染
//   ② 打开对话框即预取所有已登录账号的房间（按钮显隐靠这份映射）；不必切号即可跨账号管理
//   ③ 管理区：状态在标题左边、标题草稿 = 远端（一字不差禁用保存）、开播 / 下播独占一行
//   ④ 分区改动即存（`anchor_area_set`，独立写入口，不必等到开播）
//   ⑤ 开播被身份校验挡住 → 弹提示框（QrConfirm 离线二维码 / FaceAuth 走 open_url），
//      **不轮询不重试**，上游原话照旧留在错误行；开播成功渲染推流码、下播即消失
//   ⑥ 读失败 / 没开通直播间：只渲染错误行或什么都不渲染，**不静默**
//   ⑦ ROOM_CHANGE：上游推来标题变更（`danmubox://room`，房间号命中当前直播间）→ 就地更新标题
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    /* 前提（本段自己保证）：
       · 界面停在**列表页**（账号区 db-account 只在列表页）—— 上一段（status poll）收尾就在列表页；
       · 当前账号是**已登录**的（上一段为跑状态刷新真实走了一次新增账号流程）；
       · 账号行里另有一条**未登录**的行（账号那段最后退出登录留下的），正好用来验「不发请求」那条。
       三条都不靠上一段的收尾状态白拿：缺哪一条就在这里补，补不上就把 anchorBlockRan 置 false。 */
    try {
      // 临时注入「跨账号 / 没开通 / 未登录」三个账号，验证按钮显隐与跨账号管理；
      // 块末还原，免得污染后面的场景块（账号场景块 32 要求恰好 1 个账号、且是 default）。
      var anSavedAccounts = window.__accountsRef();
      window.__setAccounts([
        { name: "default", nickname: "本地测试", uid: 1000, logged_in: true, active: true, face: FACE_512 },
        { name: "alt", nickname: "二号账号", uid: 1001, logged_in: true, active: false, face: FACE_512 },
        { name: "noroom", nickname: "没开播的账号", uid: 1002, logged_in: true, active: false, face: FACE_512 },
        { name: "guest", nickname: "未登录账号", uid: 0, logged_in: false, active: false, face: "" },
      ]);
      if (!byTestId("db-list-page")) {
        byTestId("db-header-back").click();
        await sleep(600);
      }
      // 打开对话框**之前**的 anchor_room 次数（bootstrap 给当前账号拉过一次，算基线）：
      // 「打开即预取」比的应是「比基线多 3 次」（3 个已登录账号各一次），不是绝对 3。
      var anRoomCallsBase = callsWithArgs.filter(function (c) {
        return c.cmd === "anchor_room";
      }).length;
      byTestId("db-account").click();
      await sleep(400);
      // 行助手：按昵称定位账号行（default=本地测试 / alt=二号账号 / noroom=没开播的账号 / guest=未登录账号）
      var anRowByName = function (name) {
        return allByTestId("db-account-row").filter(function (r) {
          return r.innerText.indexOf(name) >= 0;
        })[0];
      };
      var anToggle = function (row) { return row ? buttonWith(row, "我的直播间") : null; };
      var anPanel = function () { return byTestId("db-anchor-panel"); };
      // 原生 setter 绕过 React 的取值追踪器（同 typeInto 那条理由）：直接改 .value 派发 change，
      // React 的 onChange 收不到。
      var anSetSelect = function (sel, value) {
        var desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
        desc.set.call(sel, value);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      };
      var anCalls = function (cmd) {
        return callsWithArgs.filter(function (c) { return c.cmd === cmd; });
      };
      var anText = function (id) {
        return (byTestId(id) || { innerText: "" }).innerText.trim();
      };

      var anDefaultRow = anRowByName("本地测试");   // 当前已登录、有直播间
      var anAltRow = anRowByName("二号账号");        // 另一个已登录、有直播间（跨账号）
      var anNoRoomRow = anRowByName("没开播的账号"); // 已登录但没开通直播间
      var anGuestRow = anRowByName("未登录账号");    // 未登录
      out.anchorDialogOpened = !!byTestId("db-account-dialog") && !!anDefaultRow;
      // ---- ① 入口：按钮只在「有直播间」的行出现，且贴行右端（与账号管理组隔离，第 1 条）
      out.anchorToggleOnRowWithRoom = !!anToggle(anDefaultRow) && !!anToggle(anAltRow);
      out.anchorNoToggleOnNoRoom = !anToggle(anNoRoomRow);   // 没开通 → 不渲染（第 2 条）
      out.anchorNoToggleOnGuest = !anToggle(anGuestRow);     // 未登录 → 不渲染
      var anRemove = anDefaultRow.querySelector('[data-testid="db-account-remove"]');
      var anToggleBtn = anToggle(anDefaultRow);
      out.anchorToggleRightOfRemove = !!anRemove && !!anToggleBtn &&
        (anRemove.compareDocumentPosition(anToggleBtn) & 4) > 0;

      // ---- ② 打开对话框即预取所有**已登录**账号的房间（第 2 条判定靠这份映射；3 个已登录账号）
      var anRoomCalls0 = anCalls("anchor_room").length;
      out.anchorPrefetchOnOpen = anRoomCalls0 === anRoomCallsBase + 3;
      out.anchorPanelHiddenBeforeToggle = anPanel() === null;

      // ---- ③ 跨账号管理（第 3 条）：展开 alt（非当前账号）就能管理它的房间，不必先切号
      anToggle(anAltRow).click();
      await sleep(600);
      out.anchorAltPanelShown = !!anPanel();
      out.anchorAltRoomFetched = anCalls("anchor_room").length === anRoomCalls0 + 1; // 面板拉自己那份
      out.anchorAltTitleFromRemote = !!byTestId("db-anchor-title") &&
        byTestId("db-anchor-title").value === "二号直播间";
      out.anchorAltStatus = anText("db-anchor-status") === "未开播";
      anToggle(anAltRow).click();
      await sleep(300);

      // ---- ④ 展开当前账号行：拉自己那份，标题 / 分区 / 状态都从远端来
      var anRoomCalls1 = anCalls("anchor_room").length;
      anToggle(anDefaultRow).click();
      await sleep(600);
      out.anchorPanelShown = !!anPanel();
      out.anchorRoomFetched = anCalls("anchor_room").length === anRoomCalls1 + 1;
      out.anchorLiveRowExists = !!byTestId("db-anchor-live-row"); // 开播 / 下播独占一行（第 5 条）
      out.anchorTitleFromRemote = !!byTestId("db-anchor-title") &&
        byTestId("db-anchor-title").value === "冒烟直播间";
      // 草稿与远端一字不差 → 保存键禁用（没改就不必发）
      out.anchorSaveDisabledWhenClean = !!byTestId("db-anchor-title-save") &&
        byTestId("db-anchor-title-save").disabled;
      out.anchorStatusNotLive = anText("db-anchor-status") === "未开播";
      out.anchorLiveSaysStart = !!buttonWith(anPanel(), "开播") && !buttonWith(anPanel(), "下播");
      // 分区两级联动：默认选中直播间当前分区（父「虚拟主播」/ 子「虚拟主播」）
      var anSelects = [].slice.call(anPanel().querySelectorAll("select"));
      out.anchorAreaTwoLevels = anSelects.length === 2;
      out.anchorAreaParentIsCurrent = anSelects.length === 2 && anSelects[0].value === "9";
      out.anchorAreaChildIsCurrent = anSelects.length === 2 && anSelects[1].value === "371";
      // 空标题：界面禁用保存（后端也会拒，这里钉的是「不发那一次无效请求」）
      typeInto(byTestId("db-anchor-title"), "   ");
      await sleep(250);
      out.anchorSaveDisabledWhenBlank = byTestId("db-anchor-title-save").disabled;
      // 改标题：保存键解禁 → 发一次 → 成功以远端为准（输入框显示回包里那份）
      typeInto(byTestId("db-anchor-title"), "冒烟改后标题");
      await sleep(250);
      out.anchorSaveEnabledWhenDirty = !byTestId("db-anchor-title-save").disabled;
      byTestId("db-anchor-title-save").click();
      await sleep(600);
      var anTitleCalls = anCalls("anchor_title_set");
      out.anchorTitleSetCalled = anTitleCalls.length === 1 &&
        anTitleCalls[0].args.title === "冒烟改后标题";
      out.anchorTitleEchoesRemote = byTestId("db-anchor-title").value === "冒烟改后标题";
      // 标题行：输入框吃满剩余宽度、保存键不被挤出面板（窄屏尤其容易横溢）
      var anTitleInput = byTestId("db-anchor-title");
      var anSaveBtn = byTestId("db-anchor-title-save");
      out.anchorTitleRowNoOverflow = rect(anSaveBtn).right <= rect(anPanel()).right + 1 &&
        rect(anTitleInput).width > 0;
      snap();
      await sleep(700);

      // ---- 第 4 条：改分区 = 独立写，改动即存（不必等到开播）
      var anSel0 = [].slice.call(anPanel().querySelectorAll("select"));
      anSetSelect(anSel0[0], "1"); // 父「娱乐」→ 子落到第一个「生活」=21
      await sleep(350);
      var anSel1 = [].slice.call(anPanel().querySelectorAll("select"));
      out.anchorChildFollowsParent = anSel1.length === 2 && anSel1[1].value === "21";
      anSetSelect(anSel1[1], "22"); // 子选到「美食」=22
      await sleep(400);
      var anSel2 = [].slice.call(anPanel().querySelectorAll("select"));
      out.anchorChildSelected = anSel2.length === 2 && anSel2[1].value === "22";
      // 两次改动各发一次 anchor_area_set（父联动一次 + 子一次），都带 account
      var anAreaCalls = anCalls("anchor_area_set");
      out.anchorAreaSetCalled = anAreaCalls.length === 2 &&
        anAreaCalls.every(function (c) { return c.args.account === "default"; }) &&
        anAreaCalls[anAreaCalls.length - 1].args.areaV2 === 22;
      var anLiveBefore = anCalls("anchor_live_set").length;

      // ---- ③ 开播被挡：QrConfirm（离线二维码）+ 错误行留上游原话 + 不轮询
      window.__anchorGate = true;
      window.__anchorGateKind = "qrconfirm";
      buttonWith(anPanel(), "开播").click();
      await sleep(700);
      var anLiveCalls = anCalls("anchor_live_set");
      out.anchorLiveSetSendsAreaV2 = anLiveCalls.length === anLiveBefore + 1 &&
        anLiveCalls[anLiveCalls.length - 1].args.live === true &&
        anLiveCalls[anLiveCalls.length - 1].args.account === "default" &&
        anLiveCalls[anLiveCalls.length - 1].args.areaV2 === 22;
      out.anchorGateModalShown = !!byTestId("db-anchor-gate-modal");
      var anQr = byTestId("db-anchor-gate-qr");
      out.anchorGateQrRendered = !!anQr && anQr.tagName.toLowerCase() === "img" &&
        String(anQr.getAttribute("src")).indexOf("data:image/svg+xml") === 0;
      out.anchorGateHintSaysRedo =
        anText("db-anchor-gate-hint").indexOf("再点一次开播") >= 0;
      // 引导**不代替**上游原话：code 与 msg 一起留在错误行里
      out.anchorGateKeepsUpstreamWords = anText("db-anchor-error").indexOf("60024") >= 0 &&
        anText("db-anchor-error").indexOf("身份验证") >= 0;
      var anLiveCallsInGate = anLiveCalls.length;
      await sleep(2600);
      out.anchorGateNoAutoRetry = anCalls("anchor_live_set").length === anLiveCallsInGate;
      snap();
      await sleep(800);
      // Esc 先关提示框，**不**连带关掉账号对话框（一次 Esc 只关一层）
      pressEscape();
      await sleep(400);
      out.anchorGateEscClosesOnlyModal =
        !byTestId("db-anchor-gate-modal") && !!byTestId("db-account-dialog");

      // ---- ③b FaceAuth：给「去完成人脸认证」入口，走 open_url 打开认证页
      window.__anchorGateKind = "faceauth";
      buttonWith(anPanel(), "开播").click();
      await sleep(700);
      out.anchorFaceAuthEntryShown = !!byTestId("db-anchor-gate-open");
      byTestId("db-anchor-gate-open").click();
      await sleep(500);
      var anOpenCalls = anCalls("open_url");
      out.anchorFaceAuthOpensUrl = anOpenCalls.length === 1 &&
        String(anOpenCalls[0].args.url).indexOf("face-auth") >= 0;
      pressEscape();
      await sleep(400);

      // ---- ④ 开播成功：下方直接渲染推流地址与推流码；状态与按钮同时翻转
      window.__anchorGate = false;
      buttonWith(anPanel(), "开播").click();
      await sleep(800);
      out.anchorConfigShownAfterLive = !!byTestId("db-anchor-config");
      out.anchorAddrShown = anText("db-anchor-rtmp-addr") === "rtmp://live-push.example/live";
      out.anchorCodeShown = anText("db-anchor-rtmp-code") === "smoke-stream-key-0001";
      out.anchorAreaShownInConfig = anText("db-anchor-area") === "美食";
      out.anchorStatusLiveNow = anText("db-anchor-status") === "直播中";
      out.anchorLiveSaysStop = !!buttonWith(anPanel(), "下播") && !buttonWith(anPanel(), "开播");
      // 等宽体 + 可断行：长串不把面板撑出横向滚动
      var anAddr = byTestId("db-anchor-rtmp-addr");
      out.anchorValueMonospace = !!anAddr &&
        getComputedStyle(anAddr).fontFamily.toLowerCase().indexOf("mono") >= 0;
      out.anchorValueNoOverflow = !!anAddr && anAddr.scrollWidth <= anAddr.clientWidth + 1;
      out.anchorPanelWithinDialog = rect(anPanel()).right <=
        rect(allByTestId("db-account-row")[0]).right + 1;
      snap();
      await sleep(900);

      // ---- ④b 下播：推流参数**从 DOM 里消失**（不是在内存里留着），状态回到未开播
      buttonWith(anPanel(), "下播").click();
      await sleep(800);
      var anStopCalls = anCalls("anchor_live_set");
      out.anchorStopSendsLiveFalse = anStopCalls.length > 0 &&
        anStopCalls[anStopCalls.length - 1].args.live === false &&
        anStopCalls[anStopCalls.length - 1].args.account === "default";
      out.anchorConfigGoneAfterStop = !byTestId("db-anchor-config");
      out.anchorStatusBackToIdle = anText("db-anchor-status") === "未开播";

      // ---- ⑤b 读失败：**不静默** —— 只渲染错误行（后端原话），不画半截管理区
      window.__anchorFail = true;
      anToggle(anDefaultRow).click();
      await sleep(300);
      anToggle(anDefaultRow).click();
      await sleep(600);
      out.anchorReadErrorShown = anText("db-anchor-error").indexOf("读取直播间失败") >= 0;
      out.anchorNoBodyOnReadError = byTestId("db-anchor-title") === null &&
        byTestId("db-anchor-live") === null;
      // 读失败后这枚按钮**也不渲染**（`anchorRooms[name]` 被置回 null）：不给入口，原因留痕
      out.anchorNoToggleOnReadError = !anToggle(anDefaultRow);
      window.__anchorFail = false;
      pressEscape(); // 读失败后按钮已不渲染，收尾只能关对话框（顺带清展开态与错误行）
      await sleep(400);

      // ---- ⑤c 没开通直播间（anchor_room 返回 null）：**不是错误**，整块不渲染、也不报错（第 2 条）
      //   把 default 的状态置 null、重开对话框重新预取 → 那行按钮消失。
      var anKeptRoom = window.__anchorByAccount.default;
      window.__anchorByAccount.default = null;
      pressEscape();
      await sleep(400);
      byTestId("db-account").click();
      await sleep(600);
      out.anchorNoRoomNoToggle = !anToggle(anRowByName("本地测试"));
      window.__anchorByAccount.default = anKeptRoom; // 恢复，留给下面的 ROOM_CHANGE 段
      pressEscape();
      await sleep(400);

      // ---- ⑥ ROOM_CHANGE 自动更新标题（第 6 条）：上游推来标题变更（danmubox://room，
      //   房间号命中当前直播间），管理区就地换掉标题输入框，不必手动重读。
      byTestId("db-account").click();
      await sleep(500);
      anToggle(anRowByName("本地测试")).click();
      await sleep(500);
      window.__emit("danmubox://room", { room_id: 515151, title: "被弹幕端改的标题" });
      await sleep(400);
      out.anchorTitleUpdatedByRoomChange =
        !!byTestId("db-anchor-title") &&
        byTestId("db-anchor-title").value === "被弹幕端改的标题";
      anToggle(anRowByName("本地测试")).click(); // 收起管理区
      await sleep(300);
      out.anchorCollapseClearsPanel = anPanel() === null;

      // 还原账号表与 default 的直播间状态，免得污染后面的场景块
      window.__setAccounts(anSavedAccounts);
      // ---- 收起对话框（推流码是账号级凭据，关掉对话框即清）
      pressEscape();
      await sleep(400);
      out.anchorDialogClosedAfterBlock = !byTestId("db-account-dialog");
      out.anchorBlockRan = true;
    } catch (e) {
      out.anchorBlockError = String((e && e.stack) || e);
      // 块没跑完 = 明确红（运行器只查布尔值，非布尔直接跳过；不显式置 false 就什么都拦不住）
      out.anchorBlockRan = false;
    }
