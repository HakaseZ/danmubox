package dev.kksk.danmubox

import android.os.Bundle
import android.webkit.WebView
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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // inset 从 decorView 收：它在分发链最前面，中间层（content FrameLayout 等）先消费掉
    // 就再也拿不到真实值了。这里原样返回，子树照旧收到。
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      publishInsets(insets)
      insets
    }
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
    val script =
      "(function(){var st=document.documentElement.style,d=window.devicePixelRatio||1;" +
        "st.setProperty('--safe-top',(${bars.top}/d)+'px');" +
        "st.setProperty('--safe-bottom',(${bars.bottom}/d)+'px')})()"
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
