// 场景块：工具行、面板布局与表情面板
//   工具行只剩三个面板入口；文档本身永不滚动（面板与键盘只挤内部滚动区）
//   layout 面板向上展开时列表上弹且最新一条不被遮挡
//   表情面板 = 竖向 tab 轨道 + 表情网格（行数按大表情高度固定、搜索框已删、无标题无关闭、轨道可滚）
//   表情溢出格子边框那一版的回归闸、无权限表情置灰但不隐藏、切 tab 不关面板
//   面板收起后「跟随最新」仍活、窄屏面板形态（视口份额限高 + 面板内部滚动 + 热区 ≥ 40px）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 工具行只剩三个面板入口：表情 / 短语 / 筛选（用户 #7：「最近」整条链路删掉）
    var toolLabels = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .map(function (b) { return b.innerText.trim(); });
    out.toolsPanelButtons = toolLabels;
    out.toolsOnlyThreePanels = ["表情", "短语", "筛选"].every(function (t) {
      return toolLabels.indexOf(t) >= 0;
    }) && toolLabels.indexOf("最近") < 0;

    // ---- 文档本身**永不滚动**（键盘 / 面板只许挤压内部滚动区，不许把整个界面顶走；docs/ui.md §9.3）
    //      为什么钉这条：安卓上键盘避让只有一条机制 —— 原生把「系统栏 ∪ 键盘」的高度下发成
    //      --safe-bottom，body 用它让出底部空间，窗口**不**为键盘 resize（AndroidManifest 里
    //      windowSoftInputMode=adjustNothing）。这条链子一旦被谁再叠一次（平台又替我们 resize
    //      了一次视口、或内部某一层比容器高），多出来的那一截就会把 **document** 变成一个可滚容器：
    //      手指在弹幕列表上滑到底之后会**接力**滚它，整个界面（含房间顶栏）被顶上去、底边露出画布色
    //      （用户 2026-09-16 报的就是这个）。无头里没有 IME，所以这里验的是这条链子的**布局那一半**：
    //      ① 常态 ② 面板展开（固定高度的兄弟最多、最容易把外壳撑破的一档）③ 把 --safe-bottom 换成
    //      键盘高度（原生在键盘弹出时就是换这个值）三种状态下，文档都不可滚，且「body 铺满视口、
    //      #root 恰好短掉 body 的上下内边距（= 让开系统栏 / 键盘）」这条链子成立。
    //      IME 那一半（系统会不会额外 resize / 平移窗口）只能在设备上看，见 docs/ui.md §9.3。
    function docBox() {
      var se = document.scrollingElement;
      var bodyStyle = getComputedStyle(document.body);
      return {
        overflow: se.scrollHeight - se.clientHeight,
        scrollTop: se.scrollTop,
        bodyH: document.body.getBoundingClientRect().height,
        rootH: document.getElementById("root").getBoundingClientRect().height,
        viewH: window.innerHeight,
        // body 的上下内边距 = 让开系统栏 / 键盘的那两条（--safe-top / --safe-bottom）。
        // #root 的高度以百分比写在 body 上，解析的是 body 的**内容盒** —— 键盘那一档
        // 因此短掉内边距那么多，这不是漏让开，正是让开本身（见下面那条断言的说明）。
        padTop: Number.parseFloat(bodyStyle.paddingTop) || 0,
        padBottom: Number.parseFloat(bodyStyle.paddingBottom) || 0,
      };
    }
    var docIdle = docBox();
    if (!byTestId("db-panel")) { clickTool("表情"); await sleep(400); }
    var docPanel = docBox();
    if (byTestId("db-panel")) { clickTool("表情"); await sleep(400); }
    var rootStyle = document.documentElement.style;
    var prevSafeBottom = rootStyle.getPropertyValue("--safe-bottom");
    rootStyle.setProperty("--safe-bottom", "336px");
    await sleep(250);
    var docInset = docBox();
    var composerBox = rect(document.querySelector("textarea"));
    var composerVisible = !!composerBox && composerBox.top >= -1 &&
      composerBox.bottom <= window.innerHeight + 1 && composerBox.height > 0;
    // 令牌用完立刻复原：后面的断言还按正常视口量
    if (prevSafeBottom) rootStyle.setProperty("--safe-bottom", prevSafeBottom);
    else rootStyle.removeProperty("--safe-bottom");
    await sleep(200);
    out.docLayouts = { idle: docIdle, panel: docPanel, keyboardInset: docInset };
    out.docNeverScrollable = [docIdle, docPanel, docInset].every(function (d) {
      return d.overflow <= 1 && d.scrollTop === 0;
    });
    // body 是「整屏那一层」（border-box = 动态视口高），#root 的高度是**可用区** ——
    // 它以百分比写在 body 上、解析的是 body 的**内容盒**，所以正好等于「视口 − 上下内边距
    // （--safe-top / --safe-bottom）」。键盘那一档因此是设计意图，不是实现漂了：
    // 实测 idle / panel 两档 rootH = 900 = 视口高（两条内边距在桌面上都是 0），
    // keyboardInset 一档 rootH = 564 = 900 − 336（原生在键盘弹出时下发的就是 336px，
    // 见 docs/ui.md §9.3 与 index.css 顶上那段「界面自补内边距」）。
    // 旧写法要求 rootH 也 = 视口高，等于要求「让开键盘这件事不发生」。新写法钉住的是这条链子
    // 本身：body 铺满视口（不让开就没有那一截），root 恰好短掉 body 的内边距（谁把
    // height:100% / box-sizing 改坏都立刻红），三档一起成立才过。
    out.docHeightsMatchViewport = [docIdle, docPanel, docInset].every(function (d) {
      return Math.abs(d.bodyH - d.viewH) <= 1 &&
        Math.abs(d.rootH - (d.viewH - d.padTop - d.padBottom)) <= 1;
    });
    out.docComposerVisibleWithKeyboardInset = composerVisible;
    out.docSafeBottomRestored = rootStyle.getPropertyValue("--safe-bottom") === prevSafeBottom;

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
    // 贴底时的呼吸空间：末行底边 ↔ **滚动容器（.scroller）自己的底边**的间距必须 == 那个内边距。
    // 尺子为什么量容器而不是「面板顶边」（= 旧口径）：面板是**输入区**那一块里的弹出面板，
    // 而弹幕区与输入区之间现在还夹着**上下分区**（issue #8：礼物栏与弹幕区共享高度、中间一条
    // 8px 分割条；默认态礼物栏是折叠的，那一栏就是折叠头那么高）。于是旧口径量到的其实是
    // 「内边距 + 折叠头 + 分割条」：实测 42.7 = 8（内边距）+ 26.6（折叠头）+ 8.1（分割条），
    // 而它想验的从来不是这个和 —— 是「贴底时最新一条与它所在滚动区底边之间正好留着内边距」。
    // 新尺子一点没放水：贴底（layoutScrollBottomGapPx = 0）时内边距被谁挤掉（末行顶到容器边）
    // 或末行下方多出一截空隙，这条都会红。面板顶边那一份继续留在快照里（分割条口径的证据）。
    out.layoutNewestPanelGapPx = newestAfter
      ? Math.round((rect(panel).top - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutNewestContainerGapPx = newestAfter
      ? Math.round((rect(scroller).bottom - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutNewestGapIsPadding = out.layoutNewestContainerGapPx !== null &&
      Math.abs(out.layoutNewestContainerGapPx - out.layoutScrollerPaddingBottomPx) <= 1;
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
    // ⚠ 抬起（pointerup）这一步**不能省**：只发 pointerdown 不是「按了一下」，是「按住不放」。
    //    面板里那三处按下（tab 轨道 / 表情格）与弹幕列表都落在共享分区 .paneDanmaku 里，
    //    于是 SplitPanes 的「长按 0.5s 换位」计时器被真的挂上：500ms 后它照常触发 —— 那一栏
    //    进入换位拖拽态、document.body.userSelect 被置成 none，并在 window 上挂一个**吞掉
    //    下一次 click** 的捕获监听器（600ms 兜底才摘）。实测代价：pressedOnly(弹幕列表) 之后
    //    约 800ms 那一次 pressLike(通用 tab) 被它吞掉 —— 面板仍停在上一个分组，
    //    panelBackOnCommon 因此长期为假（点的是「通用」，量到的还是「本房间」）。
    //    真实用户的手势一定是「按下 + 抬起」，所以这里按 immTap 那条口径补齐抬起。
    var pressLike = function (el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      el.click();
    };
    var pressedOnly = function (el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
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
    var kindsNow = function () {
      var p = byTestId("db-panel");
      return p ? [].slice.call(p.querySelectorAll('[data-testid="db-emote-tab"]')).map(function (b) {
        return b.getAttribute("data-kind") + ":" + b.getAttribute("aria-selected");
      }) : null;
    };
    var commonTab = tabOf("common");
    out.panelBackOnCommonDiag = {
      commonTab: !!commonTab,
      kindsBefore: kindsNow(),
      selectedBefore: byTestId("db-panel") ? selectedKind() : "panel-gone",
      clicked: !!commonTab,
    };
    if (commonTab) pressLike(commonTab);
    await sleep(300);
    // 面板还在不在、还有哪些组、选中的是哪个 —— 快照里只留一个布尔的话，
    // 「组没了」「面板被关了」「点了没生效」三种情形长得一模一样。
    var panelAfterCommon = byTestId("db-panel");
    out.panelBackOnCommonDiag.kindsAfter = kindsNow();
    out.panelBackOnCommonDiag.selectedAfter = panelAfterCommon ? selectedKind() : "panel-gone";
    out.panelBackOnCommonDiag.emptyText = panelAfterCommon &&
      panelAfterCommon.querySelector('[class*="empty"]')
      ? panelAfterCommon.querySelector('[class*="empty"]').innerText.trim() : null;
    // 面板不在了（被谁关了）也是这条断言不成立的一种，不能让 selectedKind() 抛出去
    // （抛出去就是场景当场死掉，见 admin 那一段的教训）。
    out.panelBackOnCommon = !!panelAfterCommon && selectedKind() === "common";

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
    // 与上面那条同一支尺子（见那处的说明）：面板收起后列表下面这一档，量的仍是
    // 「末行 ↔ **滚动容器**底边 = 内边距」。输入区顶边那一份（旧口径）留在快照里做对照 ——
    // 它与新的容器底边之间正好差着折叠头 + 分割条（实测 42.8 − 8.1 ≈ 34.7）。
    out.layoutNewestGapComposerPx = afterCloseLast
      ? Math.round((rect(document.querySelector("textarea").parentElement).top -
          rect(afterCloseLast).bottom) * 10) / 10
      : null;
    out.layoutNewestGapNoPanelPx = afterCloseLast
      ? Math.round((rect(afterCloseScroller).bottom - rect(afterCloseLast).bottom) * 10) / 10
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

