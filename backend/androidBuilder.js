// =================================================================
// ==                  androidBuilder.js                          ==
// =================================================================

const fs = require('fs-extra');
const path = require('path');

class AndroidBuilder {
    static async generateProjectStructure(workspaceDir, project) {
        const packagePath = project.packageName.replace(/\./g, '/');
        const srcDir = path.join(workspaceDir, `app/src/main/java/${packagePath}`);
        const resDir = path.join(workspaceDir, 'app/src/main/res');

        await fs.ensureDir(srcDir);
        await fs.ensureDir(resDir);

        await this.writeBuildGradle(workspaceDir, project);
        await this.writeAndroidManifest(workspaceDir, project);
        await this.writeMainActivity(srcDir, project);
        await this.writeSplashActivity(srcDir, project);
        await this.writeResourceLayouts(resDir, project);
    }

    static async writeBuildGradle(workspaceDir, project) {
        // Root build.gradle
        await fs.outputFile(path.join(workspaceDir, 'build.gradle'), `
            buildscript {
                repositories { google() ; mavenCentral() }
                dependencies {
                    classpath 'com.android.tools.build:gradle:8.0.2'
                    classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.8.20'
                }
            }
            allprojects {
                repositories { google() ; mavenCentral() }
            }
        `);

        // App-level build.gradle
        await fs.outputFile(path.join(workspaceDir, 'app/build.gradle'), `
            plugins {
                id 'com.android.application'
                id 'kotlin-android'
            }
            android {
                namespace '${project.packageName}'
                compileSdk 33
                defaultConfig {
                    applicationId "${project.packageName}"
                    minSdk 21
                    targetSdk 33
                    versionCode ${project.versionCode}
                    versionName "${project.versionName}"
                }
                buildTypes {
                    release {
                        minifyEnabled false
                        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
                    }
                }
            }
            dependencies {
                implementation 'androidx.core:core-ktx:1.10.1'
                implementation 'androidx.appcompat:appcompat:1.6.1'
                implementation 'com.google.android.material:material:1.9.0'
                implementation 'androidx.swiperefreshlayout:swiperefreshlayout:1.1.0'
            }
        `);
    }

    static async writeAndroidManifest(workspaceDir, project) {
        let permissionsXml = '';
        if (project.permissions.internet) permissionsXml += '    <uses-permission android:name="android.permission.INTERNET" />\n';
        if (project.permissions.camera) permissionsXml += '    <uses-permission android:name="android.permission.CAMERA" />\n';
        if (project.permissions.storage) {
            permissionsXml += '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n';
            permissionsXml += '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />\n';
        }
        if (project.permissions.location) {
            permissionsXml += '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n';
            permissionsXml += '    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n';
        }

        // Custom Manifest Injections via CustomCode settings
        let customManifestBlock = '';
        if (project.customCode && project.customCode.includes('<manifest')) {
            customManifestBlock = project.customCode.substring(
                project.customCode.indexOf('<manifest') + 10,
                project.customCode.indexOf('</manifest>')
            );
        }

        const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.google.com/apk/res/android"
    package="${project.packageName}">
    
${permissionsXml}
${customManifestBlock}

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="${project.appName}"
        android:theme="@style/Theme.AppCompat.NoActionBar"
        android:usesCleartextTraffic="true">
        
        <activity
            android:name=".SplashActivity"
            android:exported="true"
            android:theme="@style/Theme.AppCompat.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden"
            android:exported="false" />
    </application>
</manifest>`;

        await fs.outputFile(path.join(workspaceDir, 'app/src/main/AndroidManifest.xml'), manifest);
    }

    static async writeMainActivity(srcDir, project) {
        // Custom Code logic parsing and JavaScript injection targets
        let jsInjectCode = '';
        let kotlinInjectCode = '';
        if (project.customCode) {
            if (project.customCode.includes('<script>')) {
                jsInjectCode = project.customCode.substring(
                    project.customCode.indexOf('<script>') + 8,
                    project.customCode.indexOf('</script>')
                ).replace(/"/g, '\\"').replace(/\n/g, ' ');
            }
            if (project.customCode.includes('//kotlin')) {
                kotlinInjectCode = project.customCode.substring(
                    project.customCode.indexOf('//kotlin') + 8
                );
            }
        }

        const mainActivity = `package ${project.packageName}

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.*
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var swipeRefresh: SwipeRefreshLayout

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        progressBar = findViewById(R.id.progressBar)
        swipeRefresh = findViewById(R.id.swipeRefresh)

        // WebHost WebView configurations
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        webView.settings.databaseEnabled = true
        webView.settings.userAgentString = "WebHost-Native-WebView-AndroidContainer"
        
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                progressBar.visibility = View.GONE
                swipeRefresh.isRefreshing = false
                
                // Inject custom user JS directly into Page context
                if ("${jsInjectCode}".isNotEmpty()) {
                    webView.evaluateJavascript("javascript:(function() { ${jsInjectCode} })()", null)
                }
            }

            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                webView.loadUrl("file:///android_asset/offline.html")
            }

            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                handler?.proceed() // Support self-signed SSL structures cleanly
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                if (newProgress == 100) {
                    progressBar.visibility = View.GONE
                } else {
                    progressBar.visibility = View.VISIBLE
                }
            }
        }

        // Native Download Manager mapping
        webView.setDownloadListener { url, userAgent, contentDisposition, mimetype, contentLength ->
            try {
                val request = DownloadManager.Request(Uri.parse(url))
                request.setMimeType(mimetype)
                request.addRequestHeader("User-Agent", userAgent)
                request.setDescription("Downloading file assets...")
                request.setTitle(URLUtil.guessFileName(url, contentDisposition, mimetype))
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, contentDisposition, mimetype))
                val dm = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
                dm.enqueue(request)
                Toast.makeText(applicationContext, "Download started...", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(applicationContext, "Download failed: " + e.message, Toast.LENGTH_LONG).show()
            }
        }

        swipeRefresh.setOnRefreshListener {
            webView.reload()
        }

        webView.loadUrl("${project.websiteUrl}")
        
        ${kotlinInjectCode}
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}`;

        await fs.outputFile(path.join(srcDir, 'MainActivity.kt'), mainActivity);
    }

    static async writeSplashActivity(srcDir, project) {
        const splash = `package ${project.packageName}

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity

class SplashActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash)

        Handler(Looper.getMainLooper()).postDelayed({
            startActivity(Intent(this, MainActivity::class.java))
            finish()
        }, 2000)
    }
}`;
        await fs.outputFile(path.join(srcDir, 'SplashActivity.kt'), splash);
    }

    static async writeResourceLayouts(resDir, project) {
        // Colors
        await fs.outputFile(path.join(resDir, 'values/colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="primary">${project.themeColor}</color>
    <color name="splash_bg">${project.themeColor}</color>
</resources>`);

        // MainActivity Layout XML
        await fs.outputFile(path.join(resDir, 'layout/activity_main.xml'), `<?xml version="1.0" encoding="utf-8"?>
<androidx.swiperefreshlayout.widget.SwipeRefreshLayout xmlns:android="http://schemas.google.com/apk/res/android"
    android:id="@+id/swipeRefresh"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <RelativeLayout
        android:layout_width="match_parent"
        android:layout_height="match_parent">

        <WebView
            android:id="@+id/webView"
            android:layout_width="match_parent"
            android:layout_height="match_parent" />

        <ProgressBar
            android:id="@+id/progressBar"
            style="?android:attr/progressBarStyleHorizontal"
            android:layout_width="match_parent"
            android:layout_height="6dp"
            android:layout_alignParentTop="true"
            android:progressDrawable="@android:drawable/progress_horizontal" />
    </RelativeLayout>
</androidx.swiperefreshlayout.widget.SwipeRefreshLayout>`);

        // Splash Layout XML
        await fs.outputFile(path.join(resDir, 'layout/activity_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<RelativeLayout xmlns:android="http://schemas.google.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="@color/splash_bg">

    <ImageView
        android:layout_width="150dp"
        android:layout_height="150dp"
        android:layout_centerInParent="true"
        android:src="@drawable/splash_logo" />
</RelativeLayout>`);

        // Generate Offline Assets
        const assetsDir = path.join(resDir, '../assets');
        await fs.ensureDir(assetsDir);
        await fs.outputFile(path.join(assetsDir, 'offline.html'), `<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Offline</title>
    <style>
        body { font-family: sans-serif; text-align: center; background: #0F172A; color: white; padding-top: 20%; }
        h1 { color: #ef4444; }
    </style>
</head>
<body>
    <h1>Connection Lost</h1>
    <p>Please check your internet settings and try again.</p>
</body>
</html>`);
    }
}

module.exports = AndroidBuilder;
