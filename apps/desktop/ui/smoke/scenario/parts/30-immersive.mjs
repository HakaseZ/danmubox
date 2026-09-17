// 场景块：沉浸模式
//   弹幕区双击收起标题栏 / 标签条 / 输入区，只留弹幕区与礼物栏（退出条件、阅读位置、选中不丢、几何等式）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 沉浸模式（issue #1）：弹幕区**双击**收起标题栏与输入区，只留弹幕区与礼物 / SC 栏，
    //      再双击恢复。判据是**指针事件**（鼠标双击与触屏点两下走同一条路，见 RoomView 顶部
    //      的 TAP_MS）：两次「按下 → 抬起」都在 400ms 内、落点相距不超过 24px，且不落在
    //      可交互元素上。这一段与 docs/ui.md 2.3.1 的「收起 / 保留」清单一一对应。
    // 整块包一层（同上面几段的手法）：出岔子时让断言红（immersiveBlockRan），不卡死整个场景。
    //
    // ⚠ **沉浸态是唯一一个「块内出错会连带打死块外」的状态**：沉浸态里房间头 / 输入区都是
    //   条件渲染（RoomView 的 {!immersive && …}），它们整个不在 DOM 里；块外的段落照旧
    //   裸取 byTestId("db-header-more").click()（那是「进房间点 ⋯ 看菜单」的常规动作），
    //   拿到 null 就是一个**未捕获的 TypeError** —— 场景当场死掉，跑脚本的那一头只能看到
    //   「视口 wide 的场景未跑完（超时）」，root cause 全被 300s 的超时盖住（实测两引擎都栽在这）。
    //   所以这里的 finally 是**必需**的：无论块内走到哪一步、抛了什么，先把沉浸态退出来，
    //   让块外的世界回到它假设的样子；退出结果另记一条布尔（immersiveRestoredAfterBlock）。
    var immersiveOff = async function () {
      var root = document.documentElement;
      if (root.getAttribute("data-immersive") !== "true") return true;
      var el = document.querySelector('[data-testid="db-chat-wrap"]') ||
        document.querySelector('[data-testid="db-chat-scroll"]');
      if (!el) return false;
      var box = el.getBoundingClientRect();
      var x = Math.round(box.left + box.width / 2);
      var y = Math.round(box.top + box.height / 2);
      var base = {
        bubbles: true, cancelable: true, composed: true, isPrimary: true,
        button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y,
      };
      // 两下「点」挨着发（判据看的是两次点的间隔 < 400ms，sleep 会被页面节流拉长，见块内说明）
      for (var i = 0; i < 2; i += 1) {
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { buttons: 1 })));
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
      }
      await sleep(320);
      return root.getAttribute("data-immersive") !== "true";
    };
    var immersiveBlockRan = false;
    try {
      var immTap = function (el, x, y, pointerType) {
        var base = {
          bubbles: true, cancelable: true, composed: true, isPrimary: true,
          button: 0, pointerId: 1, pointerType: pointerType, clientX: x, clientY: y,
        };
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { buttons: 1 })));
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
      };
      // 两下「点」**挨着发**（中间不 sleep）：判据量的是两次点的间隔，而 sleep 会被页面节流拉长
      // —— 实测在被节流的页面里 sleep(60) 落成 **473ms** 的间隔，直接超出 400ms 窗口。
      // 真实用户当然不会快到这个程度，这里要验的是**判据本身**，不是人手速；间隔为 0 必定在窗口内。
      var immDoubleTap = async function (el, x, y, pointerType) {
        immTap(el, x, y, pointerType);
        immTap(el, x, y, pointerType);
        await sleep(320);
      };
      // 「DOM 层面不可见」的两条路：条件渲染的那几块**不在 DOM 里**；标签条在 App 里
      // （房间页的兄弟节点），走 CSS 的 display: none —— 仍在 DOM 里，但 getClientRects()
      // 为空（既不占位、也不进 Tab 序）。
      var immUnrendered = function (el) { return el == null || el.getClientRects().length === 0; };
      var immAttr = function () { return document.documentElement.getAttribute("data-immersive"); };
      // 垫场：这一步之前刚跑完「A 间 → B 间 → A 间」，而切回 A 间看到的是**这一间房间
      // 重新回填的历史**（store 里 messages 只有一份、跟着当前房间走；每个房间自己的会话
      // 缓冲在 Rust 那一头，切回来是靠再 query 一次历史看到的 —— 见 store 的 openRoom），
      // 夹具那几条历史**撑不满一屏**：实测此刻 scrollHeight == clientHeight、scrollTop 恒 0，
      // 下面「沉浸态里照样能往上翻历史」就没有了可观察面（不是功能坏了 —— 单独跑一段垫过场的
      // 场景，进沉浸后滚到中段 scrollTop=765、离底 764px、「回到最新」如期出现且稳定）。
      // 做法与 tabs 那一段的「隔离垫场」逐字同源。
      for (var immPad = 0; immPad < 30; immPad += 1) {
        window.__emit("danmubox://message", window.__mk("danmaku", "沉浸垫场" + immPad, false, {
          uid: 88002, uname: "垫场观众"
        }));
      }
      await sleep(700);
      out.immersivePadRows = rows().length;
      var immChat0 = rect(byTestId("db-chat-scroll"));
      var immGift0 = rect(byTestId("db-gift-dock"));
      var immTabs0 = rect(byTestId("db-room-tabs"));
      var immHeader0 = rect(byTestId("db-room-header"));
      // 输入区整块的高度**直接量输入区这一块**（RoomView 的 shell 里它是被收起的三块之一）。
      // 旧写法拿「礼物栏顶边 − 弹幕区底边」推算，前提是「文档流里礼物栏与弹幕区紧挨着输入区的上下」
      // —— 那是**上下分区（issue #8）之前**的结构：礼物栏搬进共享分区之后，那一段量到的是
      // 弹幕区与礼物栏之间的**分割条**（实测 8.0px），输入区那块（100px 量级）根本不在这条缝里，
      // 等式必然差一大截。这里改用与文件里其它段落同源的办法（closest('[class*="composer"]')）。
      var immComposerEl = document.querySelector("textarea")
        ? document.querySelector("textarea").closest('[class*="composer"]')
        : null;
      var immComposerH = immComposerEl ? Math.round(rect(immComposerEl).height * 10) / 10 : 0;
      var immGiftHeadH = Math.round((immGift0 ? immGift0.height : 0) * 10) / 10;
      out.immersiveRemovedBlocksPx = [
        immTabs0 ? Math.round(immTabs0.height * 10) / 10 : null,
        immHeader0 ? Math.round(immHeader0.height * 10) / 10 : null,
        immComposerH,
      ];
      var immTextareas0 = document.querySelectorAll("textarea").length;
      var immTapX = Math.round(immChat0.left + immChat0.width / 2);
      var immTapY = Math.round(immChat0.top + immChat0.height / 2);
      // ① 单击**不**切（判据是双击）：标签条 / 房间头 / 属性三处都还是原样
      immTap(byTestId("db-chat-scroll"), immTapX, immTapY, "mouse");
      await sleep(500);
      out.immersiveSingleTapIgnored = immUnrendered(byTestId("db-room-tabs")) === false &&
        byTestId("db-room-header") !== null && immAttr() === null;
      // ② 双击弹幕区 → 进沉浸模式（鼠标指针）
      await immDoubleTap(byTestId("db-chat-scroll"), immTapX, immTapY, "mouse");
      var immChat1 = rect(byTestId("db-chat-scroll"));
      var immGift1 = rect(byTestId("db-gift-dock"));
      out.immersiveEnterOnChatDoubleTap = immAttr() === "true";
      out.immersiveHidesHeader = immHeader0 !== null &&
        byTestId("db-room-header") === null && byTestId("db-live-dot-box") === null;
      out.immersiveHidesComposer = immTextareas0 === 1 &&
        byTestId("db-composer-tools") === null && byTestId("db-input-count") === null &&
        document.querySelector("textarea") === null;
      out.immersiveHidesTabs = immTabs0 !== null && byTestId("db-room-tabs") !== null &&
        immUnrendered(byTestId("db-room-tabs")) &&
        getComputedStyle(byTestId("db-room-tabs")).display === "none";
      out.immersiveChatGrewPx = Math.round((immChat1.height - immChat0.height) * 10) / 10;
      // 弹幕区长高的**正好**是被收起来的那三块之和（标签条 + 房间头 + 输入区）：
      // 既证明「收起」，也证明这几块腾出来的高度全归弹幕区，没有别的块被挤错。
      out.immersiveChatGrewByRemovedBlocks = immTabs0 !== null && immHeader0 !== null &&
        immComposerH > 0 && Math.abs(out.immersiveChatGrewPx -
          (immTabs0.height + immHeader0.height + immComposerH)) < 1.5;
      // 礼物 / SC 栏留在场上、高度一点没变；它与弹幕区之间**只隔着那条分割条**
      // （弹幕区拿走收起腾出的全部高度，没有别的块被挤错）。旧写法要求「弹幕区底边紧贴礼物栏顶边」，
      // 同样是上下分区之前的结构 —— 折叠态下礼物栏在弹幕区正下方，中间那一条 8px 就是分割条
      // （实测 8.0），所以相邻性改成「弹幕区底边 = 分割条顶边、礼物栏顶边 = 分割条底边」。
      var immSplit1 = rect(byTestId("db-pane-splitter"));
      out.immersiveGiftHeightDeltaPx = immGift0 && immGift1
        ? Math.round((immGift1.height - immGift0.height) * 10) / 10 : null;
      out.immersiveKeepsGiftDock = byTestId("db-gift-dock") !== null && !!immGift0 &&
        !!immGift1 && !!immSplit1 &&
        // 折叠态（此刻它就是折叠的）在沉浸态里照旧折叠：高度仍然是折叠头那一个数
        !byTestId("db-gift-area") &&
        Math.abs(immGift1.height - immGift0.height) < 1 &&
        Math.abs(immGift1.height - immGiftHeadH) < 1 &&
        Math.abs(rect(byTestId("db-chat-scroll")).bottom - immSplit1.top) < 1 &&
        Math.abs(immGift1.top - immSplit1.bottom) < 1;
      snap();
      // ③ 沉浸态里照样能往上翻历史、「回到最新」跟着出现、点了又贴底（虚拟列表重新量高）
      var immScroll = byTestId("db-chat-scroll");
      immScroll.scrollTop = Math.round((immScroll.scrollHeight - immScroll.clientHeight) * 0.5);
      // 采样而不是只量一次：虚拟列表在沉浸态里会重新量高、MessageList 的 ResizeObserver
      // 又会在「跟随中」时重新贴底 —— 「滚上去之后按钮没出现」到底是没滚成（scrollTop 为 0）、
      // 还是滚了又被弹回底，采样数组一眼分得出来。
      var immSamples = [];
      for (var immStep = 0; immStep < 5; immStep += 1) {
        await sleep(immStep === 0 ? 80 : 150);
        var immNow = byTestId("db-chat-scroll");
        immSamples.push({
          top: immNow ? Math.round(immNow.scrollTop) : null,
          gap: immNow ? bottomGap(immNow) : null,
          anchor: !!byTestId("db-bottom-anchor"),
        });
      }
      out.immersiveScrollSamples = immSamples;
      out.immersiveScrollsWhenImmersive = immScroll.scrollTop > 0 &&
        bottomGap(immScroll) > 8 && byTestId("db-bottom-anchor") !== null;
      // 按钮不在就**不点**：这一步以前是裸取 .click()，沉浸块内一旦走到这里就抛 TypeError，
      // 被 catch 吞掉之后沉浸态留在场上，块外的裸取（房间头那枚 ⋯）拿到 null → 未捕获异常 →
      // 整个场景死掉（实测两引擎都栽在这，跑脚本那头只看到「场景未跑完（超时）」）。
      if (byTestId("db-bottom-anchor")) byTestId("db-bottom-anchor").click();
      await sleep(400);
      out.immersiveJumpToLatestWhenImmersive = byTestId("db-bottom-anchor") === null &&
        bottomGap(immScroll) < 8;
      // ④ 沉浸态里滚到中段再展开：**当前阅读位置不许被弹走**（与 layoutPanelScrollStable 同款量法）
      immScroll.scrollTop = Math.round((immScroll.scrollHeight - immScroll.clientHeight) * 0.45);
      await sleep(400);
      // 锚定「当前正在读的那一行」= **视口里最靠上的那一行**（按 data-index 认它）。
      // 旧写法取 rows()[4]（第 5 个**渲染出来**的格子）：虚拟列表的窗口带 12 行 overscan，
      // 45% 处那个窗口是从列表开头开始的，于是 rows()[4] 落在视口**上方**（top 为负、用户
      // 根本看不见）—— 拿它当阅读位置量错了对象，换掉它是为了让断言指向「用户在看的那一条」。
      // 但**改口径并不能救回这条断言**：修之前两处数值相同（都是 88.1px，见
      // immersiveAnchorSlotDeltaPx / immersiveExitKeepsReadingPositionPx 的对照），
      // 因为 88.1px 根本不是「一行的位移」，而是**滚动容器自己下移了** —— 退出沉浸时
      // 房间头 57 + 房间标签条 31.1 回到弹幕区**上方**，容器顶边整体下移 88.1px，
      // 容器里的内容（scrollTop、锚点行的内容坐标、它相对容器顶边的 1px 偏移）一动没动。
      // 旧数值仍然记进快照（immersiveAnchorSlotIndex / ...SlotDeltaPx）当对照。
      var immScrollBox = rect(byTestId("db-chat-scroll"));
      var immVisibleRow = immScrollBox
        ? rows().filter(function (r) { return rect(r).bottom > immScrollBox.top + 1; })[0] || null
        : null;
      var immAnchorSlot = rows()[4];
      var immAnchorSlotWrap = immAnchorSlot ? immAnchorSlot.closest("[data-index]") : null;
      var immAnchorSlotIndex = immAnchorSlotWrap
        ? immAnchorSlotWrap.getAttribute("data-index") : null;
      var immAnchorSlotTop = immAnchorSlot
        ? Math.round(rect(immAnchorSlot).top * 10) / 10 : null;
      var immAnchor = immVisibleRow || immAnchorSlot;
      var immAnchorTop = immAnchor ? Math.round(rect(immAnchor).top * 10) / 10 : null;
      // 认的是**这一条消息**，不是「第 5 个渲染出来的格子」：虚拟列表渲染的是窗口里那几行，
      // 视口一变窗口就挪（退出沉浸时弹幕区矮回去 193px，窗口里换一批行），rows()[4]
      // 指向的已经不是同一条了。**别把 88.1px 读成行高**：layoutLastRowHeightPx 是 81.1，
      // 两个数只是同量级；88.1 = 房间头 57 + 房间标签条 31.1，是容器自己的位移。
      // 行的外层包装上有 data-index（MessageList 用虚拟项的 index 打的那一枚），
      // 记下它就能在退出之后把**同一条消息**找回来；比按下标取更硬，不是放水。
      var immAnchorWrap = immAnchor ? immAnchor.closest("[data-index]") : null;
      var immAnchorIndex = immAnchorWrap ? immAnchorWrap.getAttribute("data-index") : null;
      var rowByIndex = function (index) {
        var wrap = index === null ? null : document.querySelector('[data-index="' + index + '"]');
        return wrap ? wrap.querySelector('[data-testid="db-msg-row"]') : null;
      };
      // 顺带钉住「不跟双击选词打架」：选中一段正文（双击选词的等价物），
      // 进出沉浸模式都不许把它清掉，正文本身也不许变成不可选。
      var immBody = immAnchor ? immAnchor.querySelector('[data-testid="db-msg-body"]') : null;
      var immSelected = "";
      var immSelectable = false;
      if (immBody) {
        var immRange = document.createRange();
        immRange.selectNodeContents(immBody);
        var immSel = window.getSelection();
        immSel.removeAllRanges();
        immSel.addRange(immRange);
        immSelected = immSel.toString();
        immSelectable = getComputedStyle(immBody).userSelect !== "none";
      }
      out.immersiveSelectionProbe = { selected: immSelected.length, selectable: immSelectable };
      // ⑤ 触屏双击（pointerType = touch）退出：鼠标与触摸走的是同一条指针判据
      await immDoubleTap(byTestId("db-chat-scroll"), immTapX, immTapY, "touch");
      var immChat2 = rect(byTestId("db-chat-scroll"));
      // 用 data-index 把**同一条消息**找回来（见上面 immAnchorIndex 的说明）
      var immAnchorAfter = rowByIndex(immAnchorIndex);
      var immAnchorTopAfter = immAnchorAfter
        ? Math.round(rect(immAnchorAfter).top * 10) / 10 : null;
      out.immersiveAnchorIndex = immAnchorIndex;
      out.immersiveAnchorFoundAfter = !!immAnchorAfter;
      // 对照：同一个场景里那个 overscan 格子（旧锚点）的位移 —— 它动不代表阅读位置动了。
      var immAnchorSlotAfter = rowByIndex(immAnchorSlotIndex);
      out.immersiveAnchorSlotIndex = immAnchorSlotIndex;
      out.immersiveAnchorSlotDeltaPx = immAnchorSlotTop !== null && immAnchorSlotAfter
        ? Math.round((Math.round(rect(immAnchorSlotAfter).top * 10) / 10 - immAnchorSlotTop) * 10) / 10
        : null;
      out.immersiveExitOnTouchDoubleTap = immAttr() === null;
      out.immersiveRestoresLayout = byTestId("db-room-header") !== null &&
        byTestId("db-composer-tools") !== null &&
        immUnrendered(byTestId("db-room-tabs")) === false &&
        Math.abs(immChat2.height - immChat0.height) < 1.5;
      out.immersiveExitKeepsReadingPositionPx = immAnchorTop !== null && immAnchorTopAfter !== null
        ? Math.round((immAnchorTopAfter - immAnchorTop) * 10) / 10 : null;
      out.immersiveExitKeepsReadingPosition = immAnchorTop !== null &&
        immAnchorTopAfter !== null && Math.abs(out.immersiveExitKeepsReadingPositionPx) < 8 &&
        byTestId("db-bottom-anchor") !== null && bottomGap(byTestId("db-chat-scroll")) > 8;
      out.immersiveKeepsTextSelection = immSelected.length > 0 && immSelectable &&
        window.getSelection().toString() === immSelected;
      // ⑥ 落在可交互元素上的双击**不**切（判据的另一半）。两个探针，都是真的落在 button 上的双击：
      //    ① 临时插一枚**稳定的**按钮进弹幕区（挂完就用，用完即摘）—— 它没有任何 click 处理，
      //       所以这一对「点」必然被完整判据看到：判据里少了「排除可交互元素」这一条，这里就会翻进沉浸态。
      //    ② 真实的「回到最新」按钮（此刻不在跟随，它在场）—— 同一个判据在真实控件上的实例。
      //    断言只认「没翻进去、房间页没被拆」，不去认那枚按钮还在不在：万一某个引擎给派发的指针事件
      //    补一个 click，②里的按钮会被点掉（跟随恢复），那与「双击不切沉浸」是两件事。
      var immProbe = document.createElement("button");
      immProbe.setAttribute("type", "button");
      immProbe.setAttribute("data-testid", "db-immersive-probe");
      immProbe.style.cssText = "position:absolute;left:8px;top:8px;width:40px;height:40px;z-index:9";
      byTestId("db-chat-wrap").appendChild(immProbe);
      await immDoubleTap(immProbe, Math.round(rect(immProbe).left + 20),
        Math.round(rect(immProbe).top + 20), "mouse");
      var immAfterProbe = immAttr();
      var immJump = byTestId("db-bottom-anchor");
      var immJumpBox = rect(immJump);
      if (immJumpBox) {
        await immDoubleTap(immJump, Math.round(immJumpBox.left + immJumpBox.width / 2),
          Math.round(immJumpBox.top + immJumpBox.height / 2), "mouse");
      }
      immProbe.remove();
      out.immersiveButtonDoubleTapIgnored = immAfterProbe === null && immAttr() === null &&
        byTestId("db-room-header") !== null && byTestId("db-immersive-probe") === null;
      out.immersiveButtonProbe = {
        attrAfterProbe: immAfterProbe,
        attrAfterJump: immAttr(),
        jumpStillThere: byTestId("db-bottom-anchor") !== null,
      };
      // 复原成「跟随最新」：后面的段落依赖它（顺手清掉刚才那段落选择）
      window.getSelection().removeAllRanges();
      immScroll = byTestId("db-chat-scroll");
      immScroll.scrollTop = immScroll.scrollHeight;
      await sleep(500);
      out.immersiveRestoredPinned = byTestId("db-bottom-anchor") === null &&
        bottomGap(immScroll) < 8 && immAttr() === null;
      snap();
      immersiveBlockRan = true;
    } catch (e) {
      out.immersiveBlockError = String((e && e.stack) || e);
    } finally {
      // 无论成败都退出沉浸态（见块上那段说明），并把「退出来了没有」记进快照 ——
      // 快照是判官拿到的唯一证据，出错那一条（immersiveBlockError）也必须落进去，
      // 否则现场只剩「场景未跑完（超时）」一句话。
      out.immersiveRestoredAfterBlock = await immersiveOff();
      snap();
    }
    out.immersiveBlockRan = immersiveBlockRan;
    snap();



