package io.github.ozakijun.am

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge draws the page under the status bar, the gesture /
    // navigation bar and the keyboard. Keep it between them instead: the
    // page gets the space that is really free, and the keyboard pushes the
    // chat's input box up rather than covering it.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val free = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(free.left, free.top, free.right, free.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
