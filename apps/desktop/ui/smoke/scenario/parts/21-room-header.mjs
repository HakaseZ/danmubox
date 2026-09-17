// 场景块：房间页基本形态：进房、房间头、状态点、标题、电池、贴底
//   step2 进房间、历史回填可见；step3 头部在线 / 看过且无人气值、系统与互动行的渲染与弱化、历史与实时同款
//   layout 弹幕列表是唯一生长区；内容不足视口时整体贴底；头像列永远占位（昵称三列纵向对齐）
//   房间头一排（返回键 + 状态点 + 标题 + 在线·看过 + ⋯）、两枚图标的矢量规范
//   状态点三态（灰 = 断连 / 红 = 已连接未开播 / 绿 = 开播）与断连那一档的 HSL 判据
//   标题放不下时循环滚动（两份拷贝 + transform）、电池是发送按钮左侧的竖电池
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- step2 进房间 + 历史回填可见
    byTestId("db-room-card").click();
    await sleep(800);
    window.__emit("danmubox://status", { room_id: 5440, state: "connected", detail: "" });
    out.step2_roomPage = text().indexOf("发送") >= 0;
    out.step2_historyVisible = !!rowWith("这是进场回填的历史弹幕");
    out.chatScroll = !!byTestId("db-chat-scroll");
    // 只有**一个**房间时标签条不渲染（没有可切的目标，也没有可拖的次序）——
    // 此刻正是那一次的状态：第二个房间要到多标签隔离那一段才登记进替身。
    out.singleRoomNoTabStrip = !byTestId("db-room-tabs") && allByTestId("db-room-tab").length === 0;
    snap();

    // 铺 2 条实时弹幕 + 互动 + 系统（step3 需要历史行与实时行同时在场）
    window.__emit("danmubox://message", window.__mk("danmaku", "这是实时弹幕"));
    // 进场行的自动摘除定时器 = 这条消息的 ts + 8s（store.scheduleInteractHide）。
    // 后面「面板展开不弹走视口」那条断言必须先等它落定：摘掉一行会把下面整体顶上去一行高。
    var interactMsg = window.__mk("interact", "");
    window.__interactAt = interactMsg.ts;
    window.__emit("danmubox://message", interactMsg);
    window.__emit("danmubox://message", window.__mk("system", "标题或分区变更"));
    window.__emit("danmubox://room_stats", { room_id: 5440, online: 12345, watched: 345678 });
    await sleep(600);

    // ---- step3 头部数字 / 渲染与弱化（语义不得改）
    var hist = rowWith("这是进场回填的历史弹幕");
    var live = rowWith("这是实时弹幕");
    var interact = rowWith("进入直播间");
    out.step3_headerHasOnline = text().indexOf("在线 1.2万") >= 0;
    out.step3_headerHasWatched = text().indexOf("看过 34.6万") >= 0;
    out.step3_headerHasPopularity = text().indexOf("人气") >= 0;
    out.step3_systemRendered = text().indexOf("标题或分区变更") >= 0;
    out.step3_interactRendered = !!interact;
    out.step3_historyOpacity = hist ? getComputedStyle(hist).opacity : null;
    out.step3_liveOpacity = live ? getComputedStyle(live).opacity : null;
    out.step3_dividerTextPresent = text().indexOf("以上为进场前的最新弹幕") >= 0;
    out.step3_interactAnimation = interact ? getComputedStyle(interact).animationName : null;
    // 窄屏：头部（在线 / 看过 / 电池）与弹幕列表都不许横向滚动——放不下就换行，不许溢出
    var headerEl0 = byTestId("db-room-header");
    var scrollerEl0 = byTestId("db-chat-scroll");
    put("headerNoHorizontalScroll", headerEl0.scrollWidth <= headerEl0.clientWidth);
    put("chatNoHorizontalScroll", scrollerEl0.scrollWidth <= scrollerEl0.clientWidth + 1);
    put("pageNoHorizontalScroll",
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      document.body.scrollWidth <= document.body.clientWidth);

    // ---- 房间头（用户 2026-09-12 反馈 1）：**两排**（控件一排、标题另一排）、
    //      返回 / ⋯ 两枚**圆形控件**、直播状态点（红 = 下播 / 绿 = 开播 / 橙 = 未连接）、
    //      标题在状态点右侧同一排、顶栏两个数值、不再有「已连接（缓冲 N）」文字与 verified 徽标。
    var headerEl1 = byTestId("db-room-header");
    // 圆形控件只剩**返回**与 **⋯**（用户 2026-09-13：「电池不要圆形，仅 3 点选项需要」）。
    // 电池挪去输入区、发送按钮左侧，形状也不同（圆角矩形，见下面的 battery* 断言）。
    var roundCtl = [byTestId("db-header-back"), byTestId("db-header-more")];
    var circleOf = function (el) {
      if (!el) return null;
      var box = rect(el);
      var radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
      return {
        w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10, r: radius,
        // 「圆角 = 半径」：正方盒 + 圆角不小于半边长 = 正圆（--r-full 在正方盒上被夹到半边长）
        round: Math.abs(box.width - box.height) < 0.6 && radius >= box.width / 2 - 0.6,
      };
    };
    out.headerControls = roundCtl.map(circleOf);
    out.headerControlsAllRound = roundCtl.every(function (el) { return !!circleOf(el) && circleOf(el).round; });
    out.headerControlsSameSize = roundCtl.every(function (el) {
      return !!el && Math.abs(rect(el).width - rect(roundCtl[0]).width) < 0.6;
    });
    out.headerBackIsArrowOnly = !!roundCtl[0] && roundCtl[0].innerText.trim() === "" &&
      !!roundCtl[0].querySelector("svg") &&
      (roundCtl[0].getAttribute("aria-label") || "").indexOf("返回") >= 0;
    out.headerNoConnectedText = headerEl1.innerText.indexOf("已连接") < 0 &&
      headerEl1.innerText.indexOf("缓冲") < 0 && headerEl1.innerText.indexOf("连接中") < 0 &&
      headerEl1.innerText.indexOf("已断开") < 0;
    // verified 徽标：类名与 testid 两种命名都不许出现（本仓库本来就没有，这条是防它被加回来）
    out.headerNoVerifiedBadge =
      document.querySelectorAll('[data-testid*="verified"], [class*="verified"], [class*="Verified"]').length === 0;
    var barBox = rect(byTestId("db-room-header-bar"));
    var titleBox = rect(byTestId("db-room-title"));
    var dotBox0 = rect(byTestId("db-live-dot"));
    // 标题回到**状态点右侧、同一排**（用户 2026-09-13 第 3 条的纠正：上一版「标题另起一排」理解错了）。
    // 判据：① 标题左边缘在状态点右边缘之右；② 两者的竖直中心对齐（同一排）；
    // ③ 标题整个落在头部那一排的盒子里（没有掉到第二排）。
    out.headerTitleWithDot = !!titleBox && !!dotBox0 && !!barBox &&
      titleBox.left >= dotBox0.right - 0.5 &&
      Math.abs((titleBox.top + titleBox.height / 2) - (dotBox0.top + dotBox0.height / 2)) <= 3 &&
      titleBox.top >= barBox.top - 0.5 && titleBox.bottom <= barBox.bottom + 0.5;
    // 顶栏腾出来的位置给**两个数值**：当前在线 / 看过（用户 2026-09-13）；电池**不在**顶栏。
    var headerText = headerEl1.innerText;
    out.headerHasBothStats = headerText.indexOf("在线") >= 0 && headerText.indexOf("看过") >= 0;
    out.headerNoBattery = !headerEl1.querySelector('[data-testid="db-battery"]') &&
      headerText.indexOf("电池") < 0 && headerText.indexOf("150") < 0;
    // 直播状态点：颜色必须等于令牌值，且**随 live_status 变**（发一条 room 事件翻成未开播再翻回来）
    var cssColorOf = function (name) {
      var probe = document.createElement("span");
      probe.style.color = "var(" + name + ")";
      document.body.appendChild(probe);
      var value = getComputedStyle(probe).color;
      probe.parentNode.removeChild(probe);
      return value;
    };
    var liveOnColor = cssColorOf("--live-on");
    var liveOffColor = cssColorOf("--live-off");
    var dotColor = function () {
      var dot = byTestId("db-live-dot");
      return dot ? getComputedStyle(dot).backgroundColor : null;
    };
    var liveIdleColor = cssColorOf("--live-idle");
    // 三态口径（用户 2026-09-13）：**红 = 下播 / 绿 = 开播 / 橙 = 未连接**，三条色值互不相同
    out.liveDotTokensDistinct = liveOnColor !== liveOffColor &&
      liveOffColor !== liveIdleColor && liveOnColor !== liveIdleColor;
    // 夹具里的 live_status 是多少就按哪个色验（不写死 1 —— 真实载荷是轮播（live_status = 2），
    // 它不是「开播」，落到红那一档）。
    var liveIsOn = fixtureRoom.live_status === 1;
    var liveExpectedColor = liveIsOn ? liveOnColor : liveOffColor;
    out.liveDotMatchesStatus = dotColor() === liveExpectedColor &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    // ① 上游把 live_status 翻过去 → 颜色跟着变（这才是「随它变」的可验形式）
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: liveIsOn ? 0 : 1 });
    await sleep(350);
    var toggledDot = byTestId("db-live-dot");
    out.liveDotFollowsStatus = dotColor() === (liveIsOn ? liveOffColor : liveOnColor) && !!toggledDot &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "off" : "on");
    // ② 连接态掉线 → **未连接**（灰），与在不在播无关（这一档的来源是「danmubox://status」，
    //    与房间标签页上的圆点同源）
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "disconnected", detail: "" });
    await sleep(350);
    out.liveDotIdleWhenDisconnected = dotColor() === liveIdleColor &&
      byTestId("db-live-dot-box").getAttribute("data-state") === "idle";
    // ③ 连回来 → 回到上游那一档
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: fixtureRoom.live_status });
    await sleep(350);
    out.liveDotRestored = dotColor() === liveExpectedColor && !!byTestId("db-live-dot") &&
      byTestId("db-live-dot-box").getAttribute("data-live") === String(fixtureRoom.live_status) &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    // ---- 状态点**逐档缩小**（用户 2026-09-13：先「稍微缩小一点」12 → 10，本次第 5 条「改小一点」
    //      再降一档到 8）。
    //      两层：看得见的那颗点（db-live-dot，--live-dot）画在外壳（db-live-dot-box，
    //      仍是旧的 --sp-3 12px）里面；悬停 / 热区**不跟着缩**（用户明确要求「别让可点面积变小」）。
    //      两个数都记进快照：改的是**数字**，不是删断言。
    var liveDotEl = byTestId("db-live-dot");
    var liveDotBoxEl = byTestId("db-live-dot-box");
    var liveDotBox = rect(liveDotEl);
    var cssLengthOf = function (name) {
      var probe = document.createElement("span");
      probe.style.display = "block";
      probe.style.width = "var(" + name + ")";
      document.body.appendChild(probe);
      var value = parseFloat(getComputedStyle(probe).width);
      probe.parentNode.removeChild(probe);
      return value;
    };
    out.liveDotVisualPx = liveDotBox ? Math.round(liveDotBox.width * 10) / 10 : null;
    out.liveDotHitPx = liveDotBoxEl ? Math.round(rect(liveDotBoxEl).width * 10) / 10 : null;
    // 看得见的那颗点 = --live-dot（8px）；热区 / 悬停面（外壳）仍是改前的 12px，没跟着缩
    out.liveDotVisualIsToken = !!liveDotBox &&
      Math.abs(liveDotBox.width - cssLengthOf("--live-dot")) < 0.6;
    // 用户 2026-09-13 第 5 条：「并且要改小一点」——**再小一档**（12 → 10 → 8）。
    // 判据里的 10 是**上一档**：这回必须比它更小；外壳（热区 / 悬停面）仍是 12px 不动。
    out.liveDotShrunk = !!liveDotBox && !!liveDotBoxEl && liveDotBox.width < 10 &&
      rect(liveDotBoxEl).width > liveDotBox.width &&
      Math.abs(rect(liveDotBoxEl).width - 12) < 0.6;
    // ---- 三态语义（用户 2026-09-13 第 5 条 + 当天的更正）：**灰 = 断连 / 红 = 已连接但未开播 / 绿 = 已连接且开播**。
    //      逐状态发真实事件把三种状态各走一遍（status + room 两个来源），把「状态名 → 颜色」记下来，
    //      再判两件事：① 三个色互不相同；② 每个状态的颜色等于它该有的那个令牌。
    var liveStates = [];
    var recordLive = function () {
      liveStates.push({
        state: byTestId("db-live-dot-box").getAttribute("data-state"),
        color: dotColor(),
      });
    };
    // ① 已连接 & 未开播 → 红
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 0 });
    await sleep(300);
    recordLive();
    // ② 已连接 & 开播 → 绿
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 1 });
    await sleep(300);
    recordLive();
    // ③ 断连 → 灰（与在不在播无关：连接态掉线时根本不知道播没播）
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "disconnected", detail: "" });
    await sleep(300);
    recordLive();
    // 复位到夹具那一档，后面的断言按同一口径继续
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: fixtureRoom.live_status });
    await sleep(300);
    out.liveDotStates = liveStates;
    out.liveDotStatesDistinct = liveStates.length === 3 &&
      liveStates[0].color !== liveStates[1].color &&
      liveStates[1].color !== liveStates[2].color &&
      liveStates[0].color !== liveStates[2].color;
    out.liveDotStateMapping = liveStates.length === 3 &&
      liveStates[0].state === "off" && liveStates[0].color === liveOffColor &&
      liveStates[1].state === "on" && liveStates[1].color === liveOnColor &&
      liveStates[2].state === "idle" && liveStates[2].color === liveIdleColor;
    out.liveDotRestoredAfterStates = dotColor() === liveExpectedColor &&
      byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    // ---- 断连那一档**必须是灰的**（用户 2026-09-13：「我觉得灰色也不错，橙色的需求改成灰色」）。
    //      判据用 **HSL 饱和度**，不硬编码色值：三档色在两套主题里本来就不同值，而「绿 / 红有彩、
    //      灰没彩」是语义本身。阈值 0.2 —— 改前的橙（#e9a038 / #c2410c）是 80% / 88%，
    //      红 / 绿都在 65% 以上，灰（--fg-dim：#8696a0 / #54656f）只有 12% / 14%。
    //      ⚠ 解析**不用正则**，与上面 luminance 一样用 indexOf / slice 切：当年场景整段活在模板串里，
    //      正则里的反斜杠会先被模板求值吃掉（写 /rgba?\(([^)]+)\)/ 到页面里变成 /rgba?(([^)]+))/，
    //      捕获到带括号的 "(37, 211, 102)"，parseFloat 直接 NaN —— 第一版就是这么红的）；
    //      2026-09-17 拆分后片段是页内原文、该约束已消失，写法保持原样。
    var saturationOf = function (css) {
      if (!css) return null;
      var open = css.indexOf("(");
      var close = css.indexOf(")");
      if (open < 0 || close < 0) return null;
      var parts = css.slice(open + 1, close).split(",");
      if (parts.length < 3) return null;
      var ch = parts.slice(0, 3).map(function (v) { return parseFloat(v) / 255; });
      if (ch.some(isNaN)) return null;
      var max = Math.max(ch[0], ch[1], ch[2]);
      var min = Math.min(ch[0], ch[1], ch[2]);
      var delta = max - min;
      if (delta === 0) return 0;
      return Math.round((delta / (1 - Math.abs(2 * ((max + min) / 2) - 1))) * 1000) / 1000;
    };
    out.liveDotTheme = document.documentElement.getAttribute("data-theme");
    out.liveDotColors = { on: liveOnColor, off: liveOffColor, idle: liveIdleColor };
    out.liveIdleSaturation = saturationOf(liveIdleColor);
    out.liveIdleIsGray = out.liveIdleSaturation !== null && out.liveIdleSaturation < 0.2;
    // 另两档必须**有彩**：否则「灰」这个判据本身没有区分力（三档都灰也能骗过上面一条）
    out.liveVividStatesKeepColor = saturationOf(liveOnColor) > 0.4 && saturationOf(liveOffColor) > 0.4;
    // 清晰度：状态点是**非文字图形要素**（WCAG 1.4.11 要 3:1）。顶栏是半透明的一层，
    // 标签页坐在画布 / 面板上，所以对 --bg 与 --bg-elevated 两面各量一次。
    out.liveIdleContrastOnCanvas = contrastRatio(liveIdleColor, cssColorOf("--bg"));
    out.liveIdleContrastOnSurface = contrastRatio(liveIdleColor, cssColorOf("--bg-elevated"));
    out.liveIdleContrastOk = out.liveIdleContrastOnCanvas >= 3 && out.liveIdleContrastOnSurface >= 3;
    // ---- 图标**规范**取证（用户 2026-09-13 第 4 条 → 追加：「可能他们本就不一致，只调 size 没用？」）。
    //      上一版只把两枚的**墨迹粗细**都调成 1.5px，形状 / 光学尺寸仍各走各的（箭头墨迹 9 × 16.5
    //      且偏左 0.75，⋯ 跨度只有 11.5、圆点 1.5）—— 所以「整体粗细不一致」还在。现在两枚共用
    //      **一套**规范（见 RoomView.tsx / app.module.css 的注释）：同一个 24 × 24 盒与 viewBox、
    //      同一条 stroke-width（1.75）、同一套 round 线帽 / 接合、墨迹都居中于 (12,12)、
    //      主轴尺寸都是 16 单位（箭头的**高** = ⋯ 的**宽**）、⋯ 的圆点直径 = 2 × 描边宽。
    //      量法（iconGeomOf）定义在场景开头：**step1 的主题按钮**三档也走同一把尺子。
    out.iconBack = iconGeomOf(roundCtl[0]);
    out.iconMore = iconGeomOf(roundCtl[1]);
    out.iconBackInkThicknessPx = out.iconBack ? out.iconBack.inkThicknessPx : null;
    out.iconMoreInkThicknessPx = out.iconMore ? out.iconMore.inkThicknessPx : null;
    // ① ⋯ 的圆点直径 = 2 × 返回那一笔的描边宽（同一套规范里唯一的比例关系）
    out.iconDotsTwiceStroke = !!out.iconBack && !!out.iconMore &&
      Math.abs(out.iconMore.inkThicknessPx - out.iconBack.inkThicknessPx * 2) < 0.2;
    // ② 同一个渲染盒（24 × 24、缩放系数 1）与同一个 viewBox
    out.iconSameBox = !!out.iconBack && !!out.iconMore &&
      out.iconBack.viewBox === out.iconMore.viewBox && out.iconBack.viewBox === "0 0 24 24" &&
      Math.abs(out.iconBack.boxPx - out.iconMore.boxPx) < 0.6 &&
      Math.abs(out.iconBack.scale - 1) < 0.01;
    // ③ 同一套线帽 / 接合（返回是描边路径，⋯ 是实心圆点：端点形状由「圆」本身保证）
    out.iconCapsShared = !!out.iconBack && out.iconBack.linecap === "round" &&
      out.iconBack.linejoin === "round" && out.iconMore.shapeCount === 3;
    // ④ 两枚的墨迹都**居中**于 (12,12)（改前箭头偏左 0.75 —— 这就是「看着不一样」的一半原因）
    out.iconInkCentered = !!out.iconBack && !!out.iconMore &&
      Math.abs(out.iconBack.inkCenterX - 12) < 0.2 && Math.abs(out.iconBack.inkCenterY - 12) < 0.2 &&
      Math.abs(out.iconMore.inkCenterX - 12) < 0.2 && Math.abs(out.iconMore.inkCenterY - 12) < 0.2;
    // ⑤ 主轴尺寸相同（箭头的高 = ⋯ 的宽 = 16 单位）：两枚的**视觉尺寸**一致，而不是各调一个数
    out.iconSameDominantExtent = !!out.iconBack && !!out.iconMore &&
      Math.abs(Math.max(out.iconBack.inkW, out.iconBack.inkH) -
        Math.max(out.iconMore.inkW, out.iconMore.inkH)) < 0.2;
    // 控件本身尺寸不变（40 × 40 正圆，两枚同尺寸）
    out.iconControlsSameSize = !!roundCtl[0] && !!roundCtl[1] &&
      Math.abs(rect(roundCtl[0]).width - rect(roundCtl[1]).width) < 0.6 &&
      Math.abs(rect(roundCtl[0]).width - 40) < 0.6;
    // 圆点仍是**正圆**（圆角 = 半径）
    out.liveDotIsCircle = !!liveDotEl &&
      Math.abs(liveDotEl.getBoundingClientRect().width -
        liveDotEl.getBoundingClientRect().height) < 0.6 &&
      (parseFloat(getComputedStyle(liveDotEl).borderTopLeftRadius) || 0) >=
        liveDotEl.getBoundingClientRect().width / 2 - 0.6;
    // ---- 标题放不下就**循环滚动**（用户 2026-09-13 第 3 条）。判据不靠「看起来在动」：
    //      「data-scroll」由「一份文字的宽度 > 可视宽度」量出来，动画挂在轨道上。
    //      三种标题各量一次（超长 / 短 / 夹具原名），另外量「滚动不许引起布局跳动」。
    var trackScrolling = function () {
      var trackEl = byTestId("db-title-track");
      return !!trackEl && trackEl.getAttribute("data-scroll") === "true" &&
        getComputedStyle(trackEl).animationName !== "none";
    };
    var longTitle = new Array(40).join("很长的直播间标题");
    var headerBoxBeforeScroll = rect(byTestId("db-room-header"));
    var titleBoxBeforeScroll = rect(byTestId("db-room-title"));
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: longTitle });
    await sleep(400);
    // 「放不下」是**量出来的**（一份文字的宽度 vs 可视宽度），不是一个开关：把两个数都记进快照
    var titleOverflowMeasured = function () {
      var copyEl = byTestId("db-title-copy");
      var viewEl = byTestId("db-room-title");
      return !!copyEl && !!viewEl && copyEl.offsetWidth > viewEl.clientWidth + 0.5;
    };
    out.titleMarqueeOnOverflow = trackScrolling() && titleOverflowMeasured();
    out.titleOverflowPx = (function () {
      var copyEl = byTestId("db-title-copy");
      var viewEl = byTestId("db-room-title");
      return copyEl && viewEl ? Math.round((copyEl.offsetWidth - viewEl.clientWidth) * 10) / 10 : null;
    })();
    // 轨道滚起来之后布局**一点都不许动**：头部 / 标题的盒子与滚动前逐项相同
    var headerBoxAfterScroll = rect(byTestId("db-room-header"));
    var titleBoxAfterScroll = rect(byTestId("db-room-title"));
    out.titleMarqueeNoLayoutJump = !!headerBoxAfterScroll && !!titleBoxAfterScroll &&
      Math.abs(headerBoxAfterScroll.height - headerBoxBeforeScroll.height) < 0.6 &&
      Math.abs(titleBoxAfterScroll.left - titleBoxBeforeScroll.left) < 0.6 &&
      Math.abs(titleBoxAfterScroll.top - titleBoxBeforeScroll.top) < 0.6 &&
      Math.abs(titleBoxAfterScroll.width - titleBoxBeforeScroll.width) < 0.6;
    // 标题仍与状态点同一排（滚动没有把它挤走）。**比中心不比顶边**：标题是整行文本盒
    // （行高 ~22px）、状态点只有 10px，顶边天然差半个行高，那不是「不同排」。
    var dotBoxAfterScroll = rect(byTestId("db-live-dot"));
    out.titleRowGapPx = titleBoxAfterScroll && dotBoxAfterScroll
      ? Math.round((titleBoxAfterScroll.left - dotBoxAfterScroll.right) * 10) / 10 : null;
    out.titleMarqueeKeepsRow = !!titleBoxAfterScroll && !!dotBoxAfterScroll &&
      titleBoxAfterScroll.left >= dotBoxAfterScroll.right - 0.5 &&
      Math.abs((titleBoxAfterScroll.top + titleBoxAfterScroll.height / 2) -
        (dotBoxAfterScroll.top + dotBoxAfterScroll.height / 2)) <= 3;
    // 短标题**不滚**（不是「一律滚」）
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: "短" });
    await sleep(400);
    out.titleShortNoMarquee = !trackScrolling() && !titleOverflowMeasured() &&
      byTestId("db-title-track").getAttribute("data-scroll") === "false";
    window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, title: fixtureRoom.title });
    await sleep(400);
    // 标题在 DOM 里有两份拷贝（循环滚动要的），因此按**属性**而不是 innerText 认它。
    // 这里不判滚不滚：宽屏下夹具标题放得下、窄屏（可视宽 ~83px）下放不下，两边本来就不同档
    out.titleRestored = byTestId("db-room-title").getAttribute("title") === fixtureRoom.title;

    // ---- 电池：**发送按钮左侧**、**不是圆形**（用户 2026-09-13：「电池不要圆形，仅 3 点选项需要」+
    //      「电池数量挪到底部发送按钮左侧」）。
    var batteryEl = byTestId("db-battery");
    var batteryBox = rect(batteryEl);
    var batteryRadius = batteryEl
      ? parseFloat(getComputedStyle(batteryEl).borderTopLeftRadius) || 0 : 0;
    var sendButtonEl = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .filter(function (b) { return b.innerText.trim() === "发送"; })[0];
    var sendBox = rect(sendButtonEl);
    out.batteryInComposer = !!batteryEl && !!byTestId("db-composer-tools") &&
      byTestId("db-composer-tools").contains(batteryEl);
    out.batteryLeftOfSend = !!batteryBox && !!sendBox && batteryBox.right <= sendBox.left + 1;
    out.batteryRadiusPx = Math.round(batteryRadius * 10) / 10;
    out.batteryBoxPx = batteryBox
      ? [Math.round(batteryBox.width * 10) / 10, Math.round(batteryBox.height * 10) / 10] : null;
    // 「不是圆形」= 圆角**不**等于半边长（正圆与胶囊都会等于半短边，都算圆）
    out.batteryNotRound = !!batteryBox && batteryRadius > 0 &&
      batteryRadius < Math.min(batteryBox.width, batteryBox.height) / 2 - 1;
    out.batteryText = batteryEl ? batteryEl.innerText.trim() : null;
    // ---- 电池图标形状取证（用户 2026-09-13 第 3 条：官方是**竖**着的电池，横着像电量条）。
    //      量图标盒的宽高比 + SVG 里那个矩形与极柱的**朝向**（宽 > 高 = 横着）。
    var batterySvgEl = batteryEl ? batteryEl.querySelector("svg") : null;
    var batteryRects = batterySvgEl ? [].slice.call(batterySvgEl.querySelectorAll("rect")) : [];
    out.batteryIconBoxPx = batterySvgEl
      ? [Math.round(rect(batterySvgEl).width * 10) / 10, Math.round(rect(batterySvgEl).height * 10) / 10]
      : null;
    out.batteryIconShape = batteryRects.length > 0 ? {
      rectW: parseFloat(batteryRects[0].getAttribute("width")),
      rectH: parseFloat(batteryRects[0].getAttribute("height")),
      viewBox: batterySvgEl.getAttribute("viewBox"),
    } : null;

    // 输入区：输入框占满宽度；工具行放不下就换行，不许挤成小方块
    var composerEl0 = document.querySelector("textarea").parentElement;
    var toolsEl0 = byTestId("db-composer-tools");
    put("textareaFullWidth",
      Math.abs(rect(document.querySelector("textarea")).width - composerEl0.clientWidth) < 26);
    put("toolsRowNoOverflow", !!toolsEl0 &&
      toolsEl0.scrollWidth <= toolsEl0.clientWidth + 1);
    snap();

    // ---- 几何：内容不足视口高度时整体贴底（直播弹幕自下往上读，最新一条紧贴输入区）
    // 此刻列表只有历史 1 条 + 实时 3 条，远未填满视口，正好测「富余空间去了哪」。
    // 贴底时 未尾行.bottom 与滚动容器.bottom 之间只剩容器的 padding-bottom（8px）。
    var scrollerShort = byTestId("db-chat-scroll");
    var lastRowShort = rows()[rows().length - 1];
    out.layoutShortContentBottomGap = lastRowShort
      ? Math.round(scrollerShort.getBoundingClientRect().bottom - lastRowShort.getBoundingClientRect().bottom)
      : null;
    out.layoutShortContentPinnedBottom =
      out.layoutShortContentBottomGap !== null && out.layoutShortContentBottomGap <= 12;
    // 停一下让跑脚本的进程抓一张「内容不足视口时贴底」的截图
    snap();
    await sleep(900);

    // 再补 60 条，让列表真的会滚（后面的几何断言才有意义）
    for (var i = 0; i < 60; i += 1) {
      window.__emit("danmubox://message", window.__mk("danmaku", "实时弹幕 " + i));
    }
    await sleep(700);
    out.rowCount = rows().length;
    snap();

    // 粉丝牌配色：上游真彩色优先；空串不是颜色，回退按牌名派生的色相（issue #6 / 契约 §5）
    window.__emit("danmubox://message", window.__mk("danmaku", "带真彩牌弹幕", false, {
      medal_level: 7, medal_name: "真彩牌",
      medal_color_start: "#3FB4F699", medal_color_end: "#1E6FD9",
      medal_color_border: "#FFFFFF", medal_color_text: "#FFFFFF"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "无真彩牌弹幕", false, {
      medal_level: 3, medal_name: "兜底牌"
    }));
    // 回复关系（issue #13b）与「舰长标只认本房间」（issue #12）的样本行
    window.__emit("danmubox://message", window.__mk("danmaku", "这条是回复 @被回复的人 你好", false, {
      // 上游自定义颜色的弹幕（舰长/老爷常见金黄）。用户名与正文都不许被它染色——
      // 用户 2026-09-12 的原始反馈：用户名被染成白色看不见、正文偏黄。
      color: 16776960,
      reply_to_uid: 777, reply_to_uname: "被回复的人", reply_uname_color: "#FB7299"
    }));
    // 上游没给配色（空串）时不上色：**空串不是颜色**，与粉丝牌真彩色同一口径
    window.__emit("danmubox://message", window.__mk("danmaku", "没有配色的回复 @另一个被回复的人 哦", false, {
      reply_to_uid: 778, reply_to_uname: "另一个被回复的人", reply_uname_color: ""
    }));
    // 正文里的 @ 与「回复关系」**不是一回事**（用户 2026-09-13 第 1 条）：这条没有任何
    // reply_* 字段，正文里的 @ 照样高亮——高亮认的是正文，不是回复标记。
    window.__emit("danmubox://message", window.__mk("danmaku", "没有回复关系也 @路人乙 高亮", false, {
      uname: "路人甲"
    }));
    // 排版样本（issue #8 的「一条弹幕要像一个整体」）：
    // ① 长正文：在 360 与 1440 两个视口都会折行，用来量折行后的首字位置；
    // ② 带徽标 + 昵称 + 正文的行：用来量「徽标组→昵称」与「昵称→正文」两道间距。
    window.__emit("danmubox://message", window.__mk("danmaku",
      "折行样本：" + "身份属于人名，正文属于内容，两者之间要分开；折行之后每一行都要与首行文字左对齐，而不是回到头像下面。".repeat(3)));
    // ③ 无空格的长 ASCII 串（真实载荷里的 CDN 地址）：必须就地断开，不许把行撑出横向滚动。
    window.__emit("danmubox://message", window.__mk("danmaku", ROW_ASCII, false, {
      uname: "贴链接的观众"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "紧贴昵称的徽标弹幕", false, {
      uname: "身份样本", medal_level: 7, medal_name: "紧贴牌", guard_level: 3
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "他房间的牌子弹幕", false, {
      medal_level: 7, medal_name: "外间牌", medal_guard_level: 3, guard_level: 0
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "本房间的大航海弹幕", false, {
      guard_level: 3
    }));
    // 弹幕自己的颜色**只属于正文**（用户 #2 的根因）：一条真彩色、一条普通白。
    // 上游给普通弹幕的颜色就是 16777215（白），名字吃这条颜色时白字人名在浅色主题下就是「看不见」。
    window.__emit("danmubox://message", window.__mk("danmaku", "红字弹幕正文", false, {
      color: 0xff0000, uname: "红字观众"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "白字弹幕正文", false, {
      color: 16777215, uname: "白字观众"
    }));
    // 表情弹幕：身份簇 / 头像 / 表情图三者对齐的样本（用户 #1/#2 的「发表情时错开」）。
    // ① 行内表情 ② 独占一行的大表情（bulge）——旧版在 ② 上错开 32px（身份簇被拽到图片底边）。
    var faceUrl = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%2300aeec'/></svg>";
    // 这两条表情也**取自真实载荷**（固有尺寸 200×60 的通用表情、162×162 的 bulge 表情），
    // 不再是手写的 64×64 正方形：尺寸特征与真站一致，行内的缩放关系才量得准。
    var rowEmote = function (sample) {
      return {
        emoticon_unique: sample.emoticon_unique, url: sample.url, width: sample.width,
        height: sample.height, is_dynamic: sample.is_dynamic,
        in_player_area: sample.in_player_area, bulge_display: sample.bulge_display
      };
    };
    window.__emit("danmubox://message", window.__mk("danmaku", "行内表情样本", false, {
      face: faceUrl, uname: "表情君", emote: rowEmote(ROW_EMOTES.inline)
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "大表情样本", false, {
      face: faceUrl, uname: "大表情君", emote: rowEmote(ROW_EMOTES.bulge)
    }));
    // 头像（Message.face）：有头像画图、没头像不渲染、加载失败退化成首字符占位
    window.__emit("danmubox://message", window.__mk("danmaku", "带头像的弹幕", false, {
      face: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%2300aeec'/></svg>",
      uname: "有头像"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "坏头像的弹幕", false, {
      face: "data:image/png;base64,AAAA",
      uname: "坏头像"
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "无头像的弹幕", false, {
      face: "",
      uname: "无头像"
    }));
    // 自己发的那条：uid 必须等于 session.uid（mock 的账号表里 default = 1000），
    // 用来验「我方弹幕」的行级标记（整行底色 + 行首 2px 竖条，不做气泡）
    window.__emit("danmubox://message", window.__mk("danmaku", "我自己发的弹幕", false, {
      uid: 1000,
      uname: "本地测试"
    }));
    // 真实夹具的两行（用户 2026-09-12 报的那条正文行 + 一条真实表情包弹幕）：
    // 消息对象由 Node 侧从 smoke/fixtures/danmaku-rows.json 按 cmd.rs 的口径派生，这里只负责发。
    // local_id 必须由本地计数器分配 —— store 只接受比末尾更大的 local_id（契约 §5），
    // 所以先借 __mk 拿一个号，再把夹具字段盖上去（local_id 除外）。
    var fixtureMessage = function (fixture) {
      var m = window.__mk("danmaku", fixture.content, false);
      var allocated = m.local_id;
      for (var key in fixture) if (key !== "local_id") m[key] = fixture[key];
      m.local_id = allocated;
      return m;
    };
    window.__emit("danmubox://message", fixtureMessage(ROW_FIXTURES.text));
    window.__emit("danmubox://message", fixtureMessage(ROW_FIXTURES.emoticon));
    await sleep(600);
    var withFace = rowWith("带头像的弹幕");
    var badFace = rowWith("坏头像的弹幕");
    var noFace = rowWith("无头像的弹幕");
    var avatarOf = function (row) {
      return row ? row.querySelector('[data-testid="db-msg-avatar"]') : null;
    };
    out.avatarImageRendered = !!avatarOf(withFace) && avatarOf(withFace).tagName === "IMG";
    out.avatarAbsentWhenNoFace = !avatarOf(noFace);
    out.avatarFallbackOnError = !!avatarOf(badFace) && avatarOf(badFace).tagName === "SPAN";
    // 头像列永远占位：三行的昵称左边缘必须一致（没头像的那行不许整体左移）
    var nameLefts = [withFace, badFace, noFace].map(function (row) {
      var name = row ? row.querySelector('[data-testid="db-msg-name"]') : null;
      return name ? Math.round(name.getBoundingClientRect().left * 10) / 10 : null;
    });
    out.layoutNameLefts = nameLefts;
