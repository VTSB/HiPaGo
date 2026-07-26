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
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

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
 *  - Resume: a page already committed in the manifest and present in the SAF tree
 *    is skipped, so a killed/truncated provider write cannot be mistaken for a
 *    complete page.
 *  - The {@code 0000.json} manifest (a JSON array of per-page exts) is rewritten
 *    incrementally after each page so the TS reader/reconcile sees progress.
 *  - The handoff dir is re-scanned until no new processable work-orders remain,
 *    so downloads queued while this worker is already running are not missed.
 *  - On a page hard-failure the gallery is left partial and its work-order is
 *    KEPT; WorkManager receives Result.retry() so transient cellular/network
 *    failures can continue in the background. The work-order is deleted ONLY on
 *    full success or malformed unrecoverable input.
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
    private static final String LOCALE_KO = "ko";

    /** Min interval between progress-file writes per gallery, to bound IO on big
     *  galleries. The in-app poller reads at ~1s, so once/second is plenty. */
    private static final long PROGRESS_WRITE_THROTTLE_MS = 1000L;

    private final SafLibrary saf;

    private enum GalleryResult {
        COMPLETED,
        RETRYABLE_FAILURE,
        CANCELED,
        UNRECOVERABLE
    }

    public GalleryDownloadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
        // A fresh SafLibrary per worker run is fine — the worker is sequential, so
        // its dir cache never races. Uses the worker's application context.
        this.saf = new SafLibrary(context);
    }

    @NonNull
    @Override
    public Result doWork() {
        File handoffDir = new File(getApplicationContext().getFilesDir(), HANDOFF_DIR);
        String initialLocale = firstOrderLocale(handoffDir);

        // Go foreground immediately so the system shows the progress notification
        // and does not kill the worker while the app is backgrounded.
        try {
            setForegroundAsync(buildForegroundInfo(notificationPreparing(initialLocale), 0, 0, initialLocale)).get();
        } catch (Throwable t) {
            // setForegroundAsync can fail (e.g. POST_NOTIFICATIONS denied on 13+).
            // The download can still proceed; we just lose the visible progress.
        }

        // Without a writable SAF tree there is nowhere to write. This includes a
        // revoked persisted permission, which will not heal from WorkManager's
        // retry loop. Keep the work-order files for app-level reconcile after the
        // user reselects a folder, but stop this worker run.
        if (!saf.hasTree()) {
            File[] pending = listOrderFiles(handoffDir);
            pruneStaleProgress(pending);
            for (File orderFile : pending) {
                String name = orderFile.getName();
                String galleryId = name.substring(0, name.length() - ".json".length());
                writeProgressFailure(galleryId, "Select a download folder");
            }
            return Result.success();
        }

        Set<String> failedThisRun = new HashSet<>();
        boolean sawRetryableFailure = false;

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
                if (failedThisRun.contains(orderFile.getName())) {
                    continue;
                }

                if (isStopped()) {
                    // WorkManager cancelled us. Stop cleanly, leaving remaining
                    // work-orders for the next run.
                    return Result.success();
                }

                JSONObject order = readOrder(orderFile);
                if (order == null) {
                    // Unparseable work-order: drop it so it does not wedge the queue.
                    orderFile.delete();
                    processedAny = true;
                    continue;
                }

                processedAny = true;
                GalleryResult result = processGallery(order, orderFile);
                if (result == GalleryResult.COMPLETED) {
                    // Full success: remove the work-order so it is not reprocessed.
                    orderFile.delete();
                } else if (result == GalleryResult.RETRYABLE_FAILURE) {
                    // If SAF permission disappeared during this gallery, retrying
                    // in WorkManager will not repair it. Leave the work-order for
                    // app-level reconcile after the user reselects a folder.
                    if (!saf.hasTree()) {
                        return Result.success();
                    }
                    // Keep the file and continue with later work-orders in this
                    // run. WorkManager still receives Result.retry() after the
                    // pass so transient failures get backoff without starving
                    // unrelated queued galleries behind this one.
                    failedThisRun.add(orderFile.getName());
                    sawRetryableFailure = true;
                    continue;
                } else if (result == GalleryResult.UNRECOVERABLE) {
                    // Malformed work-order content cannot be repaired by retries.
                    orderFile.delete();
                } else {
                    return Result.success();
                }
            }

            // No order was parseable or processable in this pass. Finish cleanly
            // unless the pass only skipped files that already hit transient
            // failures; in that case hand scheduling back to WorkManager's
            // backoff instead of spinning in this worker.
            if (!processedAny) {
                return sawRetryableFailure ? Result.retry() : Result.success();
            }
        }

        return sawRetryableFailure ? Result.retry() : Result.success();
    }

    private File[] listOrderFiles(File handoffDir) {
        File[] files = handoffDir.listFiles((dir, name) -> name.endsWith(".json"));
        if (files == null) return new File[0];
        // Process by TS queuePosition first so native handoff preserves manual
        // front/reorder semantics; fall back to filename for older work-orders.
        Arrays.sort(files, Comparator
                .comparingLong(GalleryDownloadWorker::orderQueuePosition)
                .thenComparing(File::getName));
        return files;
    }

    static long orderQueuePosition(File orderFile) {
        try {
            JSONObject obj = readOrder(orderFile);
            if (obj == null || !obj.has("queuePosition") || obj.isNull("queuePosition")) {
                return Long.MAX_VALUE;
            }
            return obj.optLong("queuePosition", Long.MAX_VALUE);
        } catch (Throwable t) {
            return Long.MAX_VALUE;
        }
    }

    // -----------------------------------------------------------------------
    // Per-gallery processing
    // -----------------------------------------------------------------------

    /**
     * Download every page of one gallery.
     *
     * @return a completion class for the caller to map to work-order cleanup or
     *         WorkManager retry.
     */
    private GalleryResult processGallery(JSONObject order, File orderFile) {
        String title = order.optString("title", "");
        String locale = normalizeLocale(order.optString("locale", ""));
        // galleryId names the live-progress file the in-app poller reads. TS writes
        // numeric galleryIds; fall back to a string so a malformed id still works.
        String galleryId = order.optString("galleryId", null);
        JSONArray pages = order.optJSONArray("pages");
        if (pages == null || pages.length() == 0) {
            // Nothing to download — treat as complete so the work-order is cleared.
            deleteProgress(galleryId);
            return GalleryResult.COMPLETED;
        }

        int total = pages.length();
        File cacheDir = getApplicationContext().getCacheDir();

        // The manifest is the per-page ext array. Treat its length as the commit
        // marker for already-written pages; SAF existence alone can include a
        // non-zero partial file left by a killed provider write.
        String[] exts = new String[total];
        int manifestCount = seedManifestExts(pages, exts);

        // Last time we wrote the live-progress file for this gallery (throttle).
        long lastProgressWrite = 0L;

        for (int i = 0; i < total; i++) {
            if (isStopped()) {
                // Cancelled mid-gallery — drop the stale progress file.
                deleteProgress(galleryId);
                return GalleryResult.CANCELED;
            }
            if (!orderFile.exists()) {
                // User cancelled this active Android handoff. Stop between pages
                // without recreating progress; any already-written pages are left
                // for a later explicit retry.
                deleteProgress(galleryId);
                return GalleryResult.CANCELED;
            }

            JSONObject page = pages.optJSONObject(i);
            if (page == null) {
                deleteProgress(galleryId); // malformed — leave the gallery partial
                return GalleryResult.UNRECOVERABLE;
            }

            String relPath = page.optString("relPath", null);
            String url = page.optString("url", null);
            String ext = page.optString("ext", "webp");
            if (!isValidRelPath(relPath) || !isValidDownloadUrl(url) || !isValidExtension(ext)) {
                deleteProgress(galleryId);
                return GalleryResult.UNRECOVERABLE;
            }

            exts[i] = ext;

            // Resume: only skip a page if a prior manifest write committed it.
            // Non-manifest partial files are overwritten below.
            boolean alreadyCommitted = shouldSkipExistingPage(i, manifestCount, saf.size(relPath));
            if (!alreadyCommitted) {
                // Download to a temp file in the cache dir via the Rust core, then copy
                // into the SAF tree and delete the temp. The image never enters the JS
                // heap (this is native code).
                File temp = new File(cacheDir, "dl-" + System.nanoTime() + "." + ext);
                try {
                    BypassKt.bypassDownloadToFile(url, headersFor(page), temp.getAbsolutePath());
                    if (isStopped() || !orderFile.exists()) {
                        deleteProgress(galleryId);
                        return GalleryResult.CANCELED;
                    }
                    long sourceSize = temp.length();
                    long written = saf.copyFromFile(temp.getAbsolutePath(), relPath);
                    long storedSize = saf.size(relPath);
                    if (sourceSize <= 0 || written != sourceSize || storedSize != sourceSize) {
                        saf.delete(relPath);
                        throw new Exception("incomplete SAF write");
                    }
                } catch (Throwable t) {
                    // Page hard-failure (URL/gg expiry, network, SAF revoked). Leave the
                    // gallery partial; TS re-resolves / reconciles on next open. Publish
                    // an explicit failure sentinel so a foreground app can fail/retry the
                    // DB row without waiting for relaunch.
                    writeProgressFailure(galleryId, "Background download failed");
                    return GalleryResult.RETRYABLE_FAILURE;
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
                if (isStopped() || !orderFile.exists()) {
                    deleteProgress(galleryId);
                    return GalleryResult.CANCELED;
                }
                if (!writeManifest(relPath, exts, i + 1)) {
                    writeProgressFailure(galleryId, "Background download failed");
                    return GalleryResult.RETRYABLE_FAILURE;
                }
                manifestCount = Math.max(manifestCount, i + 1);
            }

            // `current` means pages durably committed, not pages merely started.
            // Fresh pages reach here only after both the non-empty SAF copy and the
            // incremental manifest write succeeded. Resume skips reach here only
            // when the manifest already covers the page and its file is non-empty.
            // Use the committed count (>= i+1 on resume skips, == i+1 for fresh
            // pages) so the bar never regresses below what is durably on disk.
            int committed = Math.max(i + 1, manifestCount);
            updateNotification(title, committed, total, locale);
            // Publish live progress (throttled) so the in-app poller can show
            // current/total while the app is foreground. Best-effort; an IO failure
            // here must never fail the download.
            lastProgressWrite = maybeWriteProgress(galleryId, committed, total, lastProgressWrite);
        }

        // All pages present → write the final, full manifest once more (defensive)
        // and report success.
        String anyRelPath = pages.optJSONObject(0).optString("relPath", null);
        if (isStopped() || !orderFile.exists()) {
            deleteProgress(galleryId);
            return GalleryResult.CANCELED;
        }
        if (anyRelPath != null && !writeManifest(anyRelPath, exts, total)) {
            writeProgressFailure(galleryId, "Background download failed");
            return GalleryResult.RETRYABLE_FAILURE;
        }
        // Gallery complete → remove its live-progress file (the poller then reads
        // null and the row reconciles to 'complete').
        deleteProgress(galleryId);
        return GalleryResult.COMPLETED;
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
     * once per {@link #PROGRESS_WRITE_THROTTLE_MS}. {@code current} is the number
     * of pages whose non-empty files are covered by the manifest. The first page
     * (lastWrite == 0) and the final page always write so the bar starts and lands
     * exactly. Returns the timestamp of the most recent write so the caller can
     * carry the throttle clock. Best-effort: any failure is swallowed (never fails
     * the download).
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

    /** Publish a terminal failure sentinel for the in-app poller. Best-effort. */
    private void writeProgressFailure(String galleryId, String message) {
        if (galleryId == null || galleryId.isEmpty()) return;
        try {
            JSONObject obj = new JSONObject();
            obj.put("current", JSONObject.NULL);
            obj.put("error", message);
            File f = new File(progressDir(), galleryId + ".json");
            try (java.io.FileOutputStream fos = new java.io.FileOutputStream(f)) {
                fos.write(obj.toString().getBytes("UTF-8"));
                fos.flush();
            }
        } catch (Throwable ignored) {
            // Best-effort failure signal; TS still has launch reconcile fallback.
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
        JSONArray arr = new JSONArray();
        for (int k = 0; k < count; k++) {
            arr.put(exts[k] != null ? exts[k] : "webp");
        }
        try {
            saf.writeBytes(manifestPathForPage(pageRelPath), arr.toString().getBytes("UTF-8"));
            return true;
        } catch (Throwable t) {
            // Reconcile depends on the manifest to mark the DB row complete.
            // Keep the work-order so a later worker pass can rewrite it.
            return false;
        }
    }

    private int seedManifestExts(JSONArray pages, String[] exts) {
        JSONObject firstPage = pages.optJSONObject(0);
        if (firstPage == null) return 0;

        String firstRelPath = firstPage.optString("relPath", null);
        if (!isValidRelPath(firstRelPath)) return 0;

        try {
            return decodeManifestExts(saf.readBytes(manifestPathForPage(firstRelPath)), exts);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    static String manifestPathForPage(String pageRelPath) {
        int slash = pageRelPath.lastIndexOf('/');
        String dir = slash < 0 ? "" : pageRelPath.substring(0, slash);
        return (dir.isEmpty() ? "" : dir + "/") + "0000.json";
    }

    static int decodeManifestExts(byte[] bytes, String[] exts) {
        try {
            JSONArray arr = new JSONArray(new String(bytes, "UTF-8"));
            int count = Math.min(arr.length(), exts.length);
            for (int i = 0; i < count; i++) {
                String ext = arr.optString(i, "");
                exts[i] = ext.isEmpty() ? "webp" : ext;
            }
            return count;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    static boolean shouldSkipExistingPage(int pageIndex, int manifestCount, long storedSize) {
        return pageIndex < manifestCount && storedSize > 0;
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

    static boolean isValidRelPath(String relPath) {
        if (relPath == null || relPath.isEmpty()) return false;
        if (relPath.startsWith("/") || relPath.startsWith("\\")) return false;
        if (relPath.indexOf('\0') >= 0 || relPath.indexOf('\\') >= 0) return false;
        String[] parts = relPath.split("/", -1);
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return true;
    }

    static boolean isValidDownloadUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        return url.startsWith("https://") || url.startsWith("http://");
    }

    static boolean isValidExtension(String ext) {
        if (ext == null || ext.isEmpty() || ext.length() > 16) return false;
        for (int i = 0; i < ext.length(); i++) {
            char c = ext.charAt(i);
            boolean alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            boolean digit = c >= '0' && c <= '9';
            if (!alpha && !digit) return false;
        }
        return true;
    }

    private static JSONObject readOrder(File file) {
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

    private void updateNotification(String title, int current, int total, String locale) {
        int percent = total > 0 ? Math.min(100, Math.round((current * 100f) / total)) : 0;
        String titleSuffix = title.isEmpty() ? "" : " - " + title;
        String text = total > 0
                ? notificationDownloading(locale, current, total, percent) + titleSuffix
                : notificationDownloadingIndeterminate(locale);
        ForegroundInfo info = buildForegroundInfo(text, current, total, locale);
        try {
            setForegroundAsync(info);
        } catch (Throwable ignored) {
            // Foreground update best-effort.
        }
    }

    private ForegroundInfo buildForegroundInfo(String text, int current, int total, String locale) {
        createChannel(locale);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getApplicationContext(), CHANNEL_ID)
                .setContentTitle(notificationTitle(locale))
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

    private void createChannel(String locale) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager)
                    getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
            if (existing == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID, notificationChannelName(locale), NotificationManager.IMPORTANCE_LOW);
                channel.setDescription(notificationChannelDescription(locale));
                nm.createNotificationChannel(channel);
            } else {
                existing.setName(notificationChannelName(locale));
                existing.setDescription(notificationChannelDescription(locale));
                nm.createNotificationChannel(existing);
            }
        }
    }

    private String firstOrderLocale(File handoffDir) {
        File[] orders = listOrderFiles(handoffDir);
        if (orders.length == 0) {
            return normalizeLocale(Locale.getDefault().getLanguage());
        }
        JSONObject first = readOrder(orders[0]);
        return first == null ? normalizeLocale(Locale.getDefault().getLanguage())
                : normalizeLocale(first.optString("locale", ""));
    }

    static String normalizeLocale(String locale) {
        return LOCALE_KO.equalsIgnoreCase(locale) ? LOCALE_KO : "en";
    }

    static String notificationTitle(String locale) {
        return LOCALE_KO.equals(normalizeLocale(locale)) ? "HiPaGo 다운로드" : "HiPaGo downloads";
    }

    static String notificationPreparing(String locale) {
        return LOCALE_KO.equals(normalizeLocale(locale)) ? "다운로드 준비 중…" : "Preparing downloads…";
    }

    static String notificationDownloading(String locale, int current, int total, int percent) {
        if (LOCALE_KO.equals(normalizeLocale(locale))) {
            return "다운로드 중 " + current + "/" + total + " (" + percent + "%)";
        }
        return "Downloading " + current + "/" + total + " (" + percent + "%)";
    }

    static String notificationDownloadingIndeterminate(String locale) {
        return LOCALE_KO.equals(normalizeLocale(locale)) ? "다운로드 중…" : "Downloading...";
    }

    static String notificationChannelName(String locale) {
        return LOCALE_KO.equals(normalizeLocale(locale)) ? "다운로드" : "Downloads";
    }

    static String notificationChannelDescription(String locale) {
        return LOCALE_KO.equals(normalizeLocale(locale))
                ? "백그라운드 갤러리 다운로드"
                : "Background gallery downloads";
    }
}
