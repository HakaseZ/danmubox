// 场景块：输入区快捷与上限：点一下发、右键菜单、@ 来源、字数上限、IME、超时
//   emotes 点选某个表情直接发送（点一下就发、草稿不动、面板不关）
//   menu 右键菜单（复制 / ＠TA / 回复 / 屏蔽 / 主页 / 举报）并能关掉
//   mention ＠ 目标与文本同源；limit 弹幕字数上限来自 room_session.danmaku_length；ime 组字中的回车不许发
//   超时兜底（上游一直不回推时不永远停在「发送中」）；time 时间戳默认不渲染（开关打开后另量）
//
// 页内脚本片段：由 smoke/room-page.mjs **原样拼进** `window.__smoke_run` 的函数体，与相邻块共用同一条
// 作用域（out / snap / byTestId / sleep / … 都是 10-harness.mjs 里的工具）。准入条件见 docs/testing.md §9.3。
    // ---- 「点选某个表情直接发送出去就行」（用户 2026-09-12）：**点一下就发**，没有第二步。
    // 判据：点完立刻有一次 chat_send（带的就是点中那一个的唯一键），草稿一个字符都不动，
    // 面板也不关（连发几个不必反复开面板）。
    if (ownedPicker) {
      ownedPicker.click();
      await sleep(400);
    }
    var chatSends = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
    var lastChatSend = chatSends[chatSends.length - 1];
    // 表情弹幕上游收到的 msg 就是 emoticon_unique（crates/danmubox-bili/src/send.rs），
    // 因此这两条断言等于「上游会收到 upower_<表情名>」。
    out.ownedEmoteSendUnique = !!lastChatSend && !!lastChatSend.args.emote &&
      lastChatSend.args.emote.emoticon_unique === ownedSample.emoticon_unique;
    out.ownedEmoteSendContent = !!lastChatSend && lastChatSend.args.content === ownedSample.text;
    out.ownedEmoteSentOnClick = out.ownedEmoteSendUnique && out.ownedEmoteSendContent;
    out.ownedEmoteNoSecondStep = document.querySelector("textarea").value === "" &&
      !!byTestId("db-panel");
    // 面板点选**不关**（上面那条断言），但后面几步要用满屏的列表，这里把它收起来。
    clickTool("表情");
    await sleep(250);
    // 发送成功不再占一行说「上次发送：已发出」（用户 #4：没意义且不协调）——弹幕已经出现在列表里
    out.sendHintAbsentOnSuccess = !byTestId("db-send-hint") &&
      text().indexOf("上次发送") < 0;
    snap();

    // ---- menu 右键菜单（目标行显式造：见 emitOtherRow 的注释）
    var target = await emitOtherRow("菜单目标样本");
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }));
    await sleep(250);
    var menu = byTestId("db-context-menu");
    out.menuShown = !!menu;
    out.menuItems = menu ? [].slice.call(menu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.menuClosed = !byTestId("db-context-menu");
    snap();

    // ---- mention ＠ 与文本同源（issue #13a）：文本里没有 @名字 就不许带目标
    var mentionRow = rowWith("无头像的弹幕");
    openRowMenu(mentionRow);
    await sleep(250);
    buttonWith(byTestId("db-context-menu"), "＠TA").click();
    await sleep(300);
    out.mentionInsertedIntoCaret = document.querySelector("textarea").value.indexOf("@无头像 ") >= 0;
    out.mentionHintShown = !!byTestId("db-mention-hint");
    buttonWith(null, "发送").click();
    await sleep(400);
    var sendWithMention = lastSendCall();
    out.mentionSendCarriesTarget = !!sendWithMention && !!sendWithMention.args.reply &&
      sendWithMention.args.reply.uname === "无头像" && sendWithMention.args.reply.mid > 0;
    // 再 @ 一次，然后把文本里的 @名字 换掉再发：目标必须跟着消失
    openRowMenu(mentionRow);
    await sleep(250);
    buttonWith(byTestId("db-context-menu"), "＠TA").click();
    await sleep(300);
    typeIntoArea(document.querySelector("textarea"), "你好呀");
    await sleep(200);
    out.mentionHintGoneAfterEdit = !byTestId("db-mention-hint");
    buttonWith(null, "发送").click();
    await sleep(400);
    var sendWithoutMention = lastSendCall();
    out.mentionTargetDroppedWithText = !!sendWithoutMention &&
      sendWithoutMention.args.content === "你好呀" && !sendWithoutMention.args.reply;

    // 回复是显式的引用条（可见、可取消），不靠文本，因此照旧带目标
    openRowMenu(mentionRow);
    await sleep(250);
    buttonWith(byTestId("db-context-menu"), "回复").click();
    await sleep(300);
    out.replyBarShown = !!byTestId("db-reply-bar");
    typeIntoArea(document.querySelector("textarea"), "收到");
    await sleep(150);
    buttonWith(null, "发送").click();
    await sleep(400);
    var sendWithReply = lastSendCall();
    out.replySendCarriesTarget = !!sendWithReply && !!sendWithReply.args.reply &&
      sendWithReply.args.reply.dmid.length > 0 && sendWithReply.args.content === "收到";
    snap();

    // 整块包一层（同粉丝牌与 tabs 那两段的手法）：互动步骤在一次真实运行里出岔子时
    // 要**让断言红**（limitBlockRan），而不是把整个场景卡到 300s（那样只剩「未跑完」
    // 一句、定位不到原因）。
    var limitBlockRan = false;
    try {
      // ---- limit 弹幕字数上限（item 12）：上限来自 room_session 的 danmaku_length（契约 §5，
      //      上游 getInfoByUser 的 data.property.danmu.length），缺了才按官方缺省 20 回落 ——
      //      mock 给的是 40，因此这里量到的必须是 40（回落到 20 就说明字段没透传）。
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(150);
      var limitCount = byTestId("db-input-count");
      out.inputCountShown = !!limitCount && limitCount.innerText.trim() === "0/40";
      // 41 个字的正文：超限即**截断**到上限（不是等发出去才发现），并按官方文案弹提示
      var overLimit = new Array(42).join("超");
      typeIntoArea(document.querySelector("textarea"), overLimit);
      await sleep(250);
      out.inputTruncatedToLimit = document.querySelector("textarea").value.length === 40 &&
        document.querySelector("textarea").value === overLimit.slice(0, 40);
      out.inputCountAtLimit =
        (byTestId("db-input-count") || { innerText: "" }).innerText.trim() === "40/40";
      out.inputLimitToastShown = (byTestId("db-toast") || { innerText: "" })
        .innerText.indexOf("最多输入 40 个字哦~") >= 0;
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(200);
      // @昵称 前缀**不计入**上限（官方 inputLengthLimit = 上限 + at 前缀长度，docs/ui.md §6.1）：
      // 先从行菜单拿一个确定的目标（「隔壁观众」4 个字，前缀 @隔壁观众 + 空格共 6 个码元），
      // 再补 44 个字共 50；若前缀计入会被截到 40，实测必须是 46。
      var limitTarget = await emitOtherRow("上限目标样本");
      openRowMenu(limitTarget);
      await sleep(250);
      buttonWith(byTestId("db-context-menu"), "＠TA").click();
      await sleep(300);
      out.inputAtPrefixInserted = document.querySelector("textarea").value === "@隔壁观众 ";
      var withPrefix = document.querySelector("textarea").value + new Array(45).join("a");
      typeIntoArea(document.querySelector("textarea"), withPrefix);
      await sleep(250);
      var afterLimit = document.querySelector("textarea").value;
      out.inputAtPrefixExcludedFromLimit = withPrefix.length === 50 && afterLimit.length === 46 &&
        afterLimit === withPrefix.slice(0, 46);
      out.inputCountWithAtPrefix =
        (byTestId("db-input-count") || { innerText: "" }).innerText.trim() === "46/46";
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(200);
      snap();
      // 上限提示那张浮片自己渐隐掉再往下走：后面的截图不该带着它
      await sleep(2800);
      limitBlockRan = true;
    } catch (e) {
      out.limitBlockError = String((e && e.stack) || e);
    }
    out.limitBlockRan = limitBlockRan;

    // ---- ime 中文输入法组字时的回车（issue #2 第 3 条：macOS 实测「回车选词」会把弹幕直接发出去）。
    //      场景里只能派发**合成事件**（同 pressKey 那段的说明：运行器没有把真实键盘 / IME 序列
    //      送进来的通道），因此这里把「判据依赖的四种时序」逐条摆出来，判据只落在两件对外可观察
    //      的事上：chat_send 有没有被调用、草稿还在不在。前三种都不许发，第四种**必须发**：
    //        ① 组字中：compositionstart 之后、compositionend 之前的回车（真实 IME 选词就是这一次）；
    //        ② 只有 isComposing 自报组字（Chromium 提交候选那次 keydown 的形态：不带
    //           compositionstart 也自报）—— 与 ① 分开，免得「只看组字态」的实现蒙过去；
    //        ③ WebKit 时序：compositionend **先**到，同一次按键的 keydown 随后到、带着
    //           isComposing=false / keyCode=13 —— 这是 macOS 宿主引擎（WKWebView）上的真凶，
    //           只看 ①② 会在这里变红；
    //        ④ 隔了一轮任务之后用户自己按的回车 —— 守卫要是连它也吃，等于「修完发不出弹幕」。
    //      ④ 与 ③ 靠得近是有意的：它证明守卫的窗口止于**一轮任务**，不是「一直等到下次按键」。
    var imeBlockRan = false;
    try {
      var imeArea = document.querySelector("textarea");
      var imeTexts = ["组字中样本", "自报组字样本", "提交候选样本", "组字后的回车样本"];
      var imeSendCount = function () {
        return window.__callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; }).length;
      };
      // 每条时序都重新铺一遍草稿：前一条发没发过都不影响后一条（互不依赖）
      var imeSeed = async function (text) {
        typeIntoArea(imeArea, "");
        await sleep(150);
        typeIntoArea(imeArea, text);
        await sleep(150);
        return imeSendCount();
      };
      var imeKeydown = function (isComposing, keyCode) {
        imeArea.focus();
        imeArea.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: keyCode, isComposing: isComposing,
          bubbles: true, cancelable: true
        }));
      };
      var imeCompose = function (type) {
        imeArea.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
      };

      // ① 组字中的回车
      var imeBeforeComposing = await imeSeed(imeTexts[0]);
      imeCompose("compositionstart");
      imeKeydown(true, 229);
      await sleep(400);
      out.imeComposingEnterDoesNotSend = imeSendCount() === imeBeforeComposing;
      out.imeComposingEnterKeepsDraft = imeArea.value === imeTexts[0];
      imeCompose("compositionend");
      await sleep(300);

      // ② 没有 compositionstart，只有 isComposing 自报的那次回车
      var imeBeforeFlag = await imeSeed(imeTexts[1]);
      imeKeydown(true, 229);
      await sleep(400);
      out.imeIsComposingFlagDoesNotSend = imeSendCount() === imeBeforeFlag &&
        imeArea.value === imeTexts[1];

      // ③ compositionend 先到、keydown 后到（WebKit 时序）：两者**同一轮任务**里背靠背派发
      var imeBeforeCommit = await imeSeed(imeTexts[2]);
      imeCompose("compositionstart");
      imeCompose("compositionend");
      imeKeydown(false, 13);
      await sleep(400);
      out.imeCommitTailEnterDoesNotSend = imeSendCount() === imeBeforeCommit &&
        imeArea.value === imeTexts[2];

      // ④ 隔一轮任务之后的普通回车：必须发出去（并且清空草稿）
      var imeBeforePlain = await imeSeed(imeTexts[3]);
      await sleep(300);
      imeKeydown(false, 13);
      await sleep(500);
      out.imeNextTaskEnterSends = imeSendCount() === imeBeforePlain + 1 && imeArea.value === "";
      typeIntoArea(imeArea, "");
      await sleep(200);
      snap();
      imeBlockRan = true;
    } catch (e) {
      out.imeBlockError = String((e && e.stack) || e);
    }
    out.imeBlockRan = imeBlockRan;

    // ---- 超时兜底（用户 2026-09-13：不要永远停在「发送中」）：这条**故意不回推**，
    //      看它在 SEND_CONFIRM_TIMEOUT_MS（8s）到点后是否被标成失败族的「未确认」。
    //      点击后那一瞬间它**不带任何标记**（与已确认行同款）——「发送中」那档已按用户
    //      当天的更正删掉，因此这里钉的是「没有待确认视觉」，8s 后才出现修正标记。
    //      发送放在这里（而不是紧挨着 step5 那段 8.6s 等待）有个必须的理由：**成功的发送会把
    //      编辑面板收起**（Composer 的成功路径 setPanel(null)），而紧接着的 step5 / step6 /
    //      礼物栏三块都要在**同一个筛选面板节点**上操作 —— 面板一关一开，旧节点就成了游离节点，
    //      后续 clickLabelIn(filterPanel, …) 会静默失效（改前实测：step6 的开关点了不生效、
    //      礼物栏根本不出现）。这里发送时面板还没开，因此不碰它。
    var timeoutText = "超时兜底样本弹幕";
    typeIntoArea(document.querySelector("textarea"), timeoutText);
    await sleep(150);
    sendButton.click();
    await sleep(150);
    var timeoutRow = rowWith(timeoutText);
    out.sendTimeoutStartsUnmarked = !!timeoutRow &&
      !timeoutRow.querySelector('[data-testid="db-msg-send-state"]');

    // ---- time 时间戳（默认关 → 打开后等宽对齐）
    out.timeCellsDefault = allByTestId("db-msg-time").length;
    clickTool("筛选");
    await sleep(300);
    var filterPanel = byTestId("db-panel");
    out.filterPanelShown = !!filterPanel;
