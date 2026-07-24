const fs = require('fs-extra');
const path = require('path');

class AndroidTemplateService {
    static async generateProjectStructure(outputDir, project) {
        await fs.ensureDir(outputDir);
        
        // Root build.gradle
        await fs.outputFile(path.join(outputDir, 'build.gradle'), `
            buildscript {
                repositories { google() ; mavenCentral() }
                dependencies {
                    classpath 'com.android.tools.build:gradle:8.0.2'
                    classpath 'com.google.gms:google-services:4.3.15'
                }
            }
        `);

        // App-level build.gradle
        await fs.outputFile(path.join(outputDir, 'app/build.gradle'), `
            plugins {
                id 'com.android.application'
                id 'kotlin-android'
                id 'com.google.gms.google-services'
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
                    }
                }
            }
            dependencies {
                implementation 'androidx.core:core-ktx:1.10.1'
                implementation 'androidx.appcompat:appcompat:1.6.1'
                implementation 'com.google.android.material:material:1.9.0'
                implementation 'com.google.firebase:firebase-messaging-ktx:23.1.2'
            }
        `);

        await this.generateManifest(outputDir, project);
        await this.generateNativeKotlin(outputDir, project);
        await this.generateSplashXml(outputDir, project);
    }

    static async generateManifest(outputDir, project) {
        const manifestPath = path.join(outputDir, 'app/src/main/AndroidManifest.xml');
        const permissions = project.permissions;

        let permissionsXml = '';
        if (permissions.internet) permissionsXml += '    <uses-permission android:name="android.permission.INTERNET" />\n';
        if (permissions.camera) permissionsXml += '    <uses-permission android:name="android.permission.CAMERA" />\n';
        if (permissions.storage) {
            permissionsXml += '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />\n';
            permissionsXml += '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />\n';
        }
        if (permissions.location) {
            permissionsXml += '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n';
        }

        const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.google.com/apk/res/android">
${permissionsXml}
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="${project.appName}"
        android:theme="@style/Theme.AppCompat.NoActionBar">
        
        <activity
            android:name=".SplashActivity"
            android:exported="true"
            android:theme="@style/SplashTheme">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize"
            android:exported="false" />

        <service
            android:name=".MyFirebaseMessagingService"
            android:exported="false">
            <intent-filter>
                <action android:name="com.google.firebase.MESSAGING_EVENT" />
            </intent-filter>
        </service>
    </application>
</manifest>`;

        await fs.outputFile(manifestPath, manifestContent);
    }

    static async generateNativeKotlin(outputDir, project) {
        const packageFolder = project.packageName.replace(/\./g, '/');
        const srcDir = path.join(outputDir, `app/src/main/java/${packageFolder}`);

        // MainActivity.kt with WebView and Native Javascript API Bridge
        await fs.outputFile(path.join(srcDir, 'MainActivity.kt'), `
package ${project.packageName}

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        
        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(WebHostNativeBridge(this), "WebHostNative")
        
        webView.loadUrl("${project.websiteURL}")
        setContentView(webView)
    }

    inner class WebHostNativeBridge(private val context: Context) {
        @JavascriptInterface
        public void showToast(message: String) {
            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
        }

        @JavascriptInterface
        public void openCamera() {
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
            (context as Activity).startActivityForResult(intent, 101)
        }
    }
}`);

        // Firebase Service
        await fs.outputFile(path.join(srcDir, 'MyFirebaseMessagingService.kt'), `
package ${project.packageName}

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import android.util.Log

class MyFirebaseMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.d("FCM", "Message Received: " + remoteMessage.notification?.body)
    }
}`);

        // SplashActivity.kt
        await fs.outputFile(path.join(srcDir, 'SplashActivity.kt'), `
package ${project.packageName}

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
}`);
    }

    static async generateSplashXml(outputDir, project) {
        const resDir = path.join(outputDir, 'app/src/main/res');
        
        // Colors.xml
        await fs.outputFile(path.join(resDir, 'values/colors.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="splash_bg">${project.splashScreen.backgroundColor}</color>
</resources>`);

        // Styles.xml for splash
        await fs.outputFile(path.join(resDir, 'values/styles.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="SplashTheme" parent="Theme.AppCompat.NoActionBar">
        <item name="android:windowBackground">@color/splash_bg</item>
    </style>
</resources>`);

        // activity_splash.xml layout
        await fs.outputFile(path.join(resDir, 'layout/activity_splash.xml'), `<?xml version="1.0" encoding="utf-8"?>
<RelativeLayout xmlns:android="http://schemas.google.com/apk/res/android"
    android:layout_width="match_match"
    android:layout_height="match_parent"
    android:background="@color/splash_bg"
    android:gravity="center">
    
    <ImageView
        android:id="@+id/splash_logo"
        android:layout_width="120dp"
        android:layout_height="120dp"
        android:src="@drawable/splash_logo" />
</RelativeLayout>`);
    }
}

module.exports = AndroidTemplateService;
