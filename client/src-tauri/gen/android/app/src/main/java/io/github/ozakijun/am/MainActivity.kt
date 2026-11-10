package io.github.ozakijun.am

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

/**
 * The AM app on Android (docs/design.md §5 手机和安卓).
 *
 * The page draws behind the status bar and the gesture / navigation bar
 * (edge-to-edge) so the app's own background shows there; it pads itself by
 * the bar heights it reads from `AMAndroid.insets()` (CSS --safe-top /
 * --safe-bottom, lib/android.ts). Only the keyboard and side cutouts pad the
 * view itself, so the keyboard pushes the chat's input box up.
 *
 * `AMAndroid` is the page's bridge for what only Android can do: bar icon
 * colours, the keep-alive service, the battery-optimisation request and
 * installing a downloaded update.
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  @Volatile private var insetsJson = "{\"top\":0,\"bottom\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val keyboard = insets.isVisible(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, 0, bars.right, if (keyboard) ime.bottom else 0)
      val d = resources.displayMetrics.density
      val top = bars.top / d
      val bottom = if (keyboard) 0f else bars.bottom / d
      insetsJson = "{\"top\":$top,\"bottom\":$bottom}"
      webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('am-insets'))", null) }
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "AMAndroid")
  }

  inner class Bridge {
    /** Status bar and gesture bar heights in CSS pixels: {"top":…,"bottom":…}. */
    @JavascriptInterface
    fun insets(): String = insetsJson

    /** Dark icons on a light page, light icons on a dark one. */
    @JavascriptInterface
    fun setLightBars(light: Boolean) {
      runOnUiThread {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        c.isAppearanceLightStatusBars = light
        c.isAppearanceLightNavigationBars = light
      }
    }

    /** The foreground service that keeps AM connected in the background. */
    @JavascriptInterface
    fun keepAlive(on: Boolean) {
      runOnUiThread {
        if (on) KeepAliveService.start(this@MainActivity) else KeepAliveService.stop(this@MainActivity)
      }
    }

    @JavascriptInterface
    fun batteryUnrestricted(): Boolean {
      val pm = getSystemService(POWER_SERVICE) as PowerManager
      return pm.isIgnoringBatteryOptimizations(packageName)
    }

    /** Asks the system to stop putting AM to sleep in the background. */
    @JavascriptInterface
    fun askBatteryUnrestricted() {
      runOnUiThread {
        try {
          startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
          startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
      }
    }

    /**
     * Hands a downloaded, checked APK (in the app's cache folder) to the
     * system installer. Returns "" or why not: "permission" = AM may not
     * install apps yet (the settings page opens), else an error.
     */
    @JavascriptInterface
    fun installApk(path: String): String {
      val file = File(path).canonicalFile
      val dir = File(cacheDir, "AM-update").canonicalFile
      if (file.parentFile != dir || !file.name.endsWith(".apk") || !file.isFile) return "不是下载好的安装包"
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
        runOnUiThread {
          startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
        }
        return "permission"
      }
      val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      runOnUiThread { startActivity(intent) }
      return ""
    }
  }
}
