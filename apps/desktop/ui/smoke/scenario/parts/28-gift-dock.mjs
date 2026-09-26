// 场景块：礼物类消息去向、独立礼物栏、SC 卡片、选区与两枚开关
//   gift 礼物类消息的去向与独立礼物栏（ui.gift_in_danmaku / ui.gift_panel 四种组合逐个翻一遍）
//   礼物栏一条一行、金额带单位（连击折叠后是整串总额）、数量 ×N、头像有源才画
//   SC 卡片（档位令牌上色、金额行加粗独占一行、高亮框只盖内容部）
//   礼物区与弹幕区同一套呈现（行盒 / 头像列 / 身份行 / 正文块 / 底色逐项相等，SC 长留言不截断）
//   选中一条弹幕时底色从最左铺到最右、上下分区的分界线
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- gift 礼物类消息的去向 + 独立礼物栏 + SC 卡片（issue 2609152029 第 4 / 5 / 2 条）
    //
    // 装备：夹具（fixtures/gift-sc-guard-rows.json，**按协议文档字段表构造**）。六条一次注入 ——
    // 三条礼物 / 两条 SC / 一条大航海，其中前两条礼物共享 combo_id（连击折叠）。
    for (var gr = 0; gr < GIFT_ROWS.length; gr += 1) emitGiftRow(GIFT_ROWS[gr].key);
    await sleep(500);
    var chatWidthBefore = rect(byTestId("db-chat-scroll")).width;
    // 契约默认两枚都开：礼物类消息**两处都在**（弹幕流里有折叠后的礼物行，礼物栏也出现）
    out.giftPrefsDefault = window.__prefs["ui.gift_in_danmaku"] === true &&
      window.__prefs["ui.gift_panel"] === true;
    out.giftInDanmakuByDefault = !!rowWith("投喂 小心心") && !!rowWith("开通 舰长");
    var dock = byTestId("db-gift-total");
    var composer = document.querySelector("textarea").closest('[class*="composer"]');
    // 位置（issue #8 起）：礼物折叠条现在在**共享分区**里 —— 弹幕区之下、输入区**之前**，
    // 不再挂在输入区下方。判据因此从「在输入区之后」改成「在分区里 + 在弹幕区之后 + 在输入区之前」。
    var panesEl = byTestId("db-panes");
    out.giftDockInSharedRegion = !!dock && !!composer && !!panesEl && panesEl.contains(dock) &&
      (byTestId("db-pane-danmaku").compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
      (dock.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    out.giftDockCollapsed = !!dock && !byTestId("db-gift-area");
    out.giftDockFullWidth = !!dock && Math.abs(rect(dock).width - document.body.clientWidth) < 2;
    // 窄屏：折叠条只占一行，弹幕列表不被它挤掉
    put("giftDockCompact", !!dock && rect(dock).height <= 56);
    put("giftListKeptTall", rect(byTestId("db-chat-scroll")).height >= 200);
    // 折叠态汇总**按 kind 分组**：三组各报各的合计，单位统一是元（金瓜子 ÷1000）。
    // 金额串一律用页面自己的 toLocaleString 拼（分组位数随浏览器 locale 变，断言不该把它写死）。
    var num = function (n) { return n.toLocaleString(); };
    // amountText 的格式化是 toLocaleString(undefined, { maximumFractionDigits: 3 })：
    // 整数元不带小数（138 元），非整数保留必要小数（0.1 元）。断言跟着它走。
    var yuan = function (n) { return n.toLocaleString(undefined, { maximumFractionDigits: 3 }); };
    var giftSummary = (byTestId("db-gift-summary") || {}).innerText || "";
    out.giftDockSummaryText = giftSummary;
    out.giftDockSummaryGroupedByKind =
      giftSummary.indexOf("礼物 3 · " + yuan(0.7) + " 元") >= 0 &&
      giftSummary.indexOf("SC 2 · " + yuan(1030) + " 元") >= 0 &&
      giftSummary.indexOf("大航海 1 · " + yuan(138) + " 元") >= 0;
    // 汇总不许自己另算一个总数：按 kind 分组的明细之外没有第二条合计。
    // 两个「不是分组明细」的候选值都不许出现——① 三组元值相加 0.7 + 1030 + 138 = 1168.7；
    // ② 把 SC 的元当金瓜子与另两组直接相加（139730 金瓜子）或换算后（139.73 元）。
    out.giftDockNoCrossUnitSum = giftSummary.indexOf(yuan(1168.7)) < 0 &&
      giftSummary.indexOf("1168.7") < 0 && giftSummary.indexOf("139.73") < 0 &&
      giftSummary.indexOf("139730") < 0 && giftSummary.indexOf("140730") < 0;
    // db-gift-total 是礼物栏的**总计条**（data-pane-head，折叠态唯一一行；issue #8 之后由折叠头演变而来），不再是「容器里装着一枚按钮」
    dock.click();
    await sleep(300);
    out.giftDockExpands = !!byTestId("db-gift-area");
    out.giftChatWidthUnchanged = Math.abs(rect(byTestId("db-chat-scroll")).width - chatWidthBefore) < 2;
    // ---- 一条一行：折叠后的行数（连击那两条合成 1 行）就是礼物栏的行数 —— 改前那段
    //      「金额排行 + 内容详情」的两段式结构已随 2609152029 第 5 条删掉。
    //      **行现在是弹幕行的同一份实现**（用户 2026-09-16 第 2 条）：六条夹具 → 连击两条折叠
    //      成一行 → 五行；行不再挂在 db-gift-area 的直接子层里，而在虚拟列表的高度块
    //      db-gift-list 里（与弹幕区的 db-msg-list 同一个东西）。
    var giftArea = byTestId("db-gift-area");
    var giftItems = allByTestId("db-gift-row");
    out.giftDockItemCount = giftItems.length;
    out.giftDockOneRowPerEvent = giftItems.length === 5 && !!giftArea &&
      allByTestId("db-gift-list").length === 1 && allByTestId("db-gift-scroll").length === 1;
    out.giftDockItemTexts = giftItems.map(function (item) {
      // 换行用 String.fromCharCode(10) 拼：当年这一整段活在模板串里，反斜杠转义会先被吃掉
      // （连注释里写一个都会变成真换行）；2026-09-17 拆分后已无该约束，写法保持原样、不为此单开一票。
      return item.innerText.split(String.fromCharCode(10)).join(" ");
    });
    // 行高记成实测值（旧版这里钉的是「必须 < 40px」的单行窄条，那是礼物栏**自己的**一套排版）；
    // 现在行与弹幕行同款：身份行 + 正文行（+ 礼物 / 大航海的金额行），行高因此由内容决定。
    out.giftDockRowHeights = giftItems.map(function (item) {
      return rect(item) ? Math.round(rect(item).height * 10) / 10 : null;
    });
    out.giftDockRowsAreDanmakuRows = giftItems.length === 5 && giftItems.every(function (item) {
      return !!item.querySelector('[data-testid="db-gift-avatar-col"]') &&
        !!item.querySelector('[data-testid="db-gift-identity"]') &&
        !!item.querySelector('[data-testid="db-gift-body"]');
    });
    // ---- 金额格带单位（三类都是元，金瓜子按 ÷1000 换算），且连击折叠后是整串的总额。
    //      SC 的金额是**卡片规格的一部分**（db-gift-sc-amount，与弹幕区里那条 SC 同一格）；
    //      礼物 / 大航海的金额行只在礼物栏这一份画（db-gift-amount，见 §4.1 / §5.3），
    //      所以这里两种钩子一起取：一行恰有一个金额格。
    out.giftDockAmounts = giftItems.map(function (item) {
      var el = item.querySelector(
        '[data-testid="db-gift-amount"], [data-testid="db-gift-sc-amount"]');
      return el ? el.innerText : "";
    });
    out.giftDockAmountsCarryUnits =
      out.giftDockAmounts.indexOf(yuan(0.6) + " 元") >= 0 &&
      out.giftDockAmounts.indexOf(yuan(0.1) + " 元") >= 0 &&
      out.giftDockAmounts.indexOf(yuan(30) + " 元") >= 0 &&
      out.giftDockAmounts.indexOf(yuan(1000) + " 元") >= 0 &&
      out.giftDockAmounts.indexOf(yuan(138) + " 元") >= 0;
    // **差 1000 倍的红线**：金瓜子原值不许直接贴上「元」（600 / 100 / 138000 三档一个都不许出现）。
    out.giftDockNoRawCoinDisplay = out.giftDockAmounts.every(function (t) {
      return t.indexOf(yuan(600) + " 元") < 0 && t.indexOf(yuan(100) + " 元") < 0 &&
        t.indexOf(yuan(138000) + " 元") < 0;
    });
    // ---- 数量：礼物行恒有 ×N（折叠后是整串连击的次数），SC / 大航海没有折叠就不画 ×1
    var giftCounts = giftItems.map(function (item) {
      var el = item.querySelector('[data-testid="db-gift-count"]');
      return el ? el.innerText : "";
    });
    out.giftDockCounts = giftCounts;
    out.giftDockComboFolded = giftCounts.indexOf("×2") >= 0 && giftCounts.indexOf("×1") >= 0;
    out.giftDockNonGiftHasNoCount =
      giftItems.length === 5 && giftCounts.filter(function (c) { return c === ""; }).length === 3;
    // ---- 头像（第 2 条）：**有源才画** —— 两条连击礼物（折叠后 1 行）与两条 SC 有 face，
    //      V1 礼物与大航海在上游没有头像字段（协议 §10.2 / §10.6 的字段表里都没有），
    //      因此礼物栏里这一个都不许出现（界面不画假图）。
    //      **头像列永远占位**（§4.2，与弹幕行同一口径）：有图没图都留一列，逐行才对得齐 ——
    //      五个非 system 行各一列，其中三列有图。
    var giftAvatars = [].slice.call(giftArea.querySelectorAll('[data-testid="db-gift-avatar"]'));
    out.giftDockAvatarCount = giftAvatars.length;
    out.giftDockAvatarsOnlyWhereSourced = giftAvatars.length === 3;
    out.giftDockAvatarColCount = allByTestId("db-gift-avatar-col").length;
    out.giftDockAvatarColAlwaysReserved = out.giftDockAvatarColCount === 5 &&
      out.giftDockAvatarCount === 3;
    out.giftDockAvatarIsImage = giftAvatars.length > 0 && giftAvatars.every(function (el) {
      return el.tagName === "IMG";
    });
    out.giftDockAvatarBox = giftAvatars.length > 0 ? [
      Math.round(rect(giftAvatars[0]).width), Math.round(rect(giftAvatars[0]).height)
    ] : null;
    out.giftDockAvatarSquare = giftAvatars.length > 0 &&
      Math.abs(rect(giftAvatars[0]).width - rect(giftAvatars[0]).height) < 1;
    // 头像盒与弹幕行同一档（1.25 × 行盒）：两处不再各算一套尺寸
    var chatAvatarEl = byTestId("db-msg-avatar");
    out.giftDockAvatarSameBoxAsChat = !!chatAvatarEl && giftAvatars.length > 0 &&
      Math.abs(rect(giftAvatars[0]).width - rect(chatAvatarEl).width) < 0.6 &&
      Math.abs(rect(giftAvatars[0]).height - rect(chatAvatarEl).height) < 0.6;
    snap();

    // ---- SC 卡片（第 2 条）：卡片背景 / 边框取自档位令牌，金额行低一档加粗、独占一行。
    //      文本一律**从夹具读**，不在断言里写死：最低档那条的正文刻意写长（40 个汉字，
    //      见 fixtures/gift-sc-guard-rows.json 里 superchat-low 的 why），它同时是下面
    //      「SC 不许被截断」的断言件。
    //
    //      整段包一层（同 tabs / immersive / admin 段的手法：try/catch + xxxBlockRan）——
    //      issue 2609171849 #4 第 2 点把卡片从**行**搬到**内容部**（只盖用户名 / 身份牌下面的
    //      区域），这一段因此改读新的卡片节点；出岔子时让断言红（scCardBlockRan），
    //      不把整场场景带走（§9.3 的准入条件 ①）。
    var scCardBlockRan = false;
    try {
    // 行内按 testid 取一格：以下两段（SC 卡片 / 两处对等）都用它。
    var partOf = function (row, id) {
      return row ? row.querySelector('[data-testid="' + id + '"]') : null;
    };
    var scLowSpec = GIFT_ROWS.filter(function (r) { return r.key === "superchat-low"; })[0].message;
    var scHighSpec = GIFT_ROWS.filter(function (r) { return r.key === "superchat-high"; })[0].message;
    var scLow = rowWith(scLowSpec.content);
    var scHigh = rowWith(scHighSpec.content);
    out.scCardTiers = [scLow, scHigh].map(function (r) {
      return r ? r.getAttribute("data-sc-tier") : null;
    });
    out.scCardTierByAmount = out.scCardTiers.join(",") === "1,4";
    // 卡片节点 = 正文块里那个 db-msg-sc-card。**改前它挂在行上**（.row.scCard），
    // 所以下面这些读数从前量的都是整行 —— 现在量的必须是内容部那个框。
    var scLowCard = partOf(scLow, "db-msg-sc-card");
    var scHighCard = partOf(scHigh, "db-msg-sc-card");
    // 边框色 = 那一档的令牌值（令牌真的被消费了，不是写死的色值）
    var scBorderColor = function (card) { return card ? getComputedStyle(card).borderTopColor : null; };
    out.scCardLowUsesTierToken = scBorderColor(scLowCard) === cssColorOf("--sc-1");
    out.scCardHighUsesTierToken = scBorderColor(scHighCard) === cssColorOf("--sc-4");
    out.scCardTierTokensDistinct = cssColorOf("--sc-1") !== cssColorOf("--sc-4");
    var scLowStyle = scLowCard ? getComputedStyle(scLowCard) : null;
    out.scCardIsACard = !!scLowStyle && parseFloat(scLowStyle.borderTopWidth) >= 1 &&
      scLowStyle.borderTopStyle === "solid" &&
      parseFloat(scLowStyle.borderTopLeftRadius) >= 4 &&
      scLowStyle.backgroundColor !== getComputedStyle(document.body).backgroundColor;
    // ---- issue 2609171849 #4 第 2 点：「sc 的高亮框仅显示在内容部分，也就是用户名、身份牌下面的
    //      区域」。改前卡片挂在整个**行**上（头像列 + 身份行 + 正文 + 金额都被圈住），
    //      改后框从身份行的**下一行**开始。四条判据：① 框顶 ≥ 身份行底边；② 框左 ≥ 头像列右边缘
    //      （头像在框外）；③ 正文与金额行都在框内；④ 框仍在行盒里（没横向溢出）。
    //      反面对照 scCardRowUntouched：行上不再挂卡片类名（改前为假）。
    var scCardBox = rect(scLowCard);
    var scIdentBox = rect(partOf(scLow, "db-msg-identity"));
    var scAvatarColBox = rect(partOf(scLow, "db-msg-avatar-col"));
    var scRowBox = rect(scLow);
    var scCardBodyBox = rect(partOf(scLow, "db-msg-body"));
    var scCardAmountBox = rect(partOf(scLow, "db-msg-sc-amount"));
    out.scCardRowUntouched = !!scLow && (scLow.className || "").indexOf("scCard") < 0;
    out.scCardBelowIdentity = !!scCardBox && !!scIdentBox &&
      scCardBox.top >= scIdentBox.bottom - 0.5;
    out.scCardOutsideAvatarCol = !!scCardBox && !!scAvatarColBox &&
      scCardBox.left >= scAvatarColBox.right - 0.5;
    out.scCardHoldsBodyAndAmount = !!scCardBox && !!scCardBodyBox && !!scCardAmountBox &&
      scCardBodyBox.top >= scCardBox.top - 0.5 &&
      scCardBodyBox.bottom <= scCardBox.bottom + 0.5 &&
      scCardAmountBox.top >= scCardBodyBox.top - 0.5 &&
      scCardAmountBox.bottom <= scCardBox.bottom + 0.5;
    out.scCardInsideRow = !!scCardBox && !!scRowBox &&
      scCardBox.left >= scRowBox.left - 0.5 && scCardBox.right <= scRowBox.right + 0.5;
    out.scCardGapAbovePx = scCardBox && scIdentBox
      ? Math.round((scCardBox.top - scIdentBox.bottom) * 10) / 10 : null;
    var scAmountEl = partOf(scLow, "db-msg-sc-amount");
    var scAmountStyle = scAmountEl ? getComputedStyle(scAmountEl) : null;
    var scBodyStyle = scLow
      ? getComputedStyle(partOf(scLow, "db-msg-body")) : null;
    out.scCardAmountText = scAmountEl ? scAmountEl.innerText : null;
    out.scCardAmountUnit = out.scCardAmountText === num(30) + " 元";
    out.scCardAmountBold = !!scAmountStyle && parseInt(scAmountStyle.fontWeight, 10) >= 700;
    out.scCardAmountSmallerThanBody = !!scAmountStyle && !!scBodyStyle &&
      parseFloat(scAmountStyle.fontSize) < parseFloat(scBodyStyle.fontSize);
    out.scCardAmountOnOwnLine = !!scAmountStyle && scAmountStyle.display === "block";
    snap();

    // ---- 用户 2026-09-16 第 2 条：「礼物区域的显示和弹幕区直接保持一致（一样的布局、
    //      一样的背景颜色、一样的自动滚动）」。
    //      做法是**同一份实现**（行 = MessageRow、列表 = MessageList，scope="gift"），
    //      所以这一组量的是「同一条 SC 在两处逐项相等」——行盒 / 头像列 / 身份行 / 正文块 /
    //      计算底色逐项比出来，不是「看起来差不多」。另一条腿是**SC 不许被截断**（用户报的
    //      「sc 在礼物区域显示不全」）：正文块的 scrollWidth/scrollHeight 不许超过
    //      clientWidth/clientHeight，也不许是 nowrap + ellipsis。
    //      （行内取格子的 partOf 定义在上面 SC 卡片那一段。）
    var giftScRow = giftItems.filter(function (r) {
      return r.innerText.indexOf(scLowSpec.content) >= 0;
    })[0];
    var chatScRow = rowWith(scLowSpec.content);
    var giftScBody = partOf(giftScRow, "db-gift-body");
    var chatScBody = partOf(chatScRow, "db-msg-body");
    var clipOf = function (el) {
      if (!el) return null;
      var st = getComputedStyle(el);
      return {
        x: Math.round((el.scrollWidth - el.clientWidth) * 10) / 10,
        y: Math.round((el.scrollHeight - el.clientHeight) * 10) / 10,
        whiteSpace: st.whiteSpace,
        textOverflow: st.textOverflow
      };
    };
    out.giftParityScRowFound = !!giftScRow && !!chatScRow;
    // ① 布局：同一条 SC 的行盒几何与行内各格逐项相同
    var giftScBox = rect(giftScRow), chatScBox = rect(chatScRow);
    out.giftParityRowGeometry = !!giftScBox && !!chatScBox &&
      Math.abs(giftScBox.height - chatScBox.height) < 0.6 &&
      Math.abs(giftScBox.left - chatScBox.left) < 0.6 &&
      Math.abs(giftScBox.width - chatScBox.width) < 0.6;
    out.giftParityRowHeightPx = giftScBox ? Math.round(giftScBox.height * 10) / 10 : null;
    var gCol = rect(partOf(giftScRow, "db-gift-avatar-col"));
    var cCol = rect(partOf(chatScRow, "db-msg-avatar-col"));
    out.giftParityAvatarCol = !!gCol && !!cCol &&
      Math.abs(gCol.width - cCol.width) < 0.6 && Math.abs(gCol.height - cCol.height) < 0.6 &&
      Math.abs(gCol.left - cCol.left) < 0.6;
    var gIdent = rect(partOf(giftScRow, "db-gift-identity"));
    var cIdent = rect(partOf(chatScRow, "db-msg-identity"));
    out.giftParityIdentityRow = !!gIdent && !!cIdent &&
      Math.abs(gIdent.height - cIdent.height) < 0.6 && Math.abs(gIdent.left - cIdent.left) < 0.6;
    var gBodyBox = rect(giftScBody), cBodyBox = rect(chatScBody);
    out.giftParityBodyBox = !!gBodyBox && !!cBodyBox &&
      Math.abs(gBodyBox.width - cBodyBox.width) < 0.6 &&
      Math.abs(gBodyBox.left - cBodyBox.left) < 0.6;
    var gBodyStyle = giftScBody ? getComputedStyle(giftScBody) : null;
    var cBodyStyle = chatScBody ? getComputedStyle(chatScBody) : null;
    out.giftParityBodyFont = !!gBodyStyle && !!cBodyStyle &&
      gBodyStyle.fontSize === cBodyStyle.fontSize &&
      gBodyStyle.lineHeight === cBodyStyle.lineHeight;
    // 行内各格一个不差：同一条 SC 在两处的 innerText 逐字相同（昵称 + 正文 + 金额行）
    out.giftParityScRowText = !!giftScRow && !!chatScRow &&
      giftScRow.innerText === chatScRow.innerText;
    var gScAmount = partOf(giftScRow, "db-gift-sc-amount");
    var cScAmount = partOf(chatScRow, "db-msg-sc-amount");
    out.giftParityScAmountLine = !!gScAmount && !!cScAmount &&
      gScAmount.innerText === cScAmount.innerText && gScAmount.innerText === yuan(30) + " 元";
    // ② 背景色：两栏底色同一（.paneGift 不再另刷 --bg-elevated）；同一条 SC 在两处**行本身**
    //      与**卡片**的计算底色 / 边框也逐项相同（行不再刷底色，卡片才是那个框 —— issue
    //      2609171849 #4 第 2 点之后卡片只盖内容部，见上面那一段的两条腿都量一遍）。
    var paneGiftEl = byTestId("db-pane-gift");
    var paneDanmakuEl = byTestId("db-pane-danmaku");
    out.giftParityPaneBackground = !!paneGiftEl && !!paneDanmakuEl &&
      getComputedStyle(paneGiftEl).backgroundColor ===
      getComputedStyle(paneDanmakuEl).backgroundColor;
    out.giftParityPaneBackgroundColor = paneGiftEl
      ? getComputedStyle(paneGiftEl).backgroundColor : null;
    out.giftParityRowBackground = !!giftScRow && !!chatScRow &&
      getComputedStyle(giftScRow).backgroundColor ===
      getComputedStyle(chatScRow).backgroundColor;
    out.giftParityRowBackgroundColor = giftScRow
      ? getComputedStyle(giftScRow).backgroundColor : null;
    var giftScCard = partOf(giftScRow, "db-gift-sc-card");
    var chatScCard = partOf(chatScRow, "db-msg-sc-card");
    out.giftParityCardBackground = !!giftScCard && !!chatScCard &&
      getComputedStyle(giftScCard).backgroundColor ===
      getComputedStyle(chatScCard).backgroundColor &&
      getComputedStyle(giftScCard).borderTopColor === getComputedStyle(chatScCard).borderTopColor &&
      getComputedStyle(giftScCard).borderTopWidth === getComputedStyle(chatScCard).borderTopWidth;
    // ③ SC 不许被截断：两处都不许（现在这一条同时钉住弹幕区那一份，避免只修了礼物栏那一处）
    out.giftScBodyClip = clipOf(giftScBody);
    out.chatScBodyClip = clipOf(chatScBody);
    out.giftScNotTruncated = !!out.giftScBodyClip &&
      out.giftScBodyClip.x <= 1 && out.giftScBodyClip.y <= 1 &&
      out.giftScBodyClip.whiteSpace === "pre-wrap" && out.giftScBodyClip.textOverflow === "clip";
    out.chatScNotTruncated = !!out.chatScBodyClip &&
      out.chatScBodyClip.x <= 1 && out.chatScBodyClip.y <= 1 &&
      out.chatScBodyClip.whiteSpace === "pre-wrap" && out.chatScBodyClip.textOverflow === "clip";
    out.giftScFullTextPresent = !!giftScBody &&
      giftScBody.innerText.indexOf(scLowSpec.content) >= 0;
    out.chatScFullTextPresent = !!chatScBody &&
      chatScBody.innerText.indexOf(scLowSpec.content) >= 0;
    // 礼物 / 大航海的金额**只在礼物栏画**（§4.1：弹幕流行内不塞金额；§5.3：礼物栏画）：
    // 同一批"投喂 小心心"在两处各一行，礼物栏那行有金额行、弹幕流那行没有。
    var chatGiftRow = rowWith("投喂 小心心");
    var paneGiftRow = giftItems.filter(function (r) {
      return r.innerText.indexOf("投喂 小心心") >= 0;
    })[0];
    out.giftAmountOnlyInPane = !!chatGiftRow && !!paneGiftRow &&
      !partOf(chatGiftRow, "db-msg-amount") && !partOf(chatGiftRow, "db-msg-sc-amount") &&
      !!partOf(paneGiftRow, "db-gift-amount") &&
      partOf(paneGiftRow, "db-gift-amount").innerText === yuan(0.6) + " 元";
    // ④ 自动滚动与「跟随 / 暂停 / 回到最新」与弹幕列表**同源**：同一套 8px 判据、同一条
    //      scrollToIndex(align: "end") 贴底、同一枚「回到最新」控件 —— 只是另一份实例。
    var giftScroll = byTestId("db-gift-scroll");
    var giftGapNow = function () { return giftScroll ? bottomGap(giftScroll) : null; };
    out.giftFollowPinnedToBottom = !!giftScroll && giftGapNow() < 8 && !byTestId("db-gift-anchor");
    // 贴底的可观察面：最新一条真的在视口里（末行的底边不越过滚动容器的底边）
    var lastGiftRow = giftItems[giftItems.length - 1];
    var giftScrollBox = rect(giftScroll);
    out.giftNewestRowVisible = !!lastGiftRow && !!giftScrollBox &&
      rect(lastGiftRow).bottom <= giftScrollBox.bottom + 1;
    // 用户自己往上滚 → 暂停跟随（判据与弹幕区同一条：离底 > 8px 且「回到最新」出现）
    var chatGapBefore = bottomGap(byTestId("db-chat-scroll"));
    giftScroll.scrollTop = 0;
    await sleep(400);
    out.giftPausedGapPx = giftGapNow();
    out.giftPausedShowsJumpButton = !!byTestId("db-gift-anchor") && giftGapNow() > 8;
    // 两处各自一份滚动位置与虚拟列表状态：滚礼物栏**不动**弹幕区
    out.giftScrollIndependentOfChat =
      Math.abs(bottomGap(byTestId("db-chat-scroll")) - chatGapBefore) < 1;
    var giftAnchorBtn = byTestId("db-gift-anchor");
    if (giftAnchorBtn) giftAnchorBtn.click();
    await sleep(500);
    out.giftJumpButtonReturnsToBottom = giftGapNow() < 8 && !byTestId("db-gift-anchor");
    out.giftRowsStillRendered = allByTestId("db-gift-row").length === giftItems.length;
    snap();
    scCardBlockRan = true;
    } catch (e) {
      out.scCardBlockError = String((e && e.stack) || e);
      snap();
    }
    out.scCardBlockRan = scCardBlockRan;

    // ---- issue 2609171849 #4 第 1 点：**选中一条弹幕时，那层绿底从界面最左铺到最右**
    //      （用户原话：「选中某条弹幕时，那个绿色底色能不能从界面最左一直到最右，现在这个卡在
    //      头像上有点不好看」）。实现见 docs/ui.md §4.10：底色不再画在字形上（浏览器那层原生选区底
    //      贴着字画、头像那一列是空的），改成整行一层底 —— 行盒向两侧各探出一道 --sp-3
    //      （.scroller 的左右内边距），由 MessageRow 按「当前选区碰没碰到这一行」打
    //      data-selected。
    //      整块包一层（try/catch + rowSelectBlockRan，§9.3 的准入条件 ①）；准入自备（条件 ②）：
    //      块内自己确认在房间页、自己**推一条新行**当锚（虚拟列表的渲染窗口随时在变，
    //      拿历史行当锚会假失败 —— 本仓踩过），跑完自己把选区清掉（后面的段落不受影响）。
    var rowSelectBlockRan = false;
    try {
    // 读「某个令牌当背景色」的计算值：.row[data-selected] 的底色是 color-mix 出来的，
    // 与探针走的是同一条解析路径，因此两者可以直接比字符串（issue 2609171849 #4）。
    var bgColorOf = function (name) {
      var probe = document.createElement("span");
      probe.style.setProperty("background-color", "var(" + name + ")");
      document.body.appendChild(probe);
      var value = getComputedStyle(probe).backgroundColor;
      probe.parentNode.removeChild(probe);
      return value;
    };
    // 计算色的序列化随引擎 / 色值来源不同（color-mix 出来的是 color(srgb r g b / a)，
    // 令牌里写死的十六进制是 rgb(r, g, b)），两族都要切得出来 —— 用 indexOf / split 切，
    // **不写正则**（当年为绕开模板串吞反斜杠的坑；拆分后约束已消失，写法保持原样）。
    var channelsOf = function (css) {
      var open = css.indexOf("(");
      var close = css.lastIndexOf(")");
      if (open < 0 || close < 0) return null;
      var parts = css.slice(open + 1, close).split(",").join(" ").split("/").join(" ").split(" ");
      var nums = [];
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].length === 0) continue;
        var value = parseFloat(parts[i]);
        if (!isNaN(value)) nums.push(value);
      }
      return nums.length >= 3 ? nums : null;
    };
    out.rowSelectPrecondition = !!byTestId("db-chat-scroll") && !!byTestId("db-chat-area");
    window.__emit("danmubox://message", window.__mk("danmaku", "选中态全宽断言样本", false, {
      uid: 77006, uname: "全宽样本观众"
    }));
    await sleep(400);
    var selRow = rowWith("选中态全宽断言样本");
    var selScroller = byTestId("db-chat-scroll");
    var selRowBox = rect(selRow);
    var selScrollerBox = rect(selScroller);
    var selBodyEl = selRow ? selRow.querySelector('[data-testid="db-msg-body"]') : null;
    var selNameEl = selRow ? selRow.querySelector('[data-testid="db-msg-name"]') : null;
    var selAvatarBox = rect(selRow
      ? selRow.querySelector('[data-testid="db-msg-avatar-col"]') : null);
    // ① 行盒与滚动容器**左右边界对齐**：.scroller 的左右内边距是 --sp-3，行盒探出去之后
    //    左边缘 = 容器的内边距盒左边缘，右边缘 = 容器 clientWidth 的右边缘（clientWidth
    //    已经扣掉滚动条那条槽：覆盖式滚动条下两者相等，经典滚动条下正好差一条槽宽）。
    out.rowBoxFullBleedLeftPx = selRowBox && selScrollerBox
      ? Math.round((selRowBox.left - selScrollerBox.left) * 10) / 10 : null;
    out.rowBoxFullBleedRightPx = selRowBox && selScrollerBox
      ? Math.round((selScrollerBox.left + selScroller.clientWidth - selRowBox.right) * 10) / 10 : null;
    out.rowBoxFullBleed = out.rowBoxFullBleedLeftPx !== null &&
      Math.abs(out.rowBoxFullBleedLeftPx) < 1 && Math.abs(out.rowBoxFullBleedRightPx) < 1;
    // ② 底色真的铺到头像**左边**去了：改前行盒的左边缘就是头像列的左边缘（这个差值是 0），
    //    所以这条是「不再被头像卡住」的正面判据（反面对照就是上面那两个 0）。
    out.rowBoxBleedsLeftOfAvatarPx = selRowBox && selAvatarBox
      ? Math.round((selAvatarBox.left - selRowBox.left) * 10) / 10 : null;
    out.rowBoxCoversAvatarColumn = out.rowBoxBleedsLeftOfAvatarPx !== null &&
      out.rowBoxBleedsLeftOfAvatarPx > 8;
    // ③ 探出去的是**盒**不是内容：正文左边缘仍与用户名左边缘一致（悬挂缩进没被带歪）
    out.rowFullBleedKeepsIndent = !!selBodyEl && !!selNameEl &&
      Math.abs(rect(selBodyEl).left - rect(selNameEl).left) < 1;
    // ④ 选中：真实 Range（与拖选走同一批 DOM API）
    var selRange = document.createRange();
    selRange.selectNodeContents(selBodyEl);
    var selSel = window.getSelection();
    selSel.removeAllRanges();
    selSel.addRange(selRange);
    await sleep(300);
    out.rowSelectedMarked = !!selRow && selRow.getAttribute("data-selected") === "true";
    out.rowSelectedBackground = selRow ? getComputedStyle(selRow).backgroundColor : null;
    out.rowSelectedUsesSelectWash = out.rowSelectedBackground === bgColorOf("--select-wash");
    out.rowSelectedWashIsOwn = bgColorOf("--select-wash") !== bgColorOf("--hover-wash");
    var selChannels = channelsOf(out.rowSelectedBackground || "");
    out.rowSelectedWashGreen = !!selChannels && selChannels[1] >= selChannels[0] &&
      selChannels[1] >= selChannels[2] && selChannels[1] > 0;
    out.rowSelectedOnlyThisRow = allByTestId("db-msg-row").filter(function (r) {
      return r !== selRow && r.getAttribute("data-selected") !== null;
    }).length === 0;
    // 选中语义一条都不许少：正文仍可选中、仍取得到文字（沉浸态那条断言量的是同一件事）
    out.rowSelectionTextKept = selSel.toString().length > 0;
    out.rowSelectionKeepsTextSelectable = !!selBodyEl &&
      getComputedStyle(selBodyEl).userSelect !== "none";
    // 字形那层底已置透明（整行已经有一层底，再叠一层更深的绿就是两色）
    out.rowSelectionGlyphBackground = selBodyEl
      ? getComputedStyle(selBodyEl, "::selection").backgroundColor : null;
    out.rowSelectionGlyphTransparent = out.rowSelectionGlyphBackground === "rgba(0, 0, 0, 0)" ||
      out.rowSelectionGlyphBackground === "transparent";
    // ⑤ 松开选区：底色与标记都要收回去（用户点一下就松手 = 没选中任何东西）
    selSel.removeAllRanges();
    await sleep(300);
    out.rowSelectionCleared = !!selRow && selRow.getAttribute("data-selected") === null;
    out.rowBackgroundBackToNone = !!selRow &&
      getComputedStyle(selRow).backgroundColor === "rgba(0, 0, 0, 0)";
    snap();
    rowSelectBlockRan = true;
    } catch (e) {
      out.rowSelectBlockError = String((e && e.stack) || e);
      // 出错也要把选区清掉：后面的段落不该带着一个活动选区跑。
      try { window.getSelection().removeAllRanges(); } catch (ignored) {}
      snap();
    }
    out.rowSelectBlockRan = rowSelectBlockRan;

    // ---- issue 2609171849 #4 第 3 点：**上下分区的分界线**（用户原话：「分割独立礼物栏的那个
    //      横折叠区域，弄点横线或者虚线之类的（类似于折叠屏分屏的那个提示），而且现在 2 区间
    //      没有任何边界，有点不便于区分区域」）。改前那条线借的是 --border 发丝线：深色下对
    //      底色 1.56:1、浅色下 1.02:1 —— 用户的「没有任何边界」就是它。现在画在分割条自己的顶边上
    //      （**虚线** + --fold-line），对比度两套主题都 ≥ 3:1（图形要素的达标线）。
    //      整块包一层（try/catch + foldLineBlockRan）；准入前提是礼物栏开着
    //      （ui.gift_panel 为真、分割条在场），判据直接记进快照（条件 ②）。
    var foldLineBlockRan = false;
    try {
    var splitEl = byTestId("db-pane-splitter");
    var splitStyle = splitEl ? getComputedStyle(splitEl) : null;
    var splitBox = rect(splitEl);
    var paneDanmakuBox = rect(byTestId("db-pane-danmaku"));
    var paneGiftBox = rect(byTestId("db-pane-gift"));
    out.foldLinePrecondition = !!splitEl && window.__prefs["ui.gift_panel"] === true;
    // 线画在 `.splitter::before`（居中实线 1px，见 docs/ui.md §5.4）：分割条本身不再带边框。
    var splitPseudo = splitEl ? getComputedStyle(splitEl, "::before") : null;
    out.foldLineIsSolid = !!splitPseudo && splitPseudo.borderTopStyle === "solid" &&
      parseFloat(splitPseudo.borderTopWidth) >= 1;
    out.foldLineWidthPx = splitPseudo
      ? Math.round(parseFloat(splitPseudo.borderTopWidth) * 10) / 10 : null;
    // 线的颜色 = 令牌值（令牌真的被消费了，不是写死的色值）
    out.foldLineUsesToken = !!splitPseudo && splitPseudo.borderTopColor === cssColorOf("--fold-line");
    out.foldLineColor = splitPseudo ? splitPseudo.borderTopColor : null;
    // 可见性：线的颜色对画布 ≥ 3:1（与「正文对背景 ≥ 4.5:1」同一套 WCAG 算式）。
    // 反面对照 foldLineOldBorderContrast 是改前那条线（--border）的读数，两套主题都 < 1.6:1。
    out.foldLineContrastOnCanvas = contrastRatio(
      cssColorOf("--fold-line"), cssColorOf("--bg")) >= 3;
    out.foldLineContrastPx = contrastRatio(cssColorOf("--fold-line"), cssColorOf("--bg"));
    out.foldLineOldBorderContrast = contrastRatio(
      cssColorOf("--border"), cssColorOf("--bg"));
    // 它真的落在两个区间**之间**（礼物栏在上还是在下都成立：分割条在 DOM 里恒在两栏之间）
    out.foldLineSeparatesPanes = !!splitBox && !!paneDanmakuBox && !!paneGiftBox &&
      ((Math.abs(splitBox.top - paneDanmakuBox.bottom) < 1 &&
        Math.abs(splitBox.bottom - paneGiftBox.top) < 1) ||
       (Math.abs(splitBox.top - paneGiftBox.bottom) < 1 &&
        Math.abs(splitBox.bottom - paneDanmakuBox.top) < 1));
    // `.splitter::before` 即分界线本身（居中实线），不是叠着画、也不是删掉
    out.foldLineDrawnByPseudo = !!splitEl && getComputedStyle(splitEl, "::before").content !== "none";
    snap();
    foldLineBlockRan = true;
    } catch (e) {
      out.foldLineBlockError = String((e && e.stack) || e);
      snap();
    }
    out.foldLineBlockRan = foldLineBlockRan;

    // ---- 两枚开关的四种组合（第 4 条）：每一次都顺带验「切开关不丢消息」（同一批数据只换渲染位置）。
    //      点开关之前必须先把**筛选面板**开回来：上一步展开礼物栏那一下按「五者互斥」把面板收掉了
    //      （不是 bug，是 §2.3 的口径）。反过来，开面板也会收起礼物栏 —— 两件事分开验，不混在一起。
    clickTool("筛选");
    await sleep(300);
    out.giftSwitchPanelOff = setGiftSwitch("独立礼物栏", false);
    await sleep(350);
    out.giftPanelOffHidesDock = !byTestId("db-gift-total");
    out.giftPanelOffKeepsStream = !!rowWith("投喂 小心心") &&
      !!rowWith(scLowSpec.content);
    out.giftSwitchInDanmakuOff = setGiftSwitch("弹幕包含礼物", false);
    await sleep(350);
    out.giftBothOffHidesDock = !byTestId("db-gift-total");
    out.giftBothOffHidesStream = !rowWith("投喂 小心心") &&
      !rowWith(scLowSpec.content) && !rowWith("开通 舰长");
    // 普通弹幕不受这两枚开关影响（它们只管礼物类三族）。判据现场推一条**新的**弹幕再找它：
    // 历史那条早已滚出虚拟列表的渲染窗口，拿它当锚会假失败（踩过一次）。
    window.__emit("danmubox://message", window.__mk("danmaku", "两枚开关都关时的普通弹幕", false, {
      uid: 77002, uname: "隔壁观众"
    }));
    await sleep(350);
    out.giftSwitchesKeepDanmaku = !!rowWith("两枚开关都关时的普通弹幕");
    out.giftSwitchPanelOnly = setGiftSwitch("独立礼物栏", true);
    await sleep(350);
    out.giftPanelOnlyShowsDock = !!byTestId("db-gift-total");
    out.giftPanelOnlyKeepsStreamOff = !rowWith("投喂 小心心");
    // db-gift-total 是**礼物栏的总计条**（data-pane-head，折叠态唯一一行）；它本身不是按钮，
    // 展开/收起入口是它右端的 db-gift-toggle（见 docs/ui.md §5.3）。
    byTestId("db-gift-toggle").click();
    await sleep(350);
    out.giftPanelOnlyRendersAllRows = allByTestId("db-gift-row").length === 5;
    // 回到默认（两枚都开）：同样先开面板再点开关；开面板那一下已经把展开的礼物栏收起来了，
    // 因此这里不再点多一次（连点会把礼物栏又展开，下一段的「默认形态」就不是折叠态了）。
    // 后面几段（面板互斥 / 多标签）因此跑在**默认形态**上：筛选面板开着、礼物栏折叠着。
    clickTool("筛选");
    await sleep(300);
    out.giftSwitchBothBackOn = setGiftSwitch("弹幕包含礼物", true);
    await sleep(350);
    out.giftRestoredToDefault = !!byTestId("db-gift-total") && !byTestId("db-gift-area") &&
      !!rowWith("投喂 小心心") && window.__prefs["ui.gift_in_danmaku"] === true &&
      window.__prefs["ui.gift_panel"] === true;
    snap();

