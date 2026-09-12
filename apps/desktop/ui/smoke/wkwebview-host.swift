// 在**系统 WKWebView**（macOS 上 Tauri 用的就是它）里跑冒烟页，落截图与快照。
//
//   cd apps/desktop/ui && npm run build && node smoke/room-page.mjs      # 生成冒烟页
//   swift smoke/wkwebview-host.swift /tmp/danmubox-ui-smoke.html /tmp/wk-host 390 844
//   node smoke/run-headless.mjs --from-snapshot /tmp/wk-host/snapshot.json   # 用同一套断言判定
//
// 为什么要它：Playwright 的 WebKit 是 WebKit 的一个构建，**系统 WKWebView 才是宿主本尊**。
// 这一条链路的价值是「零构建差异」——`@property`、网格、`em` 求值这些差异它一测一个准。
//
// 它的**已知局限**（所以它是旁证、不是主闸门）：
// - 没有显示会话时（我们的 shell 就是这样），rAF 会被节流，**按时间推进的断言会假失败**
//   （跟随贴底那几条）。几何 / 尺寸 / 溢出 / 截图是可靠的，时序类结论请以
//   `run-headless.mjs --engine webkit` 为准。
// - 每次只跑一个视口（宽度高度由参数给），不像 node 那条链路一轮跑两个视口。
//
// 参数：<冒烟页 html> <输出目录> [宽度] [高度] [标签]
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("用法：swift wkwebview-host.swift <html> <outDir> [宽] [高] [标签]\n".data(using: .utf8)!)
    exit(2)
}
let htmlPath = args[1]
let outDir = args[2]
let width = Double(args.count > 3 ? args[3] : "1440") ?? 1440
let height = Double(args.count > 4 ? args[4] : "900") ?? 900
let label = args.count > 5 ? args[5] : "wk"

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

/// 页面里未捕获的异常与 console.error 都记下来：崩溃 / 静默失败时这是唯一的线索。
let bootstrap = """
window.__errors = [];
window.addEventListener('error', function (e) {
  window.__errors.push(String(e.message) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
});
window.addEventListener('unhandledrejection', function (e) {
  window.__errors.push('rejection: ' + String(e.reason));
});
var __logError = console.error.bind(console);
console.error = function () {
  window.__errors.push(Array.prototype.map.call(arguments, String).join(' '));
  __logError.apply(null, arguments);
};
// rAF 可用性：没有显示会话时 requestAnimationFrame 一次都不触发（实测 raf=0 / 2.2s，
// 而 setTimeout 正常）。这会让「跟随最新 / 虚拟列表窗口」这类**按帧推进**的断言假失败，
// 所以要在结论里显式带出来，别让人把环境限制读成产品 bug。
window.__rafTicks = 0;
(function tick() { window.__rafTicks += 1; requestAnimationFrame(tick); })();
"""

let config = WKWebViewConfiguration()
config.userContentController.addUserScript(
    WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))

let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
let window = NSWindow(
    contentRect: NSRect(x: 40, y: 40, width: width, height: height),
    styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView
window.orderFrontRegardless()

func pump(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

func evalAsync(_ js: String) -> Any? {
    var done = false
    var value: Any?
    webView.evaluateJavaScript(js) { v, e in
        if let e = e { FileHandle.standardError.write("JS 错误: \(e)\n".data(using: .utf8)!) }
        value = v
        done = true
    }
    let deadline = Date().addingTimeInterval(30)
    while !done && Date() < deadline { pump(0.02) }
    return value
}

func shot(_ name: String) {
    var done = false
    webView.takeSnapshot(with: WKSnapshotConfiguration()) { image, err in
        defer { done = true }
        guard let image = image, let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write("截图失败 \(name)：\(String(describing: err))\n".data(using: .utf8)!)
            return
        }
        try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(label)-\(name).png"))
        FileHandle.standardError.write("截图 \(label)-\(name).png\n".data(using: .utf8)!)
    }
    let deadline = Date().addingTimeInterval(30)
    while !done && Date() < deadline { pump(0.02) }
}

webView.loadFileURL(
    URL(fileURLWithPath: htmlPath),
    allowingReadAccessTo: URL(fileURLWithPath: htmlPath).deletingLastPathComponent())

// 等注入的 IPC 替身与产物就绪
for _ in 0..<80 {
    pump(0.25)
    if let t = evalAsync("typeof window.__smoke_run") as? String, t == "function" { break }
}

pump(1)
shot("home") // 列表页（主页）先留一张

_ = evalAsync("document.dispatchEvent(new CustomEvent('__smoke-cmd', { detail: { type: 'run' } }))")

var panelShot = false
var snapshotJSON: String?
for _ in 0..<1200 {
    pump(0.25)
    guard let raw = evalAsync("document.documentElement.getAttribute('data-smoke')") as? String,
          let data = raw.data(using: .utf8),
          let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    if !panelShot, let shown = snapshot["layoutPanelShown"] as? Bool, shown {
        panelShot = true
        shot("room")
    }
    if let done = snapshot["done"] as? Bool, done {
        shot("final")
        snapshotJSON = raw
        break
    }
}

let errors = evalAsync("JSON.stringify(window.__errors || [])") as? String ?? "[]"
let rafTicks = (evalAsync("window.__rafTicks") as? NSNumber)?.intValue ?? -1
let rafNote = rafTicks <= 1
    ? "⚠ 本会话 rAF 没有持续帧（tick=\(rafTicks)，实测无显示会话时只有首帧）：跟随最新 / 虚拟列表窗口这类"
        + "按帧推进的断言会假失败（实测 24 条），几何 / 尺寸 / 溢出 / 颜色仍然可靠；"
        + "完整断言以 run-headless.mjs --engine webkit 为准，不要把这里的失败读成产品问题。"
    : "rAF 正常（tick=\(rafTicks)）"
FileHandle.standardError.write("\(rafNote)\n".data(using: .utf8)!)
if let snapshot = snapshotJSON {
    try? snapshot.write(toFile: "\(outDir)/snapshot.json", atomically: true, encoding: .utf8)
    print(snapshot)
    FileHandle.standardError.write("快照已写入 \(outDir)/snapshot.json；页面错误 \(errors)\n".data(using: .utf8)!)
    exit(0)
}
FileHandle.standardError.write("✗ 场景未跑完（超时）。页面错误 \(errors)\n".data(using: .utf8)!)
exit(1)
