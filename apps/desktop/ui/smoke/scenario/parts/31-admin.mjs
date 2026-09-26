// 场景块：房管
//   admin 权限前置、写操作二次确认与请求形状、三块名单预载与 tab 轨道（roving tabindex）
//   单点动作走行右键菜单、批量一次确认按序执行、上游 code + message 原样展示、身份被撤销后面板自动收起
//   面板第 1 排 / 批量第 2 排的贴顶几何；panels 五面板互斥（房管 / 表情 / 短语 / 筛选 / 独立礼物栏）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- admin 房管（issue #3）：权限前置、写操作二次确认、面板三块与错误原样展示
    // 整段包一层（同 tabs / immersive 段的手法：try/catch + xxxBlockRan）—— 这一段里有 5 处
    // **裸取** byTestId("db-header-more").click()、db-admin-close 之类的常规动作，「进房间点 ⋯」
    // 的前置状态一旦被谁弄坏（历史教训：沉浸态泄漏时房间头整个不在 DOM 里），裸取就是未捕获异常，
    // 场景当场死掉、跑脚本那一头只看到「场景未跑完（超时）」。包起来之后这一段最多红一片，
    // 后面的段落照跑。缩进保持原样不动：这一段的注释与断言排布本来就按「段」读，
    // 为了多一层缩进把 500 行重排一遍，只会把这次的改动淹在空白差异里。
    var adminBlockRan = false;
    try {
    out.adminIdentityFetched = calls.indexOf("room_session") >= 0;
    // **预载**（issue #4/第 5 条：连接上就有房管权限的房间时把数据加载好）：身份就绪之后
    // **不打开面板**也已经拉过三块名单 —— 数 IPC 调用即可（一次都没有 = 打开面板才拉，慢半拍）。
    var adminListCallCounts = function (cmd) {
      return calls.filter(function (c) { return c === cmd; }).length;
    };
    out.adminPreloadCalls = [
      adminListCallCounts("admin_silent_list"),
      adminListCallCounts("admin_blacklist_list"),
      adminListCallCounts("admin_keywords_list")
    ];
    out.adminPreloadedBeforeOpen = out.adminPreloadCalls.every(function (n) { return n >= 1; });
    // **反面对照**（item 3）：先把身份发成 is_admin:false，⋯ 菜单里就不该再有「房管面板」这一项 ——
    // 口径是「有房管身份才有房管界面的选项」，不是置灰让人点开再看上游报错
    // （旧的 adminReadOnlyPanelStillOpen 已删）。身份按契约 §5 的 RoomSession 全量给
    // （含 item 12 的 danmaku_length，少了它界面会按缺省 20 回落）。
    window.__setAdmin(false);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
      my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(300);
    byTestId("db-header-more").click();
    await sleep(250);
    out.adminPanelMenuItemHiddenWithoutPermission =
      !buttonWith(byTestId("db-context-menu"), "房管面板");
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    // 恢复房管身份再往下走
    window.__setAdmin(true);
    window.__setAdminFail(false);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
      my_guard_level: 0, danmaku_length: 40, is_admin: true
    });
    await sleep(300);
    var adminTarget = await emitOtherRow("房管目标样本");
    adminTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(250);
    var adminMenu = byTestId("db-context-menu");
    var adminLabels = ["禁言…", "拉黑", "解除禁言"];
    var adminItemsOf = function (menu) {
      return menu ? [].slice.call(menu.querySelectorAll("button")).filter(function (b) {
        return adminLabels.indexOf(b.innerText.trim()) >= 0;
      }) : [];
    };
    var adminItems = adminItemsOf(adminMenu);
    out.adminMenuItemsShown = adminItems.length === 3;
    out.adminMenuItemsEnabledAsAdmin = adminItems.length === 3 && adminItems.every(function (b) { return !b.disabled; });
    // 禁言必须选时长：确认条上给出对象与时长，默认「本场直播」
    buttonWith(adminMenu, "禁言…").click();
    await sleep(300);
    var muteConfirm = byTestId("db-admin-confirm");
    out.adminMuteConfirmShown = !!muteConfirm;
    // 确认文案必须说清**对象**：目标行的昵称要出现在确认条里（不能只写「确认禁言？」）。
    var targetNameEl = adminTarget ? adminTarget.querySelector('[data-testid="db-msg-name"]') : null;
    var targetNick = targetNameEl ? targetNameEl.innerText.replace(/:$/, "") : "";
    out.adminMuteTargetNick = targetNick;
    out.adminMuteConfirmNamesTarget = !!muteConfirm && targetNick.length > 0 &&
      muteConfirm.innerText.indexOf(targetNick) >= 0;
    var hourSelect = muteConfirm ? muteConfirm.querySelector("select") : null;
    // 时长默认「本场直播」（hour = 0），选「1 小时」后选择器与请求都要跟上。
    // 注意别拿确认条的 innerText 找时长文案——select 的选项文本本来就在 innerText 里，那会平凡成立。
    out.adminMuteDefaultHour = hourSelect ? hourSelect.value : null;
    out.adminMuteDefaultHourIsCurrentSession = !!hourSelect && hourSelect.value === "0";
    // 停一下让跑脚本的进程抓一张「确认条」的截图（对象 + 时长都在上面）
    snap();
    await sleep(1200);
    if (hourSelect) {
      hourSelect.value = "1";
      hourSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(200);
    }
    out.adminMuteHourSelected = !!byTestId("db-admin-confirm") &&
      byTestId("db-admin-confirm").querySelector("select").value === "1";
    buttonWith(byTestId("db-admin-confirm"), "确认禁言").click();
    await sleep(600);
    var mutes = callsWithArgs.filter(function (c) { return c.cmd === "admin_mute"; });
    var lastMute = mutes[mutes.length - 1];
    // 请求形状：房间号 + 目标 uid + 选中的时长（-1 永久 / 0 本场 / 其余小时）
    out.adminMuteRequestShape = !!lastMute && lastMute.args.roomId === 5440 &&
      lastMute.args.hour === 1 && typeof lastMute.args.uid === "number" && lastMute.args.uid > 0;
    out.adminConfirmClosedAfterWrite = !byTestId("db-admin-confirm");

    // 面板：三块名单收成**三个 tab**（issue #1）——一次只渲染当前那一块。
    // tab 文案**只有名单名**（旧的「禁言（1）」计数已随 item 3 删掉，计数改由
    // adminPanelItemCounts 逐块量行数）。
    // 单点动作在**行右键菜单**里、批量在批量条上（issue #4）；「增删」照旧先二次确认。
    byTestId("db-header-more").click();
    await sleep(250);
    var headerMenu2 = byTestId("db-context-menu");
    out.adminPanelMenuItemShown = !!buttonWith(headerMenu2, "房管面板");
    buttonWith(headerMenu2, "房管面板").click();
    await sleep(600);
    var adminPanel = byTestId("db-admin-panel");
    out.adminPanelShown = !!adminPanel;
    // 面板里**没有**「刷新」按钮、也**没有**「你是本直播间房管」那句提示（issue #5：入口只对房管
    // 存在，面板里再说一遍身份是废话；手动重试入口随之取消，读取失败靠错误条说话），关闭入口仍在。
    out.adminPanelNoRefreshButton = !!adminPanel && !buttonWith(adminPanel, "刷新");
    out.adminPanelNoIdentityHint = !!adminPanel &&
      adminPanel.innerText.indexOf("你是本直播间房管") < 0;
    out.adminPanelClosable = !!byTestId("db-admin-close");
    // 逐 tab 的取数口径：tab 的 [data-kind] 与行级 testid 一一对应
    var ADMIN_KINDS = ["silent", "blacklist", "keywords"];
    var adminRowTestId = function (adminKind) {
      return adminKind === "silent" ? "db-admin-silent-item"
        : adminKind === "blacklist" ? "db-admin-blacklist-item" : "db-admin-keyword-item";
    };
    var adminTabEls = function () { return allByTestId("db-admin-tab"); };
    var adminTabOf = function (adminKind) {
      return adminTabEls().filter(function (b) {
        return b.getAttribute("data-kind") === adminKind;
      })[0];
    };
    var adminSelectedTab = function () {
      return adminTabEls().filter(function (b) {
        return b.getAttribute("aria-selected") === "true";
      })[0];
    };
    var adminSelectedKind = function () {
      var el = adminSelectedTab();
      return el ? el.getAttribute("data-kind") : null;
    };
    // 别跟上面那个「数右键菜单项」的 adminItemsOf 混了：这里数的是当前 tab 的行。
    var adminListItemsOf = function (adminKind) {
      return allByTestId(adminRowTestId(adminKind)).length;
    };
    // ---- item 4：关闭入口是**图标钮**（tab 行右侧只剩它一枚）
    //      —— X 号没有文字，可访问名走 aria-label / title，盒子是控件族的 40 × 40 正圆。
    var adminCloseBtn = byTestId("db-admin-close");
    out.adminCloseIsIconButton = !!adminCloseBtn &&
      adminCloseBtn.innerText.trim() === "" &&
      (adminCloseBtn.getAttribute("aria-label") || "").length > 0 &&
      (adminCloseBtn.getAttribute("title") || "").length > 0 &&
      !!adminCloseBtn.querySelector("svg");
    var adminCloseBox = adminCloseBtn ? rect(adminCloseBtn) : null;
    out.adminCloseIsRound40 = !!adminCloseBox && !!circleOf(adminCloseBtn) &&
      Math.abs(adminCloseBox.width - 40) < 1 && Math.abs(adminCloseBox.height - 40) < 1 &&
      circleOf(adminCloseBtn).round;
    // tab 行（面板的第一行）= tab 轨道 + 右侧的关闭钮；轨道之外**只有关闭这一枚**按钮，
    // 批量图标钮搬到了第 1 排（item 5），因此它**不在**轨道内。
    var adminRail = byTestId("db-admin-tabs");
    var adminHeadRow = adminPanel ? adminPanel.firstElementChild : null;
    var adminHeadOthers = adminHeadRow
      ? [].slice.call(adminHeadRow.querySelectorAll("button")).filter(function (b) {
          return !adminRail || !adminRail.contains(b);
        })
      : [];
    out.adminTabRowOnlyClose = !!adminRail && !!adminHeadRow && adminHeadRow.contains(adminRail) &&
      adminHeadOthers.length === 1 && adminHeadOthers[0] === adminCloseBtn &&
      !adminRail.contains(byTestId("db-admin-batch"));
    // ---- item 5：两排都**贴顶**（第 1 排 = 输入框 + 主操作 + 批量图标钮；批量模式下第 2 排
    //      紧贴第 1 排下方），名单芯片在第 1 排之下 —— 非批量模式下先量这一档。
    var adminFormRow = adminPanel ? adminPanel.querySelector("input") : null;
    adminFormRow = adminFormRow ? adminFormRow.parentElement : null;
    var adminFormInput = adminFormRow ? adminFormRow.querySelector("input") : null;
    var adminFormPrimary = adminFormRow
      ? [].slice.call(adminFormRow.querySelectorAll("button")).filter(function (b) {
          return b.getAttribute("data-testid") !== "db-admin-batch";
        })[0]
      : null;
    var adminFormBatch = byTestId("db-admin-batch");
    var adminCurrentFirstItem = adminSelectedKind()
      ? allByTestId(adminRowTestId(adminSelectedKind()))[0] : null;
    var sameRowAs = function (a, b) {
      return !!a && !!b && Math.abs(centerY(a) - centerY(b)) < 2;
    };
    var adminTabPanelEl = byTestId("db-admin-tabpanel");
    out.adminFormRowAboveList = !!adminFormInput && !!adminFormPrimary &&
      !!adminFormBatch && !!adminCurrentFirstItem &&
      !!adminTabPanelEl && adminTabPanelEl.firstElementChild === adminFormRow &&
      rect(adminFormInput).top < rect(adminCurrentFirstItem).top &&
      sameRowAs(adminFormInput, adminFormPrimary) &&
      sameRowAs(adminFormInput, adminFormBatch) &&
      sameRowAs(adminFormPrimary, adminFormBatch);
    // 两排都是**横向一排**（不换行）：flex-wrap 的计算值就是 nowrap
    out.adminFormRowNoWrap = !!adminFormRow &&
      getComputedStyle(adminFormRow).flexWrap === "nowrap";
    // ---- item 4：批量图标钮（第 1 排末尾）—— 同样是图标钮，aria-pressed 说明它是**模式**；
    //      打开态从透明底换成强调色填充（与工具行的选中态同一套语言）。
    var adminBatchBgOff = adminFormBatch
      ? getComputedStyle(adminFormBatch).backgroundColor : null;
    out.adminBatchIsIconButton = !!adminFormBatch &&
      adminFormBatch.innerText.trim() === "" &&
      !!adminFormBatch.querySelector("svg") &&
      (adminFormBatch.getAttribute("aria-label") || "").length > 0 &&
      (adminFormBatch.getAttribute("title") || "").length > 0 &&
      adminFormBatch.getAttribute("aria-pressed") === "false";
    out.adminBatchOffIsTransparent = adminBatchBgOff === "rgba(0, 0, 0, 0)" ||
      adminBatchBgOff === "transparent";
    // 走一遍三个 tab：切过去之后**只有这一块**的列表在 DOM 里（行数由 adminPanelItemCounts 记账）
    var adminWalk = async function () {
      var seen = {};
      for (var wi = 0; wi < ADMIN_KINDS.length; wi += 1) {
        var walkKind = ADMIN_KINDS[wi];
        if (adminTabOf(walkKind)) adminTabOf(walkKind).click();
        await sleep(280);
        seen[walkKind] = {
          selected: adminSelectedKind() === walkKind,
          others: ADMIN_KINDS.reduce(function (sum, k) {
            return k === walkKind ? sum : sum + adminListItemsOf(k);
          }, 0),
          items: adminListItemsOf(walkKind)
        };
      }
      return seen;
    };
    var adminKindsShown = adminTabEls().map(function (b) { return b.getAttribute("data-kind"); });
    out.adminTabKinds = adminKindsShown;
    out.adminTabThreeKinds = adminKindsShown.join(",") === ADMIN_KINDS.join(",");
    out.adminTabSinglePanel = allByTestId("db-admin-tabpanel").length === 1;
    out.adminTabDefaultSilent = adminSelectedKind() === "silent";
    // roving tabindex：只有选中的那一枚可 Tab 到（其余 -1），role / aria-selected / aria-controls 都在
    out.adminTabRoving = adminTabEls().length === ADMIN_KINDS.length &&
      adminTabEls().every(function (b) {
        var on = b.getAttribute("aria-selected") === "true";
        return b.getAttribute("role") === "tab" &&
          b.getAttribute("tabindex") === (on ? "0" : "-1");
      }) && !!adminSelectedTab();
    var adminTabPanel = byTestId("db-admin-tabpanel");
    out.adminTabPanelLinked = !!adminTabPanel && !!adminSelectedTab() &&
      adminTabPanel.getAttribute("aria-labelledby") === adminSelectedTab().id &&
      adminTabEls().every(function (b) {
        return b.getAttribute("aria-controls") === adminTabPanel.id;
      });
    out.adminPanelSections = adminTabEls().map(function (b) { return b.innerText.trim(); });
    var adminWalked = await adminWalk();
    out.adminPanelListsRendered = ADMIN_KINDS.every(function (k) {
      return adminWalked[k].selected && adminWalked[k].others === 0;
    });
    out.adminPanelItemCounts = {
      silent: adminWalked.silent.items,
      blacklist: adminWalked.blacklist.items,
      keywords: adminWalked.keywords.items
    };
    // tab 文案就是**名单名**（item 3：计数已从 tab 上删掉 —— 旧断言拿「（N）」当分母，
    // 现在恒为 null，因此改成直接钉文案；行数由上面 adminPanelItemCounts 逐块记账）
    out.adminPanelTabLabels = out.adminPanelSections.join(",") === "禁言,黑名单,屏蔽词";
    // 键盘：←→ 换 tab、Home / End 跳首尾，焦点跟着选中项走（WAI-ARIA tabs 口径）。
    // 键事件派发在**已聚焦的那一枚 tab** 上，轨道自身的 keydown 因此收到它 —— 与真实按键同一条路径。
    // ⚠ 先**点回「禁言」**把起点定下来：轨道上的方向键是**相对当前选中的那一枚**算的
    //   （current = TAB_ORDER.indexOf(tab)），而上面那次 adminWalk() 巡完三个 tab 之后
    //   停在「屏蔽词」上。不点回起点的话，第一步「在禁言上按 →」实际是在**屏蔽词**上按 →
    //   走到「禁言」（0 的下一个），于是 adminTabKeyboardFollows 恒为假 ——
    //   实测（9-15 两引擎 × 四档全红）每一步的现场都记在 adminTabKeyboardSteps 里：
    //   第一步 expected=blacklist 而 selected=silent、焦点也还在 silent 上，正是「起点不对」。
    if (adminTabOf("silent")) adminTabOf("silent").click();
    await sleep(280);
    var adminKeySteps = [];
    var adminKeyStep = async function (fromKind, key, expectKind) {
      var fromEl = adminTabOf(fromKind);
      if (!fromEl) return false;
      pressKey(fromEl, key);
      await sleep(280);
      // 每一步的现场都记账：只看最后那个布尔，失败时分不清是「选中项没跟着走」还是
      // 「选中了但焦点没挪过去」（两者的修法完全不同）。
      var focused = document.activeElement;
      var step = {
        key: key,
        from: fromKind,
        expect: expectKind,
        selected: adminSelectedKind(),
        focusKind: focused && focused.getAttribute
          ? focused.getAttribute("data-kind") : null,
        focusTestId: focused && focused.getAttribute
          ? focused.getAttribute("data-testid") : null,
        focusTag: focused ? focused.tagName : null,
      };
      adminKeySteps.push(step);
      return step.selected === expectKind && step.focusKind === expectKind;
    };
    var adminKeyOk = await adminKeyStep("silent", "ArrowRight", "blacklist");
    adminKeyOk = (await adminKeyStep("blacklist", "ArrowLeft", "silent")) && adminKeyOk;
    adminKeyOk = (await adminKeyStep("silent", "End", "keywords")) && adminKeyOk;
    adminKeyOk = (await adminKeyStep("keywords", "Home", "silent")) && adminKeyOk;
    out.adminTabKeyboardFollows = adminKeyOk;
    out.adminTabKeyboardSteps = adminKeySteps;
    // 房管面板是最高的一个（窄屏撞 45vh 上限），它展开时最能暴露「跟随被悄悄关掉」：
    // 修复前这里实测离底 398px，最新一条落在面板下方 318px 处。
    out.layoutAdminBottomGap = bottomGap(byTestId("db-chat-scroll"));
    out.layoutAdminFollowing = out.layoutAdminBottomGap < 8;
    out.layoutNoJumpButtonWithAdminPanel = !byTestId("db-bottom-anchor");
    // 窄屏：房管面板同样是文档流里的一块（只挤列表、不遮最新一条），限高 + 内部滚动 + 关闭入口 + 热区 ≥ 40px
    if (NARROW) {
      var adminPanelRect = rect(adminPanel);
      var adminPanelNewest = rows()[rows().length - 1];
      put("adminPanelInFlow", getComputedStyle(adminPanel).position !== "fixed");
      put("adminPanelScrollable", getComputedStyle(adminPanel).overflowY === "auto");
      put("adminPanelHeightPx", Math.round(adminPanelRect.height));
      put("adminPanelCappedToViewportShare", adminPanelRect.height <= window.innerHeight * 0.5 + 1);
      put("adminPanelNewestNotCovered", !!adminPanelNewest &&
        rect(adminPanelNewest).bottom <= adminPanelRect.top + 1);
      put("adminPanelClosable", !!byTestId("db-admin-close"));
      // item 5：360 宽下面板**不许**横向溢出（两排都是 nowrap 的横向一排，输入框是唯一可缩的一项）
      put("adminPanelNoHorizontalOverflow", adminPanel.scrollWidth <= adminPanel.clientWidth + 1);
      var adminHotspots = shortHotspots(adminPanel);
      put("adminPanelHotspotsBad", adminHotspots);
      put("adminPanelHotspotsAtLeast40", adminHotspots.length === 0);
    }
    // 停一下让跑脚本的进程抓一张「房管面板三块」的截图
    snap();
    await sleep(1200);
    // ---- 五面板互斥（issue #4）：房管面板 / 表情 / 短语 / 筛选 / 独立礼物栏**同时最多开一个**。
    //      开一个 → 其余四个同步都关；收起某一个不影响别人（panelSurvivesTabSwitch 那三条照旧成立）。
    //      礼物栏这一档要先存在它：它由 ui.gift_panel 决定，默认就是开的（上面 gift 那段
    //      最后把两枚开关都还原成默认值，礼物栏因此折叠着在场）。
    var openPanelCount = function () {
      return (byTestId("db-panel") ? 1 : 0) + (byTestId("db-admin-panel") ? 1 : 0) +
        (byTestId("db-gift-area") ? 1 : 0);
    };
    // 房管面板的开/关都只有一条路：⋯ 菜单里那一项（面板内没有开关自己的按钮）
    var toggleAdminFromHeader = async function () {
      byTestId("db-header-more").click();
      await sleep(250);
      var item = buttonWith(byTestId("db-context-menu"), "房管面板");
      if (item) item.click();
      await sleep(700);
    };
    out.panelExclusiveStart = openPanelCount() === 1 && !!byTestId("db-admin-panel");
    clickTool("表情");
    await sleep(450);
    out.panelExclusiveEmoteClosesAdmin = !!byTestId("db-panel") &&
      !byTestId("db-admin-panel") && !byTestId("db-gift-area") && openPanelCount() === 1;
    clickTool("短语");
    await sleep(350);
    out.panelExclusivePhraseReplacesEmote = allByTestId("db-panel").length === 1 &&
      !!byTestId("db-phrase-add") && openPanelCount() === 1;
    clickTool("筛选");
    await sleep(350);
    out.panelExclusiveFilterReplacesPhrase = allByTestId("db-panel").length === 1 &&
      !byTestId("db-phrase-add") && openPanelCount() === 1;
    // db-gift-total 是礼物栏的总计条（data-pane-head，折叠态唯一一行），它本身不是按钮；
    // 展开 / 收起入口是它右端的 db-gift-toggle，点它即开礼物栏（与房管面板互斥）。
    var exclusiveGiftToggle = byTestId("db-gift-toggle");
    if (exclusiveGiftToggle) exclusiveGiftToggle.click();
    await sleep(450);
    out.panelExclusiveGiftDockClosesPanel = !!byTestId("db-gift-area") &&
      !byTestId("db-panel") && !byTestId("db-admin-panel") && openPanelCount() === 1;
    await toggleAdminFromHeader();
    out.panelExclusiveAdminClosesGiftDock = !!byTestId("db-admin-panel") &&
      !byTestId("db-panel") && !byTestId("db-gift-area") && openPanelCount() === 1;

    // ---- 上游拒绝**原样展示**（code + message）：三块各自留痕、互不清空，面板留在原地。
    //      这一档必须在**有权限**时测 —— 入口只对房管存在，身份被撤销时面板会直接收起（见下）。
    //      issue #5 之后面板里**没有**手动重试入口：重拉 = 关掉再开（⋯ →「房管面板」），
    //      所以下面这条路径本身就是「重拉」这条路的验收面。
    var reopenAdmin = async function () {
      if (byTestId("db-admin-close")) byTestId("db-admin-close").click();
      await sleep(300);
      await toggleAdminFromHeader();
    };
    window.__setAdminFail(true);
    await reopenAdmin();
    out.adminReopenRefetches = adminListCallCounts("admin_blacklist_list") >= 2;
    var adminErrCount = {};
    var adminErrRaw = {};
    for (var ae = 0; ae < ADMIN_KINDS.length; ae += 1) {
      var errKind = ADMIN_KINDS[ae];
      if (adminTabOf(errKind)) adminTabOf(errKind).click();
      await sleep(300);
      var errText = (byTestId("db-admin-tabpanel") || { innerText: "" }).innerText;
      adminErrRaw[errKind] = errText.indexOf("不是管理员") >= 0 &&
        errText.indexOf("UPSTREAM_ERROR") >= 0;
      adminErrCount[errKind] = allByTestId("db-admin-error").length;
    }
    out.adminPanelErrorRaw = ADMIN_KINDS.every(function (k) { return adminErrRaw[k]; });
    out.adminPanelErrorCount = adminErrCount;
    // 三块各自留痕、互不清空 —— 但**任一时刻只有当前 tab 那一条**在 DOM 里（切三个 tab 各看一次）
    out.adminPanelErrorsIndependent = ADMIN_KINDS.every(function (k) {
      return adminErrCount[k] === 1;
    });
    // 上游恢复之后「关掉再开」能把三块读回来、错误条随之消失
    window.__setAdminFail(false);
    await reopenAdmin();
    out.adminPanelErrorClearedAfterRetry = allByTestId("db-admin-error").length === 0;
    var adminAfterRetry = await adminWalk();
    out.adminPanelListsAfterRetry = {
      silent: adminAfterRetry.silent.items,
      blacklist: adminAfterRetry.blacklist.items,
      keywords: adminAfterRetry.keywords.items
    };
    // ---- 单点动作：行的**右键菜单**（issue #4；行内那枚「删除」按钮已删），一次确认后执行
    if (adminTabOf("keywords")) adminTabOf("keywords").click();
    await sleep(300);
    var adminKeywordRow = allByTestId(adminRowTestId("keywords"))[0];
    out.adminRowHasNoInlineAction = !!adminKeywordRow &&
      adminKeywordRow.querySelector("button") === null;
    if (adminKeywordRow) openRowMenu(adminKeywordRow);
    await sleep(250);
    var adminRowMenu = byTestId("db-context-menu");
    var adminRowDelBtn = adminRowMenu ? buttonWith(adminRowMenu, "删除") : null;
    out.adminRowMenuShown = !!adminRowDelBtn;
    if (adminRowDelBtn) adminRowDelBtn.click();
    await sleep(300);
    var wordConfirm = byTestId("db-admin-confirm");
    out.adminKeywordConfirmShown = !!wordConfirm && wordConfirm.innerText.indexOf("刷屏") >= 0;
    if (wordConfirm) buttonWith(wordConfirm, "确认删除").click();
    await sleep(600);
    var wordDels = callsWithArgs.filter(function (c) { return c.cmd === "admin_keywords_del"; });
    var lastWordDel = wordDels[wordDels.length - 1];
    out.adminKeywordDelRequestShape = !!lastWordDel &&
      lastWordDel.args.roomId === 5440 && lastWordDel.args.word === "刷屏";

    // ---- 批量（issue #4）：打开后行前出现勾选框、上方有全选、底部升起当前 tab 的动作条；
    //      选中 N 项 → **一次**确认（文案含数量）→ 按序执行（N 次调用，顺序即屏幕顺序）。
    if (adminTabOf("keywords")) adminTabOf("keywords").click();
    await sleep(300);
    if (byTestId("db-admin-batch")) byTestId("db-admin-batch").click();
    await sleep(300);
    var batchToggle = byTestId("db-admin-batch");
    out.adminBatchControlsShown = !!batchToggle &&
      batchToggle.getAttribute("aria-pressed") === "true" &&
      !!byTestId("db-admin-select-all") && !!byTestId("db-admin-batch-bar") &&
      allByTestId("db-admin-select").length === adminListItemsOf("keywords");
    var adminBoxes = allByTestId("db-admin-select");
    adminBoxes.forEach(function (box) { box.click(); });
    await sleep(300);
    var batchBar = byTestId("db-admin-batch-bar");
    // ---- item 5 的第 2 排（批量模式才出现）：紧贴第 1 排**正下方**（间距 = 那一排自己的上外边距
    //      --sp-2 = 8px，不与名单的间距混淆）、仍在**第 1 条芯片之上**；行内三样（全选 /
    //      已选 N 项 / 批量动作）同一排不换行；第 1 排的主操作按钮没被这一排挤走。
    var batchFormRow = byTestId("db-admin-panel").querySelector("input").parentElement;
    var batchFormInput = batchFormRow.querySelector("input");
    var batchFormPrimary = [].slice.call(batchFormRow.querySelectorAll("button")).filter(function (b) {
      return b.getAttribute("data-testid") !== "db-admin-batch";
    })[0];
    var batchSelectAll = byTestId("db-admin-select-all");
    var batchFirstItem = allByTestId(adminRowTestId("keywords"))[0];
    var batchBarBox = batchBar ? rect(batchBar) : null;
    var batchGapPx = batchBarBox && batchFormRow
      ? Math.round((batchBarBox.top - rect(batchFormRow).bottom) * 10) / 10 : null;
    out.adminBatchBarGapPx = batchGapPx;
    out.adminBatchBarSecondRow = batchGapPx !== null && batchGapPx >= -0.5 && batchGapPx <= 12 &&
      !!batchFirstItem && batchBarBox.bottom <= rect(batchFirstItem).top + 1 &&
      sameRowAs(batchSelectAll, byTestId("db-admin-batch-action")) &&
      sameRowAs(batchFormPrimary, batchFormInput) &&
      rect(batchFormPrimary).top < batchBarBox.top;
    out.adminBatchBarNoWrap = !!batchBar && getComputedStyle(batchBar).flexWrap === "nowrap";
    // item 4：批量钮是**模式**开关 —— aria-pressed 翻成 true 的同时底色从透明换成强调色填充
    // （强调色的计算值就地取：选中 tab 的下边框色就是 var(--accent)，同一个令牌）
    var accentRef = adminSelectedTab() ? getComputedStyle(adminSelectedTab()).borderBottomColor : null;
    out.adminBatchOnIsAccentFill = !!accentRef && !!batchToggle && adminBatchBgOff !== null &&
      accentRef.indexOf("0, 0, 0, 0") < 0 &&
      getComputedStyle(batchToggle).backgroundColor === accentRef &&
      getComputedStyle(batchToggle).backgroundColor !== adminBatchBgOff;
    // item 12：批量开时第 2 排那两枚按钮也纳入 40px 热区体检（窄屏口径不变）
    if (NARROW) {
      var batchHotspots = shortHotspots(byTestId("db-admin-panel"));
      put("adminPanelHotspotsWithBatchBad", batchHotspots);
      put("adminPanelHotspotsWithBatchAtLeast40", batchHotspots.length === 0);
    }
    out.adminBatchBarShowsCount = !!batchBar && adminBoxes.length === 2 &&
      batchBar.innerText.indexOf("已选 " + adminBoxes.length + " 项") >= 0;
    var delsBeforeBatch = callsWithArgs.filter(function (c) {
      return c.cmd === "admin_keywords_del";
    }).length;
    var batchActionBtn = byTestId("db-admin-batch-action");
    if (batchActionBtn) batchActionBtn.click();
    await sleep(300);
    var batchConfirm = byTestId("db-admin-confirm");
    var delsAtConfirm = callsWithArgs.filter(function (c) {
      return c.cmd === "admin_keywords_del";
    }).length;
    out.adminBatchOneConfirmWithCount = !!batchConfirm &&
      batchConfirm.innerText.indexOf("2 项") >= 0 &&
      batchConfirm.innerText.indexOf("刷屏") >= 0 &&
      batchConfirm.innerText.indexOf("广告") >= 0 &&
      delsAtConfirm === delsBeforeBatch;
    if (batchConfirm) buttonWith(batchConfirm, "确认批量").click();
    await sleep(800);
    var batchDels = callsWithArgs.filter(function (c) { return c.cmd === "admin_keywords_del"; });
    out.adminBatchExecutesInOrder = batchDels.length === delsBeforeBatch + 2 &&
      batchDels[batchDels.length - 2].args.word === "刷屏" &&
      batchDels[batchDels.length - 1].args.word === "广告";

    // ---- 身份被撤销（item 3，契约 C6）：面板**自动收起**、入口随之从 ⋯ 菜单里消失；
    //      行右键那三项改成置灰并说明原因（它们是「权限前置」的另一半，仍照旧可判）。
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    window.__setAdmin(false);
    window.__setAdminFail(true);
    // 身份经 danmubox://session 事件送达（面板里已没有刷新按钮，所以撤销不再靠点它触发）
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
      my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(500);
    out.adminPanelClosedAfterRevoke = !byTestId("db-admin-panel");
    byTestId("db-header-more").click();
    await sleep(250);
    out.adminPanelMenuItemHiddenAfterRevoke =
      !buttonWith(byTestId("db-context-menu"), "房管面板");
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    adminTarget = await emitOtherRow("无权限目标样本");
    adminTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(300);
    var noPermItems = adminItemsOf(byTestId("db-context-menu"));
    out.adminMenuItemsDisabledWithoutPermission =
      noPermItems.length === 3 && noPermItems.every(function (b) { return b.disabled; });
    out.adminMenuHintExplainsWhy = noPermItems.length === 3 &&
      noPermItems.every(function (b) { return (b.title || "").indexOf("房管") >= 0; });
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.adminPanelStaysClosed = !byTestId("db-admin-panel");
    snap();
    adminBlockRan = true;
    } catch (e) {
      out.adminBlockError = String((e && e.stack) || e);
    }
    out.adminBlockRan = adminBlockRan;
    snap();

