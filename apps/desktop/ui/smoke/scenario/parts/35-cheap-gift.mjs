// 场景块：低价礼物两枚开关（cheapgift + switchscope）
//   cheapgift ui.gift_collapse_cheap 只改礼物栏的分组形状、ui.gift_exclude_cheap_stats 只改折叠头统计口径，两枚默认都关
//   边界按 0.09 / 0.10 算低价、0.11 不算、0 元（上游没给价）不算逐条量；SC 与大航海不受影响
//   switchscope 两个区域（弹幕区 + 礼物栏）各量一次，且不丢内容 / 开关可逆（关掉即逐条复原）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ==== cheapgift 低价礼物两枚开关（issue 2609162056 第 3 / 4 条，契约 §8、docs/ui.md §5.3）
    //
    // ui.gift_collapse_cheap = 礼物栏里把单个价值 ≤ 0.1 元的礼物合并成**一条**；
    // ui.gift_exclude_cheap_stats = 把这批礼物从折叠头的**统计**里剔除（展示照旧）。两枚默认都关。
    //
    // ⚠ 为什么换到**空会话的新房间**里量：礼物栏的行由与弹幕区同一套（虚拟）列表渲染，只有
    //   「全部落在渲染窗口里」时行数才等于条目数 —— 房间 5440 里前面已经堆了六条礼物类夹具与
    //   几十条弹幕，量出来的行数会随窗口大小浮动，差值是假的。新房间只推我这几条，行数才可判。
    // ⚠ 为什么本段排在**场景最末**：新房间会让标签条多一枚、房间页布局随之变化，插在中间会把
    //   后面各段的几何断言一起带偏。
    // ⚠ 行钩子 db-gift-row 来自同批的礼物栏票（礼物栏改用与弹幕区同一套列表渲染；旧实现的
    //   行钩子是 db-gift-item）。两票合入后以 db-gift-row 为准 —— 它一枚都找不到时，
    //   cheapGiftRowsBeforeFold 会是 0，失败点一眼能看见。
    var CHEAP_ROOM = 5555;
    window.__addSecondRoom();
    await sleep(200);
    var cheapTabFor = function (roomId) {
      // data-room-id 取出来是**字符串**，而这里的入参两种都有：从属性上取回来的那一份是
      // 字符串，CHEAP_ROOM 是**数字**。少了这层归一化，用数字找标签永远找不到 —— 本轮
      // 首次真跑就是这么红的：cheapGiftFreshRoomTab=false，标签根本没点下去，下面整段
      // 全量在旧房间（5440）上量，11 条断言一起假失败。
      var want = String(roomId);
      return allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === want;
      })[0];
    };
    var cheapActiveRoomId = function () {
      var t = allByTestId("db-room-tab").filter(function (x) {
        return x.getAttribute("data-active") === "true";
      })[0];
      return t ? t.getAttribute("data-room-id") : null;
    };
    // 先点一次**当前**这一枚标签，把标签条「拖完吞掉下一发 click」的标志消费掉（同 splitter 段）
    var cheapHomeId = cheapActiveRoomId();
    if (cheapHomeId) {
      cheapTabFor(cheapHomeId).click();
      await sleep(250);
    }
    var cheapTab = cheapTabFor(CHEAP_ROOM);
    out.cheapGiftFreshRoomTab = !!cheapTab;
    if (cheapTab) cheapTab.click();
    await sleep(900);
    out.cheapGiftFreshRoomActive = cheapActiveRoomId() === String(CHEAP_ROOM);

    // 总计条与三格的串都由页面的格式器拼（`yuanText`：
    // `¥` + `toLocaleString(undefined, { maximumFractionDigits: 3 })`），这里跟着**同一套**格式器
    // 生成期望值，不手写千分位（分组位数随浏览器 locale 变，断言不该把它写死）。
    var yuan = function (n) { return n.toLocaleString(undefined, { maximumFractionDigits: 3 }); };
    // 总计条的期望串：`礼物 ${条数}条 ¥${金额}`（RoomView 的 `giftTotalText`，未开筛选时带金额）。
    var totalLine = function (count, amount) { return "礼物 " + count + "条 ¥" + yuan(amount); };
    var cheapPush = function (kind, content, amount, extra) {
      window.__emit("danmubox://message", window.__mk(kind, content, false,
        Object.assign({ room_id: CHEAP_ROOM, amount: amount }, extra || {})));
    };
    var cheapRowCount = function () { return allByTestId("db-gift-row").length; };
    var cheapPaneText = function () {
      var el = byTestId("db-pane-gift");
      return el ? el.innerText : "";
    };
    // **2026-09-27 钩子校准**：本批的单轴模型（需求 5.1–5.4）把礼物栏重做成
    // 「总计条 / 列表 / 筛选条」三段常驻，`db-gift-summary`（旧那条整串分组汇总）与
    // `db-gift-dock`（旧的整块礼物栏）两枚钩子在 `src/` 里已 0 次出现。它们现在的着落：
    //   · 旧的**整串汇总** → 拆成「总计条 `db-gift-total-text`（三族合计）」+
    //     「筛选条三格 `db-gift-chip[data-kind]`（每族各自的条数与金额，`title` 上逐字可读）」；
    //   · 旧的**整块礼物栏** → `db-gift-pane`（栏内那一段，盒子与 `db-pane-gift` 同宽高）；
    //   · 旧的**开合** → `db-gift-toggle` 的 `aria-expanded`（条本身不是按钮，见 docs/ui.md §5.4）。
    var cheapSummary = function () {
      var el = byTestId("db-gift-total-text");
      return el ? el.innerText.trim() : null;
    };
    // 某一族的口径（`gift` / `superchat` / `guard`）：`title` = `${族名} ${条数} 条 · ${金额}（点击筛选）`。
    // 它与总计条是**两条数据链**（三格走**筛前**全集 `panelAllRows`、总计条走**筛后** `giftRows`），
    // 因此把一个数同时钉在两处，比改前从句号和括号里抠字串更硬。
    var cheapChipTitle = function (kind) {
      var chip = allByTestId("db-gift-chip").filter(function (c) {
        return c.getAttribute("data-kind") === kind;
      })[0];
      return chip ? chip.getAttribute("title") : null;
    };
    var cheapKindText = function (kind) {
      var t = cheapChipTitle(kind);
      return t === null ? "" : t;
    };
    var cheapPanelOpen = function () { return !!byTestId("db-panel"); };
    var cheapSetPanel = async function (open) {
      if (cheapPanelOpen() !== open) {
        clickTool("筛选");
        await sleep(400);
      }
      return cheapPanelOpen() === open;
    };
    // 礼物栏的开合走 `db-gift-toggle` 的 `aria-expanded`：这枚小箭头才是开合入口
    // （总计条 `db-gift-total` 本身不是按钮，需求 4.4；旧的 `db-gift-dock` 钩子已随本批移除）。
    var cheapPaneExpanded = function () {
      var toggle = byTestId("db-gift-toggle");
      return !!toggle && toggle.getAttribute("aria-expanded") === "true";
    };
    var cheapSetPane = async function (open) {
      var toggle = byTestId("db-gift-toggle");
      if (cheapPaneExpanded() !== open && toggle) {
        toggle.click();
        await sleep(500);
      }
      return cheapPaneExpanded() === open;
    };
    var cheapBoxOf = function (label) {
      var panel = byTestId("db-panel");
      if (!panel) return null;
      var picked = [].slice.call(panel.querySelectorAll("label")).filter(function (l) {
        return l.innerText.trim() === label;
      })[0];
      return picked ? picked.querySelector('input[type="checkbox"]') : null;
    };

    // ---- ① 默认关：干净房间里两枚开关都没勾着、偏好也都是 false（契约 §8）
    var cheapPanelForDefaults = await cheapSetPanel(true);
    var cheapFoldBox0 = cheapBoxOf("折叠低价礼物");
    var cheapExcludeBox0 = cheapBoxOf("剔除低价礼物统计");
    out.cheapGiftSwitchesDefaultOff = cheapPanelForDefaults &&
      window.__prefs["ui.gift_collapse_cheap"] === false &&
      window.__prefs["ui.gift_exclude_cheap_stats"] === false &&
      !!cheapFoldBox0 && !cheapFoldBox0.checked &&
      !!cheapExcludeBox0 && !cheapExcludeBox0.checked;
    await cheapSetPanel(false);

    // ---- ② 折叠：0.09 元 / 0.10 元（两条低价）与 0.11 元（不是低价）各一条 —— 礼物栏条目数
    //         只该因为两条低价合成一条而 -1，折叠头那份**统计**逐字不动（折叠只管形状）。
    cheapPush("gift", "投喂 铅笔", 90);
    cheapPush("gift", "投喂 铅笔屑", 100);
    cheapPush("gift", "投喂 橡皮", 110);
    await sleep(800);
    var cheapPaneBefore = await cheapSetPane(true);
    out.cheapGiftRowsBeforeFold = cheapRowCount();
    out.cheapGiftPaneExpandedBeforeFold = cheapPaneBefore;
    out.cheapGiftSummaryBeforeFold = cheapSummary();
    out.cheapGiftThreeRowsSeparate = cheapRowCount() === 3 &&
      cheapPaneText().indexOf("投喂 铅笔") >= 0 &&
      cheapPaneText().indexOf("投喂 铅笔屑") >= 0 &&
      cheapPaneText().indexOf("投喂 橡皮") >= 0 &&
      // 三条各归各：总计条 = 礼物这一族 3 条 · 0.3 元（此刻只有礼物族，三格与总计条同一个数）。
      cheapSummary() === totalLine(3, 0.3);
    await cheapSetPanel(true);
    out.cheapGiftFoldToggled = setGiftSwitch("折叠低价礼物", true);
    await sleep(400);
    await cheapSetPanel(false);
    await cheapSetPane(true);
    out.cheapGiftRowsAfterFold = cheapRowCount();
    out.cheapGiftFoldMergesRows = out.cheapGiftRowsBeforeFold === 3 && cheapRowCount() === 2;
    // 合并行的身份取桶里**第一条**（投喂 铅笔）、数量与金额是整桶合计（×2 / 0.19 元）；
    // 第二条低价礼物不再单独成行，0.11 元那条与它无关、照旧一行。
    out.cheapGiftBucketRowText = cheapPaneText();
    out.cheapGiftBucketRow = cheapPaneText().indexOf("投喂 铅笔") >= 0 &&
      cheapPaneText().indexOf("投喂 铅笔屑") < 0 &&
      cheapPaneText().indexOf("×2") >= 0 &&
      cheapPaneText().indexOf("0.19 元") >= 0;
    out.cheapGiftNonCheapRowStays = cheapPaneText().indexOf("投喂 橡皮") >= 0;
    out.cheapGiftFoldKeepsStats = cheapSummary() === out.cheapGiftSummaryBeforeFold;
    // 界面侧「存得住」：面板关掉再开，复选框画的仍是那枚偏好（真落盘见 prefs.rs 的 roundtrip 用例）
    await cheapSetPanel(true);
    var cheapFoldBox1 = cheapBoxOf("折叠低价礼物");
    out.cheapGiftFoldPersists = window.__prefs["ui.gift_collapse_cheap"] === true &&
      !!cheapFoldBox1 && cheapFoldBox1.checked;

    // ---- ③ 剔除统计：折叠关回去、剔除打开 —— 礼物栏**条目数不变**（展示不动），折叠头的
    //         条数与金额只算剩下的那一条 0.11 元。
    out.cheapGiftExcludeToggled = setGiftSwitch("折叠低价礼物", false) &&
      setGiftSwitch("剔除低价礼物统计", true);
    await sleep(400);
    await cheapSetPanel(false);
    await cheapSetPane(true);
    out.cheapGiftRowsWithExcludeCount = cheapRowCount();
    out.cheapGiftExcludeKeepsRowCount = out.cheapGiftRowsWithExcludeCount === 3;
    out.cheapGiftSummaryAfterExclude = cheapSummary();
    out.cheapGiftExcludeKeepsDisplay = cheapPaneText().indexOf("投喂 铅笔") >= 0 &&
      cheapPaneText().indexOf("投喂 铅笔屑") >= 0 &&
      cheapPaneText().indexOf("投喂 橡皮") >= 0;
    out.cheapGiftExcludeChangesStats =
      out.cheapGiftSummaryAfterExclude === totalLine(1, 0.11) &&
      // 第二条证据来自**另一条数据链**（筛选条那格 = 筛前口径的礼物族）：
      // 0.09 / 0.10 两条低价礼物被剔出统计后，这一族只剩 0.11 元那一条。
      cheapKindText("gift").indexOf("礼物 1 条 · ¥" + yuan(0.11)) >= 0 &&
      out.cheapGiftSummaryAfterExclude !== out.cheapGiftSummaryBeforeFold;

    // ---- ④ 边界：0 元（上游没给价）不是低价、SC 与大航海两边都不进这枚键的口径。
    //        剔除仍开着：礼物组里 0.11 元那条**不低价、留着**，再加上没给价的那一条 —— 两条都在
    //        统计里，金额只算 0.11 元（0 元那条本来就不画金额格）。判据落在**条数 = 2** 上：
    //        若把 0 当低价，它会被一并剔掉、这一组只剩 1 条（「礼物 1 · 0.11 元」），所以这条
    //        断言正好钉住「0 不是低价」这个边界（实测值见本轮报告，两引擎四个视口逐字相同）。
    cheapPush("gift", "投喂 尺子", 0);
    cheapPush("superchat", "脱敏的边界样本留言", 30);
    cheapPush("guard", "开通 舰长 ×1", 138000, { guard_level: 3 });
    await sleep(800);
    await cheapSetPane(true);
    out.cheapGiftSummaryBoundary = cheapSummary();
    out.cheapGiftSummaryBoundaryChips = ["gift", "superchat", "guard"].map(cheapKindText);
    // 三个判据，分别钉住总数、礼物族的条数与另外两族：
    //   ① 总计条 = 三族合计（2 + 1 + 1 = 4 条，0.11 + 30 + 138 = 168.11 元）；
    //   ② 礼物族那一格 = **2 条**（0.11 元那条 + 没给价那条）—— 这正是「0 元不算低价」的边界：
    //      若把 0 当低价，它会被一并剔掉、这一族只剩 1 条；
    //   ③ SC 与 大航海 两格各 1 条、金额原样，不受这枚键影响。
    out.cheapGiftZeroPriceNotCheap =
      out.cheapGiftSummaryBoundary === totalLine(4, 168.11) &&
      cheapKindText("gift").indexOf("礼物 2 条 · ¥" + yuan(0.11)) >= 0 &&
      cheapKindText("superchat").indexOf("SC 1 条 · ¥" + yuan(30)) >= 0 &&
      cheapKindText("guard").indexOf("大航海 1 条 · ¥" + yuan(138)) >= 0;
    // SC / 大航海两边都不进这枚键的口径：三格里那两串与上一步（只开剔除）逐字相同。
    // 旧写法是从整串汇总里 `slice` 出尾巴的那一段（「SC 1 · 30 元 / 大航海 1 · 138 元」）；
    // 单轴模型之后串已经不在一起了，尾巴因此改从**两格**上读。
    var cheapScGuardTail = function () {
      return [cheapKindText("superchat"), cheapKindText("guard")].join(" | ");
    };
    var cheapScGuardExcludeOnly = cheapScGuardTail();
    // 两枚都开：统计口径与「只开剔除」逐字相同（折叠不改统计），SC / 大航海两组也逐字相同。
    await cheapSetPanel(true);
    var cheapFoldOnAgain = setGiftSwitch("折叠低价礼物", true);
    await sleep(400);
    await cheapSetPanel(false);
    await cheapSetPane(true);
    out.cheapGiftBothOnSummary = cheapSummary();
    out.cheapGiftBothOnStatsUnchanged = cheapFoldOnAgain &&
      cheapSummary() === out.cheapGiftSummaryBoundary;
    out.cheapGiftScGuardUntouched =
      cheapKindText("superchat").indexOf("SC 1 条 · ¥" + yuan(30)) >= 0 &&
      cheapKindText("guard").indexOf("大航海 1 条 · ¥" + yuan(138)) >= 0 &&
      cheapScGuardTail() === cheapScGuardExcludeOnly;

    // ---- 收尾：两枚开关恢复默认（false）、面板收起、回到原来的房间
    await cheapSetPanel(true);
    var cheapRestoreFold = setGiftSwitch("折叠低价礼物", false);
    var cheapRestoreExclude = setGiftSwitch("剔除低价礼物统计", false);
    await sleep(400);
    await cheapSetPanel(false);
    out.cheapGiftRestoredDefaults = cheapRestoreFold && cheapRestoreExclude &&
      window.__prefs["ui.gift_collapse_cheap"] === false &&
      window.__prefs["ui.gift_exclude_cheap_stats"] === false;
    if (cheapHomeId) {
      cheapTabFor(cheapHomeId).click();
      await sleep(800);
    }
    out.cheapGiftHomeRoomRestored = !!cheapHomeId && cheapActiveRoomId() === cheapHomeId;

    /* ==== switchscope：两枚低价礼物开关的「**两个区域**」与「不丢内容 / 开关可逆」
       （issue 2609171849 第 5 条；本票 = feat/2609171849-switch-scope，见 docs/ui.md §5.3 与 §4.8）

       「两个区域」= **弹幕区**（行钩子 db-msg-row）与**礼物栏**（db-gift-row）——礼物类消息
       按 ui.gift_in_danmaku / ui.gift_panel 分别落进这两栏，用户在同一屏里同时看得到（默认两枚
       都开）。本段把每条口径都**在两处各量一次**：
         ① 折叠（ui.gift_collapse_cheap）：低价礼物在两处都合并成一条（桶取第一条的身份与位置，
            ×N 与金额是整桶合计），0.11 元那条与它无关、两处都照旧一行；
         ② 关掉折叠：两处**逐条回来**，顺序（铅笔 → 铅笔屑 → 橡皮）、条目数、各行金额都回到原值；
         ③ 剔除统计（ui.gift_exclude_cheap_stats）：只改**统计**（礼物栏折叠头的「礼物 / SC（N）」
            与分组明细）—— 两个区域的行**一条都不动**；关掉它统计逐字回到原串。
       （互动消息那一路「自动消失」已随 ui.interact_auto_hide 删除：互动消息改由单槽位浮层
        呈现、弹幕列表里一条都不画，「关掉开关回到列表行」这条口径不再存在。）
       ⚠ 准入前提全部在本块内自备（§9.3 ②）：切回**空会话**的第二房间（只有本段推的夹具）、
          两枚低价礼物开关各自先拨到既定值、礼物栏展开（行数才等于条目数）。
       ⚠ 整块包一层 try/catch + switchScopeBlockRan（§9.3 ①）：出岔子只作废本块、不带走整场。 */
    var switchScopeBlockRan = false;
    try {
      var ssRoomId = 5555;
      // 计数用：弹幕区里含某条礼物的行有几条（礼物栏那一族用 cheapRowCount / cheapPaneText）。
      // 判据是「子串命中，且命中处后面不紧跟汉字」：夹具里「投喂 铅笔」是「投喂 铅笔屑」的
      // 前缀，纯子串会同时命中两条（首次真跑即此红）；折叠之后只剩桶行、它的文本比礼物名长，
      // 所以也不能改成精确相等。这里用 charCodeAt 判汉字区间、不用正则 —— 当年是因为整个场景活在
      // 模板串里（反斜杠转义会被吃掉）；2026-09-17 拆分后约束已消失，写法保持原样。
      var ssChatRowsWith = function (needle) {
        return rows().filter(function (r) {
          var body = r.innerText;
          var n = needle.length;
          for (var i = body.indexOf(needle); i >= 0; i = body.indexOf(needle, i + 1)) {
            var after = body.slice(i + n, i + n + 1);
            if (after === "") return true;
            var c = after.charCodeAt(0);
            if (!(c >= 0x3400 && c <= 0x9fff)) return true;
          }
          return false;
        });
      };
      // 面板里的一枚开关拨到指定值（面板自己开合，幂等）：返回「找没找到并拨成功」。
      var ssToggle = async function (label, value) {
        var opened = await cheapSetPanel(true);
        var found = setGiftSwitch(label, value);
        await sleep(300);
        await cheapSetPanel(false);
        return opened && found;
      };

      var ssTab = cheapTabFor(ssRoomId);
      out.switchScopeFreshRoomTab = !!ssTab;
      if (!ssTab) throw new Error("第二房间的标签拿不到（标签条前提失效）");
      ssTab.click();
      await sleep(900);
      out.switchScopeFreshRoomActive = cheapActiveRoomId() === String(ssRoomId);
      if (!out.switchScopeFreshRoomActive) throw new Error("没切进第二房间");

      out.switchScopeSwitchesSet = (await ssToggle("折叠低价礼物", false)) &&
        (await ssToggle("剔除低价礼物统计", false)) &&
        window.__prefs["ui.gift_collapse_cheap"] === false &&
        window.__prefs["ui.gift_exclude_cheap_stats"] === false;

      // ---- ① 默认（两枚都关）：两个区域都一条一行
      cheapPush("gift", "投喂 铅笔", 90);
      cheapPush("gift", "投喂 铅笔屑", 100);
      cheapPush("gift", "投喂 橡皮", 110);
      await sleep(800);
      var ssPaneOpen = await cheapSetPane(true);
      out.switchScopeGiftRowsBefore = cheapRowCount();
      out.switchScopeSummaryBefore = cheapSummary();
      out.switchScopeBaseline = ssPaneOpen &&
        ssChatRowsWith("投喂 铅笔").length === 1 &&
        ssChatRowsWith("投喂 铅笔屑").length === 1 &&
        ssChatRowsWith("投喂 橡皮").length === 1 &&
        out.switchScopeGiftRowsBefore === 3 &&
        cheapPaneText().indexOf("0.09 元") >= 0 &&
        cheapPaneText().indexOf("0.1 元") >= 0 &&
        cheapPaneText().indexOf("0.11 元") >= 0 &&
        // 统计：总计条三族合计那一串（此刻本场只有礼物族 3 条 · 0.3 元）。
        out.switchScopeSummaryBefore === totalLine(3, 0.3) &&
        cheapKindText("gift").indexOf("礼物 3 条 · ¥" + yuan(0.3)) >= 0;

      // ---- ② 折叠开：**两个区域都折**（弹幕区少一行、桶行带 ×2；礼物栏条目 3 → 2）
      out.switchScopeFoldToggled = (await ssToggle("折叠低价礼物", true)) &&
        window.__prefs["ui.gift_collapse_cheap"] === true;
      await cheapSetPane(true);
      var ssChatBucketRows = ssChatRowsWith("投喂 铅笔");
      // ⚠ 桶行的 ×N 在**身份位**（`db-msg-spam`，写「低价礼物 ×N」），**不在**正文那格
      //   `db-msg-count`：2026-09-22 第 3 条把低价礼物桶改成与刷屏聚合**同一套形态**
      //   （`MessageRow`：`aggregated` 时身份位印数量，正文里那格行内 ×N **不画**——
      //   同一个数不在一行里出现两次）。旧断言查 `db-msg-count`，在这条改动之后恒红：
      //   **是这一句落后于实现，不是实现的 bug**（ui.md §5.3 / §8.4、MessageRow 两处对得上）。
      var ssChatBucketSpam = ssChatBucketRows.length === 1
        ? ssChatBucketRows[0].querySelector('[data-testid="db-msg-spam"]') : null;
      out.switchScopeChatPaneFolds = ssChatBucketRows.length === 1 &&
        ssChatRowsWith("投喂 铅笔屑").length === 0 &&
        !!ssChatBucketSpam && ssChatBucketSpam.innerText.indexOf("低价礼物 ×2") >= 0;
      // 同一个数只出现一次：聚合行正文里那格 `db-msg-count` 确实没画（0.11 元那条不是聚合行，
      // 它照旧有 ×1 那一格，所以判据只在**桶行**上取）。
      out.switchScopeBucketNoInlineCount = ssChatBucketRows.length === 1 &&
        ssChatBucketRows[0].querySelector('[data-testid="db-msg-count"]') === null;
      out.switchScopeGiftRowsAfterFold = cheapRowCount();
      var ssGiftBucketSpam = allByTestId("db-gift-spam")[0];
      out.switchScopeGiftPaneFolds = out.switchScopeGiftRowsAfterFold === 2 &&
        cheapPaneText().indexOf("投喂 铅笔屑") < 0 &&
        cheapPaneText().indexOf("0.19 元") >= 0 &&
        !!ssGiftBucketSpam && ssGiftBucketSpam.innerText.indexOf("低价礼物 ×2") >= 0;
      out.switchScopeBothPanesFold = out.switchScopeChatPaneFolds && out.switchScopeGiftPaneFolds;
      // 折叠只管形状：统计逐字不动（含头部那个 N）。
      out.switchScopeFoldKeepsStats = cheapSummary() === out.switchScopeSummaryBefore;
      // 0.11 元那条不是低价，两个区域都照旧单独一行。
      out.switchScopeNonCheapRowUntouched = ssChatRowsWith("投喂 橡皮").length === 1 &&
        cheapPaneText().indexOf("投喂 橡皮") >= 0;

      // ---- ③ 折叠关回去：两处**逐条回来**（数量 / 顺序 / 金额 / 统计逐项复原）
      out.switchScopeFoldOff = (await ssToggle("折叠低价礼物", false)) &&
        window.__prefs["ui.gift_collapse_cheap"] === false;
      await cheapSetPane(true);
      var ssPencilRow = rowWith("投喂 铅笔");
      var ssPencilDustRow = rowWith("投喂 铅笔屑");
      var ssRubberRow = rowWith("投喂 橡皮");
      out.switchScopeChatRowsRestored = ssChatRowsWith("投喂 铅笔").length === 1 &&
        ssChatRowsWith("投喂 铅笔屑").length === 1 && ssChatRowsWith("投喂 橡皮").length === 1;
      out.switchScopeChatOrderRestored = !!ssPencilRow && !!ssPencilDustRow && !!ssRubberRow &&
        (ssPencilRow.compareDocumentPosition(ssPencilDustRow) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
        (ssPencilDustRow.compareDocumentPosition(ssRubberRow) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      out.switchScopeGiftRowsRestored = cheapRowCount() === out.switchScopeGiftRowsBefore;
      out.switchScopeAmountsRestored = cheapPaneText().indexOf("0.09 元") >= 0 &&
        cheapPaneText().indexOf("0.1 元") >= 0 && cheapPaneText().indexOf("0.11 元") >= 0;
      out.switchScopeSummaryRestored = cheapSummary() === out.switchScopeSummaryBefore;
      out.switchScopeBothPanesRestore = out.switchScopeChatRowsRestored &&
        out.switchScopeChatOrderRestored && out.switchScopeGiftRowsRestored &&
        out.switchScopeAmountsRestored && out.switchScopeSummaryRestored;

      // ---- ④ 剔除统计：只改统计，两个区域的行一条不动
      out.switchScopeExcludeToggled = (await ssToggle("剔除低价礼物统计", true)) &&
        window.__prefs["ui.gift_exclude_cheap_stats"] === true;
      await cheapSetPane(true);
      var ssExcludeSummary = cheapSummary();
      out.switchScopeExcludeKeepsPanes = ssChatRowsWith("投喂 铅笔").length === 1 &&
        ssChatRowsWith("投喂 铅笔屑").length === 1 && ssChatRowsWith("投喂 橡皮").length === 1 &&
        cheapRowCount() === out.switchScopeGiftRowsBefore;
      out.switchScopeExcludeTouchesStatsOnly = out.switchScopeExcludeKeepsPanes &&
        ssExcludeSummary === totalLine(1, 0.11) &&
        // 换一条数据链再钉一次（筛选条那格 = 筛前口径的礼物族）：低价两条被剔出统计后只剩 0.11 元那条。
        cheapKindText("gift").indexOf("礼物 1 条 · ¥" + yuan(0.11)) >= 0 &&
        ssExcludeSummary !== out.switchScopeSummaryBefore;

      // ---- ⑤ 剔除关回去：统计逐字回到原串（头部 N 一起回来）
      out.switchScopeExcludeOff = (await ssToggle("剔除低价礼物统计", false)) &&
        window.__prefs["ui.gift_exclude_cheap_stats"] === false;
      // 关回去 ⇒ 统计逐字复原（头部那个「N 条」跟着一起回来）：两处口径各自回归原值。
      out.switchScopeExcludeRestoresStats = cheapSummary() === out.switchScopeSummaryBefore &&
        cheapKindText("gift").indexOf("礼物 3 条 · ¥" + yuan(0.3)) >= 0;

      // ---- 收尾：两枚低价礼物开关回到契约 §8 的默认值、回到原来的房间（下一段从房间页开始量）
      out.switchScopeDefaultsRestored = window.__prefs["ui.gift_collapse_cheap"] === false &&
        window.__prefs["ui.gift_exclude_cheap_stats"] === false;
      if (cheapHomeId) {
        cheapTabFor(cheapHomeId).click();
        await sleep(800);
      }
      out.switchScopeHomeRoomRestored = !!cheapHomeId && cheapActiveRoomId() === cheapHomeId;
      snap();
      switchScopeBlockRan = true;
    } catch (e) {
      out.switchScopeBlockError = String((e && e.stack) || e);
      switchScopeBlockRan = false;
    }
    out.switchScopeBlockRan = switchScopeBlockRan;

