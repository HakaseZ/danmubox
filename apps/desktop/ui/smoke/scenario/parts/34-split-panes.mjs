// 场景块：共享分区：分割条与长按换位
//   splitter 弹幕区与礼物栏上下分区、分割条热区 ≥ 8px、拖动实时改比例且松手才落盘
//   拖到极限时两栏最小高度成立（弹幕区 ≥ 3 行、礼物栏 ≥ 折叠头）且总量不溢出、比例重挂后保持
//   键盘 ↑↓ 微调（连按只落盘一次）、长按 0.5s 换位与三种取消路、切标签回来后本地状态复位
//   ui.gift_panel 关掉后分区退化为弹幕区全高
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
    // 归一形态：礼物栏折叠（点折叠头收起；它顺带收起别的面板）
    if (byTestId("db-gift-area")) {
      byTestId("db-gift-dock").click();
      await sleep(350);
    }
    var panesBox0 = rect(byTestId("db-panes"));
    var splitBox0 = rect(byTestId("db-pane-splitter"));
    var giftBox0 = rect(byTestId("db-pane-gift"));
    var danmakuBox0 = rect(byTestId("db-pane-danmaku"));
    var headBox0 = rect(byTestId("db-gift-dock"));
    var ratioAtEntry = window.__prefs["ui.gift_pane_ratio"];
    var splitX = panesBox0.left + panesBox0.width / 2;

    out.splitterPresent = !!splitBox0 && !!giftBox0 && !!danmakuBox0 &&
      byTestId("db-panes").getAttribute("data-gift") === "on";
    out.splitterHitAreaPx = Math.round(splitBox0.height * 10) / 10;
    out.splitterHitAreaAtLeast8 = splitBox0.height >= 8;
    // 默认顺序：弹幕在上、礼物在下（契约 §8 的默认值 = 与改前一致的那个形态）
    out.splitterDefaultOrderGiftBelow =
      danmakuBox0.bottom <= splitBox0.top + 1 && splitBox0.bottom <= giftBox0.top + 1;
    // 折叠态：礼物栏只有折叠头那么高（「礼物栏不小于它的折叠头」这条约束的常态）
    out.splitterCollapsedGiftIsHeadHeight = !byTestId("db-gift-area") &&
      Math.abs(giftBox0.height - headBox0.height) <= 1;
    out.splitterDefaultRatioPref = ratioAtEntry;
    out.splitterDefaultOnTopPref = window.__prefs["ui.gift_pane_on_top"] === false;

    // ---- 拖动分割条（鼠标指针这一路）：实时改比例、折叠态下「拖开就展开」、松手才落盘 ----
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid(), "mouse");
    firePointer(window, "pointermove", splitX, splitterMid() - 100, "mouse");
    // 折叠态下的这一次移动会顺手把礼物栏**展开**（onExpand → setState），展开要等 React 重渲染
    // 之后才看得见；同步读几何会读到展开前的那一帧（页面内派发没有真实输入那一趟往返）。
    await sleep(80);
    var midGiftBox = rect(byTestId("db-pane-gift"));
    out.splitterDragLiveGrewPx = Math.round(midGiftBox.height - giftBox0.height);
    out.splitterDragLiveExpandsPane = !!byTestId("db-gift-area");
    out.splitterDragLiveGrew = midGiftBox.height > giftBox0.height + 80;
    // 拖动中**一帧都不写 store**：磁盘上还是进来时那一份
    out.splitterDragLiveWithoutStore = window.__prefs["ui.gift_pane_ratio"] === ratioAtEntry;
    firePointer(window, "pointerup", splitX, splitterMid() - 100, "mouse");
    await sleep(450);
    var draggedRatio = shownRatio();
    out.splitterDraggedRatioShown = draggedRatio;
    out.splitterDragPersistsRatio = !!draggedRatio &&
      Math.abs(window.__prefs["ui.gift_pane_ratio"] - draggedRatio) < 0.02;
    // 「涨了」要比**当时屏幕上的那一份**：折叠态下这一栏只有折叠头那么高（份额约 0.04），
    // 而 ratioAtEntry 是「上次拖到哪儿」的意图、折叠时并没有落到屏幕上（0.35 那个数在
    // 折叠态下看不见），拿它当基准会把「确实长大了」判成没长。
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
        giftBodyBefore: !!byTestId("db-gift-area"),
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
      remountProbe.giftBodyAfterOther = !!byTestId("db-gift-area");
      tabByRoomId(remountRoomId).click();
      await sleep(900);
      remountProbe.activeAfterBack = (function () {
        var t = allByTestId("db-room-tab").filter(function (x) {
          return x.getAttribute("data-active") === "true";
        })[0];
        return t ? t.getAttribute("data-room-id") : null;
      })();
      remountProbe.giftBodyAfterBack = !!byTestId("db-gift-area");
      remountProbe.giftHeightAfterBack = byTestId("db-pane-gift")
        ? Math.round(rect(byTestId("db-pane-gift")).height * 10) / 10 : null;
      remountProbe.ratioPrefAfterBack = window.__prefs["ui.gift_pane_ratio"];
      out.splitterRemountProbe = remountProbe;
    }
    // 切房那一趟做得出来才算数（标签条上至少要有两枚、且能认出当前那一枚）；
    // 做不出就是夹具的事，明着写出来，不把它悄悄放过 —— 与 tabs 那一段的 tabsRendered 同一条口径。
    out.splitterRemountAvailable = remountAvailable;
    out.splitterCollapsedAfterRemount = remountAvailable && !byTestId("db-gift-area") &&
      Math.abs(rect(byTestId("db-pane-gift")).height - headBox0.height) <= 1;
    byTestId("db-gift-dock").click();
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
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, panesBox1.top - 300);
    firePointer(window, "pointerup", splitX, panesBox1.top - 300);
    await sleep(450);
    var upDanmaku = rect(byTestId("db-pane-danmaku"));
    var upGift = rect(byTestId("db-pane-gift"));
    var upSplit = rect(byTestId("db-pane-splitter"));
    out.splitterMinRowHeightPx = Math.round(minRow * 10) / 10;
    out.splitterExtremeUpKeepsThreeRows = upDanmaku.height >= 3 * minRow - 8;
    out.splitterExtremeUpNoOverflow =
      Math.abs(upGift.height + upSplit.height + upDanmaku.height - panesBox1.height) <= 1;
    out.splitterExtremeUpClampedRatio = window.__prefs["ui.gift_pane_ratio"] === 0.9;

    // ---- 拖到极限（向下）：礼物栏不小于它的折叠头 ----
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, panesBox1.bottom + 300);
    firePointer(window, "pointerup", splitX, panesBox1.bottom + 300);
    await sleep(450);
    var downGift = rect(byTestId("db-pane-gift"));
    var downHead = rect(byTestId("db-gift-dock"));
    out.splitterExtremeDownKeepsHead = downGift.height >= downHead.height - 1 && downHead.height > 0;
    out.splitterExtremeDownClampedRatio = window.__prefs["ui.gift_pane_ratio"] === 0.1;

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
    out.swapByLongPress = window.__prefs["ui.gift_pane_on_top"] === true &&
      afterSwapGift.bottom <= afterSwapSplit.top + 1 &&
      afterSwapSplit.bottom <= afterSwapDanmaku.top + 1;
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
    var dockBoxBeforeNextTap = rect(byTestId("db-gift-dock"));
    // 「折叠头开合」的量法 = 这一栏自己那两枚钩子：列表根 db-gift-area（**展开才在场上**，
    // 见 docs/ui.md §5.3）与折叠头的 aria-expanded。**不能**拿 db-gift-body 当折叠状态：
    // 那是**行内**的正文格（MessageRow 的 t("body")，同 §5.3 的钩子表），只有「本来就有礼物行」
    // 时才存在；本段跑在送礼那几段之后、当前房间里礼物列表已空，开合两态都取不到它 ——
    // 断言于是恒为 false（本轮首次真跑就是这么红的：swapDoesNotEatNextTap=false，
    // 与「那一下 click 有没有被吞」无关）。
    var giftFoldBeforeNextTap = [
      !!byTestId("db-gift-area"),
      byTestId("db-gift-dock").getAttribute("aria-expanded"),
    ];
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
    firePointer(byTestId("db-gift-dock"), "pointerdown",
      dockBoxBeforeNextTap.left + dockBoxBeforeNextTap.width / 2,
      dockBoxBeforeNextTap.top + dockBoxBeforeNextTap.height / 2);
    firePointer(byTestId("db-gift-dock"), "pointerup",
      dockBoxBeforeNextTap.left + dockBoxBeforeNextTap.width / 2,
      dockBoxBeforeNextTap.top + dockBoxBeforeNextTap.height / 2);
    byTestId("db-gift-dock").click();
    await sleep(400);
    out.swapDoesNotEatNextTap = (!!byTestId("db-gift-area") !== giftFoldBeforeNextTap[0]) &&
      (byTestId("db-gift-dock").getAttribute("aria-expanded") !== giftFoldBeforeNextTap[1]);
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

    // ---- 收尾：礼物栏开回来，并把两枚键恢复默认（份额 0.35、礼物在下）----
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
      (panesBoxEnd.height - splitBoxEnd.height) * (1 - 0.35);
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, targetY);
    firePointer(window, "pointerup", splitX, targetY);
    await sleep(450);
    out.splitterRestoredRatio = Math.abs(window.__prefs["ui.gift_pane_ratio"] - 0.35) < 0.02;
    out.splitterRestoredOrder = window.__prefs["ui.gift_pane_on_top"] === false;
    out.splitterRestoredShownRatio = Math.abs(shownRatio() - 0.35) < 0.02;
    snap();

