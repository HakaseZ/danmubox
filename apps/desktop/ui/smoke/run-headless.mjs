// 无头跑 smoke/room-page.mjs 的场景，两个引擎任选：
//
//   cd apps/desktop/ui && npm run build
//   node smoke/run-headless.mjs                     # Chromium（默认）：自带 Chrome for Testing，走 CDP
//   node smoke/run-headless.mjs --engine webkit     # WebKit：宿主引擎（macOS 上 Tauri 用的 WKWebView 就是它）
//   SMOKE_ENGINE=webkit node smoke/run-headless.mjs # 同一件事的环境变量写法
//
// **为什么必须能跑宿主引擎**：应用跑在 WKWebView 里，Chromium 的绿只证明「在 Chromium 里成立」。
// 同一份 DOM / CSS 在两个引擎里可以一个正常、一个塌掉（`@property` 注册自定义属性、网格的
// `minmax()`、`em` 在声明处还是使用处求值，都有差异）。引擎不在验证链里，「全绿」对用户没有意义。
//
// **为什么每一步都有超时**：这台机器上曾经同时挂着十几个没被回收的浏览器，把内存吃到只剩几十 MB；
// 那种环境下浏览器进程还活着、CDP 端口也连得上，但命令**永远不回复** —— 于是脚本「一行输出都没有、
// 进程还在」地挂着，看起来像死锁，实际是被环境拖垮。现在每个 CDP 调用都有超时，超时即报错并清理。
//
// 两个视口各跑一遍同一份场景，断言与截图在两引擎间逐字相同：1440×900（桌面）与
// 360×844（窗口最小宽度 = 可达面边界）。退出码 0 = 两个视口里所有「期望为 true」的断言都为 true。
//
// **同一台机上冒烟必须串行**：一次只让一个浏览器跑。并发时内存压力会先杀掉 WebKit 的
// WebContent 进程，表现是 `page.evaluate: Target crashed`，而且**看起来像「某一段场景必崩」**
// ——这个假象骗过两个人。崩溃会换新页重试一次并记账（重跑整个场景），两次都崩才报失败。
//
// `--from-snapshot <file>`：不起浏览器，只判定一份已有快照（给宿主引擎那条链路用，
// 见 `smoke/wkwebview-host.swift` 与 docs/ui.md §15）。
// 换 Chrome：CHROME_BIN=/path/to/chrome node smoke/run-headless.mjs
// 截图目录：SMOKE_SHOT_DIR（默认系统临时目录）。两个引擎要指到**不同**目录，否则同名截图互相覆盖。

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { webkit } from "playwright";

import { buildSmokeHtml } from "./room-page.mjs";

/** 期望为 false 的布尔字段（其余布尔断言都必须为 true）。 */
const EXPECTED_FALSE = new Set([
  // 断言：头部不再展示人气值；系统通知默认关闭；历史与实时之间没有分界提示
  "step3_headerHasPopularity",
  "step3_systemRendered",
  "step3_dividerTextPresent",
  // 值字段（不是断言）：关掉自动消失开关后的偏好值本来就该是 false
  "step6_prefAutoHide",
]);

/**
 * 视口：宽屏在前（截图沿用既有文件名），窄屏的截图带 `-narrow` 前缀。
 *
 * 窄屏跑 **360×844**：窗口最小宽度就是 360（`tauri.conf.json` 的 `minWidth`），
 * 也是**可达面的边界值**——按「验证要覆盖可达面的边界」这条规矩，冒烟就该压在边界上
 * （390×844 是窗口默认值，比边界宽 30px，跑它会被这 30px 的宽容度掩盖溢出类问题）。
 */
const VIEWPORTS = [
  { name: "wide", width: 1440, height: 900 },
  { name: "narrow", width: 360, height: 844 },
];

/**
 * 主题维度（本次新增）：同一份场景 × 同一套断言，深浅**各跑一遍**。
 * 主题由 mock 的 `ui.theme` 驱动（`SMOKE_THEME` 传进 `buildSmokeHtml`），
 * 场景里另有一条真实交互断言：在筛选面板里切主题 → `<html data-theme>` 跟着变。
 * 截图命名带主题后缀（`danmubox-ui-dark-*` / `danmubox-ui-narrow-light-*`），
 * 否则深浅两遍会互相覆盖，验收矩阵里就只剩一套图。
 * `SMOKE_THEMES=dark` 可以只跑一遍（单档调试用，验收矩阵要求两档都跑）。
 */
const THEMES = (process.env.SMOKE_THEMES ?? "dark,light")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

/** 单条命令 / 阶段的上限：宁可失败并说清卡在哪，也不要无声地挂着。 */
const TIMEOUTS = {
  cdp: 20000, // 一条 CDP 命令
  connect: 10000, // 连上浏览器调试端口
  launch: 60000, // 浏览器进程起来（含被环境拖慢的情况）
  navigate: 30000, // 一次导航
  probe: 6000, // 出帧自检：拍一张 about:blank
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 走 stderr：stdout 留给快照 JSON，日志不能混进去。 */
function log(line) {
  console.error(`[smoke] ${line}`);
}

/** `--engine webkit` 或 `SMOKE_ENGINE=webkit`；默认 chromium。 */
function parseEngine(argv, env) {
  const flag = argv.indexOf("--engine");
  const value = flag >= 0 ? argv[flag + 1] : (env.SMOKE_ENGINE ?? "chromium");
  if (value !== "chromium" && value !== "webkit") {
    throw new Error(`未知引擎 ${value}（可选 chromium / webkit）`);
  }
  return value;
}

/* ============================================================ 进程回收（谁起的谁负责收）

   冒烟自己起浏览器，就必须自己收干净：正常退出、断言失败、Ctrl-C、被 timeout 杀掉，
   任何一条路径都不能把浏览器留给下一个人（实测漏过 19 个，把机器内存吃到只剩 28MB，
   于是后续每一次运行都被拖到挂死 —— 工具不清理，验证本身就会把环境搞坏）。 */

/** 干掉本进程的全部后代；同步执行，好用在 `exit` / 信号处理里。 */
function reapDescendants() {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return;
  }
  const children = new Map();
  for (const line of out.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const doomed = [];
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      doomed.push(child);
      walk(child);
    }
  };
  walk(process.pid);
  for (const pid of doomed) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经自己退了
    }
  }
}

/**
 * 清掉**上一次跑残留**的浏览器。只认两个我们自己的标记，且**只杀孤儿**（ppid == 1，
 * 即父进程已经不在、确认是遗留物）：用户自己开的 Chrome、别的 agent 正在跑的实例都不碰。
 */
function sweepStaleBrowsers() {
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  let killed = 0;
  for (const line of out.trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (Number(ppid) !== 1) continue; // 只动孤儿
    const mine =
      command.includes("danmubox-profile-") || // 我们的 Chrome：--user-data-dir 带这个前缀
      command.includes("ms-playwright/webkit-"); // Playwright 的 WebKit
    if (!mine) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
      killed += 1;
    } catch {
      // 竞态：刚好自己退了
    }
  }
  return killed;
}

/* ======================================================== Chromium：CDP，不额外下载浏览器 */

/**
 * 候选浏览器，按顺序试：显式 `CHROME_BIN` → omp 自带的那份 Chrome for Testing（新版本优先）
 * → 系统 Chrome。
 *
 * 为什么不写死一台：这台机器上出现过「omp 自带那份 150 起得来、CDP 也连得上，但**渲染进程
 * 不产帧**」的状态 —— 连 `about:blank` 的截图都永不返回，页面定时器随即被节流，场景永远跑不完。
 * 同一时刻系统 Chrome 153 截图 32ms 就回来了。浏览器是否可用是**环境事实**，不是常量。
 */
function chromeCandidates() {
  const list = [];
  if (process.env.CHROME_BIN) list.push(process.env.CHROME_BIN);
  const root = join(process.env.HOME ?? "", ".omp", "puppeteer", "chrome");
  let versions = [];
  try {
    versions = readdirSync(root).sort().reverse();
  } catch {
    versions = [];
  }
  for (const version of versions) {
    const dir = join(root, version, "chrome-mac-arm64");
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const app = entries.find((name) => name.endsWith(".app"));
    if (!app) continue;
    list.push(join(dir, app, "Contents", "MacOS", app.replace(/\.app$/, "")));
  }
  list.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  const unique = [...new Set(list)];
  return unique.filter((bin) => {
    try {
      statSync(bin);
      return true;
    } catch {
      return false;
    }
  });
}

/** 极简 CDP 客户端：一个 WebSocket、一张 id → promise 的表、若干事件回调。每条命令都有超时。 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const openTimer = setTimeout(
      () => reject(new Error(`连 CDP 调试端口超时（${TIMEOUTS.connect}ms）：${url}`)),
      TIMEOUTS.connect,
    );
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: done, reject: fail, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      for (const cb of listeners.get(message.method) ?? []) cb(message.params);
    });
    ws.addEventListener("error", () => {
      clearTimeout(openTimer);
      reject(new Error("CDP 连接失败"));
    });
    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params = {}, sessionId, timeoutMs = TIMEOUTS.cdp) {
          const id = ++nextId;
          return new Promise((done, fail) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              fail(
                new Error(
                  `CDP ${method} 超时（${timeoutMs}ms）——浏览器没有回复。` +
                    "常见原因是机器被拖垮（残留浏览器占满内存）或渲染进程无响应；" +
                    "先跑 `pkill -f danmubox-profile-` 清掉残留再试。",
                ),
              );
            }, timeoutMs);
            pending.set(id, {
              resolve: done,
              reject: fail,
              timer,
            });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
          });
        },
        on(method, cb) {
          listeners.set(method, [...(listeners.get(method) ?? []), cb]);
        },
        close() {
          ws.close();
        },
      });
    });
  });
}

async function waitForDebugger(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`等 DevTools 端口超时（${TIMEOUTS.launch}ms）`)),
      TIMEOUTS.launch,
    );
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });
}

async function launchChromium(bin) {
  const profile = mkdtempSync(join(tmpdir(), "danmubox-profile-"));
  const child = spawn(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      // 无头自动化标配：不节流后台标签页的定时器 / 渲染。
      // 没有这几条时，标签页一旦被判定为「不可见」，页面里的 setTimeout 会被降到 1s 级、
      // 帧也不再产出 —— 表现就是「页面还在、CDP 也连得上，但场景跑不完、截图永不返回」。
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=PaintHolding",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--window-size=1440,900",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    // detached：自带一个进程组，收尾时能整组带走（Chrome 的 helper 不会变成孤儿）
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  const killBrowser = () => {
    try {
      process.kill(-child.pid, "SIGKILL"); // 整组
    } catch {
      // 组已经没了
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // 已经退了
    }
  };
  const client = await connect(await waitForDebugger(child));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  // 让它成为**活动标签页**：新无头模式下非活动标签不产出帧，`Page.captureScreenshot`
  // 会一直等一张永远不来的帧（实测：卡到外层 timeout，且一行日志都没有）。
  await client.send("Target.activateTarget", { targetId });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const send = (method, params, timeoutMs) => client.send(method, params, sessionId, timeoutMs);
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    kill: killBrowser,
    /**
     * 出帧自检：拍一张 about:blank。产不出帧的浏览器在这里就会失败 —— 比起让它跑到
     * 一半再挂死（或把场景拖成几分钟），这一步只花几秒。
     */
    async selfCheck() {
      await send("Page.captureScreenshot", { format: "png" }, undefined, TIMEOUTS.probe);
      await send("Page.navigate", { url: "about:blank" });
    },
    async openPage(width, height) {
      // 用 CDP 改布局视口（等价于把窗口缩到手机比例），而不是改启动参数：跑的是同一份场景代码
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      return {
        async goto(url) {
          await send("Page.navigate", { url });
        },
        async evaluate(expression) {
          const { result } = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          return result.value;
        },
        async shoot(path) {
          mkdirSync(dirname(path), { recursive: true });
          // `captureBeyondViewport: false`：只拍视口。默认的「连视口外一起拍」要求把整个页面
          // （我们的虚拟列表高度块可以有几万 px）都布局出来，是截图卡死的另一条常见路径。
          const { data } = await send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          });
          writeFileSync(path, Buffer.from(data, "base64"));
        },
        async dispose() {},
      };
    },
  };
}

async function openChromium() {
  const candidates = chromeCandidates();
  if (candidates.length === 0) {
    throw new Error("找不到可用的 Chrome（可用 CHROME_BIN 指定一台）");
  }
  let firstError = null;
  for (const bin of candidates) {
    let browser = null;
    try {
      browser = await launchChromium(bin);
      await browser.selfCheck();
      log(`引擎 chromium：${bin}（出帧自检通过）`);
      return browser;
    } catch (error) {
      if (firstError === null) firstError = error;
      log(`候选浏览器不可用，换下一个：${bin} —— ${String(error).slice(0, 140)}`);
      // 自检不过的这台**要当场收掉**：留着它跑完整轮就是白白多占一份内存，
      // 而内存压力正是 WebKit 那侧渲染进程崩溃的诱因。
      try {
        browser?.kill();
      } catch {
        // 已经退了
      }
      reapDescendants();
    }
  }
  log(
    "⚠ 没有候选浏览器通过出帧自检，仍用第一个继续（截图会失败、场景可能被环境拖慢）：" +
      `建议用 CHROME_BIN 指定一台能渲染的 Chrome。首个错误：${String(firstError).slice(0, 160)}`,
  );
  return await launchChromium(candidates[0]);
}

/* ================================================ WebKit：Playwright，宿主引擎的唯一可达入口 */

async function openWebKit() {
  log(`引擎 webkit：Playwright WebKit（宿主引擎，macOS 上 Tauri 用的就是它）`);
  const browser = await webkit.launch({ timeout: TIMEOUTS.launch });
  return {
    async kill() {
      await browser.close();
    },
    async openPage(width, height) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      // 页面里的异常不许静默：WebKit 特有的失败（语法不支持、布局塌掉）先在这里现形
      page.on("pageerror", (error) => console.error(`[webkit] 页面异常：${error.message}`));
      // 渲染进程整个挂掉时 Playwright 只抛一句 `Target crashed`（details.log 往往是空的）。
      // 在那之前把 WebKit 自己的崩溃通知打出来，至少留下「确实是 WebContent 死了」这条线索。
      page.on("crash", () =>
        console.error(
          "[webkit] 渲染进程崩溃（WebContent 挂了）：多为内存压力 —— " +
            "同机并发跑另一个浏览器 / 另一轮冒烟时最常见；本条会被记进崩溃计数。",
        ),
      );
      page.on("console", (message) => {
        if (message.type() === "error") console.error(`[webkit] console.error：${message.text()}`);
      });
      return {
        async goto(url) {
          await page.goto(url, { waitUntil: "load", timeout: TIMEOUTS.navigate });
        },
        async evaluate(expression) {
          return await page.evaluate(expression);
        },
        async shoot(path) {
          mkdirSync(dirname(path), { recursive: true });
          await page.screenshot({ path });
        },
        async dispose() {
          await context.close();
        },
      };
    },
  };
}

/* ==================================================================== 场景驱动（两引擎共用） */

// 每个主题各生成一份 HTML（mock 里的 ui.theme 不同），同一个进程里换页跑，不用重建产物
const smokeDir = mkdtempSync(join(tmpdir(), "danmubox-smoke-"));
const htmlPaths = new Map(
  THEMES.map((theme) => {
    const file = join(smokeDir, `room-page-${theme}.html`);
    writeFileSync(file, buildSmokeHtml(theme));
    return [theme, file];
  }),
);

/** 一个视口里跑完整个场景，返回快照。 */
async function runViewport({ viewPage, shoot, shotDir, name, width, height, theme }) {
  log(`视口 ${name}（${width}×${height}）· 主题 ${theme}`);
  await viewPage.goto(`file://${htmlPaths.get(theme)}`);

  for (let i = 0; i < 60; i += 1) {
    if (await viewPage.evaluate("typeof window.__smoke_run === 'function'")) break;
    await sleep(250);
  }
  await viewPage.evaluate(
    "document.dispatchEvent(new CustomEvent('__smoke-cmd', { detail: { type: 'run' } }))",
  );

  let snapshot = null;
  let midShot = false;
  let shortShot = false;
  let adminShot = false;
  let confirmShot = false;
  let accountAreaShot = false;
  let accountShot = false;
  let accountQrShot = false;
  let followShot = false;
  let roomsShot = false;
  // 宽屏沿用既有文件名（docs/ui.md §15 列了它们），窄屏加 `-narrow`；末尾一律带主题后缀
  const prefix = `${name === "narrow" ? "danmubox-ui-narrow" : "danmubox-ui"}-${theme}`;
  // 300s 上限：正常 35–45s 跑完；环境被拖慢时宁可多等，也不要报一个假的「场景未跑完」
  for (let i = 0; i < 1200; i += 1) {
    const raw = await viewPage.evaluate("document.documentElement.getAttribute('data-smoke')");
    if (raw) {
      snapshot = JSON.parse(raw);
      // 面板展开那一刻抓一张：这是「面板向上展开、最新弹幕不被遮挡」的视觉证据
      if (!midShot && snapshot.layoutPanelShown) {
        midShot = true;
        await shoot(join(shotDir, `${prefix}-room.png`));
      }
      // 内容不足视口时贴底那一刻（issue #8 / A2 的视觉证据）
      if (!shortShot && typeof snapshot.layoutShortContentBottomGap === "number") {
        shortShot = true;
        await shoot(join(shotDir, `${prefix}-short-content.png`));
      }
      // 房管面板三块列表与二次确认条各一张（issue #3 的视觉证据）
      if (!adminShot && snapshot.adminPanelShown) {
        adminShot = true;
        await shoot(join(shotDir, `${prefix}-admin.png`));
      }
      if (!confirmShot && snapshot.adminMuteConfirmShown) {
        confirmShot = true;
        await shoot(join(shotDir, `${prefix}-admin-confirm.png`));
      }
      // 账号区（一行身份 + 账号按钮）、账号管理对话框、二维码面板各一张
      // 连接中的房间列表：卡片报「主播名 · 直播间名」（#17）——列表页在画面里的那一刻抓一张
      if (!roomsShot && snapshot.roomsListRendered) {
        roomsShot = true;
        await shoot(join(shotDir, `${prefix}-rooms.png`));
      }
      // 关注列表排布（#14/#15）：宽屏一张单排、窄屏一张两排，两处都不许出现房间号
      if (!followShot && snapshot.followListRendered) {
        followShot = true;
        await shoot(join(shotDir, `${prefix}-follow.png`));
      }
      if (!accountAreaShot && snapshot.accountAreaReady) {
        accountAreaShot = true;
        await shoot(join(shotDir, `${prefix}-account-area.png`));
      }
      if (!accountShot && snapshot.accountDialogShown) {
        accountShot = true;
        await shoot(join(shotDir, `${prefix}-account.png`));
      }
      if (!accountQrShot && snapshot.accountQrImgShown) {
        accountQrShot = true;
        await shoot(join(shotDir, `${prefix}-account-qr.png`));
      }
      if (snapshot.done) break;
    }
    await sleep(250);
  }
  if (!snapshot || !snapshot.done) throw new Error(`${name} 视口的场景未跑完（超时）`);
  log(`视口 ${name} 跑完，抓最后一张截图`);
  await shoot(join(shotDir, `${prefix}-final.png`));
  return snapshot;
}

/* ================================================================================ 入口 */

// `--from-snapshot <file>`：不起浏览器，只按**同一套断言**判定一份已有快照。
// 宿主引擎那条链路（`smoke/wkwebview-host.swift` 跑系统 WKWebView）就是这么判的，
// 免得「旁证」和「主闸门」各有一套口径。
const snapshotFlag = process.argv.indexOf("--from-snapshot");
if (snapshotFlag >= 0) {
  const file = process.argv[snapshotFlag + 1];
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  console.log(JSON.stringify(snapshot, null, 2));
  const failures = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value !== "boolean") continue;
    if (value !== !EXPECTED_FALSE.has(key)) failures.push(key);
  }
  if (failures.length > 0) {
    console.error("\n断言不成立（宿主引擎快照 " + file + "）：" + failures.join(", "));
    process.exit(1);
  }
  const booleans = Object.values(snapshot).filter((v) => typeof v === "boolean").length;
  console.error(
    `\n宿主引擎快照 ${file}：${booleans} 条布尔断言 / ${Object.keys(snapshot).length} 项快照，全部成立`,
  );
  process.exit(0);
}

const engine = parseEngine(process.argv.slice(2), process.env);
const shotDir = process.env.SMOKE_SHOT_DIR ?? tmpdir();

const swept = sweepStaleBrowsers();
if (swept > 0) log(`清掉上次残留的浏览器进程 ${swept} 个`);

const browser = engine === "webkit" ? await openWebKit() : await openChromium();
// 任何退出路径都要把自己起的浏览器带走 —— 包括断言失败、未捕获异常、Ctrl-C、
// 以及外层 `timeout` 发的 SIGTERM（那条最容易漏，漏了就是留一堆进程给下一个人）
let cleaned = false;
const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  try {
    await browser.kill();
  } catch {
    // 浏览器已经退了
  }
  reapDescendants();
};
// `exit` / 信号处理里能用的只有同步代码：直接用「杀后代」这条同步路径兜底，
// 它不依赖 browser.close() 的异步收尾（Target crashed 之类的异常路径也走得到）。
process.on("exit", () => {
  reapDescendants();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    log(`收到 ${signal}，收尾`);
    reapDescendants();
    process.exit(130);
  });
}

try {
  // 截图要走视口自己的通道（CDP 截图在会话上、Playwright 在页面上）。
  //
  // 截图是**证据**，不是断言：这台机器上出现过「连 about:blank 都产不出帧」的状态
  // （`Page.captureScreenshot` 永不返回），那种时候断言本身仍然可判定，不该被截图拖死。
  // 因此这里：第一次失败就熔断（不再逐张各等一次超时），告警，继续跑断言；末尾汇总张数。
  let shotsTaken = 0;
  let shotsFailed = 0;
  let shotsBroken = false;
  let crashCount = 0;
  const shootFor = (viewPage) => async (path) => {
    if (shotsBroken) {
      shotsFailed += 1;
      return;
    }
    try {
      await viewPage.shoot(path);
      shotsTaken += 1;
      log("截图 " + path);
    } catch (error) {
      shotsBroken = true;
      shotsFailed += 1;
      log(
        "⚠ 截图失败，后续截图一并跳过（本环境的渲染进程产不出帧；断言不受影响）：" +
          String(error).slice(0, 160),
      );
    }
  };

  const results = [];
  // 主题在外层：同一引擎里把一档跑完再跑另一档，截图目录里的文件名自带主题后缀
  for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    let snapshot = null;
    for (let attempt = 1; attempt <= 2 && snapshot === null; attempt += 1) {
      const viewPage = await browser.openPage(viewport.width, viewport.height);
      try {
        snapshot = await runViewport({
          viewPage,
          shoot: shootFor(viewPage),
          shotDir,
          ...viewport,
          theme,
        });
      } catch (error) {
        // 渲染进程被打死（`Target crashed`）是**环境**问题：这台机器上并发跑第二轮冒烟时，
        // 内存压力会让 WebKit 的 WebContent 进程被杀。换一张新页重试一次——崩溃的页已经死了，
        // 重试不会掩盖产品 bug（真有问题会再崩一次，那就按失败报出来）。
        const crashed = /crashed/i.test(String(error));
        if (!crashed || attempt === 2) {
          if (crashed) {
            crashCount += 1;
            log(
              `✗ 视口 ${viewport.name} 两次都因渲染进程崩溃失败 —— 这是环境问题（内存压力），` +
                "不是断言不成立；清掉并发跑的浏览器后重试本引擎。",
            );
          }
          throw error;
        }
        crashCount += 1;
        log(
          `⚠ 视口 ${viewport.name} 第 ${attempt} 次尝试：渲染进程崩溃（Target crashed）。` +
            "单次崩溃 ≠ 该场景必崩（并发跑浏览器时内存压力先杀 WebKit 的 WebContent），" +
            "换一张新页**重跑整个场景**（断言一起重跑，不是只补截图）：" +
            `${String(error).slice(0, 120)}`,
        );
      } finally {
        try {
          await viewPage.dispose();
        } catch {
          // 崩溃后的页面关不掉是正常的
        }
      }
    }
    console.log(JSON.stringify(snapshot, null, 2));
    results.push({ viewport: `${viewport.name}/${theme}`, snapshot });
  }
  }

  const failures = [];
  for (const { viewport, snapshot } of results) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof value !== "boolean") continue;
      if (value !== !EXPECTED_FALSE.has(key)) failures.push(`${viewport}:${key}`);
    }
  }
  if (failures.length > 0) {
    console.error("\n断言不成立：" + failures.join(", "));
    process.exitCode = 1;
  } else {
    const total = results.reduce((sum, item) => sum + Object.keys(item.snapshot).length, 0);
    if (shotsFailed > 0) {
      console.error(
        `\n⚠ 截图 ${shotsFailed} 张没拍成（本环境产不出帧），断言判定不受影响；` +
          `环境恢复后重跑即可补上（截图目录 ${shotDir}）。`,
      );
    }
    console.error(
      `\n引擎 ${engine}：两个视口全部断言成立（` +
        results
          .map(
            (item) =>
              `${item.viewport} ${Object.values(item.snapshot).filter((v) => typeof v === "boolean").length} 条布尔断言 / ${Object.keys(item.snapshot).length} 项快照`,
          )
          .join(" + ") +
        ` = ${total} 项快照，截图 ${shotsTaken} 张${crashCount > 0 ? `，渲染进程崩溃重试 ${crashCount} 次` : ""}）`,
    );
  }
} finally {
  // WebKit 的 close 是异步的：正常路径要 await，否则 node 可能先退出、把浏览器留成孤儿。
  await cleanup();
}
