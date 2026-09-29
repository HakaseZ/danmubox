// 场景块：标题随 ROOM_CHANGE 刷新 + 互动消息共用单槽位（用户 2026-09-26；高度口径 2026-09-27 修正）
//   ① 标题：push 一条带新标题的 danmubox://room，房间头标题（db-room-title）随之更新；
//      证明它走的是 state.rooms 回写这条路（与 onRoom 的 ROOM_CHANGE 同源，见 store.saveAnchorTitle）。
//   ② 单槽位：单条互动消息到达时弹幕列表里不出现互动行（ui.interact_single_slot 默认开，
//      toDisplayRows 已剔除），浮层 db-interact-slot 显示最新一条；连续两条时浮层文案刷新为后到的
//      那条（快速顶替），且整段里只该有这一个浮层。
//   ③ 预留（2026-09-29 换口径）：预留不再「等于互动气泡自身的高度」、也不再挂在外层盒子上 ——
//      它落在**滚动内容的末尾**（`.scroller` 的 `padding-bottom`），且必须**不小于**气泡实际占的
//      那条带（行高 + 它与下边界之间那道 2px）。⚠ 改前那条「预留 == 气泡高」钉的是旧口径：
//      那时这一带是**盒子之外的死区**，剪不断理还乱的是翻查时内容永远画不进去。
//   ④ 翻查（2026-09-29 需求）：贴底时最新一行停在气泡之上（不被压住）；**向上翻**时先前的行会
//      **滚进这一带** ⇒ 只有气泡自身那点面积压着它们，其余照常显示 —— 而不是被这条带截断。
//   ⑤ 缩回（需求 1.2 / 1.4）：空闲 INTERACT_SLOT_MS（4s）+ 淡出（300ms）之后**整块卸载**。
//      判据只能是**时钟**：淡出是 CSS Modules 的 @keyframes，动画名会被哈希改名，比对
//      animationName 认不出「我的淡出播完了没有」⇒ 槽位永不卸载。卸载后 `:has()` 失效 ⇒ 预留
//      退回 `.scroller` 原本的呼吸位（不再是「列表长高一段」—— 这一带从没挤过列表的高度）。
//   准入：本块自带入房间（先回列表页再点开 fixtureRoom 的卡片），不依赖上一块留下的页面状态。
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    var titleSlotBlockRan = false;
    try {
      // 前提：本块从**列表页**开始 —— 若此刻在房间页，返回键必然存在。
      if (!byTestId("db-list-page")) {
        byTestId("db-header-back").click();
        await sleep(600);
      }
      // 点开 fixtureRoom（与 36 同一手段），确保 db-room-title 指的就是它、且 activeRoomId 对齐。
      var tsCard = byTestId("db-room-card");
      var tsCards = allByTestId("db-room-card");
      for (var tsI = 0; tsI < tsCards.length; tsI += 1) {
        if (tsCards[tsI].innerText.indexOf(fixtureRoom.anchor_uname) >= 0) {
          tsCard = tsCards[tsI];
          break;
        }
      }
      tsCard.click();
      await sleep(900);

      // ---- ① 标题随 ROOM_CHANGE 刷新
      var tsTitleBefore = byTestId("db-room-title") ? byTestId("db-room-title").innerText : "";
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: "回归测试新标题" });
      await sleep(400);
      var tsTitleEl = byTestId("db-room-title");
      out.roomTitleFollowsEvent = !!tsTitleEl && tsTitleEl.innerText.indexOf("回归测试新标题") >= 0;
      out.roomTitleChanged = !!tsTitleEl && tsTitleBefore.indexOf("回归测试新标题") < 0;

      // ---- ② 互动消息共用单槽位
      var tsSlotBefore = byTestId("db-interact-slot");
      out.interactSlotHiddenBefore = !tsSlotBefore;
      window.__emit("danmubox://message", window.__mk("interact", "", false, {
        room_id: fixtureRoom.room_id, uname: "顶替甲", ts: Date.now()
      }));
      await sleep(400);
      var tsSlot1 = byTestId("db-interact-slot");
      out.interactSlotShowsFirst = !!tsSlot1 && tsSlot1.innerText.indexOf("顶替甲") >= 0;
      // 列表（db-chat-scroll）里**不该**出现这条互动文案：单槽位开时 toDisplayRows 已剔除 interact。
      var tsScroll = byTestId("db-chat-scroll");
      window.__emit("danmubox://message", window.__mk("interact", "", false, {
        room_id: fixtureRoom.room_id, uname: "顶替乙", ts: Date.now() + 100
      }));
      await sleep(400);
      var tsSlot2 = byTestId("db-interact-slot");
      out.interactSlotReplacesWithSecond = !!tsSlot2 && tsSlot2.innerText.indexOf("顶替乙") >= 0;
      out.interactRowNotInList = !!tsScroll &&
        tsScroll.innerText.indexOf("顶替甲") < 0 &&
        tsScroll.innerText.indexOf("顶替乙") < 0;
      out.interactSlotStillSingle = !!tsSlot2 && allByTestId("db-interact-slot").length === 1;

      // ---- ③ 预留**落在滚动内容的末尾**（2026-09-29 换口径）
      //      量法只看几何：预留 = 滚动容器 `db-chat-scroll` 的 `padding-bottom`
      //      （改前它挂在外层 `.chatWrap` 上 —— 那是盒子之外的死区，翻查时内容永远画不进去）；
      //      气泡 = 槽位的第一个子元素（`.interactSlotBox`，退场层是绝对定位的兄弟，不撑高盒子）。
      var tsWrap = byTestId("db-chat-wrap");
      var tsWrapRect = tsWrap ? tsWrap.getBoundingClientRect() : null;
      var tsScroller = byTestId("db-chat-scroll");
      var tsPad = tsScroller ? parseFloat(getComputedStyle(tsScroller).paddingBottom) || 0 : 0;
      var tsWrapPad = tsWrap ? parseFloat(getComputedStyle(tsWrap).paddingBottom) || 0 : 0;
      var tsSlotRect = tsSlot2 ? tsSlot2.getBoundingClientRect() : null;
      var tsBox = tsSlot2 ? tsSlot2.firstElementChild : null;
      var tsBoxRect = tsBox ? tsBox.getBoundingClientRect() : null;
      out.interactSlotPadPx = Math.round(tsPad * 10) / 10;
      out.interactSlotWrapPadPx = Math.round(tsWrapPad * 10) / 10;
      out.interactSlotBubblePx = tsBoxRect ? Math.round(tsBoxRect.height * 10) / 10 : null;
      out.interactSlotSpaceReserved = !!tsScroller && tsPad > 0;
      // **搬了家**：外层盒子的下内边距必须是 0（留那儿 = 盒子外的死区 = 翻查被截断），
      // 那段空间必须在滚动内容的末尾。
      out.interactSlotReserveLivesInScrollContent = tsWrapPad === 0 && tsPad > 0;
      // 气泡与下边界之间那道 2px（用户 2026-09-29：「互动下方加 2px，不贴在输入框上」）。
      var tsGapPx = tsSlotRect && tsWrapRect
        ? Math.round((tsWrapRect.bottom - tsSlotRect.bottom) * 10) / 10
        : 0;
      out.interactSlotGapPx = tsGapPx;
      out.interactSlotGapIs2 = !!tsSlotRect && !!tsWrapRect && Math.abs(tsGapPx - 2) <= 1;
      // 预留必须**不小于**气泡实际占的那条带（行高 + 那道间隙）—— 否则贴底时气泡又压住最新一条。
      // （改前钉的是「预留 == 气泡高」，那时还没有这道间隙。）
      out.interactSlotReserveCoversBubble = !!tsBoxRect && !!tsWrapRect &&
        tsPad >= tsBoxRect.height + tsGapPx - 1;
      // 槽位整体（外层定位壳）不得高过气泡本身。
      out.interactSlotNoTallerThanBubble = !!tsSlotRect && !!tsBoxRect &&
        tsSlotRect.height <= tsBoxRect.height + 1;
      // 气泡整条落在预留带里（顶边不高于「容器底边 - 预留」）——否则它压住最新一条弹幕。
      out.interactSlotInsideReservedBand = !!tsSlotRect && !!tsWrapRect && tsPad > 0 &&
        tsSlotRect.top >= tsWrapRect.bottom - tsPad - 1 &&
        tsSlotRect.bottom <= tsWrapRect.bottom + 1;

      // ---- ④ 翻查时内容**滚进**这条带，而不是被这条带截断（2026-09-29 需求）
      //      前提 1：列表得有富余内容才谈得上「翻查」—— 先补一批普通弹幕。
      //      前提 2：气泡 4.3s 后就整块卸载，测量前补一条新的、保证它在场。
      for (var tsN = 0; tsN < 30; tsN += 1) {
        window.__emit("danmubox://message", window.__mk("danmaku", "翻查用 " + tsN, false, {
          room_id: fixtureRoom.room_id, uname: "回头看的你", ts: Date.now() + tsN
        }));
      }
      window.__emit("danmubox://message", window.__mk("interact", "", false, {
        room_id: fixtureRoom.room_id, uname: "翻查时在场", ts: Date.now() + 40
      }));
      await sleep(500);
      // 只看**真的占位**的那些行：礼物栏折叠时兜里的行是 display:none、rect 全 0，
      // 混进来会让「贴底那一行」取到一堆 0、判据假通过。
      var visibleRows = function () {
        return rows().filter(function (r) { return r.getBoundingClientRect().height > 1; });
      };
      var tsScroller2 = byTestId("db-chat-scroll");
      var tsSlot3 = byTestId("db-interact-slot");
      var tsSlot3Rect = tsSlot3 ? tsSlot3.getBoundingClientRect() : null;
      out.interactSlotHadRoomToScroll = !!tsScroller2 &&
        tsScroller2.scrollHeight > tsScroller2.clientHeight + 20;
      // 贴底时（默认视角）最新一行不许被气泡压住：这一行的底边得停在气泡顶边之上。
      var tsRowsAtBottom = visibleRows();
      var tsLastRowRect = tsRowsAtBottom.length > 0
        ? tsRowsAtBottom[tsRowsAtBottom.length - 1].getBoundingClientRect()
        : null;
      out.interactSlotLatestRowClearOfBubble = !!tsLastRowRect && !!tsSlot3Rect &&
        tsLastRowRect.bottom <= tsSlot3Rect.top + 1;
      // 向上翻一点点 —— 预留若留在外层盒子（改前那样），那条带是**永远画不进内容的死区**；
      // 现在必须有某行跨进这一带（⇒ 只有气泡自身那点面积会压住它们，其余照常显示）。
      var tsScrollDelta = !!tsScroller2
        ? Math.min(90, tsScroller2.scrollHeight - tsScroller2.clientHeight)
        : 0;
      if (tsScroller2) {
        tsScroller2.scrollTop = tsScroller2.scrollHeight - tsScroller2.clientHeight - tsScrollDelta;
      }
      await sleep(350);
      out.interactSlotScrolledUpPx = Math.round(tsScrollDelta * 10) / 10;
      var tsRowIntoBand = null;
      var tsRowsScrolled = visibleRows();
      for (var tsJ = 0; tsJ < tsRowsScrolled.length; tsJ += 1) {
        var tsRowRect = tsRowsScrolled[tsJ].getBoundingClientRect();
        if (tsSlot3Rect && tsRowRect.top < tsSlot3Rect.bottom &&
            tsRowRect.bottom > tsSlot3Rect.top) {
          tsRowIntoBand = tsRowRect;
          break;
        }
      }
      out.interactSlotContentReachesUnderBubble = !!tsRowIntoBand;
      if (tsScroller2) tsScroller2.scrollTop = tsScroller2.scrollHeight;
      await sleep(300);

      // ---- ⑤ 空闲到点后整块卸载、预留退回原本那点呼吸位
      //      判据只能是**时钟**：淡出是 CSS Modules 的 @keyframes，动画名会被哈希改名，比对
      //      animationName 认不出「我的淡出播完了没有」⇒ 槽位永不卸载。
      //      ⚠ 不再是「空出的一段还给弹幕区、列表长高」—— 改后这一带压根没挤过列表的高度,
      //      变的是内容**末尾**那段空白,所以它退回的是 `.scroller` 原本的 `--sp-2`。
      // 4s 空闲 + 300ms 淡出 = 4300ms（INTERACT_SLOT_MS / INTERACT_SLOT_FADE_MS），
      // 上面那批消息的 ts 可能在发车之后 —— 等 5.4s 留足余量（定时器被节流也不至于假红）。
      await sleep(5400);
      var tsPadAfter = tsScroller ? parseFloat(getComputedStyle(tsScroller).paddingBottom) || 0 : 0;
      out.interactSlotUnmountedWhenIdle = !byTestId("db-interact-slot");
      out.interactSlotReserveBackToBaseline = !!tsScroller && tsPadAfter > 0 && tsPadAfter < tsPad;
      snap();
      titleSlotBlockRan = true;
    } catch (e) {
      out.titleSlotBlockError = String((e && e.stack) || e);
      titleSlotBlockRan = false;
      // 出错也要走到 snap()：否则这一段之后的读数一个都不产出（docs/testing.md §9.3 ③）。
      snap();
    }
    out.titleSlotBlockRan = titleSlotBlockRan;
    if (NARROW) put("titleSlotNarrow", true);
