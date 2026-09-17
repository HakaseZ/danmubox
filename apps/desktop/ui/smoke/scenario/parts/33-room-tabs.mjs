// 场景块：房间标签条：名字、圆点、拖动排序、横向滚动
//   #18 标签条显示主播名、不显示房间号；两处状态圆点同一判据同一色
//   tabs 标签条本身：拖动排序（5px 阈值、拖完不切房间、阈值以下仍是点击）、触摸下横滑是滚动而按住才是拖
//   拖动中被拖的房间被关掉则整次作废；开 20 个房间后横向滚动且每枚标签不被压缩
//   标签条不画滚动条但仍能横滚（溢出段为 0 + scrollbar-width: none + 归零再滚仍能变）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- #18 房间标签条：显示主播名，不显示房间号。
    // 标签条只在**多于一个**房间时渲染（App 既有语义）。第二个房间在**多标签隔离**那一段
    // （房间页里）就已经登记进替身了，这里只需走一次真实路径把它带回界面：
    // 点房间卡 → openRoom → connect 会重拉 rooms_list —— 这一轮之后 store 里就有两个房间。
    // （__addSecondRoom 是幂等的，重复调用不会多出一条。）
    // 主页**不挂**弹幕页的标签条（用户 2026-09-12：与主页的「已连接房间」卡片列表重复）。
    // 这里正是「有两个房间」的状态 —— 旧实现下标签条就是在这个条件下冒出来的。
    out.listPageNoRoomTabs = !byTestId("db-room-tabs") && allByTestId("db-room-tab").length === 0;
    byTestId("db-room-card").click();
    await sleep(800);
    var tabs = allByTestId("db-room-tab");
    out.roomTabsInsideRoom = !!byTestId("db-room-tabs");
    out.tabsRendered = tabs.length === 2;
    // 有名字的那个标签：报的是**真实载荷**里的主播名，且不露房间号。
    var namedTab = tabs.filter(function (t) {
      return t.innerText.indexOf(fixtureRoom.anchor_uname) >= 0;
    })[0];
    out.tabShowsAnchorNames = !!namedTab && tabs.length === 2;
    out.tabHidesRoomNumbers = !!namedTab && namedTab.innerText.indexOf("5440") < 0;
    // 没有名字的那个标签（上游名与标题都缺）：只能报房间号——但**不许**报「未命名直播间」，
    // 那个词既不说明是哪个房间，又像真名字（用户 2026-09-12 报的就是它）。
    out.tabFallbackShowsRoomNumber = tabs.length === 2 &&
      tabs.some(function (t) { return t.innerText.indexOf("房间 5555") >= 0; }) &&
      tabs.every(function (t) { return t.innerText.indexOf("未命名直播间") < 0; });
    // ---- 两处圆点**同一状态同色**（用户 2026-09-13：「橙色的需求改成灰色，但是下面的标题栏
    //      左边还是之前的样子」+ 追加「标题旁的断连确实没变化（只有红绿）」）。房间头那颗与
    //      标签页那颗现在是**同一个判据（liveKindOf）、同一组令牌（--live-*）、同一条 .liveDot 规则**，
    //      这条断言把它钉死：三态各走一遍，量每一处的**计算色**与 data-state。
    //      两个房间发同一组事件（含载荷里的 connected ——「连没连上」是两路信号取与），
    //      所以「哪个标签是当前激活的那个」不影响结论。
    var tabDotEls = function () { return allByTestId("db-tab-dot"); };
    var headerDotNow = function () {
      var dot = byTestId("db-live-dot");
      return dot ? getComputedStyle(dot).backgroundColor : null;
    };
    var headerStateNow = function () {
      var box = byTestId("db-live-dot-box");
      return box ? box.getAttribute("data-state") : null;
    };
    var tabColorsNow = function () {
      return tabDotEls().map(function (el) { return getComputedStyle(el).backgroundColor; });
    };
    var pairAt = async function (conn, liveStatus) {
      [fixtureRoom.room_id, 5555].forEach(function (id) {
        window.__emit("danmubox://status", { room_id: id, state: conn, detail: "" });
        window.__emit("danmubox://room", {
          room_id: id, live_status: liveStatus, connected: conn === "connected",
        });
      });
      await sleep(350);
      return {
        header: headerDotNow(),
        headerState: headerStateNow(),
        tabs: tabColorsNow(),
        tabStates: tabDotEls().map(function (el) { return el.getAttribute("data-state"); }),
      };
    };
    var dotPairs = [
      { kind: "on", want: cssColorOf("--live-on"), at: await pairAt("connected", 1) },
      { kind: "off", want: cssColorOf("--live-off"), at: await pairAt("connected", 0) },
      { kind: "idle", want: cssColorOf("--live-idle"),
        at: await pairAt("disconnected", fixtureRoom.live_status) },
    ];
    out.liveDotPairColors = dotPairs.map(function (p) {
      return { kind: p.kind, want: p.want, header: p.at.header, tabs: p.at.tabs };
    });
    out.liveDotTwoSitesSameColor = dotPairs.every(function (p) {
      return p.at.tabs.length === 2 && p.at.header === p.want &&
        p.at.tabs.every(function (c) { return c === p.want; });
    });
    out.liveDotTwoSitesSameState = dotPairs.every(function (p) {
      return p.at.headerState === p.kind && p.at.tabStates.length === 2 &&
        p.at.tabStates.every(function (s) { return s === p.kind; });
    });
    // 尺寸**维持现状**：标签页那颗点换的只是配色来源（旧 .dot 的 --sp-2 → 现在这条 .liveDot
    // 的 --live-dot），看得见的那颗点仍是 8px、外壳（热区 / 悬停面）仍是 12px。
    var firstTabDot = tabDotEls()[0];
    out.tabDotSizePx = firstTabDot ? Math.round(rect(firstTabDot).width * 10) / 10 : null;
    out.tabDotSizeUnchanged = !!firstTabDot &&
      Math.abs(rect(firstTabDot).width - cssLengthOf("--live-dot")) < 0.6 &&
      Math.abs(rect(firstTabDot).width - 8) < 0.6;
    // ---- issue #1（本批追加第 6 条）：标签条**拖动排序 + 横向滚动**（docs/ui.md §2.3）。
    //      用**真实指针事件**驱动（pointerdown → 越过阈值的 pointermove → pointerup），
    //      判的全是对外可观察的东西：DOM 顺序、data-active / data-dragging、房间头标题、
    //      rooms_connect 调用次数、计算样式、scrollWidth / clientWidth。
    //      边界逐条落到断言上：阈值以下的位移仍是点击、触摸横滑是滚动而按住才是拖、
    //      拖动中被拖的房间被关掉则整次作废、只有一个房间时根本没有标签条（另见 step2）。
    // 整块包一层（同上面几段的手法）：出岔子时让断言红（tabDragBlockRan），不把场景卡到超时。
    var tabDragBlockRan = false;
    try {
      var stripEl = byTestId("db-room-tabs");
      // 这一段接在别的切片后面跑：标签条得**真的在画面上**（别的切片可能把房间页留在
      // 沉浸模式 / 列表页里）—— 那样的话这里整段作废，但要说清原因，不能给一堆假几何。
      if (!stripEl || getComputedStyle(stripEl).display === "none" || rect(stripEl).width < 1) {
        throw new Error("标签条不可见（房间页没停在可见状态：沉浸模式没退出？）");
      }
      var pe = function (type, target, x, y, pointerType) {
        var init = {
          bubbles: true, cancelable: true, pointerId: 7, isPrimary: true,
          pointerType: pointerType || "mouse", clientX: x, clientY: y,
        };
        if (type === "pointerdown") { init.button = 0; init.buttons = 1; }
        if (type === "pointerup") { init.button = 0; init.buttons = 0; }
        target.dispatchEvent(new PointerEvent(type, init));
      };
      var tabNames = function () {
        return allByTestId("db-room-tab").map(function (t) { return t.innerText.trim(); });
      };
      var roomIds = function () {
        return allByTestId("db-room-tab").map(function (t) { return t.getAttribute("data-room-id"); });
      };
      /** 当前激活那一枚的房间号（标签上只有一个 data-active=true，取不到就是 null）。 */
      var activeRoomId = function () {
        var on = allByTestId("db-room-tab").filter(function (t) {
          return t.getAttribute("data-active") === "true";
        });
        return on.length === 1 ? on[0].getAttribute("data-room-id") : null;
      };
      var connectCalls = function () {
        return callsWithArgs.filter(function (c) { return c.cmd === "rooms_connect"; }).length;
      };
      var lastConnectRoom = function () {
        var all = callsWithArgs.filter(function (c) { return c.cmd === "rooms_connect"; });
        return all.length > 0 ? all[all.length - 1].args.roomId : null;
      };
      /** 点房间头 ⋯ 菜单里的某一项（菜单按文案找，与用户在菜单里点同一条路）。 */
      var menuPick = async function (label) {
        byTestId("db-header-more").click();
        await sleep(250);
        var item = buttonWith(byTestId("db-context-menu"), label);
        if (item) item.click();
        await sleep(1000);
        return !!item;
      };
      /**
       * 按住第 index 枚标签拖到 x，返回**拖拽中途**量到的那几个数（拖拽态 / 被拖项 /
       * 插入指示条 / 容器计算样式）。
       * holdMs 有值 = 触摸那条路：先按住这么久再动（触摸的横滑归容器滚动）。
       */
      var dragTab = async function (index, toX, pointerType, holdMs) {
        var tab = allByTestId("db-room-tab")[index];
        var box = rect(tab);
        var y = box.top + box.height / 2;
        pe("pointerdown", tab, box.left + 10, y, pointerType);
        if (holdMs) await sleep(holdMs);
        else {
          pe("pointermove", window, box.left + 50, y, pointerType);
          await sleep(90);
        }
        var mid = {
          dragging: stripEl.getAttribute("data-dragging"),
          dragged: allByTestId("db-room-tab").filter(function (t) {
            return t.getAttribute("data-dragging") === "true";
          }).length,
          markers: allByTestId("db-tab-drop").length,
          touchAction: getComputedStyle(stripEl).touchAction,
          overscroll: getComputedStyle(stripEl).overscrollBehaviorX,
        };
        pe("pointermove", window, toX, y, pointerType);
        await sleep(90);
        pe("pointerup", window, toX, y, pointerType);
        await sleep(150);
        return mid;
      };
      var farRight = function () {
        var tabs = allByTestId("db-room-tab");
        return rect(tabs[tabs.length - 1]).right + 40;
      };

      var restTouchAction = getComputedStyle(stripEl).touchAction;
      var orderBefore = roomIds();
      var activeBefore = activeRoomId();
      var headerBefore = byTestId("db-room-title").getAttribute("title");
      var connectsBefore = connectCalls();

      // ---- ① 拖动排序：把**当前激活的那一枚**（第 0 枚）拖到最右
      var dragMid = await dragTab(0, farRight());
      // 拖拽中的视觉反馈：被拖项自己半透明（data-dragging）、目标位有一枚插入指示条
      out.tabDragStateShown = dragMid.dragging === "true" && dragMid.dragged === 1 &&
        dragMid.markers === 1;
      // 拖拽态下容器不再滚（touch-action 收到自己手里、越界链就地截断）；
      // 静止时是 pan-x：触摸的横滑 = 滚标签条
      out.tabDragSuppressesScroll = dragMid.touchAction === "none" &&
        dragMid.overscroll === "contain" && restTouchAction === "pan-x";
      // 「第 0 枚挪到末尾」= 整体左移一位（与前面几段留下的顺序无关，任何长度都成立）
      var orderAfterDrag = roomIds();
      out.tabDragReorders = orderBefore.length >= 2 &&
        orderAfterDrag.length === orderBefore.length &&
        orderAfterDrag.every(function (id, index) {
          return id === orderBefore[(index + 1) % orderBefore.length];
        }) && orderAfterDrag.join("|") !== orderBefore.join("|");
      // 拖动**只改顺序**：激活项没换（还是同一枚房间号）、房间头报的还是同一个房间、
      // 一次 rooms_connect 都没发（没顺手切房间）
      out.tabDragKeepsActive = !!activeBefore && activeRoomId() === activeBefore &&
        byTestId("db-room-title").getAttribute("title") === headerBefore &&
        connectCalls() === connectsBefore;
      // 拖完指示条收掉（不留一根挂在那儿的竖条）
      out.tabDragClearedAfterDrop = stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0;

      // ---- ② 拖完之后重拉一次 rooms_list（⋯ → 刷新连接）：**顺序必须留住**
      //      （本票的口径是「会话内有效」，而切房间本身就会重拉一次 rooms_list）
      await menuPick("刷新连接");
      out.tabOrderKeepsAcrossReload = roomIds().join("|") === orderAfterDrag.join("|");

      // ---- ③ 反向拖回来：最后一枚拖到最前，顺序恢复原样
      var backMid = await dragTab(allByTestId("db-room-tab").length - 1,
        rect(allByTestId("db-room-tab")[0]).left - 20);
      out.tabDragBackRestores = backMid.markers === 1 &&
        roomIds().join("|") === orderBefore.join("|");

      // ---- ④ 阈值以下 = 点击：3px 的位移不进入拖拽态，松手后的那一下照旧切房间。
      //      目标挑**不是当前激活的那一枚**：切没切房间从 data-active 与 rooms_connect
      //      的参数上直接看得出来（与前面几段留下的状态无关）。
      var clickTarget = allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") !== activeBefore;
      })[0];
      var clickRoomId = clickTarget.getAttribute("data-room-id");
      var clickBox = rect(clickTarget);
      pe("pointerdown", clickTarget, clickBox.left + 10, clickBox.top + clickBox.height / 2);
      pe("pointermove", window, clickBox.left + 13, clickBox.top + clickBox.height / 2);
      await sleep(90);
      out.tabPressUnderThresholdNoDrag =
        stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0;
      pe("pointerup", window, clickBox.left + 13, clickBox.top + clickBox.height / 2);
      await sleep(60);
      // 同一枚元素上「按下并松开」之后浏览器自己会发的那一下 click
      clickTarget.click();
      await sleep(1000);
      out.tabClickStillSwitches = activeRoomId() === clickRoomId &&
        lastConnectRoom() === Number(clickRoomId);
      // 切回来（后面几段按「激活项仍是原来那一枚」继续）
      allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === activeBefore;
      })[0].click();
      await sleep(1000);
      out.tabClickSwitchesBackOnMouse = activeRoomId() === activeBefore &&
        lastConnectRoom() === Number(activeBefore);

      // ---- ⑤ 触摸：横滑 = 滚标签条（不排序）；**按住**再动才是拖动排序
      var orderBeforeTouch = roomIds();
      var swipeMid = await dragTab(0, farRight(), "touch");
      out.tabTouchSwipeNotDrag = swipeMid.dragging === "false" && swipeMid.markers === 0 &&
        roomIds().join("|") === orderBeforeTouch.join("|");
      var holdMid = await dragTab(0, farRight(), "touch", 500);
      out.tabTouchHoldDrags = holdMid.dragging === "true" && holdMid.markers === 1;
      // 按住之后的那一次是**真的拖动了**（同样左移一位）
      var orderAfterHold = roomIds();
      out.tabTouchHoldReorders = orderAfterHold.join("|") !== orderBeforeTouch.join("|") &&
        orderAfterHold.every(function (id, index) {
          return id === orderBeforeTouch[(index + 1) % orderBeforeTouch.length];
        });

      // ---- ⑤b 触摸下「手势归谁」的对外可观察面：拿起来之后，容器上的 touchmove 必须被
      //      preventDefault（滚动收走），没拿起来时**不许**拦（横划是「看更多标签」的正路）。
      //      这两条是本次修复的回归闸：旧实现只靠 CSS 的 touch-action + pointermove
      //      上的 preventDefault，两个都拦不住滚动 —— 浏览器在 **touchstart 那一刻**就把
      //      touch-action 快照给手势识别器了。真机实测（Android WebView Chrome/124，
      //      CDP 注入真实触摸）：按住 400ms 拿起来后的**第一次** pointermove 就收到
      //      pointercancel，排序一次都没成过；而合成 PointerEvent 绕开了浏览器的手势管线，
      //      所以旧的真机故障在冒烟里一直照不出来 —— 这条断言量的是那条管线上的约定。
      var touchMoveProbe = function (target) {
        try {
          var ev = new TouchEvent("touchmove", { bubbles: true, cancelable: true });
          target.dispatchEvent(ev);
          return ev.defaultPrevented;
        } catch (e) {
          return "throw:" + e.message;
        }
      };
      var stripFirstTab = allByTestId("db-room-tab")[0];
      var stripFirstBox = rect(stripFirstTab);
      var stripFirstY = stripFirstBox.top + stripFirstBox.height / 2;
      out.tabTouchMoveFreeWhenIdle = touchMoveProbe(stripFirstTab) === false;
      pe("pointerdown", stripFirstTab, stripFirstBox.left + 10, stripFirstY, "touch");
      await sleep(500); // > TAB_HOLD_MS：已经拿起来了（拖拽态在画面上）
      out.tabTouchLiftedForProbe = stripEl.getAttribute("data-dragging") === "true";
      out.tabTouchMoveOwnedWhenLifted = touchMoveProbe(stripFirstTab) === true;
      pe("pointerup", stripFirstTab, stripFirstBox.left + 10, stripFirstY, "touch");
      await sleep(250);

      // ---- ⑤c 触摸**原地长按再松手**（慢点）= 仍然是点击：那一下 click 不许吞。
      //      旧实现只要越过 TAB_HOLD_MS 就举「吞 click」的旗，于是慢点一次都切不了房间
      //      （实测真机：click 事件照发，data-active 一动不动 —— 用户说「点了没反应」）。
      var slowTarget = allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") !== activeRoomId();
      })[0];
      var slowRoomId = slowTarget.getAttribute("data-room-id");
      var slowBox = rect(slowTarget);
      var slowY = slowBox.top + slowBox.height / 2;
      var connectsBeforeSlowTap = connectCalls();
      pe("pointerdown", slowTarget, slowBox.left + 12, slowY, "touch");
      await sleep(500);
      out.tabSlowTouchTapLifted = stripEl.getAttribute("data-dragging") === "true";
      pe("pointerup", slowTarget, slowBox.left + 12, slowY, "touch");
      await sleep(80);
      // 按下与松开落在同一枚上时，浏览器自己会补的那一下 click
      slowTarget.click();
      await sleep(900);
      out.tabSlowTouchTapSwitches = activeRoomId() === slowRoomId &&
        lastConnectRoom() === Number(slowRoomId) &&
        connectCalls() > connectsBeforeSlowTap;
      // 切回来：后面几段按「激活项还是原来那一枚」继续
      var backToActiveTab = allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === activeBefore;
      })[0];
      backToActiveTab.click();
      await sleep(1000);
      out.tabSlowTouchTapSwitchesBack = activeRoomId() === activeBefore;

      // ---- ⑤d 触摸**真的拖动过**之后：松手补发的那一下 click 必须吞掉（拖的是顺序，不是切房间）。
      //      这一段在同一栏里挪 90px（落点还是自己那一枚 = 顺序不动），随后手动补一发 click：
      //      它被吞掉的表现就是「一次 rooms_connect 都没发、激活项没变」。
      var dragAwayTab = allByTestId("db-room-tab")[0];
      var dragAwayBox = rect(dragAwayTab);
      var dragAwayY = dragAwayBox.top + dragAwayBox.height / 2;
      var connectsBeforeTouchDrag = connectCalls();
      var activeBeforeTouchDrag = activeRoomId();
      pe("pointerdown", dragAwayTab, dragAwayBox.left + 10, dragAwayY, "touch");
      await sleep(500);
      pe("pointermove", window, dragAwayBox.left + 100, dragAwayY, "touch");
      await sleep(90);
      pe("pointerup", dragAwayTab, dragAwayBox.left + 100, dragAwayY, "touch");
      await sleep(80);
      dragAwayTab.click();
      await sleep(700);
      out.tabTouchDragSwallowsFollowUpClick =
        connectCalls() === connectsBeforeTouchDrag && activeRoomId() === activeBeforeTouchDrag;

      // ---- ⑤e 阈值边界：**没到** TAB_DRAG_THRESHOLD_PX（5px）不算拖（4px 不行、6px 行）。
      //      上一条只量了 3px 那一侧（tabPressUnderThresholdNoDrag），这里把另一侧也钉住，
      //      阈值本身就成了对外可观察的行为而不是一个常量。
      var edgeTab = allByTestId("db-room-tab")[0];
      var edgeBox = rect(edgeTab);
      var edgeY = edgeBox.top + edgeBox.height / 2;
      pe("pointerdown", edgeTab, edgeBox.left + 10, edgeY, "mouse");
      pe("pointermove", window, edgeBox.left + 14, edgeY, "mouse");
      await sleep(90);
      out.tabBelowThresholdNoDrag = stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0;
      pe("pointermove", window, edgeBox.left + 16, edgeY, "mouse");
      await sleep(90);
      out.tabAboveThresholdDrags = stripEl.getAttribute("data-dragging") === "true";
      pe("pointerup", window, edgeBox.left + 16, edgeY, "mouse");
      await sleep(250);
      // 这一拖是**真的拖过**（越过阈值、也 move 过）：它举起了「吞下一发 click」的旗。
      // 点**当前这一枚**把它消费掉（原地重开一次、不换房间、顺序也不动），
      // 免得后面几段里第一次点标签被它吃掉（④ 那段同样的道理）。
      allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === activeRoomId();
      })[0].click();
      await sleep(250);

      // ---- ⑥ 开 20 个房间：标签条**横向滚动**，每枚标签**不被压缩**（各保自己的最小宽度）
      window.__addRooms(20);
      await menuPick("刷新连接");
      var tabsNow = allByTestId("db-room-tab");
      var widths = tabsNow.map(function (t) { return rect(t).width; });
      var minTabW = cssLengthOf("--tab-min-w");
      out.tabMinWidthPx = Math.round(minTabW * 10) / 10;
      out.tabStripScrolls = tabsNow.length >= 20 &&
        getComputedStyle(stripEl).overflowX === "auto" && minTabW > 0 &&
        stripEl.scrollWidth > stripEl.clientWidth + 1;
      out.tabWidthsNotSqueezed = widths.length === tabsNow.length && minTabW > 0 &&
        Math.min.apply(null, widths) >= minTabW - 0.6;
      // 「没挤在一起」的另一半：它们是真的溢出去了，而不是被压回容器宽度里
      out.tabWidthsSumOverflowsStrip =
        widths.reduce(function (sum, w) { return sum + w; }, 0) > stripEl.clientWidth;
      // 滚到末尾：最后一枚完整可见（开再多也拿得到）
      stripEl.scrollLeft = stripEl.scrollWidth;
      await sleep(250);
      var lastTabNow = allByTestId("db-room-tab").slice(-1)[0];
      out.tabStripScrollsToEnd = stripEl.scrollLeft > 0 &&
        rect(lastTabNow).right <= rect(stripEl).right + 1 &&
        rect(lastTabNow).left >= rect(stripEl).left - 1;

      // ---- ⑥b 标签条**不画滚动条**（用户 2026-09-16 第 1 条：「顶部 tab 滚动的时候不要有滑块，
      //      会挡住，能隐藏掉吗」），但横向照旧能滚。
      //      判「滚动条有没有占位」不能用 clientHeight === offsetHeight：这个容器的高度是**由标签
      //      撑开**的（没有固定高度 + 只横向滚），占位式滚动条会把容器一并撑高，两者的差始终只剩
      //      那 1px 底边框。真正的判据是「标签底边 → 容器内底边」那一段：不画滚动条时恒为 0，
      //      画了占位式横向滚动条时正好是一条滚动条的厚度。
      var stripStyle = getComputedStyle(stripEl);
      var stripBorderBottom = parseFloat(stripStyle.borderBottomWidth) || 0;
      var tabsBottomEdge = Math.max.apply(null, allByTestId("db-room-tab").map(function (t) {
        return rect(t).bottom;
      }));
      out.tabStripScrollbarThicknessPx =
        Math.round((rect(stripEl).bottom - stripBorderBottom - tabsBottomEdge) * 10) / 10;
      out.tabStripNoScrollbarSpace = out.tabStripScrollbarThicknessPx <= 0.5 &&
        stripStyle.getPropertyValue("scrollbar-width").trim() === "none";
      // （scrollbar-width 取的是**引擎算出来的**值（走 getPropertyValue，不看 JS 侧有没有这个
      //   属性名）：覆盖式滚动条的引擎本来就不占位，只靠几何量不出「滑块还会不会飘到标签上」，
      //   这条是它唯一的可观察面。）
      stripEl.scrollLeft = 0;
      await sleep(150);
      out.tabStripScrollsWithHiddenScrollbar = stripEl.scrollLeft === 0 &&
        (function () {
          stripEl.scrollLeft = Math.round((stripEl.scrollWidth - stripEl.clientWidth) / 2);
          return stripEl.scrollLeft > 0;
        })();
      stripEl.scrollLeft = 0;
      await sleep(150);

      // ---- ⑦ 拖动中被拖的那个房间被**关掉**（上游快照不再包含它）：整次拖动作废 ——
      //      指示条收掉、顺序不动，松手也不落位。
      stripEl.scrollLeft = 0;
      await sleep(250);
      var orderBeforeKill = tabNames();
      var victimName = "房间 6004";
      var victimIndex = orderBeforeKill.indexOf(victimName);
      var victim = allByTestId("db-room-tab")[victimIndex];
      if (!victim) throw new Error("找不到被关掉的样本标签 " + victimName + "（__addRooms 没生效？）");
      var victimBox = rect(victim);
      pe("pointerdown", victim, victimBox.left + 10, victimBox.top + victimBox.height / 2);
      pe("pointermove", window, victimBox.left + 60, victimBox.top + victimBox.height / 2);
      await sleep(150);
      out.tabKillDragLifted = victimIndex >= 0 &&
        stripEl.getAttribute("data-dragging") === "true";
      window.__dropRoom(6004);
      await menuPick("刷新连接");
      out.tabDragAbortsWhenRoomClosed = victimIndex >= 0 &&
        stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0 &&
        tabNames().indexOf(victimName) < 0 &&
        tabNames().join("|") === orderBeforeKill.filter(function (n) {
          return n !== victimName;
        }).join("|");
      pe("pointerup", window, victimBox.left + 60, victimBox.top + victimBox.height / 2);
      await sleep(200);
      out.tabDragAbortKeepsOrder = tabNames().join("|") === orderBeforeKill.filter(function (n) {
        return n !== victimName;
      }).join("|");

      // 收尾仍停在**未连接（灰）**那一档（同上一条尾注）：这一段点过标签、刷过连接，
      // 连接态会被替身推成 connected，这里显式复位，最后那张截图仍然看得到灰点。
      // （当前激活那个房间号从 data-active 上取 —— 不假设是哪一间。）
      [Number(activeRoomId()), fixtureRoom.room_id, 5555].forEach(function (id) {
        if (!id) return;
        window.__emit("danmubox://status", { room_id: id, state: "disconnected", detail: "" });
        window.__emit("danmubox://room", {
          room_id: id, live_status: fixtureRoom.live_status, connected: false,
        });
      });
      await sleep(300);
      snap();
      tabDragBlockRan = true;
    } catch (e) {
      out.tabDragBlockError = String((e && e.stack) || e);
    }
    out.tabDragBlockRan = tabDragBlockRan;

    // 收尾就停在**未连接（灰）**那一档：最后那张截图因此看得到灰点（两处都是灰的）。
    snap();

