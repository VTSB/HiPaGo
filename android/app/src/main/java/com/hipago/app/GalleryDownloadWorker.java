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
 *  - The handoff dir is re-scanned until no new processable work-orders remain,
 *    so downloads queued while this worker is already running are not missed.
 *  - On a page hard-failure the gallery is left partial and its work-order is
 *    KEPT (TS auto-retry/reconcile decides what to do); the worker skips that
 *    file for the rest of this run and keeps draining newer work-orders. The
 *    work-order is deleted ONLY on full success.
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
    /** Per-gallery live progress files: {@code filesDir/dl-progress/<galleryId>.json}. */
    public static final String PROGRESS_DIR = "dl-progress";

    private static final String CHANNEL_ID = "hipago-downloads";
    private static final int NOTIFICATION_ID = 4201;

    /** Min interval between progress-file writes per gallery, to bound IO on big
     *  galleries. The in-app poller reads at ~1s, so once/second is plenty. */
    private static final long PROGRESS_WRITE_THROTTLE_MS = 1000L;

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

        // Without a SAF tree there is nowhere to write. Retry later only when
        // there is actual work pending; otherwise finish quietly.
        if (!saf.hasTree()) {
            File[] pending = listOrderFiles(handoffDir);
            pruneStaleProgress(pending);
            return pending.length == 0 ? Result.success() : Result.retry();
        }

        java.util.Set<String> failedThisRun = new java.util.HashSet<>();
        boolean hadRetryableFailure = false;

        while (!isStopped()) {
            File[] orderFiles = listOrderFiles(handoffDir);

            // Best-effort prune of stale progress files: any dl-progress/<id>.json whose
            // gallery no longer has a work-order in dl-queue is orphaned (a prior run
            // crashed before cleanup). The in-app getProgress returns null for these,
            // but pruning keeps the dir small. Failure here must not affect downloads.
            pruneStaleProgress(orderFiles);

            if (orderFiles.length == 0) {
                return Result.success();
            }

            boolean processedAny = false;

            for (File orderFile : orderFiles) {
                if (isStopped()) {
                    // WorkManager cancelled us. Stop cleanly, leaving remaining
                    // work-orders for the next run.
                    return Result.success();
                }

                String orderName = orderFile.getName();
                if (failedThisRun.contains(orderName)) {
                    continue;
                }

                JSONObject order = readOrder(orderFile);
                if (order == null) {
                    // Unparseable work-order: drop it so it does not wedge the queue.
                    orderFile.delete();
                    processedAny = true;
                    continue;
                }

                processedAny = true;
                boolean completed = processGallery(order, orderFile);
                if (completed) {
                    // Full success: remove the work-order so it is not reprocessed.
                    orderFile.delete();
                    failedThisRun.remove(orderName);
                } else {
                    // Keep the file for a later scheduled/reconciled retry, but do
                    // not immediately spin on the same failing gallery in this run.
                    failedThisRun.add(orderName);
                    hadRetryableFailure = true;
                }
            }

            // Only previously-failed files remain. Finish this run; a future
            // enqueue/reconcile will schedule another pass.
            if (!processedAny) {
                return hadRetryableFailure ? Result.retry() : Result.success();
            }
        }

        return Result.success();
    }

    private File[] listOrderFiles(File handoffDir) {
        File[] files = handoffDir.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return new File[0];
        // Process in stable name order (TS names files <galleryId>.json; sorting
        // by name gives a deterministic order that the app can reason about).
        Arrays.sort(files, Comparator.comparing(File::getName));
        return files;
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
    private boolean processGallery(JSONObject order, File orderFile) {
        String title = order.optString("title", "");
        // galleryId names the live-progress file the in-app poller reads. TS writes
        // numeric galleryIds; fall back to a string so a malformed id still works.
        String galleryId = order.optString("galleryId", null);
        JSONArray pages = order.optJSONArray("pages");
        if (pages == null || pages.length() == 0) {
            // Nothing to download — treat as complete so the work-order is cleared.
            deleteProgress(galleryId);
            return true;
        }

        int total = pages.length();
        File cacheDir = getApplicationContext().getCacheDir();

        // The manifest is the per-page ext array. Seed it from any pages already
        // on disk so an interrupted gallery resumes with a correct manifest.
        String[] exts = new String[total];

        // Last time we wrote the live-progress file for this gallery (throttle).
        long lastProgressWrite = 0L;

        for (int i = 0; i < total; i++) {
            if (isStopped()) {
                // Cancelled mid-gallery — drop the stale progress file.
                deleteProgress(galleryId);
                return false;
            }
            if (!orderFile.exists()) {
                // User cancelled this active Android handoff. Stop between pages
                // without recreating progress; any already-written pages are left
                // for a later explicit retry.
                deleteProgress(galleryId);
                return false;
            }

            JSONObject page = pages.optJSONObject(i);
            if (page == null) {
                deleteProgress(galleryId); // malformed — leave the gallery partial
                return false;
            }

            String relPath = page.optString("relPath", null);
            String url = page.optString("url", null);
            String ext = page.optString("ext", "webp");
            if (relPath == null || url == null) {
                deleteProgress(galleryId);
                return false;
            }

            exts[i] = ext;

            updateNotification(title, i + 1, total);
            // Publish live progress (throttled) so the in-app poller can show
            // current/total while the app is foreground. Best-effort; an IO failure
            // here must never fail the download.
            lastProgressWrite = maybeWriteProgress(galleryId, i + 1, total, lastProgressWrite);

            // Resume: skip a page already written to the SAF tree. Existence
            // alone is not enough: a killed/truncated provider write can leave
            // a zero-byte placeholder that must be downloaded again.
            if (saf.size(relPath) > 0) {
                continue;
            }

            // Download to a temp file in the cache dir via the Rust core, then copy
            // into the SAF tree and delete the temp. The image never enters the JS
            // heap (this is native code).
            File temp = new File(cacheDir, "dl-" + System.nanoTime() + "." + ext);
            try {
                BypassKt.bypassDownloadToFile(url, headersFor(page), temp.getAbsolutePath());
                long sourceSize = temp.length();
                long written = saf.copyFromFile(temp.getAbsolutePath(), relPath);
                long storedSize = saf.size(relPath);
                if (sourceSize <= 0 || written != sourceSize || storedSize != sourceSize) {
                    saf.delete(relPath);
                    throw new Exception("incomplete SAF write");
                }
            } catch (Throwable t) {
                // Page hard-failure (URL/gg expiry, network, SAF revoked). Leave the
                // gallery partial; TS re-resolves / reconciles on next open. Drop the
                // progress file so a frozen value is not polled forever.
                deleteProgress(galleryId);
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
            if (!writeManifest(relPath, exts, i + 1)) {
                deleteProgress(galleryId);
                return false;
            }
        }

        // All pages present → write the final, full manifest once more (defensive)
        // and report success.
        String anyRelPath = pages.optJSONObject(0).optString("relPath", null);
        if (anyRelPath != null && !writeManifest(anyRelPath, exts, total)) {
            deleteProgress(galleryId);
            return false;
        }
        // Gallery complete → remove its live-progress file (the poller then reads
        // null and the row reconciles to 'complete').
        deleteProgress(galleryId);
        return true;
    }

    // -----------------------------------------------------------------------
    // Live progress file (in-app progress bridge)
    //
    // DEVICE-PENDING: Java is not compiled in the sandbox; the progress-file
    // write/throttle/cleanup + DownloadWorkerPlugin.getProgress read are verified
    // by code review here and must be smoke-tested on a device (advancing %
    // in-app while foreground, file removed on completion/cancel/failure).
    // -----------------------------------------------------------------------

    /** {@code filesDir/dl-progress} (created on demand). */
    private File progressDir() {
        File dir = new File(getApplicationContext().getFilesDir(), PROGRESS_DIR);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    /**
     * Write {@code dl-progress/<galleryId>.json = {"current":N,"total":M}} at most
     * once per {@link #PROGRESS_WRITE_THROTTLE_MS}. The first page (lastWrite == 0)
     * and the final page always write so the bar starts and lands exactly. Returns
     * the timestamp of the most recent write so the caller can carry the throttle
     * clock. Best-effort: any failure is swallowed (never fails the download).
     */
    private long maybeWriteProgress(String galleryId, int current, int total, long lastWrite) {
        if (galleryId == null || galleryId.isEmpty()) return lastWrite;
        long now = System.currentTimeMillis();
        boolean isFirstOrLast = lastWrite == 0L || current >= total;
        if (!isFirstOrLast && (now - lastWrite) < PROGRESS_WRITE_THROTTLE_MS) {
            return lastWrite;
        }
        try {
            JSONObject obj = new JSONObject();
            obj.put("current", current);
            obj.put("total", total);
            File f = new File(progressDir(), galleryId + ".json");
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) {
                fos.write(obj.toString().getBytes("UTF-8"));
                fos.flush();
            }
        } catch (Throwable t) {
            // Progress is advisory; a failed write just leaves the last value.
            return lastWrite;
        }
        return now;
    }

    /** Remove a gallery's live-progress file (completion/cancel/failure). Best-effort. */
    private void deleteProgress(String galleryId) {
        if (galleryId == null || galleryId.isEmpty()) return;
        try {
            File f = new File(progressDir(), galleryId + ".json");
            if (f.exists()) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        } catch (Throwable ignored) {
            // Best-effort cleanup; a stale file just reads as the last value until
            // the next run prunes it (pruneStaleProgress) or getProgress returns it.
        }
    }

    /**
     * On worker start, delete any {@code dl-progress/<id>.json} whose gallery has
     * no matching work-order in {@code dl-queue} — orphans from a crashed run.
     * Best-effort; never affects the download.
     */
    private void pruneStaleProgress(File[] orderFiles) {
        try {
            File dir = new File(getApplicationContext().getFilesDir(), PROGRESS_DIR);
            File[] progressFiles = dir.listFiles((d, name) -> name.endsWith(".json"));
            if (progressFiles == null || progressFiles.length == 0) return;

            java.util.Set<String> activeIds = new java.util.HashSet<>();
            if (orderFiles != null) {
                for (File o : orderFiles) {
                    String name = o.getName();
                    activeIds.add(name.substring(0, name.length() - ".json".length()));
                }
            }
            for (File p : progressFiles) {
                String name = p.getName();
                String id = name.substring(0, name.length() - ".json".length());
                if (!activeIds.contains(id)) {
                    //noinspection ResultOfMethodCallIgnored
                    p.delete();
                }
            }
        } catch (Throwable ignored) {
            // Pruning is housekeeping only.
        }
    }

    /**
     * Build the {@code 0000.json} manifest path from a page's relPath (same parent
     * dir) and write the first {@code count} exts as a JSON array.
     */
    private boolean writeManifest(String pageRelPath, String[] exts, int count) {
        int slash = pageRelPath.lastIndexOf('/');
        String dir = slash < 0 ? "" : pageRelPath.substring(0, slash);
        String manifestPath = (dir.isEmpty() ? "" : dir + "/") + "0000.json";

        JSONArray arr = new JSONArray();
        for (int k = 0; k < count; k++) {
            arr.put(exts[k] != null ? exts[k] : "webp");
        }
        try {
            saf.writeBytes(manifestPath, arr.toString().getBytes("UTF-8"));
            return true;
        } catch (Throwable t) {
            // Reconcile depends on the manifest to mark the DB row complete.
            // Keep the work-order so a later worker pass can rewrite it.
            return false;
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
        int percent = total > 0 ? Math.min(100, Math.round((current * 100f) / total)) : 0;
        String titleSuffix = title.isEmpty() ? "" : " - " + title;
        String text = total > 0
                ? "Downloading " + current + "/" + total + " (" + percent + "%)" + titleSuffix
                : "Downloading...";
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
                .setOnlyAlertOnce(true)
                .setSubText(current > 0 && total > 0 ? current + "/" + total : null);
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
