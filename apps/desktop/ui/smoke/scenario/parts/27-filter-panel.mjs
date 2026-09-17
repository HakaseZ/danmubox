// 场景块：筛选与显示偏好面板 + step4/5/6
//   filter 筛选面板的两块表单是两列勾选清单（消息类型 6 项 + 辅助功能 6 枚开关）：列 / 行几何、不许横向滚动、不再是芯片样
//   六枚辅助开关逐枚点开再点回（偏好与复选框同步翻）、干净环境下画的即契约默认值、两块标题的视觉层级
//   字号滑杆只作用弹幕区；房间页这一档的主题对比度；时间戳在最右且逐行等宽
//   step4 系统类消息的白名单；step5 互动行 8 秒后自动消失；step6 关掉开关后常驻
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 筛选面板重排（item 11 + issue 2609160959 第 3 / 4 条）：两块 ——「消息类型」与
    //      「辅助功能」（关键词那一整块随 item 9 删除，主题下拉随 item 10 搬到列表页页头）。
    //      两块的表单**同一形态**：两列勾选清单（第 3 条要的就是这个，第 4 条把
    //      时间戳 / 互动消息自动消失 / 弹幕包含礼物 / 独立礼物栏四枚开关并进来）。
    out.filterPanelSections = filterPanel
      ? [].slice.call(filterPanel.querySelectorAll("h3")).map(function (h) { return h.innerText.trim(); })
      : [];
    out.filterPanelTwoBlocks = out.filterPanelSections.join(",") === "消息类型,辅助功能";
    out.filterPanelNoKeywords = !!filterPanel && filterPanel.innerText.indexOf("关键词") < 0;
    out.filterPanelNoThemeSelect = !!filterPanel &&
      !filterPanel.querySelector('[data-testid="db-pref-theme"]');
    // 两块各自按**稳定钩子**定位（不再靠 sections[0] / [1] 的下标）：db-filter-kinds /
    // db-filter-aux 是本次新增的 data-testid（docs/ui.md §8.5）。
    //      「消息类型」= 6 项（契约 §8 的 kind 全集）；「辅助功能」= 字号滑杆 + **六枚**复选框。
    //      文案由下面的 step4 / step6 / gift / cheapgift 四段用 clickLabelIn / setGiftSwitch 点到
    //      （点得到就说明文案在），这里只列文案并数控件，不解析 select 的 innerText。
    var kindsSection = byTestId("db-filter-kinds");
    var auxSection = byTestId("db-filter-aux");
    var labelsOf = function (root) {
      return root ? [].slice.call(root.querySelectorAll("label")) : [];
    };
    var kindLabels = labelsOf(kindsSection);
    out.filterPanelKindItems = kindLabels.map(function (l) { return l.innerText.trim(); });
    out.filterPanelKindItemsComplete = out.filterPanelKindItems.length === 6;
    // 六项的**文案**（契约 §8 的 KIND_LABEL）：系统那一项就在这里，step4 点它。
    // 字段名从 *KindChips 改成 *KindItems：那个形态（芯片）正是本批删掉的（第 3 条），
    // 留着旧名字等于让快照撒谎。
    out.filterPanelKindLabels =
      out.filterPanelKindItems.join(",") === "弹幕,礼物,SC,互动,大航海,系统";
    // 「辅助功能」块的控件清单：**旧的「礼物栏」下拉已随 issue 2609152029 第 1 条删除**
    // （字符串键 ui.gift_panel_mode 换成两枚布尔键），末两枚是低价礼物开关
    // （issue 2609162056 第 3 / 4 条），所以这里数的是六枚复选框，并另外
    // 钉住「select 一个都不剩」；字号滑杆仍在（它只是排布换成了整行）。
    var auxLabels = labelsOf(auxSection).filter(function (l) {
      return !!l.querySelector('input[type="checkbox"]');
    });
    out.filterPanelAuxLabels = auxLabels.map(function (l) { return l.innerText.trim(); });
    out.filterPanelAuxControls = {
      fontScale: !!auxSection && !!auxSection.querySelector('input[type="range"]'),
      switches: auxLabels.length,
      selects: auxSection ? auxSection.querySelectorAll("select").length : 0,
    };
    out.filterPanelAuxSwitchesPresent =
      out.filterPanelAuxLabels.indexOf("弹幕包含礼物") >= 0 &&
      out.filterPanelAuxLabels.indexOf("独立礼物栏") >= 0 &&
      out.filterPanelAuxLabels.indexOf("折叠低价礼物") >= 0 &&
      out.filterPanelAuxLabels.indexOf("剔除低价礼物统计") >= 0;
    out.filterPanelAuxComplete = !!out.filterPanelAuxControls.fontScale &&
      out.filterPanelAuxControls.switches === 6 &&
      out.filterPanelAuxControls.selects === 0 &&
      out.filterPanelAuxSwitchesPresent;
    // 字号滑杆那一行**仍占满整行**（横跨两列，滑杆贴右）：两列清单里唯一的例外，也是
    // 最容易在改排布时被顺手压丢的一条（docs/ui.md §8.2 / §8.5）。
    var rangeLabel = labelsOf(auxSection).filter(function (l) {
      return !!l.querySelector('input[type="range"]');
    })[0];
    var rangeInput = rangeLabel ? rangeLabel.querySelector('input[type="range"]') : null;
    out.filterPanelRangeSpansRow = !!rangeLabel && !!auxSection && !!rangeInput &&
      rect(rangeLabel).width >= rect(auxSection).width - 2 &&
      rect(rangeInput).width >= rect(rangeLabel).width / 2;
    // ---- 两列清单的**几何**（第 3 / 4 条）：把一组 label 按**取整后的左边缘**分组 ——
    //      恰好 2 组、各组成员数相同、纵向分层，就是「两列」这个形态（不看 CSS 类名）。
    //      逐项落在哪一列（0 = 左 / 1 = 右）也记进快照：010101 = 按行铺（DOM 序 = 阅读序，
    //      Tab 顺序与目视一致），000111 = 按列铺。两者都算两列，因此只记录、不当判据。
    var columnGeometry = function (items) {
      var cols = [];
      items.forEach(function (el) {
        var left = Math.round(rect(el).left);
        var hit = null;
        for (var i = 0; i < cols.length; i += 1) {
          if (Math.abs(cols[i].left - left) < 2) hit = cols[i];
        }
        if (!hit) { hit = { left: left, items: [] }; cols.push(hit); }
        hit.items.push(el);
      });
      cols.sort(function (a, b) { return a.left - b.left; });
      var rows = [];
      items.forEach(function (el) {
        var top = Math.round(rect(el).top);
        if (rows.indexOf(top) < 0) rows.push(top);
      });
      return {
        columns: cols.length,
        rows: rows.length,
        perColumn: cols.map(function (c) { return c.items.length; }).join("/"),
        order: items.map(function (el) {
          return cols.length === 2 && Math.abs(rect(el).left - cols[1].left) < 2 ? 1 : 0;
        }).join(""),
      };
    };
    out.filterPanelKindGeom = columnGeometry(kindLabels);
    out.filterPanelAuxGeom = columnGeometry(auxLabels);
    var twoColumnsEven = function (geom, perColumn, order) {
      return !!geom && geom.columns === 2 && geom.rows === order.length / 2 &&
        geom.perColumn === perColumn && geom.order === order;
    };
    out.filterPanelKindsTwoColumns = twoColumnsEven(out.filterPanelKindGeom, "3/3", "010101");
    // 辅助功能的六枚开关：三行两列（DOM 序 010101 —— 末一行是「折叠低价礼物 / 剔除低价礼物统计」）
    out.filterPanelAuxTwoColumns = twoColumnsEven(out.filterPanelAuxGeom, "3/3", "010101");
    out.filterPanelTwoColumnLists = out.filterPanelKindsTwoColumns && out.filterPanelAuxTwoColumns;
    // ---- 「不要使用现在的按钮形式」（第 3 条）：清单里每一项都是**朴素的复选框 + 文字** ——
    //      没有旧芯片那层底色与描边（旧样式给 label 上 --bg-input 底 + 1px 描边 + 胶囊圆角），
    //      两块里也一个 button 都没有；两块的形态还必须**逐项一致**（第 4 条要的是同一形态）。
    var labelForm = function (l) {
      var lcs = getComputedStyle(l);
      return [lcs.backgroundColor, lcs.borderTopWidth, lcs.borderBottomWidth, lcs.display].join("|");
    };
    out.filterPanelKindLabelBackground = kindLabels.length > 0
      ? getComputedStyle(kindLabels[0]).backgroundColor : null;
    var plain = function (list) {
      return list.length > 0 && list.every(function (l) {
        var lcs = getComputedStyle(l);
        return lcs.backgroundColor === "rgba(0, 0, 0, 0)" &&
          parseFloat(lcs.borderTopWidth) === 0 &&
          !!l.querySelector('input[type="checkbox"]') &&
          l.querySelectorAll("input").length === 1;
      });
    };
    out.filterPanelPlainCheckboxList = plain(kindLabels) && plain(auxLabels);
    out.filterPanelSameFormBothLists = kindLabels.length > 0 &&
      kindLabels.concat(auxLabels).every(function (l) {
        return labelForm(l) === labelForm(kindLabels[0]);
      });
    out.filterPanelNoButtons = !!filterPanel && filterPanel.querySelectorAll("button").length === 0;
    // 两列清单不许把面板撑出横向滚动（窄屏 360 是这条的边界值，§9.1）
    out.filterPanelNoHorizontalOverflow = !!filterPanel &&
      filterPanel.scrollWidth <= filterPanel.clientWidth + 1;
    // ---- 「默认勾选」（issue 2609160959 第 2 条）：本页跑在**干净环境**里 —— mock 的偏好
    //      就是契约 §8 的默认值（ui.interact_auto_hide = true、ui.show_timestamp = false），
    //      没有任何本机覆盖，因此这两枚复选框必须照实画成「互动消息自动消失 = 勾上 /
    //      时间戳 = 未勾」。它们同时守住「复选框的形态与偏好值一致」这条渲染路径。
    var auxBoxOf = function (label) {
      var picked = auxLabels.filter(function (l) { return l.innerText.trim() === label; })[0];
      return picked ? picked.querySelector('input[type="checkbox"]') : null;
    };
    var autoHideBox = auxBoxOf("互动消息自动消失");
    var timestampBox = auxBoxOf("时间戳");
    out.filterPanelAutoHideCheckedByDefault = !!autoHideBox && autoHideBox.checked &&
      window.__prefs["ui.interact_auto_hide"] === true;
    out.filterPanelTimestampUncheckedByDefault = !!timestampBox && !timestampBox.checked &&
      window.__prefs["ui.show_timestamp"] === false;
    // ---- 六枚辅助开关**逐枚真的能切**（第 4 条 + issue 2609162056 第 3 / 4 条）：点一下偏好跟着翻、
    //      复选框跟着画，再点一下回到原值 —— 因此后面各段（时间戳 / step4 / step5 / step6 / gift
    //      四种组合 / cheapgift）跑在**与改前完全相同的默认形态**上，切完行为不变这件事由那些
    //      既有断言继续钉住。末两枚低价礼物开关的「默认关」与行为量值在 cheapgift 那一段。
    var auxSpecs = [
      { label: "时间戳", key: "ui.show_timestamp" },
      { label: "互动消息自动消失", key: "ui.interact_auto_hide" },
      { label: "弹幕包含礼物", key: "ui.gift_in_danmaku" },
      { label: "独立礼物栏", key: "ui.gift_panel" },
      { label: "折叠低价礼物", key: "ui.gift_collapse_cheap" },
      { label: "剔除低价礼物统计", key: "ui.gift_exclude_cheap_stats" },
    ];
    var auxTogglesOk = true;
    var auxToggleReport = [];
    for (var ai = 0; ai < auxSpecs.length; ai += 1) {
      var spec = auxSpecs[ai];
      var box = auxBoxOf(spec.label);
      if (!box) { auxTogglesOk = false; auxToggleReport.push(spec.label + ":missing"); continue; }
      var before = window.__prefs[spec.key];
      box.click();
      await sleep(250);
      var flippedOk = window.__prefs[spec.key] === !before && box.checked === !before;
      box.click();
      await sleep(250);
      var restoredOk = window.__prefs[spec.key] === before && box.checked === before;
      auxTogglesOk = auxTogglesOk && flippedOk && restoredOk;
      auxToggleReport.push(spec.label + " " + String(before) + "->" + String(!before) + "->" +
        String(before) + (flippedOk && restoredOk ? "" : " FAIL"));
    }
    out.filterPanelAuxToggles = auxTogglesOk;
    out.filterPanelAuxToggleReport = auxToggleReport.join(" / ");
    // ---- 两块标题的**视觉层级**（issue 2609162056 第 5 条：格式变更醒目一些）：标题要比
    //      它自己的清单项醒目。只量视觉层级 —— 文案与结构由 filterPanelTwoBlocks（「消息类型,
    //      辅助功能」逐字）与 filterPanelSections 钉着，这一组不碰它们。
    //      四条判据：字号更大、字重 ≥ 700 且不轻于清单项、字色是正文色 --fg（改前是次级
    //      --fg-dim）、底部有一条 ≥ 1px 的分隔线（清单项一条都没有）。
    var cheapCssColorOf = function (name) {
      var probe = document.createElement("span");
      probe.style.color = "var(" + name + ")";
      document.body.appendChild(probe);
      var value = getComputedStyle(probe).color;
      probe.parentNode.removeChild(probe);
      return value;
    };
    var titleStyleOf = function (section, labelList) {
      var h = section ? section.querySelector("h3") : null;
      var first = labelList[0];
      if (!h || !first) return null;
      var hcs = getComputedStyle(h);
      var lcs = getComputedStyle(first);
      return {
        text: h.innerText.trim(),
        size: parseFloat(hcs.fontSize),
        weight: parseInt(hcs.fontWeight, 10) || 0,
        color: hcs.color,
        borderBottom: parseFloat(hcs.borderBottomWidth) || 0,
        labelSize: parseFloat(lcs.fontSize),
        labelWeight: parseInt(lcs.fontWeight, 10) || 0,
        labelColor: lcs.color,
        labelBorderBottom: parseFloat(lcs.borderBottomWidth) || 0,
      };
    };
    var kindTitleStyle = titleStyleOf(kindsSection, kindLabels);
    var auxTitleStyle = titleStyleOf(auxSection, auxLabels);
    out.filterPanelTitleStyles = { kinds: kindTitleStyle, aux: auxTitleStyle };
    out.filterPanelTitlesProminent = !!kindTitleStyle && !!auxTitleStyle &&
      kindTitleStyle.size > kindTitleStyle.labelSize &&
      auxTitleStyle.size > auxTitleStyle.labelSize &&
      kindTitleStyle.weight >= 700 && auxTitleStyle.weight >= 700 &&
      kindTitleStyle.weight > kindTitleStyle.labelWeight &&
      auxTitleStyle.weight > auxTitleStyle.labelWeight &&
      kindTitleStyle.color === cheapCssColorOf("--fg") &&
      auxTitleStyle.color === cheapCssColorOf("--fg") &&
      kindTitleStyle.color !== cheapCssColorOf("--fg-dim") &&
      auxTitleStyle.color !== cheapCssColorOf("--fg-dim") &&
      kindTitleStyle.borderBottom >= 1 && auxTitleStyle.borderBottom >= 1 &&
      kindTitleStyle.labelBorderBottom === 0 && auxTitleStyle.labelBorderBottom === 0;
    out.filterPanelTitleCopyUnchanged = !!kindTitleStyle && !!auxTitleStyle &&
      kindTitleStyle.text === "消息类型" && auxTitleStyle.text === "辅助功能";
    snap();
    // ---- item 8：短语与筛选面板同样没有标题与关闭按钮（db-panel-close 钩子整个界面不再提供），
    //      高度与表情面板同源（--panel-h）——逐个数进快照，最后比三者相等。
    out.filterPanelCloseGone = !!filterPanel &&
      filterPanel.querySelectorAll('[data-testid="db-panel-close"]').length === 0 &&
      document.querySelectorAll('[data-testid="db-panel-close"]').length === 0;
    out.filterPanelHeightPx = filterPanel ? f1(rect(filterPanel).height) : null;
    // ---- 字号滑杆只作用**弹幕区**（用户 2026-09-14：「字号只作用弹幕区」）：滑杆写的
    //      ui.font_scale 由 MessageList 落成 scroller 上的 font-size: scale em，行的尺寸
    //      全部按 em 派生 —— 面板不在 scroller 里，它的字号与 --panel-h（= 面板高度）是**常数**。
    //      这里直接拨 scroller 的字号量一次（与下面 rowScaleProbe 同一个手法，量完立刻还原）：
    //      正文的字号跟着变，面板的字号 / 高度必须纹丝不动。
    var scaleScroller = byTestId("db-chat-scroll");
    var scaleRowBody = byTestId("db-msg-body");
    var scalePanelFont0 = filterPanel ? getComputedStyle(filterPanel).fontSize : null;
    var scalePanelH0 = filterPanel ? rect(filterPanel).height : null;
    var scaleRowFont0 = scaleRowBody ? parseFloat(getComputedStyle(scaleRowBody).fontSize) : NaN;
    var scaleFontPrev = scaleScroller ? scaleScroller.style.fontSize : "";
    // 同步量：**不 await** —— 与下面 rowScaleProbe 一样，改了 inline font-size 立刻读计算值
    // （中间留窗口反而给 React 重渲染把这一行改回去的机会，会把「跟随」判成假失败）
    if (scaleScroller) scaleScroller.style.fontSize = "1.6em";
    out.panelFontConstantUnderScale = scalePanelFont0 !== null && !!filterPanel &&
      getComputedStyle(filterPanel).fontSize === scalePanelFont0;
    out.panelHeightConstantUnderScale = scalePanelH0 !== null && !!filterPanel &&
      Math.abs(rect(filterPanel).height - scalePanelH0) < 1;
    out.chatFontFollowsScale = !!scaleRowBody && !isNaN(scaleRowFont0) &&
      parseFloat(getComputedStyle(scaleRowBody).fontSize) > scaleRowFont0;
    if (scaleScroller) scaleScroller.style.fontSize = scaleFontPrev;
    await sleep(250);
    // ---- theme 对比度（房间页这一档）：主题开关已搬到列表页页头（item 10，见 step1），
    //      房间页不再切档，只按**本次运行的那一档**判「正文 / 昵称对背景 ≥ 4.5:1」。
    //      SMOKE_THEMES 深浅各跑一遍，两档因此都成立；开关本身的断言在 step1 那一步。
    var themeBodyBg = getComputedStyle(document.body).backgroundColor;
    var themeBodyColor = getComputedStyle(document.body).color;
    var themeNameEl = document.querySelector('[data-testid="db-msg-name"]');
    out.themeBaseContrastBody = contrastRatio(themeBodyColor, themeBodyBg);
    out.themeBaseContrastDim = contrastRatio(
      themeNameEl ? getComputedStyle(themeNameEl).color : "", themeBodyBg);
    out.themeContrastBodyOk = out.themeBaseContrastBody >= 4.5;
    out.themeContrastDimOk = out.themeBaseContrastDim >= 4.5;
    // ---- time 时间戳（用户 2026-09-14：「时间戳显示时放在最右边」）：它是**身份行的最后一格**、
    //      靠右 —— 不再是行首的一列（旧版正文块因此被扣掉 --time-col 与一道间距）。
    //      参考系跟着换：从「行内列对齐」换成「**正文块的右边缘**」。没有身份行的行
    //      （system / 空昵称无徽标）里时间是正文块内的「只有时间」首行（见下面 step4）。
    //      量「开关前」的正文几何要先来：开关关了它才是**不扣那一列**的基准。
    var tsProbeRow0 = rowWith(timeoutText);
    var tsProbeBody0 = tsProbeRow0 ? tsProbeRow0.querySelector('[data-testid="db-msg-body"]') : null;
    var tsBodyLeft0 = tsProbeBody0 ? rect(tsProbeBody0).left : null;
    var tsBodyWidth0 = tsProbeBody0 ? rect(tsProbeBody0).width : null;
    clickLabelIn(filterPanel, "时间戳");
    await sleep(400);
    var cells = allByTestId("db-msg-time").map(function (el) { return el.getBoundingClientRect(); });
    out.timeCellsShown = cells.length;
    out.timeWidthsEqual = cells.length > 0 && cells.every(function (r) { return Math.abs(r.width - cells[0].width) < 0.6; });
    var tsRows = rows().map(function (r) {
      var t = r.querySelector('[data-testid="db-msg-time"]');
      var identity = r.querySelector('[data-testid="db-msg-identity"]');
      var body = r.querySelector('[data-testid="db-msg-body"]');
      return t ? {
        time: t,
        identity: identity,
        bodyBox: body ? rect(body) : null,
        box: rect(t),
        inIdentity: !!identity && identity.lastElementChild === t
      } : null;
    }).filter(Boolean);
    // 有身份行的行：时间是 identity 的**最后一个孩子**（且那一行至少得有一条，否则这条断言空转）
    out.timeInsideIdentityRow = tsRows.length > 0 && tsRows.every(function (p) { return p.inIdentity; });
    // 右边缘：每行的时间右边缘 = **该行正文块的右边缘**（时间落在 identity 内、靠右推到底），
    // 且逐行彼此相等（等宽 + 右对齐 = 纵向对齐那一格）
    out.timeRightEdgesEqual = tsRows.length > 0 && tsRows.every(function (p) {
      return !!p.bodyBox && Math.abs(p.box.right - p.bodyBox.right) < 0.6;
    }) && cells.length > 0 && cells.every(function (r) { return Math.abs(r.right - cells[0].right) < 0.6; });
    // 正文块不因时间戳挪位 / 变窄（旧版占掉行首一列，正文块整体右移且窄掉）
    var tsProbeRow1 = rowWith(timeoutText);
    var tsProbeBody1 = tsProbeRow1 ? tsProbeRow1.querySelector('[data-testid="db-msg-body"]') : null;
    out.bodyLeftUnaffectedByTimestamp = tsBodyLeft0 !== null && !!tsProbeBody1 &&
      Math.abs(rect(tsProbeBody1).left - tsBodyLeft0) < 0.6;
    out.bodyWidthUnaffectedByTimestamp = tsBodyWidth0 !== null && !!tsProbeBody1 &&
      Math.abs(rect(tsProbeBody1).width - tsBodyWidth0) < 0.6;
    // 窄屏 360：正文宽仍占视口一半以上（时间戳挪走后「文字挤在右边」那个毛病不许回来）
    if (NARROW) {
      put("bodyWidthAtLeastHalfViewport", !!tsProbeBody1 &&
        rect(tsProbeBody1).width >= window.innerWidth / 2);
    }
    // 超长昵称：可收缩的是**昵称**（省略号），时间那一格 flex: none 不可压 —— 它必须完整
    // 落在身份行内（不被 identity 的 overflow: hidden 切掉），宽度也不许被压扁。
    var longNick = "超长昵称样本一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉";
    window.__emit("danmubox://message", window.__mk("danmaku", "超长昵称样本弹幕", false, { uname: longNick }));
    await sleep(350);
    var longNickRow = rowWith("超长昵称样本弹幕");
    var longNickIdentity = longNickRow ? longNickRow.querySelector('[data-testid="db-msg-identity"]') : null;
    var longNickTime = longNickRow ? longNickRow.querySelector('[data-testid="db-msg-time"]') : null;
    out.timeNotClippedByLongIdentity = !!longNickIdentity && !!longNickTime && cells.length > 0 &&
      Math.abs(rect(longNickTime).width - cells[0].width) < 0.6 &&
      rect(longNickTime).right <= rect(longNickIdentity).right + 0.6;
    // 开了时间戳也不许把行撑出横向滚动（昵称省略号 + 正文就地断行的另一半）
    out.rowNoHorizontalOverflowWithTimestamp = rows().length > 0 &&
      rows().every(function (r) { return r.scrollWidth <= r.clientWidth + 1; });
    snap();

    // ---- step4 系统类白名单（语义不得改）：勾上「消息类型 → 系统」之后**新来**的系统行要出现。
    //      这里点的**不再是**「系统通知」那枚开关（ui.system_notice 已随 item 1 删除，两个门
    //      盖的消息集合逐字相同）：辅助功能块只剩「时间戳」「互动消息自动消失」，面板里没有第二条
    //      label 含「系统」二字，因此点到的必然是「消息类型」里那一项「系统」。
    //      这里不拿很早以前那条（它已滚出虚拟列表的渲染范围），改发一条新的，断言更硬。
    out.step4_toggledSystem = clickLabelIn(filterPanel, "系统");
    await sleep(400);
    window.__emit("danmubox://message", window.__mk("system", "分区变更二号"));
    await sleep(300);
    out.step4_kindsHasSystem = window.__prefs["filter.kinds"].indexOf("system") >= 0;
    out.step4_systemRenderedAfterToggle = text().indexOf("分区变更二号") >= 0;
    // 系统行**没有身份行**（kind === "system" 不画）：时间独占正文块的**首行**，正文仍在下一行
    var sysRow = rowWith("分区变更二号");
    var sysText = sysRow ? sysRow.querySelector('[data-testid="db-msg-identity"]') : null;
    var sysTime = sysRow ? sysRow.querySelector('[data-testid="db-msg-time"]') : null;
    var sysBody = sysRow ? sysRow.querySelector('[data-testid="db-msg-body"]') : null;
    out.timeOnOwnLineWhenNoIdentity = !!sysRow && sysTime !== null && sysBody !== null &&
      sysText === null && sysTime.previousElementSibling === null &&
      sysTime.parentElement === sysBody.parentElement &&
      rect(sysTime).bottom <= rect(sysBody).top + 1;
    // 无身份行的那一格同样靠右（.time 的定宽 + margin-left: auto 在块级盒上推到底），
    // 右边缘与身份行里那一格同列（参照仍是正文块的右边缘）
    out.timeRightAlignedWithoutIdentity = !!sysTime && !!sysBody &&
      Math.abs(rect(sysTime).right - rect(sysBody).right) < 0.6;
    snap();

    // ---- step5 互动行 8 秒后自动消失（语义不得改）。这段等待同时也盖过了前面那条超时兜底
    //      （发送 → 这里 ≈ 14s > 8s），所以「未确认」在同一格验掉，不额外增加一轮的墙钟时间。
    await sleep(8600);
    timeoutRow = rowWith(timeoutText);
    var timeoutMark = timeoutRow
      ? timeoutRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.sendTimeoutMarkedUnconfirmed = !!timeoutMark &&
      timeoutMark.getAttribute("data-state") === "unconfirmed" &&
      timeoutMark.innerText.indexOf("未确认") >= 0;
    out.step5_interactGoneAfter8s = text().indexOf("进入直播间") < 0;
    snap();

    // ---- step6 关掉开关则常驻（语义不得改）
    out.step6_toggledAutoHide = clickLabelIn(filterPanel, "互动消息自动消失");
    await sleep(300);
    window.__emit("danmubox://message", window.__mk("interact", ""));
    await sleep(8600);
    out.step6_prefAutoHide = window.__prefs["ui.interact_auto_hide"];
    out.step6_interactPersistsWhenOff = text().indexOf("进入直播间") >= 0;
    snap();

