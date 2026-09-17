// 场景块：滚到顶部不被头部压住 + 账号区与账号对话框
//   滚到顶部时第一条不被头部压住（量完还原滚动位置）
//   account 账号区只留一行身份、整行即入口（游客态同样可点，键盘 Enter / Space 等价）
//   对话框：一行一个账号、非当前账号整行可点即切换、二维码卡片与上方一级块同宽、＋ 添加账号居中
//   切号隔离（重拉 rooms_list / follow_list 并回列表页）、重新登录二次确认、删除当前账号自动切走、退出登录回游客态
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 滚到顶部时第一条不被头部压住（头部是文档流里的一行，不是 sticky/fixed 浮层）。
    // 放在最后量：改滚动位置会影响「跟随最新」，量完立刻还原。
    var headerBox = rect(byTestId("db-room-header"));
    var chatScroll = byTestId("db-chat-scroll");
    var keptScrollTop = chatScroll.scrollTop;
    chatScroll.scrollTop = 0;
    await sleep(300);
    var topRow = rows()[0];
    var chatScrollBox = rect(chatScroll);
    out.layoutHeaderOverlapPx = topRow
      ? Math.round((chatScrollBox.top - rect(topRow).top) * 10) / 10
      : null;
    out.layoutHeaderAboveList = headerBox.bottom <= chatScrollBox.top + 1;
    out.layoutTopRowNotCovered = !!topRow &&
      rect(topRow).top >= chatScrollBox.top - 0.5;
    out.layoutTopRowVisible = !!topRow &&
      rect(topRow).top >= chatScrollBox.top - 0.5 &&
      rect(topRow).bottom <= chatScrollBox.bottom + 1;
    chatScroll.scrollTop = keptScrollTop;
    await sleep(500);
    // 还原的判据是「又回到贴底 / 跟随状态」，不是 scrollTop 逐位相等：
    // 虚拟列表的高度估算落定后，可滚区间的最大值会差几像素，逐位比较是假失败。
    out.layoutScrollRestored =
      chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 8;
    snap();

    // ---- account 账号区一行身份 + 账号管理对话框（契约 §7 accounts_*）
    byTestId("db-header-back").click();
    await sleep(500);
    var account = byTestId("db-account");
    out.accountShown = !!account;
    // 下拉整块删掉了：单条目下拉会被读成「切换功能坏了」（用户原话「好像没法选」）
    out.accountNoDropdown = !!account && account.querySelector("select") === null;
    out.accountShowsIdentity = !!byTestId("db-account-name") &&
      byTestId("db-account-name").innerText.indexOf("本地测试") >= 0 &&
      byTestId("db-account-uid").innerText.indexOf("1000") >= 0;
    // ---- issue #8：**整行即入口**（独立的「账号」按钮已删）。这一行本身就是按钮语义：
    //      role=button + tabIndex=0 + aria-label「账号管理」，行内不再有别的可点元素。
    out.accountOpenButtonGone = byTestId("db-account-open") === null;
    out.accountRowIsEntry = !!account &&
      account.getAttribute("role") === "button" &&
      account.getAttribute("tabindex") === "0" &&
      (account.getAttribute("aria-label") || "").indexOf("账号管理") >= 0;
    out.accountRowHasNoInnerButton = !!account && account.querySelector("button") === null;
    var followBefore = window.__followCalls;
    // 停一下让跑脚本的进程抓一张「账号区只留一行」的截图
    out.accountAreaReady = out.accountShown;
    snap();
    await sleep(900);

    // 鼠标：点这一行开对话框；键盘：Enter / Space 等价（行是 div role=button，键事件由它的
    // keydown 处理 —— 焦点先落上去再派发，与真实「Tab 到这一行再按」同一条路径）。
    account.click();
    await sleep(400);
    out.accountDialogShown = !!byTestId("db-account-dialog");
    // ---- issue #3：对话框排版（宽屏 / 窄屏同一套断言，两档各量一次）
    // ① 「＋ 添加账号」在内容宽里**水平居中**（左右留白相等），且**不拉满整行** —— 拉满的行
    //    左右留白当然也相等，所以「比参照块窄」必须一起判。时序：开扫码时这枚按钮**不在 DOM 里**，
    //    所以只能在点它之前量。参照物取账号行：两者都是对话框里的一级块，都撑满内容宽。
    var addBtnNow = byTestId("db-account-add");
    var accountRowRef = allByTestId("db-account-row")[0];
    out.accountAddShownBeforeScan = !!addBtnNow;
    out.accountAddCenteredPx = addBtnNow && accountRowRef
      ? Math.round(((rect(addBtnNow).left - rect(accountRowRef).left) -
          (rect(accountRowRef).right - rect(addBtnNow).right)) * 10) / 10
      : null;
    out.accountAddCentered = out.accountAddCenteredPx !== null &&
      Math.abs(out.accountAddCenteredPx) <= 1;
    out.accountAddNotStretched = !!addBtnNow && !!accountRowRef &&
      rect(addBtnNow).width < rect(accountRowRef).width - 8;
    // ---- item 2：对话框里**没有**「关闭」按钮了（db-account-close 在整个界面里都不存在），
    //      关闭只剩两条路 —— **Esc** 与**点背景**。下面各走一次，每次都断卡片真的消失
    //      （后面还各再走一次，两条路径都不是「只关得掉一次」）。
    out.accountDialogCloseButtonGone = byTestId("db-account-close") === null;
    pressEscape();
    await sleep(300);
    out.accountDialogClosedByEscape = !byTestId("db-account-dialog");
    pressKey(account, "Enter");
    await sleep(400);
    out.accountRowEnterOpensDialog = !!byTestId("db-account-dialog");
    var accountBackdropClicked = clickDialogBackdrop(byTestId("db-account-dialog"));
    await sleep(300);
    out.accountDialogClosedByBackdrop = accountBackdropClicked &&
      !byTestId("db-account-dialog");
    pressKey(account, " ");
    await sleep(400);
    out.accountRowSpaceOpensDialog = !!byTestId("db-account-dialog");
    // 窄屏：账号对话框是自底部升起的 sheet（占满宽度、贴着视口底），可滚动、有关闭入口、热区 ≥ 40px
    if (NARROW) {
      var accountDlgEl = byTestId("db-account-dialog");
      var accountDlgRect = rect(accountDlgEl);
      var accountDlgHotspots = shortHotspots(accountDlgEl);
      put("accountDialogIsBottomSheet",
        Math.abs(accountDlgRect.bottom - window.innerHeight) < 2 &&
        Math.abs(accountDlgRect.width - document.documentElement.clientWidth) < 2);
      put("accountDialogScrollable", getComputedStyle(accountDlgEl).overflowY === "auto");
      // item 2：关闭入口不再是一枚按钮（卡片里没有 db-account-close）；「关得掉」由上面
      // 的 Esc / 点背景两条断言负责，这里只钉「卡片里确实没有那枚按钮」。
      put("accountDialogNoCloseButton", byTestId("db-account-close") === null);
      put("accountDialogHotspotsBad", accountDlgHotspots);
      put("accountDialogHotspotsAtLeast40", accountDlgHotspots.length === 0);
    }
    var rowsBefore = allByTestId("db-account-row");
    out.accountDialogRowsBefore = rowsBefore.length;
    out.accountRowShowsWho = rowsBefore.length === 1 &&
      rowsBefore[0].innerText.indexOf("本地测试") >= 0 &&
      rowsBefore[0].innerText.indexOf("uid 1000") >= 0;
    out.accountRowAvatarShown = rowsBefore.length === 1 &&
      !!rowsBefore[0].querySelector("img");
    // 窄屏：账号行里「昵称 / uid / 账号名」与操作按钮不许横向叠在一起（放不下就该换行）
    var rowUidEl = rowsBefore.length === 1
      ? rowsBefore[0].querySelector('[data-testid="db-account-row-uid"]')
      : null;
    var rowRemoveEl = rowsBefore.length === 1
      ? rowsBefore[0].querySelector('[data-testid="db-account-remove"]')
      : null;
    var rowActionsEl = rowRemoveEl ? rowRemoveEl.parentElement : null;
    put("accountRowNoOverlap", !!rowUidEl && !!rowActionsEl &&
      (rect(rowUidEl).right <= rect(rowActionsEl).left + 1 ||
        rect(rowActionsEl).top >= rect(rowUidEl).bottom - 1));
    out.accountCurrentMarked = rowsBefore.length === 1 &&
      byTestId("db-account-row-status").innerText.trim() === "已登录 · 当前";
    // 单账号时也必须看得到添加入口（用户卡住的就是这一步）
    out.accountAddShownWithOneAccount = !!byTestId("db-account-add");
    var onlyRemoveBtn = rowsBefore.length === 1 ? buttonWith(rowsBefore[0], "删除") : null;
    out.accountRemoveDisabledWithOneAccount = !!onlyRemoveBtn && onlyRemoveBtn.disabled &&
      (onlyRemoveBtn.title || "").indexOf("至少保留") >= 0;
    // ---- item 5：切换改成**非当前账号整行可点**（db-account-switch 按钮已删）。
    //      当前账号行因此没有按钮语义、也没有可切的目标：不带 role / tabindex / aria-label，
    //      点它也不会发出 account_switch。
    //      （item 6：手填 Cookie 整条链路已删，这里不再有 accountCookieEntryReachable。）
    var switchesBeforeCurrentClick =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length;
    rowsBefore[0].click();
    await sleep(300);
    out.accountCurrentRowNotSwitchable = rowsBefore.length === 1 &&
      !rowsBefore[0].getAttribute("role") && rowsBefore[0].getAttribute("tabindex") === null &&
      !rowsBefore[0].getAttribute("aria-label") &&
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length ===
        switchesBeforeCurrentClick;
    snap();
    await sleep(800);

    // 添加账号 = 默认入口：account_qr_start 不带 target，永不覆盖任何凭据
    byTestId("db-account-add").click();
    await sleep(400);
    // ---- issue #3 ②③：二维码卡片与上方的一级块**同宽**（撑满对话框内容宽，不再是贴左的
    //      fit-content）；它与上方块的间距 = 对话框的统一行间距（.accountDialog 的 gap），
    //      **不另加外边距**（改前是 fit-content 242px + margin-top 20px）。
    var qrCardEl = byTestId("db-account-qr");
    var qrRowRef = allByTestId("db-account-row")[0];
    var accountDlgForGap = byTestId("db-account-dialog");
    var accountDlgGap = accountDlgForGap
      ? parseFloat(getComputedStyle(accountDlgForGap).rowGap) : null;
    out.accountQrSameWidthAsRow = !!qrCardEl && !!qrRowRef &&
      Math.abs(rect(qrCardEl).width - rect(qrRowRef).width) <= 1;
    out.accountQrGapPx = qrCardEl && qrRowRef
      ? Math.round((rect(qrCardEl).top - rect(qrRowRef).bottom) * 10) / 10
      : null;
    out.accountQrGapIsDialogGap = out.accountQrGapPx !== null && accountDlgGap !== null &&
      Math.abs(out.accountQrGapPx - accountDlgGap) <= 1;
    var startCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; });
    var lastStart = startCalls[startCalls.length - 1];
    out.accountAddCallsQrStart = startCalls.length === 1;
    out.accountAddStartHasNoTarget = !!lastStart && lastStart.args.target === undefined;
    var qrImg = byTestId("db-account-qr-img");
    out.accountQrImgShown = !!qrImg &&
      String(qrImg.getAttribute("src")).indexOf("data:image/svg+xml") === 0;
    out.accountQrAddNeverOverwrites = byTestId("db-account-qr-warn") === null;
    out.accountQrPendingHintSaysScan =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("扫码") >= 0;
    snap();
    await sleep(900);
    await sleep(2300);
    out.accountQrScannedHintShown =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("确认") >= 0;
    await sleep(2300);
    out.accountQrClosedAfterConfirm = !byTestId("db-account-qr");
    var rowsAfterAdd = allByTestId("db-account-row");
    out.accountDialogRowsAfterAdd = rowsAfterAdd.length;
    out.accountNewRowIsCurrent = rowsAfterAdd.length === 2 &&
      rowsAfterAdd[1].innerText.indexOf("已登录 · 当前") >= 0;
    out.accountIdentityRefreshedAfterAdd = byTestId("db-account-name").innerText.indexOf("扫码新用户") >= 0;
    out.accountFollowReloadedAfterAdd = window.__followCalls > followBefore;

    // 轮询失败要能重试：面板留在原地（二维码还在）+ 给出错误原因 + 「重新获取」能再发一次
    byTestId("db-account-add").click();
    await sleep(400);
    window.__qrFail = true;
    await sleep(2400);
    out.accountQrFailureShown =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("失败") >= 0;
    out.accountQrRetryOffered = !!byTestId("db-account-qr-retry");
    var startsBeforeRetry =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    byTestId("db-account-qr-retry").click();
    await sleep(400);
    out.accountQrRetryRestarts =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length ===
      startsBeforeRetry + 1;
    out.accountQrRetryHintBackToScan =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("扫码") >= 0;
    window.__qrFail = false;
    byTestId("db-account-qr-cancel").click();
    await sleep(300);
    out.accountQrCancelClearsPanel = !byTestId("db-account-qr") && !!byTestId("db-account-add");

    // 切换：非当前账号**整行可点**即 account_switch（item 5；「切换」按钮已删），
    // 界面重拉会话并把「当前」标记挪过去；切换后按新身份重铺（item 4 的切号隔离）。
    var roomsListBeforeSwitch =
      calls.filter(function (c) { return c === "rooms_list"; }).length;
    var followBeforeSwitch = window.__followCalls;
    var rowSwitchable = rowsAfterAdd[0];
    out.accountRowSwitchableSemantics = !!rowSwitchable &&
      rowSwitchable.getAttribute("role") === "button" &&
      rowSwitchable.getAttribute("tabindex") === "0" &&
      (rowSwitchable.getAttribute("aria-label") || "").indexOf("切到") >= 0;
    rowSwitchable.click();
    await sleep(600);
    var switchCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchCalled = switchCalls.length === 1 && switchCalls[0].args.name === "default";
    var rowsAfterSwitch = allByTestId("db-account-row");
    out.accountCurrentMarkMoved = rowsAfterSwitch[0].innerText.indexOf("已登录 · 当前") >= 0 &&
      rowsAfterSwitch[1].innerText.indexOf("已登录 · 当前") < 0;
    out.accountIdentityAfterSwitch = byTestId("db-account-name").innerText.indexOf("本地测试") >= 0;
    // item 4 切号隔离：上一个身份的视角不许留下 —— 界面回到房间列表页、rooms_list 与
    // follow_list 都按新身份重拉（房间列表 / 关注列表 / 房内身份 / 房管三块 / 表情库先清后铺）。
    out.accountSwitchBackToList = !!byTestId("db-list-page") && !byTestId("db-room-tabs");
    out.accountSwitchRelistsRooms =
      calls.filter(function (c) { return c === "rooms_list"; }).length > roomsListBeforeSwitch;
    out.accountSwitchRelistsFollowed = window.__followCalls > followBeforeSwitch;
    // 键盘与鼠标等价（item 5）：Enter 换到另一个账号，再用 Space 换回来 —— 两次都走真实键事件
    rowsAfterSwitch[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(600);
    var switchCallsAfterEnter = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchByEnter = switchCallsAfterEnter.length === 2 &&
      switchCallsAfterEnter[1].args.name === "扫码新用户";
    rowsAfterSwitch[0].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await sleep(600);
    var switchCallsAfterSpace = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchBySpace = switchCallsAfterSpace.length === 3 &&
      switchCallsAfterSpace[2].args.name === "default";
    // 切回来（鼠标这一条路径），让「删除当前账号」这一步删的确实是当前那一个
    rowsAfterSwitch[1].click();
    await sleep(600);
    var switchCallsFinal = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchFinal = switchCallsFinal.length === 4 &&
      switchCallsFinal[3].args.name === "扫码新用户";
    out.accountCurrentIsScanUserAgain = byTestId("db-account-name").innerText.indexOf("扫码新用户") >= 0;

    // 重新登录 = 覆盖路径：先二次确认，且文案写清覆盖谁的凭据（原账号就是这样被顶掉的）
    var rowsNow = allByTestId("db-account-row");
    var startsBefore = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    var switchesBeforeRescan =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length;
    buttonWith(rowsNow[0], "重新登录").click();
    await sleep(250);
    var overwriteConfirm = byTestId("db-account-confirm");
    out.accountRescanNeedsConfirm = !!overwriteConfirm &&
      overwriteConfirm.innerText.indexOf("覆盖") >= 0 &&
      overwriteConfirm.innerText.indexOf("default") >= 0;
    out.accountRescanNotStartedBeforeConfirm =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length === startsBefore;
    // item 5 的另一半：行**内**的动作按钮不冒泡到行 —— 点「重新登录」不该顺带切号
    out.accountRowActionDoesNotSwitch =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length ===
        switchesBeforeRescan;
    buttonWith(overwriteConfirm, "取消").click();
    await sleep(200);
    out.accountRescanConfirmDismissed = !byTestId("db-account-confirm");

    // 删除当前账号：二次确认 → 后端删掉后自动切到剩下的那个
    buttonWith(rowsNow[1], "删除").click();
    await sleep(250);
    var delConfirm = byTestId("db-account-confirm");
    out.accountRemoveConfirmShown = !!delConfirm &&
      delConfirm.innerText.indexOf("不可恢复") >= 0 &&
      delConfirm.innerText.indexOf("扫码新用户") >= 0;
    buttonWith(delConfirm, "确认删除").click();
    await sleep(700);
    var delCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_remove"; });
    out.accountRemoveCalledWithCurrent = delCalls.length === 1 &&
      delCalls[0].args.name === "扫码新用户";
    var rowsAfterRemove = allByTestId("db-account-row");
    out.accountRemoveFallsBackToOther = rowsAfterRemove.length === 1 &&
      rowsAfterRemove[0].innerText.indexOf("本地测试") >= 0 &&
      rowsAfterRemove[0].innerText.indexOf("已登录 · 当前") >= 0;
    var leftRemoveBtn = rowsAfterRemove.length === 1 ? buttonWith(rowsAfterRemove[0], "删除") : null;
    out.accountRemoveDisabledWithOneLeft = !!leftRemoveBtn && leftRemoveBtn.disabled;

    // 退出登录 = 清凭据、退回游客态（账号条目保留）
    buttonWith(rowsAfterRemove[0], "退出登录").click();
    await sleep(250);
    var logoutConfirm = byTestId("db-account-confirm");
    out.accountLogoutConfirmExplains = !!logoutConfirm &&
      logoutConfirm.innerText.indexOf("游客态") >= 0 &&
      logoutConfirm.innerText.indexOf("本地测试") >= 0;
    buttonWith(logoutConfirm, "确认退出登录").click();
    await sleep(700);
    out.accountLogoutCalled = calls.indexOf("account_logout") >= 0;
    out.accountRowShowsNotLoggedIn =
      (byTestId("db-account-row-status") || { innerText: "" }).innerText.trim() === "未登录";
    // 关闭路径仍是 Esc（对话框里那枚「关闭」按钮已随 item 2 删除）
    pressEscape();
    await sleep(400);
    out.accountBackToGuest = !!byTestId("db-account-guest") && !byTestId("db-account-dialog");
    out.accountGuestTextShown = (byTestId("db-account-guest") || { innerText: "" })
      .innerText.indexOf("游客态") >= 0;
    // 游客态那一行**同样可点**（issue #8：那时它的作用就是去登录）—— 键盘 Enter 一样开对话框
    var guestRow = byTestId("db-account");
    out.accountGuestRowIsEntry = !!guestRow &&
      guestRow.getAttribute("role") === "button" &&
      guestRow.getAttribute("tabindex") === "0" &&
      (guestRow.getAttribute("aria-label") || "").indexOf("账号管理") >= 0;
    pressKey(guestRow, "Enter");
    await sleep(400);
    out.accountGuestRowOpensDialog = !!byTestId("db-account-dialog");
    var guestBackdropClicked = clickDialogBackdrop(byTestId("db-account-dialog"));
    await sleep(300);
    out.accountGuestDialogCloses = guestBackdropClicked && !byTestId("db-account-dialog");

