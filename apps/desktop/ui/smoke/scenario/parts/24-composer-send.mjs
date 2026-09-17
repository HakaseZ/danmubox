// 场景块：发送链路：浮动提示、乐观渲染、粉丝牌
//   发送失败 = 浮动提示（无常驻提示行、pointer-events: none、2.6s 后自去）
//   乐观渲染 + 回执校验（本地行与已确认行逐项相同、回执只做校验、被拒才留痕）
//   layout 粉丝牌只在佩戴着 / 亮着时才画（刚发出的那条不带牌）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 发送失败 = **浮动提示**（用户 2026-09-12：「发送失败也不要在最下出提示，弹窗提示
    //      然后渐隐消失（这个过程不要挡住滚动的弹幕）即可」）。四条一起量：
    //      ① 最下方**没有**常驻提示行；② 浮片在且 pointer-events 为 none（弹幕照常滚、照常点）；
    //      ③ 浮片的矩形与弹幕列表区域**不相交**（这才是「不挡弹幕」的可验形式）；
    //      ④ 渐隐之后元素被摘掉（不是「透明地占着位置」）。
    window.__setSendOutcome("failed", "上游拒绝：弹幕被吞");
    // 回执先**扣住**：这一步要看的正是「上游还没回的」那一瞬间 —— 那条行此时必须与已确认行
    // 一模一样（无标记、无弱化），失败标记只允许在回执明确说没发出去之后才出现。
    window.__holdSend();
    typeIntoArea(document.querySelector("textarea"), "这条会发失败");
    await sleep(250);
    var sendButton = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .filter(function (b) { return b.innerText.trim() === "发送"; })[0];
    if (sendButton) sendButton.click();
    await sleep(250);
    var heldFailRow = rowWith("这条会发失败");
    out.sendFailRowNoMarkBeforeOutcome = !!heldFailRow &&
      !heldFailRow.querySelector('[data-testid="db-msg-send-state"]');
    // 用户 2026-09-13：「发出去就是和已发送一样的状态」—— 回执没回之前那一行不许有任何弱化
    // （被删掉的那档弱化是 opacity: .6，这里逐位钉回 1）。
    out.sendFailRowNoFadeBeforeOutcome = !!heldFailRow &&
      getComputedStyle(heldFailRow).opacity === "1";
    window.__releaseSend();
    await sleep(500);
    var toastEl = byTestId("db-toast");
    var toastBox = rect(toastEl);
    var chatBoxForToast = rect(byTestId("db-chat-scroll"));
    out.sendFailNoBottomHint = !byTestId("db-send-hint");
    out.sendFailToastShown = !!toastEl && toastEl.innerText.indexOf("发送失败") >= 0;
    out.sendFailToastText = toastEl ? toastEl.innerText : null;
    out.sendFailToastPassive = !!toastEl &&
      getComputedStyle(toastEl).pointerEvents === "none";
    out.sendFailToastClearsList = !!toastEl && !!chatBoxForToast &&
      !(toastBox.bottom > chatBoxForToast.top + 1 && toastBox.top < chatBoxForToast.bottom - 1 &&
        toastBox.right > chatBoxForToast.left + 1 && toastBox.left < chatBoxForToast.right - 1);
    out.sendFailToastAboveComposer = !!toastEl &&
      toastBox.bottom <= rect(document.querySelector("textarea")).top + 1;
    // 失败修正（用户 2026-09-13）：上游说没发出去时，**那一条本地行**要就地标成失败，
    // 而既有的浮动提示一并保留（提示是用户此前明确要求的，不许为了加行标记把它删掉）。
    var failRow = rowWith("这条会发失败");
    var failMark = failRow
      ? failRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    // 被拒的那条**留在列表里**（用户 2026-09-13：「那行消失我希望能得到保留，划线并标注一下被 ban
    // 的原因，便于我对照修改」），行尾那枚标记写的是**原因**（与浮片同一句，见 sendOutcomeText）。
    out.sendFailRowMarked = !!failMark &&
      failMark.getAttribute("data-state") === "rejected" &&
      failMark.innerText.indexOf("上游拒绝：弹幕被吞") >= 0;
    out.sendFailRowReason = failMark ? failMark.innerText : null;
    // 行上那句话与浮片上那句话**必须逐字相同**：两处说的是同一件事，不许各自表述。
    out.sendFailRowReasonMatchesToast = !!failMark && !!toastEl &&
      failMark.innerText === toastEl.innerText;
    // 正文划线（.rejectedText 的 line-through）：这是「对照着改」的锚点。
    var failBody = failRow ? failRow.querySelector('[data-testid="db-msg-body"] span') : null;
    out.sendFailRowStruckThrough = !!failBody &&
      getComputedStyle(failBody).textDecorationLine.indexOf("line-through") >= 0;
    // 但整行**不弱化**：划掉的是那条弹幕，不是「把整行淡化到看不清」。
    out.sendFailRowNotFaded = !!failRow && getComputedStyle(failRow).opacity === "1";
    // 被拒的那条**只有一条**：标被拒不是「再插一条」。
    out.sendFailRowSingle = rows().filter(function (r) {
      return r.innerText.indexOf("这条会发失败") >= 0;
    }).length === 1;
    out.sendFailRowMarkedWithToast = out.sendFailRowMarked && out.sendFailToastShown === true;
    // 草稿留着：被拒之后要能照着行上划掉的正文 + 原因自己改一条再发（用户 2026-09-13：
    // 「便于我对照修改」）—— 发出去（outcome 为 ok）才清空。
    out.sendFailKeepsDraft = document.querySelector("textarea").value === "这条会发失败";
    // **被吞写明理由**（用户 2026-09-13：「被吞写明理由，如 发送失败 · 全局屏蔽词 /
    //  发送失败 · 房间屏蔽词」）：两档各发一条，行尾标记必须把那句话写出来
    // （上游只给 f / k 一个标记，「是哪一份词库」由界面说清）。
    // 放在草稿那条断言**之后**：这两次发送会把草稿清空，插在前面会把上面那条弄红。
    window.__setSendOutcome("blocked_platform", "msg=f");
    typeIntoArea(document.querySelector("textarea"), "被平台吞的样本");
    await sleep(200);
    sendButton.click();
    await sleep(400);
    var blockedRow = rowWith("被平台吞的样本");
    var blockedMark = blockedRow
      ? blockedRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.blockedRowNamesGlobalWords = !!blockedMark &&
      blockedMark.innerText.indexOf("发送失败 · 全局屏蔽词") >= 0;
    window.__setSendOutcome("blocked_room", "msg=k");
    typeIntoArea(document.querySelector("textarea"), "被房间吞的样本");
    await sleep(200);
    sendButton.click();
    await sleep(400);
    var roomBlockedRow = rowWith("被房间吞的样本");
    var roomBlockedMark = roomBlockedRow
      ? roomBlockedRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.blockedRowNamesRoomWords = !!roomBlockedMark &&
      roomBlockedMark.innerText.indexOf("发送失败 · 房间屏蔽词") >= 0;
    typeIntoArea(document.querySelector("textarea"), "");
    window.__setSendOutcome("ok", null);
    await sleep(200);
    snap();
    await sleep(3200);
    out.sendFailToastGone = !byTestId("db-toast");
    typeIntoArea(document.querySelector("textarea"), "");
    window.__setSendOutcome("ok", null);
    await sleep(200);
    snap();

    // ---- 乐观渲染 + 回执校验（用户 2026-09-13：「发送应该即刻响应，上游只校验发送成功与否，
    //      无论成功与否我都是发了；失败再修正弹幕状态」；同一天再更正：「我不需要发送中这个状态，
    //      发出去就是和已发送一样的状态，上游返回的数据只做校验」）。四步各自取证：
    //      ① 点击后**本地那条立刻在列表里**（量「点击 → 行出现」的毫秒数；改前要等上游回推 ≈1.36s）；
    //      ② 这条行与**已确认行渲染逐项相同** —— 不透明度 / 行、昵称、正文的字色 / 字号逐项相等，
    //         且两边都没有修正标记（本次要钉的契约：不许有「发送中」那类待确认视觉）；
    //      ③ 上游把自己那条回推回来 → 本地那条**转正**：仍然只有一条，且各项与普通行无差别；
    //      ④ 「转正」是**换掉**不是「再插一条」——总量也不许多出来。
    // 对照行：先显式推一条**上游来的、本人的**弹幕（uid 与本地行相同、走的是同一条渲染路径），
    // 它就是「已确认行」的样本；下面拿它与点击后插进来的那条逐项比对。
    var confirmedText = "已确认对照行";
    window.__emit("danmubox://message", window.__mk("danmaku", confirmedText, false, {
      uid: 1000, uname: "本地测试"
    }));
    await sleep(300);
    var optimisticText = "乐观渲染样本弹幕";
    var optimisticRow = function () { return rowWith(optimisticText); };
    var optimisticRowCount = function () {
      return rows().filter(function (r) { return r.innerText.indexOf(optimisticText) >= 0; }).length;
    };
    typeIntoArea(document.querySelector("textarea"), optimisticText);
    await sleep(200);
    var optimisticT0 = performance.now();
    sendButton.click();
    var optimisticAppearMs = null;
    for (var optimisticTry = 0; optimisticTry < 60 && optimisticAppearMs === null; optimisticTry += 1) {
      if (optimisticRow()) optimisticAppearMs = performance.now() - optimisticT0;
      else await sleep(8);
    }
    out.sendOptimisticAppearMs = optimisticAppearMs === null
      ? null : Math.round(optimisticAppearMs * 10) / 10;
    // 「立刻」的判据取 250ms 这个宽松档（含一帧渲染 + WebKit 的抖动）：改前实测是 1820ms，
    // 两者差一个数量级，所以这个阈值能拦住「又回去等上游回播」的退步。
    out.sendOptimisticAppearsImmediately = optimisticAppearMs !== null && optimisticAppearMs <= 250;
    // **按正文数行**，不按渲染行数：虚拟列表的渲染窗口是定长的（可视 + overscan），
    // 在末尾插一行时「渲染出来的行数」可能一个都不变（窗口上沿丢一行、下沿进一行），
    // 拿它当「插了几条」的判据会假失败。
    out.sendOptimisticRowsBeforeEcho = optimisticRowCount();
    out.sendOptimisticSingleRow = optimisticRowCount() === 1;
    var optimisticEl = optimisticRow();
    // 「与已确认行渲染逐项相同」的可验形式：取**同一组计算样式**逐项比对，并各自确认
    // 没有修正标记。两条都是本人（uid 1000）的 danmaku 行（同 kind、同身份来源），
    // 这一组值本就该等价；任何「待确认」弱化（不透明度 / 字色 / 字号）或标记都会当场露出来。
    var lookOf = function (el) {
      if (!el) return null;
      var nameEl = el.querySelector('[data-testid="db-msg-name"]');
      var bodyEl = el.querySelector('[data-testid="db-msg-body"]');
      var rowStyle = getComputedStyle(el);
      return {
        opacity: rowStyle.opacity,
        color: rowStyle.color,
        fontSize: rowStyle.fontSize,
        nameColor: nameEl ? getComputedStyle(nameEl).color : null,
        bodyColor: bodyEl ? getComputedStyle(bodyEl).color : null,
        hasState: !!el.querySelector('[data-testid="db-msg-send-state"]')
      };
    };
    out.sendOptimisticLook = lookOf(optimisticEl);
    out.sendOptimisticConfirmedLook = lookOf(rowWith(confirmedText));
    out.sendOptimisticRendersLikeConfirmed = !!optimisticEl &&
      out.sendOptimisticConfirmedLook !== null &&
      JSON.stringify(out.sendOptimisticLook) === JSON.stringify(out.sendOptimisticConfirmedLook) &&
      out.sendOptimisticLook.hasState === false;
    // **第一帧就带头像**（用户 2026-09-13：「含身份牌 / 等级 / 头像 / 表情 / 间距等上游行会显示的
    // 一切」）：插入的那一行必须已经有头像图。改前它不带 face，头像要等回播换上来才出现 ——
    // 那就是用户看见的那次「修正」。（这里只钉「有头像」，不比 URL：那份 URL 属于当前账号。）
    var optimisticAvatar = optimisticEl
      ? optimisticEl.querySelector('[data-testid="db-msg-avatar"]') : null;
    out.sendOptimisticHasFace = !!optimisticAvatar &&
      (optimisticAvatar.getAttribute("src") || "").length > 0;
    // 停下让跑脚本的进程抓一张截图：同一屏里上下两条（刚发的 + 已确认的）外观应当一致，
    // 这张图就是「两者无法区分」的证据（它每 250ms 读一次 data-smoke）。
    out.sendOptimisticShown = out.sendOptimisticRendersLikeConfirmed;
    snap();
    await sleep(700);
    // 上游把自己那条回播回来（uid 与正文对得上，见 store.matchPending 的对账规则）。
    // **故意带一张不同的头像**：本地行插入时的头像取自当前账号（Account.face，取自 nav），回播那条带的是
    // 上游权威值 —— 换进来才算「我用别的客户端看到的样子」。真机上两者是同一张图（都是我的头像），
    // 所以看不出变化；这里用一张不同的，证明字段确实换进来了（而不是被忽略）。
    var echoFace =
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%23e05b7a'/></svg>";
    window.__emit("danmubox://message", window.__mk("danmaku", optimisticText, false, {
      uid: 1000, uname: "本地测试", face: echoFace
    }));
    await sleep(300);
    var convertedRow = optimisticRow();
    out.sendOptimisticRowsAfterEcho = optimisticRowCount();
    out.sendOptimisticEchoSingleRow = optimisticRowCount() === 1;
    // 「看不出有回播」的可验形式（用户 2026-09-13：「那个时候根本看不出来有回播，只知道如果被 ban 了
    // 那个弹幕会消失然后弹个提示」），分三件量：
    // ① **同一个 DOM 节点**：回播前取的句柄 === 回播后按正文重新查到的那个（节点没被重建）；
    // ② **样式逐项不变**：lookOf 快照与回播前那一次相等（不是「与对照行相同」）；
    // ③ **字段换成上游的**：头像 src 变成回播那条给的那张。
    // ①②保证「不重建、不闪」，③保证「以上游为准」—— 两件事必须同时成立，缺一个都不算对。
    out.sendOptimisticEchoSameNode = !!optimisticEl && optimisticEl === convertedRow &&
      optimisticEl.isConnected === true;
    out.sendOptimisticEchoLookUnchanged = !!convertedRow &&
      JSON.stringify(lookOf(convertedRow)) === JSON.stringify(out.sendOptimisticLook);
    var echoAvatar = convertedRow
      ? convertedRow.querySelector('[data-testid="db-msg-avatar"]') : null;
    out.sendOptimisticEchoAdoptsFace = !!echoAvatar &&
      echoAvatar.getAttribute("src") === echoFace;
    // 回播后：状态标记没了（这条已经是上游的事实），昵称/正文以远端那条为准。
    out.sendOptimisticEchoConverted = !!convertedRow &&
      !convertedRow.querySelector('[data-testid="db-msg-send-state"]') &&
      convertedRow.innerText.indexOf("本地测试") >= 0;
    // 本地那一条**留在原位**而不是又插一条：同一正文的行数回播前后都是 1（不是 2），
    // 而且它身上不再挂标记（字段已经换成上游那条）。
    out.sendOptimisticEchoAbsorbedLocal = optimisticRowCount() === 1 && !!convertedRow &&
      !convertedRow.querySelector('[data-testid="db-msg-send-state"]');
    // 换过字段的那条与**已确认行**同样逐项相同（它现在就是上游那条的字段 + 本地那个 key）。
    var echoLook = lookOf(convertedRow);
    var confirmedLookAfterEcho = lookOf(rowWith(confirmedText));
    out.sendOptimisticEchoRendersLikeConfirmed = !!echoLook && !!confirmedLookAfterEcho &&
      JSON.stringify(echoLook) === JSON.stringify(confirmedLookAfterEcho);
    typeIntoArea(document.querySelector("textarea"), "");
    snap();

    // ---- 粉丝牌只在**佩戴着 / 亮着**时才画（用户 2026-09-13：「还是有区别，刚发出去会有一个
    //      1级本直播间粉丝牌，但是不应该有才对」）。官方判据（2026-09-13 读官方前端产物取证）：
    //      弹幕侧看 medal.is_light（官方分支 if (F?.is_lighted) { 追加粉丝牌 }），
    //      身份侧看 data.medal.is_weared —— **持有 ≠ 佩戴**，没戴就不画。
    // 这块整体包一层：里面一次发送 / 一次身份事件出岔子时要**让断言红**，而不是把整个场景
    // 卡到 300s（那样只能看到「未跑完」这一句、定位不到原因）。异常文本一并进快照。
    var medalBlockOk = false;
    try {
    //      ① 上游行：同一正文、同一牌名，只差 medal_lit 一个布尔，看画不画。
    window.__emit("danmubox://message", window.__mk("danmaku", "没点亮的牌样本", false, {
      uname: "灰牌观众", medal_level: 7, medal_name: "本房间牌", medal_lit: false
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "亮着的牌样本", false, {
      uname: "亮牌观众", medal_level: 7, medal_name: "本房间牌", medal_lit: true
    }));
    await sleep(300);
    var unlitRow = rowWith("没点亮的牌样本");
    var litRow = rowWith("亮着的牌样本");
    out.medalHiddenWhenNotLit = !!unlitRow &&
      !unlitRow.querySelector('[data-testid="db-msg-badges"]');
    out.medalShownWhenLit = !!litRow &&
      !!litRow.querySelector('[data-testid="db-msg-badges"]') &&
      litRow.innerText.indexOf("本房间牌") >= 0;
    //      ② 本地乐观行：身份说「持有 Lv1 但没佩戴」→ 一行里**不许**出现牌；
    //         改成「佩戴」后同一条路径必须画出来（正面对照，防止过滤过头）。
    window.__setSendOutcome("ok", null);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 1, my_medal_name: "本房间牌",
      my_medal_worn: false, my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(200);
    typeIntoArea(document.querySelector("textarea"), "持有但没戴牌");
    await sleep(150);
    sendButton.click();
    await sleep(250);
    var unwornLocal = rowWith("持有但没戴牌");
    out.sendLocalHidesUnwornMedal = !!unwornLocal &&
      !unwornLocal.querySelector('[data-testid="db-msg-badges"]');
    typeIntoArea(document.querySelector("textarea"), "");
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 1, my_medal_name: "本房间牌",
      my_medal_worn: true, my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(200);
    typeIntoArea(document.querySelector("textarea"), "戴着牌发的");
    await sleep(150);
    sendButton.click();
    await sleep(250);
    var wornLocal = rowWith("戴着牌发的");
    out.sendLocalShowsWornMedal = !!wornLocal &&
      !!wornLocal.querySelector('[data-testid="db-msg-badges"]') &&
      wornLocal.innerText.indexOf("本房间牌") >= 0;
    typeIntoArea(document.querySelector("textarea"), "");
      medalBlockOk = true;
    } catch (e) {
      out.medalBlockError = String((e && e.stack) || e);
    }
    out.medalBlockRan = medalBlockOk;
    snap();

