// 场景块：列表页：关注列表与页头
//   step1 关注列表自动加载、列表页展示关注项
//   follow 未开播也列出（真实取样夹具：未开播项第 1 页可见且翻页到底一条不少）、排序、>30 条分页
//   两档排布（宽屏一排 / 窄屏两排）、房间卡与关注项都不显示房间号
//   主页左右边距对称、出现滚动条后右侧不往里回缩
//   theme 主题按钮在列表页页头（三档循环、图标矢量规范、深浅对比度达标）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // 视口：360×844（窄屏，取窗口最小宽度；竖屏是默认形态）与 1440×900（宽屏）各跑一遍。
    // 视口专属的断言只写进对应视口的快照（narrow_* / wide_*），
    // 否则「宽屏的面板在文档流里」这类口径会在窄屏那边假失败。
    var NARROW = window.innerWidth <= 520;
    out.viewport = NARROW ? "narrow" : "wide";
    var put = function (name, value) { out[(NARROW ? "narrow_" : "wide_") + name] = value; };
    // 触屏热区体检：sheet / 对话框里凡是可点的东西都必须 ≥ 40px。
    // 复选框与滑杆本身不撑高（会变形），它们的热区由各自的 label 承担，所以按 label 计。
    var shortHotspots = function (root) {
      var els = [].slice.call(root.querySelectorAll("button, select, label, input"));
      var bad = [];
      els.forEach(function (el) {
        if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "range")) return;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.height < 39.5) bad.push(el.tagName + "=" + Math.round(r.height) + "×" + Math.round(r.width));
      });
      return bad;
    };
    // ---- step1 关注列表自动加载 + 列表页展示关注项（语义不得改）
    await sleep(900);
    out.step1_followCalls = window.__followCalls;
    out.step1_roomListShowsFollowed = text().indexOf("在播主播") >= 0;
    // follow：未开播也列出、按最后开播时间排序、分页
    var followNames = allByTestId("db-follow-item").map(function (el) { return el.innerText.split("\n")[0]; });
    out.followOrder = followNames.slice(0, 3);
    out.followPage1Count = followNames.length;
    out.followPagerShown = !!document.querySelector('[class*="pager"]');
    // 夹具里真实取样的名字（全部 live_status != 1：取证当天那 70 条没人开播）。
    var fixtureNames = FOLLOW_FIXTURE_ROWS.map(function (row) { return row.uname; });
    var fixtureOfflineNames = FOLLOW_FIXTURE_ROWS
      .filter(function (row) { return row.live_status !== 1; })
      .map(function (row) { return row.uname; });
    out.followOfflineFixtureTotal = fixtureOfflineNames.length;
    var followHeaderEl = document.querySelector('[class*="followSection"] h2') ||
      document.querySelector('[class*="followHeader"] h2');
    out.followHeaderText = followHeaderEl ? followHeaderEl.innerText : "";
    // 列表头报出的总数 = 真实取样 70 + 自造 3：**一条都没被过滤掉**（第 1 页只画 30 条）。
    out.followHeaderCountsAll = out.followHeaderText.indexOf(
      "（" + (fixtureNames.length + 3) + "）") >= 0;
    // 关注项带出直播间标题（上游 title 字段）：非空的渲染出文本，空串的不渲染该元素
    // （不留空框、不用占位符）。
    var followItemNamed = function (name) {
      return allByTestId("db-follow-item").filter(function (el) {
        return el.innerText.indexOf(name) >= 0;
      })[0];
    };
    var liveFollowItem = followItemNamed("在播主播");
    var liveFollowTitle = liveFollowItem
      ? liveFollowItem.querySelector('[data-testid="db-follow-title"]')
      : null;
    out.step1_followTitleShown = !!liveFollowTitle &&
      liveFollowTitle.innerText.indexOf("在播中的直播间标题") >= 0;
    var emptyTitleItem = followItemNamed("离线甲");
    out.step1_followEmptyTitleHidden = !!emptyTitleItem &&
      !emptyTitleItem.querySelector('[data-testid="db-follow-title"]');

    // ---- 用户 2026-09-13：「关注但未开播的也一直没加载到主界面」。
    // 判据分两层，都用**真实取样**的条目：
    //   ① 第 1 页里必须真的有夹具里的未开播条目，并且**真的布了局**（有尺寸、没被藏掉）；
    //   ② 翻完所有页，夹具里的每一条未开播取样都必须出现过（谁都没在过滤 / 分页里掉队）。
    // 「可见」不写成「在视口内」：窄屏第 1 页的关注列表本来就在折线以下，滚过去才看得到
    // （截图那一步会滚），能判的是「布局出来了、不是被隐藏」。
    var offlineOnPage1 = followNames.filter(function (name) {
      return fixtureOfflineNames.indexOf(name) >= 0;
    });
    out.followOfflineOnPage1 = offlineOnPage1.length;
    out.followOfflineVisibleOnPage1 = offlineOnPage1.filter(function (name) {
      var el = followItemNamed(name);
      return !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 8;
    }).length;
    out.followNonLiveListed = offlineOnPage1.length > 0 && out.followOfflineVisibleOnPage1 > 0;
    put("followOfflineVisibleOnPage1", out.followOfflineVisibleOnPage1 > 0);

    // ---- #16 排序：直播中置顶 → **最近观看降序** → 最后开播时间降序。
    // 「最近观看」的样本换成了**真实取样**的那条（prefs 的 ui.recent_watched 指向夹具第 1 条）：
    // 它比离线甲后看过，因此必须排在最前——看过的那些按时间降序。
    var watchedFixtureName = FOLLOW_FIXTURE_ROWS[0].uname;
    out.followLivePinnedFirst = followNames.length > 0 && followNames[0] === "在播主播";
    out.followWatchedDesc =
      followNames.indexOf(watchedFixtureName) >= 0 &&
      followNames.indexOf(watchedFixtureName) < followNames.indexOf("离线甲");
    out.followWatchedBeforeUnwatched =
      followNames.indexOf("离线甲") >= 0 && followNames.indexOf("离线甲") < followNames.indexOf("离线乙");
    // 没看过的按「最后开播时间」降序：只有自造条目带 live_start_at（真实取样的未开播条目
    // 拿不到这个量——上游未开播时不给，见 A28），所以它们整体排在离线乙之后。
    var unwatchedFixtureName = followNames.filter(function (name) {
      return fixtureNames.indexOf(name) >= 0 && name !== watchedFixtureName;
    })[0] || "";
    out.followUnwatchedKeepsLiveStartOrder =
      followNames.indexOf("离线乙") >= 0 && !!unwatchedFixtureName &&
      followNames.indexOf("离线乙") < followNames.indexOf(unwatchedFixtureName);

    // ---- #14/#15 排布：宽屏一排（左 头像·主播名·直播标题 / 右 状态·最后开播时间），
    // 窄屏两排（第二排 左标题 / 右最后开播时间）；两档都不得出现房间号。
    var followPart = function (item, testid) {
      return item ? item.querySelector('[data-testid="' + testid + '"]') : null;
    };
    var centerY = function (el) {
      var r = rect(el);
      return (r.top + r.bottom) / 2;
    };
    var partsName = followPart(liveFollowItem, "db-follow-name");
    var partsStatus = followPart(liveFollowItem, "db-follow-status");
    var partsTime = followPart(liveFollowItem, "db-follow-last-live");
    out.followItemHasAllParts = !!(partsName && liveFollowTitle && partsStatus && partsTime);
    if (out.followItemHasAllParts) {
      if (NARROW) {
        // 窄屏：主播名与状态同一排；标题与最后开播时间在第二排，且标题在左、时间在右。
        put("followRow1NameWithStatus", Math.abs(centerY(partsName) - centerY(partsStatus)) < 6);
        put("followRow2TitleWithTime", Math.abs(centerY(liveFollowTitle) - centerY(partsTime)) < 6);
        put("followTitleOnSecondRow", rect(liveFollowTitle).top >= rect(partsName).bottom - 2);
        put("followRow2BelowStatus", rect(liveFollowTitle).top > rect(partsStatus).bottom - 2);
        put("followTitleLeftOfTime", rect(liveFollowTitle).left < rect(partsTime).left);
        // 第一排的状态与第二排的时间都贴右边缘（同一列、同一条右边界）
        put("followRowRightsAligned", Math.abs(rect(partsStatus).right - rect(partsTime).right) < 2);
        put("followStatusInRightHalf",
          rect(partsStatus).left > rect(liveFollowItem).left + rect(liveFollowItem).width / 2);
        // 标题与主播名同一起点（悬挂缩进）：不顶到头像下面，也不越到状态右边。
        put("followTitleAlignedWithName",
          Math.abs(rect(liveFollowTitle).left - rect(partsName).left) < 2);
      } else {
        // 宽屏：四项在同一排；标题在两簇之间（名字之后、状态之前），最后开播时间在最右。
        put("followSingleRow",
          Math.abs(centerY(partsName) - centerY(liveFollowTitle)) < 8 &&
          Math.abs(centerY(partsName) - centerY(partsStatus)) < 8 &&
          Math.abs(centerY(partsName) - centerY(partsTime)) < 8);
        put("followNameLeftOfTitle", rect(partsName).left < rect(liveFollowTitle).left);
        put("followTitleBeforeStatus", rect(liveFollowTitle).right <= rect(partsStatus).left + 1);
        put("followTimeAtRightEdge", rect(partsTime).right >= rect(partsStatus).right);
      }
    }
    // ---- 翻完所有页：夹具里的每一条未开播取样都必须出现过（谁都没在过滤 / 分页里掉队）。
    //      跑完翻回第 1 页：后面的排布断言与截图都按第 1 页来。
    var pagerButton = function (label) {
      var pager = document.querySelector('[class*="pager"]');
      if (!pager) return null;
      return [].slice.call(pager.querySelectorAll("button")).filter(function (b) {
        return b.innerText.indexOf(label) >= 0;
      })[0] || null;
    };
    var seenFollowNames = followNames.slice();
    var collectNames = function () {
      allByTestId("db-follow-item").forEach(function (el) {
        var name = el.innerText.split("\n")[0];
        if (seenFollowNames.indexOf(name) < 0) seenFollowNames.push(name);
      });
    };
    var forwardPages = 0;
    for (var step = 0; step < 8; step += 1) {
      var next = pagerButton("下一页");
      if (!next || next.disabled) break;
      next.click();
      await sleep(160);
      collectNames();
      forwardPages += 1;
    }
    var missingFollowed = fixtureOfflineNames.filter(function (name) {
      return seenFollowNames.indexOf(name) < 0;
    });
    out.followWindowPages = forwardPages;
    out.followOfflineSeen = fixtureOfflineNames.length - missingFollowed.length;
    out.followOfflineAllListed = missingFollowed.length === 0;
    out.followOfflineMissing = missingFollowed.slice(0, 3);
    for (var back = 0; back < 8; back += 1) {
      var prev = pagerButton("上一页");
      if (!prev || prev.disabled) break;
      prev.click();
      await sleep(140);
    }
    out.followBackOnFirstPage =
      allByTestId("db-follow-item").length === out.followPage1Count;
    // 翻页会重建关注项的 DOM 节点：后面还用 liveFollowItem / emptyTitleItem（房间号不得出现
    // 那条断言），必须重新取，否则是拿脱离文档的旧节点在判（innerText 为空 → 断言假绿）。
    liveFollowItem = followItemNamed("在播主播");
    emptyTitleItem = followItemNamed("离线甲");
    await sleep(200);

    // 房间号不得出现在关注项里（用户 #14/#15：两档都「不要房间号」）：
    // #100 是「有标题 + 直播中」那条，#300 是「无标题 + 未开播且看过」那条，两类都查。
    out.followItemHidesRoomNumber = !!liveFollowItem && !!emptyTitleItem &&
      liveFollowItem.innerText.indexOf("100") < 0 &&
      emptyTitleItem.innerText.indexOf("300") < 0;
    // 连接中的房间列表同样不报房间号（#17）：卡片报「主播名 · 直播间名」，
    // 且名字取的是**真实载荷**里的值（fixtureRoom，见文件头夹具说明）。
    // 这两条就是「不许出现占位词」的回归断言：解析路径写错时 anchor_uname 是空串，
    // 卡片会退成「未命名直播间」或「房间 5440」，两条都会失败。
    var roomCard = byTestId("db-room-card");
    out.roomCardShowsAnchorAndTitle = !!roomCard &&
      roomCard.innerText.indexOf(fixtureRoom.anchor_uname) >= 0 &&
      roomCard.innerText.indexOf(fixtureRoom.title) >= 0;
    out.roomCardHidesRoomNumber = !!roomCard && roomCard.innerText.indexOf("5440") < 0;
    out.roomCardHidesPlaceholder = !!roomCard &&
      roomCard.innerText.indexOf("未命名直播间") < 0;
    // 把卡片滚进画面并停一下：跑脚本的进程据此抓一张「连接中的房间列表」截图（#17）。
    // 下一段会把关注项滚到顶，那时卡片已不在画面里，所以这一步必须在它前面。
    if (roomCard && roomCard.scrollIntoView) {
      roomCard.scrollIntoView({ block: "start" });
    }
    out.roomsListRendered = !!roomCard;
    // ---- 主页左右边距对称（用户 2026-09-12：「主页好像没有居中？右边的边距好像稍微宽一些」）。
    //      根因：经典滚动条（index.css 把它定制成 10px）只吃内容盒的**右侧**，
    //      max-width + margin: 0 auto 的居中块因此右宽左窄正好一个滚动条宽
    //      （改前实测 4 档：宽屏 24 / 34，窄屏 16 / 26）。判据取「到内容的左右距离相等」（容差 1px），
    //      并**同时**要求容器真的在滚 —— 没有滚动条时这条断言会假绿。
    var listEl = byTestId("db-list-page");
    var listBox = rect(listEl);
    var listAnchorBox = rect(byTestId("db-account") || listEl.querySelector("h1"));
    out.listPageScrolls = listEl.scrollHeight > listEl.clientHeight + 1;
    out.listPageScrollbarPx = listEl.offsetWidth - listEl.clientWidth;
    out.listPageLeftGapPx = Math.round((listAnchorBox.left - listBox.left) * 10) / 10;
    out.listPageRightGapPx = Math.round((listBox.right - listAnchorBox.right) * 10) / 10;
    out.listPageMarginsSymmetric = out.listPageScrolls &&
      Math.abs(out.listPageLeftGapPx - out.listPageRightGapPx) <= 1;
    // ---- 「高度缩到出现滚动条之后，元素右侧往中间回缩」（用户 2026-09-12 的决定性复现）。
    //      判据：**同一个元素**的右缘 x 在「内容装得下（不出滚动条）」与「装不下（出滚动条）」
    //      两态下相等（容差 1px）。根因是 index.css 里那条自定义滚动条样式 —— 它把 macOS 的
    //      **覆盖式**滚动条（不占宽）换成**经典**滚动条（占宽），一出现就吃掉内容右侧一条；
    //      现已删除那些样式（同一个改动也把「窗口右边缘拖不动」一起解了）。
    var stableProbe = byTestId("db-account");
    var followRowsProbe = allByTestId("db-follow-item");
    var rightWhenScrolling = rect(stableProbe).right;
    var savedRowDisplay = followRowsProbe.map(function (el) { return el.style.display; });
    followRowsProbe.forEach(function (el) { el.style.display = "none"; });
    await sleep(300);
    var shortListEl = byTestId("db-list-page");
    out.listPageShortStateHasNoScrollbar = shortListEl.scrollHeight <= shortListEl.clientHeight + 1;
    var rightWhenShort = rect(stableProbe).right;
    followRowsProbe.forEach(function (el, index) { el.style.display = savedRowDisplay[index]; });
    await sleep(300);
    out.listPageRightEdgeDeltaPx = Math.round(Math.abs(rightWhenShort - rightWhenScrolling) * 10) / 10;
    out.listPageRightEdgeStable = out.listPageShortStateHasNoScrollbar &&
      out.listPageRightEdgeDeltaPx <= 1;
    snap();
    await sleep(900);

    // 让跑脚本的进程抓一张「关注列表排布」的截图（宽屏单排 / 窄屏两排各一张）。
    var firstFollowItem = byTestId("db-follow-item");
    if (firstFollowItem && firstFollowItem.scrollIntoView) {
      firstFollowItem.scrollIntoView({ block: "start" });
    }
    out.followListRendered = allByTestId("db-follow-item").length > 0;

    out.accountArea = !!byTestId("db-account");
    // 列表页的头像（账号区 / 关注项）尺寸必须由 CSS 给，不能落到「原图尺寸」：
    // 夹具是 512×512，一旦 var(--avatar) 解析不出来，头像会按 512 渲染、把主页顶爆
    // （用户 2026-09-12：「主页的内容都没了啊，只能看到一个头像的角落」）。
    var listAvatars = allByTestId("db-msg-avatar");
    out.listAvatarCount = listAvatars.length;
    out.listAvatarsSized = listAvatars.length >= 2 && listAvatars.every(function (el) {
      var r = rect(el);
      return r.width > 8 && r.width <= 40 && r.height > 8 && r.height <= 40;
    });
    // 失败时把「为什么」也带出来：--avatar 算成什么、img 实际渲染多大（那次主页被顶爆，
    // 就是这个字段把根因钉死的：--avatar 取不到值 → computed width 变成原图的 512px）。
    out.listAvatarBoxes = listAvatars.map(function (el) {
      var r = rect(el);
      var cs = getComputedStyle(el);
      return [Math.round(r.width), Math.round(r.height), cs.width, cs.height,
        cs.getPropertyValue("--avatar").trim() || "(未解析)"];
    });
    // 列表页在窄屏也不许横向滚动（关注项一行放不下要换行）
    var listPage = byTestId("db-list-page");
    put("listNoHorizontalScroll", !!listPage &&
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      listPage.scrollWidth <= listPage.clientWidth);
    snap();
    // 停一下让跑脚本的进程抓一张「关注列表排布」（宽屏单排 / 窄屏两排）：
    // 过了这一步就点进房间了，列表页那两排只在这一刻可见。
    await sleep(900);

    // ---- theme 主题按钮（item 10 + issue #7）：控件在**房间列表页页头**（标题「弹幕框」右侧），
    //      形态是**按钮**（用户 2026-09-13 #7：「模仿安卓 / iOS 的日月按钮，分亮、暗、自动三态，
    //      是按钮非滑块」）：点一下前进一档（亮 → 暗 → 自动 → 亮），图标随档变；档位落到
    //      window.__prefs["ui.theme"] 与 <html data-theme>，两档下正文 / 昵称的对比度都达标。
    //      **自动**档的 data-theme 由环境偏好决定（跟随系统），所以那一档只判「是个合法主题名」、
    //      不写死 light / dark。（这一段一条正则都不写：当年为绕开模板串吞反斜杠的坑；2026-09-17 拆分后已无该约束，写法保持原样。）
    var themeBtn = byTestId("db-pref-theme");
    out.themeControlShown = Boolean(themeBtn);
    // ① 控件是一枚**原生按钮**、可聚焦（原生按钮的 Enter / Space 由浏览器默认动作换成 click，
    //     所以「是按钮 + 能聚焦 + 没禁用」就是它的键盘契约），里面不再是下拉。
    out.themeControlIsButton = !!themeBtn && themeBtn.tagName === "BUTTON";
    out.themeControlHasNoSelect = !!themeBtn && themeBtn.querySelector("select") === null;
    out.themeControlInListHeader = !!themeBtn && !!byTestId("db-list-page") &&
      byTestId("db-list-page").contains(themeBtn);
    if (themeBtn) themeBtn.focus();
    out.themeControlFocusable = !!themeBtn && themeBtn.disabled !== true &&
      document.activeElement === themeBtn;
    var THEME_ORDER = ["light", "dark", "system"];
    var THEME_NAMES = { light: "亮", dark: "暗", system: "自动" };
    var themeModeOf = function () { return window.__prefs["ui.theme"]; };
    var themeNextOf = function (mode) {
      var at = THEME_ORDER.indexOf(mode);
      return THEME_ORDER[(at + 1) % THEME_ORDER.length];
    };
    // 图标没有可见文字：可访问名必须自带「现在是哪一档、点一下去哪一档」（title 同一句话）
    var themeHintOf = function (mode) {
      return "主题：" + THEME_NAMES[mode] + "（点一下切到" + THEME_NAMES[themeNextOf(mode)] + "）";
    };
    var themeApplied = document.documentElement.getAttribute("data-theme");
    var themeStart = themeModeOf();
    out.themeApplied = themeApplied;
    out.themeStartMode = themeStart;
    out.themeMatchesPref = themeApplied === themeStart || themeStart === "system";
    out.themeAccessibleName = themeBtn ? (themeBtn.getAttribute("aria-label") || "") : null;
    out.themeAccessibleNameIsHint = !!themeBtn &&
      out.themeAccessibleName === themeHintOf(themeStart) &&
      (themeBtn.getAttribute("title") || "") === out.themeAccessibleName;
    // 三档图标都走 §3.1 那一套矢量规范：24 盒 / 1.75 描边 / 墨迹居中 (12,12) / 主轴 16 单位
    var themeIconSpecOk = function () {
      var g = iconGeomOf(themeBtn);
      var svg = themeBtn ? themeBtn.querySelector("svg") : null;
      return !!g && !!svg && svg.getAttribute("aria-hidden") === "true" &&
        g.viewBox === "0 0 24 24" &&
        Math.abs(g.inkCenterX - 12) < 0.2 && Math.abs(g.inkCenterY - 12) < 0.2 &&
        Math.abs(Math.max(g.inkW, g.inkH) - 16) < 0.2 &&
        Math.abs(g.inkThicknessPx / g.scale - 1.75) < 0.01;
    };
    out.themeIcon = iconGeomOf(themeBtn);
    out.themeIconSpecOk = themeIconSpecOk();
    // 列表页能测的两处文字：正文色（关注项昵称，继承 --fg）与**次级色**（账号区的
    // uid 那一格 .accountMeta，取 --fg-dim）—— 正是硬纪律里那两个 token。
    var listContrast = function () {
      var bg = getComputedStyle(document.body).backgroundColor;
      var bodyText = byTestId("db-follow-name");
      var dimText = byTestId("db-account-uid");
      return {
        bg: bg,
        body: contrastRatio(getComputedStyle(document.body).color, bg),
        name: contrastRatio(bodyText ? getComputedStyle(bodyText).color : "", bg),
        dim: contrastRatio(dimText ? getComputedStyle(dimText).color : "", bg),
      };
    };
    out.listThemeContrast = listContrast();
    out.listThemeContrastOk = out.listThemeContrast.body >= 4.5 &&
      out.listThemeContrast.name >= 4.5 && out.listThemeContrast.dim >= 4.5;
    if (themeBtn) {
      // 走完**亮 → 暗 → 自动**一轮（三下回到原档）：每一步都验档位本身、<html data-theme>、
      // 可访问名与图标规范；路过**与起始档相反**的那一档时，把对比度也量一遍。
      var themeOtherMode = themeStart === "light" ? "dark" : "light";
      var themeSteps = [];
      var themeSwitchedContrast = null;
      for (var ts = 0; ts < THEME_ORDER.length; ts += 1) {
        themeBtn.click();
        await sleep(350);
        var themeNow = themeModeOf();
        var themeDom = document.documentElement.getAttribute("data-theme");
        themeSteps.push({
          mode: themeNow,
          dom: themeDom,
          nameOk: (themeBtn.getAttribute("aria-label") || "") === themeHintOf(themeNow),
          iconOk: themeIconSpecOk(),
          // 亮 / 暗是确定的；自动档由环境偏好定，只要落在两套主题里即可
          domOk: themeNow === "system"
            ? (themeDom === "light" || themeDom === "dark")
            : themeDom === themeNow,
          prefOk: window.__prefs["ui.theme"] === themeNow
        });
        if (themeNow === themeOtherMode) themeSwitchedContrast = listContrast();
      }
      out.themeCycleModes = themeSteps.map(function (s) { return s.mode; });
      out.themeAdvanceOneStep = themeSteps.length === 3 &&
        themeSteps[0].mode === themeNextOf(themeStart) &&
        themeSteps[1].mode === themeNextOf(themeSteps[0].mode) &&
        themeSteps[2].mode === themeStart;
      out.themeCycleStepsOk = themeSteps.length === THEME_ORDER.length &&
        themeSteps.every(function (s) {
          return s.nameOk && s.iconOk && s.domOk && s.prefOk;
        });
      out.themeSwitchChangesBackground = !!themeSwitchedContrast &&
        themeSwitchedContrast.bg !== out.listThemeContrast.bg;
      out.themeSwitchedContrast = themeSwitchedContrast;
      out.themeSwitchedContrastBodyOk = !!themeSwitchedContrast &&
        themeSwitchedContrast.body >= 4.5 && themeSwitchedContrast.name >= 4.5;
      out.themeSwitchedContrastDimOk = !!themeSwitchedContrast &&
        themeSwitchedContrast.dim >= 4.5;
      // 一轮走完必须回到本次运行的档位：后面的步骤与截图仍按这一档走
      out.themeRestored = themeModeOf() === themeStart &&
        document.documentElement.getAttribute("data-theme") === themeApplied;
    }
    snap();

