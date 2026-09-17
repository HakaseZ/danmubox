// 页内片段（在运行器**之前**）：断言与交互的共享工具。
//   out / snap / put / byTestId / allByTestId / rows / rect / text / sleep 等全部断言工具
//   断言里凡要「点一下」都走这里（typeInto / pressKey / pressEscape / openRowMenu / setGiftSwitch …）
//   NARROW / put 由 20-room-list.mjs 开头设置（视口档位），其余块只读
//
// 本文件是**页内脚本的原文**：由 smoke/room-page.mjs 原样拼进页内 IIFE（在运行器之前，与各主题块
// 共用同一条作用域），**不要**把它塞回模板字符串（转义坑见 docs/testing.md §9.3）。

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {};
  var snap = function () { document.documentElement.setAttribute("data-smoke", JSON.stringify(out)); };
  var byTestId = function (id) { return document.querySelector('[data-testid="' + id + '"]'); };
  var allByTestId = function (id) { return [].slice.call(document.querySelectorAll('[data-testid="' + id + '"]')); };
  var rows = function () { return allByTestId("db-msg-row"); };
  var rect = function (el) { return el ? el.getBoundingClientRect() : null; };
  var text = function () { return document.body.innerText; };
  var rowWith = function (needle) {
    return rows().filter(function (r) { return r.innerText.indexOf(needle) >= 0; })[0];
  };
  var buttonWith = function (root, label) {
    return [].slice.call((root || document).querySelectorAll("button")).filter(function (b) {
      return b.innerText.trim().indexOf(label) >= 0;
    })[0];
  };
  var clickLabelIn = function (root, label) {
    var l = [].slice.call((root || document).querySelectorAll("label")).filter(function (x) {
      return x.innerText.indexOf(label) >= 0;
    })[0];
    if (!l) return false;
    var input = l.querySelector("input");
    if (!input) return false;
    input.click();
    return true;
  };
  // 只认工具行里的按钮：面板里也有带「表情」二字的按钮（「我的表情」tab 在文档序上更靠前），
  // 按 document.querySelectorAll 取首个会点错。
  var clickTool = function (label) {
    var b = buttonWith(byTestId("db-composer-tools"), label);
    if (!b) return false;
    b.click();
    return true;
  };
  // React 在元素上包了取值追踪器：直接改 .value 再派发 input 事件不会触发 onChange，
  // 必须走原生 setter（否则「新增账号」这类受控输入在冒烟里永远点不动）。
  var typeInto = function (input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // textarea 用的是另一个原型上的 setter：直接改 .value 不会触发 React 的 onChange
  var typeIntoArea = function (area, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  };
  var lastSendCall = function () {
    var all = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
    return all[all.length - 1];
  };
  var openRowMenu = function (row) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
  };
  // 「别人的最新一条」：**乐观渲染之后最后一行不再保证是别人**——自己刚发的那条就排在末尾
  // （uid == 我，房管项与 @/回复按设计置灰）。凡是要拿「最新的一条弹幕」当目标的地方都走这里：
  // 显式推一条上游来的行（uid ≠ 我、有昵称、有 upstream_id），目标因此是确定的。
  var emitOtherRow = async function (label) {
    window.__emit("danmubox://message", window.__mk("danmaku", label, false, {
      uid: 77001, uname: "隔壁观众"
    }));
    await sleep(300);
    return rowWith(label);
  };
  // 离底部还有多远（0 = 贴底）。「跟随最新」是否还活着，看这个数就知道。
  var bottomGap = function (el) {
    return Math.round((el.scrollHeight - el.scrollTop - el.clientHeight) * 10) / 10;
  };
  /**
   * 显示块里的两枚礼物开关（issue 2609152029 第 1 条：原来那个「礼物栏」下拉已删）：
   * 按 label 文案点复选框本体 —— 与用户点它走的是同一条路（React 的 onChange）。
   * 每次都重新取面板节点：面板关掉再开时旧节点会变成游离节点（踩过，见上面发弹幕那段的说明）。
   * 值已经对了就不点（幂等），返回「找没找到这枚开关」。
   */
  var setGiftSwitch = function (label, value) {
    var panel = byTestId("db-panel");
    if (!panel) return false;
    var picked = [].slice.call(panel.querySelectorAll("label")).filter(function (l) {
      return l.innerText.trim() === label;
    })[0];
    if (!picked) return false;
    var input = picked.querySelector('input[type="checkbox"]');
    if (!input) return false;
    if (input.checked !== value) input.click();
    return true;
  };
  // 键事件：焦点先落到目标上，再派发 keydown / keyup —— 与「Tab 到它、再按键」同一条路径
  // （React 的 onKeyDown 收到的就是这一个事件）。**场景跑在一次 evaluate 里**，运行器没有把
  // 真实键盘事件送进来的通道（它只发 click 与取快照），所以这是页面内能给出的最接近的一次；
  // 原生 <button> 的 Enter / Space 是浏览器默认动作换出来的 click，派发键事件换不出来 ——
  // 凡是判「原生按钮的键盘激活」，判据因此落在「它确实是一枚原生按钮 + 可聚焦 + 未禁用」上。
  var pressKey = function (el, key) {
    if (!el) return false;
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true, cancelable: true }));
    return true;
  };
  // 账号对话框（item 2 删掉了里面的「关闭」按钮）只剩两条关闭路径：**Esc** 与**点背景**。
  // Esc 派发到 window —— 组件挂的就是 window.addEventListener("keydown")（与真实按键同一条
  // 监听链）；点背景派发在对话框卡片外的那层遮罩上（组件的判据是 target === currentTarget，
  // 直接派发到遮罩自身正好命中）。
  var pressEscape = function () {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  };
  var clickDialogBackdrop = function (dialogEl) {
    if (!dialogEl || !dialogEl.parentElement) return false;
    dialogEl.parentElement.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    return true;
  };
  // 图标几何取证（房间头两枚 / 「回到最新」/ 主题按钮三档共用）：getBBox() 给的是**几何**
  // 包围盒（不含描边），四周各外扩半个墨迹厚度才是墨迹外接盒。定义在场景开头是因为
  // **step1 的主题按钮**就要用它（后面的房间头那一段只负责调用与断言）。
  var iconGeomOf = function (btn) {
    var svg = btn ? btn.querySelector("svg") : null;
    var shapes = svg ? [].slice.call(svg.querySelectorAll("path, circle")) : [];
    if (!svg || shapes.length === 0) return null;
    var vb = (svg.getAttribute("viewBox") || "").split(" ").map(parseFloat);
    var box = rect(svg);
    if (!box || !(vb[2] > 0)) return null;
    var scale = box.width / vb[2];
    // 墨迹厚度：描边 = stroke-width，**实心**圆点 = 直径（一个圆点就是一个零长度描边段的圆头）。
    // ⚠ 两者对**外接盒**的贡献不同：描边的几何包围盒是**路径中心线**，四周各要外扩半个笔画；
    //    实心圆的包围盒**本身就是墨迹**，一点都不用外扩（第一版两边都外扩，于是 ⋯ 的墨迹范围
    //    被算成 19.5 × 7，与箭头那 16 对不上 —— 冒烟当场把这条抓住了）。
    // ⚠ circle 这个标签名**本身不说明**它是实心还是描边：⋯ 那三枚圆点是 fill 实心
    //    （厚度 = 直径 3.5 = 2 × 描边规范里的 1.75），而主题按钮的「亮」（太阳的圆心）与
    //    「自动」（半亮的圆环）都是 fill="none" + stroke-width: 1.75 的**描边环** ——
    //    它们的厚度就是 1.75、包围盒要外扩半个笔画。旧写法对任何 <circle> 一律按「实心圆点」
    //    算，于是太阳的圆心被算成厚度 6、自动档的圆环被算成 14.25，两档都撞不过下面这条
    //    「墨迹粗度 = 1.75」的规范（实测：浅色那一档 themeIconSpecOk=false）。
    //    判据因此落在**画法**上：fill 缺席或为 none = 描边环，否则 = 实心圆点。
    var isFilled = function (s) {
      var fill = s.getAttribute("fill");
      return fill !== null && fill !== "none";
    };
    var strokeWidthOf = function (s) {
      var w = s.getAttribute("stroke-width");
      return w === null ? 0 : parseFloat(w);
    };
    var thicknessOf = function (s) {
      if (s.tagName.toLowerCase() === "circle") {
        return isFilled(s) ? parseFloat(s.getAttribute("r")) * 2 : strokeWidthOf(s);
      }
      return strokeWidthOf(s);
    };
    var padOf = function (s) {
      return s.tagName.toLowerCase() === "circle" && isFilled(s) ? 0 : thicknessOf(s) / 2;
    };
    var lo = { x: Infinity, y: Infinity };
    var hi = { x: -Infinity, y: -Infinity };
    var thickness = 0;
    shapes.forEach(function (s) {
      var b = s.getBBox();
      var t = thicknessOf(s);
      var pad = padOf(s);
      thickness = Math.max(thickness, t);
      lo.x = Math.min(lo.x, b.x - pad);
      lo.y = Math.min(lo.y, b.y - pad);
      hi.x = Math.max(hi.x, b.x + b.width + pad);
      hi.y = Math.max(hi.y, b.y + b.height + pad);
    });
    var round1 = function (v) { return Math.round(v * 100) / 100; };
    return {
      viewBox: svg.getAttribute("viewBox"),
      scale: Math.round(scale * 1000) / 1000,
      boxPx: round1(box.width),
      inkThicknessPx: round1(thickness * scale),
      inkW: round1(hi.x - lo.x),
      inkH: round1(hi.y - lo.y),
      inkCenterX: round1((lo.x + hi.x) / 2),
      inkCenterY: round1((lo.y + hi.y) / 2),
      linecap: shapes[0].getAttribute("stroke-linecap"),
      linejoin: shapes[0].getAttribute("stroke-linejoin"),
      shapeCount: shapes.length,
    };
  };
  // WCAG 相对亮度：把「正文 / 次级文字对背景 ≥ 4.5:1」这条纪律写成可判定的数字，
  // 不靠人眼判（两套主题各判一次，浅色尤其容易在绿 / 灰上翻车）。
  var luminance = function (css) {
    var open = css.indexOf("(");
    var close = css.indexOf(")");
    if (open < 0 || close < 0) return null;
    var parts = css.slice(open + 1, close).split(",");
    if (parts.length < 3) return null;
    var lin = parts.slice(0, 3).map(function (v) {
      var c = parseFloat(v) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  var contrastRatio = function (fg, bg) {
    var a = luminance(fg);
    var b = luminance(bg);
    if (a === null || b === null) return 0;
    var hi = Math.max(a, b);
    var lo = Math.min(a, b);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

