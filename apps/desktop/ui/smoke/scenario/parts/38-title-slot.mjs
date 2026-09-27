// 场景块：标题随 ROOM_CHANGE 刷新 + 互动消息共用单槽位（用户 2026-09-26；高度口径 2026-09-27 修正）
//   ① 标题：push 一条带新标题的 danmubox://room，房间头标题（db-room-title）随之更新；
//      证明它走的是 state.rooms 回写这条路（与 onRoom 的 ROOM_CHANGE 同源，见 store.saveAnchorTitle）。
//   ② 单槽位：单条互动消息到达时弹幕列表里不出现互动行（ui.interact_single_slot 默认开，
//      toDisplayRows 已剔除），浮层 db-interact-slot 显示最新一条；连续两条时浮层文案刷新为后到的
//      那条（快速顶替），且整段里只该有这一个浮层。
//   ③ 预留高度（需求 1.1）：预留**等于互动气泡自身的高度**，且气泡整条落在预留带里。
//      ⚠ 旧断言 `tsPad >= tsSlotRect.height` 钉的是**改前**的口径（预留 = 气泡高 + 上下各一道
//      安全间距，于是多留 24px 纯空白段），已按新口径换成「预留 == 气泡高」+「槽位不高过气泡」。
//   ④ 缩回补齐（需求 1.2 / 1.4）：空闲 INTERACT_SLOT_MS（4s）+ 淡出（300ms）之后**整块卸载**。
//      判据只能是**时钟**：淡出是 CSS Modules 的 @keyframes，动画名会被哈希改名，比对
//      animationName 认不出「我的淡出播完了没有」⇒ 槽位永不卸载、预留永不回收。
//      卸载后 `:has(> .interactSlot)` 失效 → 预留归零 → 空出的那一段真的还给弹幕列表
//      （滚动容器长高）、贴底的那一行随之下移同样的量（弹幕缩回补齐）。
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

      // ---- ③ 预留高度 = 互动气泡自身的高度（需求 1.1）
      //      量法只看几何：预留 = 容器的下内边距；气泡 = 槽位的第一个子元素（`.interactSlotBox`，
      //      退场层是绝对定位的兄弟，不撑高盒子）。
      var tsWrap = byTestId("db-chat-wrap");
      var tsPad = tsWrap ? parseFloat(getComputedStyle(tsWrap).paddingBottom) || 0 : 0;
      var tsWrapRect = tsWrap ? tsWrap.getBoundingClientRect() : null;
      var tsSlotRect = tsSlot2 ? tsSlot2.getBoundingClientRect() : null;
      var tsBox = tsSlot2 ? tsSlot2.firstElementChild : null;
      var tsBoxRect = tsBox ? tsBox.getBoundingClientRect() : null;
      out.interactSlotPadPx = Math.round(tsPad * 10) / 10;
      out.interactSlotBubblePx = tsBoxRect ? Math.round(tsBoxRect.height * 10) / 10 : null;
      out.interactSlotSpaceReserved = !!tsWrap && tsPad > 0;
      // 预留**等于**气泡高（改前是「气泡高 + 上下各一道安全间距」，多留 24px 空白段）。
      out.interactSlotReserveEqualsBubble = !!tsBoxRect && Math.abs(tsPad - tsBoxRect.height) <= 1;
      // 槽位整体（外层定位壳）不得高过气泡本身。
      out.interactSlotNoTallerThanBubble = !!tsSlotRect && !!tsBoxRect &&
        tsSlotRect.height <= tsBoxRect.height + 1;
      // 气泡整条落在预留带里（顶边不高于「容器底边 - 预留」）——否则它压住最新一条弹幕。
      out.interactSlotInsideReservedBand = !!tsSlotRect && !!tsWrapRect && tsPad > 0 &&
        tsSlotRect.top >= tsWrapRect.bottom - tsPad - 1 &&
        tsSlotRect.bottom <= tsWrapRect.bottom + 1;

      // ---- ④ 缩回补齐：空闲到点后整块卸载、预留归零、空出的那一段还给弹幕（需求 1.2 / 1.4）
      //      先记下留白时的几何（滚动容器高 + 贴底那一行的底边），卸载后再量一次。
      var tsScrollBefore = tsScroll ? tsScroll.getBoundingClientRect().height : null;
      var tsRowsBefore = rows();
      var tsLastBefore = tsRowsBefore.length > 0
        ? tsRowsBefore[tsRowsBefore.length - 1].getBoundingClientRect().bottom
        : null;
      // 4s 空闲 + 300ms 淡出 = 4300ms（INTERACT_SLOT_MS / INTERACT_SLOT_FADE_MS），
      // 乙那条的 ts 还比发车时刻大 100ms —— 等 5.4s 留足余量（定时器被节流也不至于假红）。
      await sleep(5400);
      var tsWrapAfter = byTestId("db-chat-wrap");
      var tsPadAfter = tsWrapAfter ? parseFloat(getComputedStyle(tsWrapAfter).paddingBottom) || 0 : 0;
      out.interactSlotUnmountedWhenIdle = !byTestId("db-interact-slot");
      out.interactSlotReserveDroppedWhenIdle = tsPadAfter === 0;
      var tsScrollAfter = byTestId("db-chat-scroll");
      var tsScrollAfterH = tsScrollAfter ? tsScrollAfter.getBoundingClientRect().height : null;
      var tsRowsAfter = rows();
      var tsLastAfter = tsRowsAfter.length > 0
        ? tsRowsAfter[tsRowsAfter.length - 1].getBoundingClientRect().bottom
        : null;
      // 空出来的那一段真的还给了弹幕区：滚动容器正好长高「刚才那段预留」。
      out.interactSlotRetractFreesSpace = tsScrollBefore !== null && tsScrollAfterH !== null &&
        Math.abs((tsScrollAfterH - tsScrollBefore) - tsPad) <= 1.5;
      // 贴底那一行随之下移同样的量 ⇒ 弹幕上移填补空出的部分，不留空白段。
      out.interactSlotLostSpaceFilledByDanmaku = tsLastBefore !== null && tsLastAfter !== null &&
        Math.abs((tsLastAfter - tsLastBefore) - tsPad) <= 1.5;
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
