package dev.kksk.danmubox

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * 后台保活：一枚**前台服务**，作用只是把本进程的 oom_adj 顶到前台档
 * （`PROCESS_STATE_FOREGROUND_SERVICE`），让「退到后台后继续收弹幕」这件事多一层保障。
 *
 * 它**不做事**：不轮询、不上报、不持有唤醒锁、不碰网络。弹幕连接本来就跑在**本进程的 Rust 侧**
 * （tokio + WebView 只负责画界面），被系统限流的只有 WebView 的定时器与渲染，
 * 所以这里不需要（也不该）替 Rust 侧做任何心跳——见 `docs/operations.md` §2.8。
 *
 * 谁在什么时候起停（全在 `MainActivity`）：应用**退到后台**（`onStop`）且页面答「还有活跃连接」
 * 时起，**回到前台**（`onStart`）时停；用户主动退出（`finish`）与把任务从最近任务里划掉
 * （`onTaskRemoved`）都不保活。
 *
 * 为什么是 `dataSync` 这个前台服务类型（`AndroidManifest.xml` 同名属性）：
 * Android 14（API 34）起**每个**前台服务都必须声明类型，而本项目做的事就是「持续接收
 * 网络数据」，在官方那张类型表里对应 `dataSync`，它的运行时前置条件是
 * **无**（不像 camera / location / microphone 那样需要 while-in-use 权限，
 * 因此可以在后台安全创建）。代价写在下面 `onTimeout` 那条注释里。
 */
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // `startForeground()` 必须在 `startForegroundService()` 之后 5 秒内调用，否则系统直接
    // 抛 `ForegroundServiceDidNotStartInTimeException`。放在这里（而不是 `onCreate`）是必须的：
    // 服务可能被反复要求启动，而每次都要重新把通知挂上去。
    createChannel()
    ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), foregroundServiceType())
    Log.i(TAG, "前台服务已启动")
    // 不粘：进程被系统杀掉后**不要**自动重来。保活只负责「退到后台这一段时间」，
    // 自动重启会变成用户没要的东西（也违背「不写任何后台轮询」）。
    return START_NOT_STICKY
  }

  /**
   * Android 15（API 35）起，targetSdk ≥ 35 的应用其 `dataSync` 前台服务每 24 小时只有
   * **6 小时**额度，到点系统回调这里；此时服务已经被系统摘掉前台身份，几秒内不 `stopSelf()`
   * 就会变成 `RemoteServiceException`（进程崩）。
   *
   * 这一档必须显式收工：额度耗尽后连**再起**服务都会被拒（`ForegroundServiceStartNotAllowedException`，
   * 见 `KeepAliveService.start()` 的 catch），所以这里只是老老实实停掉——用户回到前台后额度会重置。
   * 自用场景下 6 小时够（一次蹲播），真机上更长的场次表现为「通知自己消失、后台可能被回收」。
   */
  @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "前台服务已用满系统配额（dataSync 每 24 小时 6 小时），按系统要求自停")
    stopSelf()
  }

  override fun onDestroy() {
    // 显式摘掉通知：`stopService()` 与划掉最近任务两条路都会走到这里。
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    Log.i(TAG, "前台服务已停止")
    super.onDestroy()
  }

  /**
   * 用户把本应用从**最近任务**里划掉 = 明确不要它了 —— 不留通知、不占前台档。
   *
   * 应用内那条退出路径（根页面按返回 → `finish()`）到不了这里：那条路上 `MainActivity.onStop`
   * 已经用 `isFinishing` 挡掉、根本不会起服务。
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  /**
   * 建通知渠道。**可重建**：已存在就直接返回。
   *
   * `createNotificationChannel()` 本身幂等（同 id 再建不会报错、也不会把用户改过的设置重置回去），
   * 这里先查一次只是因为没必要每次都进一趟系统服务；应用重启、服务反复起停都不会炸。
   */
  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.keepalive_channel_name),
      // 低优先级：不响、不震、不弹横幅（`setSilent(true)` 是同一件事的第二道保险）。
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = getString(R.string.keepalive_channel_description)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  /**
   * 那枚常驻通知。**文案是静态的，不含房间号 / 主播昵称 / 账号 / 弹幕内容**——
   * 通知栏是锁屏可见面，本仓库对敏感信息的口径见 `docs/operations.md` §3。
   *
   * `setOngoing(true)` = 划不掉。注意 Android 14 起系统允许用户划掉前台服务通知
   * （划掉只是通知消失，服务照跑），这一档不由应用决定。
   */
  private fun buildNotification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      // `singleTask`（见 AndroidManifest.xml）+ SINGLE_TOP：从通知回到那个**已经存在**的
      // Activity，而不是再叠一个 —— 回到前台会走 `onStart` 把服务收掉。
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_launcher_foreground)
      .setContentTitle(getString(R.string.keepalive_notification_title))
      .setContentText(getString(R.string.keepalive_notification_text))
      .setContentIntent(open)
      .setOngoing(true)
      .setShowWhen(false)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      // 默认（targetSdk 31+）系统会把前台通知压后 10 秒才显示；这里立刻显示：
      // 服务是长跑型的，晚 10 秒只是让「是否真的起了」变得难验证。
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  companion object {
    private const val TAG = "danmubox-keepalive"
    private const val CHANNEL_ID = "danmubox-keepalive"
    private const val NOTIFICATION_ID = 1

    /**
     * `FOREGROUND_SERVICE_TYPE_DATA_SYNC` 是 API 29 的常量；24..28 上系统没有「类型」这一说，
     * `ServiceCompat.startForeground` 会忽略这个参数（传 0）。
     */
    private fun foregroundServiceType(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
      } else {
        0
      }

    /** 起服务（`MainActivity.onStop` 且页面答「有活跃连接」时）。重复调用无副作用。 */
    fun start(context: Context) {
      try {
        ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java))
      } catch (err: IllegalStateException) {
        // Android 12 起后台不许起前台服务，Android 15 起 `dataSync` 还有每 24 小时 6 小时的
        // 额度——两种情况抛的都是 `ForegroundServiceStartNotAllowedException`（它是
        // `IllegalStateException` 的子类；这里按父类接是**故意的**：那个类 API 31 才有，
        // 在 minSdk 24 的包上直接 catch 它会让老设备在校验期去解析一个不存在的类）。
        //
        // 接住而不是崩：保活是「锦上添花」，起不来就退化成保活之前的行为，用户照旧能看到
        // 通知栏以外的一切。原因写进 logcat 便于排查（`docs/operations.md` §2.8）。
        Log.w(TAG, "系统不允许在此时启动前台服务，本次不保活", err)
      }
    }

    /** 停服务（`MainActivity.onStart`、`onTaskRemoved`）。没在跑时是空操作，不报错。 */
    fun stop(context: Context) {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }
  }
}
