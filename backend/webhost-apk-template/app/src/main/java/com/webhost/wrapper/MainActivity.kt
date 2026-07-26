package com.webhost.wrapper

import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Minimal WebView shell.
 *
 * This is the piece the original WebHost project was missing: the server
 * patches a JSON config file (assets/webhost_config.json) into this APK
 * after it's built, and THIS activity is what actually reads that file and
 * loads the configured URL. Without an app on the other end that reads that
 * specific file, patching the config does nothing — the compiled app would
 * just show whatever was hardcoded (or nothing) at build time.
 *
 * Expected assets/webhost_config.json shape (see server.js buildAndroidApk):
 *   { "url": "https://your-deployed-site", "title": "App Name", "generatedAt": "..." }
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.webViewClient = WebViewClient()

        val config = readConfig()
        val targetUrl = config?.optString("url")

        if (config != null) {
            val title = config.optString("title")
            if (title.isNotBlank()) setTitle(title)
        }

        if (!targetUrl.isNullOrBlank()) {
            webView.loadUrl(targetUrl)
        } else {
            Toast.makeText(
                this,
                "No target URL was configured for this app (assets/webhost_config.json missing or empty).",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun readConfig(): JSONObject? {
        return try {
            val inputStream = assets.open("webhost_config.json")
            val reader = BufferedReader(InputStreamReader(inputStream))
            val text = reader.readText()
            reader.close()
            JSONObject(text)
        } catch (e: Exception) {
            // No config bundled yet — fine for a freshly-built, unpatched template.
            null
        }
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
