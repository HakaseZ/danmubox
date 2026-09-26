// 场景块：刷屏弹幕聚合、阅读位置、回到最新、我的表情
//   刷屏弹幕聚合（**3 条以上 + 两位不同观众**才折：身份位印「刷屏 ×N」、头像列错位 30% 堆叠前 3 位、
//   窗口**滑动**（每并入一条刷新一次 5 秒、无条数上限）、关掉开关逐条显示）
//   面板展开改可视高度时正在看的位置不被弹走；「回到最新」是圆形图标钮（下箭头、与返回键同源几何）
//   emotes 主站「我的表情」分组可见、能选中、发出去带的是唯一键
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 刷屏弹幕聚合（issue 202609211940 第 3 条，docs/ui.md §8.4 第二条、契约 §4 的四条常量）：
    //      **3 条以上**同键、同一个**滑动**的 5 秒窗口（基准是这一串的**最后一条**，每并入一条
    //      就把窗口往后刷一次 5 秒，**没有条数上限**）、参与观众去重后 **≥ 2 位不同 uid** 才折成一行：
    //      头像列画前 3 位观众的头像（沿 X 轴依次错开 30% 个头像宽、后一张压在前一张上、
    //      **最左那张在最上层**），身份位改印「刷屏 ×N」且**一个用户名都不出现**
    //      （db-msg-name / db-msg-badges 都不画），行内那一格 db-msg-count 也不再画
    //      （数量已经在身份位）。五条读数：
    //      ① 同文本 + 3 位不同观众（窗口内）→ **一行**、「刷屏 ×3」、堆叠 3 张头像（错位 30%、
    //         z-index 递减）、身份位没有用户名 / 徽标、行内没有 ×N；
    //      ② **不同文本** → 两行（聚合只认同一个键），且照旧画昵称（正面对照）；
    //      ③ 同文本、每 4 秒一条连发三条（首尾跨 8 秒 > 一个窗口）→ **一行**「刷屏 ×3」
    //         （**滑动**窗口只看与上一条的距离）；再补一条离上一条 6 秒的 → 它自己一行；
    //      ④ 三位观众里有一位**没头像** → 头像列只画两张、错位也只错开一次（空 url 不占位）；
    //      ⑤ **关掉开关**（ui.danmaku_aggregate，点筛选面板里那一枚）→ 同样三条**逐条显示**
    //         （三行、没有「刷屏 ×N」也没有堆叠层、昵称照旧），点回来当场又折成一行；
    //         收尾把面板关回去（紧邻的 26 段接着用同一个面板节点，于是这条也当场钉住）。
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
      // 开关走**筛选面板里那一枚复选框**（与用户点它同一条路）：面板是 db-panel，
      // 打开 / 收起与 35-cheap-gift 那一段同一套写法（点工具行的「筛选」）。
      var aggPanelOpen = function () { return !!byTestId("db-panel"); };
      var aggSetPanel = async function (open) {
        if (aggPanelOpen() !== open) {
          clickTool("筛选");
          await sleep(400);
        }
        return aggPanelOpen() === open;
      };
      var aggSetSwitch = async function (value) {
        if (!await aggSetPanel(true)) return false;
        var picked = [].slice.call(byTestId("db-panel").querySelectorAll("label")).filter(function (l) {
          return l.innerText.trim() === "刷屏弹幕聚合";
        })[0];
        var box = picked ? picked.querySelector('input[type="checkbox"]') : null;
        if (!box) return false;
        if (box.checked !== value) {
          box.click();
          await sleep(400);
        }
        return window.__prefs["ui.danmaku_aggregate"] === value;
      };
      // 一条弹幕：`face` 传空串就是「上游没给头像」那一档（头像列不许画假图）。
      var aggPush = function (text, uid, uname, ts, face) {
        window.__emit("danmubox://message", window.__mk("danmaku", text, false, {
          uid: uid, uname: uname, ts: ts, face: face
        }));
      };
      // ① 三位不同观众、同一文本、相隔 100ms（都在窗口内）
      var aggT0 = Date.now();
      aggPush("聚合样本甲", 71001, "聚合一号", aggT0, FACE_512);
      aggPush("聚合样本甲", 71002, "聚合二号", aggT0 + 100, FACE_512);
      aggPush("聚合样本甲", 71003, "聚合三号", aggT0 + 200, FACE_512);
      await sleep(450);
      var aggTrio = aggRowsOf("聚合样本甲");
      var aggTrioRow = aggTrio[0];
      var aggStack = aggTrioRow ? aggTrioRow.querySelector('[data-testid="db-msg-avatar-stack"]') : null;
      var aggStackItems = aggStack ? [].slice.call(aggStack.children) : [];
      var aggStackFaces = aggStack ? [].slice.call(aggStack.querySelectorAll('[data-testid="db-msg-avatar"]')) : [];
      var aggStackBox = rect(aggStack);
      var aggOffsets = aggStackItems.map(function (el) {
        return Math.round((rect(el).left - aggStackBox.left) * 10) / 10;
      });
      // z-index 只认「最左那张在最上层」这条序：数值本身不重要（递减即可）。
      var aggZOrder = aggStackItems.map(function (el) { return Number(getComputedStyle(el).zIndex) || 0; });
      var aggFaceW = aggStackFaces.length > 0 ? rect(aggStackFaces[0]).width : 0;
      out.aggregateSameTextRows = aggTrio.length;
      out.aggregateSpamText = aggCellOf(aggTrioRow, "db-msg-spam");
      out.aggregateSpamStackCount = aggStackFaces.length;
      out.aggregateSpamOffsets = aggOffsets.join(",");
      out.aggregateSpamZOrder = aggZOrder.join(",");
      out.aggregateSameText = aggTrio.length === 1 &&
        out.aggregateSpamText === "刷屏 ×3" &&
        // 身份位**一个用户名都不出现**：代表行（第一条）的昵称也不许在行里露头
        aggTrioRow.innerText.indexOf("聚合一号") < 0 &&
        aggTrioRow.querySelector('[data-testid="db-msg-name"]') === null &&
        aggTrioRow.querySelector('[data-testid="db-msg-badges"]') === null &&
        // 数量只在身份位出现一次（行内那一格不画）
        aggCellOf(aggTrioRow, "db-msg-count") === null;
      // 头像列：3 张、每个错开 30% 个头像宽、容器宽 = 头像宽 × 1.6、高 = 头像宽、最左那张在最上层
      out.aggregateSameTextAvatars = aggStack !== null && aggStackFaces.length === 3 &&
        aggStackBox.height > 0 && Math.abs(aggStackBox.height - aggFaceW) < 0.6 &&
        Math.abs(aggStackBox.width - aggFaceW * 1.6) < 1 &&
        Math.abs(aggOffsets[0]) < 0.6 &&
        Math.abs(aggOffsets[1] - aggFaceW * 0.3) < 1 &&
        Math.abs(aggOffsets[2] - aggFaceW * 0.6) < 1 &&
        aggZOrder[0] > aggZOrder[1] && aggZOrder[1] > aggZOrder[2];
      snap();
      // ② 不同文本：两条各占一行，都不是聚合行（没有「刷屏 ×N」、没有堆叠层，昵称照旧画）
      aggPush("聚合样本乙", 71004, "聚合四号", Date.now(), FACE_512);
      aggPush("聚合样本丙", 71005, "聚合五号", Date.now() + 50, FACE_512);
      await sleep(450);
      var aggB = aggRowsOf("聚合样本乙");
      var aggC = aggRowsOf("聚合样本丙");
      out.aggregateDifferentTextTwoRows =
        aggB.length === 1 && aggC.length === 1 &&
        aggCellOf(aggB[0], "db-msg-count") === null &&
        aggCellOf(aggC[0], "db-msg-spam") === null &&
        aggCellOf(aggC[0], "db-msg-name") !== null &&
        aggC[0].querySelector('[data-testid="db-msg-avatar-stack"]') === null;
      // ③ 同文本、每 4 秒一条连发三条（首尾跨 8 秒，**超过**一个窗口）：窗口是**滑动**的 ——
      //    基准是这一串的**最后一条**，每并入一条就把 5 秒往后刷一次，因此三条并成**一行**
      //    「刷屏 ×3」。非滑动（与第一条比）会在第三条处切成一串两条 + 一条，串串不够门槛
      //    ⇒ 三行且一行都不折 —— 旧读数量正是那个，按新语义翻过来。
      //    再补一条离上一条 6 秒的：窗口到此收口，它自己站一行（不够 3 条 ⇒ 不折，昵称照旧）。
      var aggT1 = Date.now() - 6000;
      aggPush("聚合样本丁", 71006, "聚合六号", aggT1 - 8000, FACE_512);
      aggPush("聚合样本丁", 71007, "聚合七号", aggT1 - 4000, FACE_512);
      aggPush("聚合样本丁", 71008, "聚合八号", aggT1, FACE_512);
      aggPush("聚合样本丁", 71064, "聚合窗口后", aggT1 + 6000, FACE_512);
      await sleep(450);
      var aggWindowRows = aggRowsOf("聚合样本丁");
      out.aggregateWindowRows = aggWindowRows.length;
      out.aggregateWindowFirstSpam = aggCellOf(aggWindowRows[0], "db-msg-spam");
      out.aggregateWindowSlidesRows = aggWindowRows.length === 2 &&
        out.aggregateWindowFirstSpam === "刷屏 ×3" &&
        // 后面那条离上一条 6 秒 ⇒ 另起一串：只有一条、不折（没有「刷屏 ×N」，昵称照旧）
        aggWindowRows[1].querySelector('[data-testid="db-msg-spam"]') === null &&
        aggCellOf(aggWindowRows[1], "db-msg-name") !== null;
      // ④ 三位观众里有一位没头像：头像列只画两张（不画假图），错位也只错开一次
      aggPush("聚合样本戊", 71009, "聚合九号", Date.now(), FACE_512);
      aggPush("聚合样本戊", 71010, "聚合十号", Date.now() + 50, "");
      aggPush("聚合样本戊", 71011, "聚合十一号", Date.now() + 100, FACE_512);
      await sleep(450);
      var aggBareRows = aggRowsOf("聚合样本戊");
      var aggBareStack = aggBareRows[0]
        ? aggBareRows[0].querySelector('[data-testid="db-msg-avatar-stack"]') : null;
      var aggBareFaces = aggBareStack
        ? [].slice.call(aggBareStack.querySelectorAll('[data-testid="db-msg-avatar"]')) : [];
      var aggBareW = aggBareFaces.length > 0 ? rect(aggBareFaces[0]).width : 0;
      out.aggregateEmptyFaceNoSlot = aggBareRows.length === 1 && aggBareFaces.length === 2 &&
        aggBareStack !== null && Math.abs(rect(aggBareStack).width - aggBareW * 1.3) < 1;
      snap();
      // ⑤ 关掉开关（ui.danmaku_aggregate）：同样三条**逐条显示** —— 一行都不是聚合行，
      //    昵称照旧回来；点回来又折成一行（纯派生，不丢内容）。
      var aggSwitchOff = await aggSetSwitch(false);
      await aggSetPanel(false);
      aggPush("聚合样本己", 71012, "聚合十二号", Date.now(), FACE_512);
      aggPush("聚合样本己", 71013, "聚合十三号", Date.now() + 50, FACE_512);
      aggPush("聚合样本己", 71014, "聚合十四号", Date.now() + 100, FACE_512);
      await sleep(450);
      var aggPlainRows = aggRowsOf("聚合样本己");
      out.aggregateSwitchOffRows = aggPlainRows.length;
      out.aggregateSwitchOffKeepsRows = aggSwitchOff && aggPlainRows.length === 3 &&
        aggPlainRows.every(function (r) {
          return r.querySelector('[data-testid="db-msg-spam"]') === null &&
            r.querySelector('[data-testid="db-msg-avatar-stack"]') === null;
        }) &&
        aggCellOf(aggPlainRows[0], "db-msg-name") !== null;
      var aggSwitchOn = await aggSetSwitch(true);
      var aggPanelClosed = await aggSetPanel(false);
      await sleep(450);
      var aggBackRows = aggRowsOf("聚合样本己");
      out.aggregateSwitchBackFolds = aggSwitchOn && aggBackRows.length === 1 &&
        aggCellOf(aggBackRows[0], "db-msg-spam") === "刷屏 ×3";
      // 收尾必须**确定**：本段结束时筛选面板要是关着的。紧邻的 26 那一段会在同一枚工具行按钮上
      // 开一次筛选面板，并把那个节点存进**块间共享的** `filterPanel`（var 声明同一条函数作用域）
      // 一路用到 27 —— 面板要是漏着，26 那一次点击只是把它**关掉**，后续 clickLabelIn 静默失效
      // （26 的注释记着改前实测过的这条坑）。这条断言把「漏着」从静默变成当场红。
      out.aggregatePanelClosedAfterToggle = aggPanelClosed;
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
