package com.hipago.app;

import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Capacitor plugin for in-app APK update.
 *
 * Two methods:
 *   check({owner, repo}) → {available, version?, notes?, apkUrl?}
 *     Queries https://api.github.com/repos/{owner}/{repo}/releases/latest,
 *     compares the tag (e.g. "v0.0.7") against the installed app version,
 *     finds the first `.apk` asset, returns the download URL. Resolves
 *     {available:false} on any network or parse error (UI prefers silent
 *     no-op over a broken banner).
 *
 *   install({apkUrl}) → {status}
 *     Downloads via DownloadManager into the app's external-files Downloads
 *     directory (path declared in res/xml/file_paths.xml), then on
 *     ACTION_DOWNLOAD_COMPLETE fires an Intent.ACTION_VIEW with a
 *     FileProvider URI and the application/vnd.android.package-archive MIME
 *     type. Resolves when the installer/settings UI is opened so the app UI
 *     can recover if the user cancels or returns without installing.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {

    @PluginMethod
    public void check(PluginCall call) {
        final String owner = call.getString("owner");
        final String repo = call.getString("repo");
        if (owner == null || owner.isEmpty() || repo == null || repo.isEmpty()) {
            call.reject("owner and repo are required");
            return;
        }
        new Thread(() -> {
            try {
                URL url = new URL("https://api.github.com/repos/" + owner + "/" + repo + "/releases/latest");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestProperty("Accept", "application/vnd.github+json");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(15000);

                int code = conn.getResponseCode();
                if (code != 200) {
                    JSObject ret = new JSObject();
                    ret.put("available", false);
                    call.resolve(ret);
                    return;
                }

                StringBuilder body = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        body.append(line).append('\n');
                    }
                }

                JSONObject json = new JSONObject(body.toString());
                String tag = json.optString("tag_name", "");
                String remoteVer = tag.startsWith("v") ? tag.substring(1) : tag;
                String currentVer = getCurrentVersion();
                if (remoteVer.isEmpty() || !isNewer(remoteVer, currentVer)) {
                    JSObject ret = new JSObject();
                    ret.put("available", false);
                    call.resolve(ret);
                    return;
                }

                String apkUrl = findApkAssetUrl(json.optJSONArray("assets"));
                if (apkUrl == null) {
                    JSObject ret = new JSObject();
                    ret.put("available", false);
                    ret.put("reason", "no .apk asset in release");
                    call.resolve(ret);
                    return;
                }

                JSObject ret = new JSObject();
                ret.put("available", true);
                ret.put("version", remoteVer);
                ret.put("notes", json.optString("body", ""));
                ret.put("apkUrl", apkUrl);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("available", false);
                ret.put("error", e.getMessage() != null ? e.getMessage() : e.toString());
                call.resolve(ret);
            }
        }).start();
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String apkUrl = call.getString("apkUrl");
        if (apkUrl == null || apkUrl.isEmpty()) {
            call.reject("apkUrl is required");
            return;
        }
        final Context ctx = getContext();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !ctx.getPackageManager().canRequestPackageInstalls()) {
                openUnknownSourcesSettings(ctx);
                JSObject ret = new JSObject();
                ret.put("status", "permission_required");
                call.resolve(ret);
                return;
            }

            File dlDir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dlDir == null) {
                call.reject("external files dir unavailable");
                return;
            }
            final File apkFile = new File(dlDir, "hipago-update.apk");
            if (apkFile.exists()) {
                // Stale APK from a half-finished prior run would resolve to
                // a different version; force a fresh download.
                //noinspection ResultOfMethodCallIgnored
                apkFile.delete();
            }

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setTitle("HiPaGo update");
            req.setDescription("Downloading new APK…");
            req.setMimeType("application/vnd.android.package-archive");
            req.setDestinationUri(Uri.fromFile(apkFile));
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE);

            DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                call.reject("DownloadManager unavailable");
                return;
            }
            final long downloadId = dm.enqueue(req);

            // Surface download progress to the JS layer so the in-app banner /
            // settings card show a moving bar instead of a frozen 0%.
            // DownloadManager has no progress callback, so poll it.
            startProgressPolling(dm, downloadId);

            final BroadcastReceiver onComplete = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent i) {
                    long completedId = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (completedId != downloadId) {
                        return;
                    }
                    try {
                        ctx.unregisterReceiver(this);
                    } catch (IllegalArgumentException ignored) {
                        // Already unregistered; safe to ignore.
                    }

                    if (!isSuccessfulDownload(dm, downloadId)) {
                        call.reject("download failed");
                        return;
                    }

                    if (!apkFile.exists() || apkFile.length() <= 0) {
                        call.reject("downloaded APK missing or empty");
                        return;
                    }

                    Uri apkUri = FileProvider.getUriForFile(
                            ctx,
                            ctx.getPackageName() + ".fileprovider",
                            apkFile);
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        ctx.startActivity(install);
                        JSObject ret = new JSObject();
                        ret.put("status", "installer_started");
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject("installer launch failed: "
                                + (e.getMessage() != null ? e.getMessage() : e.toString()), e);
                    }
                }
            };
            IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            // Android 14 (API 34) tightens runtime-receiver rules; the
            // ContextCompat overload picks the right flag per API level
            // for receivers listening to system broadcasts.
            ContextCompat.registerReceiver(ctx, onComplete, filter, ContextCompat.RECEIVER_EXPORTED);
        } catch (Exception e) {
            call.reject("install failed: " + (e.getMessage() != null ? e.getMessage() : e.toString()), e);
        }
    }

    /**
     * Poll DownloadManager for the running download and emit `downloadProgress`
     * events (percent 0-100) until the download reaches a terminal state.
     * DownloadManager exposes no progress callback, so a short poll loop is the
     * only way to drive the in-app progress bar. The thread ends on its own when
     * the download succeeds, fails, or its row disappears — no cancel plumbing.
     */
    private void startProgressPolling(final DownloadManager dm, final long downloadId) {
        new Thread(() -> {
            while (true) {
                int status = -1;
                long soFar = -1;
                long total = -1;
                DownloadManager.Query q = new DownloadManager.Query().setFilterById(downloadId);
                try (Cursor c = dm.query(q)) {
                    if (c == null || !c.moveToFirst()) {
                        return; // row gone — nothing left to report
                    }
                    int si = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    int bi = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    int ti = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                    if (si >= 0) status = c.getInt(si);
                    if (bi >= 0) soFar = c.getLong(bi);
                    if (ti >= 0) total = c.getLong(ti);
                } catch (Exception e) {
                    return;
                }

                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    emitProgress(100);
                    return;
                }
                if (status == DownloadManager.STATUS_FAILED) {
                    return;
                }
                // Only report a real percentage when the server gave a total
                // length; otherwise leave the UI in its indeterminate state
                // instead of showing a false number.
                if (total > 0 && soFar >= 0) {
                    long pct = (soFar * 100L) / total;
                    emitProgress((int) Math.max(0, Math.min(100, pct)));
                }

                try {
                    Thread.sleep(300);
                } catch (InterruptedException e) {
                    return;
                }
            }
        }).start();
    }

    private void emitProgress(int percent) {
        JSObject ev = new JSObject();
        ev.put("percent", percent);
        notifyListeners("downloadProgress", ev);
    }

    private static void openUnknownSourcesSettings(Context ctx) {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + ctx.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Intent fallback = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(fallback);
        }
    }

    private static boolean isSuccessfulDownload(DownloadManager dm, long downloadId) {
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
        try (Cursor cursor = dm.query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                return false;
            }
            int statusIndex = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
            if (statusIndex < 0) {
                return false;
            }
            return cursor.getInt(statusIndex) == DownloadManager.STATUS_SUCCESSFUL;
        }
    }

    private static String findApkAssetUrl(JSONArray assets) {
        if (assets == null) {
            return null;
        }
        for (int i = 0; i < assets.length(); i++) {
            JSONObject a = assets.optJSONObject(i);
            if (a == null) {
                continue;
            }
            String name = a.optString("name", "");
            if (name.toLowerCase().endsWith(".apk")) {
                String url = a.optString("browser_download_url", "");
                if (!url.isEmpty()) {
                    return url;
                }
            }
        }
        return null;
    }

    private static boolean isNewer(String remote, String current) {
        String[] r = remote.split("\\.");
        String[] c = current.split("\\.");
        int n = Math.max(r.length, c.length);
        for (int i = 0; i < n; i++) {
            int ri = parseIntSafe(i < r.length ? r[i] : "0");
            int ci = parseIntSafe(i < c.length ? c[i] : "0");
            if (ri > ci) return true;
            if (ri < ci) return false;
        }
        return false;
    }

    private String getCurrentVersion() throws Exception {
        Context ctx = getContext();
        PackageInfo info = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
        return info.versionName != null ? info.versionName : "0.0.0";
    }

    private static int parseIntSafe(String s) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
