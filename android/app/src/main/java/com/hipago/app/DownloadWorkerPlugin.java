package com.hipago.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.system.Os;
import android.util.AtomicFile;

import androidx.work.Constraints;
import androidx.work.BackoffPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Capacitor plugin that bridges the TS download queue to the native
 * {@link GalleryDownloadWorker}.
 *
 * On Android the worker is the SOLE downloader. TS resolves a work-order, hands
 * it off via {@link #writeWorkOrder} (so TS never needs raw access to the app's
 * {@code filesDir}), then calls {@link #enqueue} to schedule the worker. One
 * unique worker chain ({@link GalleryDownloadWorker#UNIQUE_WORK_NAME}, policy
 * APPEND_OR_REPLACE) drains pending work-order files. Appending a follow-up run
 * closes the race where a work-order is written while a previous run is already
 * finishing.
 *
 * Network constraint: {@link NetworkType#CONNECTED}, so downloads may run on
 * Wi-Fi, ethernet, or cellular but still wait while the device is offline.
 * Android 13+ notification permission is requested before enqueueing so the
 * worker's foreground progress notification appears in the system shade.
 *
 * {@link #cancel} removes one gallery's work-order file; if no work-orders remain
 * it also cancels the unique work so the worker stops.
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file is verified by
 * code review here and must be smoke-tested on a physical/emulator Android
 * device (WorkManager scheduling, CONNECTED constraint, append policy, cancel).
 */
@CapacitorPlugin(
        name = "DownloadWorker",
        permissions = {
                @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
        }
)
public class DownloadWorkerPlugin extends Plugin {
    private static final String NOTIFICATIONS = "notifications";
    private static final String PREFS = "hipago_download_worker";
    private static final String KEY_NETWORK_CONSTRAINT_VERSION = "network_constraint_version";
    private static final int NETWORK_CONSTRAINT_CONNECTED_VERSION = 2;

    enum WorkOrderPublication {
        PUBLISH,
        IDEMPOTENT,
        LEGACY_REPLACE,
        STALE,
        UNKNOWN
    }

    static final class CurrentRunResolution {
        final String runId;
        final boolean conflict;
        final boolean unknown;
        final boolean legacy;

        private CurrentRunResolution(
                String runId,
                boolean conflict,
                boolean unknown,
                boolean legacy
        ) {
            this.runId = runId;
            this.conflict = conflict;
            this.unknown = unknown;
            this.legacy = legacy;
        }

        static CurrentRunResolution current(String runId) {
            return new CurrentRunResolution(runId, false, false, false);
        }

        static CurrentRunResolution absent() {
            return current(null);
        }

        static CurrentRunResolution legacy() {
            return new CurrentRunResolution(null, false, false, true);
        }

        static CurrentRunResolution conflict() {
            return new CurrentRunResolution(null, true, false, false);
        }

        static CurrentRunResolution unknown() {
            return new CurrentRunResolution(null, false, true, false);
        }
    }

    private static final class CancelResult {
        final boolean cancelled;
        final boolean stale;
        final int remainingCount;

        CancelResult(boolean cancelled, boolean stale, int remainingCount) {
            this.cancelled = cancelled;
            this.stale = stale;
            this.remainingCount = remainingCount;
        }
    }

    private File handoffDir() {
        File dir = new File(getContext().getFilesDir(), GalleryDownloadWorker.HANDOFF_DIR);
        if (!dir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }
        return dir;
    }

    private File orderFile(String galleryId) {
        return new File(handoffDir(), galleryId + ".json");
    }

    private File progressDir() {
        return new File(getContext().getFilesDir(), GalleryDownloadWorker.PROGRESS_DIR);
    }

    private File progressFile(String galleryId) {
        return new File(progressDir(), galleryId + ".json");
    }

    static boolean isValidGalleryId(String galleryId) {
        if (galleryId == null || galleryId.isEmpty()) return false;
        for (int i = 0; i < galleryId.length(); i++) {
            char c = galleryId.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    private void deleteProgress(String galleryId) {
        File f = progressFile(galleryId);
        new AtomicFile(f).delete();
    }

    private boolean deleteProgressIfMatches(NativeDownloadRun run) {
        File f = progressFile(run.galleryId);
        if (!f.exists() || !run.matchesProgressFile(f)) return false;
        new AtomicFile(f).delete();
        return true;
    }

    private String workOrderGalleryId(String json) {
        try {
            JSONObject obj = new JSONObject(json);
            Object raw = obj.opt("galleryId");
            if (raw == null || raw == JSONObject.NULL) {
                return null;
            }
            return String.valueOf(raw);
        } catch (Throwable t) {
            return null;
        }
    }

    private String workOrderRunId(String json) {
        try {
            JSONObject obj = new JSONObject(json);
            String runId = obj.optString("runId", null);
            return NativeDownloadRun.isValidRunId(runId) ? runId : null;
        } catch (Throwable t) {
            return null;
        }
    }

    static JSObject readProgressFile(File f, String expectedRunId) {
        JSObject ret = new JSObject();
        ret.put("runId", expectedRunId);
        if (!f.exists()) {
            // Absent → no active progress (not started, or already completed/cleared).
            ret.put("current", JSObject.NULL);
            return ret;
        }
        try {
            byte[] bytes = new byte[(int) f.length()];
            try (FileInputStream fis = new FileInputStream(f)) {
                int off = 0;
                int n;
                while (off < bytes.length && (n = fis.read(bytes, off, bytes.length - off)) != -1) {
                    off += n;
                }
            }
            JSONObject obj = new JSONObject(new String(bytes, "UTF-8"));
            String actualRunId = obj.optString("runId", null);
            if (!NativeDownloadRun.isValidRunId(actualRunId)
                    || !expectedRunId.equals(actualRunId)) {
                ret.put("current", JSObject.NULL);
                ret.put("stale", true);
                if (NativeDownloadRun.isValidRunId(actualRunId)) {
                    ret.put("runId", actualRunId);
                }
                return ret;
            }
            if (obj.has("error")) {
                ret.put("current", JSObject.NULL);
                ret.put("error", obj.optString("error", "Background download failed"));
                return ret;
            }
            ret.put("current", obj.getInt("current"));
            ret.put("total", obj.getInt("total"));
            return ret;
        } catch (Throwable t) {
            // Unparseable / torn write → treat as no progress this tick.
            ret.put("current", JSObject.NULL);
            return ret;
        }
    }

    /**
     * Read progress only while the requested identity still owns the order path.
     * Checking the order first closes the replacement gap before a new run has
     * emitted its first progress file.
     */
    static JSObject readProgressForRun(
            String galleryId,
            File orderFile,
            File progressFile,
            String expectedRunId
    ) {
        if (orderFile != null && orderFile.isFile()) {
            NativeDownloadRun current = NativeDownloadRun.fromOrderFile(orderFile);
            if (current == null
                    || !galleryId.equals(current.galleryId)
                    || !expectedRunId.equals(current.runId)) {
                JSObject stale = new JSObject();
                stale.put("runId", current == null ? expectedRunId : current.runId);
                stale.put("current", JSObject.NULL);
                stale.put("stale", true);
                return stale;
            }
        }
        return readProgressFile(progressFile, expectedRunId);
    }

    /**
     * Resolve the authoritative run identity for app/WebView restart recovery.
     * A disagreement between two readable identities is a conflict. A present but
     * unreadable or malformed file is unknown; callers must not interpret either
     * state as proof that the native writer stopped. A strictly confirmed pre-runId
     * order/progress pair is reported separately as legacy so restart recovery can
     * replace it without treating arbitrary malformed state as absence.
     */
    static CurrentRunResolution resolveCurrentRun(
            String galleryId,
            File orderFile,
            File progressFile
    ) {
        boolean hasOrder = orderFile != null && orderFile.exists();
        boolean hasProgress = progressFile != null && progressFile.exists();
        NativeDownloadRun orderRun = null;
        String progressRunId = null;

        try {
            if (hasOrder) {
                JSONObject order = readJsonStrict(orderFile);
                orderRun = NativeDownloadRun.fromOrder(order);
                if (orderRun == null) {
                    if (!isConfirmedLegacyOrder(order, galleryId)) {
                        return CurrentRunResolution.unknown();
                    }
                    if (!hasProgress) return CurrentRunResolution.legacy();

                    JSONObject progress = readJsonStrict(progressFile);
                    if (isConfirmedLegacyProgress(progress)) {
                        return CurrentRunResolution.legacy();
                    }
                    String currentProgressRunId = progress.optString("runId", null);
                    return NativeDownloadRun.isValidRunId(currentProgressRunId)
                            ? CurrentRunResolution.conflict()
                            : CurrentRunResolution.unknown();
                }
                if (!galleryId.equals(orderRun.galleryId)) {
                    return CurrentRunResolution.conflict();
                }
            }
            if (hasProgress) {
                JSONObject progress = readJsonStrict(progressFile);
                if (!hasOrder && isConfirmedLegacyProgress(progress)) {
                    // Older cancel/finish paths removed the order before the
                    // progress sentinel. A process death between those deletes
                    // leaves a valid tokenless upgrade state that must still be
                    // able to reach the guarded writeWorkOrder replacement.
                    return CurrentRunResolution.legacy();
                }
                progressRunId = progress.optString("runId", null);
                if (!NativeDownloadRun.isValidRunId(progressRunId)) {
                    return CurrentRunResolution.unknown();
                }
            }
        } catch (Throwable readError) {
            return CurrentRunResolution.unknown();
        }

        if (hasOrder && hasProgress) {
            return orderRun.runId.equals(progressRunId)
                    ? CurrentRunResolution.current(orderRun.runId)
                    : CurrentRunResolution.conflict();
        }
        if (hasOrder) return CurrentRunResolution.current(orderRun.runId);
        if (hasProgress) return CurrentRunResolution.current(progressRunId);
        return CurrentRunResolution.absent();
    }

    static String resolveCurrentRunId(String galleryId, File orderFile, File progressFile) {
        return resolveCurrentRun(galleryId, orderFile, progressFile).runId;
    }

    static WorkOrderPublication classifyWorkOrderPublication(
            File existingOrderFile,
            File existingProgressFile,
            NativeDownloadRun requestedRun,
            byte[] requestedPayload
    ) {
        if (existingOrderFile == null || !existingOrderFile.exists()) {
            return WorkOrderPublication.PUBLISH;
        }
        if (requestedRun == null || requestedPayload == null) {
            return WorkOrderPublication.UNKNOWN;
        }

        try {
            JSONObject existingOrder = readJsonStrict(existingOrderFile);
            NativeDownloadRun current = NativeDownloadRun.fromOrder(existingOrder);
            if (current != null) {
                if (!requestedRun.equalsIdentity(current)) {
                    return WorkOrderPublication.STALE;
                }
                return fileContentsEqualStrict(existingOrderFile, requestedPayload)
                        ? WorkOrderPublication.IDEMPOTENT
                        : WorkOrderPublication.STALE;
            }

            if (!isConfirmedLegacyOrder(existingOrder, requestedRun.galleryId)) {
                return WorkOrderPublication.UNKNOWN;
            }
            if (existingProgressFile == null || !existingProgressFile.exists()) {
                return WorkOrderPublication.LEGACY_REPLACE;
            }

            JSONObject progress = readJsonStrict(existingProgressFile);
            String progressRunId = progress.optString("runId", null);
            if (NativeDownloadRun.isValidRunId(progressRunId)) {
                return WorkOrderPublication.STALE;
            }
            return isConfirmedLegacyProgress(progress)
                    ? WorkOrderPublication.LEGACY_REPLACE
                    : WorkOrderPublication.UNKNOWN;
        } catch (Throwable readError) {
            // A transient private-storage read failure must never authorize an
            // overwrite of the only durable native order/progress state.
            return WorkOrderPublication.UNKNOWN;
        }
    }

    static WorkOrderPublication classifyWorkOrderPublication(
            File existingOrderFile,
            NativeDownloadRun requestedRun,
            byte[] requestedPayload
    ) {
        return classifyWorkOrderPublication(
                existingOrderFile,
                null,
                requestedRun,
                requestedPayload
        );
    }

    static boolean isConfirmedLegacyOrder(JSONObject order, String galleryId) {
        if (order == null || order.has("runId") || order.optJSONArray("pages") == null) {
            return false;
        }
        Object rawGalleryId = order.opt("galleryId");
        return rawGalleryId != null
                && rawGalleryId != JSONObject.NULL
                && galleryId.equals(String.valueOf(rawGalleryId));
    }

    static boolean isConfirmedLegacyProgress(JSONObject progress) {
        return progress != null && !progress.has("runId") && progress.has("current");
    }

    static void deleteConfirmedLegacyProgress(File progressFile) throws Exception {
        if (progressFile == null || !progressFile.exists()) return;
        JSONObject progress = readJsonStrict(progressFile);
        if (!isConfirmedLegacyProgress(progress)) {
            throw new Exception("prior progress state is not confirmed legacy");
        }
        new AtomicFile(progressFile).delete();
        if (progressFile.exists()) {
            throw new Exception("legacy progress cleanup failed");
        }
    }

    private static JSONObject readJsonStrict(File file) throws Exception {
        if (file == null || !file.isFile()) {
            throw new Exception("state file is not a regular file");
        }
        long length = file.length();
        if (length <= 0 || length > Integer.MAX_VALUE) {
            throw new Exception("state file length is invalid");
        }
        byte[] bytes = new byte[(int) length];
        try (FileInputStream fis = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int count = fis.read(bytes, offset, bytes.length - offset);
                if (count <= 0) throw new Exception("state file read was incomplete");
                offset += count;
            }
            if (fis.read() != -1) throw new Exception("state file changed while reading");
        }
        return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
    }

    private static boolean fileContentsEqualStrict(File file, byte[] expected) throws Exception {
        if (file == null || expected == null || !file.isFile() || file.length() != expected.length) {
            return false;
        }
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int offset = 0;
            while (offset < expected.length) {
                int count = fis.read(buffer, 0, Math.min(buffer.length, expected.length - offset));
                if (count <= 0) throw new Exception("state file read was incomplete");
                for (int i = 0; i < count; i++) {
                    if (buffer[i] != expected[offset + i]) return false;
                }
                offset += count;
            }
            return fis.read() == -1;
        }
    }

    static int countPendingWorkOrders(File directory) throws Exception {
        File[] remaining = directory == null
                ? null
                : directory.listFiles((dir, name) -> name.endsWith(".json"));
        if (remaining == null) {
            throw new Exception("work-order enumeration failed");
        }
        return remaining.length;
    }

    /**
     * Persist a work-order JSON to {@code filesDir/dl-queue/<galleryId>.json} so
     * the worker can read it. TS passes the already-serialized JSON string and the
     * galleryId (used only for the filename). The request and payload must carry
     * the same opaque runId. Does NOT enqueue — call enqueue next.
     */
    @PluginMethod
    public void writeWorkOrder(PluginCall call) {
        String galleryId = call.getString("galleryId");
        String runId = call.getString("runId");
        String json = call.getString("json");
        if (!isValidGalleryId(galleryId)) { call.reject("galleryId must be numeric"); return; }
        if (!NativeDownloadRun.isValidRunId(runId)) { call.reject("runId is invalid"); return; }
        if (json == null) { call.reject("json is required"); return; }
        try {
            String payloadGalleryId = workOrderGalleryId(json);
            if (!isValidGalleryId(payloadGalleryId) || !galleryId.equals(payloadGalleryId)) {
                call.reject("work-order galleryId does not match filename");
                return;
            }
            String payloadRunId = workOrderRunId(json);
            if (!runId.equals(payloadRunId)) {
                call.reject("work-order runId does not match request");
                return;
            }
            byte[] payloadBytes = json.getBytes(StandardCharsets.UTF_8);
            synchronized (NativeDownloadRun.lockFor(galleryId)) {
                File f = orderFile(galleryId);
                NativeDownloadRun requestedRun = NativeDownloadRun.create(galleryId, runId);
                WorkOrderPublication publication = classifyWorkOrderPublication(
                        f,
                        progressFile(galleryId),
                        requestedRun,
                        payloadBytes
                );
                if (publication == WorkOrderPublication.STALE) {
                    call.reject("stale runId");
                    return;
                }
                if (publication == WorkOrderPublication.UNKNOWN) {
                    call.reject("existing native download state is unreadable or malformed");
                    return;
                }
                if (publication == WorkOrderPublication.IDEMPOTENT) {
                    // Do not replace a live same-run file: an in-flight worker is
                    // authorized by this identity and could otherwise consume the
                    // republished path as if it were its original order (ABA).
                    call.resolve();
                    return;
                }
                File tmp = new File(handoffDir(), galleryId + ".json.tmp");
                try (FileOutputStream fos = new FileOutputStream(tmp)) {
                    fos.write(payloadBytes);
                    fos.flush();
                    fos.getFD().sync();
                }
                // A pre-runId order from an earlier app version is replaceable only
                // after both it and any progress file were strictly parsed as the
                // matching legacy format. The per-gallery lock makes the progress
                // cleanup plus atomic order replacement one migration boundary.
                if (publication == WorkOrderPublication.LEGACY_REPLACE) {
                    deleteConfirmedLegacyProgress(progressFile(galleryId));
                } else {
                    deleteProgress(galleryId);
                }
                if (progressFile(galleryId).exists()) {
                    throw new Exception("prior progress cleanup failed: " + galleryId);
                }
                try {
                    // Both paths are in filesDir/dl-queue, so rename(2) gives an
                    // atomic publish/migration boundary without an absent-order gap.
                    Os.rename(tmp.getAbsolutePath(), f.getAbsolutePath());
                } catch (Throwable renameError) {
                    //noinspection ResultOfMethodCallIgnored
                    tmp.delete();
                    throw new Exception("atomic publish failed: " + f.getName(), renameError);
                }
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("writeWorkOrder error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        }
    }

    /**
     * Enqueue the unique, connected-network download worker. The work-order file is
     * assumed already written (via {@link #writeWorkOrder}). APPEND_OR_REPLACE keeps
     * the current run and appends a follow-up pass, so a work-order written while a
     * worker is already running is still guaranteed to be seen.
     */
    @PluginMethod
    public void enqueue(PluginCall call) {
        if (shouldRequestNotificationPermission()) {
            requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionCallback");
            return;
        }

        enqueueWorker(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        // A denial only hides the foreground notification from the shade; the
        // actual WorkManager download should still proceed.
        enqueueWorker(call);
    }

    private boolean shouldRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false;
        PermissionState state = getPermissionState(NOTIFICATIONS);
        return state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE;
    }

    private void enqueueWorker(PluginCall call) {
        try {
            String galleryId = call.getString("galleryId");
            String runId = call.getString("runId");
            if (!isValidGalleryId(galleryId)) { call.reject("galleryId must be numeric"); return; }
            if (!NativeDownloadRun.isValidRunId(runId)) { call.reject("runId is invalid"); return; }
            NativeDownloadRun requestedRun = NativeDownloadRun.create(galleryId, runId);
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(GalleryDownloadWorker.class)
                    .setConstraints(constraints)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .build();
            boolean enqueued = NativeDownloadRun.withQueueTransaction(galleryId, () -> {
                boolean migratingNetworkConstraint = shouldMigrateNetworkConstraint();
                ExistingWorkPolicy policy = migratingNetworkConstraint
                        ? ExistingWorkPolicy.REPLACE
                        : ExistingWorkPolicy.APPEND_OR_REPLACE;
                if (!requestedRun.matchesOrderFile(orderFile(galleryId))) {
                    return false;
                }
                WorkManager.getInstance(getContext()).enqueueUniqueWork(
                        GalleryDownloadWorker.UNIQUE_WORK_NAME,
                        policy,
                        request);
                if (migratingNetworkConstraint) {
                    markNetworkConstraintMigrated();
                }
                return true;
            });
            if (!enqueued) {
                call.reject("stale runId");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("enqueue error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        }
    }

    private boolean shouldMigrateNetworkConstraint() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int version = prefs.getInt(KEY_NETWORK_CONSTRAINT_VERSION, 0);
        return version < NETWORK_CONSTRAINT_CONNECTED_VERSION;
    }

    private void markNetworkConstraintMigrated() {
        // One-time migration from the old UNMETERED work constraint. Existing
        // WorkManager requests keep their original constraints across app
        // updates, so replace the unique chain once; persistent work-order files
        // let the new CONNECTED worker resume anything that was interrupted.
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putInt(KEY_NETWORK_CONSTRAINT_VERSION, NETWORK_CONSTRAINT_CONNECTED_VERSION)
                .apply();
    }

    /**
     * Read one gallery's live progress, written by the worker to
     * {@code filesDir/dl-progress/<galleryId>.json =
     * {"runId":"...","current":N,"total":M}}. Resolves progress only when
     * the file belongs to the requested runId; a replacement run is reported as
     * {@code {current: null, stale: true, runId}}. The in-app poller only runs on
     * Android, so iOS omits this method (the TS caller is isAndroid-gated).
     *
     * DEVICE-PENDING: verified by code review here; smoke-test on a device that the
     * advancing values reach the in-app card and that a completed gallery reads
     * absent (null) after the worker deletes the file.
     */
    @PluginMethod
    public void getProgress(PluginCall call) {
        String galleryId = call.getString("galleryId");
        String runId = call.getString("runId");
        if (!isValidGalleryId(galleryId)) { call.reject("galleryId must be numeric"); return; }
        if (!NativeDownloadRun.isValidRunId(runId)) { call.reject("runId is invalid"); return; }
        synchronized (NativeDownloadRun.lockFor(galleryId)) {
            call.resolve(readProgressForRun(
                    galleryId,
                    orderFile(galleryId),
                    progressFile(galleryId),
                    runId
            ));
        }
    }

    /**
     * Discover (without mutating native state) the runId that owns this gallery's
     * current order/progress files. Used to restore Android polling after the JS
     * runtime is recreated.
     */
    @PluginMethod
    public void getCurrentRun(PluginCall call) {
        String galleryId = call.getString("galleryId");
        if (!isValidGalleryId(galleryId)) { call.reject("galleryId must be numeric"); return; }
        synchronized (NativeDownloadRun.lockFor(galleryId)) {
            CurrentRunResolution resolution = resolveCurrentRun(
                    galleryId,
                    orderFile(galleryId),
                    progressFile(galleryId)
            );
            JSObject ret = new JSObject();
            ret.put("runId", resolution.runId == null ? JSObject.NULL : resolution.runId);
            if (resolution.conflict) ret.put("conflict", true);
            if (resolution.unknown) ret.put("unknown", true);
            if (resolution.legacy) ret.put("legacy", true);
            call.resolve(ret);
        }
    }

    /**
     * Cancel one gallery's pending download: delete its work-order file so the
     * worker skips it. When no work-orders remain, also cancel the unique work so
     * a running/queued worker stops.
     */
    @PluginMethod
    public void cancel(PluginCall call) {
        String galleryId = call.getString("galleryId");
        String runId = call.getString("runId");
        if (!isValidGalleryId(galleryId)) { call.reject("galleryId must be numeric"); return; }
        if (!NativeDownloadRun.isValidRunId(runId)) { call.reject("runId is invalid"); return; }
        try {
            CancelResult result = NativeDownloadRun.withQueueTransaction(galleryId, () -> {
                boolean cancelled = false;
                boolean stale = false;
                NativeDownloadRun requestedRun = NativeDownloadRun.create(galleryId, runId);
                File f = orderFile(galleryId);
                NativeDownloadRun current = NativeDownloadRun.fromOrderFile(f);
                if (requestedRun.equalsIdentity(current)) {
                    if (f.exists() && !f.delete()) {
                        throw new Exception("cancel delete failed: " + f.getName());
                    }
                    deleteProgressIfMatches(requestedRun);
                    cancelled = true;
                } else if (current != null) {
                    // A late cancel from an older UI run must be a strict no-op.
                    stale = true;
                } else {
                    // The worker may already have consumed the order. It is still
                    // safe to clean only this run's matching progress sentinel.
                    String progressRunId = NativeDownloadRun.progressRunId(progressFile(galleryId));
                    if (progressRunId != null && !runId.equals(progressRunId)) {
                        stale = true;
                    } else {
                        cancelled = deleteProgressIfMatches(requestedRun);
                    }
                }

                File dir = handoffDir();
                int remainingCount = countPendingWorkOrders(dir);
                if (cancelled && remainingCount == 0) {
                    WorkManager.getInstance(getContext())
                            .cancelUniqueWork(GalleryDownloadWorker.UNIQUE_WORK_NAME);
                }
                return new CancelResult(cancelled, stale, remainingCount);
            });
            JSObject ret = new JSObject();
            ret.put("runId", runId);
            ret.put("cancelled", result.cancelled);
            ret.put("stale", result.stale);
            ret.put("remaining", result.remainingCount);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("cancel error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        }
    }

}
