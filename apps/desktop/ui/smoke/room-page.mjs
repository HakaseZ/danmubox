// 房间页 UI 冒烟 —— **薄组装器 / 运行器**：把夹具数据、页内 IPC 替身与各主题场景块拼成一页，
// 用真实 dist 产物跑同一份场景；引擎 / 视口 / 主题的驱动与判定在 run-headless.mjs。
// 宿主引擎必须在验证链里，否则「全绿」只对 Chromium 成立（2026-09-12 的教训）。
//
// 复现（一条命令，自己起浏览器，不依赖 relay 标签页）：
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs                 # Chromium
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs --engine webkit # 宿主引擎
// 只要页面（不跑浏览器）：
//   node smoke/room-page.mjs            # 生成 /tmp/danmubox-ui-smoke.html
//
// 场景自己跑完（含两段 8.6s 等待）后把断言快照写进 document.documentElement 的 data-smoke
// 属性（JSON）并 console.log 一份。
//
// ---------------------------------------------------------------------------
// 结构（2026-09-17 拆分：此前整个场景是这一个文件里的**一个模板字符串**，6841 行 / 872 条读数）
//
//   scenario/fixtures.mjs            Node 侧：夹具 → 页内数据（唯一读 fixtures/*.json 的地方）
//   scenario/parts/00-mock.mjs       页内 IPC 替身（__TAURI_INTERNALS__）
//   scenario/parts/10-harness.mjs    页内共享工具（out / snap / byTestId / sleep / …）
//   scenario/parts/2x-3x-*.mjs       按主题切的场景块，**按文件名升序依次执行**（顺序即语义）
//   scenario/parts/90-epilogue.mjs   页内收尾（把 `run` 命令接上 window.__smoke_run）
//
// 拼装出的页内脚本（各 part 是**页内脚本的原文**，这里只做拼接，不做转义）：
//
//   (function () {
//     var __SMOKE_DATA = {…夹具 + 主题…};        ← 本文件注入（dataPrelude）
//     <00-mock>  <10-harness>
//     window.__smoke_run = async function () {   ← **运行器**：就是下面 BLOCKS 这份清单
//       <20…36 各主题块，原文>
//       out.done = true; snap();
//     };
//     <90-epilogue>
//   })();
//
// 为什么各 part 是**原文**而不是模板串里的字符串：旧写法把整场塞进一个模板字符串，反引号 / 反斜杠 /
// `${` 都会在求值模板时被吃掉（`split("\\n")` 到页面里是 `split("\n")`、正文里的 `${...}` 会当插值、
// 注释里的反引号会让模板提前收尾），docs/testing.md §9.3 记了两次踩坑。现在片段由 readFileSync 读出后
// 原样拼接，**写的就是页面里跑的**。因此：**不要**把这些片段再塞回模板字符串。
//
// 主题块清单（原块 → 新文件；docs/testing.md §9.1 有同一张表）：
//   follow / theme / 主页边距 / 未开播取样     → 20-room-list.mjs
//   step2 / step3 / 房间头 / 状态点 / 图标 / 标题 / 电池 / 贴底 → 21-room-header.mjs
//   layout 的弹幕行部分（排版取证 / 长串 / 表情盒 / ＠ / 身份行 / 头像 / 颜色）→ 22-danmaku-rows.mjs
//   工具行 / 文档不滚动 / 面板布局 / 表情面板   → 23-panels-layout.mjs
//   发送失败浮片 / 乐观渲染 / 粉丝牌            → 24-composer-send.mjs
//   弹幕聚合 / 阅读位置 / 回到最新 / 我的表情   → 25-aggregate-jump.mjs
//   点一下发 / 右键菜单 / mention / limit / ime / 超时 / time → 26-shortcuts-limits.mjs
//   filter / step4 / step5 / step6 / 字号 / 对比度 / 时间戳位置 → 27-filter-panel.mjs
//   gift / SC 卡片 / 礼物区与弹幕区同款 / 选区 / 分界线 / 两枚开关四组合 → 28-gift-dock.mjs
//   短语面板 / 断开与刷新连接 / tabs 多标签隔离 → 29-phrases-tabs.mjs
//   沉浸模式                                    → 30-immersive.mjs
//   admin / panels 五面板互斥                   → 31-admin.mjs
//   滚到顶部 + account 账号区与对话框           → 32-top-scroll-account.mjs
//   标签条（名字 / 圆点 / 拖动排序 / 横向滚动） → 33-room-tabs.mjs
//   splitter 分割条与长按换位                   → 34-split-panes.mjs
//   cheapgift / switchscope 两枚低价礼物开关    → 35-cheap-gift.mjs
//   开播 / 下播状态自动更新                     → 36-status-poll.mjs
//
// 三条维护约定（拆之前就在，逐条保留）：
//   1) 断言只依赖对外可观察的行为（DOM 文本 / 几何 / 副作用记录），**不依赖 CSS-module 类名**；
//      定位一律走 `data-testid`（db-chat-scroll / db-msg-row / db-msg-time / db-context-menu /
//      db-account / db-panel / db-gift-dock / db-follow-item），那是稳定的对外契约。
//   2) 快照字段名是契约：`step1_*` … `step6_*` 的语义不得改（Main 按这套闭环），
//      新增断言另起字段名（layout* / menu* / time* / gift* / follow* / account*）。
//   3) **断「某个元素在不在」必须定位到那个元素自身**，不要拿整行 / 整块的 innerText 找关键词：
//      行的正文里恰好出现同样两个字就会让断言说谎（#12 那次的样本正文含「舰长」两字，
//      于是「不该有舰长标」的断言假失败——它反过来也会让真 bug 混过去）。
//      例：判徽标看 `span.innerText.trim() === "舰长"`，而不是 `row.innerText.indexOf("舰长")`。
//
// 加一条断言怎么落（详见 docs/testing.md §9.3）：改**对应主题块**那个 part，块内自己包
// `try/catch` + `xxxBlockRan`、自己保证准入前提；**新增一个主题块**才要在下面 BLOCKS 里登记一行
// （少登记 / 多登记都会在构造页面时当场抛错）。
//
// 覆盖的规格：docs/ui.md §2、§3、§4、§5、§6、§7、§8、§9。

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pageData } from "./scenario/fixtures.mjs";

const PARTS_DIR = new URL("./scenario/parts/", import.meta.url);

/**
 * 场景块清单 —— **运行器就是这份清单**：按顺序 await 各块。顺序即语义（后一块接着前一块留下的
 * 页面状态跑），所以它是显式的、不许靠文件名扫描的巧合。每块自己保证准入前提（docs/testing.md §9.3 ②）。
 */
const BLOCKS = [
  "20-room-list.mjs",
  "21-room-header.mjs",
  "22-danmaku-rows.mjs",
  "23-panels-layout.mjs",
  "24-composer-send.mjs",
  "25-aggregate-jump.mjs",
  "26-shortcuts-limits.mjs",
  "27-filter-panel.mjs",
  "28-gift-dock.mjs",
  "29-phrases-tabs.mjs",
  "30-immersive.mjs",
  "31-admin.mjs",
  "32-top-scroll-account.mjs",
  "33-room-tabs.mjs",
  "34-split-panes.mjs",
  "35-cheap-gift.mjs",
  "36-status-poll.mjs",
];
const MOCK_PART = "00-mock.mjs";
const HARNESS_PART = "10-harness.mjs";
const EPILOGUE_PART = "90-epilogue.mjs";

/** 本次运行的档位：`SMOKE_THEME`（dark / light / system，默认 dark）。 */
const THEME = process.env.SMOKE_THEME ?? "dark";

/** 读一个 part（页内脚本原文）。 */
function readPart(name) {
  return readFileSync(new URL(name, PARTS_DIR), "utf8");
}

/** 清单里的 part 必须都存在，目录里也不许有没登记的文件（加了文件忘登记 = 断言静默不跑）。 */
function assertPartsComplete() {
  const found = readdirSync(PARTS_DIR).filter((name) => name.endsWith(".mjs"));
  const declared = [MOCK_PART, HARNESS_PART, ...BLOCKS, EPILOGUE_PART];
  const missing = declared.filter((name) => !found.includes(name));
  const extra = found.filter((name) => !declared.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `scenario/parts 与 RUN 清单不一致：缺 [${missing.join(", ")}]；多 [${extra.join(", ")}]` +
        "（新增主题块要在 room-page.mjs 的 BLOCKS 里登记）",
    );
  }
}

/**
 * 夹具数据前奏：`pageData` 已在 Node 侧备好，这里只做一次 JSON 序列化。
 * `</` 打成 `<\/` 是唯一一处转义 —— 它防的是数据里出现 `</script`（页内脚本是内联的）。
 */
function dataPrelude(theme) {
  const json = JSON.stringify({ theme, ...pageData }).replace(/<\//g, "<\\/");
  return "  var __SMOKE_DATA = " + json + ";\n";
}

/** 组装结果里每一行来自哪个 part —— 预检③把编译错误的行号指回**源文件**（见 run-headless.mjs）。 */
let lastLineOrigins = [];

/**
 * 组装页内脚本（等价于拆之前的 `MOCK(theme)`）。返回值就是塞进 `<script>` 的那段文本：
 * 各 part 原文拼接，**不做任何转义**，所以片段里写反引号 / 反斜杠 / `${` 都与浏览器里一致。
 */
export function buildPageScript(theme = THEME) {
  assertPartsComplete();
  const chunks = [
    { file: "(room-page.mjs 组装出的外壳)", text: "(function () {\n" },
    { file: "(room-page.mjs 注入的 __SMOKE_DATA)", text: dataPrelude(theme) },
    { file: MOCK_PART, text: readPart(MOCK_PART) },
    { file: HARNESS_PART, text: readPart(HARNESS_PART) },
    // 运行器：只做一件事 —— 按清单顺序跑各块；块内自带 try/catch（§9.3 ①）。
    { file: "(room-page.mjs 的运行器外壳)", text: "  window.__smoke_run = async function () {\n" },
    ...BLOCKS.map((name) => ({ file: name, text: readPart(name) })),
    { file: "(room-page.mjs 的运行器外壳)", text: "    out.done = true;\n    snap();\n  };\n" },
    { file: EPILOGUE_PART, text: readPart(EPILOGUE_PART) },
    { file: "(room-page.mjs 组装出的外壳)", text: "})();\n" },
  ];
  const origins = [];
  const parts = [];
  for (const chunk of chunks) {
    const lines = chunk.text.split("\n");
    // 末元素是结尾换行留下的空串，不是一行
    for (let i = 1; i < lines.length; i += 1) {
      origins.push({ file: chunk.file, line: i });
    }
    parts.push(chunk.text);
  }
  lastLineOrigins = origins;
  return parts.join("");
}

/** 组装结果里第 `line` 行（1-based）来自哪个 part 的第几行；越界返回 null。 */
export function locatePageScriptLine(line) {
  return lastLineOrigins[line - 1] ?? null;
}

/** 场景片段清单（预检要对每一份单独做语法检查；见 run-headless.mjs 的 precheckScenario）。 */
export function scenarioFiles() {
  return [MOCK_PART, HARNESS_PART, ...BLOCKS, EPILOGUE_PART].map((name) => ({
    name,
    // fileURLToPath 而不是 url.pathname：后者在 Windows 上会给出 `/C:/...` 这种前缀，node --check 认不出来
    path: fileURLToPath(new URL(name, PARTS_DIR)),
  }));
}

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
    buildPageScript(theme) +
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
