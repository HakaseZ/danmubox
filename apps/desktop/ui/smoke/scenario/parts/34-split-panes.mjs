// 场景块：共享分区：分割条与长按换位
//   splitter 弹幕区与礼物栏上下分区、分割条热区 ≥ 8px、拖动实时改比例且松手才落盘
//   默认份额 0.25（= 1 : 3）、**拖动全程开合态不变、松手才收起 / 展开**、ESC 只还原份额
//   折叠态列表与三枚筛选芯片照旧挂载（被这一栏裁掉）、展开即刻可见且不重挂
//   拖到极限时两栏最小高度成立（弹幕区 ≥ 3 行、礼物栏 ≥ 总计条）且总量不溢出、比例重挂后保持
//   键盘 ↑↓ 微调（连按只落盘一次）、长按 0.5s 换位与三种取消路、切标签回来后本地状态复位
//   ui.gift_panel 关掉后分区退化为弹幕区全高
//
// 开合态一律读 `db-gift-toggle` 的 `aria-expanded`：列表根 `db-gift-area` 自需求 5.1–5.4
// （单轴模型）起**折叠也挂载**，拿它在场与否当开合会恒为真。
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ================= 共享分区：分割条与长按换位（issue #8，用户 2026-09-16）=================
    //
    // 这一段的两条手势都是**指针事件**（鼠标与触摸走同一条路，见 SplitPanes.tsx），场景里按真实
    // 序列派发：pointerdown →（长按 0.5s）pointermove → pointerup。派发目标是「按下落在那一栏 /
    // 分割条上（React 的 onPointerDown 就挂在它们身上），之后的 move / up 落在 window（组件在
    // 拖动期间挂的就是 window 级监听）」—— 与真手指走出的是同一批监听器。运行器只送 click 与
    // 取快照，没有真实指针通道，所以这是页面内能给出的最接近的一次（与既有 pointerdown 断言同一手法）。
    // 注意：这一段当年活在模板字符串里（反引号与反斜杠都不能写）；2026-09-17 拆分后片段是页内原文，约束已消失。
    var firePointer = function (target, type, x, y, kind) {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 77, pointerType: kind || "touch",
        clientX: Math.round(x), clientY: Math.round(y),
      }));
    };
    // 量出来的**份额**：礼物栏高度 / 可用高度（分区高度减去分割条）。这就是「指针意图」落在
    // 屏幕上的那一份，用它跟落盘的值对账。
    var shownRatio = function () {
      var panesBox = rect(byTestId("db-panes"));
      var splitBox = rect(byTestId("db-pane-splitter"));
      if (!panesBox || !splitBox) return null;
      return Math.round((rect(byTestId("db-pane-gift")).height / (panesBox.height - splitBox.height)) * 1000) / 1000;
    };
    var splitterMid = function () {
      var box = rect(byTestId("db-pane-splitter"));
      return box ? box.top + box.height / 2 : 0;
    };
    // 这一下就是「点面板外面」那条路：把可能还开着的面板收掉，免得分区被面板压着、几何不干净
    if (byTestId("db-panel")) {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
    }
    // 归一形态：礼物栏折叠（点总计条右端那枚小箭头收起；它顺带收起别的面板）。
    // 判据是 `aria-expanded`（不是列表根在不在场，见文件头）。
    var giftToggleEl = byTestId("db-gift-toggle");
    var giftExpandedNow = function () {
      var el = byTestId("db-gift-toggle");
      return el ? el.getAttribute("aria-expanded") : null;
    };
    if (giftExpandedNow() === "true") {
      giftToggleEl.click();
      await sleep(350);
    }
    var panesBox0 = rect(byTestId("db-panes"));
    var splitBox0 = rect(byTestId("db-pane-splitter"));
    var giftBox0 = rect(byTestId("db-pane-gift"));
    var danmakuBox0 = rect(byTestId("db-pane-danmaku"));
    var headBox0 = rect(byTestId("db-gift-total"));
    var ratioAtEntry = window.__prefs["ui.gift_pane_ratio"];
    var splitX = panesBox0.left + panesBox0.width / 2;

    out.splitterPresent = !!splitBox0 && !!giftBox0 && !!danmakuBox0 &&
      byTestId("db-panes").getAttribute("data-gift") === "on";
    out.splitterHitAreaPx = Math.round(splitBox0.height * 10) / 10;
    out.splitterHitAreaAtLeast8 = splitBox0.height >= 8;
    // 默认顺序：弹幕在上、礼物在下（契约 §8 的默认值 = 与改前一致的那个形态）。
    // **2026-09-27 判据校准**：分割条现在**浮起**（`margin-block: -4px`，不占布局高度，
    // 见 app.module.css 的 `.splitter`），它在布局上已经不「夹」在两栏之间 —— 而是**叠在交界之上**，
    // 所以「礼物在下」不能再用「分割条盒子整体落在两栏之间」判（新几何下那个条件恒不成立，
    // 与顺序无关）。真判据是「礼物栏顶边就是交界」—— 交界 = 分割条的**中线**（那条线也画在那儿）。
    out.splitterDefaultOrderGiftBelow =
      Math.abs(danmakuBox0.bottom - splitterMid()) < 1 &&
      Math.abs(giftBox0.top - splitterMid()) < 1 &&
      giftBox0.top > danmakuBox0.top &&
      window.__prefs["ui.gift_pane_on_top"] === false;
    out.splitterDefaultBoxesPx = {
      danmaku: [Math.round(danmakuBox0.top * 10) / 10, Math.round(danmakuBox0.bottom * 10) / 10],
      splitter: [Math.round(splitBox0.top * 10) / 10, Math.round(splitBox0.bottom * 10) / 10],
      gift: [Math.round(giftBox0.top * 10) / 10, Math.round(giftBox0.bottom * 10) / 10],
    };
    // 折叠态：礼物栏只有总计条那么高（单轴模型里它就是「份额被压到下限以下 + 这一栏裁剪」
    // 的样子 —— 高度由最小高度兜住，不是份额驱动的）
    out.splitterCollapsedGiftIsHeadHeight = giftExpandedNow() === "false" &&
      Math.abs(giftBox0.height - headBox0.height) <= 1;
    out.splitterDefaultRatioPref = ratioAtEntry;
    out.splitterDefaultRatioIsQuarter = Math.abs(ratioAtEntry - 0.25) < 1e-9;
    out.splitterDefaultOnTopPref = window.__prefs["ui.gift_pane_on_top"] === false;
    // ---- 单轴模型（需求 5.1–5.4）：折叠态下礼物**列表与三枚筛选芯片照旧挂载**，
    //      只是落在这一栏的裁剪区外（看不见）。两步判据：① DOM 里在；
    //      ② 它们的盒子在礼物栏这一栏的矩形**之外**（这一栏 overflow: hidden，所以看不见）。
    var foldFilterBox = rect(byTestId("db-gift-filter"));
    var outsidePane = function (box, paneBox) {
      if (!box || !paneBox) return null;
      return box.top >= paneBox.bottom - 1 || box.bottom <= paneBox.top + 1;
    };
    out.splitterCollapsedKeepsChips = !!byTestId("db-gift-area") &&
      !!byTestId("db-gift-scroll") && !!byTestId("db-gift-filter") &&
      allByTestId("db-gift-chip").length === 3;
    out.splitterCollapsedChipsClipped = outsidePane(foldFilterBox, giftBox0) === true;
    // 「展开不重挂」的判据：给列表根与筛选条挂一个自定义属性，走完这一次开合它们必须还在
    // （重挂会把它们带走 —— 那正是改前「展开才挂载」的形态）。
    var giftAreaEl = byTestId("db-gift-area");
    var giftFilterEl = byTestId("db-gift-filter");
    if (giftAreaEl) giftAreaEl.setAttribute("data-smoke-keep", "list");
    if (giftFilterEl) giftFilterEl.setAttribute("data-smoke-keep", "filter");

    // ---- 拖动分割条（鼠标指针这一路）：实时改比例、**全程不改开合态**、松手才落盘 ----
    var dragFoldBefore = giftExpandedNow();
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid(), "mouse");
    firePointer(window, "pointermove", splitX, splitterMid() - 100, "mouse");
    await sleep(80);
    var midGiftBox = rect(byTestId("db-pane-gift"));
    out.splitterDragLiveGrewPx = Math.round(midGiftBox.height - giftBox0.height);
    out.splitterDragLiveGrew = midGiftBox.height > giftBox0.height + 80;
    // 需求 4.2：拖动**全程**不改开合状态 —— 折叠着也照样被拖开（几何实时长起来），
    // 但那一档开合状态一动不动（改前在这里就已经 onExpand 了）。
    out.splitterDragKeepsFoldState = giftExpandedNow() === dragFoldBefore;
    // 拖动中**一帧都不写 store**：磁盘上还是进来时那一份
    out.splitterDragLiveWithoutStore = window.__prefs["ui.gift_pane_ratio"] === ratioAtEntry;
    firePointer(window, "pointerup", splitX, splitterMid() - 100, "mouse");
    await sleep(450);
    var draggedRatio = shownRatio();
    out.splitterDraggedRatioShown = draggedRatio;
    out.splitterDragPersistsRatio = !!draggedRatio &&
      Math.abs(window.__prefs["ui.gift_pane_ratio"] - draggedRatio) < 0.02;
    // 松手才判开合：折叠态被拖开 → 展开（与点那枚小箭头同一条路，需求 4.3 / 4.4）
    out.splitterDragExpandsOnRelease = dragFoldBefore === "false" && giftExpandedNow() === "true";
    // 展开**即刻可见**（需求 5.4）：三枚芯片的盒子回到礼物栏这一栏里（裁剪区收起来）；
    // 且列表与筛选条还是**同两个节点**（`data-smoke-keep` 还在 ⇒ 没有被重新挂载）。
    var grownFilterBox = rect(byTestId("db-gift-filter"));
    var grownGiftBox = rect(byTestId("db-pane-gift"));
    out.splitterExpandedChipsVisible = !!grownFilterBox && !!grownGiftBox &&
      outsidePane(grownFilterBox, grownGiftBox) === false;
    out.splitterExpandDoesNotRemount = byTestId("db-gift-area") !== null &&
      byTestId("db-gift-area").getAttribute("data-smoke-keep") === "list" &&
      byTestId("db-gift-filter").getAttribute("data-smoke-keep") === "filter";
    // 「涨了」要比**当时屏幕上的那一份**：折叠态下这一栏只有总计条那么高（份额约 0.03），
    // 而 ratioAtEntry 是「上次拖到哪儿」的意图、折叠时并没有落到屏幕上（0.25 或别的那个数
    // 在折叠态下看不见），拿它当基准会把「确实长大了」判成没长。
    var shownAtEntry = giftBox0.height / (panesBox0.height - splitBox0.height);
    out.splitterDragGrewOnScreen = !!draggedRatio && draggedRatio > shownAtEntry + 0.05;
    snap();

    // ---- 切到另一个房间标签再切回来：RoomView 的**本地状态**复位（room_id 那条 effect：
    //      礼物栏回到折叠、面板收起…），输入区那份比例落在 prefs 上、因此原样保持。
    // ⚠ 判据不能要求「标签条上正好两枚」：这一段跑在**标签条拖动那一段之后**，
    //   那一段用 __addRooms(n) 又开了好几个房间，标签数早就不是 2 了 ——
    //   旧写法（length === 2）于是恒为假，三条件一起红，还把「本地状态复位」这条口径
    //   悄悄跳过（实测两引擎 × 两个视口全红）。改成**按标签自己的 data-active 找当前房间**，
    //   再挑一枚别的房间，与标签数无关。
    var tabsForRemount = allByTestId("db-room-tab");
    var activeTabForRemount = tabsForRemount.filter(function (t) {
      return t.getAttribute("data-active") === "true";
    })[0];
    var otherTabForRemount = tabsForRemount.filter(function (t) {
      return t !== activeTabForRemount;
    })[0];
    var remountAvailable = !!activeTabForRemount && !!otherTabForRemount;
    var tabByRoomId = function (roomId) {
      return allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === roomId;
      })[0];
    };
    if (remountAvailable) {
      var remountRoomId = activeTabForRemount.getAttribute("data-room-id");
      var otherRoomId = otherTabForRemount.getAttribute("data-room-id");
      // ⚠ 先点一次**当前这一枚**标签，把标签条的「吞掉这一下 click」标志消费掉：标签条拖动
      //    那一段（排在文件里本段之前）用真实指针事件做了好几次拖动排序，而真实浏览器在
      //    pointerup 之后**还会补一发 click**（App 的 swallowClick 就是为它准备的：拖完不许
      //    顺手切房间），场景里没有补那一发，于是那个标志一直挂着 true，会把**紧接着的第一次**
      //    标签点击吞掉 —— 本段第一次点「别的房间」正好撞上。实测：activeAfterOther 仍是 5440，
      //    房间根本没换，下面两条断言（折叠态 / 比例保持）跟着一起红。点自己这一枚不换房间，
      //    正好当消费；标志为假时它也只是原地重开一次，无副作用。
      activeTabForRemount.click();
      await sleep(250);
      var remountProbe = {
        activeBefore: remountRoomId,
        other: otherRoomId,
        // 开合态读 `aria-expanded`（列表根折叠也挂载，见文件头）；顺带记下「它在场上」。
        giftExpandBefore: giftExpandedNow(),
        giftListMounted: !!byTestId("db-gift-area"),
        giftHeightBefore: Math.round(rect(byTestId("db-pane-gift")).height * 10) / 10,
        headHeightBefore: Math.round(headBox0.height * 10) / 10,
        ratioPrefBefore: window.__prefs["ui.gift_pane_ratio"],
      };
      otherTabForRemount.click();
      await sleep(700);
      remountProbe.activeAfterOther = (function () {
        var t = allByTestId("db-room-tab").filter(function (x) {
          return x.getAttribute("data-active") === "true";
        })[0];
        return t ? t.getAttribute("data-room-id") : null;
      })();
      remountProbe.giftExpandAfterOther = giftExpandedNow();
      remountProbe.giftListMountedAfterOther = !!byTestId("db-gift-area");
      tabByRoomId(remountRoomId).click();
      await sleep(900);
      remountProbe.activeAfterBack = (function () {
        var t = allByTestId("db-room-tab").filter(function (x) {
          return x.getAttribute("data-active") === "true";
        })[0];
        return t ? t.getAttribute("data-room-id") : null;
      })();
      remountProbe.giftExpandAfterBack = giftExpandedNow();
      remountProbe.giftListMountedAfterBack = !!byTestId("db-gift-area");
      remountProbe.giftHeightAfterBack = byTestId("db-pane-gift")
        ? Math.round(rect(byTestId("db-pane-gift")).height * 10) / 10 : null;
      remountProbe.ratioPrefAfterBack = window.__prefs["ui.gift_pane_ratio"];
      out.splitterRemountProbe = remountProbe;
    }
    // 切房那一趟做得出来才算数（标签条上至少要有两枚、且能认出当前那一枚）；
    // 做不出就是夹具的事，明着写出来，不把它悄悄放过 —— 与 tabs 那一段的 tabsRendered 同一条口径。
    out.splitterRemountAvailable = remountAvailable;
    out.splitterCollapsedAfterRemount = remountAvailable && giftExpandedNow() === "false" &&
      Math.abs(rect(byTestId("db-pane-gift")).height - headBox0.height) <= 1;
    // 单轴模型：切房之后礼物列表照旧**在场**（折叠 ≠ 卸载；复位复位的是开合那一档，
    // 不是把这一栏从场上撤掉）。
    out.splitterListStaysMountedAfterRemount = remountAvailable && !!byTestId("db-gift-area");
    byTestId("db-gift-toggle").click();
    await sleep(400);
    var remountedRatio = shownRatio();
    out.splitterRatioSurvivesRemount = remountAvailable && !!remountedRatio && !!draggedRatio &&
      Math.abs(remountedRatio - draggedRatio) < 0.02 &&
      Math.abs(remountedRatio - window.__prefs["ui.gift_pane_ratio"]) < 0.02;
    snap();

    // ---- 拖到极限（向上）：弹幕区不小于 **3 行**、整块不溢出 ----
    var rowHeights = rows().map(function (r) { return rect(r).height; });
    var minRow = Math.min.apply(null, rowHeights);
    var panesBox1 = rect(byTestId("db-panes"));
    var upFoldBefore = giftExpandedNow();
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, panesBox1.top - 300);
    await sleep(80);
    // 往上拖到顶（份额被夹在 0.9）也**不改开合态**（需求 4.2）
    out.splitterExtremeUpKeepsFoldState = giftExpandedNow() === upFoldBefore;
    firePointer(window, "pointerup", splitX, panesBox1.top - 300);
    await sleep(450);
    var upDanmaku = rect(byTestId("db-pane-danmaku"));
    var upGift = rect(byTestId("db-pane-gift"));
    var upSplit = rect(byTestId("db-pane-splitter"));
    out.splitterMinRowHeightPx = Math.round(minRow * 10) / 10;
    out.splitterExtremeUpKeepsThreeRows = upDanmaku.height >= 3 * minRow - 8;
    // 「拖到极限也不溢出」：**两栏高度之和 = 分区高度**（允许 1px 取整误差）。
    // **2026-09-27 判据校准**：分割条现在**不占布局高度**（`margin-block: -4px` 上下各让掉自身一半，
    // 自己的 8px 与两块负 margin 正好抵掉），所以正确的等式是**两栏**之和 —— 旧写法把分割条的
    // 8px 也算进去，恒多出一个热区的高度（实测 8.0），量的是「热区占不占位」而不是「溢不溢出」。
    // 与此同时多钉一条：两栏与分割条本身都仍落在分区盒子里（它只是被允许重叠，不是跑到外面去）。
    out.splitterExtremeUpPaneSumPx = {
      danmaku: Math.round(upDanmaku.height * 10) / 10,
      gift: Math.round(upGift.height * 10) / 10,
      splitter: Math.round(upSplit.height * 10) / 10,
      panes: Math.round(panesBox1.height * 10) / 10,
    };
    out.splitterExtremeUpNoOverflow =
      Math.abs(upGift.height + upDanmaku.height - panesBox1.height) <= 1 &&
      upSplit.top >= panesBox1.top - 1 && upSplit.bottom <= panesBox1.bottom + 1 &&
      upDanmaku.top >= panesBox1.top - 1 && upGift.bottom <= panesBox1.bottom + 1;
    out.splitterExtremeUpClampedRatio = window.__prefs["ui.gift_pane_ratio"] === 0.9;
    // 份额停在 0.9（在下限之上）⇒ 松手也不动开合，仍是展开
    out.splitterExtremeUpStaysExpanded = giftExpandedNow() === "true";

    // ---- 拖到极限（向下）：礼物栏不小于它的总计条；**压到下限以下 = 松手收起**（需求 4.3）----
    var downFoldBefore = giftExpandedNow();
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, panesBox1.bottom + 300);
    await sleep(80);
    // 已经压过下限了，但这一帧开合态还没变（收起来自**松手**那一下，不是拖动途中）
    out.splitterPressedPastMinKeepsFold = downFoldBefore === "true" &&
      giftExpandedNow() === "true" &&
      window.__prefs["ui.gift_pane_ratio"] === 0.9;
    firePointer(window, "pointerup", splitX, panesBox1.bottom + 300);
    await sleep(450);
    var downGift = rect(byTestId("db-pane-gift"));
    var downHead = rect(byTestId("db-gift-total"));
    out.splitterExtremeDownKeepsHead = downGift.height >= downHead.height - 1 && downHead.height > 0;
    out.splitterExtremeDownClampedRatio = window.__prefs["ui.gift_pane_ratio"] === 0.1;
    out.splitterPressedPastMinCollapsesOnRelease = giftExpandedNow() === "false" &&
      Math.abs(downGift.height - downHead.height) <= 1;

    // ---- 取消（ESC）：**只还原份额、不留中间态**（需求 4.3）----
    //      起手是折叠（上一段刚收起、份额 0.1）→ 拖开（屏幕上的份额实时长起来）→ ESC：
    //      几何回到起手那一份、开合**始终**是折叠、偏好一个数都没变。
    var cancelPrefBefore = window.__prefs["ui.gift_pane_ratio"];
    var cancelHeightBefore = rect(byTestId("db-pane-gift")).height;
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid(), "mouse");
    firePointer(window, "pointermove", splitX, splitterMid() - 140, "mouse");
    await sleep(80);
    var cancelMidBox = rect(byTestId("db-pane-gift"));
    out.splitterCancelDraggedLive = cancelMidBox.height > cancelHeightBefore + 60;
    out.splitterCancelKeepsFoldState = giftExpandedNow() === "false";
    pressEscape();
    await sleep(300);
    out.splitterEscapeRestoresShareOnly =
      Math.abs(window.__prefs["ui.gift_pane_ratio"] - cancelPrefBefore) < 1e-9 &&
      giftExpandedNow() === "false" &&
      Math.abs(rect(byTestId("db-pane-gift")).height - cancelHeightBefore) <= 1 &&
      byTestId("db-panes").getAttribute("data-dragging") === null;
    out.splitterCancelNoCrash = !!byTestId("db-room-header");

    // ---- 键盘可达：分割条可聚焦，↑↓ 每次微调 0.02，连按只有最后一次落盘 ----
    var splitterEl = byTestId("db-pane-splitter");
    out.splitterIsSeparator = splitterEl.getAttribute("role") === "separator" &&
      splitterEl.getAttribute("tabindex") === "0" &&
      splitterEl.getAttribute("aria-orientation") === "horizontal" &&
      splitterEl.getAttribute("aria-valuenow") !== null;
    var ratioBeforeKeys = window.__prefs["ui.gift_pane_ratio"];
    pressKey(splitterEl, "ArrowUp");
    pressKey(splitterEl, "ArrowUp");
    await sleep(900);
    out.splitterKeyboardAdjustsRatio =
      Math.abs(window.__prefs["ui.gift_pane_ratio"] - (ratioBeforeKeys + 0.04)) < 0.001;
    out.splitterKeyboardReflectsOnScreen =
      Math.abs(shownRatio() - window.__prefs["ui.gift_pane_ratio"]) < 0.02;
    snap();

    // ---- 长按换位（触摸指针这一路）：按住 0.62s → 该栏半透明跟随指针 → 拖过另一栏松手 = 互换 ----
    var giftBoxSwap = rect(byTestId("db-pane-gift"));
    var danmakuBoxSwap = rect(byTestId("db-pane-danmaku"));
    var ratioBeforeSwap = window.__prefs["ui.gift_pane_ratio"];
    var giftHeightBeforeSwap = giftBoxSwap.height;
    firePointer(byTestId("db-pane-danmaku"), "pointerdown", splitX, danmakuBoxSwap.top + 30);
    await sleep(620);
    out.swapDragArmed = byTestId("db-pane-danmaku").getAttribute("data-swap-drag") === "true";
    firePointer(window, "pointermove", splitX, giftBoxSwap.bottom - 4);
    await sleep(80); // 落点提示（data-swap-over）是 setState 换出来的，要等一次重渲染
    var draggedStyle = getComputedStyle(byTestId("db-pane-danmaku"));
    out.swapDragTranslucentFollowing = draggedStyle.transform !== "none" &&
      parseFloat(draggedStyle.opacity) < 1;
    out.swapDropTargetHinted = byTestId("db-pane-gift").getAttribute("data-swap-over") === "true";
    firePointer(window, "pointerup", splitX, giftBoxSwap.bottom - 4);
    await sleep(450);
    var afterSwapGift = rect(byTestId("db-pane-gift"));
    var afterSwapSplit = rect(byTestId("db-pane-splitter"));
    var afterSwapDanmaku = rect(byTestId("db-pane-danmaku"));
    // 两栏真的换了上下：礼物栏在上面、弹幕区在下面，交界处仍是分割条的**中线**
    // （同一处口径见上面的 `splitterDefaultOrderGiftBelow`：热区浮起之后它不再夹在两栏之间，
    // 「礼物在上」因此不能用「分割条盒子整体落在两栏之间」判 —— 那个写法在新几何下与顺序无关）。
    var afterSwapMid = afterSwapSplit.top + afterSwapSplit.height / 2;
    out.swapAfterBoxesPx = {
      gift: [Math.round(afterSwapGift.top * 10) / 10, Math.round(afterSwapGift.bottom * 10) / 10],
      splitter: [Math.round(afterSwapSplit.top * 10) / 10, Math.round(afterSwapSplit.bottom * 10) / 10],
      danmaku: [Math.round(afterSwapDanmaku.top * 10) / 10, Math.round(afterSwapDanmaku.bottom * 10) / 10],
      mid: Math.round(afterSwapMid * 10) / 10,
    };
    out.swapByLongPress = window.__prefs["ui.gift_pane_on_top"] === true &&
      Math.abs(afterSwapGift.bottom - afterSwapMid) < 1 &&
      Math.abs(afterSwapDanmaku.top - afterSwapMid) < 1 &&
      afterSwapGift.top < afterSwapDanmaku.top;
    // 换位**不改比例**：礼物栏高度一个像素都不变，只是挪到了上面（契约 §8 / ui.md §5.4 的口径）
    out.swapKeepsRatio = window.__prefs["ui.gift_pane_ratio"] === ratioBeforeSwap &&
      Math.abs(afterSwapGift.height - giftHeightBeforeSwap) <= 2;
    snap();

    // ---- 三种「不算长按」/「取消」的路：短按、按住前就移动（在滚列表）、ESC ----
    firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, rect(byTestId("db-pane-gift")).top + 6);
    await sleep(300);
    firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
    firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
    await sleep(350);
    out.swapIgnoresShortPress = byTestId("db-pane-gift").getAttribute("data-swap-drag") === null &&
      window.__prefs["ui.gift_pane_on_top"] === true;

    firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, rect(byTestId("db-pane-gift")).top + 6);
    firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-gift")).top + 60);
    await sleep(700);
    out.swapIgnoresMoveBeforeHold = byTestId("db-pane-gift").getAttribute("data-swap-drag") === null;
    firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-gift")).top + 60);
    await sleep(300);
    out.swapStillDefaultAfterIgnoredGestures = window.__prefs["ui.gift_pane_on_top"] === true;

    firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, rect(byTestId("db-pane-gift")).top + 6);
    await sleep(620);
    var escArmed = byTestId("db-pane-gift").getAttribute("data-swap-drag") === "true";
    firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-danmaku")).top + 40);
    pressEscape();
    await sleep(200);
    out.swapCancelsOnEscape = escArmed &&
      byTestId("db-pane-gift").getAttribute("data-swap-drag") === null &&
      byTestId("db-pane-danmaku").getAttribute("data-swap-over") === null;
    firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-danmaku")).top + 40);
    await sleep(350);
    out.swapStaysCancelled = window.__prefs["ui.gift_pane_on_top"] === true;
    snap();

    // ---- 「触摸上手势归谁」的对外可观察面（本次修复的回归闸）：拿起来之后，区块上的
    //      touchmove 必须被 preventDefault（滚动收走），没拿起来时**不许**拦
    //      （弹幕列表照旧滚）。旧实现只靠 CSS 的 touch-action 与 pointermove.preventDefault()，
    //      两个都拦不住滚动 —— 浏览器在 **touchstart 那一刻**就把 touch-action 快照走了。
    //      真机实测（Android WebView Chrome/124，CDP 注入真实触摸）：按住 560ms 进入换位态后
    //      第一次 pointermove 就收到 pointercancel，换位一次都没成过；而合成 PointerEvent
    //      绕开了浏览器的手势管线，所以这个真机故障在冒烟里一直照不出来。
    var paneTouchMoveProbe = function (target) {
      try {
        var ev = new TouchEvent("touchmove", { bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      } catch (e) {
        return "throw:" + e.message;
      }
    };
    var danmakuProbeEl = byTestId("db-pane-danmaku");
    var danmakuProbeBox = rect(danmakuProbeEl);
    out.swapTouchMoveFreeWhenIdle = paneTouchMoveProbe(danmakuProbeEl) === false;
    var dockBoxBeforeNextTap = rect(byTestId("db-gift-total"));
    // 「这一栏开合」的量法 = 总计条右端那枚小箭头的 `aria-expanded`（`docs/ui.md` §5.3 的钩子表）。
    // **不能**拿列表根 `db-gift-area` 在不在场当开合：需求 5.1–5.4 之后它折叠也挂载，
    // 两态都在场、判据恒为假。**也不能**拿 db-gift-body：那是**行内**的正文格
    // （MessageRow 的 t("body")），只有「本来就有礼物行」时才存在；本段跑在送礼那几段之后、
    // 当前房间里礼物列表已空，开合两态都取不到它（改前就是这么假失败的）。
    var giftFoldBeforeNextTap = byTestId("db-gift-toggle").getAttribute("aria-expanded");
    firePointer(danmakuProbeEl, "pointerdown", splitX, danmakuProbeBox.top + 30);
    await sleep(620);
    out.swapTouchMoveOwnedWhenArmed = paneTouchMoveProbe(danmakuProbeEl) === true;
    // 同一栏里挪一小段（不越过分割条 = 不换位），松手
    firePointer(window, "pointermove", splitX, danmakuProbeBox.top + 60);
    await sleep(80);
    firePointer(window, "pointerup", splitX, danmakuProbeBox.top + 60);
    // ---- 紧接着（旧实现 600ms 兜底窗口**之内**）真的按一下礼物折叠头：它必须照旧开合。
    //      旧实现用一个 600ms 的全局捕获定时器去猜「那一下 click 来没来」，这段时间里
    //      任何一处点击都会被吃掉（冒烟里的 panelBackOnCommon 就是这么假失败的）。
    //      这里按下 -> 抬起 -> click 三步齐全，与用户真按一次完全同形。
    await sleep(120);
    firePointer(byTestId("db-gift-toggle"), "pointerdown",
      dockBoxBeforeNextTap.left + dockBoxBeforeNextTap.width / 2,
      dockBoxBeforeNextTap.top + dockBoxBeforeNextTap.height / 2);
    firePointer(byTestId("db-gift-toggle"), "pointerup",
      dockBoxBeforeNextTap.left + dockBoxBeforeNextTap.width / 2,
      dockBoxBeforeNextTap.top + dockBoxBeforeNextTap.height / 2);
    byTestId("db-gift-toggle").click();
    await sleep(400);
    out.swapDoesNotEatNextTap =
      byTestId("db-gift-toggle").getAttribute("aria-expanded") !== giftFoldBeforeNextTap;
    snap();

    // ---- 关掉独立礼物栏：分区退化为弹幕区全高、分割条与礼物栏一起消失、换位随之停用 ----
    var giftSwitchOff = setGiftSwitch("独立礼物栏", false);
    if (!giftSwitchOff) {
      // 面板可能关着、也可能开着别的那个：先点面板外收干净，再明确开筛选面板重来一次
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
      clickTool("筛选");
      await sleep(350);
      giftSwitchOff = setGiftSwitch("独立礼物栏", false);
    }
    if (!giftSwitchOff) {
      // 还是没摸到那枚开关：把现场留下来（值字段，不是断言），免得只剩一个 false 无从判断
      var panelNow = byTestId("db-panel");
      var toolsNow = byTestId("db-composer-tools");
      out.splitterGiftSwitchDiag = {
        panel: !!panelNow,
        labels: panelNow
          ? [].slice.call(panelNow.querySelectorAll("label")).map(function (l) { return l.innerText.trim(); })
          : [],
        tools: toolsNow
          ? [].slice.call(toolsNow.querySelectorAll("button")).map(function (b) { return b.innerText.trim(); })
          : [],
      };
    }
    await sleep(450);
    var offPanes = rect(byTestId("db-panes"));
    var offDanmaku = rect(byTestId("db-pane-danmaku"));
    out.splitterGiftSwitchOffTouched = giftSwitchOff;
    out.splitterGoneWhenGiftPanelOff = !byTestId("db-pane-splitter") && !byTestId("db-pane-gift");
    out.splitterRegionGivesAllToDanmaku = !!offPanes && !!offDanmaku &&
      Math.abs(offDanmaku.height - offPanes.height) <= 1;
    // 没有另一栏可换：长按下去不该有任何动静（也不该抛）
    firePointer(byTestId("db-pane-danmaku"), "pointerdown", splitX, offDanmaku.top + 30);
    await sleep(620);
    out.splitterSwapInertWithoutGiftPane =
      byTestId("db-pane-danmaku").getAttribute("data-swap-drag") === null;
    firePointer(window, "pointerup", splitX, offDanmaku.bottom - 20);
    await sleep(300);
    out.splitterNoCrashWithoutGiftPane = !!byTestId("db-room-header");

    // ---- 收尾：礼物栏开回来，并把两枚键恢复默认（份额 0.25 = 契约 §8 的默认值、礼物在下）----
    if (!byTestId("db-panel")) {
      clickTool("筛选");
      await sleep(350);
    }
    var giftSwitchBackOn = setGiftSwitch("独立礼物栏", true);
    if (!giftSwitchBackOn) {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(250);
      clickTool("筛选");
      await sleep(350);
      giftSwitchBackOn = setGiftSwitch("独立礼物栏", true);
    }
    out.splitterGiftSwitchBackOn = giftSwitchBackOn;
    await sleep(450);
    out.splitterRestoredPane = !!byTestId("db-pane-splitter") && !!byTestId("db-pane-gift") &&
      window.__prefs["ui.gift_panel"] === true;
    if (window.__prefs["ui.gift_pane_on_top"] === true) {
      var giftBoxBack = rect(byTestId("db-pane-gift"));
      firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, giftBoxBack.top + 6);
      await sleep(620);
      firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
      firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
      await sleep(450);
    }
    var panesBoxEnd = rect(byTestId("db-panes"));
    var splitBoxEnd = rect(byTestId("db-pane-splitter"));
    var targetY = panesBoxEnd.top + splitBoxEnd.height / 2 +
      (panesBoxEnd.height - splitBoxEnd.height) * (1 - 0.25);
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, targetY);
    firePointer(window, "pointerup", splitX, targetY);
    await sleep(450);
    out.splitterRestoredRatio = Math.abs(window.__prefs["ui.gift_pane_ratio"] - 0.25) < 0.02;
    out.splitterRestoredOrder = window.__prefs["ui.gift_pane_on_top"] === false;
    out.splitterRestoredShownRatio = Math.abs(shownRatio() - 0.25) < 0.02;
    snap();

