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
// 两个视口各跑一遍同一份场景，断言与截图在两引擎间逐字相同：1440×900（桌面）与
// 360×844（窗口最小宽度 = 可达面边界）。退出码 0 = 两个视口里所有「期望为 true」的断言都为 true。
// 换 Chrome：CHROME_BIN=/path/to/chrome node smoke/run-headless.mjs
// 截图目录：SMOKE_SHOT_DIR（默认系统临时目录）。两个引擎要指到**不同**目录，否则同名截图互相覆盖。

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `--engine webkit` 或 `SMOKE_ENGINE=webkit`；默认 chromium。 */
function parseEngine(argv, env) {
  const flag = argv.indexOf("--engine");
  const value = flag >= 0 ? argv[flag + 1] : (env.SMOKE_ENGINE ?? "chromium");
  if (value !== "chromium" && value !== "webkit") {
    throw new Error(`未知引擎 ${value}（可选 chromium / webkit）`);
  }
  return value;
}

/* ======================================================== Chromium：CDP，不额外下载浏览器 */

/** 找一台可用的 Chrome：显式 CHROME_BIN 优先，否则用 omp 自带的那份。 */
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const root = join(process.env.HOME ?? "", ".omp", "puppeteer", "chrome");
  const versions = readdirSync(root).sort();
  for (const version of versions.reverse()) {
    const dir = join(root, version, "chrome-mac-arm64");
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    const app = entries.find((name) => name.endsWith(".app"));
    if (!app) continue;
    const bin = join(dir, app, "Contents", "MacOS", app.replace(/\.app$/, ""));
    try {
      statSync(bin);
      return bin;
    } catch {
      continue;
    }
  }
  throw new Error("找不到 Chrome，可用 CHROME_BIN 指定");
}

/** 极简 CDP 客户端：一个 WebSocket、一张 id → promise 的表、若干事件回调。 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: done, reject: fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      for (const cb of listeners.get(message.method) ?? []) cb(message.params);
    });
    ws.addEventListener("error", () => reject(new Error("CDP 连接失败")));
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = ++nextId;
          return new Promise((done, fail) => {
            pending.set(id, { resolve: done, reject: fail });
            ws.send(JSON.stringify({ id, method, params, sessionId }));
          });
        },
        on(method, cb) {
          listeners.set(method, [...(listeners.get(method) ?? []), cb]);
        },
        close() {
          ws.close();
        },
      }),
    );
  });
}

async function waitForDebugger(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("等 DevTools 端口超时")), 30000);
    child.stderr.on("data", (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });
}

async function openChromium() {
  const child = spawn(
    findChrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "danmubox-profile-"))}`,
      "--remote-debugging-port=0",
      "--window-size=1440,900",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const client = await connect(await waitForDebugger(child));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const send = (method, params) => client.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  return {
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
          const { data } = await send("Page.captureScreenshot", { format: "png" });
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, Buffer.from(data, "base64"));
        },
        async dispose() {},
      };
    },
    async close() {
      client.close();
      child.kill("SIGKILL");
    },
  };
}

/* ================================================ WebKit：Playwright，宿主引擎的唯一可达入口 */

async function openWebKit() {
  const browser = await webkit.launch();
  return {
    async openPage(width, height) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      // 页面里的异常不许静默：WebKit 特有的失败（语法不支持、布局塌掉）先在这里现形
      page.on("pageerror", (error) => console.error(`[webkit] 页面异常：${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error") console.error(`[webkit] console.error：${message.text()}`);
      });
      return {
        async goto(url) {
          await page.goto(url, { waitUntil: "load" });
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
    async close() {
      await browser.close();
    },
  };
}

/* ==================================================================== 场景驱动（两引擎共用） */

const html = buildSmokeHtml();
const htmlPath = join(mkdtempSync(join(tmpdir(), "danmubox-smoke-")), "room-page.html");
writeFileSync(htmlPath, html);

/** 一个视口里跑完整个场景，返回快照。 */
async function runViewport({ viewPage, shoot, shotDir, name }) {
  await viewPage.goto(`file://${htmlPath}`);

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
  // 宽屏沿用既有文件名（docs/ui.md §15 列了它们），窄屏加 `-narrow` 前缀
  const prefix = name === "narrow" ? "danmubox-ui-narrow" : "danmubox-ui";
  for (let i = 0; i < 400; i += 1) {
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
  await shoot(join(shotDir, `${prefix}-final.png`));
  return snapshot;
}

const engine = parseEngine(process.argv.slice(2), process.env);
const shotDir = process.env.SMOKE_SHOT_DIR ?? tmpdir();
const browser = engine === "webkit" ? await openWebKit() : await openChromium();

try {
  // 截图要走视口自己的通道（CDP 截图在会话上、Playwright 在页面上）
  const shootFor = (viewPage) => async (path) => {
    await viewPage.shoot(path);
    console.error("截图 " + path);
  };

  const results = [];
  for (const viewport of VIEWPORTS) {
    const viewPage = await browser.openPage(viewport.width, viewport.height);
    try {
      const snapshot = await runViewport({
        viewPage,
        shoot: shootFor(viewPage),
        shotDir,
        ...viewport,
      });
      console.log(JSON.stringify(snapshot, null, 2));
      results.push({ viewport: viewport.name, snapshot });
    } finally {
      await viewPage.dispose();
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
    console.error(
      `\n引擎 ${engine}：两个视口全部断言成立（` +
        results
          .map(
            (item) =>
              `${item.viewport} ${Object.values(item.snapshot).filter((v) => typeof v === "boolean").length} 条布尔断言 / ${Object.keys(item.snapshot).length} 项快照`,
          )
          .join(" + ") +
        ` = ${total} 项快照）`,
    );
  }
} finally {
  await browser.close();
}
