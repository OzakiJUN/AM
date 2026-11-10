package io.github.ozakijun.am

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps AM running while it is in the background (docs/design.md §5
 * 后台保持连接): a foreground service with a quiet, permanent notification,
 * so Android does not freeze or kill the app and its connections to the
 * servers stay open; new messages then notify as usual. Turned on and off
 * by the page (设置 → 通知 →「后台保持连接」) through MainActivity's bridge.
 * Swiping AM away from the recent apps ends it.
 */
class KeepAliveService : Service() {
  companion object {
    private const val CHANNEL = "keep-alive"
    private const val ID = 1

    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, KeepAliveService::class.java))
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, KeepAliveService::class.java))
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "后台保持连接", NotificationManager.IMPORTANCE_MIN).apply {
        description = "AM 在后台时保持和服务器的连接，这样新消息能马上提醒你"
        setShowBadge(false)
      })
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val n = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_am)
      .setContentTitle("AM 在后台保持连接")
      .setContentText("新消息会马上提醒你。不需要的话在 AM 的设置 → 通知里关掉")
      .setContentIntent(open)
      .setOngoing(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
    ServiceCompat.startForeground(this, ID, n, type)
    // Not sticky: without the app's window there is no connection to keep.
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }
}
