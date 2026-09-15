package dev.kksk.danmubox

import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * 系统栏安全区。
 *
 * Tauri 的 Android 外壳是 edge-to-edge（下面的 `enableEdgeToEdge()`）：窗口、WebView、
 * 页面都铺满 0..2400（模拟器实测 `frame=[0,0][1080,2400]`），而状态栏占 y=0..128、
 * 手势栏占 y=2337..2400 —— 顶栏（标题 / 主题按钮 / 房间页返回键）因此整条压在状态栏带里，
 * 与右上角的电池图标直接重叠，房间页的输入区则压在底部手势栏那一条上。
 *
 * 这个值拿不到就只能从原生取：WebView 的 `env(safe-area-inset-*)` 只报**刘海**，
 * 实测 top=129 / bottom=0 设备像素（同一次实测里状态栏 128、手势栏 63）——按它排版
 * 顶栏能勉强让开，输入区却仍然压在手势栏下；没有刘海的机型上连顶栏也让不开。
 *
 * 取到的系统栏 inset 换算成 **CSS 变量** `--safe-top` / `--safe-bottom` 交给界面
 * （值 = 设备 px / devicePixelRatio，即 CSS px），界面在 `body` 上留内边距
 * （见 index.css 与 app.module.css 的 `--safe-*` 令牌）。
 * 同一处还下发 `--gesture-left` / `--gesture-right`（Android 的**系统手势区**宽度，
 * 即左右边缘那一条）：它不参与排版，只让界面知道「这一下触摸可能是系统的返回手势起手」，
 * 免得把返回手势当成「点了面板外面」（见 `ui/src/back.ts`）。
 *
 * 为什么不直接给 WebView 设 padding：窗口与 WebView 保持铺满时，状态栏/手势栏后面画的
 * 是**页面自己的底色**（深浅色跟随界面里的 ui.theme）；给 WebView 设 padding 会在这两条上
 * 露出一条 windowBackground —— 它是 Android 主题色，只跟系统深色模式走，与界面里可强制的
 * `ui.theme` 不同步（用户在浅色系统上锁深色主题时会看到一条亮边）。所以这里只下发数值，
 * 排版交给界面自己的令牌体系（`--safe-*`，见 app.module.css）。
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var documentStartScript: ScriptHandler? = null
  private var lastScript: String? = null

  /**
   * 接手 webview 的返回语义，因此关掉 Wry 外壳自带的那条（见下面的 `handleBackNavigation`）。
   */
  private val backCallback = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() = askPageBeforeLeaving()
  }

  /**
   * 关掉 `WryActivity` 自带的返回处理。
   *
   * 它在 `setWebView` 里往**同一个** `OnBackPressedDispatcher` 注册自己的一条 callback
   * （webview 有历史就 `goBack()`、没有就退出），而 dispatcher 是**后注册的先被选中** ——
   * 谁先谁后取决于 `setWebView` 与这里 `addCallback` 的先后，而 `setWebView` 是 Rust 侧
   * 在 `onActivityCreate` 之后调过来的、时机不可靠：留着它就成了「两条 callback 抢一次返回」。
   * 关掉它，改由我们这一条同时承担三档：**页面先挑 → webview 历史 → 退出**（见
   * `askPageBeforeLeaving`），语义不减（本页是单文档 SPA，历史那一档实际用不到）。
   */
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // inset 从 decorView 收：它在分发链最前面，中间层（content FrameLayout 等）先消费掉
    // 就再也拿不到真实值了。这里原样返回，子树照旧收到。
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      publishInsets(insets)
      insets
    }
    onBackPressedDispatcher.addCallback(this, backCallback)
  }

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onBackPressed() {
    // 未启用 predictive back 时系统走这条老路（predictive back 打开时改投
    // `OnBackInvokedDispatcher`，AndroidX 会把它接到上面那条 callback 上）。两处同一份逻辑。
    // **不要**改回 `super.onBackPressed()`：那只会在 `ComponentActivity` 里绕回
    // `onBackPressedDispatcher.onBackPressed()`，而它会立刻再挑中上面刚注册的 callback，递归下去。
    askPageBeforeLeaving()
  }

  /**
   * 把这次返回交给页面判断：`window.__danmuboxHandleBack()` 认领（`true`）就什么都不做；
   * 没认领时先按 webview 自己的历史返回（= Wry 原本那档），没有历史才退出应用
   * （协议与三级顺序见 `ui/src/back.ts`、`docs/ui.md` §2.6）。
   *
   * 为什么用**返回值**而不是自定义协议（让页面往原生发一条「我处理了」的消息）：原生必须在
   * 同一个调用栈里拿到答案才好决定要不要 `finish()`。消息是异步的 —— 它到达时原生已经必须先
   * 二选一：要么先退出（页面想拦也晚了），要么先挂起等一个来回（返回手势卡顿）。
   * `evaluateJavascript(script, ValueCallback)` 一次往返就把 JSON 布尔值带回来，
   * 也不必为此新增 IPC 命令与契约面（IPC 层只管业务命令，见 `docs/ipc.md`）。
   */
  private fun askPageBeforeLeaving() {
    val view = webView
    if (view == null) {
      // 页面还没建起来（返回手势要求窗口在前台，正常到不了这里）——没有 JS 可问，按系统默认退出。
      finish()
      return
    }
    view.evaluateJavascript(BACK_SCRIPT, ValueCallback { result ->
      // 页面给的是 JS 布尔真值，回传的是 JSON 文本 `"true"`；`"false"` / `"null"` / null
      // 一律当「没认领」。
      if (result == "true") return@ValueCallback
      // 退出用 `finish()` = 根 Activity 上系统默认返回的终态。
      if (view.canGoBack()) view.goBack() else finish()
    })
  }

  private companion object {
    /**
     * 与 `ui/src/back.ts` 的 `installBackBridge()` 成对：在页面里求值成布尔值
     * （页面没挂上桥时短路成 `undefined`，同样当「没认领」）。
     */
    const val BACK_SCRIPT =
      "(window.__danmuboxHandleBack && window.__danmuboxHandleBack()) === true"
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    val script = lastScript ?: return
    // inset 可能比页面加载**早**到（那时 evaluateJavascript 打在过去还存在的文档上，
    // 随导航一起丢掉），也可能**晚**到（页面已经画了一帧）。document-start 脚本堵前者：
    // 它在每个新文档的开头执行，早于 React 首次渲染。
    registerDocumentStartScript(webView, script)
  }

  private fun publishInsets(insets: WindowInsetsCompat) {
    // ime() 一起算：软键盘弹出时它给出键盘高度，输入区因此不会被键盘压住
    // （取 max(手势栏, 键盘)，与 systemBars() 取并集即可）。
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
    )
    // 系统手势区（左右边缘那一条）：手势导航下，从边缘起手的返回会先把这个 DOWN 发给页面、
    // 再把整条触摸流 CANCEL 收走。页面据此把边缘那一条里的触摸**不当点击**（见 ui/src/back.ts），
    // 否则一次侧滑会变成「先把面板点没了、返回再退一级」两件事。
    // 三键导航下这里是 0：没有会抢触摸的系统手势，页面也就不启用这条避让。
    val gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
    val script =
      "(function(){var st=document.documentElement.style,d=window.devicePixelRatio||1;" +
        "st.setProperty('--safe-top',(${bars.top}/d)+'px');" +
        "st.setProperty('--safe-bottom',(${bars.bottom}/d)+'px');" +
        "st.setProperty('--gesture-left',(${gestures.left}/d)+'px');" +
        "st.setProperty('--gesture-right',(${gestures.right}/d)+'px')})()"
    if (script == lastScript) return
    lastScript = script
    val view = webView ?: return
    documentStartScript?.remove()
    registerDocumentStartScript(view, script)
    // 已经画出来的那一帧：变量是内联自定义属性，改完立即重新排版。
    view.evaluateJavascript(script, null)
  }

  private fun registerDocumentStartScript(webView: WebView, script: String) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    documentStartScript = WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("*"))
  }
}
