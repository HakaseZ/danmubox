// 无头跑 smoke/room-page.mjs 的场景：自己起 Chrome for Testing，走 CDP，不依赖任何外部浏览器/relay。
//
//   cd apps/desktop/ui && npm run build && node smoke/run-headless.mjs
//
// 两个视口各跑一遍同一份场景：1440×900（桌面）与 390×844（竖屏手机比例，安卓的参考）。
// 退出码 0 = 两个视口里所有「期望为 true」的断言都为 true；非 0 = 有断言不成立（名单会打印出来）。
// 换浏览器：CHROME_BIN=/path/to/chrome node smoke/run-headless.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = buildSmokeHtml();
const page = join(mkdtempSync(join(tmpdir(), "danmubox-smoke-")), "room-page.html");
writeFileSync(page, html);

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

/** 一个视口里跑完整个场景，返回快照。 */
async function runViewport({ send, evaluate, shoot, shotDir, name, width, height }) {
  // 用 CDP 改布局视口（等价于把窗口缩到手机比例），而不是改启动参数：跑的是同一份场景代码
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `file://${page}` });

  for (let i = 0; i < 60; i += 1) {
    if (await evaluate("typeof window.__smoke_run === 'function'")) break;
    await sleep(250);
  }
  await evaluate(
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
    const raw = await evaluate("document.documentElement.getAttribute('data-smoke')");
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

let client;
try {
  client = await connect(await waitForDebugger(child));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const send = (method, params) => client.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expression) => {
    const { result } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.value;
  };

  const shoot = async (path) => {
    // SMOKE_SHOT_DIR 指到还不存在的目录时别用 ENOENT 报错（那种失败很难看出是路径问题）
    mkdirSync(dirname(path), { recursive: true });
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(data, "base64"));
    console.error("截图 " + path);
  };
  const shotDir = process.env.SMOKE_SHOT_DIR ?? tmpdir();

  const results = [];
  for (const viewport of VIEWPORTS) {
    const snapshot = await runViewport({ send, evaluate, shoot, shotDir, ...viewport });
    console.log(JSON.stringify(snapshot, null, 2));
    results.push({ viewport: viewport.name, snapshot });
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
      "\n两个视口全部断言成立（" +
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
  client?.close();
  child.kill("SIGKILL");
}
