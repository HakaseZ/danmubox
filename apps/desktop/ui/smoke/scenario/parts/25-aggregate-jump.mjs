// 场景块：弹幕聚合、阅读位置、回到最新、我的表情
//   弹幕聚合（不同观众短时同文本折一行：×N 与「都是谁」，非滑动窗口、至少两位观众）
//   面板展开改可视高度时正在看的位置不被弹走；「回到最新」是圆形图标钮（下箭头、与返回键同源几何）
//   emotes 主站「我的表情」分组可见、能选中、发出去带的是唯一键
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 弹幕聚合（issue 2609171849 第 7 条，docs/ui.md §8.4 第二条、契约 §4 的三条常量）：
    //      **不同观众**在短时间窗口里发的**同一条**弹幕折成一行 —— 正文行内「×N」（折了几条）
    //      紧跟一格「都是谁」（db-msg-senders）。三条读数：
    //      ① 同文本 + 两位不同观众 → **一行**、「×2」、名单里两位都在；
    //      ② **不同文本** → 两行（聚合只认同一个键）；
    //      ③ 同文本但**在窗口外**（5 秒）→ 两行（锚点是这一行的第一条，非滑动）。
    //      准入前提自己保证（testing.md §9.3 ②）：本段要求停在**房间页**、聊天流在场、且列表
    //      **跟随最新**（虚拟列表只渲染视口内的行，不跟随则新推的行根本不在 DOM 里）——
    //      不在底部就点一次「回到最新」，缺 db-msg-list 则当场报错红、不静默通过。
    //      读数一律**当场重查 DOM**（rows() / querySelector），因此归属于本次运行。
    //      注：这一段此前标注的「整个场景活在模板串里」已随 2026-09-17 的拆分作废（片段是页内原文）。
    var aggregateBlockRan = false;
    try {
      if (!byTestId("db-msg-list")) throw new Error("不在房间页：db-msg-list 不存在");
      var aggAnchor = byTestId("db-bottom-anchor");
      if (aggAnchor) {
        aggAnchor.click();
        await sleep(400);
      }
      var aggRowsOf = function (needle) {
        return rows().filter(function (r) { return r.innerText.indexOf(needle) >= 0; });
      };
      var aggCellOf = function (row, cell) {
        var el = row ? row.querySelector('[data-testid="' + cell + '"]') : null;
        return el ? el.innerText.trim() : null;
      };
      var aggPush = function (text, uid, uname, ts) {
        window.__emit("danmubox://message", window.__mk("danmaku", text, false, {
          uid: uid, uname: uname, ts: ts
        }));
      };
      // ① 两位不同观众、同一文本、相隔 100ms（窗口内）
      var aggT0 = Date.now();
      aggPush("聚合样本甲", 71001, "聚合一号", aggT0);
      aggPush("聚合样本甲", 71002, "聚合二号", aggT0 + 100);
      await sleep(400);
      var aggPair = aggRowsOf("聚合样本甲");
      out.aggregateSameTextRows = aggPair.length;
      out.aggregateSameTextCount = aggCellOf(aggPair[0], "db-msg-count");
      out.aggregateSameTextSenders = aggCellOf(aggPair[0], "db-msg-senders");
      out.aggregateSameText = aggPair.length === 1 &&
        out.aggregateSameTextCount === "×2" &&
        (out.aggregateSameTextSenders || "").indexOf("聚合一号") >= 0 &&
        (out.aggregateSameTextSenders || "").indexOf("聚合二号") >= 0;
      snap();
      // ② 不同文本：两条各占一行，且都不是聚合行（没有 ×N / 名单两格）
      aggPush("聚合样本乙", 71003, "聚合三号", Date.now());
      aggPush("聚合样本丙", 71004, "聚合四号", Date.now() + 50);
      await sleep(400);
      var aggB = aggRowsOf("聚合样本乙");
      var aggC = aggRowsOf("聚合样本丙");
      out.aggregateDifferentTextTwoRows =
        aggB.length === 1 && aggC.length === 1 &&
        aggCellOf(aggB[0], "db-msg-count") === null &&
        aggCellOf(aggC[0], "db-msg-senders") === null;
      // ③ 同文本、但第一条落在 60 秒前（远在 5 秒窗口之外）：不许折
      aggPush("聚合样本丁", 71005, "聚合五号", Date.now() - 60000);
      aggPush("聚合样本丁", 71006, "聚合六号", Date.now());
      await sleep(400);
      out.aggregateWindowSeparatesRows = aggRowsOf("聚合样本丁").length === 2;
      snap();
      aggregateBlockRan = true;
    } catch (e) {
      out.aggregateBlockError = String((e && e.stack) || e);
      snap();
    }
    out.aggregateBlockRan = aggregateBlockRan;

    // ---- 面板展开会改可视高度：**正在看的位置不能被弹走**
    // 先把列表停在中间（此时不在底部 = 非跟随模式），再展开面板，量同一个行在视口里的
    // 位置变化。跟随模式下重新贴底是**有意**的（见 MessageList 的 ResizeObserver），
    // 所以这里量的是「用户自己滚上去看历史」时的行为。
    var stableScroll = byTestId("db-chat-scroll");
    // 先等列表**静止**：进场行的自动摘除会少掉一行，上面少一行会把下面整体顶上去整整一行高
    // （实测 29px）——那是「自动消失」的既定行为，不是面板把视口弹走了。判据必须用
    // 「发出时刻 + 8s」这个时钟，**不能**用「列表里还在不在那一行」：列表这会儿滚在中间，
    // 那一行根本不在渲染窗口里，rowWith 看不见它，等它等于没等。
    var settleWait = (window.__interactAt || 0) + 8000 + 250 - Date.now();
    if (settleWait > 0) await sleep(settleWait);
    await sleep(400);
    stableScroll.scrollTop = Math.round((stableScroll.scrollHeight - stableScroll.clientHeight) * 0.55);
    await sleep(300);
    out.layoutPausedBeforePanel = stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight > 8;
    // 另一半：**用户自己往上滚**必须真的降为「不跟随」——判据同样是状态按钮出现
    out.layoutPausedShowsJumpButton = !!byTestId("db-bottom-anchor");
    // ---- item 1 + issue #2：「回到最新」那枚图标是**下箭头**，与房间头返回键**同源几何**
    //      （docs/ui.md §3.1 的矢量规范 + §7.4）：同一个 24 × 24 viewBox、同一条 stroke-width 1.75、
    //      round 线帽 / 接合、墨迹居中 (12,12)、主轴 16 单位；箭头朝下 ⇒ 宽 > 高。
    //      issue #2 之后它是一枚**圆形图标钮**（与返回键共用 .ctlRound / .ctlIcon）：可见文字
    //      一个都没有 ⇒ 可访问名只能由 aria-label / title 给（innerText 必须为空）。
    var anchorBtn = byTestId("db-bottom-anchor");
    var anchorSvg = anchorBtn ? anchorBtn.querySelector("svg") : null;
    out.jumpIconSvgShown = !!anchorSvg;
    out.jumpIconAriaHidden = !!anchorSvg && anchorSvg.getAttribute("aria-hidden") === "true";
    out.jumpButtonAccessibleName = anchorBtn ? (anchorBtn.getAttribute("aria-label") || "") : null;
    out.jumpButtonNamesPurpose = !!anchorBtn &&
      out.jumpButtonAccessibleName.indexOf("回到最新") >= 0 &&
      (anchorBtn.getAttribute("title") || "") === out.jumpButtonAccessibleName;
    out.jumpButtonHasNoText = !!anchorBtn && anchorBtn.innerText.trim() === "";
    // 与返回键**同尺寸**：控件都 40 × 40 正圆，图标盒都 24
    out.jumpControlSameSizeAsBack = !!anchorBtn && !!roundCtl[0] && !!anchorSvg &&
      !!out.iconBack &&
      Math.abs(rect(anchorBtn).width - rect(roundCtl[0]).width) < 0.6 &&
      Math.abs(rect(anchorBtn).width - 40) < 0.6 &&
      Math.abs(rect(anchorSvg).width - out.iconBack.boxPx) < 0.6;
    out.jumpIcon = iconGeomOf(anchorBtn);
    out.jumpIconInkCentered = !!out.jumpIcon &&
      Math.abs(out.jumpIcon.inkCenterX - 12) < 0.2 && Math.abs(out.jumpIcon.inkCenterY - 12) < 0.2;
    out.jumpIconSameViewBox = !!out.jumpIcon && out.jumpIcon.viewBox === "0 0 24 24";
    out.jumpIconBackArrowExtent = !!out.jumpIcon &&
      Math.abs(Math.max(out.jumpIcon.inkW, out.jumpIcon.inkH) - 16) < 0.2;
    out.jumpIconPointsDown = !!out.jumpIcon && out.jumpIcon.inkW > out.jumpIcon.inkH;
    // 与返回键量到的**同一套规范**逐项相同：描边宽度 / 线帽 / 接合 / 形状数（只有朝向不同）。
    // issue #2 之后两枚的渲染盒也一样（都 24），但描边仍比**用户单位**（SVG 里写死的数），
    // 缩放系数不算规范的一部分 —— 同一套规范因此不该被盒子的换算方式带偏。
    out.jumpIconStrokeUnits = out.jumpIcon
      ? Math.round((out.jumpIcon.inkThicknessPx / out.jumpIcon.scale) * 100) / 100
      : null;
    out.jumpIconSameStrokeAsBack = out.jumpIconStrokeUnits !== null &&
      Math.abs(out.jumpIconStrokeUnits - 1.75) < 0.01 && !!out.iconBack &&
      Math.abs(out.iconBack.inkThicknessPx / out.iconBack.scale - out.jumpIconStrokeUnits) < 0.01 &&
      out.jumpIcon.linecap === "round" && out.jumpIcon.linejoin === "round" &&
      out.jumpIcon.shapeCount === 1;
    var anchorRow = rows()[4];
    var anchorTopBefore = anchorRow ? Math.round(rect(anchorRow).top * 10) / 10 : null;
    clickTool("表情");
    await sleep(600);
    var anchorTopAfter = anchorRow && anchorRow.isConnected
      ? Math.round(rect(anchorRow).top * 10) / 10
      : null;
    out.layoutPanelScrollStablePx = anchorTopBefore !== null && anchorTopAfter !== null
      ? Math.round((anchorTopAfter - anchorTopBefore) * 10) / 10
      : null;
    out.layoutPanelScrollStable = out.layoutPausedBeforePanel &&
      out.layoutPanelScrollStablePx !== null && Math.abs(out.layoutPanelScrollStablePx) < 8;
    clickTool("表情");
    await sleep(200);
    // 还原成「跟随最新」，后面的断言依赖它
    stableScroll.scrollTop = stableScroll.scrollHeight;
    await sleep(500);
    out.layoutStabilityRestored =
      stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight < 8;
    out.layoutJumpButtonGoneAfterRestore = !byTestId("db-bottom-anchor");

    // ---- emotes 主站「我的表情」：分组可见、选得到、发出去带的是唯一键（issue #8）
    out.emotesOwnedCalled = calls.indexOf("emotes_owned") >= 0;
    clickTool("表情");
    await sleep(400);
    var emotePanel = byTestId("db-panel");
    out.ownedGroupShown = !!emotePanel && emotePanel.innerText.indexOf("我的表情") >= 0;
    // tab 化之后「我的表情」不默认在场：先切过去，再找那一格
    var ownedTab = emotePanel
      ? [].slice.call(emotePanel.querySelectorAll('[data-testid="db-emote-tab"]')).filter(function (b) {
          return b.getAttribute("data-kind") === "owned";
        })[0]
      : null;
    if (ownedTab) {
      ownedTab.click();
      await sleep(300);
    }
    // 取哪一条：**从真实载荷里挑**（用户命名的那条自定义表情），不在断言里写死名字
    var ownedSample = EMOTES.owned.filter(function (e) { return e.text.indexOf("吃瓜") >= 0; })[0];
    var ownedPicker = byTestId("db-panel")
      ? byTestId("db-panel").querySelector('button[title="' + ownedSample.text + '"]')
      : null;
    out.ownedEmoteShown = !!ownedPicker;
