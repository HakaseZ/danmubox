// 场景块：标题随 ROOM_CHANGE 刷新 + 互动消息共用单槽位（用户 2026-09-26）
//   ① 标题：push 一条带新标题的 danmubox://room，房间头标题（db-room-title）随之更新；
//      证明它走的是 state.rooms 回写这条路（与 onRoom 的 ROOM_CHANGE 同源，见 store.saveAnchorTitle）。
//   ② 单槽位：单条互动消息到达时弹幕列表里不出现互动行（ui.interact_single_slot 默认开，
//      toDisplayRows 已剔除），浮层 db-interact-slot 显示最新一条；连续两条时浮层文案刷新为后到的
//      那条（快速顶替），且整段里只该有这一个浮层。
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
      titleSlotBlockRan = true;
    } catch (e) {
      out.titleSlotBlockError = String((e && e.stack) || e);
      titleSlotBlockRan = false;
    }
    out.titleSlotBlockRan = titleSlotBlockRan;
    if (NARROW) put("titleSlotNarrow", true);
