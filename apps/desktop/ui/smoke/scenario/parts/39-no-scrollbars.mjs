// 场景块：全局不画滚动条（用户 2026-10-01 第 2 条）——**滚动能力一项不减，只是不画条、不留槽**
//   ① 全量扫描：把当前 DOM 里**真的可滚**的元素全挑出来（竖轴 `scrollHeight > clientHeight`
//      且 overflowY 是 auto / scroll；横轴 `scrollWidth > clientWidth` 且 overflowX 是
//      auto / scroll —— **两轴都要**，只扫竖轴会把横向滚动容器整类漏掉），逐轴断言「滚动条盒 = 0」：
//      竖轴 offsetWidth - clientWidth - 左右边框、横轴 offsetHeight - clientHeight - 上下边框。
//      占位式滚动条会把内容区吃掉一条，覆盖式本来就为 0，所以①对后者验不出东西，
//      它的可观察面是 ②。
//      横轴那一档另有一层**定点覆盖**（写在下面「房管面板」那段）：`.adminRail` 与 `.adminName`
//      是否溢出由夹具决定，不能靠几何，改读它们的 `scrollbar-width` 计算值 ——
//      这两个容器原先各自写死的 `::-webkit-scrollbar { display: none }` 已被删掉、
//      现在全靠 `index.css` 那一条全局规则兜住，兜不住就是本次引入的回归。
//   ② 同一个元素上 `scrollbar-width` 的计算值必须是 `none`。⚠ 不认这个属性的老引擎
//      （宿主 WebKit 的老版本）getComputedStyle 返回**空串**、不是 "auto" —— 那种引擎走的是
//      `::-webkit-scrollbar { display: none }`，①的几何量是它唯一的可观察面，所以这里
//      「空串或 none 都算过」，别让断言假红。
//   ③ 准入前提自己凑：四个面板（表情 / 短语 / 筛选 / 房管）都走**真实交互路径**打开
//      （工具行按钮 / ⋯ 菜单那一路上），在它们展开的状态下各扫一遍 —— 只扫弹幕流的话，
//      面板里的滚动条永远验不到。短语面板内容撑不满时**自己加**（「输入框 → 添加」这条真
//      路径），直到面板里真的出现一个可滚元素：「不画条」要在**真的有得滚**的地方才验得到。
//      收尾把面板收掉、弹幕列表贴回底部。
//   ④ 「滚动能力没丢」：db-chat-scroll 仍然可滚（scrollHeight > clientHeight），且宽度
//      没被滚动条吃掉 —— 只验「没有条」的话，把 overflow 一并干掉也能假绿。
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    var noScrollbarBlockRan = false;
    try {
      // ---- 扫描工具（本块自带，名字一律 ns 前缀，不占共享作用域里的常用名）
      var nsRound = function (v) { return Math.round(v * 10) / 10; };
      /** 竖向滚动条占掉的宽度（0 = 没画条 / 画的是覆盖式）：offsetWidth 含边框，clientWidth 不含边框与滚动条。 */
      var nsGutterPx = function (el) {
        var cs = getComputedStyle(el);
        var borders = (parseFloat(cs.borderLeftWidth) || 0) +
          (parseFloat(cs.borderRightWidth) || 0);
        return nsRound(el.offsetWidth - el.clientWidth - borders);
      };
      /** 横向滚动条占掉的高度（同一套算法换到 Y 轴）：横向那条躺在容器底边，吃掉的是高度。 */
      var nsHGutterPx = function (el) {
        var cs = getComputedStyle(el);
        var borders = (parseFloat(cs.borderTopWidth) || 0) +
          (parseFloat(cs.borderBottomWidth) || 0);
        return nsRound(el.offsetHeight - el.clientHeight - borders);
      };
      /**
       * `scrollbar-width` 的计算值。老引擎不认这个属性时返回**空串**（上面②说明了为什么容掉它）。
       * 用 getComputedStyle 读而不是看 JS 侧有没有这个属性名 —— 要看的是**引擎算出来的值**。
       */
      var nsScrollbarWidthOf = function (el) {
        var v = getComputedStyle(el).scrollbarWidth;
        return v === null || v === undefined ? "" : String(v).trim();
      };
      /**
       * 真的可竖向滚：内容超出**且**这一轴交给了滚动容器。
       * ⚠ visible / hidden 的盒子不算（前者会把滚动交给祖先、后者根本没有滚动这回事），
       *   混进来会让「滚动条盒宽」量到一个压根不画条的盒子上 —— 那就是假绿。
       * ⚠ SVG 元素没有 offsetWidth / scrollHeight（`undefined`），在这里被过滤掉。
       */
      var nsVScrollable = function (el) {
        if (!el || el.scrollHeight === undefined || el.clientHeight === undefined) return false;
        var oy = getComputedStyle(el).overflowY;
        return el.scrollHeight > el.clientHeight + 1 && (oy === "auto" || oy === "scroll");
      };
      /**
       * 真的可横向滚。横着一档必须有这一条 —— **只扫竖轴会让 `.adminRail`（房管分组 tab 轨道）
       * 与 `.adminName`（名单里的名字格）一个都验不到**：它们是横向溢出，而这批改动正好把它们的
       * 自有 `::-webkit-scrollbar { display: none }` 删了、改由 `index.css` 的全局规则兜住
       * （`.tabs` 那一条则由 33 的 `tabStripScrollbarThicknessPx` 单独覆盖，不重复验）。
       */
      var nsHScrollable = function (el) {
        if (!el || el.scrollWidth === undefined || el.clientWidth === undefined) return false;
        var ox = getComputedStyle(el).overflowX;
        return el.scrollWidth > el.clientWidth + 1 && (ox === "auto" || ox === "scroll");
      };
      var nsNameOf = function (el) {
        var id = el.getAttribute ? el.getAttribute("data-testid") : null;
        return id || ((el.tagName ? el.tagName.toLowerCase() : "?") + (el.id ? "#" + el.id : ""));
      };
      /** 竖轴或横轴真的可滚的元素：两轴都挑，只挑竖轴会把横向滚动容器整类漏掉。 */
      var nsAllScrollers = function () {
        return [].slice.call(document.querySelectorAll("*")).filter(function (el) {
          return nsVScrollable(el) || nsHScrollable(el);
        });
      };
      var nsInside = function (root, el) {
        return !!root && !!el && (root === el || root.contains(el));
      };

      // 累计结果：nsBad = 扫出问题的元素（红的时候能直接定位），nsSeen / nsStates = 值字段
      var nsBad = [];
      var nsSeen = [];
      var nsPanelScrollers = [];
      var nsStates = [];
      /**
       * 扫一遍并把结果累进上面四个集合。root 有值时，落在 root 里的可滚元素同时记进
       * nsPanelScrollers —— 「面板真的溢出了、而且被扫到了」靠它证明。
       */
      var nsScanAt = function (state, root) {
        var items = nsAllScrollers().map(function (el) {
          var cs = getComputedStyle(el);
          var sw = nsScrollbarWidthOf(el);
          var name = nsNameOf(el);
          // 每个轴**各自**量槽：只在那个轴真的溢出时才量 —— 没溢出的轴压根不画滚动条，
          // 量出来的差值会混进别的东西（例如裁剪到内容上的边框），把断言变成假的红。
          var vGutter = nsVScrollable(el) ? nsGutterPx(el) : 0;
          var hGutter = nsHScrollable(el) ? nsHGutterPx(el) : 0;
          var worst = vGutter > hGutter ? vGutter : hGutter;
          // 两条：① 没给滚动条留槽（竖 / 横任一轴 > 0 都算）；② 引擎算出来的 scrollbar-width 是 none（或引擎不认 → 空串）
          if (worst > 0.5 || !(sw === "none" || sw === "")) {
            nsBad.push({
              state: state, el: name, gutterPx: vGutter, hGutterPx: hGutter, scrollbarWidth: sw,
            });
          }
          if (nsInside(root, el) && nsPanelScrollers.indexOf(name) < 0) nsPanelScrollers.push(name);
          if (nsSeen.indexOf(name) < 0) nsSeen.push(name);
          return {
            el: name, gutterPx: vGutter, hGutterPx: hGutter,
            scrollbarWidth: sw, overflowY: cs.overflowY, overflowX: cs.overflowX,
          };
        });
        nsStates.push({ state: state, scrollers: items.length, items: items });
        return items;
      };

      // ---- 准入前提①：停在**房间页**（工具行 db-composer-tools 只在房间页；
      //      面板与弹幕流是这一段唯一的可观察面，不在这里就什么都量不到）
      if (!byTestId("db-composer-tools")) {
        if (byTestId("db-header-back")) {
          byTestId("db-header-back").click();
          await sleep(600);
        }
        var nsCard = byTestId("db-room-card");
        if (!nsCard) throw new Error("列表页没有房间卡（db-room-card 不在）");
        nsCard.click();
        await sleep(900);
      }
      if (!byTestId("db-composer-tools")) throw new Error("房间页没起来（db-composer-tools 不在）");
      // 输入区在「未连接」时整块禁用（docs/ui.md §6.1），点一枚 disabled 的工具按钮**不派发
      // click** —— 面板永远开不出来而 clickTool 照样返回 true。这里显式把连接态推成已连接，
      // 免得下面四块全变成「没打开」而不是「不画条」。
      window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
      window.__emit("danmubox://room", {
        room_id: fixtureRoom.room_id, connected: true, live_status: fixtureRoom.live_status,
      });
      await sleep(400);

      // ---- 准入前提②：弹幕流真的可滚（本块要拿它验「滚动能力没丢」）。不够就自己补一批消息。
      var nsChat = byTestId("db-chat-scroll");
      if (!nsChat) throw new Error("db-chat-scroll 不在（房间页没起来？）");
      if (nsChat.scrollHeight <= nsChat.clientHeight + 20) {
        for (var nsN = 0; nsN < 40; nsN += 1) {
          window.__emit("danmubox://message", window.__mk("danmaku", "无滚动条取样 " + nsN, false, {
            room_id: fixtureRoom.room_id, uname: "取样观众", ts: Date.now() + nsN,
          }));
        }
        await sleep(700);
      }
      out.noScrollbarChatScrollable = nsChat.scrollHeight > nsChat.clientHeight + 1;
      nsScanAt("chat", null);

      // 工具行里那枚按钮是**开关**：点开同一个面板（prove 验「真的是这一个面板」）
      var nsOpenToolPanel = async function (label, prove) {
        clickTool(label);
        await sleep(450);
        var panel = byTestId("db-panel");
        return !!panel && prove(panel);
      };
      // 收面板走「点面板外面」那条路（与 34 同一手法：body 上一发 pointerdown）
      var nsClosePanel = async function () {
        document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await sleep(350);
        return !byTestId("db-panel");
      };

      // ---- 表情面板（真实路径：工具行「表情」）。网格区定高三行，通用那 38 条必然滚得起来；
      //      tab 轨道（db-emote-tabs）也是一条滚动轴 —— 两个是否溢出都记进值字段。
      out.noScrollbarEmoteOpened = await nsOpenToolPanel("表情", function (p) {
        return !!p.querySelector('[data-testid="db-emote-group"]');
      });
      var nsGrid = byTestId("db-emote-group");
      var nsRail = byTestId("db-emote-tabs");
      // 这两个**只记值、不作闸门**：是否溢出取决于视口宽度 —— 宽屏一行排得多，38 条通用表情
      // 三行就装下了（窄屏必然溢出）。当闸门的话同一个断言在宽屏必红，而它与「不画条」无关。
      out.noScrollbarEmoteGridOverflowPx = nsGrid
        ? Math.round((nsGrid.scrollHeight - nsGrid.clientHeight) * 10) / 10 : null;
      out.noScrollbarEmoteRailOverflowPx = nsRail
        ? Math.round((nsRail.scrollHeight - nsRail.clientHeight) * 10) / 10 : null;
      nsScanAt("emote", byTestId("db-panel"));
      out.noScrollbarEmoteClosed = await nsClosePanel();

      // ---- 短语面板（真实路径：工具行「短语」）。内容撑不满面板高度时**自己加**：
      //      「不画条」要在真的有得滚的地方验，拿一个内容还没溢出的面板扫一遍等于什么都没验。
      out.noScrollbarPhraseOpened = await nsOpenToolPanel("短语", function (p) {
        return !!p.querySelector('[data-testid="db-phrase-add"]');
      });
      var nsPhraseScrollers = function () {
        var p = byTestId("db-panel");
        return nsAllScrollers().filter(function (el) { return nsInside(p, el); });
      };
      var nsAdded = 0;
      for (var nsK = 0; nsK < 14 && nsPhraseScrollers().length === 0; nsK += 1) {
        var nsAddRow = byTestId("db-phrase-add");
        var nsInput = nsAddRow ? nsAddRow.querySelector("input") : null;
        var nsAddBtn = buttonWith(byTestId("db-panel"), "添加");
        if (!nsInput || !nsAddBtn) break;
        typeInto(nsInput, "无滚动条取样短语" + nsK);
        await sleep(120);
        nsAddBtn.click();
        await sleep(220);
        nsAdded += 1;
      }
      out.noScrollbarPhrasesAdded = nsAdded;
      // 同上，**只记值**：短语面板能不能被撑到溢出取决于面板高度与补进去的条数，宽屏补到上限
      // 也未必溢出 —— 「不画条」的判据不能挂在它身上。
      out.noScrollbarPhraseScrollerCount = nsPhraseScrollers().length;
      nsScanAt("phrase", byTestId("db-panel"));
      out.noScrollbarPhraseClosed = await nsClosePanel();

      // ---- 筛选面板（真实路径：工具行「筛选」）
      out.noScrollbarFilterOpened = await nsOpenToolPanel("筛选", function (p) {
        return !!p.querySelector('[data-testid="db-filter-kinds"]');
      });
      nsScanAt("filter", byTestId("db-panel"));
      out.noScrollbarFilterClosed = await nsClosePanel();

      // ---- 房管面板：开 / 关只有一条路（⋯ 菜单里那一项），与 31 同一手法。
      //      ⚠ **房管身份必须先自己发回来**：31 那段结尾会把 `is_admin` 发成 false（面板随即自动
      //      收起），而没有房管身份时 ⋯ 菜单里**根本没有**「房管面板」这一项 —— 不发身份这里必然
      //      开不出来，那个红跟「不画滚动条」毫无关系。RoomSession 按契约 §5 全量给
      //      （缺 `danmaku_length` 界面会按缺省 20 回落）。
      window.__setAdmin(true);
      window.__setAdminFail(false);
      window.__emit("danmubox://session", {
        room_id: fixtureRoom.room_id, my_medal_level: 0, my_medal_name: "", my_medal_worn: false,
        my_guard_level: 0, danmaku_length: 40, is_admin: true,
      });
      await sleep(500);
      var nsToggleAdmin = async function () {
        byTestId("db-header-more").click();
        await sleep(250);
        var item = buttonWith(byTestId("db-context-menu"), "房管面板");
        if (item) item.click();
        await sleep(700);
        return !!item;
      };
      await nsToggleAdmin();
      out.noScrollbarAdminOpened = !!byTestId("db-admin-panel");
      var nsAdminList = byTestId("db-admin-list");
      out.noScrollbarAdminListScrollable = !!nsAdminList &&
        getComputedStyle(nsAdminList).overflowY === "auto";
      // 名单**是否溢出**只记值（同上）：它由夹具的行数决定，够不着判据。
      out.noScrollbarAdminListOverflowPx = nsAdminList
        ? Math.round((nsAdminList.scrollHeight - nsAdminList.clientHeight) * 10) / 10 : null;
      nsScanAt("admin", byTestId("db-admin-panel"));

      // ---- 横向那一档的**定点覆盖**：`.adminRail`（db-admin-tabs）与 `.adminName`
      //      （`[data-admin-name]`）是否横向溢出，取决于夹具里的名单长度与名字长短，**不能保证
      //      每次都溢出**，所以这里**不靠几何**判定 —— 读它们的 `scrollbar-width` **计算值**：
      //      计算样式与「此刻溢不溢出」无关，验的正是「`index.css` 那条全局规则够不够得到它们」
      //      （它们原先各自写死的 `::-webkit-scrollbar { display: none }` 已被删掉，
      //      全局那一条兜不住就是本次引入的回归）。溢出与否另记值，只作说明不作闸门。
      var nsAdminPanel = byTestId("db-admin-panel");
      var nsRail2 = byTestId("db-admin-tabs");
      var nsNameCell = nsAdminPanel ? nsAdminPanel.querySelector("[data-admin-name]") : null;
      out.noScrollbarAdminRailPresent = !!nsRail2;
      out.noScrollbarAdminNamePresent = !!nsNameCell;
      out.noScrollbarAdminRailOverflowPx = nsRail2
        ? Math.round((nsRail2.scrollWidth - nsRail2.clientWidth) * 10) / 10 : null;
      // 「够得到」的判据与上面 ② 同口径：none（新引擎）或空串（引擎不认这个属性）
      out.noScrollbarAdminRailPolicy = nsRail2 ? nsScrollbarWidthOf(nsRail2) : "";
      out.noScrollbarAdminNamePolicy = nsNameCell ? nsScrollbarWidthOf(nsNameCell) : "";
      out.noScrollbarAdminHorizCovered = !!nsRail2 && !!nsNameCell &&
        ["none", ""].indexOf(out.noScrollbarAdminRailPolicy) >= 0 &&
        ["none", ""].indexOf(out.noScrollbarAdminNamePolicy) >= 0;

      await nsToggleAdmin();
      out.noScrollbarAdminClosed = !byTestId("db-admin-panel");

      // ---- 滚动能力没丢：弹幕流仍然滚得动，且宽度没被滚动条吃掉
      nsChat = byTestId("db-chat-scroll");
      out.noScrollbarChatStillScrollable = !!nsChat && nsChat.scrollHeight > nsChat.clientHeight + 1;
      var nsMax = nsChat ? nsChat.scrollHeight - nsChat.clientHeight : 0;
      if (nsChat) {
        nsChat.scrollTop = Math.max(0, nsMax - 80);
        await sleep(350);
      }
      var nsUp = nsChat ? nsChat.scrollTop : 0;
      if (nsChat) {
        nsChat.scrollTop = nsChat.scrollHeight;
        await sleep(450);
      }
      out.noScrollbarChatScrolls = !!nsChat && nsUp < nsMax - 1 && nsChat.scrollTop > nsUp;
      out.noScrollbarChatGutterPx = nsChat ? nsGutterPx(nsChat) : null;
      out.noScrollbarChatNoGutter = !!nsChat && nsGutterPx(nsChat) <= 0.5 &&
        nsScrollbarWidthOf(nsChat) !== "auto";
      out.noScrollbarChatBackToBottom = !!nsChat && bottomGap(nsChat) < 8;

      // ---- 汇总
      out.noScrollbarScrollerTotal = nsSeen.length;
      out.noScrollbarPanelScrollers = nsPanelScrollers;
      out.noScrollbarBadCount = nsBad.length;
      out.noScrollbarBad = nsBad;
      out.noScrollbarStates = nsStates;
      // 「全局不画滚动条」= 扫到的每一个可滚元素都没留槽、且 scrollbar-width 是 none
      // （或引擎不认这个属性 → 空串）。nsSeen.length > 0 是准入：一个都没扫到 = 前提没凑齐，
      // 这种「绿」是空的。
      out.noScrollbarZeroGutterEverywhere = nsBad.length === 0 && nsSeen.length > 0;
      out.noScrollbarPanelScrollerTotal = nsPanelScrollers.length;
      out.noScrollbarAllPanelsOpened = out.noScrollbarEmoteOpened &&
        out.noScrollbarPhraseOpened && out.noScrollbarFilterOpened && out.noScrollbarAdminOpened;
      out.noScrollbarAllPanelsClosed = out.noScrollbarEmoteClosed &&
        out.noScrollbarPhraseClosed && out.noScrollbarFilterClosed && out.noScrollbarAdminClosed;
      snap();
      noScrollbarBlockRan = true;
    } catch (e) {
      out.noScrollbarBlockError = String((e && e.stack) || e);
      // 出错也要把断言字段**写出来**（docs/testing.md §9.3 ③）：字段缺席 = 断言静默不跑。
      out.noScrollbarZeroGutterEverywhere = false;
      out.noScrollbarEmoteOpened = false;
      out.noScrollbarPhraseOpened = false;
      out.noScrollbarFilterOpened = false;
      out.noScrollbarAdminOpened = false;
      out.noScrollbarAllPanelsOpened = false;
      out.noScrollbarAllPanelsClosed = false;
      out.noScrollbarAdminListScrollable = false;
      out.noScrollbarAdminRailPresent = false;
      out.noScrollbarAdminNamePresent = false;
      out.noScrollbarAdminHorizCovered = false;
      out.noScrollbarChatStillScrollable = false;
      out.noScrollbarChatNoGutter = false;
      out.noScrollbarChatScrolls = false;
      out.noScrollbarChatBackToBottom = false;
      out.noScrollbarPanelScrollerTotal = 0;
      out.noScrollbarScrollerTotal = 0;
      snap();
    }
    out.noScrollbarBlockRan = noScrollbarBlockRan;
