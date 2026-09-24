// 场景块：「我的直播间」—— 账号行按钮展开管理区（docs/ui.md §2.2.2）
//   ① 入口：每行都有「我的直播间」按钮、排在「删除」右侧；**点开才拉数据**（不点不发请求）
//   ② 管理区：标题草稿 = 远端（一字不差禁用保存）、两级联动分区（父→子）、开播 / 下播按
//      live_status 自适应
//   ③ 开播被身份校验挡住 → 弹提示框（QrConfirm 离线二维码 / FaceAuth 走 open_url），
//      **不轮询不重试**，上游原话照旧留在错误行
//   ④ 开播成功 → 下方直接渲染推流地址与推流码（等宽体、不横向溢出）；下播即消失
//   ⑤ 读失败 / 没开通直播间：只渲染错误行或什么都不渲染，**不静默**
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    /* 前提（本段自己保证）：
       · 界面停在**列表页**（账号区 db-account 只在列表页）—— 上一段（status poll）收尾就在列表页；
       · 当前账号是**已登录**的（上一段为跑状态刷新真实走了一次新增账号流程）；
       · 账号行里另有一条**未登录**的行（账号那段最后退出登录留下的），正好用来验「不发请求」那条。
       三条都不靠上一段的收尾状态白拿：缺哪一条就在这里补，补不上就把 anchorBlockRan 置 false。 */
    try {
      if (!byTestId("db-list-page")) {
        byTestId("db-header-back").click();
        await sleep(600);
      }
      byTestId("db-account").click();
      await sleep(400);
      var anCurrentRow = function () {
        return allByTestId("db-account-row").filter(function (r) {
          return r.innerText.indexOf("已登录 · 当前") >= 0;
        })[0];
      };
      var anOtherRow = function () {
        return allByTestId("db-account-row").filter(function (r) {
          return r.innerText.indexOf("已登录 · 当前") < 0;
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

      var anRows = allByTestId("db-account-row");
      var anRow = anCurrentRow();
      out.anchorDialogOpened = !!byTestId("db-account-dialog") && !!anRow;
      // ---- ① 入口：每一行都有一枚「我的直播间」，且在「删除」**右侧**（文档序：它排在后面）
      out.anchorToggleOnEveryRow = anRows.length > 0 && anRows.every(function (r) {
        return !!buttonWith(r, "我的直播间");
      });
      var anRemove = anRow ? anRow.querySelector('[data-testid="db-account-remove"]') : null;
      var anToggleBtn = anToggle(anRow);
      out.anchorToggleRightOfRemove = !!anRemove && !!anToggleBtn &&
        (anRemove.compareDocumentPosition(anToggleBtn) & 4) > 0;
      // 不点就不拉：展开之前既不渲染面板、也不发 anchor_room
      var anRoomCalls0 = anCalls("anchor_room").length;
      out.anchorPanelHiddenBeforeToggle = anPanel() === null;
      out.anchorNoRequestBeforeToggle = anRoomCalls0 === 0;

      // ---- ⑤a 展开**非当前 / 未登录**那一行：不发请求，只给错误行（后端读的是当前账号自己的）
      var anOther = anOtherRow();
      if (anOther) {
        anToggle(anOther).click();
        await sleep(500);
        out.anchorOtherRowNoRequest = anCalls("anchor_room").length === anRoomCalls0;
        out.anchorOtherRowErrorShown = anText("db-anchor-error").length > 0;
        out.anchorOtherRowNoBody = byTestId("db-anchor-title") === null &&
          byTestId("db-anchor-live") === null;
        anToggle(anOtherRow()).click();
        await sleep(300);
      }

      // ---- ② 展开当前账号行：拉一次，标题 / 分区 / 状态都从远端来
      anToggle(anCurrentRow()).click();
      await sleep(600);
      out.anchorPanelShown = !!anPanel();
      out.anchorRoomFetched = anCalls("anchor_room").length === anRoomCalls0 + 1;
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

      // 换分区：父 → 子联动（选父落到它的第一个子分区，再选到「美食」= 22）
      var anSel0 = [].slice.call(anPanel().querySelectorAll("select"));
      anSetSelect(anSel0[0], "1");
      await sleep(350);
      var anSel1 = [].slice.call(anPanel().querySelectorAll("select"));
      out.anchorChildFollowsParent = anSel1.length === 2 && anSel1[1].value === "21";
      anSetSelect(anSel1[1], "22");
      await sleep(300);

      // ---- ③ 开播被挡：QrConfirm（离线二维码）+ 错误行留上游原话 + 不轮询
      window.__anchorGate = true;
      window.__anchorGateKind = "qrconfirm";
      buttonWith(anPanel(), "开播").click();
      await sleep(700);
      var anLiveCalls = anCalls("anchor_live_set");
      out.anchorLiveSetSendsAreaV2 = anLiveCalls.length === 1 &&
        anLiveCalls[0].args.live === true && anLiveCalls[0].args.areaV2 === 22;
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
        anStopCalls[anStopCalls.length - 1].args.live === false;
      out.anchorConfigGoneAfterStop = !byTestId("db-anchor-config");
      out.anchorStatusBackToIdle = anText("db-anchor-status") === "未开播";

      // ---- ⑤b 读失败：**不静默** —— 只渲染错误行（后端原话），不画半截管理区
      window.__anchorFail = true;
      anToggle(anCurrentRow()).click();
      await sleep(300);
      anToggle(anCurrentRow()).click();
      await sleep(600);
      out.anchorReadErrorShown = anText("db-anchor-error").indexOf("读取直播间失败") >= 0;
      out.anchorNoBodyOnReadError = byTestId("db-anchor-title") === null &&
        byTestId("db-anchor-live") === null;
      window.__anchorFail = false;

      // ---- ⑤c 该账号没开通直播间（anchor_room 返回 null）：**不是错误**，整块不渲染、也不报错
      var anKeptRoom = window.__anchor;
      window.__anchor = null;
      anToggle(anCurrentRow()).click();
      await sleep(300);
      anToggle(anCurrentRow()).click();
      await sleep(600);
      out.anchorNoRoomNoBody = byTestId("db-anchor-title") === null;
      out.anchorNoRoomNoError = anText("db-anchor-error").length === 0;
      window.__anchor = anKeptRoom;

      // ---- 收起：面板与里面的推流参数一起消失（推流码是账号级凭据，收起即清）
      anToggle(anCurrentRow()).click();
      await sleep(400);
      out.anchorCollapseClearsPanel = anPanel() === null && !byTestId("db-anchor-config");
      pressEscape();
      await sleep(400);
      out.anchorDialogClosedAfterBlock = !byTestId("db-account-dialog");
      out.anchorBlockRan = true;
    } catch (e) {
      out.anchorBlockError = String((e && e.stack) || e);
      // 块没跑完 = 明确红（运行器只查布尔值，非布尔直接跳过；不显式置 false 就什么都拦不住）
      out.anchorBlockRan = false;
    }
