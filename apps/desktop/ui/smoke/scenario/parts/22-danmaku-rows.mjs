// 场景块：弹幕行排版取证
//   真实夹具派生行的排版（正文起点、折行、可用宽度）、无空格长 ASCII 串就地断开
//   行内通用表情的渲染盒 vs 文字高、表情不吃字号、头像 512 原图不撑爆
//   ＠ 高亮与「回复 @某人」牌子、身份行（昵称在前、身份牌在右）、悬挂缩进、头像顶边 = 身份行顶边
//   尺度（头像 / 身份牌 / 表情同一条基准）、字号滑杆联动、昵称颜色（两套主题都要能读）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 真实夹具派生行的排版取证（用户 2026-09-12：「文字全挤在右边，没法往用户名 / 身份牌
    //      下方换行」，并判断「是之前调表情的格式导致的」）。
    // 量四件事：① 行可用宽度与正文列宽度；② 正文起点 x 与折行行数（Range 按**行盒**返回矩形）；
    // ③ 行内表情图的**渲染盒**与**原图尺寸**（渲染盒跟着原图走 = 第三次同款错误）；
    // ④ 行 / 正文列有没有横向溢出。
    var f1 = function (v) { return Math.round(v * 10) / 10; };
    var fixtureMetricsOf = function (row) {
      if (!row) return null;
      var body = row.querySelector('[data-testid="db-msg-body"]');
      var identity = row.querySelector('[data-testid="db-msg-identity"]');
      var img = body ? body.querySelector("img") : null;
      var rowBox = rect(row);
      var bodyBox = rect(body);
      var lines = [];
      if (body) {
        var range = document.createRange();
        range.selectNodeContents(body);
        lines = [].slice.call(range.getClientRects());
      }
      var imgBox = rect(img);
      var imgStyle = img ? getComputedStyle(img) : null;
      return {
        rowW: f1(rowBox ? rowBox.width : 0),
        rowLeft: f1(rowBox ? rowBox.left : 0),
        bodyLeft: f1(bodyBox ? bodyBox.left : 0),
        bodyRight: f1(bodyBox ? bodyBox.right : 0),
        bodyTop: f1(bodyBox ? bodyBox.top : 0),
        bodyW: f1(bodyBox ? bodyBox.width : 0),
        identityW: identity ? f1(rect(identity).width) : null,
        identityLeft: identity ? f1(rect(identity).left) : null,
        identityTop: identity ? f1(rect(identity).top) : null,
        identityH: identity ? f1(rect(identity).height) : null,
        lines: lines.length,
        lineLefts: lines.map(function (l) { return f1(l.left); }),
        firstLineLeft: lines.length > 0 ? f1(lines[0].left) : null,
        lastLineLeft: lines.length > 0 ? f1(lines[lines.length - 1].left) : null,
        imgW: imgBox ? f1(imgBox.width) : null,
        imgH: imgBox ? f1(imgBox.height) : null,
        // 原图尺寸：渲染盒若与它同进同退，说明尺寸还是被原图牵着走
        imgNaturalW: img ? img.naturalWidth : null,
        imgNaturalH: img ? img.naturalHeight : null,
        imgCssW: imgStyle ? imgStyle.width : null,
        imgCssH: imgStyle ? imgStyle.height : null,
        imgFit: imgStyle ? imgStyle.objectFit : null,
        rowOverflowPx: f1(Math.max(0, row.scrollWidth - row.clientWidth)),
        bodyOverflowPx: body ? f1(Math.max(0, body.scrollWidth - body.clientWidth)) : null
      };
    };
    var fixtureTextRow = rowWith(ROW_FIXTURES.text.content);
    // 表情包弹幕那一条没有可搜索的正文文本（正文被画成了图），按**图的 alt** 找它：
    // alt 就是表情名，也就是这条弹幕的「正文」。
    var fixtureEmoteRow = rows().filter(function (r) {
      var img = r.querySelector('[data-testid="db-msg-body"] img');
      return !!img && img.alt === ROW_FIXTURES.emoticon.content;
    })[0];
    out.fixtureTextRow = fixtureMetricsOf(fixtureTextRow);
    out.fixtureEmoteRow = fixtureMetricsOf(fixtureEmoteRow);
    out.fixtureRowsRendered = !!fixtureTextRow && !!fixtureEmoteRow;
    // 正文不许越出自己那一列（「挤到右边 / 撑出去」的判据）：行与正文列都不得横向溢出
    out.fixtureTextNoOverflow = !!out.fixtureTextRow &&
      out.fixtureTextRow.rowOverflowPx === 0 && out.fixtureTextRow.bodyOverflowPx === 0;
    // 正文必须拿到**整行宽度**（≥ 视口的一半，用户 2026-09-13）：
    // 改前是「身份簇 ｜ 正文」两列，360 宽下身份簇列 182.7px（占正文块 56%）、正文列只剩
    // 112.4px —— 用户的「长文本弹幕自动换行还是没有实现好」就是它。改后正文另起一行。
    // 量的是**视口**的一半（不是「正文块的一半」）：那才是用户眼睛看到的宽度。
    var fixtureBodyEl = fixtureTextRow
      ? fixtureTextRow.querySelector('[data-testid="db-msg-body"]')
      : null;
    var fixtureBlockEl = fixtureBodyEl ? fixtureBodyEl.parentElement : null;
    var fixtureBlockBox = rect(fixtureBlockEl);
    out.fixtureTextBlockPx = fixtureBlockBox ? f1(fixtureBlockBox.width) : null;
    out.fixtureTextBodyShareOfViewport = out.fixtureTextRow
      ? f1(out.fixtureTextRow.bodyW / window.innerWidth)
      : null;
    out.fixtureTextBodyKeepsHalfViewport = !!out.fixtureTextRow &&
      out.fixtureTextRow.bodyW >= window.innerWidth / 2;
    // 正文的行宽 = 正文块的宽度减去那一道行内左边距（--sp-1 已经在头像列上，这里应是 0）
    out.fixtureTextBodyFillsBlock = !!out.fixtureTextRow && out.fixtureTextBlockPx !== null &&
      out.fixtureTextBlockPx - out.fixtureTextRow.bodyW < 1;
    // 悬挂缩进 = 正文左边缘与**用户名**左边缘一致（上下两行共用同一个左起点）
    out.fixtureBodyAlignedWithName = !!out.fixtureTextRow &&
      out.fixtureTextRow.identityLeft !== null &&
      Math.abs(out.fixtureTextRow.bodyLeft - out.fixtureTextRow.identityLeft) < 1;
    // 正文在身份行**下面**（另起一行）：正文顶边 ≥ 身份行底边
    out.fixtureBodyOnSecondRow = !!out.fixtureTextRow &&
      out.fixtureTextRow.identityTop !== null && out.fixtureTextRow.identityH !== null &&
      out.fixtureTextRow.bodyTop >= out.fixtureTextRow.identityTop + out.fixtureTextRow.identityH - 1;
    // 「能换行」在**窄屏**上量（360 = 窗口最小宽度，也就是可达面的边界）：折成 ≥2 个行盒，
    // 且**每一行**都与首行左对齐（悬挂缩进）——不是被挤到右侧去、也不是回到头像下面。
    out.fixtureTextWrapLineLefts = out.fixtureTextRow
      ? [out.fixtureTextRow.firstLineLeft, out.fixtureTextRow.lastLineLeft]
      : null;
    // 真实夹具那条正文只有 21 个字：正文拿到整行宽后，窄屏下一行就放得下了 —— 那不是失败，
    // 所以这里只断言「折行时每一行都与首行左对齐」；「窄屏下长正文折 ≥2 行」由下面
    // layoutHangIndent* 那组在**足够长**的样本上断言（用户 2026-09-13 的第 ② 条）。
    out.fixtureTextLinesAlignWhenWrapped = !!out.fixtureTextRow &&
      out.fixtureTextRow.lineLefts.every(function (l) {
        return Math.abs(l - out.fixtureTextRow.firstLineLeft) < 1;
      });
    // ---- 无空格的长 ASCII 串（真实载荷里的 CDN 地址，用户 2026-09-13）：就地断开、
    //      不许把行撑出横向滚动。窄屏下它必然放不进一行，所以「断了」是量得出来的；
    //      宽屏下放得下就不断——两种情形都只要求**不溢出**。
    var asciiRow = rowWith(ROW_ASCII);
    out.fixtureAsciiRow = fixtureMetricsOf(asciiRow);
    out.fixtureAsciiNoOverflow = !!out.fixtureAsciiRow &&
      out.fixtureAsciiRow.rowOverflowPx === 0 && out.fixtureAsciiRow.bodyOverflowPx === 0;
    // 正文的右边缘不许越出行（行盒 scrollWidth ≤ clientWidth 的另一半：几何上也在里面）
    out.fixtureAsciiInsideRow = !!out.fixtureAsciiRow &&
      out.fixtureAsciiRow.bodyRight <= out.fixtureAsciiRow.rowLeft + out.fixtureAsciiRow.rowW + 1;
    // 断开点必须落在正文块内部：行内最长的一行长（= 正文宽度）不超出行宽
    out.fixtureAsciiWrapsWhenNarrow = !NARROW || (!!out.fixtureAsciiRow &&
      out.fixtureAsciiRow.lines >= 2);


    // 行内表情图的**盒子**不许跟着原图走：同一个尺寸档里，200×60 的横条（通用表情样本，
    // 取自 emotes.json 的真实尺寸）与 162×162 的方图（夹具里的表情包弹幕）必须渲染成同一个盒。
    // 只给 height 的话宽度会按原图比例算出来 —— 改前实测：横条那条 23.1px 高 / 77px 宽。
    // 样本行按**图的 alt** 找（它的正文被画成了图，innerText 里没有那条文本）。
    var inlineSampleRow = rows().filter(function (r) {
      var img = r.querySelector('[data-testid="db-msg-body"] img');
      return !!img && img.alt === "行内表情样本";
    })[0];
    var inlineSampleImg = inlineSampleRow
      ? inlineSampleRow.querySelector('[data-testid="db-msg-body"] img')
      : null;
    var inlineSampleBody = inlineSampleRow
      ? inlineSampleRow.querySelector('[data-testid="db-msg-body"]')
      : null;
    var lineBoxPxHere = inlineSampleBody
      ? parseFloat(getComputedStyle(inlineSampleBody).lineHeight)
      : NaN;
    var inlineSampleBox = rect(inlineSampleImg);
    out.rowInlineEmoteBox = inlineSampleBox
      ? { w: f1(inlineSampleBox.width), h: f1(inlineSampleBox.height), naturalW: inlineSampleImg.naturalWidth,
          naturalH: inlineSampleImg.naturalHeight, fit: getComputedStyle(inlineSampleImg).objectFit }
      : null;
    // ---- 行内通用表情的**渲染盒 vs 文字高**取证（用户 2026-09-13 第 7 条：
    //      「通用表情在弹幕里渲染得有点小，看起来是当成文本渲染了」）。
    //      通用表情的原图是 200×60 的**横条**：见方盒 + contain 之后，可见高度只有盒宽的 30%。
    //      这里把「盒」「原图」「正文行高」「一行文字的墨迹高」四个数一起记下来。
    var textInkProbe = (function () {
      var probe = document.createElement("span");
      probe.textContent = "字";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      inlineSampleBody.appendChild(probe);
      var box = rect(probe);
      var result = { h: f1(box.height), fontSize: getComputedStyle(probe).fontSize };
      probe.parentNode.removeChild(probe);
      return result;
    })();
    out.rowInlineEmoteContext = inlineSampleBox ? {
      boxW: f1(inlineSampleBox.width),
      boxH: f1(inlineSampleBox.height),
      naturalW: inlineSampleImg.naturalWidth,
      naturalH: inlineSampleImg.naturalHeight,
      visibleRatioW: Math.round((inlineSampleBox.width / inlineSampleImg.naturalWidth) * 1000) / 1000,
      bodyLinePx: Math.round(lineBoxPxHere * 10) / 10,
      // 1em 在这里是多少：字号的 px 值（「比普通文字高」的基准）
      emPx: parseFloat(getComputedStyle(inlineSampleBody).fontSize),
      // 图**画出来**的高度（contain 之后）：盒与横条同比例时它就等于盒高
      visibleH: f1(Math.min(
        inlineSampleBox.height,
        inlineSampleBox.width / (inlineSampleImg.naturalWidth / inlineSampleImg.naturalHeight),
      )),
      emTokenPx: (function () {
        var v = getComputedStyle(inlineSampleBody).getPropertyValue("--emote");
        return v.trim();
      })(),
      textInkPx: textInkProbe.h,
      imgTop: f1(rect(inlineSampleImg).top),
      bodyTop: f1(rect(inlineSampleBody).top),
      bodyBottom: f1(rect(inlineSampleBody).bottom),
      rowH: f1(rect(inlineSampleRow).height),
    } : null;
    // 改后（用户 2026-09-13 第 7 条）：通用表情在行内拿到**与它原图长宽比相称的宽盒** ——
    // 高度仍是 --emote（= 1.1 × 行盒），宽度写成固定的 10:3 算式。三条一起判：
    // ① 盒高 = 1.1 × 行盒（不是 1em，也不是原图高度）；② 宽高比 = 10:3（横条正好填满盒）；
    // ③ 画出来的高度**大于 1em**（= 字号）—— 这就是「别当成文本渲染」的可验形式。
    out.rowInlineEmoteWideBox = !!inlineSampleBox && !isNaN(lineBoxPxHere) &&
      Math.abs(inlineSampleBox.height - lineBoxPxHere * 1.1) < 0.6 &&
      Math.abs(inlineSampleBox.width / inlineSampleBox.height - 10 / 3) < 0.06;
    out.rowInlineEmoteTallerThanText = !!out.rowInlineEmoteContext &&
      out.rowInlineEmoteContext.visibleH > out.rowInlineEmoteContext.emPx + 1 &&
      out.rowInlineEmoteContext.visibleH >= out.rowInlineEmoteContext.bodyLinePx - 0.6;
    // 宽盒也不许撑破行：盒右边缘仍在行内，行与正文块都没有横向溢出
    out.rowInlineEmoteFitsRow = !!inlineSampleRow && !!inlineSampleBox &&
      inlineSampleBox.right <= rect(inlineSampleRow).right + 1 &&
      Math.max(0, inlineSampleRow.scrollWidth - inlineSampleRow.clientWidth) === 0 &&
      Math.max(0, inlineSampleBody.scrollWidth - inlineSampleBody.clientWidth) === 0 &&
      getComputedStyle(inlineSampleImg).objectFit === "contain";
    // 夹具那条表情包弹幕（bulge：2 倍档）：同样是**见方 + contain** 的显式盒
    out.fixtureEmoteImgExplicitBox = !!out.fixtureEmoteRow && !isNaN(lineBoxPxHere) &&
      out.fixtureEmoteRow.imgFit === "contain" && out.fixtureEmoteRow.imgW !== null &&
      Math.abs(out.fixtureEmoteRow.imgW - out.fixtureEmoteRow.imgH) < 0.6 &&
      Math.abs(out.fixtureEmoteRow.imgH - lineBoxPxHere * 1.1 * 2) < 0.6;
    out.fixtureEmoteImgInsideColumn = !!out.fixtureEmoteRow &&
      out.fixtureEmoteRow.imgW !== null &&
      out.fixtureEmoteRow.imgW <= out.fixtureEmoteRow.bodyW + 1 &&
      out.fixtureEmoteRow.rowOverflowPx === 0;

    out.layoutAvatarColumnAligned =
      nameLefts.every(function (v) { return v !== null && Math.abs(v - nameLefts[0]) < 0.6; });
    // 粉丝牌配色：可观察面是行内 style 与计算样式（不依赖 CSS-module 类名）
    var medalBadgeOf = function (needle) {
      var row = rowWith(needle);
      if (!row) return null;
      var spans = [].slice.call(row.querySelectorAll("span"));
      for (var i = 0; i < spans.length; i += 1) {
        if ((spans[i].getAttribute("style") || "").indexOf("linear-gradient") >= 0) return spans[i];
      }
      return null;
    };
    var medalStyleText = function (badge) {
      if (!badge) return "";
      return (badge.getAttribute("style") || "") + "|" + getComputedStyle(badge).backgroundImage;
    };
    var trueMedalText = medalStyleText(medalBadgeOf("带真彩牌弹幕"));
    var fallbackMedalText = medalStyleText(medalBadgeOf("无真彩牌弹幕"));
    out.medalTrueColorApplied = trueMedalText.indexOf("#3FB4F699") >= 0 ||
      trueMedalText.indexOf("63, 180, 246") >= 0;
    out.medalFallbackGradientApplied = fallbackMedalText.indexOf("linear-gradient") >= 0 &&
      fallbackMedalText !== trueMedalText;
    // ---- @ 高亮（用户 2026-09-13 第 1 条）：身份行最后那枚「回复 @某人」的牌子与正文里
    //      自带的 @ 重复，牌子**删掉**；@ 改在**正文里**就地强调，配色**参照身份牌**的字符色。
    //      改前的取证：那枚牌子是 .replyTo 一格（文案「回复 @昵称」、弱化色 + 14% 灰底 +
    //      4px 圆角，排在身份牌右侧）—— 改前快照里的 replyLabelBox 就是它的几何。
    out.replyChipGone =
      document.querySelectorAll('[data-testid="db-msg-reply"], [data-testid="db-msg-reply-name"]')
        .length === 0;
    var replyRow = rowWith("这条是回复");
    var mentionOf = function (row) {
      return row ? row.querySelector('[data-testid="db-msg-mention"]') : null;
    };
    var replyMention = mentionOf(replyRow);
    out.mentionHighlighted = !!replyMention && replyMention.innerText === "@被回复的人";
    // 颜色 = **正文里的醒目可读色**（令牌 --mention），**不是**身份牌的文字色：用户 2026-09-13
    // 第二次实测「@的颜色之前不是粉色吗，白色看不清啊」—— 身份牌那枚白字是「彩底上的文字色」，
    // 照抄到正文里在深色下与正文近乎同色、在浅色下白压米色（1.2:1）干脆看不见。
    // 判据按「这件事在用户眼里成不成立」写，不用硬编码色值：
    // ① 两套主题下都对**所在面**（画布 --bg / 表面 --bg-elevated）≥ 4.5:1（正文档，深浅各跑一遍
    //    由 runner 的主题维度保证）；② 与正文色**不同**且**有彩**——「醒目」不能靠加底色或加粗。
    var mentionTokenColor = cssColorOf("--mention");
    var mentionColor = replyMention ? getComputedStyle(replyMention).color : "";
    var replyBodyEl = replyRow ? replyRow.querySelector('[data-testid="db-msg-body"]') : null;
    var mentionBodyColor = replyBodyEl ? getComputedStyle(replyBodyEl).color : "";
    out.mentionColor = mentionColor;
    out.mentionBodyColor = mentionBodyColor;
    out.mentionContrastOnCanvas = contrastRatio(mentionColor, cssColorOf("--bg"));
    out.mentionContrastOnSurface = contrastRatio(mentionColor, cssColorOf("--bg-elevated"));
    out.mentionSaturation = saturationOf(mentionColor);
    out.mentionColorVisible = mentionColor === mentionTokenColor &&
      out.mentionContrastOnCanvas >= 4.5 && out.mentionContrastOnSurface >= 4.5 &&
      mentionColor !== mentionBodyColor && out.mentionSaturation > 0.4;
    // 用户 2026-09-13 的更正：「高亮我要求的是使用字体颜色，不是背景」—— @ 那一格**只许有颜色**：
    // 底色 / 背景图都没有（上一版那层 45° 强调色渐变底已删），内边距与圆角也没加回来。
    var mentionStyle = replyMention ? getComputedStyle(replyMention) : null;
    // 同样不用正则（见上面 saturationOf 那条注）：这三种写法都是「没有底色」。
    var noPaint = function (value) {
      return value === "none" || value === "transparent" || value === "rgba(0, 0, 0, 0)" ||
        value.indexOf("0, 0, 0, 0") >= 0;
    };
    out.mentionNoBackground = !!mentionStyle &&
      noPaint(mentionStyle.backgroundImage) && noPaint(mentionStyle.backgroundColor) &&
      parseFloat(mentionStyle.paddingLeft) === 0 && parseFloat(mentionStyle.paddingRight) === 0 &&
      parseFloat(mentionStyle.borderTopLeftRadius) === 0;
    // 高亮认的是**正文**，不是回复关系：没有任何 reply_* 字段的那条照样高亮
    var plainMentionRow = rowWith("没有回复关系也");
    out.mentionWorksWithoutReply = !!mentionOf(plainMentionRow) &&
      mentionOf(plainMentionRow).innerText === "@路人乙";
    // 切分只加壳、不改字：正文的文字一个不丢（正文元素在上面量过一次，复用同一个）
    out.mentionBodyTextIntact = !!replyBodyEl &&
      replyBodyEl.innerText === "这条是回复 @被回复的人 你好";
    // 另一条回复（上游没给配色）也跟着高亮，且**没有**被上游色染过
    var noColorRow = rowWith("没有配色的回复");
    var noColorMention = mentionOf(noColorRow);
    out.mentionHighlightedWithoutUpstreamColor = !!noColorMention &&
      noColorMention.innerText === "@另一个被回复的人" &&
      getComputedStyle(noColorMention).color === mentionTokenColor;
    // 舰长标只认本房间的 guard_level：戴着别的房间舰长牌（medal_guard_level=3）不亮舰长标（issue #12）
    // 判据看**徽标元素本身**的文本（正文里出现「舰长」两字不算）
    var hasGuardBadge = function (row) {
      if (!row) return false;
      return [].slice.call(row.querySelectorAll("span")).some(function (s) {
        return s.innerText.trim() === "舰长";
      });
    };
    var outsideGuardRow = rowWith("他房间的牌子弹幕");
    var roomGuardRow = rowWith("本房间的大航海弹幕");
    out.guardBadgeNotFromMedalGuardLevel = !!outsideGuardRow && !hasGuardBadge(outsideGuardRow);
    out.guardBadgeShownForRoomGuard = hasGuardBadge(roomGuardRow);

    // ---- 身份行：**昵称在前、身份牌在昵称右侧**（参考图口径，用户 2026-09-13）；
    //      正文另起一行、左起点与昵称一致（不是被牌挤到右边去）。
    var badgeRow = rowWith("紧贴昵称的徽标弹幕");
    var badgesEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-badges"]') : null;
    var badgeNameEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-name"]') : null;
    var badgeBodyEl = badgeRow ? badgeRow.querySelector('[data-testid="db-msg-body"]') : null;
    out.layoutNameBadgeGap = badgesEl && badgeNameEl
      ? Math.round((rect(badgesEl).left - rect(badgeNameEl).right) * 10) / 10
      : null;
    // ---- 身份牌圆角取证（用户 2026-09-13 第 6 条：「圆角大一些，现在看着有点方」）。
    //      两族都量：房间牌（.badge，圆角 0.25em）与粉丝牌（同样挂在 .badge 上）。
    var cornerRadiusOf = function (el) {
      if (!el) return null;
      var cs = getComputedStyle(el);
      var box = rect(el);
      return {
        radiusPx: Math.round((parseFloat(cs.borderTopLeftRadius) || 0) * 10) / 10,
        heightPx: Math.round(box.height * 10) / 10,
        raw: cs.borderTopLeftRadius,
      };
    };
    out.badgeRadius = badgesEl ? cornerRadiusOf(badgesEl.children[0]) : null;
    out.medalBadgeRadius = badgesEl
      ? cornerRadiusOf([].slice.call(badgesEl.children).filter(function (el) {
          return (el.getAttribute("style") || "").indexOf("linear-gradient") >= 0;
        })[0])
      : null;
    // 用户 2026-09-13 第 6 条：「身份标识的圆角大一些，现在看着有点方」。
    // 改前圆角 0.25em（≈ 牌高的 18.5%，实测 3.5px / 牌高 18.9px），改后 0.45em（≈ 33%）。
    // 两条一起判：① 圆角**比改前大**（> 牌高的 25%）；② 仍是矩形不是胶囊（< 半高）。
    out.badgeRadiusGrew = (function () {
      var b = out.badgeRadius;
      if (!b || b.heightPx === 0) return false;
      var ratio = b.radiusPx / b.heightPx;
      return ratio > 0.25 && b.radiusPx > 4 && ratio < 0.5;
    })();
    out.badgeRadiusRatio = out.badgeRadius && out.badgeRadius.heightPx > 0
      ? Math.round((out.badgeRadius.radiusPx / out.badgeRadius.heightPx) * 1000) / 1000
      : null;
    out.layoutBadgeAfterName = !!badgesEl && !!badgeNameEl &&
      rect(badgesEl).left >= rect(badgeNameEl).right - 1;
    // 牌与名字之间是「贴」（--sp-1 = 4px），不许出现第三种间距
    out.layoutBadgeTightWithName = out.layoutNameBadgeGap !== null &&
      out.layoutNameBadgeGap <= 4.01 && out.layoutNameBadgeGap >= 0;
    // 身份行独占一行：正文顶边在身份行底边**之下**（同一行的两列排法已删除）
    out.layoutBodyBelowIdentity = !!badgeBodyEl && !!badgesEl &&
      rect(badgeBodyEl).top >= rect(badgesEl).bottom - 1;
    // 正文与昵称共用左边缘（悬挂缩进的另一半：正文不是接在牌后面）
    out.layoutBodyLeftAlignedWithName = !!badgeBodyEl && !!badgeNameEl &&
      Math.abs(rect(badgeBodyEl).left - rect(badgeNameEl).left) < 1;

    // ---- 悬挂缩进：折行后每一行的首字都与首行的文字左对齐（不是回到头像下面）
    // 量法用 Range.getClientRects()：它按**行盒**返回矩形，正好能拿到每一行的左边缘。
    var wrapRow = rowWith("折行样本");
    var wrapBody = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-body"]') : null;
    var lineRects = [];
    if (wrapBody) {
      var range = document.createRange();
      range.selectNodeContents(wrapBody);
      lineRects = [].slice.call(range.getClientRects());
    }
    out.layoutHangIndentLines = lineRects.length;
    out.layoutHangIndentFirstLeft = lineRects.length > 0 ? Math.round(lineRects[0].left * 10) / 10 : null;
    out.layoutHangIndentLastLeft = lineRects.length > 0
      ? Math.round(lineRects[lineRects.length - 1].left * 10) / 10
      : null;
    // 行数 ≥ 2 才算真的折了行，否则这条断言是「空对空」。
    // 用户 2026-09-13 的第 ② 条：**每一行**（不只是末行）的左边界都要与首行一致（悬挂缩进）。
    out.layoutHangIndentLineLefts = lineRects.map(function (r) {
      return Math.round(r.left * 10) / 10;
    });
    out.layoutHangIndentAligned = lineRects.length >= 2 &&
      out.layoutHangIndentLineLefts.every(function (l) {
        return Math.abs(l - out.layoutHangIndentLineLefts[0]) < 1;
      });

    // ---- 头像对齐口径：**顶部与身份行对齐**（参考图），且头像比身份行**稍高**
    //      （用户 2026-09-13：「头像需要比身份簇稍微高一些，太小了看不清」）。
    //      旧口径是「垂直居中于首行盒」——两行布局下首行就是身份行，居中会让头像整体下沉，
    //      所以这里改为量**顶边**：头像列/头像图的顶边与身份行顶边一致。
    var wrapIdentityEl = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-identity"]') : null;
    var avatarColEl = wrapRow ? wrapRow.querySelector('[data-testid="db-msg-avatar-col"]') : null;
    var wrapRowRect = rect(wrapRow);
    var avatarRect = rect(avatarColEl);
    var wrapIdentityRect = rect(wrapIdentityEl);
    var firstLine = lineRects[0];
    out.layoutAvatarTopDelta = wrapIdentityRect && avatarRect
      ? Math.round((avatarRect.top - wrapIdentityRect.top) * 10) / 10
      : null;
    out.layoutAvatarTopAlignedWithIdentity = out.layoutAvatarTopDelta !== null &&
      Math.abs(out.layoutAvatarTopDelta) < 1.5;
    // 反面对照：这一行折了好几行，头像若按「整行居中」会明显更低
    out.layoutAvatarNotRowCentered = !!firstLine && !!avatarRect && !!wrapRowRect &&
      (avatarRect.top + avatarRect.height / 2) <
        (wrapRowRect.top + wrapRowRect.height / 2) - 4;

    // ---- 头像顶边 = 身份行顶边，正文在身份行**下面**（用户 #1/#2：发表情时「错开」）
    // 量的是两条**表情弹幕**：行内表情与大表情（bulge）。旧版在这两行上分别错开 1.8px / 32px。
    var emoteRows = rows().filter(function (r) {
      return !!r.querySelector('[data-testid="db-msg-body"] img');
    });
    var firstLineTops = function (row) {
      var col = row.querySelector('[data-testid="db-msg-avatar-col"]');
      var identity = row.querySelector('[data-testid="db-msg-identity"]');
      var body = row.querySelector('[data-testid="db-msg-body"]');
      if (!col || !identity || !body) return null;
      var round = function (v) { return Math.round(v * 10) / 10; };
      return {
        avatarTop: round(rect(col).top),
        identityTop: round(rect(identity).top),
        identityBottom: round(rect(identity).bottom),
        bodyTop: round(rect(body).top)
      };
    };
    out.rowEmoteFirstLineTops = emoteRows.map(firstLineTops);
    out.rowIdentityOnFirstLineBox = emoteRows.length >= 2 && emoteRows.every(function (row) {
      var t = firstLineTops(row);
      return !!t && Math.abs(t.identityTop - t.avatarTop) < 1.5 &&
        t.bodyTop >= t.identityBottom - 0.5;
    });
    // 反面对照：大表情那一行折不了行（图是块级），头像按「行容器 flex-start + 行容器居中」会明显更低
    out.rowAvatarNotDroppedByTallEmote = emoteRows.length >= 2 && emoteRows.every(function (row) {
      var t = firstLineTops(row);
      return !!t && Math.abs(t.avatarTop - Math.min(t.avatarTop, t.bodyTop)) < 1.5;
    });

    // ---- 尺度：头像 / 身份牌 / 表情图同出一条基准（用户 #3），但**头像单独一档**
    //      （用户 2026-09-13：「头像需要比身份簇稍微高一些，太小了看不清」）：
    //      头像 = 1.25 × 行盒、身份牌 = 0.9 × 行盒（**不跟头像走**）、表情 = 1.1 × 行盒。
    var bodyForScale = byTestId("db-msg-body");
    var lineBoxPx = bodyForScale ? parseFloat(getComputedStyle(bodyForScale).lineHeight) : NaN;
    var avatarImgEl = avatarOf(withFace);
    var badgeForScale = byTestId("db-msg-badges") ? byTestId("db-msg-badges").children[0] : null;
    var emoteImgEl = emoteRows[0] ? emoteRows[0].querySelector('[data-testid="db-msg-body"] img') : null;
    var sizeOf = function (el) { return el ? Math.round(rect(el).height * 10) / 10 : null; };
    out.rowScale = {
      line: lineBoxPx,
      avatar: sizeOf(avatarImgEl),
      badge: sizeOf(badgeForScale),
      emote: sizeOf(emoteImgEl)
    };
    // 身份行的高度：身份是「用户名 + 身份牌」那一行，它的行盒就是 --row-line
    var identityForScale = byTestId("db-msg-identity");
    out.rowIdentityBoxPx = identityForScale ? Math.round(rect(identityForScale).height * 10) / 10 : null;
    out.rowScaleCoherent = !isNaN(lineBoxPx) &&
      out.rowScale.avatar !== null && out.rowScale.badge !== null && out.rowScale.emote !== null &&
      Math.abs(out.rowScale.avatar / lineBoxPx - 1.25) < 0.06 &&
      Math.abs(out.rowScale.badge / lineBoxPx - 0.9) < 0.06 &&
      Math.abs(out.rowScale.emote / lineBoxPx - 1.1) < 0.06;
    // 用户 2026-09-13 的正题：头像**比身份簇稍高**（不是等高、更不是更小），高度差 ≥ 15%
    out.rowAvatarTallerThanIdentity =
      out.rowScale.avatar !== null && out.rowIdentityBoxPx !== null &&
      out.rowScale.avatar > out.rowIdentityBoxPx &&
      out.rowScale.avatar / out.rowIdentityBoxPx >= 1.15;
    // 反面：身份牌**不**跟着头像放大（复用时它就 1.25 × 行盒了）
    out.rowBadgeNotFollowingAvatar =
      out.rowScale.badge !== null && out.rowScale.avatar !== null &&
      out.rowScale.avatar - out.rowScale.badge > 1;

    // ---- 字号滑杆联动（用户 2026-09-13：头像放大后，三种字号下都得成立）。
    //      弹幕区把 ui.font_scale 写成 scroller 上的 font-size: <scale>em（MessageList），
    //      行内尺寸全部由行盒按 em 派生，所以换三档字号量比值：头像/行盒恒 = 1.25、
    //      头像恒比身份行高 ≥ 15%。把尺寸写死成 px 的实现会在这里露出（比值随字号漂）。
    var scrollerEl = byTestId("db-chat-scroll");
    var probeAvatar = avatarOf(withFace);
    var probeIdentity = withFace ? withFace.querySelector('[data-testid="db-msg-identity"]') : null;
    var probeBody = withFace ? withFace.querySelector('[data-testid="db-msg-body"]') : null;
    var prevFontSize = scrollerEl.style.fontSize;
    var scaleProbe = [];
    // 比值记到 3 位小数：f1 那种 1 位小数会把 1.252 记成 1.3，容差就没意义了
    var f3 = function (v) { return Math.round(v * 1000) / 1000; };
    [0.85, 1, 1.6].forEach(function (scale) {
      scrollerEl.style.fontSize = scale + "em";
      var line = parseFloat(getComputedStyle(probeBody).lineHeight);
      var av = rect(probeAvatar).height;
      var idH = rect(probeIdentity).height;
      scaleProbe.push({
        scale: scale, line: f1(line), avatar: f1(av), identity: f1(idH),
        avatarPerLine: f3(av / line), avatarOverIdentity: f3(av / idH)
      });
    });
    scrollerEl.style.fontSize = prevFontSize;
    out.rowScaleProbe = scaleProbe;
    out.rowScaleFollowsFontSlider = scaleProbe.length === 3 && scaleProbe.every(function (p) {
      return Math.abs(p.avatarPerLine - 1.25) < 0.01 && p.avatarOverIdentity >= 1.15;
    });

    // ---- 昵称不吃弹幕颜色，颜色只落正文（用户 #2）
    var redRow = rowWith("红字弹幕正文");
    var redNameEl = redRow ? redRow.querySelector('[data-testid="db-msg-name"]') : null;
    var redBodyEl = redRow ? redRow.querySelector('[data-testid="db-msg-body"]') : null;
    var paintOf = function (el) {
      return el ? (el.getAttribute("style") || "") + "|" + getComputedStyle(el).color : "";
    };
    out.rowNameNotPaintedByDanmakuColor = !!redNameEl &&
      paintOf(redNameEl).indexOf("255, 0, 0") < 0 &&
      paintOf(redNameEl).indexOf("#ff0000") < 0;
    // 用户 2026-09-12：所有文本统一，正文不再照搬上游弹幕的自定义颜色
    out.rowBodyNotPaintedByDanmakuColor = !!redBodyEl &&
      paintOf(redBodyEl).indexOf("rgb(255, 0, 0)") < 0 &&
      paintOf(redBodyEl).indexOf("#ff0000") < 0;
    var whiteRow = rowWith("白字弹幕正文");
    var whiteBodyEl = whiteRow ? whiteRow.querySelector('[data-testid="db-msg-body"]') : null;
    // 16777215 是上游给普通弹幕的「白」= 未指定：不许照搬到正文（浅色主题下正文会瞎）
    out.rowDefaultWhiteTreatedAsUnset = !!whiteBodyEl &&
      (whiteBodyEl.getAttribute("style") || "") === "" &&
      getComputedStyle(whiteBodyEl).color !== "rgb(255, 255, 255)";

    // ---- 同一个颜色规则在**两种主题**下都要能读（用户报的「用户名是白色、看不见」发生在浅色主题）
    // 直接拨文档属性（app 的主题最终也落在这个属性上），量完立刻拨回去。
    var themeBefore = document.documentElement.getAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "light");
    await sleep(250);
    var lightRed = rowWith("红字弹幕正文");
    var lightWhite = rowWith("白字弹幕正文");
    var lightNameColor = lightRed
      ? getComputedStyle(lightRed.querySelector('[data-testid="db-msg-name"]')).color
      : "";
    var lightBodyColor = lightRed
      ? getComputedStyle(lightRed.querySelector('[data-testid="db-msg-body"]')).color
      : "";
    var lightWhiteBodyColor = lightWhite
      ? getComputedStyle(lightWhite.querySelector('[data-testid="db-msg-body"]')).color
      : "";
    var lightPageBg = getComputedStyle(document.body).backgroundColor;
    out.rowLightNameReadable = lightNameColor.length > 0 &&
      lightNameColor !== "rgb(255, 255, 255)" && lightNameColor !== lightPageBg;
    out.rowLightBodyNotPaintedByDanmakuColor = lightBodyColor.length > 0 &&
      lightBodyColor !== "rgb(255, 0, 0)" && lightBodyColor !== lightPageBg;
    // 最强的一条：同一屏里所有正文颜色必须完全一致（用户要的是「统一」）
    var allBodyColors = Array.from(document.querySelectorAll('[data-testid="db-msg-body"]'))
      .map(function (el) { return getComputedStyle(el).color; });
    out.rowAllBodiesSameColor = allBodyColors.length >= 3 &&
      allBodyColors.every(function (c) { return c === allBodyColors[0]; });
    // ---- 同一屏里所有昵称也必须是一个颜色，且既不是上游给的自定义色、也不是白
    // （白在浅色主题里等于看不见；这两条是用户 2026-09-12 那条反馈的最强口径）
    var screenNames = Array.from(document.querySelectorAll('[data-testid="db-msg-name"]'))
      .map(function (el) { return getComputedStyle(el).color; });
    out.namesAllSameColor = screenNames.length >= 3 &&
      screenNames.every(function (c) { return c === screenNames[0]; });
    out.namesNotPaintedByCustomColor = screenNames.length >= 3 && screenNames.every(function (c) {
      return c.indexOf("255, 255, 0") < 0 && c !== "rgb(255, 255, 255)";
    });
    out.rowLightDefaultWhiteTreatedAsUnset = lightWhiteBodyColor.length > 0 &&
      lightWhiteBodyColor !== "rgb(255, 255, 255)" && lightWhiteBodyColor !== lightPageBg;
    out.rowLightColors = [lightNameColor, lightBodyColor, lightWhiteBodyColor, lightPageBg];
    if (themeBefore === null) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", themeBefore);
    await sleep(150);

    // ---- 行尾「⋯」删掉（用户 #5：与右键菜单重复）；房间头那一个保留
    out.rowMenuTriggerGone = rows().length > 0 && rows().every(function (r) { return !buttonWith(r, "⋯"); });
    // 房间头那个 ⋯ 现在画的是**矢量三点**（不再是文字字形，见 RoomView 里那条注释）：
    // 判据改成「按钮还在、里面有图、aria-label 说明它是更多菜单」
    out.headerMenuTriggerKept = (function () {
      var more = byTestId("db-header-more");
      return !!more && !!more.querySelector("svg") &&
        (more.getAttribute("aria-label") || "").indexOf("更多") >= 0 &&
        !buttonWith(byTestId("db-room-header"), "⋯");
    })();

