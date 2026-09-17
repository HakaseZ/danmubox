// 场景块：短语面板、断开与刷新连接、多标签隔离
//   panel 层短语面板（右键增删改、点选插入到光标处、头部 ⋯ 菜单；与筛选 / 表情同一副骨架）
//   「断开连接」之后再点「刷新连接」必须能把连接拉回来
//   tabs 多标签隔离（切房间重置面板 / 菜单 / 滚动跟随，草稿按「身份 × 房间」各留一份）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
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
      // B 间再开一次面板，切回 A 间时它同样必须收起（两个方向都判，不是单向巧合）。
      // **用「筛选」而不是「表情」**：夹具里的第二个房间（5555）刻意是「上游没给主播名与标题」
      // 的形态、connected: false（见 mock 的 __addSecondRoom），而房间页把这当成「没有可发的东西」：
      // 输入区整块与「表情 / 短语」两枚工具按钮都 disabled={disabled || !loggedIn}
      // （docs/ui.md §6.1），**点一枚 disabled 的按钮不派发 click** —— 实测 clickTool("表情")
      // 返回 true（按钮找得到、也真的点了）但面板永远开不出来，这条断言因此恒为假，而
      // 它旁边的 tabIsolationPanelClosedBackInA 会**顺带变成恒真**（B 间根本没开过面板，
      // 「切回 A 间时收起」也就无从谈起）。筛选手板不看连接状态（它只是显示偏好），
      // 在 B 间照常打得开 —— 换它之后这对断言才恢复成「两个方向都真的开过、都真的收起」。
      var bEmotesTool = buttonWith(byTestId("db-composer-tools"), "筛选");
      out.tabIsolationBComposer = {
        toolsRow: !!byTestId("db-composer-tools"),
        filterTool: !!bEmotesTool,
        emotesToolDisabled: (function () {
          var b = buttonWith(byTestId("db-composer-tools"), "表情");
          return b ? b.disabled === true : null;
        })(),
        textareaDisabled: document.querySelector("textarea")
          ? document.querySelector("textarea").disabled === true : null,
      };
      out.tabIsolationBClickedTool = clickTool("筛选");
      await sleep(400);
      out.tabIsolationPanelOpenInB = !!byTestId("db-panel");
      out.tabIsolationBPanelDiag = {
        panel: !!byTestId("db-panel"),
        emoteTabs: [].slice.call(document.querySelectorAll('[data-testid="db-emote-tab"]'))
          .map(function (b) { return b.getAttribute("data-kind"); }),
        options: byTestId("db-panel")
          ? [].slice.call(byTestId("db-panel").querySelectorAll("button")).length : null,
      };
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

