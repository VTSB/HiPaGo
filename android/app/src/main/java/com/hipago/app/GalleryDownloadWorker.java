package com.hipago.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import uniffi.bypass.BypassKt;

/**
 * WorkManager worker that drains the gallery download handoff queue on Android.
 *
 * On Android the worker is the SOLE downloader (web/Tauri/iOS keep the in-process
 * TS downloader). TS resolves each work-order, writes it as a JSON file into the
 * handoff dir, and enqueues this worker via {@link DownloadWorkerPlugin}. The
 * worker is DB-decoupled: it reads those JSON files, downloads images via the
 * Rust core ({@code BypassKt.bypassDownloadToFile}), and writes the images +
 * {@code 0000.json} manifest into the SAF tree exactly where the TS reader looks
 * ({@link SafLibrary}). TS reconciles row status on next app open.
 *
 * Handoff dir: {@code context.getFilesDir()/dl-queue/<galleryId>.json}.
 * Work-order JSON shape (written by TS {@code writeWorkOrder}):
 * <pre>
 *   { "galleryId": 12345, "title": "...", "folderName": "12345 Title",
 *     "pages": [ { "index": 0, "url": "https://…", "headers": { "Referer": … },
 *                  "ext": "webp", "relPath": "HiPaGo/12345 Title/0001.webp" }, … ] }
 * </pre>
 *
 * Behaviour:
 *  - Sequential: one gallery, one page at a time (no parallelism).
 *  - Resume: a page already present in the SAF tree ({@link SafLibrary#exists})
 *    is skipped, so an app-kill-interrupted gallery resumes from disk.
 *  - The {@code 0000.json} manifest (a JSON array of per-page exts) is rewritten
 *    incrementally after each page so the TS reader/reconcile sees progress.
 *  - On a page hard-failure the gallery is left partial and its work-order is
 *    KEPT (TS auto-retry/reconcile decides what to do); the worker breaks to the
 *    next work-order file. The work-order is deleted ONLY on full success.
 *  - One SUMMARY foreground notification is updated across all galleries (not one
 *    per gallery), satisfying the foreground-service requirement.
 *  - Honors {@link #isStopped()} (WorkManager cancellation) between pages.
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file is verified by
 * code review here and must be smoke-tested on a physical/emulator Android
 * device (foreground service, SAF-from-worker, resume, network constraint).
 */
public class GalleryDownloadWorker extends Worker {

    public static final String UNIQUE_WORK_NAME = "hipago-downloads";
    public static final String HANDOFF_DIR = "dl-queue";

    private static final String CHANNEL_ID = "hipago-downloads";
    private static final int NOTIFICATION_ID = 4201;

    private final SafLibrary saf;

    public GalleryDownloadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
        // A fresh SafLibrary per worker run is fine — the worker is sequential, so
        // its dir cache never races. Uses the worker's application context.
        this.saf = new SafLibrary(context);
    }

    @NonNull
    @Override
    public Result doWork() {
        // Go foreground immediately so the system shows the progress notification
        // and does not kill the worker while the app is backgrounded.
        try {
            setForegroundAsync(buildForegroundInfo("Preparing downloads…", 0, 0)).get();
        } catch (Throwable t) {
            // setForegroundAsync can fail (e.g. POST_NOTIFICATIONS denied on 13+).
            // The download can still proceed; we just lose the visible progress.
        }

        File handoffDir = new File(getApplicationContext().getFilesDir(), HANDOFF_DIR);
        File[] orderFiles = handoffDir.listFiles((dir, name) -> name.endsWith(".json"));
        if (orderFiles == null || orderFiles.length == 0) {
            return Result.success();
        }

        // Process in stable name order (TS names files <galleryId>.json; sorting by
        // name gives a deterministic order that the app can reason about).
        Arrays.sort(orderFiles, Comparator.comparing(File::getName));

        // Without a SAF tree there is nowhere to write — retry later (the user may
        // re-grant the folder, after which the same work-orders are still queued).
        if (!saf.hasTree()) {
            return Result.retry();
        }

        for (File orderFile : orderFiles) {
            if (isStopped()) {
                // WorkManager cancelled us — stop cleanly, leaving remaining
                // work-orders for the next run.
                return Result.success();
            }

            JSONObject order = readOrder(orderFile);
            if (order == null) {
                // Unparseable work-order — drop it so it does not wedge the queue.
                orderFile.delete();
                continue;
            }

            boolean completed = processGallery(order);
            if (completed) {
                // Full success → remove the work-order so it is not reprocessed.
                orderFile.delete();
            }
            // On failure we KEEP the file: TS reconcile/auto-retry decides. We just
            // advance to the next gallery.
        }

        return Result.success();
    }

    // -----------------------------------------------------------------------
    // Per-gallery processing
    // -----------------------------------------------------------------------

    /**
     * Download every page of one gallery.
     *
     * @return true when ALL pages are present on disk (full success); false when
     *         a page failed (partial gallery left in place) or we were stopped.
     */
    private boolean processGallery(JSONObject order) {
        String title = order.optString("title", "");
        JSONArray pages = order.optJSONArray("pages");
        if (pages == null || pages.length() == 0) {
            // Nothing to download — treat as complete so the work-order is cleared.
            return true;
        }

        int total = pages.length();
        File cacheDir = getApplicationContext().getCacheDir();

        // The manifest is the per-page ext array. Seed it from any pages already
        // on disk so an interrupted gallery resumes with a correct manifest.
        String[] exts = new String[total];

        for (int i = 0; i < total; i++) {
            if (isStopped()) return false;

            JSONObject page = pages.optJSONObject(i);
            if (page == null) return false; // malformed — leave the gallery partial

            String relPath = page.optString("relPath", null);
            String url = page.optString("url", null);
            String ext = page.optString("ext", "webp");
            if (relPath == null || url == null) return false;

            exts[i] = ext;

            updateNotification(title, i + 1, total);

            // Resume: skip a page already written to the SAF tree.
            if (saf.exists(relPath)) {
                continue;
            }

            // Download to a temp file in the cache dir via the Rust core, then copy
            // into the SAF tree and delete the temp. The image never enters the JS
            // heap (this is native code).
            File temp = new File(cacheDir, "dl-" + System.nanoTime() + "." + ext);
            try {
                BypassKt.bypassDownloadToFile(url, headersFor(page), temp.getAbsolutePath());
                saf.copyFromFile(temp.getAbsolutePath(), relPath);
            } catch (Throwable t) {
                // Page hard-failure (URL/gg expiry, network, SAF revoked). Leave the
                // gallery partial; TS re-resolves / reconciles on next open.
                return false;
            } finally {
                if (temp.exists()) {
                    // Best-effort temp cleanup; a stale temp is harmless (cache dir).
                    //noinspection ResultOfMethodCallIgnored
                    temp.delete();
                }
            }

            // Write/update the 0000.json manifest incrementally (JSON array of
            // exts) so the reader/reconcile sees the gallery growing. The manifest
            // path is the gallery folder + 0000.json, derived from the page relPath.
            writeManifest(relPath, exts, i + 1);
        }

        // All pages present → write the final, full manifest once more (defensive)
        // and report success.
        String anyRelPath = pages.optJSONObject(0).optString("relPath", null);
        if (anyRelPath != null) writeManifest(anyRelPath, exts, total);
        return true;
    }

    /**
     * Build the {@code 0000.json} manifest path from a page's relPath (same parent
     * dir) and write the first {@code count} exts as a JSON array.
     */
    private void writeManifest(String pageRelPath, String[] exts, int count) {
        int slash = pageRelPath.lastIndexOf('/');
        String dir = slash < 0 ? "" : pageRelPath.substring(0, slash);
        String manifestPath = (dir.isEmpty() ? "" : dir + "/") + "0000.json";

        JSONArray arr = new JSONArray();
        for (int k = 0; k < count; k++) {
            arr.put(exts[k] != null ? exts[k] : "webp");
        }
        try {
            saf.writeBytes(manifestPath, arr.toString().getBytes("UTF-8"));
        } catch (Throwable t) {
            // A torn manifest is recoverable (TS reconcile re-derives from the files
            // present); do not fail the whole gallery over a manifest write.
        }
    }

    private Map<String, String> headersFor(JSONObject page) {
        JSONObject h = page.optJSONObject("headers");
        if (h == null) return null;
        Map<String, String> out = new HashMap<>();
        Iterator<String> keys = h.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            out.put(key, h.optString(key, ""));
        }
        return out.isEmpty() ? null : out;
    }

    private JSONObject readOrder(File file) {
        try {
            byte[] bytes = new byte[(int) file.length()];
            try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
                int off = 0;
                int n;
                while (off < bytes.length && (n = fis.read(bytes, off, bytes.length - off)) != -1) {
                    off += n;
                }
            }
            return new JSONObject(new String(bytes, "UTF-8"));
        } catch (Throwable t) {
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Foreground notification
    // -----------------------------------------------------------------------

    private void updateNotification(String title, int current, int total) {
        String text = total > 0
                ? "Downloading " + current + "/" + total + (title.isEmpty() ? "" : " — " + title)
                : "Downloading…";
        ForegroundInfo info = buildForegroundInfo(text, current, total);
        try {
            setForegroundAsync(info);
        } catch (Throwable ignored) {
            // Foreground update best-effort.
        }
    }

    private ForegroundInfo buildForegroundInfo(String text, int current, int total) {
        createChannel();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
                .setContentTitle("HiPaGo downloads")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        if (total > 0) {
            builder.setProgress(total, current, false);
        }
        Notification notification = builder.build();

        // On API 34+ (targetSdk 34) the foreground service type must be declared
        // both in the manifest AND on the ForegroundInfo. DATA_SYNC matches a
        // network download. Older APIs use the 2-arg constructor.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            return new ForegroundInfo(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(NOTIFICATION_ID, notification);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager)
                    getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, "Downloads", NotificationManager.IMPORTANCE_LOW);
                channel.setDescription("Background gallery downloads");
                nm.createNotificationChannel(channel);
            }
        }
    }
}
