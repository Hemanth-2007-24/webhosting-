# WebHost Template APK

A minimal, working Android WebView shell for the WebHost platform's App
Studio / Instant Web-to-App compiler.

## Why this exists

The compiler in `server.js` patches a config file
(`assets/webhost_config.json`) into a "template" APK after it's built. That
only works if the app inside the template actually *reads* that file and
loads the URL from it. This repo is exactly that app — nothing more. See
`app/src/main/java/com/webhost/wrapper/MainActivity.kt`.

## One-time setup (you only do this once)

1. Create a new **public** GitHub repo (private also works, just use a
   personal access token in the URL later) and push everything in this
   folder to it.
2. GitHub Actions will automatically build a debug APK on every push to
   `main` (see `.github/workflows/build-apk.yml`). You can watch it under
   the repo's **Actions** tab.
3. When you're happy with it, tag a release so you get a stable download
   URL:
   ```bash
   git tag v1.0
   git push origin v1.0
   ```
   The workflow will attach `app-debug.apk` to a GitHub Release
   automatically.
4. Copy the release asset's download URL — it'll look like:
   ```
   https://github.com/<you>/<repo>/releases/download/v1.0/app-debug.apk
   ```
5. On your WebHost server (e.g. in Railway's environment variables), set:
   ```
   BASE_APK_TEMPLATE_URL=https://github.com/<you>/<repo>/releases/download/v1.0/app-debug.apk
   ```
6. Delete any previously-cached bad template so the server re-downloads the
   working one — on Railway, that means clearing/redeploying the volume
   that backs `compiled_apps/webview_base_template.apk`, or just renaming
   `TEMPLATE_APK_PATH` in `server.js` once so it's forced to fetch fresh.

## Signing

This build uses Gradle's built-in **debug** signing key, so the resulting
APK installs fine on a device (with "install from unknown sources"
allowed) — it just isn't signed for the Play Store. That's consistent with
what the original WebHost project was already producing (or trying to).
If you eventually want Play Store distribution, you'll need your own
release keystore and `apksigner` — a separate, bigger step.

## Local build (optional)

If you have Android Studio installed, you can open this folder directly
and hit Run/Build — no changes needed.
