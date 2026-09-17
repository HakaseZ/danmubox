// 房间页 UI 冒烟：mock IPC + 真实 dist 产物，同一份场景与断言跑在**两个引擎**上
// （Chromium 与 WebKit；后者就是 macOS 上 Tauri 用的 WKWebView —— 见 run-headless.mjs）。
// 宿主引擎必须在验证链里，否则「全绿」只对 Chromium 成立（2026-09-12 的教训）。
//
// 复现（一条命令，自己起浏览器，不依赖 relay 标签页）：
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs                 # Chromium
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs --engine webkit # 宿主引擎
// 只要快照（不跑浏览器）：
//   node smoke/room-page.mjs            # 生成 /tmp/danmubox-ui-smoke.html
//
// 场景自己跑完（含两段 8.6s 等待）后把断言快照写进 document.documentElement 的 data-smoke
// 属性（JSON）并 console.log 一份。
//
// 三条维护约定：
//   1) 断言只依赖对外可观察的行为（DOM 文本 / 几何 / 副作用记录），**不依赖 CSS-module 类名**；
//      定位一律走 `data-testid`（db-chat-scroll / db-msg-row / db-msg-time / db-context-menu /
//      db-account / db-panel / db-gift-dock / db-follow-item），那是稳定的对外契约。
//   2) 快照字段名是契约：`step1_*` … `step6_*` 的语义不得改（Main 按这套闭环），
//      新增断言另起字段名（layout* / menu* / time* / gift* / follow* / account*）。
//   3) **断「某个元素在不在」必须定位到那个元素自身**，不要拿整行 / 整块的 innerText 找关键词：
//      行的正文里恰好出现同样两个字就会让断言说谎（#12 那次的样本正文含「舰长」两字，
//      于是「不该有舰长标」的断言假失败——它反过来也会让真 bug 混过去）。
//      例：判徽标看 `span.innerText.trim() === "舰长"`，而不是 `row.innerText.indexOf("舰长")`。
//   4) 场景代码整段是一个模板字符串（MOCK）：里面的注释**不要写反引号**，否则字符串提前结束、语法直接崩。
//
// 覆盖：docs/ui.md §2、§3、§4、§6、§8。
//   step1  关注列表自动加载、列表页展示关注项
//   step2  进房间、历史回填可见
//   step3  头部在线/看过且无人气；系统/互动行的渲染与弱化；历史与实时同款
//   step4  系统类消息的白名单（勾「消息类型 → 系统」那一项，不是已删的「系统通知」开关）
//   step5  互动行 8 秒后自动消失
//   step6  关掉自动消失后互动行常驻
//   filter 筛选面板的两块表单是**两列勾选清单**（issue 2609160959 第 3 / 4 条）：消息类型 6 项
//          与辅助功能 6 枚开关都是按行铺满的两列（列/行几何 + 不许横向滚动 + 不再是芯片样），
//          六枚辅助开关逐枚点开再点回（偏好与复选框同步翻）；辅助功能 = 字号滑杆（整行）+ 六枚开关；
//          两块标题（消息类型 / 辅助功能）的视觉层级比清单项醒目（issue 2609162056 第 5 条：
//          字号 / 字重 / 字色 / 分隔线，文案与结构一字不动）
//   layout 弹幕列表是唯一生长区；面板向上展开时列表上弹且最新一条不被遮挡；表情尺寸分级；
//          内容不足视口时整体贴底；头像列永远占位（昵称三列纵向对齐）；粉丝牌真彩色与兜底色；
//          回复关系可见；舰长标只认本房间的 guard_level；「回到最新」是**圆形图标钮**（下箭头，
//          与返回键同源矢量几何、同尺寸，无可见文字、可访问名走 aria-label）
//   emotes 主站「我的表情」分组可见、能选中、发出去带的是唯一键
//   menu   右键出菜单（复制 / ＠TA / 回复 / 屏蔽 / 主页 / 举报）并能关掉
//   mention＠ 目标与文本同源：文本里的 @名字 被删掉后发送就不带目标；回复的引用条照旧带目标
//   time   时间戳默认不渲染；开关打开后它是**身份行的最后一格**（无身份行的行走「只有时间」首行），
//          右边缘与正文块的右边缘齐平、逐行等宽（纵向对齐），且不挤正文宽度
//   limit  弹幕字数上限：上限来自 room_session.danmaku_length（40）；超限即截断并提示；
//          工具行常显 已用/上限；@昵称 前缀不计入有效上限
//   ime    组字中的回车是**输入法**的、不是「发送」：组字中（compositionstart 之后）、只有
//          isComposing 自报、以及 compositionend 之后紧跟的那次 keydown（WebKit 时序）三种
//          都不许发；隔一轮任务之后用户自己按的回车必须发（守卫不许滥杀）
//   theme  主题**按钮**在**房间列表页页头**（点一下前进一档：亮 → 暗 → 自动，三下一轮回到原档；
//          图标随档变且三档同一套矢量规范、切档真的落到 <html data-theme>、深浅对比度达标）
//   gift   礼物类消息的去向与独立礼物栏（issue 2609152029 第 4/5 条）：`ui.gift_in_danmaku`
//          管弹幕流、`ui.gift_panel` 管独立礼物栏，**四种组合逐个翻一遍**（默认两枚都开）；
//          礼物栏**每个礼物 / SC / 大航海一条**（头像 + 昵称 + 内容 + 数量 + 金额），连击折叠后
//          金额是整串的总额；折叠态汇总**按 kind 分组**、三组各报各的合计（单位统一是元）；
//          礼物 / SC / 大航海的**头像只在该有源时画**（V1 礼物与大航海无源 → 不画假图）；
//          SC 卡片按档位令牌上色、金额行低一档加粗且独占一行。
//          样本来自 `fixtures/gift-sc-guard-rows.json`（**按协议文档字段表构造**，出处见
//          docs/testing.md §9.1）—— 本仓此前没有任何礼物类样本，这几条行为原本零断言。
//   splitter 共享分区（issue #8）：弹幕区与礼物栏上下分区、中间一条热区 ≥ 8px 的分割条。
//          拖分割条**实时**改比例（拖动中一帧都不写 store、松手才落盘）、拖到极限时两栏各自
//          的最小高度成立（弹幕区 ≥ 3 行、礼物栏 ≥ 折叠头）且总量不溢出、比例在重新挂载后保持；
//          长按任一栏 0.5s 进入换位态（半透明跟随指针）→ 拖过另一栏松手即上下互换且落盘，
//          短按 / 按住前就移动（在滚列表）/ ESC 三条路都不换位；换位不改比例（只挪位置）；
//          ui.gift_panel 关掉后分区退化为弹幕区全高、分割条与礼物栏一起消失、换位停用。
//          两条手势各走一条指针链（拖分割条用 mouse、长按换位用 touch）。
//   cheapgift 低价礼物两枚开关（issue 2609162056 第 3 / 4 条）：`ui.gift_collapse_cheap` 只改
//          礼物栏的分组形状（≤0.1 元的礼物合并成一条）、`ui.gift_exclude_cheap_stats` 只改
//          折叠头的统计口径（礼物 / SC（N）与三组明细），两枚**默认都关**、互相独立；
//          边界按「0.09 / 0.10 算低价、0.11 不算、0 元（上游没给价）不算」逐条量；SC 与大航海
//          在两枚开关的四种组合下逐字不变。夹具放在**空会话的新房间**里量（见那一段的说明）。
//   admin  房管权限前置（**有房管身份才有入口**；不是房管时菜单里没有这一项）、写操作二次确认与
//          请求形状、身份就绪即预载三块名单、面板三块收成三个 tab（roving tabindex + ←→/Home/End，
//          tab 文案只有名单名、不带计数）、单点动作走行右键菜单、批量一次确认按序执行、
//          上游 code + message 原样展示、身份被撤销后面板自动收起；面板里没有「刷新」按钮
//          （重拉 = 关掉再开）；头部一行（tab 轨道 + 右侧一枚 X 关闭图标钮）、
//          第 1 排 = 输入框 + 主操作 + 批量图标钮，批量模式下第 2 排紧贴它下方（全选 / 已选 N 项 / 动作）
//   panels 五面板互斥：房管面板 / 表情 / 短语 / 筛选 / 独立礼物栏同时最多开一个
//   tabs   多标签隔离：切房间把面板 / 菜单 / 滚动跟随重置，草稿按「身份 × 房间」各留一份
//          标签条本身：拖动排序（真实指针事件：越过 5px 阈值才进入拖拽态、拖完不切房间、
//          阈值以下仍是点击）、横滑是滚动而**按住**才是拖、开 20 个房间后横向滚动且每枚
//          标签不被压缩到最小宽度以下、拖动中被拖的房间被关掉则整次作废；
//          **标签条不画滚动条但仍能横滚**（用户 2026-09-16 第 1 条）：溢出时「标签底边 →
//          容器内底边」那一段为 0（滚动条一旦被画出来就会占掉一条，覆盖式下则是飘在标签上）、
//          引擎算出来的 `scrollbar-width` 是 `none`、且把 `scrollLeft` 归零再滚仍然能变
//   follow 未开播也列出（**真实取样夹具**：未开播项第 1 页可见且翻页到底一条不少）、按最后开播时间排序、>30 条分页
//   account 账号区只留一行身份、**整行即入口**（独立的「账号」按钮已删；游客态同样可点，
//          键盘 Enter / Space 等价）；对话框里一行一个账号（昵称 + uid + 状态 + 操作），
//          **非当前账号整行可点即切换**
//          （role=button / tabIndex=0 / 键盘 Enter·Space 等价、行内动作按钮不冒泡、当前行不可点）；
//          对话框排版：二维码卡片与上方一级块同宽、间距 = 对话框统一行间距、「＋ 添加账号」居中；
//          切换后按新身份重拉 rooms_list / follow_list 并回到房间列表页（切号隔离）；
//          单账号也能看到「＋ 添加账号」；
//          添加 = account_qr_start（不带 target，永不覆盖）+ 2 秒轮询到 confirmed 后多一行且标为当前；
//          「重新登录」要二次确认且文案写明会覆盖谁；删除当前账号后自动切走、只剩一个时禁止删除；
//          退出登录后退回游客态；对话框里**没有关闭按钮**（关闭 = Esc 或点背景，两条路径各验一次）

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/* 房间信息夹具（真实载荷，只读抓取 2026-09-12）：**mock 与断言都从这里派生，不许手写**。
   手写的「测试主播 · 测试房间」正是 #17/#18 的病因：解析把 `anchor_info` 挂在
   `getRoomPlayInfo` 上（真实响应里根本没有这个键），手写夹具照样绿，界面却显示占位词。
   两份夹具各是一次真实响应（公开测试房间 1 = room_id 5440）：
     fixtures/room-play-info.json  GET /xlive/web-room/v1/index/getRoomPlayInfo?room_id=5440
     fixtures/room-h5-info.json    GET /xlive/web-room/v1/index/getH5InfoByRoom?room_id=5440
   房间名（主播名 · 标题）只存在于后者：`data.anchor_info.base_info.uname` / `data.room_info.title`。 */
const roomPlayFixture = JSON.parse(
  readFileSync(new URL("./fixtures/room-play-info.json", import.meta.url), "utf8"),
);
const roomH5Fixture = JSON.parse(
  readFileSync(new URL("./fixtures/room-h5-info.json", import.meta.url), "utf8"),
);
/** 真实载荷派生的房间（`RoomView` 形状）：`connected` / `buffered` 是冒烟的会话态。 */
const FIXTURE_ROOM = {
  room_id: roomPlayFixture.data.room_id,
  short_id: roomPlayFixture.data.short_id,
  anchor_uid: roomPlayFixture.data.uid,
  anchor_uname: roomH5Fixture.data.anchor_info.base_info.uname,
  title: roomH5Fixture.data.room_info.title,
  live_status: roomPlayFixture.data.live_status,
  connected: true,
  buffered: 1,
};


/** 真实表情载荷（只读 GET 固化的上游响应），见该文件自己的 `_note`。 */
const EMOTE_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/emotes.json", import.meta.url), "utf8"),
);

/**
 * 礼物 / SC / 大航海的夹具（**按协议文档字段表构造**，不是真实抓包派生；
 * 依据与脱敏口径见该文件自己的 `_note` 与 docs/testing.md §9.1）。
 * 构造而非实测的原因：`AGENT.md` §8 第 16 条禁止为测试发送礼物 / 醒目留言 / 大航海，
 * 这类事件在本项目里拿不到授权样本；而留给它的三类新行为（礼物栏一条一行、金额带单位、
 * SC 卡片）不能零断言。
 */
const GIFT_FIXTURE = JSON.parse(
  readFileSync(
    new URL("./fixtures/gift-sc-guard-rows.json", import.meta.url),
    "utf8",
  ),
);

/** 表情替身的底色（`#` 必须写成 `%23`，否则 `#` 会被当成 data URI 的片段起始、图直接坏掉）。 */
const EMOTE_FILL = ["%23f09300", "%2300aeec", "%23e67e22", "%238e44ad", "%232980b9", "%234ade80"];

/**
 * 真实图的内联替身：**固有尺寸与真实图逐张一致**（`width`/`height` 就是上游给的那两个数），
 * 只把像素内容换成纯色块。
 *
 * 这一条是整份冒烟的关键：真实图在 `i0.hdslb.com`（离线跑不到），但**尺寸特征必须一样** ——
 * 手写的 64×64 正方形表情永远撞不出「图比格子宽」，而真站的通用表情是 200×60 的横条
 * （只给 `height` 的话宽度会按 3.33:1 算出 5em，撑出 3em 的格子）。
 */
function emoteImage(width, height, seed) {
  const fill = EMOTE_FILL[seed % EMOTE_FILL.length];
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='" +
    width +
    "' height='" +
    height +
    "' viewBox='0 0 " +
    width +
    " " +
    height +
    "'><rect width='" +
    width +
    "' height='" +
    height +
    "' fill='" +
    fill +
    "'/></svg>"
  );
}

/**
 * 包分类：逐条照搬 `crates/danmubox-bili/src/emote.rs` 的 `classify_package`
 * （包名关键字 → 表情级解锁字段 → `pkg_type`）。
 */
function classifyFixturePackage(pkg) {
  const name = pkg.pkg_name ?? "";
  const items = pkg.emoticons ?? [];
  if (/舰|航海|提督|总督/.test(name)) return "guard";
  if (/粉丝|勋章/.test(name)) return "medal";
  const gated = items.some((item) => {
    const level = item.unlock_need_level ?? 0;
    const identity = item.identity ?? 99;
    return level > 0 || (identity >= 1 && identity <= 4);
  });
  if (gated) return "medal";
  return pkg.pkg_type === 2 ? "room" : "common";
}

/** 一个真实包的 `emoticons[]` → `Emote[]`（照搬 `map_packages` 的字段口径）。 */
function mapFixturePackage(roomId, pkg, seedBase) {
  const kind = classifyFixturePackage(pkg);
  return (pkg.emoticons ?? []).map((item, index) => {
    const seed = seedBase + index;
    return {
      key: `${pkg.pkg_id ?? 0}:${item.emoticon_unique ?? index}`,
      emoticon_unique: item.emoticon_unique ?? "",
      width: item.width ?? 0,
      height: item.height ?? 0,
      is_dynamic: item.is_dynamic !== 0,
      in_player_area: item.in_player_area !== 0,
      bulge_display: item.bulge_display !== 0,
      package_kind: kind,
      text: item.emoji ?? item.descript ?? "",
      url: emoteImage(item.width ?? 0, item.height ?? 0, seed),
      room_id: kind === "room" ? roomId : 0,
      locked: item.perm === 0,
    };
  });
}

/** 一份真实响应 → `Emote[]`（展平全部包）。 */
function mapFixtureResponse(roomId, response, seedBase) {
  const out = [];
  for (const pkg of response.data.data) {
    out.push(...mapFixturePackage(roomId, pkg, seedBase + out.length));
  }
  return out;
}

/** 主站「我的表情」→ `Emote[]`（照搬 `map_owned_packages`：唯一键 `upower_` + 文本）。 */
function mapFixtureOwned(response, seedBase) {
  const out = [];
  for (const pkg of response.data.packages) {
    for (const item of pkg.emote ?? []) {
      if (!item.text || !item.url) continue;
      const seed = seedBase + out.length;
      // 主站表情不给宽高（实测：`width`/`height` 字段不存在），真实图是 162×162 见方。
      out.push({
        key: `${pkg.id}:${item.id}`,
        emoticon_unique: `upower_${item.text}`,
        width: 1,
        height: 1,
        is_dynamic: false,
        in_player_area: false,
        bulge_display: false,
        package_kind: "owned",
        text: item.text,
        url: emoteImage(162, 162, seed),
        room_id: 0,
        locked: false,
      });
    }
  }
  return out;
}

/**
 * 冒烟的 `emotes_list` 替身 = 两份真实载荷并起来：
 * 公开测试房间（`room_id 5440`）只下发「通用表情」一个包，粉丝牌 / 本房间那两包要有在播房间才有，
 * 因此把 `live_rich` 的两个包也一并按**替身房间 5440** 呈现（房间号按仓库规矩不入库）。
 */
const FIXTURE_EMOTES = {
  live: [
    ...mapFixtureResponse(5440, EMOTE_FIXTURE.live, 0),
    ...mapFixtureResponse(5440, EMOTE_FIXTURE.live_rich, 7),
  ],
  owned: mapFixtureOwned(EMOTE_FIXTURE.owned, 3),
};

/** 弹幕行里的表情样本也取自真实载荷：行内一条通用（200×60）、独占一行一条 `bulge_display`。 */
const ROW_EMOTE_SAMPLES = {
  inline: FIXTURE_EMOTES.live.find(
    (emote) => emote.package_kind === "common" && emote.bulge_display === false,
  ),
  bulge: FIXTURE_EMOTES.live.find((emote) => emote.bulge_display === true),
};

/**
 * 弹幕行的**真实载荷**（`DANMU_MSG`，见该文件自己的 `_note`）：用户 2026-09-12 报的那条正文行
 * 与一条真实表情包弹幕。冒烟里这两行**不许手写** —— 手写的「测试主播 / 64×64 表情」正是
 * 「表情把格子撑破」这类 bug 逃过验证的根因（同 emotes.json 的口径）。
 */
const ROW_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/danmaku-rows.json", import.meta.url), "utf8"),
);

/**
 * 关注列表的**真实取样**（用户 2026-09-13 报的「看不到未开播的关注」）：
 * 由 `fixtures/follow-status-raw.json`（真实响应，已脱敏）派生，**70 条、取样当时全部未开播**。
 *
 * 为什么用这份而不是手写：此前冒烟里的「离线甲 / 离线乙」是**手造的**，于是
 * 「上游只给在播房间、未开播的一个都不返回」这个真实故障在冒烟里从来照不出来。
 * 现在列表里绝大多数条目都是真实取样，未开播项一旦丢掉（过滤 / 分页 / 渲染），冒烟必红。
 */
const FOLLOW_FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/follow-list.json", import.meta.url), "utf8"),
);

/** 真实 CDN 图的**内联替身**：固有尺寸与真图一样（头像原图直出，见 app.module.css 的 512 事故）。 */
function inlineImage(width, height, fill) {
  return (
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='" +
    width +
    "' height='" +
    height +
    "'><rect width='" +
    width +
    "' height='" +
    height +
    "' fill='" +
    fill +
    "'/></svg>"
  );
}

/**
 * 一条 `DANMU_MSG` 载荷 → `Message`：取值路径**照搬** `crates/danmubox-bili/src/cmd.rs::danmaku`
 * —— 正文 `info[1]`、颜色 `info[0][3]`、时间戳 `info[0][4]`、本房间舰长 `info[7]`、
 * 用户 `info[0][15].user`（粉丝牌取 `medal.{level,name,v2_medal_color_*}`）、
 * 表情 `info[0][13]`（**对象**才算，字符串 `"{}"` 不算）、`extra`（JSON 字符串）里的
 * `id_str` 与回复关系。
 *
 * 只有两类值不照搬：① 图床地址换成本地替身（真图在 i0.hdslb.com，离线跑不到，
 * 但**固有尺寸必须一致**——162×162 的方图只给 height 就会「看起来没问题」）；
 * ② 夹具里被脱敏成 `<redacted>` 的字段（uid 等）按「上游没给」处理，与 Rust 侧的
 * `unwrap_or(0)` / `unwrap_or_default()` 同一语义。
 */
function messageFromDanmakuPayload(payload, roomId = 5440) {
  const info = payload.info;
  const meta = Array.isArray(info[0]) ? info[0] : [];
  const slot = meta[15] ?? {};
  const user = slot.user ?? {};
  let extra = {};
  try {
    extra = JSON.parse(slot.extra ?? "{}");
  } catch {
    extra = {};
  }
  const num = (value) => (typeof value === "number" ? value : 0);
  const str = (value) => (typeof value === "string" && value !== "<redacted>" ? value : "");
  const pointer = (root, path) =>
    path.split("/").reduce((node, key) => (node == null ? undefined : node[key]), root);
  // 表情：`info[0][13]` 是对象、且有非空 url 时才算（非表情弹幕这一格是字符串 "{}"）
  const rawEmote = meta[13];
  const emote =
    rawEmote && typeof rawEmote === "object" && typeof rawEmote.url === "string" && rawEmote.url
      ? {
          emoticon_unique: rawEmote.emoticon_unique ?? "",
          // 上游给 http，实现侧会升到 https（crates/danmubox-bili/src/asset.rs），这里照搬
          url: inlineImage(rawEmote.width ?? 0, rawEmote.height ?? 0, "%23c08a2e"),
          width: num(rawEmote.width),
          height: num(rawEmote.height),
          is_dynamic: num(rawEmote.is_dynamic) !== 0,
          in_player_area: num(rawEmote.in_player_area) !== 0,
          bulge_display: num(rawEmote.bulge_display) !== 0,
        }
      : null;
  const rawFace = str(user.base?.face);
  return {
    local_id: 1,
    room_id: roomId,
    kind: "danmaku",
    ts: num(meta[4]) || Date.now(),
    uid: num(user.uid),
    uname: str(pointer(user, "base/name")),
    // 头像原图直出（512 见方）：替身保持同样的固有尺寸，否则「没给宽高就顶爆」量不出来
    face: rawFace.length > 0 ? inlineImage(512, 512, "%2300aeec") : "",
    content: typeof info[1] === "string" ? info[1] : "",
    color: num(meta[3]),
    medal_level: num(pointer(user, "medal/level")),
    medal_name: str(pointer(user, "medal/name")),
    // 缺键按「亮」（与后端 parse 同一口径）：is_light 是官方画不画牌的唯一判据。
    medal_lit: num(pointer(user, "medal/is_light") ?? 1) !== 0,
    medal_color_start: str(pointer(user, "medal/v2_medal_color_start")),
    medal_color_end: str(pointer(user, "medal/v2_medal_color_end")),
    medal_color_border: str(pointer(user, "medal/v2_medal_color_border")),
    medal_color_text: str(pointer(user, "medal/v2_medal_color_text")),
    medal_guard_level: num(pointer(user, "medal/guard_level")),
    guard_level: num(info[7]),
    is_admin: num(info[2]?.[2]) === 1,
    reply_to_uid: num(extra.reply_mid),
    reply_to_uname: str(extra.reply_uname),
    reply_type_enum: num(extra.reply_type_enum),
    show_reply: extra.show_reply === true,
    reply_uname_color: str(extra.reply_uname_color),
    emote,
    is_history: false,
    amount: 0,
    combo_id: "",
    upstream_id: str(extra.id_str),
  };
}

/** 夹具里那两条真实弹幕（用户报的正文行 + 一条真实表情包弹幕）。 */
const ROW_FIXTURES = {
  text: messageFromDanmakuPayload(ROW_FIXTURE.text),
  emoticon: messageFromDanmakuPayload(ROW_FIXTURE.emoticon),
};

/**
 * 一条**无空格的长 ASCII 串**的取证样本（用户 2026-09-13：长文本要能好好折行）：
 * 直接取夹具那条真实载荷里的 CDN 地址（`info[0][15].user.base.face`，只脱敏哈希段），
 * **不手写**。别人在弹幕里贴链接就是这个形状：一整串没有空格、没有可断点，
 * 只能靠 `overflow-wrap` 就地断开。它在 360 宽下必然超出一行的宽度
 * （45 个 ASCII 字符 ≈ 300px+，而正文可用宽度不到 300px），所以「有没有断」是量得出来的。
 */
const ROW_ASCII_TOKEN = ROW_FIXTURE.text.info[0][15].user.base.face;

/** 把值嵌进 MOCK 模板字符串：反引号与 `${` 必须先转义，否则场景代码会提前结束。 */
function embed(value) {
  return JSON.stringify(value).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
/**
 * 本次运行的档位：`SMOKE_THEME`（dark / light / system，默认 dark）。
 * 它写进 mock 的 `ui.theme`，由 App 的主题 effect 落到 <html data-theme> —— 也就是说
 * 深浅两套的截图与断言是**同一份场景**跑两遍，不是两套场景（docs/ui.md §15）。
 */
const THEME = process.env.SMOKE_THEME ?? "dark";
const MOCK = (theme) => `(function () {
  var EMOTES = ${embed(FIXTURE_EMOTES)};
  var ROW_EMOTES = ${embed(ROW_EMOTE_SAMPLES)};
  var ROW_FIXTURES = ${embed(ROW_FIXTURES)};
  // 礼物 / SC / 大航海的夹具行（按协议文档字段表构造，见 Node 侧 GIFT_FIXTURE 的说明）：
  // 每一项的 message 字段已经是归一化后的形状，冒烟只做字段搬运（上游载荷 → Message 在 Rust 侧）。
  var GIFT_ROWS = ${embed(GIFT_FIXTURE.rows)};
  // 无空格的长 ASCII 串（真实载荷里的 CDN 地址，见 Node 侧 ROW_ASCII_TOKEN 的说明）
  var ROW_ASCII = ${embed(ROW_ASCII_TOKEN)};
  var FOLLOW_FIXTURE_ROWS = ${embed(FOLLOW_FIXTURE)};
  var listeners = {};
  var calls = [];
  // 带参数的调用记录（看请求形状，如 chat_send 的表情唯一键）；calls 只有命令名，保持原样。
  var callsWithArgs = [];
  // 发送结果替身：默认 ok；用 __setSendOutcome 改成失败态，验证「浮动提示」那一套
  var sendOutcome = { outcome: "ok", detail: null };
  window.__setSendOutcome = function (outcome, detail) {
    sendOutcome = { outcome: outcome, detail: detail || null };
  };
  // 「上游还没回」的那一刻：扣住 chat_send 的回执，直到 __releaseSend 才 resolve。
  // 用来断言「失败标记只在（且必然在）上游明确拒绝之后才出现」—— 回执没到之前，
  // 那条本地行必须与已确认行逐项相同（用户 2026-09-13：上游返回只做校验）。
  var sendGate = null;
  window.__holdSend = function () { sendGate = { release: null }; };
  window.__releaseSend = function () {
    var gate = sendGate;
    sendGate = null;
    if (gate && gate.release) gate.release();
  };
  var nextId = 1;
  var prefs = {
    "ui.font_scale": 1, "ui.theme": "${theme}", "ui.auto_scroll": true,
    "ui.pause_on_hover": false,
    // 礼物类消息的两枚开关（契约 §8，issue 2609152029 第 1 条把旧的
    // 「ui.gift_panel_mode」这个字符串键拆成了这两枚布尔键）：管弹幕流的那枚与管独立礼物栏的
    // 那枚各管一头，**默认都是 true**（两处都渲染）。
    "ui.gift_in_danmaku": true, "ui.gift_panel": true, "ui.interact_auto_hide": true,
    // 共享分区的顺序与份额（issue #8，契约 §8 新增的两枚键）：默认「礼物在下、份额 0.35」。
    // 替身里必须与 prefs_get 同形（真实命令返回的是**合并过默认值的全集**），否则界面拿到的
    // 是 undefined、断言也就量不到「默认值」这件事。
    "ui.gift_pane_on_top": false, "ui.gift_pane_ratio": 0.35,
    // 低价礼物两枚开关（issue 2609162056 第 3 / 4 条，契约 §8）：**默认都是 false**（改前的
    // 形态就是「不折叠、不剔除」）。替身里必须与 prefs_get 同形，界面才量得到「默认关」这件事。
    "ui.gift_collapse_cheap": false, "ui.gift_exclude_cheap_stats": false,
    "ui.show_timestamp": false,
    // 键清单照抄契约 §8：ui.system_notice 随「系统类只由 filter.kinds 把关」
    // 一起删掉（两个门盖的消息集合逐字相同），关键词命中那三键随 item 9 一起删掉了，
    // 房管屏蔽词走 admin_keywords_*（IPC 命令，不是偏好键），不在这一份里。
    "composer.phrases": ["早上好"], "filter.uids": [],
    // 默认白名单**不含 system**（契约 §8.1 / §4.8）：系统行默认不渲染，
    // 要看就现场勾「消息类型 → 系统」那一项（step4）。
    "filter.kinds": ["danmaku", "gift", "superchat", "interact", "guard"],
    "filter.medal_level_min": 0, "history.buffer_rows": 5000,
    // 「最近观看」（契约 §8）：离线甲（room 300）先看过，**夹具第 1 条**（真实取样）后看过 ——
    // 用来看排序是否真的按它降序（见场景 step1 的 #16 断言）。
    "ui.recent_watched": { "300": 1789900000000, "${FOLLOW_FIXTURE[0].room_id}": 1789990000000 }
  };
  var nextLocal = 1;
  function msg(kind, content, isHistory, extra) {
    nextLocal += 1;
    var base = {
      local_id: nextLocal, room_id: 5440, kind: kind, ts: Date.now(),
      uid: 500 + nextLocal, uname: kind === "interact" ? "进场观众" + nextLocal : "观众" + nextLocal,
      content: content, color: 0, medal_level: 0, medal_name: "", medal_lit: true, guard_level: 0,
      medal_guard_level: 0, reply_to_uid: 0, reply_to_uname: "",
      is_admin: false, face: "", is_history: !!isHistory, amount: 0, combo_id: "",
      emote: null, upstream_id: "smoke-" + nextLocal
    };
    for (var key in (extra || {})) base[key] = extra[key];
    return base;
  }
  // 头像样本刻意用**原图尺寸 512×512**：上游 CDN 的头像是原图直出（没有尺寸后缀），
  // 一旦 CSS 没给出宽高，<img> 就按 512 渲染、把整页顶爆。32×32 的小图看不见这个毛病。
  var FACE_512 = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><rect width='512' height='512' fill='%2300aeec'/></svg>";
  // 房间字段来自**真实载荷夹具**（见文件头的 room-play-info.json / room-h5-info.json 说明），
  // 默认只有 1 个：标签条只在**多于一个**房间时渲染（App 既有语义），
  // 场景末尾用 __addSecondRoom() 补登记第二个，好把 #18（标签条显示主播名、不显示房间号）
  // 也验到——不然那一段永远没有可观察面。
  var fixtureRoom = ${JSON.stringify(FIXTURE_ROOM)};
  var rooms = [Object.assign({}, fixtureRoom)];
  // 第二个房间刻意是「**上游没给主播名与标题**」的形态：getH5InfoByRoom 到不了、
  // 或字段缺失时就是这样。它让「取不到名字」这条路在冒烟里真实可见——房间卡与标签
  // 都只能报房间号，**不许**渲染「未命名直播间」那种占位词（docs/ui.md §2.2）。
  // 幂等：场景在房间页里先登记一次（多标签隔离那一段），末尾再调一次也不会多出一条。
  window.__addSecondRoom = function () {
    if (rooms.some(function (r) { return r.room_id === 5555; })) return;
    rooms.push({
      room_id: 5555, short_id: 0, anchor_uid: 0, anchor_uname: "",
      title: "", live_status: 0, connected: false, buffered: 0
    });
  };
  // 标签条那一段要「开一堆房间」：__addRooms(n) 追加 n 个**上游没给名字**的房间
  // （与 5555 同款：标签只能报房间号），标签条因此一定横向溢出 ——
  // 「开多了不挤在一起」才有可观察面。幂等：同一号不会重复登记。
  window.__addRooms = function (count) {
    for (var added = 1; added <= count; added += 1) {
      var id = 6000 + added;
      if (rooms.some(function (r) { return r.room_id === id; })) continue;
      rooms.push({
        room_id: id, short_id: 0, anchor_uid: 0, anchor_uname: "",
        title: "", live_status: 0, connected: false, buffered: 0
      });
    }
  };
  // 反向：把某个房间从替身的 rooms_list 里删掉（下一次重拉就不再返回它）——
  // 用来验「拖动中被拖的那个房间被关掉」。
  window.__dropRoom = function (roomId) {
    rooms = rooms.filter(function (r) { return r.room_id !== roomId; });
  };
  // 关注列表（用户 2026-09-13：「关注但未开播的也一直没加载到主界面」）：
  // **70 条真实取样**直接来自夹具（fixtures/follow-list.json ← follow-status-raw.json，
  // 取证当天全部未开播）。此前这里只有手造的「离线甲 / 离线乙」，于是「上游只给在播房间、
  // 未开播一个都不返回」这个真实故障在冒烟里永远照不出来。
  // 只有下面 3 条是自造的：取证当天该账号无人开播，live_status == 1 的真实样本拿不到，
  // 而「在播置顶 / 标题行 / 最后开播时间」必须有条目可断言。字段名仍按 A28 实测
  // （liveTime → live_start_at）。
  var followed = FOLLOW_FIXTURE_ROWS.map(function (row, index) {
    // 头像位换成冒烟的内联替身：夹具里是脱敏后的 CDN 地址，真去请求只会挂网。
    return Object.assign({}, row, { face: index % 3 === 0 ? FACE_512 : "" });
  });
  followed = followed.concat([
    { room_id: 100, uname: "在播主播", face: FACE_512, title: "在播中的直播间标题", live_status: 1, group_name: "", live_start_at: 1789000000, online: 500 },
    { room_id: 200, uname: "离线乙", face: "", title: "离线乙的直播间标题", live_status: 0, group_name: "", live_start_at: 1789500000, online: 0 },
    { room_id: 300, uname: "离线甲", face: "", title: "", live_status: 0, group_name: "", live_start_at: 1700000000, online: 0 }
  ]);
  // 账号（契约 §7 accounts_list）：条目自带登录状态与身份。
  var accounts = [
    {
      name: "default", nickname: "本地测试", uid: 1000, logged_in: true, active: true,
      face: FACE_512
    }
  ];
  // 假二维码（21×21 图案）：真二维码由后端离线渲染，这里只要截图里**看得到图案**，
  // 免得「二维码是空白」被误读成界面 bug。
  var qrSvg = (function () {
    var cells = "";
    for (var y = 0; y < 21; y += 1) {
      for (var x = 0; x < 21; x += 1) {
        var finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
        if (finder || ((x * 7 + y * 13) % 5) < 2) {
          cells += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="21" height="21" shape-rendering="crispEdges"><rect width="21" height="21" fill="#fff"/><g fill="#000">' + cells + '</g></svg>';
  })();
  var session = { logged_in: true, uid: 1000, nickname: "本地测试", active_profile: "default" };
  // 会话由账号表派生：谁 active 且 logged_in 就是当前会话，切换/登出/删除后都靠它同步。
  var syncSession = function () {
    var active = accounts.filter(function (a) { return a.active; })[0];
    var who = active && active.logged_in ? active : null;
    session = {
      logged_in: !!who, uid: who ? who.uid : 0, nickname: who ? who.nickname : "",
      active_profile: active ? active.name : ""
    };
    return session;
  };
  var history = msg("danmaku", "这是进场回填的历史弹幕", true);
  window.__smoke_next = function () { return msg; };
  window.__calls = calls;
  window.__callsWithArgs = callsWithArgs;
  window.__prefs = prefs;
  window.__followCalls = 0;
  // 列表页那一拍（rooms_refresh_status）的调用次数与失败开关：定期刷新 / 不可见不拉 / 退避
  // 三条断言都数它。__statusFlip 让替身在每次刷新时把 live_status 翻过去，用来证明
  // 「界面真的按上游那份重画了」，而不是只证明「命令被调用了」。
  window.__statusRefreshes = 0;
  window.__statusFail = false;
  window.__statusFlip = false;
  window.__statusNext = null;
  window.__qrPolls = 0;
  window.__qrTarget = null;
  // 轮询失败开关：验证「失败要能重试」（面板留在原地 + 重新获取按钮）
  window.__qrFail = false;
  window.__mk = msg;
  /**
   * 夹具里的一条礼物 / SC / 大航海 → Message 并广播（**归一化层**：夹具给的已经是 Message
   * 形状，上游载荷 → Message 的解析在 Rust 侧 —— SEND_GIFT_V2 的 protobuf 冒烟不解，见
   * fixtures/gift-sc-guard-rows.json 的 _note）。
   *
   * 头像：夹具里只写脱敏后的 CDN 地址形状（真去请求只会挂网），这里换成本地内联替身 ——
   * 与弹幕行同一条口径。face 为空串的那两条（V1 礼物 / 大航海）保持空串：上游没有头像源，
   * 界面就不画假图（这正是要断言的那件事，不能在夹具这一层补上）。
   */
  var emitGiftRow = function (key) {
    var row = GIFT_ROWS.filter(function (r) { return r.key === key; })[0];
    if (!row) return false;
    var spec = row.message;
    var extra = {};
    for (var field in spec) {
      if (field !== "kind" && field !== "content") extra[field] = spec[field];
    }
    extra.face = spec.face ? FACE_512 : "";
    window.__emit("danmubox://message", msg(spec.kind, spec.content, false, extra));
    return true;
  };
  window.__history = history;
  // 房管身份开关：默认是房管；冒烟中途翻成 false 验证「无权限时置灰 + 说明原因」。
  window.__admin = true;
  window.__adminFail = false;
  window.__setAdmin = function (value) { window.__admin = value; };
  window.__setAdminFail = function (value) { window.__adminFail = value; };
  window.__emit = function (event, payload) {
    (listeners[event] || []).forEach(function (id) {
      window["_" + id]({ event: event, id: id, payload: payload });
    });
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: function (cb, once) {
      var id = nextId++;
      Object.defineProperty(window, "_" + id, {
        value: function (result) { if (once) delete window["_" + id]; cb(result); },
        writable: false, configurable: true, enumerable: true
      });
      return id;
    },
    invoke: function (cmd, args) {
      calls.push(cmd);
      args = args || {};
      callsWithArgs.push({ cmd: cmd, args: args });
      switch (cmd) {
        case "app_info": return Promise.resolve({ version: "0.0.0-smoke", data_dir: "/tmp", config_path: "/tmp/config.toml", logged_in: true });
        case "session_status": return Promise.resolve(session);
        case "accounts_list": return Promise.resolve(accounts.map(function (a) {
          return { name: a.name, nickname: a.nickname, uid: a.uid, face: a.face, logged_in: a.logged_in, active: a.active };
        }));
        case "account_switch": {
          accounts.forEach(function (a) { a.active = a.name === args.name; });
          return Promise.resolve(syncSession());
        }
        case "account_qr_start": {
          window.__qrTarget = args.target === undefined ? null : args.target;
          window.__qrPolls = 0;
          return Promise.resolve({ key: "k1", url: "https://example.invalid/qr", svg: qrSvg });
        }
        // 第 1 次问 = 已扫待确认，第 2 次 = 确认：两条状态文案都要能在界面上看到。
        case "account_qr_poll": {
          if (window.__qrFail) {
            return Promise.reject({ code: "INTERNAL", message: "轮询扫码状态失败（冒烟替身）" });
          }
          window.__qrPolls += 1;
          if (window.__qrPolls < 2) return Promise.resolve({ state: "scanned", account: null });
          var name = window.__qrTarget || "扫码新用户";
          var existing = accounts.filter(function (a) { return a.name === name; })[0];
          accounts.forEach(function (a) { a.active = false; });
          if (existing) {
            existing.logged_in = true;
            existing.active = true;
          } else {
            existing = {
              name: name, nickname: "扫码新用户", uid: 2000, face: "", logged_in: true, active: true
            };
            accounts.push(existing);
          }
          syncSession();
          return Promise.resolve({ state: "confirmed", account: existing });
        }
        case "account_logout": {
          var lname = args.name;
          if (lname === undefined) {
            var act = accounts.filter(function (a) { return a.active; })[0];
            lname = act ? act.name : "";
          }
          accounts.forEach(function (a) { if (a.name === lname) a.logged_in = false; });
          return Promise.resolve(syncSession());
        }
        case "account_remove": {
          var wasActive = accounts.filter(function (a) { return a.name === args.name && a.active; }).length > 0;
          accounts = accounts.filter(function (a) { return a.name !== args.name; });
          if (wasActive && accounts.length > 0) accounts[0].active = true;
          return Promise.resolve(syncSession());
        }
        case "rooms_list": return Promise.resolve(rooms.map(function (r) { return Object.assign({}, r); }));
        // 列表页的定期刷新（契约 §4）：替身按调用次数把状态翻过去 —— 界面「到点自己重拉」
        // 与「不可见不拉」两条都靠 __statusRefreshes 数出来（见 roomStatus* 断言）。
        case "rooms_refresh_status": {
          window.__statusRefreshes += 1;
          if (window.__statusFail) {
            return Promise.reject({ code: "UPSTREAM_ERROR", message: "刷新房间状态失败（冒烟替身）" });
          }
          if (window.__statusFlip) {
            rooms.forEach(function (r) { r.live_status = r.live_status === 1 ? 0 : 1; });
          }
          // **一次性**覆盖：只对下一次刷新生效，用来证明「拉回来的那个值真的落到了卡片上」
          // （而不是只证明了「命令被调用过」）。用完即清，后续各拍照旧。
          if (window.__statusNext !== null) {
            rooms.forEach(function (r) { r.live_status = window.__statusNext; });
            window.__statusNext = null;
          }
          return Promise.resolve(rooms.map(function (r) { return Object.assign({}, r); }));
        }
        case "prefs_get": return Promise.resolve(Object.assign({}, prefs));
        case "prefs_set": Object.assign(prefs, args.patch); return Promise.resolve(Object.assign({}, prefs));
        case "follow_list": window.__followCalls += 1; return Promise.resolve(followed.slice());
        case "history_query": return Promise.resolve([history]);
        // 表情替身：**全部由 「smoke/fixtures/emotes.json」（真实响应固化）派生**，
        // 见文件头的 EMOTES 构造。这里不许再出现手写的表情 JSON。
        case "emotes_list": return Promise.resolve(EMOTES.live);
        case "report_reasons": return Promise.resolve([{ id: 1, reason: "垃圾广告" }]);
        // 主站「我的表情」：用户点名要的那条必须能从面板发回去（issue #8）。
        case "emotes_owned": return Promise.resolve(EMOTES.owned);
        case "chat_send": {
          var sendPayload = Object.assign(
            { room_id: args.roomId, content: args.content }, sendOutcome);
          if (sendGate) {
            // 回执被扣住：把 release 挂到这一次调用上，__releaseSend 时才 resolve。
            var gate = sendGate;
            return new Promise(function (resolve) { gate.release = function () { resolve(sendPayload); }; });
          }
          return Promise.resolve(sendPayload);
        }
        // 房内身份（房管权限前置 + item 12 的字数上限）+ 房管只读三块 + 写操作（替身只记调用，不动真上游）。
        // danmaku_length 是契约 §5 的字段（上游 getInfoByUser 的 data.property.danmu.length，
        // 实测 40 / 缺省 20）：缺了它界面会按 20 回落，item 12 的上限断言就量不到真值。
        case "room_session": return Promise.resolve({
          room_id: args.roomId,
          my_medal_level: 0,
          my_medal_name: "",
          my_medal_worn: false,
          my_guard_level: 0,
          danmaku_length: 40,
          is_admin: window.__admin
        });
        // 三块各自的读取失败开关：__setAdminFail(true) 时**三块一起**拒绝 —— 面板里的错误条
        // 按当前 tab 只渲染一条（issue #1 之后一次只渲染一块），冒烟因此能逐 tab 各断一次。
        case "admin_silent_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve([{ uid: 900, uname: "被禁言的观众", face: "" }]);
        case "admin_blacklist_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve([{ uid: 901, uname: "黑名单观众", face: "" }]);
        case "admin_keywords_list": return window.__adminFail
          ? Promise.reject({ code: "UPSTREAM_ERROR", message: "不是管理员（code 100004）" })
          : Promise.resolve(["刷屏", "广告"]);
        case "admin_mute":
        case "admin_unmute":
        case "admin_blacklist_add":
        case "admin_blacklist_del":
        case "admin_keywords_add":
        case "admin_keywords_del": return Promise.resolve(null);
        case "wallet_balance": return Promise.resolve(150);
        case "rooms_connect": return Promise.resolve(null);
        // 「刷新连接」：替身按后端语义回一条状态流（connecting → connected），并记下
        // 「有没有真的发这条命令」——断连之后菜单里那颗键必须是活的（见下面的断言）。
        case "rooms_reconnect":
          window.__reconnectCalls = (window.__reconnectCalls || 0) + 1;
          window.__lastReconnectRoom = args.roomId;
          window.__emit("danmubox://status", { room_id: args.roomId, state: "connecting", detail: "手动重连" });
          window.__emit("danmubox://status", { room_id: args.roomId, state: "connected", detail: "verified" });
          return Promise.resolve(null);
        case "plugin:event|listen": (listeners[args.event] = listeners[args.event] || []).push(args.handler); return Promise.resolve(nextId);
        case "plugin:event|unlisten": return Promise.resolve(null);
        default: return Promise.resolve(null);
      }
    }
  };

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

  window.__smoke_run = async function () {
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
    var followNames = allByTestId("db-follow-item").map(function (el) { return el.innerText.split("\\n")[0]; });
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
        var name = el.innerText.split("\\n")[0];
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
    //      不写死 light / dark。（模板串里不许出现反引号与反斜杠，见文件头 —— 这里一条正则都不写。）
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
    //      ⚠ 解析**不用正则**：MOCK 是模板字符串，反斜杠在模板求值时就没了 —— 实测写
    //      /rgba?\(([^)]+)\)/ 经过模板会变成 /rgba?(([^)]+))/，捕获到的是带括号的 "(37, 211, 102)"，
    //      parseFloat 直接 NaN（第一版就是这么红的）—— 与上面 luminance 同一个理由，那里也是 indexOf 切的。
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

    // ---- 工具行只剩三个面板入口：表情 / 短语 / 筛选（用户 #7：「最近」整条链路删掉）
    var toolLabels = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .map(function (b) { return b.innerText.trim(); });
    out.toolsPanelButtons = toolLabels;
    out.toolsOnlyThreePanels = ["表情", "短语", "筛选"].every(function (t) {
      return toolLabels.indexOf(t) >= 0;
    }) && toolLabels.indexOf("最近") < 0;

    // ---- 文档本身**永不滚动**（键盘 / 面板只许挤压内部滚动区，不许把整个界面顶走；docs/ui.md §9.3）
    //      为什么钉这条：安卓上键盘避让只有一条机制 —— 原生把「系统栏 ∪ 键盘」的高度下发成
    //      --safe-bottom，body 用它让出底部空间，窗口**不**为键盘 resize（AndroidManifest 里
    //      windowSoftInputMode=adjustNothing）。这条链子一旦被谁再叠一次（平台又替我们 resize
    //      了一次视口、或内部某一层比容器高），多出来的那一截就会把 **document** 变成一个可滚容器：
    //      手指在弹幕列表上滑到底之后会**接力**滚它，整个界面（含房间顶栏）被顶上去、底边露出画布色
    //      （用户 2026-09-16 报的就是这个）。无头里没有 IME，所以这里验的是这条链子的**布局那一半**：
    //      ① 常态 ② 面板展开（固定高度的兄弟最多、最容易把外壳撑破的一档）③ 把 --safe-bottom 换成
    //      键盘高度（原生在键盘弹出时就是换这个值）三种状态下，文档都不可滚，且「body 铺满视口、
    //      #root 恰好短掉 body 的上下内边距（= 让开系统栏 / 键盘）」这条链子成立。
    //      IME 那一半（系统会不会额外 resize / 平移窗口）只能在设备上看，见 docs/ui.md §9.3。
    function docBox() {
      var se = document.scrollingElement;
      var bodyStyle = getComputedStyle(document.body);
      return {
        overflow: se.scrollHeight - se.clientHeight,
        scrollTop: se.scrollTop,
        bodyH: document.body.getBoundingClientRect().height,
        rootH: document.getElementById("root").getBoundingClientRect().height,
        viewH: window.innerHeight,
        // body 的上下内边距 = 让开系统栏 / 键盘的那两条（--safe-top / --safe-bottom）。
        // #root 的高度以百分比写在 body 上，解析的是 body 的**内容盒** —— 键盘那一档
        // 因此短掉内边距那么多，这不是漏让开，正是让开本身（见下面那条断言的说明）。
        padTop: Number.parseFloat(bodyStyle.paddingTop) || 0,
        padBottom: Number.parseFloat(bodyStyle.paddingBottom) || 0,
      };
    }
    var docIdle = docBox();
    if (!byTestId("db-panel")) { clickTool("表情"); await sleep(400); }
    var docPanel = docBox();
    if (byTestId("db-panel")) { clickTool("表情"); await sleep(400); }
    var rootStyle = document.documentElement.style;
    var prevSafeBottom = rootStyle.getPropertyValue("--safe-bottom");
    rootStyle.setProperty("--safe-bottom", "336px");
    await sleep(250);
    var docInset = docBox();
    var composerBox = rect(document.querySelector("textarea"));
    var composerVisible = !!composerBox && composerBox.top >= -1 &&
      composerBox.bottom <= window.innerHeight + 1 && composerBox.height > 0;
    // 令牌用完立刻复原：后面的断言还按正常视口量
    if (prevSafeBottom) rootStyle.setProperty("--safe-bottom", prevSafeBottom);
    else rootStyle.removeProperty("--safe-bottom");
    await sleep(200);
    out.docLayouts = { idle: docIdle, panel: docPanel, keyboardInset: docInset };
    out.docNeverScrollable = [docIdle, docPanel, docInset].every(function (d) {
      return d.overflow <= 1 && d.scrollTop === 0;
    });
    // body 是「整屏那一层」（border-box = 动态视口高），#root 的高度是**可用区** ——
    // 它以百分比写在 body 上、解析的是 body 的**内容盒**，所以正好等于「视口 − 上下内边距
    // （--safe-top / --safe-bottom）」。键盘那一档因此是设计意图，不是实现漂了：
    // 实测 idle / panel 两档 rootH = 900 = 视口高（两条内边距在桌面上都是 0），
    // keyboardInset 一档 rootH = 564 = 900 − 336（原生在键盘弹出时下发的就是 336px，
    // 见 docs/ui.md §9.3 与 index.css 顶上那段「界面自补内边距」）。
    // 旧写法要求 rootH 也 = 视口高，等于要求「让开键盘这件事不发生」。新写法钉住的是这条链子
    // 本身：body 铺满视口（不让开就没有那一截），root 恰好短掉 body 的内边距（谁把
    // height:100% / box-sizing 改坏都立刻红），三档一起成立才过。
    out.docHeightsMatchViewport = [docIdle, docPanel, docInset].every(function (d) {
      return Math.abs(d.bodyH - d.viewH) <= 1 &&
        Math.abs(d.rootH - (d.viewH - d.padTop - d.padBottom)) <= 1;
    });
    out.docComposerVisibleWithKeyboardInset = composerVisible;
    out.docSafeBottomRestored = rootStyle.getPropertyValue("--safe-bottom") === prevSafeBottom;

    // ---- layout 弹幕列表是唯一生长区；面板向上展开不遮挡最新弹幕
    var scroller = byTestId("db-chat-scroll");
    var before = rect(scroller);
    var headerEl = byTestId("db-room-header");
    var composerEl = document.querySelector("textarea").closest('[class*="composer"]');
    var headerBefore = rect(headerEl).height;
    var composerBefore = rect(composerEl).height;
    var newestBefore = rows()[rows().length - 1];
    out.layoutNewestVisibleBeforePanel =
      rect(newestBefore).bottom <= before.bottom + 1 && rect(newestBefore).bottom >= before.bottom - 40;
    clickTool("表情");
    await sleep(500);
    var panel = byTestId("db-panel");
    var after = rect(scroller);
    var newestAfter = rows()[rows().length - 1];
    out.layoutPanelShown = !!panel;
    // 面板内部的左右边距只有一条：面板头（搜索框所在行）、每个分区标题与表情格容器
    // 都是面板的直接子元素，左边缘必须完全一致（不然看着就是「有的顶格、有的缩进」）
    var panelChildLefts = [].slice.call(panel.children).map(function (el) {
      return Math.round(el.getBoundingClientRect().left * 10) / 10;
    });
    out.panelChildLefts = panelChildLefts;
    out.panelContentAligned = panelChildLefts.length > 0 && panelChildLefts.every(function (x) {
      return Math.abs(x - panelChildLefts[0]) < 0.6;
    });
    out.layoutPanelAboveComposer = !!panel && !!document.querySelector("textarea") &&
      (panel.compareDocumentPosition(document.querySelector("textarea")) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    out.layoutChatShrankPx = Math.round(before.height - after.height);
    // 「唯一生长区」的双向判：面板展开时只有弹幕列表变矮，头部与输入区纹丝不动
    out.layoutOnlyChatShrank =
      Math.abs(rect(headerEl).height - headerBefore) < 1 &&
      Math.abs(rect(composerEl).height - composerBefore) < 1 &&
      before.height - after.height > 50;
    out.layoutNewestNotCovered = !!newestAfter && rect(newestAfter).bottom <= rect(panel).top + 1;
    // 容器下内边距的计算值：既是「贴底时的呼吸空间」，也是下面几条断言的右值。
    // 不写死 8px：它属于排版令牌（app.module.css），RowRedesign 调它时断言自动跟着走。
    out.layoutScrollerPaddingBottomPx =
      Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    // 贴底时的呼吸空间：末行底边 ↔ **滚动容器（.scroller）自己的底边**的间距必须 == 那个内边距。
    // 尺子为什么量容器而不是「面板顶边」（= 旧口径）：面板是**输入区**那一块里的弹出面板，
    // 而弹幕区与输入区之间现在还夹着**上下分区**（issue #8：礼物栏与弹幕区共享高度、中间一条
    // 8px 分割条；默认态礼物栏是折叠的，那一栏就是折叠头那么高）。于是旧口径量到的其实是
    // 「内边距 + 折叠头 + 分割条」：实测 42.7 = 8（内边距）+ 26.6（折叠头）+ 8.1（分割条），
    // 而它想验的从来不是这个和 —— 是「贴底时最新一条与它所在滚动区底边之间正好留着内边距」。
    // 新尺子一点没放水：贴底（layoutScrollBottomGapPx = 0）时内边距被谁挤掉（末行顶到容器边）
    // 或末行下方多出一截空隙，这条都会红。面板顶边那一份继续留在快照里（分割条口径的证据）。
    out.layoutNewestPanelGapPx = newestAfter
      ? Math.round((rect(panel).top - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutNewestContainerGapPx = newestAfter
      ? Math.round((rect(scroller).bottom - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutNewestGapIsPadding = out.layoutNewestContainerGapPx !== null &&
      Math.abs(out.layoutNewestContainerGapPx - out.layoutScrollerPaddingBottomPx) <= 1;
    // 贴底时的精确几何：为什么最新一条会紧贴容器底边（而不是留出容器下内边距）？
    // scrollHeight - scrollTop - clientHeight = 0 表示已经滚到物理最大位置；
    // 若此时末行底边仍在内容块底边之下（msgListBottomGapPx 为负），说明行高溢出了虚拟高度块。
    out.layoutScrollBottomGapPx = Math.round(
      (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) * 10,
    ) / 10;
    out.layoutMsgListBottomGapPx = newestAfter
      ? Math.round((rect(byTestId("db-msg-list")).bottom - rect(newestAfter).bottom) * 10) / 10
      : null;
    out.layoutLastRowHeightPx = newestAfter ? Math.round(rect(newestAfter).height * 10) / 10 : null;
    out.layoutMsgListHeightPx = Math.round(rect(byTestId("db-msg-list")).height * 10) / 10;
    // 更硬的两条：视口仍在底部（跟随模式重新贴底），且渲染出的最后一行确实是最后一条消息
    // （此刻最后一条是**真实夹具里那条表情包弹幕**，所以按它的表情图 alt 认）
    out.layoutFollowingAtBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    out.layoutLastRowIsNewest = !!newestAfter &&
      [].slice.call(newestAfter.querySelectorAll('[data-testid="db-msg-body"] img'))
        .some(function (img) { return img.alt === ROW_FIXTURES.emoticon.content; });
    // ---- 表情面板 = **竖向 tab 轨道 + 表情网格**（用户 2026-09-12：「给表情的全是按钮，
    //      根本框不住表情图标，可以直接仿照官方实现」）。
    // 表情全部来自固化的真实载荷（「smoke/fixtures/emotes.json」）：通用那 38 条是 200×60 的横条、
    // 粉丝牌那 17 条是 162×162 的方图 —— 手写的 64×64 正方形永远撞不出下面这条「图比格子宽」。
    var emoteTabsOf = function () {
      return [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-tab"]'));
    };
    var emoteGroupsOf = function () {
      return [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-group"]'));
    };
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    /** 每一格：格子（按钮）与里面的图各自的盒子，以及「图有没有跑出格子」。 */
    var emoteMetrics = function () {
      return [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-item"]')).map(function (cell) {
        var box = cell.getBoundingClientRect();
        var img = cell.querySelector("img");
        var ib = img ? img.getBoundingClientRect() : null;
        var cs = img ? getComputedStyle(img) : null;
        return {
          // 「height」 一直是**图**的高度（「layoutEmoteSizes」 / 「layoutNonCommonEmoteBigger」 的旧口径），
          // 尺子换成格子会把「非通用放大档」比成格子高度，比错了东西。
          height: ib ? Math.round(ib.height) : Math.round(box.height),
          big: cell.className.indexOf("pickerItemBig") >= 0,
          cellW: r1(box.width), cellH: r1(box.height),
          imgW: ib ? r1(ib.width) : null, imgH: ib ? r1(ib.height) : null,
          // 溢出量：图越过格子四边的最大值（0 = 完整落在格子里）
          overflow: ib ? r1(Math.max(0, ib.right - box.right, ib.bottom - box.bottom,
            box.left - ib.left, box.top - ib.top)) : 0,
          // 宽高必须是 CSS 给的（「auto」 就是按原图尺寸渲染 = 200×60 会算出 5em 宽）
          explicit: !!cs && cs.width !== "auto" && cs.height !== "auto" && cs.objectFit === "contain"
        };
      });
    };
    var tabOf = function (kind) {
      return emoteTabsOf().filter(function (b) { return b.getAttribute("data-kind") === kind; })[0];
    };
    out.panelEmoteTabs = emoteTabsOf().map(function (b) { return b.innerText.trim(); });
    out.panelEmoteTabCount = emoteTabsOf().length;
    // 一屏只画一组：tab 的代价是「非通用放大档」不能在同一个快照里量，必须切过去量
    out.panelEmoteOneGroupAtATime = emoteGroupsOf().length === 1 &&
      emoteGroupsOf()[0].getAttribute("data-kind") === "common";
    out.panelEmoteTabSelectedOne = emoteTabsOf().filter(function (b) {
      return b.getAttribute("aria-selected") === "true";
    }).length === 1;

    // ---- tab 是**轨道**不是一排按钮：竖向排列、在网格左侧、选中态在视觉上分得出来
    var rail = byTestId("db-emote-tabs");
    var railBox = rect(rail);
    var tabBoxes = emoteTabsOf().map(rect);
    var gridBox = rect(byTestId("db-emote-group"));
    out.panelEmoteRailStacked = tabBoxes.length >= 3 && tabBoxes.every(function (b, i) {
      return i === 0 || b.top >= tabBoxes[i - 1].bottom - 0.5;
    }) && !!railBox && railBox.height > tabBoxes[0].height * 1.5;
    out.panelEmoteRailLeftOfGrid = !!railBox && !!gridBox && railBox.right <= gridBox.left + 1;
    out.panelEmoteTabIsRealTab = !!rail &&
      rail.getAttribute("role") === "tablist" &&
      rail.getAttribute("aria-orientation") === "vertical" &&
      emoteGroupsOf()[0].getAttribute("role") === "tabpanel" &&
      emoteTabsOf().every(function (b) {
        return b.getAttribute("role") === "tab" &&
          b.getAttribute("aria-controls") === emoteGroupsOf()[0].id;
      }) &&
      emoteGroupsOf()[0].getAttribute("aria-labelledby") === tabOf("common").id;
    // 选中态的「明确」= 计算样式真的不一样（不依赖 CSS-module 类名）
    var styleOf = function (el) {
      var cs = getComputedStyle(el);
      return [cs.backgroundColor, cs.color, cs.borderLeftColor, cs.fontWeight].join("|");
    };
    out.panelEmoteTabSelectedStyleDistinct =
      styleOf(tabOf("common")) !== styleOf(tabOf("room"));
    // 键盘可达：↑↓ 在轨道里换组，焦点跟着走（roving tabindex，WAI-ARIA tabs 口径）
    var firstTab = emoteTabsOf()[0];
    firstTab.focus();
    firstTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await sleep(250);
    var afterDown = emoteTabsOf().filter(function (b) {
      return b.getAttribute("aria-selected") === "true";
    })[0];
    out.panelEmoteTabArrowKeys = !!afterDown && afterDown.getAttribute("data-kind") === "owned" &&
      document.activeElement === afterDown &&
      emoteGroupsOf()[0].getAttribute("data-kind") === "owned" &&
      firstTab.getAttribute("tabindex") === "-1" && afterDown.getAttribute("tabindex") === "0";
    afterDown.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    await sleep(250);
    var afterUp = emoteTabsOf().filter(function (b) {
      return b.getAttribute("aria-selected") === "true";
    })[0];
    out.panelEmoteTabArrowUpReturns = !!afterUp &&
      afterUp.getAttribute("data-kind") === "common" && document.activeElement === afterUp;

    var commonMetrics = emoteMetrics();
    var commonSizes = commonMetrics;
    // ---- 「上方的搜索也没必要」（用户 2026-09-12）：面板里**不再有输入框**
    out.panelNoSearch = !!panel && panel.querySelectorAll("input").length === 0;
    // ---- 「表情行数改到 3 行、按大表情的高度固定下来」（用户 2026-09-13 第 2 条）：
    //      网格区高度 = **三行大表情格** + 两道行距，**与当前是哪一组无关**（通用组同一个高度），
    //      内容超出就在网格里滚。两个数都在快照里：通用组一个、大表情组一个，再比它们相等。
    var gridEl = byTestId("db-emote-group");
    var gridStyle = getComputedStyle(gridEl);
    var rowGapOf = function (el) { return parseFloat(getComputedStyle(el).rowGap) || 0; };
    out.panelEmoteGridHeightPx = f1(rect(gridEl).height);
    // ---- 面板顶上**没有「表情」标题、也没有「关闭」**（用户 2026-09-12：两样都不需要；
    //      item 8 之后**三个面板都不带**标题与关闭，db-panel-close 钩子整个界面都不再提供）。
    //      判据分三半：① 面板里没有关闭按钮（testid 契约）；② 没有任何元素**只**写着「表情」
    //      （分组名叫「我的表情」，不是同一个字符串，不会撞上）；③ 整份文档里都没有那个钩子。
    out.panelEmoteSpace = {
      closeButtons: panel.querySelectorAll('[data-testid="db-panel-close"]').length,
      documentCloseButtons: document.querySelectorAll('[data-testid="db-panel-close"]').length,
      headlineOnly: [].slice.call(panel.querySelectorAll("*")).filter(function (el) {
        return el.children.length === 0 && el.textContent.trim() === "表情";
      }).length,
      hasCloseWord: panel.innerText.indexOf("关闭") >= 0,
    };
    out.panelEmoteHeaderGone = out.panelEmoteSpace.closeButtons === 0 &&
      out.panelEmoteSpace.headlineOnly === 0 && !out.panelEmoteSpace.hasCloseWord;
    // 关闭钩子**整个界面都不再提供**（item 8：短语与筛选面板同样没有关闭按钮）：
    // 展开中的这一个面板之外，文档里也不许别处还挂着它。
    out.panelCloseHookGone = out.panelEmoteSpace.documentCloseButtons === 0;
    // 通用组的网格高（它是**三行大表情格**，与当前是哪一组无关）：
    // 数字进快照，下面的 panelEmoteGridSameHeightForBothGroups 拿它和大表情组那个数比相等。
    var commonCellH = commonMetrics.length > 0
      ? Math.max.apply(null, commonMetrics.map(function (m) { return m.cellH; })) : 0;
    out.panelEmoteCommonCellHeightPx = f1(commonCellH);
    out.panelEmoteCommonGridHeightPx = f1(rect(gridEl).height);
    var panelPad = getComputedStyle(panel);
    out.panelHeightPx = f1(rect(panel).height);
    // 三个面板共用同一个定高（--panel-h）：这里是表情面板那一份，短语 / 筛选各自那份在
    // 打开它们的那一步量，最后比三者相等（见 panelHeightsMatch）。
    // 面板高 = 网格高 + 上下内边距（面板里除了网格没有别的行）
    out.panelEmoteHeightIsGridPlusPadding = Math.abs(rect(panel).height -
      (parseFloat(panelPad.paddingTop) + rect(gridEl).height + parseFloat(panelPad.paddingBottom))) <= 1;
    // ---- 左侧 tab 轨道**自己能上下滚**（用户 2026-09-12：「左边也加入上下滚动」），
    //      而且滚动条的槽不挤窄右边的网格（scrollbar-gutter: stable）。
    var railEl = byTestId("db-emote-tabs");
    var gridWidthBefore = rect(gridEl).width;
    out.panelEmoteRailScrollable = getComputedStyle(railEl).overflowY === "auto";
    railEl.scrollTop = railEl.scrollHeight;
    await sleep(250);
    // 「轨道自己能上下滚」= **超出时滚得动**，不是「一定要超出」：用户 2026-09-13 第 2 条把网格区
    // 从两行改到三行大表情格（152.1px）之后，5 个分组（约 140px）在宽屏下**放得下了** —— 轨道
    // 本来就不再溢出，硬要求 scrollTop > 1 等于要求「必须溢出」，那是把改前的偶然当契约。
    // 判据因此写成两支：① 内容没超出 → 不滚是正确行为；② 超出 → 必须真的滚起来。
    // 溢出量进快照（panelEmoteRailOverflowPx），下次谁再改高度，这两个数一起看。
    var railOverflowPx = railEl.scrollHeight - railEl.clientHeight;
    out.panelEmoteRailOverflowPx = railOverflowPx;
    out.panelEmoteRailScrolled = railOverflowPx > 1 ? railEl.scrollTop > 1 : true;
    out.panelEmoteRailKeepsGridWidth = Math.abs(rect(gridEl).width - gridWidthBefore) < 0.6;
    railEl.scrollTop = 0;
    await sleep(200);
    out.panelEmoteGridKind = gridEl.getAttribute("data-kind");
    out.panelEmoteGridScrollHeightPx = gridEl.scrollHeight;
    // 网格是面板里**唯一会滚的部分**（固定高度 + overflow-y: auto）；
    // 「内容真的超出」在窄屏量：38 条通用表情在 360 宽下必然塞不进两行（宽屏一行放得下就是放得下）。
    out.panelEmoteGridScrollable = gridStyle.overflowY === "auto";
    if (NARROW) {
      put("panelEmoteGridOverflows", gridEl.scrollHeight > gridEl.clientHeight + 1);
    }
    var roomTab = tabOf("room");
    if (roomTab) {
      roomTab.click();
      await sleep(300);
      out.panelEmoteTabSwitchWorks = emoteGroupsOf().length === 1 &&
        emoteGroupsOf()[0].getAttribute("data-kind") === "room";
    }
    var bigMetrics = emoteMetrics();
    var bigSizes = bigMetrics;
    var allMetrics = commonMetrics.concat(bigMetrics);
    var commonH = commonMetrics.filter(function (x) { return !x.big; })[0];
    var bigH = bigMetrics.filter(function (x) { return x.big; })[0];
    out.layoutEmoteSizes = commonSizes;
    out.layoutEmoteSizesBig = bigSizes;
    out.layoutNonCommonEmoteBigger = !!commonH && !!bigH && bigH.height >= commonH.height * 1.4;
    // ---- 网格区高度 = **三行大表情** + 两道行距（用户 2026-09-13 第 2 条）。
    //      大表情那一档的高度从**格子**量（--emote-size-big 注册成 <length>，格子与网格区
    //      因此用的是同一个绝对值；不注册的话格子会再乘一次自己的字号、差 1.3 倍）。
    var bigRowH = Math.max.apply(null, bigMetrics.map(function (m) { return m.cellH; }));
    var gridRowGap = parseFloat(getComputedStyle(gridEl).rowGap) || 0;
    out.panelEmoteBigRowHeightPx = f1(bigRowH);
    out.panelEmoteGridRowGapPx = f1(gridRowGap);
    out.panelEmoteBigGridHeightPx = f1(rect(gridEl).height);
    out.panelEmoteGridThreeBigRows = bigMetrics.length > 0 &&
      Math.abs(rect(gridEl).height - (bigRowH * 3 + gridRowGap * 2)) <= 1;
    // 两组**同一个高度**（用户 2026-09-13 第 2 条：大表情那一档的高度固定下来，通用组也用它）：
    // 换了分组面板不忽高忽低，通用组也正好看到三行大格。
    out.panelEmoteGridSameHeightForBothGroups =
      out.panelEmoteCommonGridHeightPx !== null &&
      Math.abs(out.panelEmoteCommonGridHeightPx - out.panelEmoteBigGridHeightPx) < 0.6;
    // ---- 用户报的那条：表情**溢出了格子边框**。改前实测（WebKit，360×844，通用组）：
    //      格子 47.6 × 32，图 80.7 × 24.2 → 右边越出格子 33.1px。
    //      改后：图必须完整落在格子里（溢出 0），且宽高由 CSS 显式给出（「object-fit: contain」）。
    out.panelEmoteMetrics = commonMetrics.slice(0, 3).map(function (m) {
      return { cellW: m.cellW, cellH: m.cellH, imgW: m.imgW, imgH: m.imgH };
    });
    out.panelEmoteOverflowPx = Math.max.apply(null, allMetrics.map(function (m) { return m.overflow; }));
    out.panelEmoteFitsCell = allMetrics.length > 0 && allMetrics.every(function (m) {
      return m.overflow === 0;
    });
    out.panelEmoteImgExplicitBox = allMetrics.length > 0 && allMetrics.every(function (m) {
      return m.explicit;
    });
    // 窄屏 360 下不许横向溢出：面板 / 轨道 / 网格三块都不许出现横向滚动
    out.panelNoHorizontalOverflow = (function () {
      var parts = [byTestId("db-panel"), rail, byTestId("db-emote-group")];
      return parts.every(function (el) {
        return !!el && el.scrollWidth <= el.clientWidth + 1;
      });
    })();

    // ---- 无权限的表情：置灰、但不隐藏、不禁用（用户 #6；契约 §5 Emote.locked）
    // 真实载荷里 locked 的那一组是**粉丝牌**（「UP主大表情」：17 条 「perm」 全为 0），
    // 对照组用「本房间」那 10 条（「perm = 1」）——两族都是 162×162 的大表情，比尺寸才公平。
    var medalGroup = EMOTES.live.filter(function (e) { return e.package_kind === "medal"; });
    var medalText = medalGroup[0].text;
    var medalUnique = medalGroup[0].emoticon_unique;
    var lockedImgH = null;
    var lockedCount = 0;
    var medalTab = tabOf("medal");
    if (medalTab) {
      medalTab.click();
      await sleep(300);
      var lockedItems = [].slice.call(byTestId("db-panel")
        .querySelectorAll('[data-testid="db-emote-item"][data-locked="true"]'));
      lockedCount = lockedItems.length;
      out.panelLockedEmoteListed = lockedItems.length === 17;
      out.panelLockedEmoteDimmed = lockedItems.length > 0 && lockedItems.every(function (el) {
        var cs = getComputedStyle(el);
        return parseFloat(cs.opacity) < 0.8 && cs.filter.indexOf("grayscale") >= 0;
      });
      // 尺寸要在**这一组还挂在文档里**的时候量：切走之后 React 会把它们卸载，脱链元素的 rect 全是 0
      lockedImgH = lockedItems.length > 0 ? rect(lockedItems[0].querySelector("img")).height : null;
      // 置灰是提示不是闸门：照样点得动、照样**直接发出去**（真正拦的是上游发送侧）。
      // 判据取 chat_send 的载荷：emoticon_unique 就是点中的那一个。
      lockedItems[0].click();
      await sleep(350);
      var lockedSends = callsWithArgs.filter(function (c) { return c.cmd === "chat_send"; });
      var lockedSend = lockedSends[lockedSends.length - 1];
      var stillMedal = medalTab.getAttribute("aria-selected") === "true";
      out.panelLockedEmoteSelectable = !!lockedSend && !!lockedSend.args.emote &&
        lockedSend.args.emote.emoticon_unique === medalUnique &&
        lockedSend.args.content === medalText && stillMedal &&
        document.querySelector("textarea").value === "";
    }
    // 对照：可用的那一组（本房间 10 条 「perm = 1」）不灰、尺寸与灰的那组一样
    // （「字段缺失的 perm 视为可用」那一条由 「crates/danmubox-bili/src/emote.rs」 的单测覆盖，
    //  界面这一侧只消费 「locked」 布尔值）。
    if (roomTab) {
      roomTab.click();
      await sleep(300);
      var freeItems = [].slice.call(byTestId("db-panel")
        .querySelectorAll('[data-testid="db-emote-item"][data-locked="false"]'));
      out.panelUnlockedEmoteNotDimmed = freeItems.length === 10 && freeItems.every(function (el) {
        return parseFloat(getComputedStyle(el).opacity) >= 0.99;
      });
      out.panelLockedEmoteSameSize = lockedCount > 0 && lockedImgH !== null && freeItems.length > 0 &&
        Math.abs(lockedImgH - rect(freeItems[0].querySelector("img")).height) < 0.6;
      if (tabOf("common")) {
        tabOf("common").click();
        await sleep(200);
      }
    }
    // 面板还开着就先把快照写进去、并多停 1.5s：跑脚本的进程据此抓一张「面板已展开」的截图
    snap();
    await sleep(1500);
    // 面板在**两个视口**都是文档流里的一块（不是浮层）——「只挤列表、不遮最新一条」
    // 由上面的 layoutOnlyChatShrank / layoutNewestNotCovered 按同一口径断言。
    out.panelInline = getComputedStyle(panel).position !== "fixed";

    // ---- 切 tab **不许**把面板关掉（用户 2026-09-13 报的真 bug：「展开表情包面板后切换 tab，
    //      面板就自动关闭了」）。这是本批新增的「点输入区外面收起面板」监听把它自己踩了：
    //      面板与输入区是**兄弟**节点，只判输入区就会把面板内部的按下当成外面。
    //      复现必须补一次真实的「pointerdown」—— 「.click()」只发 click 事件、绕过那条监听，
    //      这正是它当初没被测出来的原因（真鼠标点 tab 一定先有 pointerdown）。
    // ⚠ 抬起（pointerup）这一步**不能省**：只发 pointerdown 不是「按了一下」，是「按住不放」。
    //    面板里那三处按下（tab 轨道 / 表情格）与弹幕列表都落在共享分区 .paneDanmaku 里，
    //    于是 SplitPanes 的「长按 0.5s 换位」计时器被真的挂上：500ms 后它照常触发 —— 那一栏
    //    进入换位拖拽态、document.body.userSelect 被置成 none，并在 window 上挂一个**吞掉
    //    下一次 click** 的捕获监听器（600ms 兜底才摘）。实测代价：pressedOnly(弹幕列表) 之后
    //    约 800ms 那一次 pressLike(通用 tab) 被它吞掉 —— 面板仍停在上一个分组，
    //    panelBackOnCommon 因此长期为假（点的是「通用」，量到的还是「本房间」）。
    //    真实用户的手势一定是「按下 + 抬起」，所以这里按 immTap 那条口径补齐抬起。
    var pressLike = function (el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      el.click();
    };
    var pressedOnly = function (el) {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    };
    var selectedKind = function () {
      var hit = [].slice.call(byTestId("db-panel").querySelectorAll('[data-testid="db-emote-tab"]'))
        .filter(function (b) { return b.getAttribute("aria-selected") === "true"; })[0];
      return hit ? hit.getAttribute("data-kind") : null;
    };
    // ① 切 tab：面板还在，且选中的那一组确实换了（两条一起判，缺一条都可能是假通过）
    var tabBefore = selectedKind();
    var tabTarget = tabOf(tabBefore === "room" ? "medal" : "room");
    var targetKind = tabTarget.getAttribute("data-kind");
    pressLike(tabTarget);
    await sleep(350);
    out.panelSurvivesTabSwitch = !!byTestId("db-panel") &&
      !!document.getElementById("db-emote-panel") &&
      selectedKind() === targetKind && targetKind !== tabBefore;
    // ② 面板内部**其它**按下（滚 tab 轨道、按表情格）也不关
    pressedOnly(byTestId("db-emote-tabs"));
    var emotePanelEl = document.getElementById("db-emote-panel");
    var firstCell = emotePanelEl
      ? emotePanelEl.querySelector('[data-testid="db-emote-item"]') : null;
    if (firstCell) pressedOnly(firstCell);
    await sleep(250);
    out.panelStaysOnInsidePress = !!byTestId("db-panel") && selectedKind() === targetKind;
    // ③ 点输入区**外面**（弹幕列表）仍然关 —— 收窄的是「哪里算外面」，不是「还能不能关」
    pressedOnly(byTestId("db-chat-scroll"));
    await sleep(350);
    out.panelClosesOnChatPress = !byTestId("db-panel");
    clickTool("表情");
    await sleep(450);
    out.panelReopensAfterOutsidePress = !!byTestId("db-panel") &&
      selectedKind() === targetKind;
    // 复原到「通用」组：后面的表情格度量与它前面的口径一致
    var kindsNow = function () {
      var p = byTestId("db-panel");
      return p ? [].slice.call(p.querySelectorAll('[data-testid="db-emote-tab"]')).map(function (b) {
        return b.getAttribute("data-kind") + ":" + b.getAttribute("aria-selected");
      }) : null;
    };
    var commonTab = tabOf("common");
    out.panelBackOnCommonDiag = {
      commonTab: !!commonTab,
      kindsBefore: kindsNow(),
      selectedBefore: byTestId("db-panel") ? selectedKind() : "panel-gone",
      clicked: !!commonTab,
    };
    if (commonTab) pressLike(commonTab);
    await sleep(300);
    // 面板还在不在、还有哪些组、选中的是哪个 —— 快照里只留一个布尔的话，
    // 「组没了」「面板被关了」「点了没生效」三种情形长得一模一样。
    var panelAfterCommon = byTestId("db-panel");
    out.panelBackOnCommonDiag.kindsAfter = kindsNow();
    out.panelBackOnCommonDiag.selectedAfter = panelAfterCommon ? selectedKind() : "panel-gone";
    out.panelBackOnCommonDiag.emptyText = panelAfterCommon &&
      panelAfterCommon.querySelector('[class*="empty"]')
      ? panelAfterCommon.querySelector('[class*="empty"]').innerText.trim() : null;
    // 面板不在了（被谁关了）也是这条断言不成立的一种，不能让 selectedKind() 抛出去
    // （抛出去就是场景当场死掉，见 admin 那一段的教训）。
    out.panelBackOnCommon = !!panelAfterCommon && selectedKind() === "common";

    clickTool("表情");
    await sleep(300);

    // ---- 面板展开 → 收起一轮之后，「跟随最新」必须还活着
    // 修复前：收起面板会让容器变高、可滚区间变大，onScroll 只看几何就把 following 判成 false，
    // 于是列表停在半路、最新一条被推出视口，界面上只剩「回到最新」按钮在提示。
    // 判据取两条：几何上仍贴底（bottomGap < 8），且 UI 自己说的状态按钮不出现
    // （db-bottom-anchor 只在 !following 时渲染，是 following 的对外可观察面）。
    out.layoutFollowingAfterPanelToggle = bottomGap(byTestId("db-chat-scroll")) < 8;
    out.layoutNoJumpButtonAfterPanelToggle = !byTestId("db-bottom-anchor");
    // 面板收起后，列表下面是输入区：同一口径再量一次（末行底边 ↔ 输入区顶边 == 容器下内边距）
    var afterCloseScroller = byTestId("db-chat-scroll");
    var afterCloseBox = rect(afterCloseScroller);
    var afterCloseRows = rows().filter(function (r) {
      var box = rect(r);
      return box.bottom <= afterCloseBox.bottom + 1 && box.top >= afterCloseBox.top - 1;
    });
    var afterCloseLast = afterCloseRows[afterCloseRows.length - 1] || null;
    // 与上面那条同一支尺子（见那处的说明）：面板收起后列表下面这一档，量的仍是
    // 「末行 ↔ **滚动容器**底边 = 内边距」。输入区顶边那一份（旧口径）留在快照里做对照 ——
    // 它与新的容器底边之间正好差着折叠头 + 分割条（实测 42.8 − 8.1 ≈ 34.7）。
    out.layoutNewestGapComposerPx = afterCloseLast
      ? Math.round((rect(document.querySelector("textarea").parentElement).top -
          rect(afterCloseLast).bottom) * 10) / 10
      : null;
    out.layoutNewestGapNoPanelPx = afterCloseLast
      ? Math.round((rect(afterCloseScroller).bottom - rect(afterCloseLast).bottom) * 10) / 10
      : null;
    out.layoutNewestGapIsPaddingNoPanel = out.layoutNewestGapNoPanelPx !== null &&
      Math.abs(out.layoutNewestGapNoPanelPx - out.layoutScrollerPaddingBottomPx) <= 1;

    // ---- 面板形态（窄屏）：限高（视口份额）+ 内容超出时**面板内部**滚动 + 关闭入口 + 热区 ≥ 40px，
    //      同时列表仍要剩下可观的高度（不遮最新一条，也不把列表挤成一条缝）
    if (NARROW) {
      clickTool("表情");
      await sleep(400);
      var narrowPanel = byTestId("db-panel");
      var narrowPanelRect = rect(narrowPanel);
      var narrowScrollerRect = rect(byTestId("db-chat-scroll"));
      var narrowNewest = rows()[rows().length - 1];
      put("panelInFlow", getComputedStyle(narrowPanel).position !== "fixed");
      put("panelHeightPx", Math.round(narrowPanelRect.height));
      put("panelCappedToViewportShare", narrowPanelRect.height <= window.innerHeight * 0.5 + 1);
      // 会滚的是**面板内部的那一块**（表情格）：面板整体不滚，所以面板头与分组 tab 常驻。
      // 这个字段的意思没变——「内容超出在面板内部滚动，不去吃列表空间」——只是换了量哪个元素。
      var narrowGrid = byTestId("db-emote-group");
      put("panelScrollsInternally", !!narrowGrid &&
        getComputedStyle(narrowGrid).overflowY === "auto" &&
        narrowGrid.scrollHeight > narrowGrid.clientHeight + 1);
      // 分组 tab 不许被表情格滚走（用户 #6：tab 是切组的唯一入口）
      var tabsBoxBefore = rect(byTestId("db-emote-tabs"));
      if (narrowGrid) {
        narrowGrid.scrollTop = narrowGrid.scrollHeight;
        await sleep(250);
      }
      var tabsBoxAfter = rect(byTestId("db-emote-tabs"));
      put("panelTabsStayVisible", !!tabsBoxBefore && !!tabsBoxAfter &&
        Math.abs(tabsBoxAfter.top - tabsBoxBefore.top) < 1 &&
        tabsBoxAfter.top >= narrowPanelRect.top - 1 &&
        tabsBoxAfter.bottom <= narrowPanelRect.bottom + 1);
      if (narrowGrid) {
        narrowGrid.scrollTop = 0;
        await sleep(150);
      }
      put("panelListStillTall", narrowScrollerRect.height >= 240);
      put("panelListHeightPx", Math.round(narrowScrollerRect.height));
      put("panelRowHeightPx", rows().length > 1
        ? Math.round((rect(rows()[1]).top - rect(rows()[0]).top) * 10) / 10
        : null);
      put("panelNewestNotCovered", !!narrowNewest &&
        rect(narrowNewest).bottom <= narrowPanelRect.top + 1);
      var narrowHotspots = shortHotspots(narrowPanel);
      put("panelHotspotsBad", narrowHotspots);
      put("panelHotspotsAtLeast40", narrowHotspots.length === 0);
      // 关面板的两条路（用户 2026-09-12：顶上不再有「关闭」）：① 再点一次「表情」；
      // ② 点输入区**外面**的任何地方（Composer 的 pointerdown 监听）。
      clickTool("表情");
      await sleep(300);
      put("panelClosesOnToolToggle", !byTestId("db-panel"));
      clickTool("表情");
      await sleep(300);
      put("panelReopenWorks", !!byTestId("db-panel"));
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
      put("panelClosesOnOutsideClick", !byTestId("db-panel"));
    }

    // ---- 发送失败 = **浮动提示**（用户 2026-09-12：「发送失败也不要在最下出提示，弹窗提示
    //      然后渐隐消失（这个过程不要挡住滚动的弹幕）即可」）。四条一起量：
    //      ① 最下方**没有**常驻提示行；② 浮片在且 pointer-events 为 none（弹幕照常滚、照常点）；
    //      ③ 浮片的矩形与弹幕列表区域**不相交**（这才是「不挡弹幕」的可验形式）；
    //      ④ 渐隐之后元素被摘掉（不是「透明地占着位置」）。
    window.__setSendOutcome("failed", "上游拒绝：弹幕被吞");
    // 回执先**扣住**：这一步要看的正是「上游还没回的」那一瞬间 —— 那条行此时必须与已确认行
    // 一模一样（无标记、无弱化），失败标记只允许在回执明确说没发出去之后才出现。
    window.__holdSend();
    typeIntoArea(document.querySelector("textarea"), "这条会发失败");
    await sleep(250);
    var sendButton = [].slice.call(byTestId("db-composer-tools").querySelectorAll("button"))
      .filter(function (b) { return b.innerText.trim() === "发送"; })[0];
    if (sendButton) sendButton.click();
    await sleep(250);
    var heldFailRow = rowWith("这条会发失败");
    out.sendFailRowNoMarkBeforeOutcome = !!heldFailRow &&
      !heldFailRow.querySelector('[data-testid="db-msg-send-state"]');
    // 用户 2026-09-13：「发出去就是和已发送一样的状态」—— 回执没回之前那一行不许有任何弱化
    // （被删掉的那档弱化是 opacity: .6，这里逐位钉回 1）。
    out.sendFailRowNoFadeBeforeOutcome = !!heldFailRow &&
      getComputedStyle(heldFailRow).opacity === "1";
    window.__releaseSend();
    await sleep(500);
    var toastEl = byTestId("db-toast");
    var toastBox = rect(toastEl);
    var chatBoxForToast = rect(byTestId("db-chat-scroll"));
    out.sendFailNoBottomHint = !byTestId("db-send-hint");
    out.sendFailToastShown = !!toastEl && toastEl.innerText.indexOf("发送失败") >= 0;
    out.sendFailToastText = toastEl ? toastEl.innerText : null;
    out.sendFailToastPassive = !!toastEl &&
      getComputedStyle(toastEl).pointerEvents === "none";
    out.sendFailToastClearsList = !!toastEl && !!chatBoxForToast &&
      !(toastBox.bottom > chatBoxForToast.top + 1 && toastBox.top < chatBoxForToast.bottom - 1 &&
        toastBox.right > chatBoxForToast.left + 1 && toastBox.left < chatBoxForToast.right - 1);
    out.sendFailToastAboveComposer = !!toastEl &&
      toastBox.bottom <= rect(document.querySelector("textarea")).top + 1;
    // 失败修正（用户 2026-09-13）：上游说没发出去时，**那一条本地行**要就地标成失败，
    // 而既有的浮动提示一并保留（提示是用户此前明确要求的，不许为了加行标记把它删掉）。
    var failRow = rowWith("这条会发失败");
    var failMark = failRow
      ? failRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    // 被拒的那条**留在列表里**（用户 2026-09-13：「那行消失我希望能得到保留，划线并标注一下被 ban
    // 的原因，便于我对照修改」），行尾那枚标记写的是**原因**（与浮片同一句，见 sendOutcomeText）。
    out.sendFailRowMarked = !!failMark &&
      failMark.getAttribute("data-state") === "rejected" &&
      failMark.innerText.indexOf("上游拒绝：弹幕被吞") >= 0;
    out.sendFailRowReason = failMark ? failMark.innerText : null;
    // 行上那句话与浮片上那句话**必须逐字相同**：两处说的是同一件事，不许各自表述。
    out.sendFailRowReasonMatchesToast = !!failMark && !!toastEl &&
      failMark.innerText === toastEl.innerText;
    // 正文划线（.rejectedText 的 line-through）：这是「对照着改」的锚点。
    var failBody = failRow ? failRow.querySelector('[data-testid="db-msg-body"] span') : null;
    out.sendFailRowStruckThrough = !!failBody &&
      getComputedStyle(failBody).textDecorationLine.indexOf("line-through") >= 0;
    // 但整行**不弱化**：划掉的是那条弹幕，不是「把整行淡化到看不清」。
    out.sendFailRowNotFaded = !!failRow && getComputedStyle(failRow).opacity === "1";
    // 被拒的那条**只有一条**：标被拒不是「再插一条」。
    out.sendFailRowSingle = rows().filter(function (r) {
      return r.innerText.indexOf("这条会发失败") >= 0;
    }).length === 1;
    out.sendFailRowMarkedWithToast = out.sendFailRowMarked && out.sendFailToastShown === true;
    // 草稿留着：被拒之后要能照着行上划掉的正文 + 原因自己改一条再发（用户 2026-09-13：
    // 「便于我对照修改」）—— 发出去（outcome 为 ok）才清空。
    out.sendFailKeepsDraft = document.querySelector("textarea").value === "这条会发失败";
    // **被吞写明理由**（用户 2026-09-13：「被吞写明理由，如 发送失败 · 全局屏蔽词 /
    //  发送失败 · 房间屏蔽词」）：两档各发一条，行尾标记必须把那句话写出来
    // （上游只给 f / k 一个标记，「是哪一份词库」由界面说清）。
    // 放在草稿那条断言**之后**：这两次发送会把草稿清空，插在前面会把上面那条弄红。
    window.__setSendOutcome("blocked_platform", "msg=f");
    typeIntoArea(document.querySelector("textarea"), "被平台吞的样本");
    await sleep(200);
    sendButton.click();
    await sleep(400);
    var blockedRow = rowWith("被平台吞的样本");
    var blockedMark = blockedRow
      ? blockedRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.blockedRowNamesGlobalWords = !!blockedMark &&
      blockedMark.innerText.indexOf("发送失败 · 全局屏蔽词") >= 0;
    window.__setSendOutcome("blocked_room", "msg=k");
    typeIntoArea(document.querySelector("textarea"), "被房间吞的样本");
    await sleep(200);
    sendButton.click();
    await sleep(400);
    var roomBlockedRow = rowWith("被房间吞的样本");
    var roomBlockedMark = roomBlockedRow
      ? roomBlockedRow.querySelector('[data-testid="db-msg-send-state"]') : null;
    out.blockedRowNamesRoomWords = !!roomBlockedMark &&
      roomBlockedMark.innerText.indexOf("发送失败 · 房间屏蔽词") >= 0;
    typeIntoArea(document.querySelector("textarea"), "");
    window.__setSendOutcome("ok", null);
    await sleep(200);
    snap();
    await sleep(3200);
    out.sendFailToastGone = !byTestId("db-toast");
    typeIntoArea(document.querySelector("textarea"), "");
    window.__setSendOutcome("ok", null);
    await sleep(200);
    snap();

    // ---- 乐观渲染 + 回执校验（用户 2026-09-13：「发送应该即刻响应，上游只校验发送成功与否，
    //      无论成功与否我都是发了；失败再修正弹幕状态」；同一天再更正：「我不需要发送中这个状态，
    //      发出去就是和已发送一样的状态，上游返回的数据只做校验」）。四步各自取证：
    //      ① 点击后**本地那条立刻在列表里**（量「点击 → 行出现」的毫秒数；改前要等上游回推 ≈1.36s）；
    //      ② 这条行与**已确认行渲染逐项相同** —— 不透明度 / 行、昵称、正文的字色 / 字号逐项相等，
    //         且两边都没有修正标记（本次要钉的契约：不许有「发送中」那类待确认视觉）；
    //      ③ 上游把自己那条回推回来 → 本地那条**转正**：仍然只有一条，且各项与普通行无差别；
    //      ④ 「转正」是**换掉**不是「再插一条」——总量也不许多出来。
    // 对照行：先显式推一条**上游来的、本人的**弹幕（uid 与本地行相同、走的是同一条渲染路径），
    // 它就是「已确认行」的样本；下面拿它与点击后插进来的那条逐项比对。
    var confirmedText = "已确认对照行";
    window.__emit("danmubox://message", window.__mk("danmaku", confirmedText, false, {
      uid: 1000, uname: "本地测试"
    }));
    await sleep(300);
    var optimisticText = "乐观渲染样本弹幕";
    var optimisticRow = function () { return rowWith(optimisticText); };
    var optimisticRowCount = function () {
      return rows().filter(function (r) { return r.innerText.indexOf(optimisticText) >= 0; }).length;
    };
    typeIntoArea(document.querySelector("textarea"), optimisticText);
    await sleep(200);
    var optimisticT0 = performance.now();
    sendButton.click();
    var optimisticAppearMs = null;
    for (var optimisticTry = 0; optimisticTry < 60 && optimisticAppearMs === null; optimisticTry += 1) {
      if (optimisticRow()) optimisticAppearMs = performance.now() - optimisticT0;
      else await sleep(8);
    }
    out.sendOptimisticAppearMs = optimisticAppearMs === null
      ? null : Math.round(optimisticAppearMs * 10) / 10;
    // 「立刻」的判据取 250ms 这个宽松档（含一帧渲染 + WebKit 的抖动）：改前实测是 1820ms，
    // 两者差一个数量级，所以这个阈值能拦住「又回去等上游回播」的退步。
    out.sendOptimisticAppearsImmediately = optimisticAppearMs !== null && optimisticAppearMs <= 250;
    // **按正文数行**，不按渲染行数：虚拟列表的渲染窗口是定长的（可视 + overscan），
    // 在末尾插一行时「渲染出来的行数」可能一个都不变（窗口上沿丢一行、下沿进一行），
    // 拿它当「插了几条」的判据会假失败。
    out.sendOptimisticRowsBeforeEcho = optimisticRowCount();
    out.sendOptimisticSingleRow = optimisticRowCount() === 1;
    var optimisticEl = optimisticRow();
    // 「与已确认行渲染逐项相同」的可验形式：取**同一组计算样式**逐项比对，并各自确认
    // 没有修正标记。两条都是本人（uid 1000）的 danmaku 行（同 kind、同身份来源），
    // 这一组值本就该等价；任何「待确认」弱化（不透明度 / 字色 / 字号）或标记都会当场露出来。
    var lookOf = function (el) {
      if (!el) return null;
      var nameEl = el.querySelector('[data-testid="db-msg-name"]');
      var bodyEl = el.querySelector('[data-testid="db-msg-body"]');
      var rowStyle = getComputedStyle(el);
      return {
        opacity: rowStyle.opacity,
        color: rowStyle.color,
        fontSize: rowStyle.fontSize,
        nameColor: nameEl ? getComputedStyle(nameEl).color : null,
        bodyColor: bodyEl ? getComputedStyle(bodyEl).color : null,
        hasState: !!el.querySelector('[data-testid="db-msg-send-state"]')
      };
    };
    out.sendOptimisticLook = lookOf(optimisticEl);
    out.sendOptimisticConfirmedLook = lookOf(rowWith(confirmedText));
    out.sendOptimisticRendersLikeConfirmed = !!optimisticEl &&
      out.sendOptimisticConfirmedLook !== null &&
      JSON.stringify(out.sendOptimisticLook) === JSON.stringify(out.sendOptimisticConfirmedLook) &&
      out.sendOptimisticLook.hasState === false;
    // **第一帧就带头像**（用户 2026-09-13：「含身份牌 / 等级 / 头像 / 表情 / 间距等上游行会显示的
    // 一切」）：插入的那一行必须已经有头像图。改前它不带 face，头像要等回播换上来才出现 ——
    // 那就是用户看见的那次「修正」。（这里只钉「有头像」，不比 URL：那份 URL 属于当前账号。）
    var optimisticAvatar = optimisticEl
      ? optimisticEl.querySelector('[data-testid="db-msg-avatar"]') : null;
    out.sendOptimisticHasFace = !!optimisticAvatar &&
      (optimisticAvatar.getAttribute("src") || "").length > 0;
    // 停下让跑脚本的进程抓一张截图：同一屏里上下两条（刚发的 + 已确认的）外观应当一致，
    // 这张图就是「两者无法区分」的证据（它每 250ms 读一次 data-smoke）。
    out.sendOptimisticShown = out.sendOptimisticRendersLikeConfirmed;
    snap();
    await sleep(700);
    // 上游把自己那条回播回来（uid 与正文对得上，见 store.matchPending 的对账规则）。
    // **故意带一张不同的头像**：本地行插入时的头像取自当前账号（Account.face，取自 nav），回播那条带的是
    // 上游权威值 —— 换进来才算「我用别的客户端看到的样子」。真机上两者是同一张图（都是我的头像），
    // 所以看不出变化；这里用一张不同的，证明字段确实换进来了（而不是被忽略）。
    var echoFace =
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><rect width='32' height='32' fill='%23e05b7a'/></svg>";
    window.__emit("danmubox://message", window.__mk("danmaku", optimisticText, false, {
      uid: 1000, uname: "本地测试", face: echoFace
    }));
    await sleep(300);
    var convertedRow = optimisticRow();
    out.sendOptimisticRowsAfterEcho = optimisticRowCount();
    out.sendOptimisticEchoSingleRow = optimisticRowCount() === 1;
    // 「看不出有回播」的可验形式（用户 2026-09-13：「那个时候根本看不出来有回播，只知道如果被 ban 了
    // 那个弹幕会消失然后弹个提示」），分三件量：
    // ① **同一个 DOM 节点**：回播前取的句柄 === 回播后按正文重新查到的那个（节点没被重建）；
    // ② **样式逐项不变**：lookOf 快照与回播前那一次相等（不是「与对照行相同」）；
    // ③ **字段换成上游的**：头像 src 变成回播那条给的那张。
    // ①②保证「不重建、不闪」，③保证「以上游为准」—— 两件事必须同时成立，缺一个都不算对。
    out.sendOptimisticEchoSameNode = !!optimisticEl && optimisticEl === convertedRow &&
      optimisticEl.isConnected === true;
    out.sendOptimisticEchoLookUnchanged = !!convertedRow &&
      JSON.stringify(lookOf(convertedRow)) === JSON.stringify(out.sendOptimisticLook);
    var echoAvatar = convertedRow
      ? convertedRow.querySelector('[data-testid="db-msg-avatar"]') : null;
    out.sendOptimisticEchoAdoptsFace = !!echoAvatar &&
      echoAvatar.getAttribute("src") === echoFace;
    // 回播后：状态标记没了（这条已经是上游的事实），昵称/正文以远端那条为准。
    out.sendOptimisticEchoConverted = !!convertedRow &&
      !convertedRow.querySelector('[data-testid="db-msg-send-state"]') &&
      convertedRow.innerText.indexOf("本地测试") >= 0;
    // 本地那一条**留在原位**而不是又插一条：同一正文的行数回播前后都是 1（不是 2），
    // 而且它身上不再挂标记（字段已经换成上游那条）。
    out.sendOptimisticEchoAbsorbedLocal = optimisticRowCount() === 1 && !!convertedRow &&
      !convertedRow.querySelector('[data-testid="db-msg-send-state"]');
    // 换过字段的那条与**已确认行**同样逐项相同（它现在就是上游那条的字段 + 本地那个 key）。
    var echoLook = lookOf(convertedRow);
    var confirmedLookAfterEcho = lookOf(rowWith(confirmedText));
    out.sendOptimisticEchoRendersLikeConfirmed = !!echoLook && !!confirmedLookAfterEcho &&
      JSON.stringify(echoLook) === JSON.stringify(confirmedLookAfterEcho);
    typeIntoArea(document.querySelector("textarea"), "");
    snap();

    // ---- 粉丝牌只在**佩戴着 / 亮着**时才画（用户 2026-09-13：「还是有区别，刚发出去会有一个
    //      1级本直播间粉丝牌，但是不应该有才对」）。官方判据（2026-09-13 读官方前端产物取证）：
    //      弹幕侧看 medal.is_light（官方分支 if (F?.is_lighted) { 追加粉丝牌 }），
    //      身份侧看 data.medal.is_weared —— **持有 ≠ 佩戴**，没戴就不画。
    // 这块整体包一层：里面一次发送 / 一次身份事件出岔子时要**让断言红**，而不是把整个场景
    // 卡到 300s（那样只能看到「未跑完」这一句、定位不到原因）。异常文本一并进快照。
    var medalBlockOk = false;
    try {
    //      ① 上游行：同一正文、同一牌名，只差 medal_lit 一个布尔，看画不画。
    window.__emit("danmubox://message", window.__mk("danmaku", "没点亮的牌样本", false, {
      uname: "灰牌观众", medal_level: 7, medal_name: "本房间牌", medal_lit: false
    }));
    window.__emit("danmubox://message", window.__mk("danmaku", "亮着的牌样本", false, {
      uname: "亮牌观众", medal_level: 7, medal_name: "本房间牌", medal_lit: true
    }));
    await sleep(300);
    var unlitRow = rowWith("没点亮的牌样本");
    var litRow = rowWith("亮着的牌样本");
    out.medalHiddenWhenNotLit = !!unlitRow &&
      !unlitRow.querySelector('[data-testid="db-msg-badges"]');
    out.medalShownWhenLit = !!litRow &&
      !!litRow.querySelector('[data-testid="db-msg-badges"]') &&
      litRow.innerText.indexOf("本房间牌") >= 0;
    //      ② 本地乐观行：身份说「持有 Lv1 但没佩戴」→ 一行里**不许**出现牌；
    //         改成「佩戴」后同一条路径必须画出来（正面对照，防止过滤过头）。
    window.__setSendOutcome("ok", null);
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 1, my_medal_name: "本房间牌",
      my_medal_worn: false, my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(200);
    typeIntoArea(document.querySelector("textarea"), "持有但没戴牌");
    await sleep(150);
    sendButton.click();
    await sleep(250);
    var unwornLocal = rowWith("持有但没戴牌");
    out.sendLocalHidesUnwornMedal = !!unwornLocal &&
      !unwornLocal.querySelector('[data-testid="db-msg-badges"]');
    typeIntoArea(document.querySelector("textarea"), "");
    window.__emit("danmubox://session", {
      room_id: 5440, my_medal_level: 1, my_medal_name: "本房间牌",
      my_medal_worn: true, my_guard_level: 0, danmaku_length: 40, is_admin: false
    });
    await sleep(200);
    typeIntoArea(document.querySelector("textarea"), "戴着牌发的");
    await sleep(150);
    sendButton.click();
    await sleep(250);
    var wornLocal = rowWith("戴着牌发的");
    out.sendLocalShowsWornMedal = !!wornLocal &&
      !!wornLocal.querySelector('[data-testid="db-msg-badges"]') &&
      wornLocal.innerText.indexOf("本房间牌") >= 0;
    typeIntoArea(document.querySelector("textarea"), "");
      medalBlockOk = true;
    } catch (e) {
      out.medalBlockError = String((e && e.stack) || e);
    }
    out.medalBlockRan = medalBlockOk;
    snap();

    // ---- 弹幕聚合（issue 2609171849 第 7 条，docs/ui.md §8.4 第二条、契约 §4 的三条常量）：
    //      **不同观众**在短时间窗口里发的**同一条**弹幕折成一行 —— 正文行内「×N」（折了几条）
    //      紧跟一格「都是谁」（db-msg-senders）。三条读数：
    //      ① 同文本 + 两位不同观众 → **一行**、「×2」、名单里两位都在；
    //      ② **不同文本** → 两行（聚合只认同一个键）；
    //      ③ 同文本但**在窗口外**（5 秒）→ 两行（锚点是这一行的第一条，非滑动）。
    //      准入前提自己保证（testing.md §9.3 ②）：本段要求停在**房间页**、聊天流在场、且列表
    //      **跟随最新**（虚拟列表只渲染视口内的行，不跟随则新推的行根本不在 DOM 里）——
    //      不在底部就点一次「回到最新」，缺 db-msg-list 则当场报错红、不静默通过。
    //      读数一律**当场重查 DOM**（rows() / querySelector），因此归属于本次运行。
    //      注：整个场景活在模板串里，注释也**不许出现反引号**（会把模板提前收尾，见 TESTING.md §9.3）。
    var aggregateBlockRan = false;
    try {
      if (!byTestId("db-msg-list")) throw new Error("不在房间页：db-msg-list 不存在");
      var aggAnchor = byTestId("db-bottom-anchor");
      if (aggAnchor) {
        aggAnchor.click();
        await sleep(400);
      }
      var aggRowsOf = function (needle) {
        return rows().filter(function (r) { return r.innerText.indexOf(needle) >= 0; });
      };
      var aggCellOf = function (row, cell) {
        var el = row ? row.querySelector('[data-testid="' + cell + '"]') : null;
        return el ? el.innerText.trim() : null;
      };
      var aggPush = function (text, uid, uname, ts) {
        window.__emit("danmubox://message", window.__mk("danmaku", text, false, {
          uid: uid, uname: uname, ts: ts
        }));
      };
      // ① 两位不同观众、同一文本、相隔 100ms（窗口内）
      var aggT0 = Date.now();
      aggPush("聚合样本甲", 71001, "聚合一号", aggT0);
      aggPush("聚合样本甲", 71002, "聚合二号", aggT0 + 100);
      await sleep(400);
      var aggPair = aggRowsOf("聚合样本甲");
      out.aggregateSameTextRows = aggPair.length;
      out.aggregateSameTextCount = aggCellOf(aggPair[0], "db-msg-count");
      out.aggregateSameTextSenders = aggCellOf(aggPair[0], "db-msg-senders");
      out.aggregateSameText = aggPair.length === 1 &&
        out.aggregateSameTextCount === "×2" &&
        (out.aggregateSameTextSenders || "").indexOf("聚合一号") >= 0 &&
        (out.aggregateSameTextSenders || "").indexOf("聚合二号") >= 0;
      snap();
      // ② 不同文本：两条各占一行，且都不是聚合行（没有 ×N / 名单两格）
      aggPush("聚合样本乙", 71003, "聚合三号", Date.now());
      aggPush("聚合样本丙", 71004, "聚合四号", Date.now() + 50);
      await sleep(400);
      var aggB = aggRowsOf("聚合样本乙");
      var aggC = aggRowsOf("聚合样本丙");
      out.aggregateDifferentTextTwoRows =
        aggB.length === 1 && aggC.length === 1 &&
        aggCellOf(aggB[0], "db-msg-count") === null &&
        aggCellOf(aggC[0], "db-msg-senders") === null;
      // ③ 同文本、但第一条落在 60 秒前（远在 5 秒窗口之外）：不许折
      aggPush("聚合样本丁", 71005, "聚合五号", Date.now() - 60000);
      aggPush("聚合样本丁", 71006, "聚合六号", Date.now());
      await sleep(400);
      out.aggregateWindowSeparatesRows = aggRowsOf("聚合样本丁").length === 2;
      snap();
      aggregateBlockRan = true;
    } catch (e) {
      out.aggregateBlockError = String((e && e.stack) || e);
      snap();
    }
    out.aggregateBlockRan = aggregateBlockRan;

    // ---- 面板展开会改可视高度：**正在看的位置不能被弹走**
    // 先把列表停在中间（此时不在底部 = 非跟随模式），再展开面板，量同一个行在视口里的
    // 位置变化。跟随模式下重新贴底是**有意**的（见 MessageList 的 ResizeObserver），
    // 所以这里量的是「用户自己滚上去看历史」时的行为。
    var stableScroll = byTestId("db-chat-scroll");
    // 先等列表**静止**：进场行的自动摘除会少掉一行，上面少一行会把下面整体顶上去整整一行高
    // （实测 29px）——那是「自动消失」的既定行为，不是面板把视口弹走了。判据必须用
    // 「发出时刻 + 8s」这个时钟，**不能**用「列表里还在不在那一行」：列表这会儿滚在中间，
    // 那一行根本不在渲染窗口里，rowWith 看不见它，等它等于没等。
    var settleWait = (window.__interactAt || 0) + 8000 + 250 - Date.now();
    if (settleWait > 0) await sleep(settleWait);
    await sleep(400);
    stableScroll.scrollTop = Math.round((stableScroll.scrollHeight - stableScroll.clientHeight) * 0.55);
    await sleep(300);
    out.layoutPausedBeforePanel = stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight > 8;
    // 另一半：**用户自己往上滚**必须真的降为「不跟随」——判据同样是状态按钮出现
    out.layoutPausedShowsJumpButton = !!byTestId("db-bottom-anchor");
    // ---- item 1 + issue #2：「回到最新」那枚图标是**下箭头**，与房间头返回键**同源几何**
    //      （docs/ui.md §3.1 的矢量规范 + §7.4）：同一个 24 × 24 viewBox、同一条 stroke-width 1.75、
    //      round 线帽 / 接合、墨迹居中 (12,12)、主轴 16 单位；箭头朝下 ⇒ 宽 > 高。
    //      issue #2 之后它是一枚**圆形图标钮**（与返回键共用 .ctlRound / .ctlIcon）：可见文字
    //      一个都没有 ⇒ 可访问名只能由 aria-label / title 给（innerText 必须为空）。
    var anchorBtn = byTestId("db-bottom-anchor");
    var anchorSvg = anchorBtn ? anchorBtn.querySelector("svg") : null;
    out.jumpIconSvgShown = !!anchorSvg;
    out.jumpIconAriaHidden = !!anchorSvg && anchorSvg.getAttribute("aria-hidden") === "true";
    out.jumpButtonAccessibleName = anchorBtn ? (anchorBtn.getAttribute("aria-label") || "") : null;
    out.jumpButtonNamesPurpose = !!anchorBtn &&
      out.jumpButtonAccessibleName.indexOf("回到最新") >= 0 &&
      (anchorBtn.getAttribute("title") || "") === out.jumpButtonAccessibleName;
    out.jumpButtonHasNoText = !!anchorBtn && anchorBtn.innerText.trim() === "";
    // 与返回键**同尺寸**：控件都 40 × 40 正圆，图标盒都 24
    out.jumpControlSameSizeAsBack = !!anchorBtn && !!roundCtl[0] && !!anchorSvg &&
      !!out.iconBack &&
      Math.abs(rect(anchorBtn).width - rect(roundCtl[0]).width) < 0.6 &&
      Math.abs(rect(anchorBtn).width - 40) < 0.6 &&
      Math.abs(rect(anchorSvg).width - out.iconBack.boxPx) < 0.6;
    out.jumpIcon = iconGeomOf(anchorBtn);
    out.jumpIconInkCentered = !!out.jumpIcon &&
      Math.abs(out.jumpIcon.inkCenterX - 12) < 0.2 && Math.abs(out.jumpIcon.inkCenterY - 12) < 0.2;
    out.jumpIconSameViewBox = !!out.jumpIcon && out.jumpIcon.viewBox === "0 0 24 24";
    out.jumpIconBackArrowExtent = !!out.jumpIcon &&
      Math.abs(Math.max(out.jumpIcon.inkW, out.jumpIcon.inkH) - 16) < 0.2;
    out.jumpIconPointsDown = !!out.jumpIcon && out.jumpIcon.inkW > out.jumpIcon.inkH;
    // 与返回键量到的**同一套规范**逐项相同：描边宽度 / 线帽 / 接合 / 形状数（只有朝向不同）。
    // issue #2 之后两枚的渲染盒也一样（都 24），但描边仍比**用户单位**（SVG 里写死的数），
    // 缩放系数不算规范的一部分 —— 同一套规范因此不该被盒子的换算方式带偏。
    out.jumpIconStrokeUnits = out.jumpIcon
      ? Math.round((out.jumpIcon.inkThicknessPx / out.jumpIcon.scale) * 100) / 100
      : null;
    out.jumpIconSameStrokeAsBack = out.jumpIconStrokeUnits !== null &&
      Math.abs(out.jumpIconStrokeUnits - 1.75) < 0.01 && !!out.iconBack &&
      Math.abs(out.iconBack.inkThicknessPx / out.iconBack.scale - out.jumpIconStrokeUnits) < 0.01 &&
      out.jumpIcon.linecap === "round" && out.jumpIcon.linejoin === "round" &&
      out.jumpIcon.shapeCount === 1;
    var anchorRow = rows()[4];
    var anchorTopBefore = anchorRow ? Math.round(rect(anchorRow).top * 10) / 10 : null;
    clickTool("表情");
    await sleep(600);
    var anchorTopAfter = anchorRow && anchorRow.isConnected
      ? Math.round(rect(anchorRow).top * 10) / 10
      : null;
    out.layoutPanelScrollStablePx = anchorTopBefore !== null && anchorTopAfter !== null
      ? Math.round((anchorTopAfter - anchorTopBefore) * 10) / 10
      : null;
    out.layoutPanelScrollStable = out.layoutPausedBeforePanel &&
      out.layoutPanelScrollStablePx !== null && Math.abs(out.layoutPanelScrollStablePx) < 8;
    clickTool("表情");
    await sleep(200);
    // 还原成「跟随最新」，后面的断言依赖它
    stableScroll.scrollTop = stableScroll.scrollHeight;
    await sleep(500);
    out.layoutStabilityRestored =
      stableScroll.scrollHeight - stableScroll.scrollTop - stableScroll.clientHeight < 8;
    out.layoutJumpButtonGoneAfterRestore = !byTestId("db-bottom-anchor");

    // ---- emotes 主站「我的表情」：分组可见、选得到、发出去带的是唯一键（issue #8）
    out.emotesOwnedCalled = calls.indexOf("emotes_owned") >= 0;
    clickTool("表情");
    await sleep(400);
    var emotePanel = byTestId("db-panel");
    out.ownedGroupShown = !!emotePanel && emotePanel.innerText.indexOf("我的表情") >= 0;
    // tab 化之后「我的表情」不默认在场：先切过去，再找那一格
    var ownedTab = emotePanel
      ? [].slice.call(emotePanel.querySelectorAll('[data-testid="db-emote-tab"]')).filter(function (b) {
          return b.getAttribute("data-kind") === "owned";
        })[0]
      : null;
    if (ownedTab) {
      ownedTab.click();
      await sleep(300);
    }
    // 取哪一条：**从真实载荷里挑**（用户命名的那条自定义表情），不在断言里写死名字
    var ownedSample = EMOTES.owned.filter(function (e) { return e.text.indexOf("吃瓜") >= 0; })[0];
    var ownedPicker = byTestId("db-panel")
      ? byTestId("db-panel").querySelector('button[title="' + ownedSample.text + '"]')
      : null;
    out.ownedEmoteShown = !!ownedPicker;
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
    var dock = byTestId("db-gift-dock");
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
    // db-gift-dock 现在**就是**那枚折叠头按钮（issue #8），不再是「容器里装着一枚按钮」
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
      // 换行用 String.fromCharCode(10) 拼，**不写字面转义**：这一整段活在模板字符串里，
      // 反斜杠转义会先被模板吃掉（连注释里写一个都会变成真换行、把注释掰断）。
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
    var scLowSpec = GIFT_ROWS.filter(function (r) { return r.key === "superchat-low"; })[0].message;
    var scHighSpec = GIFT_ROWS.filter(function (r) { return r.key === "superchat-high"; })[0].message;
    var scLow = rowWith(scLowSpec.content);
    var scHigh = rowWith(scHighSpec.content);
    out.scCardTiers = [scLow, scHigh].map(function (r) {
      return r ? r.getAttribute("data-sc-tier") : null;
    });
    out.scCardTierByAmount = out.scCardTiers.join(",") === "1,4";
    // 边框色 = 那一档的令牌值（令牌真的被消费了，不是写死的色值）
    var scBorderColor = function (r) { return r ? getComputedStyle(r).borderTopColor : null; };
    out.scCardLowUsesTierToken = scBorderColor(scLow) === cssColorOf("--sc-1");
    out.scCardHighUsesTierToken = scBorderColor(scHigh) === cssColorOf("--sc-4");
    out.scCardTierTokensDistinct = cssColorOf("--sc-1") !== cssColorOf("--sc-4");
    var scLowStyle = scLow ? getComputedStyle(scLow) : null;
    out.scCardIsACard = !!scLowStyle && parseFloat(scLowStyle.borderTopWidth) >= 1 &&
      scLowStyle.borderTopStyle === "solid" &&
      parseFloat(scLowStyle.borderTopLeftRadius) >= 4 &&
      scLowStyle.backgroundColor !== getComputedStyle(document.body).backgroundColor;
    var scAmountEl = scLow ? scLow.querySelector('[data-testid="db-msg-sc-amount"]') : null;
    var scAmountStyle = scAmountEl ? getComputedStyle(scAmountEl) : null;
    var scBodyStyle = scLow
      ? getComputedStyle(scLow.querySelector('[data-testid="db-msg-body"]')) : null;
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
    var partOf = function (row, id) {
      return row ? row.querySelector('[data-testid="' + id + '"]') : null;
    };
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
    // ② 背景色：两栏底色同一（.paneGift 不再另刷 --bg-elevated），同一行的计算底色与边框也相同
    var paneGiftEl = byTestId("db-pane-gift");
    var paneDanmakuEl = byTestId("db-pane-danmaku");
    out.giftParityPaneBackground = !!paneGiftEl && !!paneDanmakuEl &&
      getComputedStyle(paneGiftEl).backgroundColor ===
      getComputedStyle(paneDanmakuEl).backgroundColor;
    out.giftParityPaneBackgroundColor = paneGiftEl
      ? getComputedStyle(paneGiftEl).backgroundColor : null;
    out.giftParityRowBackground = !!giftScRow && !!chatScRow &&
      getComputedStyle(giftScRow).backgroundColor ===
      getComputedStyle(chatScRow).backgroundColor &&
      getComputedStyle(giftScRow).borderTopColor === getComputedStyle(chatScRow).borderTopColor &&
      getComputedStyle(giftScRow).borderTopWidth === getComputedStyle(chatScRow).borderTopWidth;
    out.giftParityRowBackgroundColor = giftScRow
      ? getComputedStyle(giftScRow).backgroundColor : null;
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

    // ---- 两枚开关的四种组合（第 4 条）：每一次都顺带验「切开关不丢消息」（同一批数据只换渲染位置）。
    //      点开关之前必须先把**筛选面板**开回来：上一步展开礼物栏那一下按「五者互斥」把面板收掉了
    //      （不是 bug，是 §2.3 的口径）。反过来，开面板也会收起礼物栏 —— 两件事分开验，不混在一起。
    clickTool("筛选");
    await sleep(300);
    out.giftSwitchPanelOff = setGiftSwitch("独立礼物栏", false);
    await sleep(350);
    out.giftPanelOffHidesDock = !byTestId("db-gift-dock");
    out.giftPanelOffKeepsStream = !!rowWith("投喂 小心心") &&
      !!rowWith(scLowSpec.content);
    out.giftSwitchInDanmakuOff = setGiftSwitch("弹幕包含礼物", false);
    await sleep(350);
    out.giftBothOffHidesDock = !byTestId("db-gift-dock");
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
    out.giftPanelOnlyShowsDock = !!byTestId("db-gift-dock");
    out.giftPanelOnlyKeepsStreamOff = !rowWith("投喂 小心心");
    // db-gift-dock 在 issue #8 之后是**礼物栏的折叠头**（礼物栏那一栏的根是 db-pane-gift），
    // 它本身就是那枚按钮 —— 不再是「容器里有按钮」。
    byTestId("db-gift-dock").click();
    await sleep(350);
    out.giftPanelOnlyRendersAllRows = allByTestId("db-gift-row").length === 5;
    // 回到默认（两枚都开）：同样先开面板再点开关；开面板那一下已经把展开的礼物栏收起来了，
    // 因此这里不再点多一次（连点会把礼物栏又展开，下一段的「默认形态」就不是折叠态了）。
    // 后面几段（面板互斥 / 多标签）因此跑在**默认形态**上：筛选面板开着、礼物栏折叠着。
    clickTool("筛选");
    await sleep(300);
    out.giftSwitchBothBackOn = setGiftSwitch("弹幕包含礼物", true);
    await sleep(350);
    out.giftRestoredToDefault = !!byTestId("db-gift-dock") && !byTestId("db-gift-area") &&
      !!rowWith("投喂 小心心") && window.__prefs["ui.gift_in_danmaku"] === true &&
      window.__prefs["ui.gift_panel"] === true;
    snap();

    // ---- panel 层：短语右键增删改、点选插入到光标处、头部 ⋯ 菜单
    clickTool("筛选"); // 收起筛选面板，避免两个面板互相干扰
    out.toolsPhrasesOpen = clickTool("短语");
    await sleep(300);
    var phrasesPanel = byTestId("db-panel");
    out.phrasesPanelShown = !!phrasesPanel;
    // ---- item 8：短语面板与筛选 / 表情面板**同一副骨架** —— 顶上没有标题、没有关闭按钮，
    //      高度同源（--panel-h），首行就是「加一条」（见下面 phraseAddRow* 那几条）。
    out.phrasesPanelFirstRow = phrasesPanel && phrasesPanel.firstElementChild
      ? phrasesPanel.firstElementChild.getAttribute("data-testid") : null;
    out.phrasesPanelStartsAtAddRow = out.phrasesPanelFirstRow === "db-phrase-add";
    out.phrasesPanelCloseGone = !!phrasesPanel &&
      phrasesPanel.querySelectorAll('[data-testid="db-panel-close"]').length === 0;
    out.phrasesPanelHeightPx = phrasesPanel ? f1(rect(phrasesPanel).height) : null;
    // 三个面板展开高度**口径一致**（item 8：短语 / 筛选「展开高度看齐表情界面」）：
    // 表情那一份在上面量过（panelHeightPx），筛选那一份在时间戳那一步量过（filterPanelHeightPx）。
    out.panelHeightsMatch = out.panelHeightPx !== null && out.filterPanelHeightPx !== null &&
      out.phrasesPanelHeightPx !== null &&
      Math.abs(out.phrasesPanelHeightPx - out.panelHeightPx) < 1 &&
      Math.abs(out.filterPanelHeightPx - out.panelHeightPx) < 1;
    var phraseChip = buttonWith(phrasesPanel, "早上好");
    phraseChip.click();
    await sleep(200);
    out.phraseInsertsAtCaret = document.querySelector("textarea").value.indexOf("早上好") >= 0;
    phraseChip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
    await sleep(250);
    var phraseMenu = byTestId("db-context-menu");
    out.phraseMenuItems = phraseMenu ? [].slice.call(phraseMenu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    buttonWith(phraseMenu, "删除").click();
    await sleep(300);
    out.phraseDeleted = window.__prefs["composer.phrases"].length === 0 && !buttonWith(byTestId("db-panel"), "早上好");
    var phraseInput = [].slice.call(byTestId("db-panel").querySelectorAll("input")).filter(function (i) {
      return (i.placeholder || "").indexOf("新短语") >= 0;
    })[0];
    typeInto(phraseInput, "晚上好");
    await sleep(150);
    buttonWith(byTestId("db-panel"), "添加").click();
    await sleep(300);
    out.phraseAdded = window.__prefs["composer.phrases"].join(",") === "晚上好" && !!buttonWith(byTestId("db-panel"), "晚上好");

    // ---- 「加一条」是固定的一行：短语再多也顶不掉它，聊天输入框也还在（用户 #8）
    var phraseAddRow = byTestId("db-phrase-add");
    var phraseAddInput = phraseAddRow ? phraseAddRow.querySelector("input") : null;
    out.phraseAddRowShown = !!phraseAddInput;
    var addTopBefore = phraseAddInput ? Math.round(rect(phraseAddInput).top * 10) / 10 : null;
    var panelTopBefore = Math.round(rect(byTestId("db-panel")).top * 10) / 10;
    for (var extra = 0; extra < 5; extra += 1) {
      if (!phraseAddInput) break;
      typeInto(phraseAddInput, "追加短语" + extra);
      await sleep(120);
      buttonWith(byTestId("db-panel"), "添加").click();
      await sleep(220);
    }
    var addRowAfter = byTestId("db-phrase-add");
    var addInputAfter = addRowAfter ? addRowAfter.querySelector("input") : null;
    var panelBox = rect(byTestId("db-panel"));
    var addBox = rect(addInputAfter);
    var chatAreaEl = document.querySelector("textarea");
    var chatBox = rect(chatAreaEl);
    out.phraseAddRowY = addTopBefore;
    out.phraseAddRowYAfter = addInputAfter ? Math.round(addBox.top * 10) / 10 : null;
    // 判据是「相对面板顶的偏移不变」：窄屏下面板向上长，绝对位置本来就会跟着动
    out.phraseAddRowStaysPut = addTopBefore !== null && panelTopBefore !== null && !!addInputAfter &&
      Math.abs((addBox.top - panelBox.top) - (addTopBefore - panelTopBefore)) < 1;
    out.phraseAddRowInsidePanel = !!addInputAfter &&
      addBox.top >= panelBox.top - 1 && addBox.bottom <= panelBox.bottom + 1;
    out.phraseAddRowWideEnough = !!addInputAfter && addBox.width >= 120;
    // 聊天输入框：仍然完整落在视口里，且被面板**顶到下面**而不是被它盖住 / 挤没
    out.phraseChatInputStillVisible = chatBox.bottom <= window.innerHeight + 1 &&
      chatBox.height >= 38 && chatBox.top >= panelBox.bottom - 1;
    clickTool("短语");
    await sleep(200);

    byTestId("db-header-more").click();
    await sleep(250);
    var headerMenu = byTestId("db-context-menu");
    out.headerMenuItems = headerMenu ? [].slice.call(headerMenu.querySelectorAll("button")).map(function (b) { return b.innerText; }) : [];
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(200);
    out.headerMenuClosed = !byTestId("db-context-menu");
    snap();

    // ---- 「断开连接」之后再点「刷新连接」必须能把连接拉回来（用户 2026-09-13：
    //      「现在断连后再刷新无法直接重连了？」）。走的是**用户看得见的那条路**：
    //      断连时这颗键必须可点 → 点了真的发出 rooms_reconnect → 状态点从灰回到上游那一档。
    //      改前后端直接报 ROOM_NOT_FOUND（rooms_disconnect 把会话摘掉了），
    //      界面只弹一条错误、连接回不来 —— 这三条断言都会红。
    window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "disconnected", detail: "会话已关闭" });
    await sleep(250);
    out.reconnectDotIdleAfterDrop = byTestId("db-live-dot-box").getAttribute("data-state") === "idle";
    // 多标签隔离（item 2）要有两个房间才有标签条：把第二个房间登记进替身的 rooms_list ——
    // **紧挨着**下面这次「刷新连接」，它会重拉 rooms_list，界面随后就看到第二个房间。
    window.__addSecondRoom();
    byTestId("db-header-more").click();
    await sleep(250);
    var refreshItem = buttonWith(byTestId("db-context-menu"), "刷新连接");
    out.reconnectItemOffered = !!refreshItem && refreshItem.disabled !== true;
    var reconnectBefore = window.__reconnectCalls || 0;
    refreshItem.click();
    await sleep(400);
    out.reconnectCommandSent = (window.__reconnectCalls || 0) === reconnectBefore + 1 &&
      window.__lastReconnectRoom === fixtureRoom.room_id;
    // 连上之后状态点回到上游 live_status 那一档（灰只表示「还没连上」，见 docs/ui.md §3.3）。
    out.reconnectDotRestored = byTestId("db-live-dot-box").getAttribute("data-state") === (liveIsOn ? "on" : "off");
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await sleep(150);
    snap();

    // ---- tabs 多标签隔离（item 2，契约 C1 / docs/ui.md §2.3「多标签共存」）：
    //      切房间 = 换掉一整套**本地临时状态**，但**输入草稿按「身份 × 房间」各留一份**。
    //      此刻有两个房间（上面那次「刷新连接」重拉 rooms_list 带进来的 5555），标签条在场。
    //      流程：A 间开面板 + 开右键菜单 + 往上滚到「不跟随」+ 留一份草稿 → 切 B 间：
    //      面板 / 菜单 / 滚动跟随全部回到初始、草稿是空的 → 在 B 间再开一次面板 → 切回 A 间：
    //      面板同样收起、A 间那份草稿还在（键 = 身份:房间，本段身份是 uid 1000）。
    // 整块包一层（同粉丝牌那段的手法）：出岔子时让断言红（tabsBlockRan），
    // 而不是把整个场景卡到 300s。
    var tabsBlockRan = false;
    try {
      var tabIsolationScroll = byTestId("db-chat-scroll");
      // 垫场：让 A 间一定滚得动（不受「此刻恰好还剩几条可见」影响），否则「滚到暂停」无从谈起
      for (var padIndex = 0; padIndex < 30; padIndex += 1) {
        window.__emit("danmubox://message", window.__mk("danmaku", "隔离垫场" + padIndex, false, {
          uid: 77003, uname: "垫场观众"
        }));
      }
      await sleep(500);
      out.tabIsolationScrollable = tabIsolationScroll.scrollHeight > tabIsolationScroll.clientHeight + 1;
      // ① 右键菜单：在**最新一条**上开 —— 此刻还在跟随、那一行一定在虚拟列表的渲染窗口里
      //    （先滚到顶再开菜单会点不到行：窗口里只剩最旧的那几条）。
      var isolationMenuTarget = await emitOtherRow("隔离菜单样本");
      openRowMenu(isolationMenuTarget);
      await sleep(300);
      // ② 面板：工具行点开（.click() 不带 pointerdown，因此不会顺带把右键菜单关掉）
      clickTool("表情");
      await sleep(400);
      // ③ 往上滚到顶 = 用户自己暂停跟随（db-bottom-anchor 只在 !following 时渲染）
      tabIsolationScroll.scrollTop = 0;
      await sleep(400);
      out.tabIsolationPausedInA = !!byTestId("db-bottom-anchor");
      out.tabIsolationStatesSet = !!byTestId("db-panel") && !!byTestId("db-context-menu") &&
        !!byTestId("db-bottom-anchor");
      // ④ 草稿：A 间这一份只属于「身份:房间」这个键
      var isolationDraft = "A 间草稿";
      typeIntoArea(document.querySelector("textarea"), isolationDraft);
      await sleep(200);
      out.tabIsolationDraftTyped = document.querySelector("textarea").value === isolationDraft;
      var tabFor = function (name) {
        return allByTestId("db-room-tab").filter(function (t) {
          return t.innerText.indexOf(name) >= 0;
        })[0];
      };
      var tabRoomA = tabFor(fixtureRoom.anchor_uname);
      var tabRoomB = tabFor("房间 5555");
      out.tabIsolationTwoTabs = allByTestId("db-room-tab").length === 2 && !!tabRoomA && !!tabRoomB;
      tabRoomB.click();
      await sleep(900);
      // 「切到了 B」以房间头报的标题为准（不认 CSS-module 类名）：5555 没有主播名与标题，退到房间号
      out.tabIsolationSwitchedToB =
        byTestId("db-room-title").getAttribute("title") === "房间 5555";
      out.tabIsolationPanelClosed = !byTestId("db-panel");
      out.tabIsolationMenuClosed = !byTestId("db-context-menu");
      out.tabIsolationDraftFreshInB = document.querySelector("textarea").value === "";
      out.tabIsolationFollowingReset = !byTestId("db-bottom-anchor") &&
        bottomGap(byTestId("db-chat-scroll")) < 8;
      // B 间再开一次面板，切回 A 间时它同样必须收起（两个方向都判，不是单向巧合）。
      // **用「筛选」而不是「表情」**：夹具里的第二个房间（5555）刻意是「上游没给主播名与标题」
      // 的形态、connected: false（见 mock 的 __addSecondRoom），而房间页把这当成「没有可发的东西」：
      // 输入区整块与「表情 / 短语」两枚工具按钮都 disabled={disabled || !loggedIn}
      // （docs/ui.md §6.1），**点一枚 disabled 的按钮不派发 click** —— 实测 clickTool("表情")
      // 返回 true（按钮找得到、也真的点了）但面板永远开不出来，这条断言因此恒为假，而
      // 它旁边的 tabIsolationPanelClosedBackInA 会**顺带变成恒真**（B 间根本没开过面板，
      // 「切回 A 间时收起」也就无从谈起）。筛选手板不看连接状态（它只是显示偏好），
      // 在 B 间照常打得开 —— 换它之后这对断言才恢复成「两个方向都真的开过、都真的收起」。
      var bEmotesTool = buttonWith(byTestId("db-composer-tools"), "筛选");
      out.tabIsolationBComposer = {
        toolsRow: !!byTestId("db-composer-tools"),
        filterTool: !!bEmotesTool,
        emotesToolDisabled: (function () {
          var b = buttonWith(byTestId("db-composer-tools"), "表情");
          return b ? b.disabled === true : null;
        })(),
        textareaDisabled: document.querySelector("textarea")
          ? document.querySelector("textarea").disabled === true : null,
      };
      out.tabIsolationBClickedTool = clickTool("筛选");
      await sleep(400);
      out.tabIsolationPanelOpenInB = !!byTestId("db-panel");
      out.tabIsolationBPanelDiag = {
        panel: !!byTestId("db-panel"),
        emoteTabs: [].slice.call(document.querySelectorAll('[data-testid="db-emote-tab"]'))
          .map(function (b) { return b.getAttribute("data-kind"); }),
        options: byTestId("db-panel")
          ? [].slice.call(byTestId("db-panel").querySelectorAll("button")).length : null,
      };
      tabRoomA = tabFor(fixtureRoom.anchor_uname);
      tabRoomA.click();
      await sleep(900);
      out.tabIsolationBackInA = byTestId("db-room-title").getAttribute("title") === fixtureRoom.title;
      out.tabIsolationPanelClosedBackInA = !byTestId("db-panel");
      out.tabIsolationDraftRestored = document.querySelector("textarea").value === isolationDraft;
      // 复原：草稿清掉（后面的步骤不依赖它），快照写下这一段
      typeIntoArea(document.querySelector("textarea"), "");
      await sleep(200);
      snap();
      tabsBlockRan = true;
    } catch (e) {
      out.tabsBlockError = String((e && e.stack) || e);
    }
    out.tabsBlockRan = tabsBlockRan;

    // ---- 沉浸模式（issue #1）：弹幕区**双击**收起标题栏与输入区，只留弹幕区与礼物 / SC 栏，
    //      再双击恢复。判据是**指针事件**（鼠标双击与触屏点两下走同一条路，见 RoomView 顶部
    //      的 TAP_MS）：两次「按下 → 抬起」都在 400ms 内、落点相距不超过 24px，且不落在
    //      可交互元素上。这一段与 docs/ui.md 2.3.1 的「收起 / 保留」清单一一对应。
    // 整块包一层（同上面几段的手法）：出岔子时让断言红（immersiveBlockRan），不卡死整个场景。
    //
    // ⚠ **沉浸态是唯一一个「块内出错会连带打死块外」的状态**：沉浸态里房间头 / 输入区都是
    //   条件渲染（RoomView 的 {!immersive && …}），它们整个不在 DOM 里；块外的段落照旧
    //   裸取 byTestId("db-header-more").click()（那是「进房间点 ⋯ 看菜单」的常规动作），
    //   拿到 null 就是一个**未捕获的 TypeError** —— 场景当场死掉，跑脚本的那一头只能看到
    //   「视口 wide 的场景未跑完（超时）」，root cause 全被 300s 的超时盖住（实测两引擎都栽在这）。
    //   所以这里的 finally 是**必需**的：无论块内走到哪一步、抛了什么，先把沉浸态退出来，
    //   让块外的世界回到它假设的样子；退出结果另记一条布尔（immersiveRestoredAfterBlock）。
    var immersiveOff = async function () {
      var root = document.documentElement;
      if (root.getAttribute("data-immersive") !== "true") return true;
      var el = document.querySelector('[data-testid="db-chat-wrap"]') ||
        document.querySelector('[data-testid="db-chat-scroll"]');
      if (!el) return false;
      var box = el.getBoundingClientRect();
      var x = Math.round(box.left + box.width / 2);
      var y = Math.round(box.top + box.height / 2);
      var base = {
        bubbles: true, cancelable: true, composed: true, isPrimary: true,
        button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y,
      };
      // 两下「点」挨着发（判据看的是两次点的间隔 < 400ms，sleep 会被页面节流拉长，见块内说明）
      for (var i = 0; i < 2; i += 1) {
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { buttons: 1 })));
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
      }
      await sleep(320);
      return root.getAttribute("data-immersive") !== "true";
    };
    var immersiveBlockRan = false;
    try {
      var immTap = function (el, x, y, pointerType) {
        var base = {
          bubbles: true, cancelable: true, composed: true, isPrimary: true,
          button: 0, pointerId: 1, pointerType: pointerType, clientX: x, clientY: y,
        };
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { buttons: 1 })));
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
      };
      // 两下「点」**挨着发**（中间不 sleep）：判据量的是两次点的间隔，而 sleep 会被页面节流拉长
      // —— 实测在被节流的页面里 sleep(60) 落成 **473ms** 的间隔，直接超出 400ms 窗口。
      // 真实用户当然不会快到这个程度，这里要验的是**判据本身**，不是人手速；间隔为 0 必定在窗口内。
      var immDoubleTap = async function (el, x, y, pointerType) {
        immTap(el, x, y, pointerType);
        immTap(el, x, y, pointerType);
        await sleep(320);
      };
      // 「DOM 层面不可见」的两条路：条件渲染的那几块**不在 DOM 里**；标签条在 App 里
      // （房间页的兄弟节点），走 CSS 的 display: none —— 仍在 DOM 里，但 getClientRects()
      // 为空（既不占位、也不进 Tab 序）。
      var immUnrendered = function (el) { return el == null || el.getClientRects().length === 0; };
      var immAttr = function () { return document.documentElement.getAttribute("data-immersive"); };
      // 垫场：这一步之前刚跑完「A 间 → B 间 → A 间」，而切回 A 间看到的是**这一间房间
      // 重新回填的历史**（store 里 messages 只有一份、跟着当前房间走；每个房间自己的会话
      // 缓冲在 Rust 那一头，切回来是靠再 query 一次历史看到的 —— 见 store 的 openRoom），
      // 夹具那几条历史**撑不满一屏**：实测此刻 scrollHeight == clientHeight、scrollTop 恒 0，
      // 下面「沉浸态里照样能往上翻历史」就没有了可观察面（不是功能坏了 —— 单独跑一段垫过场的
      // 场景，进沉浸后滚到中段 scrollTop=765、离底 764px、「回到最新」如期出现且稳定）。
      // 做法与 tabs 那一段的「隔离垫场」逐字同源。
      for (var immPad = 0; immPad < 30; immPad += 1) {
        window.__emit("danmubox://message", window.__mk("danmaku", "沉浸垫场" + immPad, false, {
          uid: 88002, uname: "垫场观众"
        }));
      }
      await sleep(700);
      out.immersivePadRows = rows().length;
      var immChat0 = rect(byTestId("db-chat-scroll"));
      var immGift0 = rect(byTestId("db-gift-dock"));
      var immTabs0 = rect(byTestId("db-room-tabs"));
      var immHeader0 = rect(byTestId("db-room-header"));
      // 输入区整块的高度**直接量输入区这一块**（RoomView 的 shell 里它是被收起的三块之一）。
      // 旧写法拿「礼物栏顶边 − 弹幕区底边」推算，前提是「文档流里礼物栏与弹幕区紧挨着输入区的上下」
      // —— 那是**上下分区（issue #8）之前**的结构：礼物栏搬进共享分区之后，那一段量到的是
      // 弹幕区与礼物栏之间的**分割条**（实测 8.0px），输入区那块（100px 量级）根本不在这条缝里，
      // 等式必然差一大截。这里改用与文件里其它段落同源的办法（closest('[class*="composer"]')）。
      var immComposerEl = document.querySelector("textarea")
        ? document.querySelector("textarea").closest('[class*="composer"]')
        : null;
      var immComposerH = immComposerEl ? Math.round(rect(immComposerEl).height * 10) / 10 : 0;
      var immGiftHeadH = Math.round((immGift0 ? immGift0.height : 0) * 10) / 10;
      out.immersiveRemovedBlocksPx = [
        immTabs0 ? Math.round(immTabs0.height * 10) / 10 : null,
        immHeader0 ? Math.round(immHeader0.height * 10) / 10 : null,
        immComposerH,
      ];
      var immTextareas0 = document.querySelectorAll("textarea").length;
      var immTapX = Math.round(immChat0.left + immChat0.width / 2);
      var immTapY = Math.round(immChat0.top + immChat0.height / 2);
      // ① 单击**不**切（判据是双击）：标签条 / 房间头 / 属性三处都还是原样
      immTap(byTestId("db-chat-scroll"), immTapX, immTapY, "mouse");
      await sleep(500);
      out.immersiveSingleTapIgnored = immUnrendered(byTestId("db-room-tabs")) === false &&
        byTestId("db-room-header") !== null && immAttr() === null;
      // ② 双击弹幕区 → 进沉浸模式（鼠标指针）
      await immDoubleTap(byTestId("db-chat-scroll"), immTapX, immTapY, "mouse");
      var immChat1 = rect(byTestId("db-chat-scroll"));
      var immGift1 = rect(byTestId("db-gift-dock"));
      out.immersiveEnterOnChatDoubleTap = immAttr() === "true";
      out.immersiveHidesHeader = immHeader0 !== null &&
        byTestId("db-room-header") === null && byTestId("db-live-dot-box") === null;
      out.immersiveHidesComposer = immTextareas0 === 1 &&
        byTestId("db-composer-tools") === null && byTestId("db-input-count") === null &&
        document.querySelector("textarea") === null;
      out.immersiveHidesTabs = immTabs0 !== null && byTestId("db-room-tabs") !== null &&
        immUnrendered(byTestId("db-room-tabs")) &&
        getComputedStyle(byTestId("db-room-tabs")).display === "none";
      out.immersiveChatGrewPx = Math.round((immChat1.height - immChat0.height) * 10) / 10;
      // 弹幕区长高的**正好**是被收起来的那三块之和（标签条 + 房间头 + 输入区）：
      // 既证明「收起」，也证明这几块腾出来的高度全归弹幕区，没有别的块被挤错。
      out.immersiveChatGrewByRemovedBlocks = immTabs0 !== null && immHeader0 !== null &&
        immComposerH > 0 && Math.abs(out.immersiveChatGrewPx -
          (immTabs0.height + immHeader0.height + immComposerH)) < 1.5;
      // 礼物 / SC 栏留在场上、高度一点没变；它与弹幕区之间**只隔着那条分割条**
      // （弹幕区拿走收起腾出的全部高度，没有别的块被挤错）。旧写法要求「弹幕区底边紧贴礼物栏顶边」，
      // 同样是上下分区之前的结构 —— 折叠态下礼物栏在弹幕区正下方，中间那一条 8px 就是分割条
      // （实测 8.0），所以相邻性改成「弹幕区底边 = 分割条顶边、礼物栏顶边 = 分割条底边」。
      var immSplit1 = rect(byTestId("db-pane-splitter"));
      out.immersiveGiftHeightDeltaPx = immGift0 && immGift1
        ? Math.round((immGift1.height - immGift0.height) * 10) / 10 : null;
      out.immersiveKeepsGiftDock = byTestId("db-gift-dock") !== null && !!immGift0 &&
        !!immGift1 && !!immSplit1 &&
        // 折叠态（此刻它就是折叠的）在沉浸态里照旧折叠：高度仍然是折叠头那一个数
        !byTestId("db-gift-area") &&
        Math.abs(immGift1.height - immGift0.height) < 1 &&
        Math.abs(immGift1.height - immGiftHeadH) < 1 &&
        Math.abs(rect(byTestId("db-chat-scroll")).bottom - immSplit1.top) < 1 &&
        Math.abs(immGift1.top - immSplit1.bottom) < 1;
      snap();
      // ③ 沉浸态里照样能往上翻历史、「回到最新」跟着出现、点了又贴底（虚拟列表重新量高）
      var immScroll = byTestId("db-chat-scroll");
      immScroll.scrollTop = Math.round((immScroll.scrollHeight - immScroll.clientHeight) * 0.5);
      // 采样而不是只量一次：虚拟列表在沉浸态里会重新量高、MessageList 的 ResizeObserver
      // 又会在「跟随中」时重新贴底 —— 「滚上去之后按钮没出现」到底是没滚成（scrollTop 为 0）、
      // 还是滚了又被弹回底，采样数组一眼分得出来。
      var immSamples = [];
      for (var immStep = 0; immStep < 5; immStep += 1) {
        await sleep(immStep === 0 ? 80 : 150);
        var immNow = byTestId("db-chat-scroll");
        immSamples.push({
          top: immNow ? Math.round(immNow.scrollTop) : null,
          gap: immNow ? bottomGap(immNow) : null,
          anchor: !!byTestId("db-bottom-anchor"),
        });
      }
      out.immersiveScrollSamples = immSamples;
      out.immersiveScrollsWhenImmersive = immScroll.scrollTop > 0 &&
        bottomGap(immScroll) > 8 && byTestId("db-bottom-anchor") !== null;
      // 按钮不在就**不点**：这一步以前是裸取 .click()，沉浸块内一旦走到这里就抛 TypeError，
      // 被 catch 吞掉之后沉浸态留在场上，块外的裸取（房间头那枚 ⋯）拿到 null → 未捕获异常 →
      // 整个场景死掉（实测两引擎都栽在这，跑脚本那头只看到「场景未跑完（超时）」）。
      if (byTestId("db-bottom-anchor")) byTestId("db-bottom-anchor").click();
      await sleep(400);
      out.immersiveJumpToLatestWhenImmersive = byTestId("db-bottom-anchor") === null &&
        bottomGap(immScroll) < 8;
      // ④ 沉浸态里滚到中段再展开：**当前阅读位置不许被弹走**（与 layoutPanelScrollStable 同款量法）
      immScroll.scrollTop = Math.round((immScroll.scrollHeight - immScroll.clientHeight) * 0.45);
      await sleep(400);
      // 锚定「当前正在读的那一行」= **视口里最靠上的那一行**（按 data-index 认它）。
      // 旧写法取 rows()[4]（第 5 个**渲染出来**的格子）：虚拟列表的窗口带 12 行 overscan，
      // 45% 处那个窗口是从列表开头开始的，于是 rows()[4] 落在视口**上方**（top 为负、用户
      // 根本看不见）—— 拿它当阅读位置量错了对象，换掉它是为了让断言指向「用户在看的那一条」。
      // 但**改口径并不能救回这条断言**：修之前两处数值相同（都是 88.1px，见
      // immersiveAnchorSlotDeltaPx / immersiveExitKeepsReadingPositionPx 的对照），
      // 因为 88.1px 根本不是「一行的位移」，而是**滚动容器自己下移了** —— 退出沉浸时
      // 房间头 57 + 房间标签条 31.1 回到弹幕区**上方**，容器顶边整体下移 88.1px，
      // 容器里的内容（scrollTop、锚点行的内容坐标、它相对容器顶边的 1px 偏移）一动没动。
      // 旧数值仍然记进快照（immersiveAnchorSlotIndex / ...SlotDeltaPx）当对照。
      var immScrollBox = rect(byTestId("db-chat-scroll"));
      var immVisibleRow = immScrollBox
        ? rows().filter(function (r) { return rect(r).bottom > immScrollBox.top + 1; })[0] || null
        : null;
      var immAnchorSlot = rows()[4];
      var immAnchorSlotWrap = immAnchorSlot ? immAnchorSlot.closest("[data-index]") : null;
      var immAnchorSlotIndex = immAnchorSlotWrap
        ? immAnchorSlotWrap.getAttribute("data-index") : null;
      var immAnchorSlotTop = immAnchorSlot
        ? Math.round(rect(immAnchorSlot).top * 10) / 10 : null;
      var immAnchor = immVisibleRow || immAnchorSlot;
      var immAnchorTop = immAnchor ? Math.round(rect(immAnchor).top * 10) / 10 : null;
      // 认的是**这一条消息**，不是「第 5 个渲染出来的格子」：虚拟列表渲染的是窗口里那几行，
      // 视口一变窗口就挪（退出沉浸时弹幕区矮回去 193px，窗口里换一批行），rows()[4]
      // 指向的已经不是同一条了。**别把 88.1px 读成行高**：layoutLastRowHeightPx 是 81.1，
      // 两个数只是同量级；88.1 = 房间头 57 + 房间标签条 31.1，是容器自己的位移。
      // 行的外层包装上有 data-index（MessageList 用虚拟项的 index 打的那一枚），
      // 记下它就能在退出之后把**同一条消息**找回来；比按下标取更硬，不是放水。
      var immAnchorWrap = immAnchor ? immAnchor.closest("[data-index]") : null;
      var immAnchorIndex = immAnchorWrap ? immAnchorWrap.getAttribute("data-index") : null;
      var rowByIndex = function (index) {
        var wrap = index === null ? null : document.querySelector('[data-index="' + index + '"]');
        return wrap ? wrap.querySelector('[data-testid="db-msg-row"]') : null;
      };
      // 顺带钉住「不跟双击选词打架」：选中一段正文（双击选词的等价物），
      // 进出沉浸模式都不许把它清掉，正文本身也不许变成不可选。
      var immBody = immAnchor ? immAnchor.querySelector('[data-testid="db-msg-body"]') : null;
      var immSelected = "";
      var immSelectable = false;
      if (immBody) {
        var immRange = document.createRange();
        immRange.selectNodeContents(immBody);
        var immSel = window.getSelection();
        immSel.removeAllRanges();
        immSel.addRange(immRange);
        immSelected = immSel.toString();
        immSelectable = getComputedStyle(immBody).userSelect !== "none";
      }
      out.immersiveSelectionProbe = { selected: immSelected.length, selectable: immSelectable };
      // ⑤ 触屏双击（pointerType = touch）退出：鼠标与触摸走的是同一条指针判据
      await immDoubleTap(byTestId("db-chat-scroll"), immTapX, immTapY, "touch");
      var immChat2 = rect(byTestId("db-chat-scroll"));
      // 用 data-index 把**同一条消息**找回来（见上面 immAnchorIndex 的说明）
      var immAnchorAfter = rowByIndex(immAnchorIndex);
      var immAnchorTopAfter = immAnchorAfter
        ? Math.round(rect(immAnchorAfter).top * 10) / 10 : null;
      out.immersiveAnchorIndex = immAnchorIndex;
      out.immersiveAnchorFoundAfter = !!immAnchorAfter;
      // 对照：同一个场景里那个 overscan 格子（旧锚点）的位移 —— 它动不代表阅读位置动了。
      var immAnchorSlotAfter = rowByIndex(immAnchorSlotIndex);
      out.immersiveAnchorSlotIndex = immAnchorSlotIndex;
      out.immersiveAnchorSlotDeltaPx = immAnchorSlotTop !== null && immAnchorSlotAfter
        ? Math.round((Math.round(rect(immAnchorSlotAfter).top * 10) / 10 - immAnchorSlotTop) * 10) / 10
        : null;
      out.immersiveExitOnTouchDoubleTap = immAttr() === null;
      out.immersiveRestoresLayout = byTestId("db-room-header") !== null &&
        byTestId("db-composer-tools") !== null &&
        immUnrendered(byTestId("db-room-tabs")) === false &&
        Math.abs(immChat2.height - immChat0.height) < 1.5;
      out.immersiveExitKeepsReadingPositionPx = immAnchorTop !== null && immAnchorTopAfter !== null
        ? Math.round((immAnchorTopAfter - immAnchorTop) * 10) / 10 : null;
      out.immersiveExitKeepsReadingPosition = immAnchorTop !== null &&
        immAnchorTopAfter !== null && Math.abs(out.immersiveExitKeepsReadingPositionPx) < 8 &&
        byTestId("db-bottom-anchor") !== null && bottomGap(byTestId("db-chat-scroll")) > 8;
      out.immersiveKeepsTextSelection = immSelected.length > 0 && immSelectable &&
        window.getSelection().toString() === immSelected;
      // ⑥ 落在可交互元素上的双击**不**切（判据的另一半）。两个探针，都是真的落在 button 上的双击：
      //    ① 临时插一枚**稳定的**按钮进弹幕区（挂完就用，用完即摘）—— 它没有任何 click 处理，
      //       所以这一对「点」必然被完整判据看到：判据里少了「排除可交互元素」这一条，这里就会翻进沉浸态。
      //    ② 真实的「回到最新」按钮（此刻不在跟随，它在场）—— 同一个判据在真实控件上的实例。
      //    断言只认「没翻进去、房间页没被拆」，不去认那枚按钮还在不在：万一某个引擎给派发的指针事件
      //    补一个 click，②里的按钮会被点掉（跟随恢复），那与「双击不切沉浸」是两件事。
      var immProbe = document.createElement("button");
      immProbe.setAttribute("type", "button");
      immProbe.setAttribute("data-testid", "db-immersive-probe");
      immProbe.style.cssText = "position:absolute;left:8px;top:8px;width:40px;height:40px;z-index:9";
      byTestId("db-chat-wrap").appendChild(immProbe);
      await immDoubleTap(immProbe, Math.round(rect(immProbe).left + 20),
        Math.round(rect(immProbe).top + 20), "mouse");
      var immAfterProbe = immAttr();
      var immJump = byTestId("db-bottom-anchor");
      var immJumpBox = rect(immJump);
      if (immJumpBox) {
        await immDoubleTap(immJump, Math.round(immJumpBox.left + immJumpBox.width / 2),
          Math.round(immJumpBox.top + immJumpBox.height / 2), "mouse");
      }
      immProbe.remove();
      out.immersiveButtonDoubleTapIgnored = immAfterProbe === null && immAttr() === null &&
        byTestId("db-room-header") !== null && byTestId("db-immersive-probe") === null;
      out.immersiveButtonProbe = {
        attrAfterProbe: immAfterProbe,
        attrAfterJump: immAttr(),
        jumpStillThere: byTestId("db-bottom-anchor") !== null,
      };
      // 复原成「跟随最新」：后面的段落依赖它（顺手清掉刚才那段落选择）
      window.getSelection().removeAllRanges();
      immScroll = byTestId("db-chat-scroll");
      immScroll.scrollTop = immScroll.scrollHeight;
      await sleep(500);
      out.immersiveRestoredPinned = byTestId("db-bottom-anchor") === null &&
        bottomGap(immScroll) < 8 && immAttr() === null;
      snap();
      immersiveBlockRan = true;
    } catch (e) {
      out.immersiveBlockError = String((e && e.stack) || e);
    } finally {
      // 无论成败都退出沉浸态（见块上那段说明），并把「退出来了没有」记进快照 ——
      // 快照是判官拿到的唯一证据，出错那一条（immersiveBlockError）也必须落进去，
      // 否则现场只剩「场景未跑完（超时）」一句话。
      out.immersiveRestoredAfterBlock = await immersiveOff();
      snap();
    }
    out.immersiveBlockRan = immersiveBlockRan;
    snap();



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
    // db-gift-dock 现在就是**那枚折叠头按钮**本身（issue #8 把礼物栏搬进共享分区后，
    // 它的根是 db-pane-gift、折叠头是它的第一个子元素），所以直接点它。
    var exclusiveDockHead = byTestId("db-gift-dock");
    if (exclusiveDockHead) exclusiveDockHead.click();
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

    // ---- 滚到顶部时第一条不被头部压住（头部是文档流里的一行，不是 sticky/fixed 浮层）。
    // 放在最后量：改滚动位置会影响「跟随最新」，量完立刻还原。
    var headerBox = rect(byTestId("db-room-header"));
    var chatScroll = byTestId("db-chat-scroll");
    var keptScrollTop = chatScroll.scrollTop;
    chatScroll.scrollTop = 0;
    await sleep(300);
    var topRow = rows()[0];
    var chatScrollBox = rect(chatScroll);
    out.layoutHeaderOverlapPx = topRow
      ? Math.round((chatScrollBox.top - rect(topRow).top) * 10) / 10
      : null;
    out.layoutHeaderAboveList = headerBox.bottom <= chatScrollBox.top + 1;
    out.layoutTopRowNotCovered = !!topRow &&
      rect(topRow).top >= chatScrollBox.top - 0.5;
    out.layoutTopRowVisible = !!topRow &&
      rect(topRow).top >= chatScrollBox.top - 0.5 &&
      rect(topRow).bottom <= chatScrollBox.bottom + 1;
    chatScroll.scrollTop = keptScrollTop;
    await sleep(500);
    // 还原的判据是「又回到贴底 / 跟随状态」，不是 scrollTop 逐位相等：
    // 虚拟列表的高度估算落定后，可滚区间的最大值会差几像素，逐位比较是假失败。
    out.layoutScrollRestored =
      chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 8;
    snap();

    // ---- account 账号区一行身份 + 账号管理对话框（契约 §7 accounts_*）
    byTestId("db-header-back").click();
    await sleep(500);
    var account = byTestId("db-account");
    out.accountShown = !!account;
    // 下拉整块删掉了：单条目下拉会被读成「切换功能坏了」（用户原话「好像没法选」）
    out.accountNoDropdown = !!account && account.querySelector("select") === null;
    out.accountShowsIdentity = !!byTestId("db-account-name") &&
      byTestId("db-account-name").innerText.indexOf("本地测试") >= 0 &&
      byTestId("db-account-uid").innerText.indexOf("1000") >= 0;
    // ---- issue #8：**整行即入口**（独立的「账号」按钮已删）。这一行本身就是按钮语义：
    //      role=button + tabIndex=0 + aria-label「账号管理」，行内不再有别的可点元素。
    out.accountOpenButtonGone = byTestId("db-account-open") === null;
    out.accountRowIsEntry = !!account &&
      account.getAttribute("role") === "button" &&
      account.getAttribute("tabindex") === "0" &&
      (account.getAttribute("aria-label") || "").indexOf("账号管理") >= 0;
    out.accountRowHasNoInnerButton = !!account && account.querySelector("button") === null;
    var followBefore = window.__followCalls;
    // 停一下让跑脚本的进程抓一张「账号区只留一行」的截图
    out.accountAreaReady = out.accountShown;
    snap();
    await sleep(900);

    // 鼠标：点这一行开对话框；键盘：Enter / Space 等价（行是 div role=button，键事件由它的
    // keydown 处理 —— 焦点先落上去再派发，与真实「Tab 到这一行再按」同一条路径）。
    account.click();
    await sleep(400);
    out.accountDialogShown = !!byTestId("db-account-dialog");
    // ---- issue #3：对话框排版（宽屏 / 窄屏同一套断言，两档各量一次）
    // ① 「＋ 添加账号」在内容宽里**水平居中**（左右留白相等），且**不拉满整行** —— 拉满的行
    //    左右留白当然也相等，所以「比参照块窄」必须一起判。时序：开扫码时这枚按钮**不在 DOM 里**，
    //    所以只能在点它之前量。参照物取账号行：两者都是对话框里的一级块，都撑满内容宽。
    var addBtnNow = byTestId("db-account-add");
    var accountRowRef = allByTestId("db-account-row")[0];
    out.accountAddShownBeforeScan = !!addBtnNow;
    out.accountAddCenteredPx = addBtnNow && accountRowRef
      ? Math.round(((rect(addBtnNow).left - rect(accountRowRef).left) -
          (rect(accountRowRef).right - rect(addBtnNow).right)) * 10) / 10
      : null;
    out.accountAddCentered = out.accountAddCenteredPx !== null &&
      Math.abs(out.accountAddCenteredPx) <= 1;
    out.accountAddNotStretched = !!addBtnNow && !!accountRowRef &&
      rect(addBtnNow).width < rect(accountRowRef).width - 8;
    // ---- item 2：对话框里**没有**「关闭」按钮了（db-account-close 在整个界面里都不存在），
    //      关闭只剩两条路 —— **Esc** 与**点背景**。下面各走一次，每次都断卡片真的消失
    //      （后面还各再走一次，两条路径都不是「只关得掉一次」）。
    out.accountDialogCloseButtonGone = byTestId("db-account-close") === null;
    pressEscape();
    await sleep(300);
    out.accountDialogClosedByEscape = !byTestId("db-account-dialog");
    pressKey(account, "Enter");
    await sleep(400);
    out.accountRowEnterOpensDialog = !!byTestId("db-account-dialog");
    var accountBackdropClicked = clickDialogBackdrop(byTestId("db-account-dialog"));
    await sleep(300);
    out.accountDialogClosedByBackdrop = accountBackdropClicked &&
      !byTestId("db-account-dialog");
    pressKey(account, " ");
    await sleep(400);
    out.accountRowSpaceOpensDialog = !!byTestId("db-account-dialog");
    // 窄屏：账号对话框是自底部升起的 sheet（占满宽度、贴着视口底），可滚动、有关闭入口、热区 ≥ 40px
    if (NARROW) {
      var accountDlgEl = byTestId("db-account-dialog");
      var accountDlgRect = rect(accountDlgEl);
      var accountDlgHotspots = shortHotspots(accountDlgEl);
      put("accountDialogIsBottomSheet",
        Math.abs(accountDlgRect.bottom - window.innerHeight) < 2 &&
        Math.abs(accountDlgRect.width - document.documentElement.clientWidth) < 2);
      put("accountDialogScrollable", getComputedStyle(accountDlgEl).overflowY === "auto");
      // item 2：关闭入口不再是一枚按钮（卡片里没有 db-account-close）；「关得掉」由上面
      // 的 Esc / 点背景两条断言负责，这里只钉「卡片里确实没有那枚按钮」。
      put("accountDialogNoCloseButton", byTestId("db-account-close") === null);
      put("accountDialogHotspotsBad", accountDlgHotspots);
      put("accountDialogHotspotsAtLeast40", accountDlgHotspots.length === 0);
    }
    var rowsBefore = allByTestId("db-account-row");
    out.accountDialogRowsBefore = rowsBefore.length;
    out.accountRowShowsWho = rowsBefore.length === 1 &&
      rowsBefore[0].innerText.indexOf("本地测试") >= 0 &&
      rowsBefore[0].innerText.indexOf("uid 1000") >= 0;
    out.accountRowAvatarShown = rowsBefore.length === 1 &&
      !!rowsBefore[0].querySelector("img");
    // 窄屏：账号行里「昵称 / uid / 账号名」与操作按钮不许横向叠在一起（放不下就该换行）
    var rowUidEl = rowsBefore.length === 1
      ? rowsBefore[0].querySelector('[data-testid="db-account-row-uid"]')
      : null;
    var rowRemoveEl = rowsBefore.length === 1
      ? rowsBefore[0].querySelector('[data-testid="db-account-remove"]')
      : null;
    var rowActionsEl = rowRemoveEl ? rowRemoveEl.parentElement : null;
    put("accountRowNoOverlap", !!rowUidEl && !!rowActionsEl &&
      (rect(rowUidEl).right <= rect(rowActionsEl).left + 1 ||
        rect(rowActionsEl).top >= rect(rowUidEl).bottom - 1));
    out.accountCurrentMarked = rowsBefore.length === 1 &&
      byTestId("db-account-row-status").innerText.trim() === "已登录 · 当前";
    // 单账号时也必须看得到添加入口（用户卡住的就是这一步）
    out.accountAddShownWithOneAccount = !!byTestId("db-account-add");
    var onlyRemoveBtn = rowsBefore.length === 1 ? buttonWith(rowsBefore[0], "删除") : null;
    out.accountRemoveDisabledWithOneAccount = !!onlyRemoveBtn && onlyRemoveBtn.disabled &&
      (onlyRemoveBtn.title || "").indexOf("至少保留") >= 0;
    // ---- item 5：切换改成**非当前账号整行可点**（db-account-switch 按钮已删）。
    //      当前账号行因此没有按钮语义、也没有可切的目标：不带 role / tabindex / aria-label，
    //      点它也不会发出 account_switch。
    //      （item 6：手填 Cookie 整条链路已删，这里不再有 accountCookieEntryReachable。）
    var switchesBeforeCurrentClick =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length;
    rowsBefore[0].click();
    await sleep(300);
    out.accountCurrentRowNotSwitchable = rowsBefore.length === 1 &&
      !rowsBefore[0].getAttribute("role") && rowsBefore[0].getAttribute("tabindex") === null &&
      !rowsBefore[0].getAttribute("aria-label") &&
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length ===
        switchesBeforeCurrentClick;
    snap();
    await sleep(800);

    // 添加账号 = 默认入口：account_qr_start 不带 target，永不覆盖任何凭据
    byTestId("db-account-add").click();
    await sleep(400);
    // ---- issue #3 ②③：二维码卡片与上方的一级块**同宽**（撑满对话框内容宽，不再是贴左的
    //      fit-content）；它与上方块的间距 = 对话框的统一行间距（.accountDialog 的 gap），
    //      **不另加外边距**（改前是 fit-content 242px + margin-top 20px）。
    var qrCardEl = byTestId("db-account-qr");
    var qrRowRef = allByTestId("db-account-row")[0];
    var accountDlgForGap = byTestId("db-account-dialog");
    var accountDlgGap = accountDlgForGap
      ? parseFloat(getComputedStyle(accountDlgForGap).rowGap) : null;
    out.accountQrSameWidthAsRow = !!qrCardEl && !!qrRowRef &&
      Math.abs(rect(qrCardEl).width - rect(qrRowRef).width) <= 1;
    out.accountQrGapPx = qrCardEl && qrRowRef
      ? Math.round((rect(qrCardEl).top - rect(qrRowRef).bottom) * 10) / 10
      : null;
    out.accountQrGapIsDialogGap = out.accountQrGapPx !== null && accountDlgGap !== null &&
      Math.abs(out.accountQrGapPx - accountDlgGap) <= 1;
    var startCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; });
    var lastStart = startCalls[startCalls.length - 1];
    out.accountAddCallsQrStart = startCalls.length === 1;
    out.accountAddStartHasNoTarget = !!lastStart && lastStart.args.target === undefined;
    var qrImg = byTestId("db-account-qr-img");
    out.accountQrImgShown = !!qrImg &&
      String(qrImg.getAttribute("src")).indexOf("data:image/svg+xml") === 0;
    out.accountQrAddNeverOverwrites = byTestId("db-account-qr-warn") === null;
    out.accountQrPendingHintSaysScan =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("扫码") >= 0;
    snap();
    await sleep(900);
    await sleep(2300);
    out.accountQrScannedHintShown =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("确认") >= 0;
    await sleep(2300);
    out.accountQrClosedAfterConfirm = !byTestId("db-account-qr");
    var rowsAfterAdd = allByTestId("db-account-row");
    out.accountDialogRowsAfterAdd = rowsAfterAdd.length;
    out.accountNewRowIsCurrent = rowsAfterAdd.length === 2 &&
      rowsAfterAdd[1].innerText.indexOf("已登录 · 当前") >= 0;
    out.accountIdentityRefreshedAfterAdd = byTestId("db-account-name").innerText.indexOf("扫码新用户") >= 0;
    out.accountFollowReloadedAfterAdd = window.__followCalls > followBefore;

    // 轮询失败要能重试：面板留在原地（二维码还在）+ 给出错误原因 + 「重新获取」能再发一次
    byTestId("db-account-add").click();
    await sleep(400);
    window.__qrFail = true;
    await sleep(2400);
    out.accountQrFailureShown =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("失败") >= 0;
    out.accountQrRetryOffered = !!byTestId("db-account-qr-retry");
    var startsBeforeRetry =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    byTestId("db-account-qr-retry").click();
    await sleep(400);
    out.accountQrRetryRestarts =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length ===
      startsBeforeRetry + 1;
    out.accountQrRetryHintBackToScan =
      (byTestId("db-account-qr-hint") || { innerText: "" }).innerText.indexOf("扫码") >= 0;
    window.__qrFail = false;
    byTestId("db-account-qr-cancel").click();
    await sleep(300);
    out.accountQrCancelClearsPanel = !byTestId("db-account-qr") && !!byTestId("db-account-add");

    // 切换：非当前账号**整行可点**即 account_switch（item 5；「切换」按钮已删），
    // 界面重拉会话并把「当前」标记挪过去；切换后按新身份重铺（item 4 的切号隔离）。
    var roomsListBeforeSwitch =
      calls.filter(function (c) { return c === "rooms_list"; }).length;
    var followBeforeSwitch = window.__followCalls;
    var rowSwitchable = rowsAfterAdd[0];
    out.accountRowSwitchableSemantics = !!rowSwitchable &&
      rowSwitchable.getAttribute("role") === "button" &&
      rowSwitchable.getAttribute("tabindex") === "0" &&
      (rowSwitchable.getAttribute("aria-label") || "").indexOf("切到") >= 0;
    rowSwitchable.click();
    await sleep(600);
    var switchCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchCalled = switchCalls.length === 1 && switchCalls[0].args.name === "default";
    var rowsAfterSwitch = allByTestId("db-account-row");
    out.accountCurrentMarkMoved = rowsAfterSwitch[0].innerText.indexOf("已登录 · 当前") >= 0 &&
      rowsAfterSwitch[1].innerText.indexOf("已登录 · 当前") < 0;
    out.accountIdentityAfterSwitch = byTestId("db-account-name").innerText.indexOf("本地测试") >= 0;
    // item 4 切号隔离：上一个身份的视角不许留下 —— 界面回到房间列表页、rooms_list 与
    // follow_list 都按新身份重拉（房间列表 / 关注列表 / 房内身份 / 房管三块 / 表情库先清后铺）。
    out.accountSwitchBackToList = !!byTestId("db-list-page") && !byTestId("db-room-tabs");
    out.accountSwitchRelistsRooms =
      calls.filter(function (c) { return c === "rooms_list"; }).length > roomsListBeforeSwitch;
    out.accountSwitchRelistsFollowed = window.__followCalls > followBeforeSwitch;
    // 键盘与鼠标等价（item 5）：Enter 换到另一个账号，再用 Space 换回来 —— 两次都走真实键事件
    rowsAfterSwitch[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await sleep(600);
    var switchCallsAfterEnter = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchByEnter = switchCallsAfterEnter.length === 2 &&
      switchCallsAfterEnter[1].args.name === "扫码新用户";
    rowsAfterSwitch[0].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await sleep(600);
    var switchCallsAfterSpace = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchBySpace = switchCallsAfterSpace.length === 3 &&
      switchCallsAfterSpace[2].args.name === "default";
    // 切回来（鼠标这一条路径），让「删除当前账号」这一步删的确实是当前那一个
    rowsAfterSwitch[1].click();
    await sleep(600);
    var switchCallsFinal = callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; });
    out.accountSwitchFinal = switchCallsFinal.length === 4 &&
      switchCallsFinal[3].args.name === "扫码新用户";
    out.accountCurrentIsScanUserAgain = byTestId("db-account-name").innerText.indexOf("扫码新用户") >= 0;

    // 重新登录 = 覆盖路径：先二次确认，且文案写清覆盖谁的凭据（原账号就是这样被顶掉的）
    var rowsNow = allByTestId("db-account-row");
    var startsBefore = callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length;
    var switchesBeforeRescan =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length;
    buttonWith(rowsNow[0], "重新登录").click();
    await sleep(250);
    var overwriteConfirm = byTestId("db-account-confirm");
    out.accountRescanNeedsConfirm = !!overwriteConfirm &&
      overwriteConfirm.innerText.indexOf("覆盖") >= 0 &&
      overwriteConfirm.innerText.indexOf("default") >= 0;
    out.accountRescanNotStartedBeforeConfirm =
      callsWithArgs.filter(function (c) { return c.cmd === "account_qr_start"; }).length === startsBefore;
    // item 5 的另一半：行**内**的动作按钮不冒泡到行 —— 点「重新登录」不该顺带切号
    out.accountRowActionDoesNotSwitch =
      callsWithArgs.filter(function (c) { return c.cmd === "account_switch"; }).length ===
        switchesBeforeRescan;
    buttonWith(overwriteConfirm, "取消").click();
    await sleep(200);
    out.accountRescanConfirmDismissed = !byTestId("db-account-confirm");

    // 删除当前账号：二次确认 → 后端删掉后自动切到剩下的那个
    buttonWith(rowsNow[1], "删除").click();
    await sleep(250);
    var delConfirm = byTestId("db-account-confirm");
    out.accountRemoveConfirmShown = !!delConfirm &&
      delConfirm.innerText.indexOf("不可恢复") >= 0 &&
      delConfirm.innerText.indexOf("扫码新用户") >= 0;
    buttonWith(delConfirm, "确认删除").click();
    await sleep(700);
    var delCalls = callsWithArgs.filter(function (c) { return c.cmd === "account_remove"; });
    out.accountRemoveCalledWithCurrent = delCalls.length === 1 &&
      delCalls[0].args.name === "扫码新用户";
    var rowsAfterRemove = allByTestId("db-account-row");
    out.accountRemoveFallsBackToOther = rowsAfterRemove.length === 1 &&
      rowsAfterRemove[0].innerText.indexOf("本地测试") >= 0 &&
      rowsAfterRemove[0].innerText.indexOf("已登录 · 当前") >= 0;
    var leftRemoveBtn = rowsAfterRemove.length === 1 ? buttonWith(rowsAfterRemove[0], "删除") : null;
    out.accountRemoveDisabledWithOneLeft = !!leftRemoveBtn && leftRemoveBtn.disabled;

    // 退出登录 = 清凭据、退回游客态（账号条目保留）
    buttonWith(rowsAfterRemove[0], "退出登录").click();
    await sleep(250);
    var logoutConfirm = byTestId("db-account-confirm");
    out.accountLogoutConfirmExplains = !!logoutConfirm &&
      logoutConfirm.innerText.indexOf("游客态") >= 0 &&
      logoutConfirm.innerText.indexOf("本地测试") >= 0;
    buttonWith(logoutConfirm, "确认退出登录").click();
    await sleep(700);
    out.accountLogoutCalled = calls.indexOf("account_logout") >= 0;
    out.accountRowShowsNotLoggedIn =
      (byTestId("db-account-row-status") || { innerText: "" }).innerText.trim() === "未登录";
    // 关闭路径仍是 Esc（对话框里那枚「关闭」按钮已随 item 2 删除）
    pressEscape();
    await sleep(400);
    out.accountBackToGuest = !!byTestId("db-account-guest") && !byTestId("db-account-dialog");
    out.accountGuestTextShown = (byTestId("db-account-guest") || { innerText: "" })
      .innerText.indexOf("游客态") >= 0;
    // 游客态那一行**同样可点**（issue #8：那时它的作用就是去登录）—— 键盘 Enter 一样开对话框
    var guestRow = byTestId("db-account");
    out.accountGuestRowIsEntry = !!guestRow &&
      guestRow.getAttribute("role") === "button" &&
      guestRow.getAttribute("tabindex") === "0" &&
      (guestRow.getAttribute("aria-label") || "").indexOf("账号管理") >= 0;
    pressKey(guestRow, "Enter");
    await sleep(400);
    out.accountGuestRowOpensDialog = !!byTestId("db-account-dialog");
    var guestBackdropClicked = clickDialogBackdrop(byTestId("db-account-dialog"));
    await sleep(300);
    out.accountGuestDialogCloses = guestBackdropClicked && !byTestId("db-account-dialog");

    // ---- #18 房间标签条：显示主播名，不显示房间号。
    // 标签条只在**多于一个**房间时渲染（App 既有语义）。第二个房间在**多标签隔离**那一段
    // （房间页里）就已经登记进替身了，这里只需走一次真实路径把它带回界面：
    // 点房间卡 → openRoom → connect 会重拉 rooms_list —— 这一轮之后 store 里就有两个房间。
    // （__addSecondRoom 是幂等的，重复调用不会多出一条。）
    // 主页**不挂**弹幕页的标签条（用户 2026-09-12：与主页的「已连接房间」卡片列表重复）。
    // 这里正是「有两个房间」的状态 —— 旧实现下标签条就是在这个条件下冒出来的。
    out.listPageNoRoomTabs = !byTestId("db-room-tabs") && allByTestId("db-room-tab").length === 0;
    byTestId("db-room-card").click();
    await sleep(800);
    var tabs = allByTestId("db-room-tab");
    out.roomTabsInsideRoom = !!byTestId("db-room-tabs");
    out.tabsRendered = tabs.length === 2;
    // 有名字的那个标签：报的是**真实载荷**里的主播名，且不露房间号。
    var namedTab = tabs.filter(function (t) {
      return t.innerText.indexOf(fixtureRoom.anchor_uname) >= 0;
    })[0];
    out.tabShowsAnchorNames = !!namedTab && tabs.length === 2;
    out.tabHidesRoomNumbers = !!namedTab && namedTab.innerText.indexOf("5440") < 0;
    // 没有名字的那个标签（上游名与标题都缺）：只能报房间号——但**不许**报「未命名直播间」，
    // 那个词既不说明是哪个房间，又像真名字（用户 2026-09-12 报的就是它）。
    out.tabFallbackShowsRoomNumber = tabs.length === 2 &&
      tabs.some(function (t) { return t.innerText.indexOf("房间 5555") >= 0; }) &&
      tabs.every(function (t) { return t.innerText.indexOf("未命名直播间") < 0; });
    // ---- 两处圆点**同一状态同色**（用户 2026-09-13：「橙色的需求改成灰色，但是下面的标题栏
    //      左边还是之前的样子」+ 追加「标题旁的断连确实没变化（只有红绿）」）。房间头那颗与
    //      标签页那颗现在是**同一个判据（liveKindOf）、同一组令牌（--live-*）、同一条 .liveDot 规则**，
    //      这条断言把它钉死：三态各走一遍，量每一处的**计算色**与 data-state。
    //      两个房间发同一组事件（含载荷里的 connected ——「连没连上」是两路信号取与），
    //      所以「哪个标签是当前激活的那个」不影响结论。
    var tabDotEls = function () { return allByTestId("db-tab-dot"); };
    var headerDotNow = function () {
      var dot = byTestId("db-live-dot");
      return dot ? getComputedStyle(dot).backgroundColor : null;
    };
    var headerStateNow = function () {
      var box = byTestId("db-live-dot-box");
      return box ? box.getAttribute("data-state") : null;
    };
    var tabColorsNow = function () {
      return tabDotEls().map(function (el) { return getComputedStyle(el).backgroundColor; });
    };
    var pairAt = async function (conn, liveStatus) {
      [fixtureRoom.room_id, 5555].forEach(function (id) {
        window.__emit("danmubox://status", { room_id: id, state: conn, detail: "" });
        window.__emit("danmubox://room", {
          room_id: id, live_status: liveStatus, connected: conn === "connected",
        });
      });
      await sleep(350);
      return {
        header: headerDotNow(),
        headerState: headerStateNow(),
        tabs: tabColorsNow(),
        tabStates: tabDotEls().map(function (el) { return el.getAttribute("data-state"); }),
      };
    };
    var dotPairs = [
      { kind: "on", want: cssColorOf("--live-on"), at: await pairAt("connected", 1) },
      { kind: "off", want: cssColorOf("--live-off"), at: await pairAt("connected", 0) },
      { kind: "idle", want: cssColorOf("--live-idle"),
        at: await pairAt("disconnected", fixtureRoom.live_status) },
    ];
    out.liveDotPairColors = dotPairs.map(function (p) {
      return { kind: p.kind, want: p.want, header: p.at.header, tabs: p.at.tabs };
    });
    out.liveDotTwoSitesSameColor = dotPairs.every(function (p) {
      return p.at.tabs.length === 2 && p.at.header === p.want &&
        p.at.tabs.every(function (c) { return c === p.want; });
    });
    out.liveDotTwoSitesSameState = dotPairs.every(function (p) {
      return p.at.headerState === p.kind && p.at.tabStates.length === 2 &&
        p.at.tabStates.every(function (s) { return s === p.kind; });
    });
    // 尺寸**维持现状**：标签页那颗点换的只是配色来源（旧 .dot 的 --sp-2 → 现在这条 .liveDot
    // 的 --live-dot），看得见的那颗点仍是 8px、外壳（热区 / 悬停面）仍是 12px。
    var firstTabDot = tabDotEls()[0];
    out.tabDotSizePx = firstTabDot ? Math.round(rect(firstTabDot).width * 10) / 10 : null;
    out.tabDotSizeUnchanged = !!firstTabDot &&
      Math.abs(rect(firstTabDot).width - cssLengthOf("--live-dot")) < 0.6 &&
      Math.abs(rect(firstTabDot).width - 8) < 0.6;
    // ---- issue #1（本批追加第 6 条）：标签条**拖动排序 + 横向滚动**（docs/ui.md §2.3）。
    //      用**真实指针事件**驱动（pointerdown → 越过阈值的 pointermove → pointerup），
    //      判的全是对外可观察的东西：DOM 顺序、data-active / data-dragging、房间头标题、
    //      rooms_connect 调用次数、计算样式、scrollWidth / clientWidth。
    //      边界逐条落到断言上：阈值以下的位移仍是点击、触摸横滑是滚动而按住才是拖、
    //      拖动中被拖的房间被关掉则整次作废、只有一个房间时根本没有标签条（另见 step2）。
    // 整块包一层（同上面几段的手法）：出岔子时让断言红（tabDragBlockRan），不把场景卡到超时。
    var tabDragBlockRan = false;
    try {
      var stripEl = byTestId("db-room-tabs");
      // 这一段接在别的切片后面跑：标签条得**真的在画面上**（别的切片可能把房间页留在
      // 沉浸模式 / 列表页里）—— 那样的话这里整段作废，但要说清原因，不能给一堆假几何。
      if (!stripEl || getComputedStyle(stripEl).display === "none" || rect(stripEl).width < 1) {
        throw new Error("标签条不可见（房间页没停在可见状态：沉浸模式没退出？）");
      }
      var pe = function (type, target, x, y, pointerType) {
        var init = {
          bubbles: true, cancelable: true, pointerId: 7, isPrimary: true,
          pointerType: pointerType || "mouse", clientX: x, clientY: y,
        };
        if (type === "pointerdown") { init.button = 0; init.buttons = 1; }
        if (type === "pointerup") { init.button = 0; init.buttons = 0; }
        target.dispatchEvent(new PointerEvent(type, init));
      };
      var tabNames = function () {
        return allByTestId("db-room-tab").map(function (t) { return t.innerText.trim(); });
      };
      var roomIds = function () {
        return allByTestId("db-room-tab").map(function (t) { return t.getAttribute("data-room-id"); });
      };
      /** 当前激活那一枚的房间号（标签上只有一个 data-active=true，取不到就是 null）。 */
      var activeRoomId = function () {
        var on = allByTestId("db-room-tab").filter(function (t) {
          return t.getAttribute("data-active") === "true";
        });
        return on.length === 1 ? on[0].getAttribute("data-room-id") : null;
      };
      var connectCalls = function () {
        return callsWithArgs.filter(function (c) { return c.cmd === "rooms_connect"; }).length;
      };
      var lastConnectRoom = function () {
        var all = callsWithArgs.filter(function (c) { return c.cmd === "rooms_connect"; });
        return all.length > 0 ? all[all.length - 1].args.roomId : null;
      };
      /** 点房间头 ⋯ 菜单里的某一项（菜单按文案找，与用户在菜单里点同一条路）。 */
      var menuPick = async function (label) {
        byTestId("db-header-more").click();
        await sleep(250);
        var item = buttonWith(byTestId("db-context-menu"), label);
        if (item) item.click();
        await sleep(1000);
        return !!item;
      };
      /**
       * 按住第 index 枚标签拖到 x，返回**拖拽中途**量到的那几个数（拖拽态 / 被拖项 /
       * 插入指示条 / 容器计算样式）。
       * holdMs 有值 = 触摸那条路：先按住这么久再动（触摸的横滑归容器滚动）。
       */
      var dragTab = async function (index, toX, pointerType, holdMs) {
        var tab = allByTestId("db-room-tab")[index];
        var box = rect(tab);
        var y = box.top + box.height / 2;
        pe("pointerdown", tab, box.left + 10, y, pointerType);
        if (holdMs) await sleep(holdMs);
        else {
          pe("pointermove", window, box.left + 50, y, pointerType);
          await sleep(90);
        }
        var mid = {
          dragging: stripEl.getAttribute("data-dragging"),
          dragged: allByTestId("db-room-tab").filter(function (t) {
            return t.getAttribute("data-dragging") === "true";
          }).length,
          markers: allByTestId("db-tab-drop").length,
          touchAction: getComputedStyle(stripEl).touchAction,
          overscroll: getComputedStyle(stripEl).overscrollBehaviorX,
        };
        pe("pointermove", window, toX, y, pointerType);
        await sleep(90);
        pe("pointerup", window, toX, y, pointerType);
        await sleep(150);
        return mid;
      };
      var farRight = function () {
        var tabs = allByTestId("db-room-tab");
        return rect(tabs[tabs.length - 1]).right + 40;
      };

      var restTouchAction = getComputedStyle(stripEl).touchAction;
      var orderBefore = roomIds();
      var activeBefore = activeRoomId();
      var headerBefore = byTestId("db-room-title").getAttribute("title");
      var connectsBefore = connectCalls();

      // ---- ① 拖动排序：把**当前激活的那一枚**（第 0 枚）拖到最右
      var dragMid = await dragTab(0, farRight());
      // 拖拽中的视觉反馈：被拖项自己半透明（data-dragging）、目标位有一枚插入指示条
      out.tabDragStateShown = dragMid.dragging === "true" && dragMid.dragged === 1 &&
        dragMid.markers === 1;
      // 拖拽态下容器不再滚（touch-action 收到自己手里、越界链就地截断）；
      // 静止时是 pan-x：触摸的横滑 = 滚标签条
      out.tabDragSuppressesScroll = dragMid.touchAction === "none" &&
        dragMid.overscroll === "contain" && restTouchAction === "pan-x";
      // 「第 0 枚挪到末尾」= 整体左移一位（与前面几段留下的顺序无关，任何长度都成立）
      var orderAfterDrag = roomIds();
      out.tabDragReorders = orderBefore.length >= 2 &&
        orderAfterDrag.length === orderBefore.length &&
        orderAfterDrag.every(function (id, index) {
          return id === orderBefore[(index + 1) % orderBefore.length];
        }) && orderAfterDrag.join("|") !== orderBefore.join("|");
      // 拖动**只改顺序**：激活项没换（还是同一枚房间号）、房间头报的还是同一个房间、
      // 一次 rooms_connect 都没发（没顺手切房间）
      out.tabDragKeepsActive = !!activeBefore && activeRoomId() === activeBefore &&
        byTestId("db-room-title").getAttribute("title") === headerBefore &&
        connectCalls() === connectsBefore;
      // 拖完指示条收掉（不留一根挂在那儿的竖条）
      out.tabDragClearedAfterDrop = stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0;

      // ---- ② 拖完之后重拉一次 rooms_list（⋯ → 刷新连接）：**顺序必须留住**
      //      （本票的口径是「会话内有效」，而切房间本身就会重拉一次 rooms_list）
      await menuPick("刷新连接");
      out.tabOrderKeepsAcrossReload = roomIds().join("|") === orderAfterDrag.join("|");

      // ---- ③ 反向拖回来：最后一枚拖到最前，顺序恢复原样
      var backMid = await dragTab(allByTestId("db-room-tab").length - 1,
        rect(allByTestId("db-room-tab")[0]).left - 20);
      out.tabDragBackRestores = backMid.markers === 1 &&
        roomIds().join("|") === orderBefore.join("|");

      // ---- ④ 阈值以下 = 点击：3px 的位移不进入拖拽态，松手后的那一下照旧切房间。
      //      目标挑**不是当前激活的那一枚**：切没切房间从 data-active 与 rooms_connect
      //      的参数上直接看得出来（与前面几段留下的状态无关）。
      var clickTarget = allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") !== activeBefore;
      })[0];
      var clickRoomId = clickTarget.getAttribute("data-room-id");
      var clickBox = rect(clickTarget);
      pe("pointerdown", clickTarget, clickBox.left + 10, clickBox.top + clickBox.height / 2);
      pe("pointermove", window, clickBox.left + 13, clickBox.top + clickBox.height / 2);
      await sleep(90);
      out.tabPressUnderThresholdNoDrag =
        stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0;
      pe("pointerup", window, clickBox.left + 13, clickBox.top + clickBox.height / 2);
      await sleep(60);
      // 同一枚元素上「按下并松开」之后浏览器自己会发的那一下 click
      clickTarget.click();
      await sleep(1000);
      out.tabClickStillSwitches = activeRoomId() === clickRoomId &&
        lastConnectRoom() === Number(clickRoomId);
      // 切回来（后面几段按「激活项仍是原来那一枚」继续）
      allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === activeBefore;
      })[0].click();
      await sleep(1000);
      out.tabClickSwitchesBackOnMouse = activeRoomId() === activeBefore &&
        lastConnectRoom() === Number(activeBefore);

      // ---- ⑤ 触摸：横滑 = 滚标签条（不排序）；**按住**再动才是拖动排序
      var orderBeforeTouch = roomIds();
      var swipeMid = await dragTab(0, farRight(), "touch");
      out.tabTouchSwipeNotDrag = swipeMid.dragging === "false" && swipeMid.markers === 0 &&
        roomIds().join("|") === orderBeforeTouch.join("|");
      var holdMid = await dragTab(0, farRight(), "touch", 500);
      out.tabTouchHoldDrags = holdMid.dragging === "true" && holdMid.markers === 1;
      // 按住之后的那一次是**真的拖动了**（同样左移一位）
      var orderAfterHold = roomIds();
      out.tabTouchHoldReorders = orderAfterHold.join("|") !== orderBeforeTouch.join("|") &&
        orderAfterHold.every(function (id, index) {
          return id === orderBeforeTouch[(index + 1) % orderBeforeTouch.length];
        });

      // ---- ⑤b 触摸下「手势归谁」的对外可观察面：拿起来之后，容器上的 touchmove 必须被
      //      preventDefault（滚动收走），没拿起来时**不许**拦（横划是「看更多标签」的正路）。
      //      这两条是本次修复的回归闸：旧实现只靠 CSS 的 touch-action + pointermove
      //      上的 preventDefault，两个都拦不住滚动 —— 浏览器在 **touchstart 那一刻**就把
      //      touch-action 快照给手势识别器了。真机实测（Android WebView Chrome/124，
      //      CDP 注入真实触摸）：按住 400ms 拿起来后的**第一次** pointermove 就收到
      //      pointercancel，排序一次都没成过；而合成 PointerEvent 绕开了浏览器的手势管线，
      //      所以旧的真机故障在冒烟里一直照不出来 —— 这条断言量的是那条管线上的约定。
      var touchMoveProbe = function (target) {
        try {
          var ev = new TouchEvent("touchmove", { bubbles: true, cancelable: true });
          target.dispatchEvent(ev);
          return ev.defaultPrevented;
        } catch (e) {
          return "throw:" + e.message;
        }
      };
      var stripFirstTab = allByTestId("db-room-tab")[0];
      var stripFirstBox = rect(stripFirstTab);
      var stripFirstY = stripFirstBox.top + stripFirstBox.height / 2;
      out.tabTouchMoveFreeWhenIdle = touchMoveProbe(stripFirstTab) === false;
      pe("pointerdown", stripFirstTab, stripFirstBox.left + 10, stripFirstY, "touch");
      await sleep(500); // > TAB_HOLD_MS：已经拿起来了（拖拽态在画面上）
      out.tabTouchLiftedForProbe = stripEl.getAttribute("data-dragging") === "true";
      out.tabTouchMoveOwnedWhenLifted = touchMoveProbe(stripFirstTab) === true;
      pe("pointerup", stripFirstTab, stripFirstBox.left + 10, stripFirstY, "touch");
      await sleep(250);

      // ---- ⑤c 触摸**原地长按再松手**（慢点）= 仍然是点击：那一下 click 不许吞。
      //      旧实现只要越过 TAB_HOLD_MS 就举「吞 click」的旗，于是慢点一次都切不了房间
      //      （实测真机：click 事件照发，data-active 一动不动 —— 用户说「点了没反应」）。
      var slowTarget = allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") !== activeRoomId();
      })[0];
      var slowRoomId = slowTarget.getAttribute("data-room-id");
      var slowBox = rect(slowTarget);
      var slowY = slowBox.top + slowBox.height / 2;
      var connectsBeforeSlowTap = connectCalls();
      pe("pointerdown", slowTarget, slowBox.left + 12, slowY, "touch");
      await sleep(500);
      out.tabSlowTouchTapLifted = stripEl.getAttribute("data-dragging") === "true";
      pe("pointerup", slowTarget, slowBox.left + 12, slowY, "touch");
      await sleep(80);
      // 按下与松开落在同一枚上时，浏览器自己会补的那一下 click
      slowTarget.click();
      await sleep(900);
      out.tabSlowTouchTapSwitches = activeRoomId() === slowRoomId &&
        lastConnectRoom() === Number(slowRoomId) &&
        connectCalls() > connectsBeforeSlowTap;
      // 切回来：后面几段按「激活项还是原来那一枚」继续
      var backToActiveTab = allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === activeBefore;
      })[0];
      backToActiveTab.click();
      await sleep(1000);
      out.tabSlowTouchTapSwitchesBack = activeRoomId() === activeBefore;

      // ---- ⑤d 触摸**真的拖动过**之后：松手补发的那一下 click 必须吞掉（拖的是顺序，不是切房间）。
      //      这一段在同一栏里挪 90px（落点还是自己那一枚 = 顺序不动），随后手动补一发 click：
      //      它被吞掉的表现就是「一次 rooms_connect 都没发、激活项没变」。
      var dragAwayTab = allByTestId("db-room-tab")[0];
      var dragAwayBox = rect(dragAwayTab);
      var dragAwayY = dragAwayBox.top + dragAwayBox.height / 2;
      var connectsBeforeTouchDrag = connectCalls();
      var activeBeforeTouchDrag = activeRoomId();
      pe("pointerdown", dragAwayTab, dragAwayBox.left + 10, dragAwayY, "touch");
      await sleep(500);
      pe("pointermove", window, dragAwayBox.left + 100, dragAwayY, "touch");
      await sleep(90);
      pe("pointerup", dragAwayTab, dragAwayBox.left + 100, dragAwayY, "touch");
      await sleep(80);
      dragAwayTab.click();
      await sleep(700);
      out.tabTouchDragSwallowsFollowUpClick =
        connectCalls() === connectsBeforeTouchDrag && activeRoomId() === activeBeforeTouchDrag;

      // ---- ⑤e 阈值边界：**没到** TAB_DRAG_THRESHOLD_PX（5px）不算拖（4px 不行、6px 行）。
      //      上一条只量了 3px 那一侧（tabPressUnderThresholdNoDrag），这里把另一侧也钉住，
      //      阈值本身就成了对外可观察的行为而不是一个常量。
      var edgeTab = allByTestId("db-room-tab")[0];
      var edgeBox = rect(edgeTab);
      var edgeY = edgeBox.top + edgeBox.height / 2;
      pe("pointerdown", edgeTab, edgeBox.left + 10, edgeY, "mouse");
      pe("pointermove", window, edgeBox.left + 14, edgeY, "mouse");
      await sleep(90);
      out.tabBelowThresholdNoDrag = stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0;
      pe("pointermove", window, edgeBox.left + 16, edgeY, "mouse");
      await sleep(90);
      out.tabAboveThresholdDrags = stripEl.getAttribute("data-dragging") === "true";
      pe("pointerup", window, edgeBox.left + 16, edgeY, "mouse");
      await sleep(250);
      // 这一拖是**真的拖过**（越过阈值、也 move 过）：它举起了「吞下一发 click」的旗。
      // 点**当前这一枚**把它消费掉（原地重开一次、不换房间、顺序也不动），
      // 免得后面几段里第一次点标签被它吃掉（④ 那段同样的道理）。
      allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === activeRoomId();
      })[0].click();
      await sleep(250);

      // ---- ⑥ 开 20 个房间：标签条**横向滚动**，每枚标签**不被压缩**（各保自己的最小宽度）
      window.__addRooms(20);
      await menuPick("刷新连接");
      var tabsNow = allByTestId("db-room-tab");
      var widths = tabsNow.map(function (t) { return rect(t).width; });
      var minTabW = cssLengthOf("--tab-min-w");
      out.tabMinWidthPx = Math.round(minTabW * 10) / 10;
      out.tabStripScrolls = tabsNow.length >= 20 &&
        getComputedStyle(stripEl).overflowX === "auto" && minTabW > 0 &&
        stripEl.scrollWidth > stripEl.clientWidth + 1;
      out.tabWidthsNotSqueezed = widths.length === tabsNow.length && minTabW > 0 &&
        Math.min.apply(null, widths) >= minTabW - 0.6;
      // 「没挤在一起」的另一半：它们是真的溢出去了，而不是被压回容器宽度里
      out.tabWidthsSumOverflowsStrip =
        widths.reduce(function (sum, w) { return sum + w; }, 0) > stripEl.clientWidth;
      // 滚到末尾：最后一枚完整可见（开再多也拿得到）
      stripEl.scrollLeft = stripEl.scrollWidth;
      await sleep(250);
      var lastTabNow = allByTestId("db-room-tab").slice(-1)[0];
      out.tabStripScrollsToEnd = stripEl.scrollLeft > 0 &&
        rect(lastTabNow).right <= rect(stripEl).right + 1 &&
        rect(lastTabNow).left >= rect(stripEl).left - 1;

      // ---- ⑥b 标签条**不画滚动条**（用户 2026-09-16 第 1 条：「顶部 tab 滚动的时候不要有滑块，
      //      会挡住，能隐藏掉吗」），但横向照旧能滚。
      //      判「滚动条有没有占位」不能用 clientHeight === offsetHeight：这个容器的高度是**由标签
      //      撑开**的（没有固定高度 + 只横向滚），占位式滚动条会把容器一并撑高，两者的差始终只剩
      //      那 1px 底边框。真正的判据是「标签底边 → 容器内底边」那一段：不画滚动条时恒为 0，
      //      画了占位式横向滚动条时正好是一条滚动条的厚度。
      var stripStyle = getComputedStyle(stripEl);
      var stripBorderBottom = parseFloat(stripStyle.borderBottomWidth) || 0;
      var tabsBottomEdge = Math.max.apply(null, allByTestId("db-room-tab").map(function (t) {
        return rect(t).bottom;
      }));
      out.tabStripScrollbarThicknessPx =
        Math.round((rect(stripEl).bottom - stripBorderBottom - tabsBottomEdge) * 10) / 10;
      out.tabStripNoScrollbarSpace = out.tabStripScrollbarThicknessPx <= 0.5 &&
        stripStyle.getPropertyValue("scrollbar-width").trim() === "none";
      // （scrollbar-width 取的是**引擎算出来的**值（走 getPropertyValue，不看 JS 侧有没有这个
      //   属性名）：覆盖式滚动条的引擎本来就不占位，只靠几何量不出「滑块还会不会飘到标签上」，
      //   这条是它唯一的可观察面。）
      stripEl.scrollLeft = 0;
      await sleep(150);
      out.tabStripScrollsWithHiddenScrollbar = stripEl.scrollLeft === 0 &&
        (function () {
          stripEl.scrollLeft = Math.round((stripEl.scrollWidth - stripEl.clientWidth) / 2);
          return stripEl.scrollLeft > 0;
        })();
      stripEl.scrollLeft = 0;
      await sleep(150);

      // ---- ⑦ 拖动中被拖的那个房间被**关掉**（上游快照不再包含它）：整次拖动作废 ——
      //      指示条收掉、顺序不动，松手也不落位。
      stripEl.scrollLeft = 0;
      await sleep(250);
      var orderBeforeKill = tabNames();
      var victimName = "房间 6004";
      var victimIndex = orderBeforeKill.indexOf(victimName);
      var victim = allByTestId("db-room-tab")[victimIndex];
      if (!victim) throw new Error("找不到被关掉的样本标签 " + victimName + "（__addRooms 没生效？）");
      var victimBox = rect(victim);
      pe("pointerdown", victim, victimBox.left + 10, victimBox.top + victimBox.height / 2);
      pe("pointermove", window, victimBox.left + 60, victimBox.top + victimBox.height / 2);
      await sleep(150);
      out.tabKillDragLifted = victimIndex >= 0 &&
        stripEl.getAttribute("data-dragging") === "true";
      window.__dropRoom(6004);
      await menuPick("刷新连接");
      out.tabDragAbortsWhenRoomClosed = victimIndex >= 0 &&
        stripEl.getAttribute("data-dragging") === "false" &&
        allByTestId("db-tab-drop").length === 0 &&
        tabNames().indexOf(victimName) < 0 &&
        tabNames().join("|") === orderBeforeKill.filter(function (n) {
          return n !== victimName;
        }).join("|");
      pe("pointerup", window, victimBox.left + 60, victimBox.top + victimBox.height / 2);
      await sleep(200);
      out.tabDragAbortKeepsOrder = tabNames().join("|") === orderBeforeKill.filter(function (n) {
        return n !== victimName;
      }).join("|");

      // 收尾仍停在**未连接（灰）**那一档（同上一条尾注）：这一段点过标签、刷过连接，
      // 连接态会被替身推成 connected，这里显式复位，最后那张截图仍然看得到灰点。
      // （当前激活那个房间号从 data-active 上取 —— 不假设是哪一间。）
      [Number(activeRoomId()), fixtureRoom.room_id, 5555].forEach(function (id) {
        if (!id) return;
        window.__emit("danmubox://status", { room_id: id, state: "disconnected", detail: "" });
        window.__emit("danmubox://room", {
          room_id: id, live_status: fixtureRoom.live_status, connected: false,
        });
      });
      await sleep(300);
      snap();
      tabDragBlockRan = true;
    } catch (e) {
      out.tabDragBlockError = String((e && e.stack) || e);
    }
    out.tabDragBlockRan = tabDragBlockRan;

    // 收尾就停在**未连接（灰）**那一档：最后那张截图因此看得到灰点（两处都是灰的）。
    snap();

    // ================= 共享分区：分割条与长按换位（issue #8，用户 2026-09-16）=================
    //
    // 这一段的两条手势都是**指针事件**（鼠标与触摸走同一条路，见 SplitPanes.tsx），场景里按真实
    // 序列派发：pointerdown →（长按 0.5s）pointermove → pointerup。派发目标是「按下落在那一栏 /
    // 分割条上（React 的 onPointerDown 就挂在它们身上），之后的 move / up 落在 window（组件在
    // 拖动期间挂的就是 window 级监听）」—— 与真手指走出的是同一批监听器。运行器只送 click 与
    // 取快照，没有真实指针通道，所以这是页面内能给出的最接近的一次（与既有 pointerdown 断言同一手法）。
    // 注意这一整段活在模板字符串里：**反引号与反斜杠转义都不能写**（见文件头的维护约定）。
    var firePointer = function (target, type, x, y, kind) {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 77, pointerType: kind || "touch",
        clientX: Math.round(x), clientY: Math.round(y),
      }));
    };
    // 量出来的**份额**：礼物栏高度 / 可用高度（分区高度减去分割条）。这就是「指针意图」落在
    // 屏幕上的那一份，用它跟落盘的值对账。
    var shownRatio = function () {
      var panesBox = rect(byTestId("db-panes"));
      var splitBox = rect(byTestId("db-pane-splitter"));
      if (!panesBox || !splitBox) return null;
      return Math.round((rect(byTestId("db-pane-gift")).height / (panesBox.height - splitBox.height)) * 1000) / 1000;
    };
    var splitterMid = function () {
      var box = rect(byTestId("db-pane-splitter"));
      return box ? box.top + box.height / 2 : 0;
    };
    // 这一下就是「点面板外面」那条路：把可能还开着的面板收掉，免得分区被面板压着、几何不干净
    if (byTestId("db-panel")) {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
    }
    // 归一形态：礼物栏折叠（点折叠头收起；它顺带收起别的面板）
    if (byTestId("db-gift-area")) {
      byTestId("db-gift-dock").click();
      await sleep(350);
    }
    var panesBox0 = rect(byTestId("db-panes"));
    var splitBox0 = rect(byTestId("db-pane-splitter"));
    var giftBox0 = rect(byTestId("db-pane-gift"));
    var danmakuBox0 = rect(byTestId("db-pane-danmaku"));
    var headBox0 = rect(byTestId("db-gift-dock"));
    var ratioAtEntry = window.__prefs["ui.gift_pane_ratio"];
    var splitX = panesBox0.left + panesBox0.width / 2;

    out.splitterPresent = !!splitBox0 && !!giftBox0 && !!danmakuBox0 &&
      byTestId("db-panes").getAttribute("data-gift") === "on";
    out.splitterHitAreaPx = Math.round(splitBox0.height * 10) / 10;
    out.splitterHitAreaAtLeast8 = splitBox0.height >= 8;
    // 默认顺序：弹幕在上、礼物在下（契约 §8 的默认值 = 与改前一致的那个形态）
    out.splitterDefaultOrderGiftBelow =
      danmakuBox0.bottom <= splitBox0.top + 1 && splitBox0.bottom <= giftBox0.top + 1;
    // 折叠态：礼物栏只有折叠头那么高（「礼物栏不小于它的折叠头」这条约束的常态）
    out.splitterCollapsedGiftIsHeadHeight = !byTestId("db-gift-area") &&
      Math.abs(giftBox0.height - headBox0.height) <= 1;
    out.splitterDefaultRatioPref = ratioAtEntry;
    out.splitterDefaultOnTopPref = window.__prefs["ui.gift_pane_on_top"] === false;

    // ---- 拖动分割条（鼠标指针这一路）：实时改比例、折叠态下「拖开就展开」、松手才落盘 ----
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid(), "mouse");
    firePointer(window, "pointermove", splitX, splitterMid() - 100, "mouse");
    // 折叠态下的这一次移动会顺手把礼物栏**展开**（onExpand → setState），展开要等 React 重渲染
    // 之后才看得见；同步读几何会读到展开前的那一帧（页面内派发没有真实输入那一趟往返）。
    await sleep(80);
    var midGiftBox = rect(byTestId("db-pane-gift"));
    out.splitterDragLiveGrewPx = Math.round(midGiftBox.height - giftBox0.height);
    out.splitterDragLiveExpandsPane = !!byTestId("db-gift-area");
    out.splitterDragLiveGrew = midGiftBox.height > giftBox0.height + 80;
    // 拖动中**一帧都不写 store**：磁盘上还是进来时那一份
    out.splitterDragLiveWithoutStore = window.__prefs["ui.gift_pane_ratio"] === ratioAtEntry;
    firePointer(window, "pointerup", splitX, splitterMid() - 100, "mouse");
    await sleep(450);
    var draggedRatio = shownRatio();
    out.splitterDraggedRatioShown = draggedRatio;
    out.splitterDragPersistsRatio = !!draggedRatio &&
      Math.abs(window.__prefs["ui.gift_pane_ratio"] - draggedRatio) < 0.02;
    // 「涨了」要比**当时屏幕上的那一份**：折叠态下这一栏只有折叠头那么高（份额约 0.04），
    // 而 ratioAtEntry 是「上次拖到哪儿」的意图、折叠时并没有落到屏幕上（0.35 那个数在
    // 折叠态下看不见），拿它当基准会把「确实长大了」判成没长。
    var shownAtEntry = giftBox0.height / (panesBox0.height - splitBox0.height);
    out.splitterDragGrewOnScreen = !!draggedRatio && draggedRatio > shownAtEntry + 0.05;
    snap();

    // ---- 切到另一个房间标签再切回来：RoomView 的**本地状态**复位（room_id 那条 effect：
    //      礼物栏回到折叠、面板收起…），输入区那份比例落在 prefs 上、因此原样保持。
    // ⚠ 判据不能要求「标签条上正好两枚」：这一段跑在**标签条拖动那一段之后**，
    //   那一段用 __addRooms(n) 又开了好几个房间，标签数早就不是 2 了 ——
    //   旧写法（length === 2）于是恒为假，三条件一起红，还把「本地状态复位」这条口径
    //   悄悄跳过（实测两引擎 × 两个视口全红）。改成**按标签自己的 data-active 找当前房间**，
    //   再挑一枚别的房间，与标签数无关。
    var tabsForRemount = allByTestId("db-room-tab");
    var activeTabForRemount = tabsForRemount.filter(function (t) {
      return t.getAttribute("data-active") === "true";
    })[0];
    var otherTabForRemount = tabsForRemount.filter(function (t) {
      return t !== activeTabForRemount;
    })[0];
    var remountAvailable = !!activeTabForRemount && !!otherTabForRemount;
    var tabByRoomId = function (roomId) {
      return allByTestId("db-room-tab").filter(function (t) {
        return t.getAttribute("data-room-id") === roomId;
      })[0];
    };
    if (remountAvailable) {
      var remountRoomId = activeTabForRemount.getAttribute("data-room-id");
      var otherRoomId = otherTabForRemount.getAttribute("data-room-id");
      // ⚠ 先点一次**当前这一枚**标签，把标签条的「吞掉这一下 click」标志消费掉：标签条拖动
      //    那一段（排在文件里本段之前）用真实指针事件做了好几次拖动排序，而真实浏览器在
      //    pointerup 之后**还会补一发 click**（App 的 swallowClick 就是为它准备的：拖完不许
      //    顺手切房间），场景里没有补那一发，于是那个标志一直挂着 true，会把**紧接着的第一次**
      //    标签点击吞掉 —— 本段第一次点「别的房间」正好撞上。实测：activeAfterOther 仍是 5440，
      //    房间根本没换，下面两条断言（折叠态 / 比例保持）跟着一起红。点自己这一枚不换房间，
      //    正好当消费；标志为假时它也只是原地重开一次，无副作用。
      activeTabForRemount.click();
      await sleep(250);
      var remountProbe = {
        activeBefore: remountRoomId,
        other: otherRoomId,
        giftBodyBefore: !!byTestId("db-gift-area"),
        giftHeightBefore: Math.round(rect(byTestId("db-pane-gift")).height * 10) / 10,
        headHeightBefore: Math.round(headBox0.height * 10) / 10,
        ratioPrefBefore: window.__prefs["ui.gift_pane_ratio"],
      };
      otherTabForRemount.click();
      await sleep(700);
      remountProbe.activeAfterOther = (function () {
        var t = allByTestId("db-room-tab").filter(function (x) {
          return x.getAttribute("data-active") === "true";
        })[0];
        return t ? t.getAttribute("data-room-id") : null;
      })();
      remountProbe.giftBodyAfterOther = !!byTestId("db-gift-area");
      tabByRoomId(remountRoomId).click();
      await sleep(900);
      remountProbe.activeAfterBack = (function () {
        var t = allByTestId("db-room-tab").filter(function (x) {
          return x.getAttribute("data-active") === "true";
        })[0];
        return t ? t.getAttribute("data-room-id") : null;
      })();
      remountProbe.giftBodyAfterBack = !!byTestId("db-gift-area");
      remountProbe.giftHeightAfterBack = byTestId("db-pane-gift")
        ? Math.round(rect(byTestId("db-pane-gift")).height * 10) / 10 : null;
      remountProbe.ratioPrefAfterBack = window.__prefs["ui.gift_pane_ratio"];
      out.splitterRemountProbe = remountProbe;
    }
    // 切房那一趟做得出来才算数（标签条上至少要有两枚、且能认出当前那一枚）；
    // 做不出就是夹具的事，明着写出来，不把它悄悄放过 —— 与 tabs 那一段的 tabsRendered 同一条口径。
    out.splitterRemountAvailable = remountAvailable;
    out.splitterCollapsedAfterRemount = remountAvailable && !byTestId("db-gift-area") &&
      Math.abs(rect(byTestId("db-pane-gift")).height - headBox0.height) <= 1;
    byTestId("db-gift-dock").click();
    await sleep(400);
    var remountedRatio = shownRatio();
    out.splitterRatioSurvivesRemount = remountAvailable && !!remountedRatio && !!draggedRatio &&
      Math.abs(remountedRatio - draggedRatio) < 0.02 &&
      Math.abs(remountedRatio - window.__prefs["ui.gift_pane_ratio"]) < 0.02;
    snap();

    // ---- 拖到极限（向上）：弹幕区不小于 **3 行**、整块不溢出 ----
    var rowHeights = rows().map(function (r) { return rect(r).height; });
    var minRow = Math.min.apply(null, rowHeights);
    var panesBox1 = rect(byTestId("db-panes"));
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, panesBox1.top - 300);
    firePointer(window, "pointerup", splitX, panesBox1.top - 300);
    await sleep(450);
    var upDanmaku = rect(byTestId("db-pane-danmaku"));
    var upGift = rect(byTestId("db-pane-gift"));
    var upSplit = rect(byTestId("db-pane-splitter"));
    out.splitterMinRowHeightPx = Math.round(minRow * 10) / 10;
    out.splitterExtremeUpKeepsThreeRows = upDanmaku.height >= 3 * minRow - 8;
    out.splitterExtremeUpNoOverflow =
      Math.abs(upGift.height + upSplit.height + upDanmaku.height - panesBox1.height) <= 1;
    out.splitterExtremeUpClampedRatio = window.__prefs["ui.gift_pane_ratio"] === 0.9;

    // ---- 拖到极限（向下）：礼物栏不小于它的折叠头 ----
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, panesBox1.bottom + 300);
    firePointer(window, "pointerup", splitX, panesBox1.bottom + 300);
    await sleep(450);
    var downGift = rect(byTestId("db-pane-gift"));
    var downHead = rect(byTestId("db-gift-dock"));
    out.splitterExtremeDownKeepsHead = downGift.height >= downHead.height - 1 && downHead.height > 0;
    out.splitterExtremeDownClampedRatio = window.__prefs["ui.gift_pane_ratio"] === 0.1;

    // ---- 键盘可达：分割条可聚焦，↑↓ 每次微调 0.02，连按只有最后一次落盘 ----
    var splitterEl = byTestId("db-pane-splitter");
    out.splitterIsSeparator = splitterEl.getAttribute("role") === "separator" &&
      splitterEl.getAttribute("tabindex") === "0" &&
      splitterEl.getAttribute("aria-orientation") === "horizontal" &&
      splitterEl.getAttribute("aria-valuenow") !== null;
    var ratioBeforeKeys = window.__prefs["ui.gift_pane_ratio"];
    pressKey(splitterEl, "ArrowUp");
    pressKey(splitterEl, "ArrowUp");
    await sleep(900);
    out.splitterKeyboardAdjustsRatio =
      Math.abs(window.__prefs["ui.gift_pane_ratio"] - (ratioBeforeKeys + 0.04)) < 0.001;
    out.splitterKeyboardReflectsOnScreen =
      Math.abs(shownRatio() - window.__prefs["ui.gift_pane_ratio"]) < 0.02;
    snap();

    // ---- 长按换位（触摸指针这一路）：按住 0.62s → 该栏半透明跟随指针 → 拖过另一栏松手 = 互换 ----
    var giftBoxSwap = rect(byTestId("db-pane-gift"));
    var danmakuBoxSwap = rect(byTestId("db-pane-danmaku"));
    var ratioBeforeSwap = window.__prefs["ui.gift_pane_ratio"];
    var giftHeightBeforeSwap = giftBoxSwap.height;
    firePointer(byTestId("db-pane-danmaku"), "pointerdown", splitX, danmakuBoxSwap.top + 30);
    await sleep(620);
    out.swapDragArmed = byTestId("db-pane-danmaku").getAttribute("data-swap-drag") === "true";
    firePointer(window, "pointermove", splitX, giftBoxSwap.bottom - 4);
    await sleep(80); // 落点提示（data-swap-over）是 setState 换出来的，要等一次重渲染
    var draggedStyle = getComputedStyle(byTestId("db-pane-danmaku"));
    out.swapDragTranslucentFollowing = draggedStyle.transform !== "none" &&
      parseFloat(draggedStyle.opacity) < 1;
    out.swapDropTargetHinted = byTestId("db-pane-gift").getAttribute("data-swap-over") === "true";
    firePointer(window, "pointerup", splitX, giftBoxSwap.bottom - 4);
    await sleep(450);
    var afterSwapGift = rect(byTestId("db-pane-gift"));
    var afterSwapSplit = rect(byTestId("db-pane-splitter"));
    var afterSwapDanmaku = rect(byTestId("db-pane-danmaku"));
    out.swapByLongPress = window.__prefs["ui.gift_pane_on_top"] === true &&
      afterSwapGift.bottom <= afterSwapSplit.top + 1 &&
      afterSwapSplit.bottom <= afterSwapDanmaku.top + 1;
    // 换位**不改比例**：礼物栏高度一个像素都不变，只是挪到了上面（契约 §8 / ui.md §5.4 的口径）
    out.swapKeepsRatio = window.__prefs["ui.gift_pane_ratio"] === ratioBeforeSwap &&
      Math.abs(afterSwapGift.height - giftHeightBeforeSwap) <= 2;
    snap();

    // ---- 三种「不算长按」/「取消」的路：短按、按住前就移动（在滚列表）、ESC ----
    firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, rect(byTestId("db-pane-gift")).top + 6);
    await sleep(300);
    firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
    firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
    await sleep(350);
    out.swapIgnoresShortPress = byTestId("db-pane-gift").getAttribute("data-swap-drag") === null &&
      window.__prefs["ui.gift_pane_on_top"] === true;

    firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, rect(byTestId("db-pane-gift")).top + 6);
    firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-gift")).top + 60);
    await sleep(700);
    out.swapIgnoresMoveBeforeHold = byTestId("db-pane-gift").getAttribute("data-swap-drag") === null;
    firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-gift")).top + 60);
    await sleep(300);
    out.swapStillDefaultAfterIgnoredGestures = window.__prefs["ui.gift_pane_on_top"] === true;

    firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, rect(byTestId("db-pane-gift")).top + 6);
    await sleep(620);
    var escArmed = byTestId("db-pane-gift").getAttribute("data-swap-drag") === "true";
    firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-danmaku")).top + 40);
    pressEscape();
    await sleep(200);
    out.swapCancelsOnEscape = escArmed &&
      byTestId("db-pane-gift").getAttribute("data-swap-drag") === null &&
      byTestId("db-pane-danmaku").getAttribute("data-swap-over") === null;
    firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-danmaku")).top + 40);
    await sleep(350);
    out.swapStaysCancelled = window.__prefs["ui.gift_pane_on_top"] === true;
    snap();

    // ---- 「触摸上手势归谁」的对外可观察面（本次修复的回归闸）：拿起来之后，区块上的
    //      touchmove 必须被 preventDefault（滚动收走），没拿起来时**不许**拦
    //      （弹幕列表照旧滚）。旧实现只靠 CSS 的 touch-action 与 pointermove.preventDefault()，
    //      两个都拦不住滚动 —— 浏览器在 **touchstart 那一刻**就把 touch-action 快照走了。
    //      真机实测（Android WebView Chrome/124，CDP 注入真实触摸）：按住 560ms 进入换位态后
    //      第一次 pointermove 就收到 pointercancel，换位一次都没成过；而合成 PointerEvent
    //      绕开了浏览器的手势管线，所以这个真机故障在冒烟里一直照不出来。
    var paneTouchMoveProbe = function (target) {
      try {
        var ev = new TouchEvent("touchmove", { bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      } catch (e) {
        return "throw:" + e.message;
      }
    };
    var danmakuProbeEl = byTestId("db-pane-danmaku");
    var danmakuProbeBox = rect(danmakuProbeEl);
    out.swapTouchMoveFreeWhenIdle = paneTouchMoveProbe(danmakuProbeEl) === false;
    var dockBoxBeforeNextTap = rect(byTestId("db-gift-dock"));
    // 「折叠头开合」的量法 = 这一栏自己那两枚钩子：列表根 db-gift-area（**展开才在场上**，
    // 见 docs/ui.md §5.3）与折叠头的 aria-expanded。**不能**拿 db-gift-body 当折叠状态：
    // 那是**行内**的正文格（MessageRow 的 t("body")，同 §5.3 的钩子表），只有「本来就有礼物行」
    // 时才存在；本段跑在送礼那几段之后、当前房间里礼物列表已空，开合两态都取不到它 ——
    // 断言于是恒为 false（本轮首次真跑就是这么红的：swapDoesNotEatNextTap=false，
    // 与「那一下 click 有没有被吞」无关）。
    var giftFoldBeforeNextTap = [
      !!byTestId("db-gift-area"),
      byTestId("db-gift-dock").getAttribute("aria-expanded"),
    ];
    firePointer(danmakuProbeEl, "pointerdown", splitX, danmakuProbeBox.top + 30);
    await sleep(620);
    out.swapTouchMoveOwnedWhenArmed = paneTouchMoveProbe(danmakuProbeEl) === true;
    // 同一栏里挪一小段（不越过分割条 = 不换位），松手
    firePointer(window, "pointermove", splitX, danmakuProbeBox.top + 60);
    await sleep(80);
    firePointer(window, "pointerup", splitX, danmakuProbeBox.top + 60);
    // ---- 紧接着（旧实现 600ms 兜底窗口**之内**）真的按一下礼物折叠头：它必须照旧开合。
    //      旧实现用一个 600ms 的全局捕获定时器去猜「那一下 click 来没来」，这段时间里
    //      任何一处点击都会被吃掉（冒烟里的 panelBackOnCommon 就是这么假失败的）。
    //      这里按下 -> 抬起 -> click 三步齐全，与用户真按一次完全同形。
    await sleep(120);
    firePointer(byTestId("db-gift-dock"), "pointerdown",
      dockBoxBeforeNextTap.left + dockBoxBeforeNextTap.width / 2,
      dockBoxBeforeNextTap.top + dockBoxBeforeNextTap.height / 2);
    firePointer(byTestId("db-gift-dock"), "pointerup",
      dockBoxBeforeNextTap.left + dockBoxBeforeNextTap.width / 2,
      dockBoxBeforeNextTap.top + dockBoxBeforeNextTap.height / 2);
    byTestId("db-gift-dock").click();
    await sleep(400);
    out.swapDoesNotEatNextTap = (!!byTestId("db-gift-area") !== giftFoldBeforeNextTap[0]) &&
      (byTestId("db-gift-dock").getAttribute("aria-expanded") !== giftFoldBeforeNextTap[1]);
    snap();

    // ---- 关掉独立礼物栏：分区退化为弹幕区全高、分割条与礼物栏一起消失、换位随之停用 ----
    var giftSwitchOff = setGiftSwitch("独立礼物栏", false);
    if (!giftSwitchOff) {
      // 面板可能关着、也可能开着别的那个：先点面板外收干净，再明确开筛选面板重来一次
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(300);
      clickTool("筛选");
      await sleep(350);
      giftSwitchOff = setGiftSwitch("独立礼物栏", false);
    }
    if (!giftSwitchOff) {
      // 还是没摸到那枚开关：把现场留下来（值字段，不是断言），免得只剩一个 false 无从判断
      var panelNow = byTestId("db-panel");
      var toolsNow = byTestId("db-composer-tools");
      out.splitterGiftSwitchDiag = {
        panel: !!panelNow,
        labels: panelNow
          ? [].slice.call(panelNow.querySelectorAll("label")).map(function (l) { return l.innerText.trim(); })
          : [],
        tools: toolsNow
          ? [].slice.call(toolsNow.querySelectorAll("button")).map(function (b) { return b.innerText.trim(); })
          : [],
      };
    }
    await sleep(450);
    var offPanes = rect(byTestId("db-panes"));
    var offDanmaku = rect(byTestId("db-pane-danmaku"));
    out.splitterGiftSwitchOffTouched = giftSwitchOff;
    out.splitterGoneWhenGiftPanelOff = !byTestId("db-pane-splitter") && !byTestId("db-pane-gift");
    out.splitterRegionGivesAllToDanmaku = !!offPanes && !!offDanmaku &&
      Math.abs(offDanmaku.height - offPanes.height) <= 1;
    // 没有另一栏可换：长按下去不该有任何动静（也不该抛）
    firePointer(byTestId("db-pane-danmaku"), "pointerdown", splitX, offDanmaku.top + 30);
    await sleep(620);
    out.splitterSwapInertWithoutGiftPane =
      byTestId("db-pane-danmaku").getAttribute("data-swap-drag") === null;
    firePointer(window, "pointerup", splitX, offDanmaku.bottom - 20);
    await sleep(300);
    out.splitterNoCrashWithoutGiftPane = !!byTestId("db-room-header");

    // ---- 收尾：礼物栏开回来，并把两枚键恢复默认（份额 0.35、礼物在下）----
    if (!byTestId("db-panel")) {
      clickTool("筛选");
      await sleep(350);
    }
    var giftSwitchBackOn = setGiftSwitch("独立礼物栏", true);
    if (!giftSwitchBackOn) {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await sleep(250);
      clickTool("筛选");
      await sleep(350);
      giftSwitchBackOn = setGiftSwitch("独立礼物栏", true);
    }
    out.splitterGiftSwitchBackOn = giftSwitchBackOn;
    await sleep(450);
    out.splitterRestoredPane = !!byTestId("db-pane-splitter") && !!byTestId("db-pane-gift") &&
      window.__prefs["ui.gift_panel"] === true;
    if (window.__prefs["ui.gift_pane_on_top"] === true) {
      var giftBoxBack = rect(byTestId("db-pane-gift"));
      firePointer(byTestId("db-pane-gift"), "pointerdown", splitX, giftBoxBack.top + 6);
      await sleep(620);
      firePointer(window, "pointermove", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
      firePointer(window, "pointerup", splitX, rect(byTestId("db-pane-danmaku")).bottom - 20);
      await sleep(450);
    }
    var panesBoxEnd = rect(byTestId("db-panes"));
    var splitBoxEnd = rect(byTestId("db-pane-splitter"));
    var targetY = panesBoxEnd.top + splitBoxEnd.height / 2 +
      (panesBoxEnd.height - splitBoxEnd.height) * (1 - 0.35);
    firePointer(byTestId("db-pane-splitter"), "pointerdown", splitX, splitterMid());
    firePointer(window, "pointermove", splitX, targetY);
    firePointer(window, "pointerup", splitX, targetY);
    await sleep(450);
    out.splitterRestoredRatio = Math.abs(window.__prefs["ui.gift_pane_ratio"] - 0.35) < 0.02;
    out.splitterRestoredOrder = window.__prefs["ui.gift_pane_on_top"] === false;
    out.splitterRestoredShownRatio = Math.abs(shownRatio() - 0.35) < 0.02;
    snap();

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

    var cheapPush = function (kind, content, amount, extra) {
      window.__emit("danmubox://message", window.__mk(kind, content, false,
        Object.assign({ room_id: CHEAP_ROOM, amount: amount }, extra || {})));
    };
    var cheapRowCount = function () { return allByTestId("db-gift-row").length; };
    var cheapPaneText = function () {
      var el = byTestId("db-pane-gift");
      return el ? el.innerText : "";
    };
    var cheapSummary = function () {
      var el = byTestId("db-gift-summary");
      return el ? el.innerText.trim() : null;
    };
    var cheapDockText = function () {
      var el = byTestId("db-gift-dock");
      return el ? el.innerText : "";
    };
    var cheapPanelOpen = function () { return !!byTestId("db-panel"); };
    var cheapSetPanel = async function (open) {
      if (cheapPanelOpen() !== open) {
        clickTool("筛选");
        await sleep(400);
      }
      return cheapPanelOpen() === open;
    };
    // 礼物栏折叠头的开合走 aria-expanded（它本来就是这枚按钮的语义钩子，礼物栏票沿用）
    var cheapPaneExpanded = function () {
      var dock = byTestId("db-gift-dock");
      return !!dock && dock.getAttribute("aria-expanded") === "true";
    };
    var cheapSetPane = async function (open) {
      if (cheapPaneExpanded() !== open && byTestId("db-gift-dock")) {
        byTestId("db-gift-dock").click();
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
      cheapSummary() === "本场 礼物 3 · 0.3 元";
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
      out.cheapGiftSummaryAfterExclude === "本场 礼物 1 · 0.11 元" &&
      cheapDockText().indexOf("（1）") >= 0 &&
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
    out.cheapGiftZeroPriceNotCheap =
      out.cheapGiftSummaryBoundary === "本场 礼物 2 · 0.11 元 / SC 1 · 30 元 / 大航海 1 · 138 元";
    var cheapScGuardTail = function (txt) {
      var at = txt ? txt.indexOf("SC ") : -1;
      return at >= 0 ? txt.slice(at) : null;
    };
    var cheapScGuardExcludeOnly = cheapScGuardTail(out.cheapGiftSummaryBoundary);
    // 两枚都开：统计口径与「只开剔除」逐字相同（折叠不改统计），SC / 大航海两组也逐字相同。
    await cheapSetPanel(true);
    var cheapFoldOnAgain = setGiftSwitch("折叠低价礼物", true);
    await sleep(400);
    await cheapSetPanel(false);
    await cheapSetPane(true);
    out.cheapGiftBothOnSummary = cheapSummary();
    out.cheapGiftBothOnStatsUnchanged = cheapFoldOnAgain &&
      cheapSummary() === out.cheapGiftSummaryBoundary;
    out.cheapGiftScGuardUntouched = cheapScGuardExcludeOnly === "SC 1 · 30 元 / 大航海 1 · 138 元" &&
      cheapScGuardTail(cheapSummary()) === cheapScGuardExcludeOnly;

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

    /* ---- 开播 / 下播的状态自动更新（用户 2026-09-16：「在开播下播时，状态不会自动更新，
       打开的房间应该实时更新状态，列表应该定期查询状态」）。

       ① **实时那条**：长连接里的 LIVE / PREPARING 到达时，后端把房间的 live_status 改掉并推
          一条 danmubox://room（契约 §6/§7）。界面这一侧要证明的是「一个事件 → 看得见的地方
          **全都**跟着变」：房间头那颗状态点、房间标签页那颗圆点（同一个 liveKindOf，两处必然
          同色）。这一块**只推事件** —— 不重连、不点任何刷新、不重开房间。
       ② **列表那条**：停在列表页时界面自己按周期问上游（周期 / 不可见不拉 / 失败退避的数值
          由探针实测，本场景不引入 30 秒级等待 —— 那会把每次冒烟都拖长一分钟以上）。这里钉的是
          机制：进列表页会立即拍一拍、进房间就停、拉回来的值真的落到卡片与关注行上。

       前提：账号那一段最后**退成了游客态**（那是有意为之，见 accountBackToGuest），而这两条
       都要在登录态下才完整（关注那一份要登录）。所以先走一次真实的新增账号流程 --
       替身会在第 2 次轮询（2 秒一次）时确认，和用户自己扫出来的那条路完全一样。 */
    /* 【本票代修 · LiveStatus 票（批次 2609162141）那一段的准入前提】这一整段的前提是「界面停在
       **列表页**」（db-account / db-account-add 只渲染在 RoomList 里），但上一段（cheapgift）的收尾
       是切回房间标签、界面此时在**房间页** —— 直接点 db-account 会抛 TypeError，而这一段此前没有
       try/catch 包着，整场场景当场死掉（表现是 run-headless 报「视口未跑完（超时）」，本轮实测）。
       两处修补都只动**前提与兜底**、断言一行未动（按 LiveStatus 作者给的口径）：
       ① 先确保停在列表页（回列表页只有「返回键」这一条路，它在房间页里必然存在）；
       ② 同款 try/catch + roomStatusBlockRan —— 它**要求为真**，块中途抛错时显式置 false，
          不许「块没跑」静默通过；catch 落在 __smoke_run 之内、out.done 之前，抛错也要产出快照。
       留 LiveStatus 复核。 */
    try {
      // 前提：这一段全部从**列表页**开始量 —— 上一段收尾停在房间页，先退回去。
      if (!byTestId("db-list-page")) {
        byTestId("db-header-back").click();
        await sleep(600);
      }
      byTestId("db-account").click();
      await sleep(400);
      byTestId("db-account-add").click();
      await sleep(5200);
      out.roomStatusReloggedIn = !!byTestId("db-list-page") &&
        (byTestId("db-account-name") || { innerText: "" }).innerText.indexOf("扫码新用户") >= 0;

      // ---- 进房间：房间头那颗点与标签页那颗点**同一个事件一起变**。
      byTestId("db-room-card").click();
      await sleep(900);
      var statusDotState = function () {
        var box = byTestId("db-live-dot-box");
        return box ? box.getAttribute("data-state") : null;
      };
      var tabDotState = function (roomId) {
        var btn = allByTestId("db-room-tab").filter(function (t) {
          return t.getAttribute("data-room-id") === String(roomId);
        })[0];
        var dot = btn ? btn.querySelector('[data-testid="db-tab-dot"]') : null;
        return dot ? dot.getAttribute("data-state") : null;
      };
      // 先置成「已连接 + 未开播」（红），再只推一条开播事件。
      window.__emit("danmubox://status", { room_id: fixtureRoom.room_id, state: "connected", detail: "" });
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 0 });
      await sleep(400);
      var dotsBeforeLive = statusDotState() === "off" && tabDotState(fixtureRoom.room_id) === "off";
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 1 });
      await sleep(400);
      out.roomStatusLiveHeaderDot = statusDotState() === "on";
      out.roomStatusLiveTabDot = tabDotState(fixtureRoom.room_id) === "on";
      // 下播（PREPARING 在 Rust 侧归一成 0，界面收到的就是这一条载荷）：两处一起回红。
      window.__emit("danmubox://room", { room_id: fixtureRoom.room_id, live_status: 0 });
      await sleep(400);
      out.roomStatusOfflineBothDots =
        statusDotState() === "off" && tabDotState(fixtureRoom.room_id) === "off";
      out.roomStatusLiveEventUpdatesBothDots = dotsBeforeLive && out.roomStatusLiveHeaderDot &&
        out.roomStatusLiveTabDot && out.roomStatusOfflineBothDots;

      // ---- 房间页里**不该**有列表那一拍（进房就停）：先等一拍可能在途的落地，再观察一段窗口。
      await sleep(1200);
      var refreshesInRoom = window.__statusRefreshes;
      await sleep(3000);
      out.roomStatusStopsPollingInRoom = window.__statusRefreshes === refreshesInRoom;

      // ---- 回列表页：**没有人点刷新**，界面自己拍一拍；一次性的替身覆盖（把房间报成「直播中」）
      //      用来证明拉回来的值**真的落到了卡片上**（只证明「命令被调用过」是不够的）。
      window.__statusNext = 1;
      var refreshesBeforeBack = window.__statusRefreshes;
      var followCallsBeforeBack = window.__followCalls;
      byTestId("db-header-back").click();
      await sleep(1200);
      out.roomStatusListRefreshAutomatic = window.__statusRefreshes > refreshesBeforeBack;
      out.roomStatusListRefreshFetchesFollowed = window.__followCalls > followCallsBeforeBack;
      var homeCard = allByTestId("db-room-card").filter(function (c) {
        return c.innerText.indexOf(fixtureRoom.anchor_uname) >= 0;
      })[0];
      out.roomStatusListCardFollowsUpstream = !!homeCard &&
        homeCard.innerText.indexOf("直播中") >= 0;

      // ---- 同一份状态也要落到**关注行**上（同号的那一条）：推一条下播事件，「在播主播」那一行
      //      从「直播中」变「未开播」—— 列表页两处状态不再自相矛盾。
      var followRowNamed = function () {
        return allByTestId("db-follow-item").filter(function (r) {
          return r.innerText.indexOf("在播主播") >= 0;
        })[0];
      };
      var followStatusOf = function (row) {
        var span = row ? row.querySelector('[data-testid="db-follow-status"]') : null;
        return span ? span.innerText : null;
      };
      var followStatusBefore = followStatusOf(followRowNamed());
      window.__emit("danmubox://room", { room_id: 100, live_status: 0 });
      await sleep(400);
      out.roomStatusFollowRowFollowsEvent = followStatusBefore === "直播中" &&
        followStatusOf(followRowNamed()) === "未开播";

      out.roomStatusListAutorefresh = out.roomStatusListRefreshAutomatic &&
        out.roomStatusListRefreshFetchesFollowed && out.roomStatusListCardFollowsUpstream &&
        out.roomStatusFollowRowFollowsEvent;
      out.roomStatusBlockRan = true;
    } catch (e) {
      out.roomStatusBlockError = String((e && e.stack) || e);
      // 块没跑完 = 明确红：这一批 roomStatus* 会全是 undefined，而运行器只查布尔值、
      // 非布尔直接跳过 —— 不显式置 false 就什么都拦不住。
      out.roomStatusBlockRan = false;
    }

    out.done = true;
    snap();
  };
  document.addEventListener("__smoke-cmd", function (e) {
    if ((e.detail || {}).type === "run") window.__smoke_run();
  });
})();`;

export function buildSmokeHtml(theme = THEME) {
  const assets = new URL("../dist/assets/", import.meta.url);
  const names = readdirSync(assets);
  const js = readFileSync(
    new URL(names.find((n) => n.endsWith(".js")), assets),
    "utf8",
  );
  const css = readFileSync(
    new URL(names.find((n) => n.endsWith(".css")), assets),
    "utf8",
  );
  // 注入顺序要紧：先装 IPC 替身，再跑 type=module 的产物
  return (
    '<!doctype html><html lang="zh"><head><meta charset="utf-8" /><style>' +
    css +
    '</style></head><body><div id="root"></div><script>' +
    MOCK(theme) +
    '</script><script type="module">' +
    js +
    "</script></body></html>"
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.env.SMOKE_OUT ?? "/tmp/danmubox-ui-smoke.html";
  const html = buildSmokeHtml();
  writeFileSync(out, html);
  console.log("已生成 " + out + "（" + html.length + " 字节）");
}
