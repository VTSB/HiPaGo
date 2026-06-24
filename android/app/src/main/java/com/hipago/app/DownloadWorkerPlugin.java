package com.hipago.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.work.Constraints;
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

    /**
     * Persist a work-order JSON to {@code filesDir/dl-queue/<galleryId>.json} so
     * the worker can read it. TS passes the already-serialized JSON string and the
     * galleryId (used only for the filename). Does NOT enqueue — call enqueue next.
     */
    @PluginMethod
    public void writeWorkOrder(PluginCall call) {
        String galleryId = call.getString("galleryId");
        String json = call.getString("json");
        if (galleryId == null || galleryId.isEmpty()) { call.reject("galleryId is required"); return; }
        if (json == null) { call.reject("json is required"); return; }
        try {
            File f = orderFile(galleryId);
            try (FileOutputStream fos = new FileOutputStream(f)) {
                fos.write(json.getBytes("UTF-8"));
                fos.flush();
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
            ExistingWorkPolicy policy = workPolicyForCurrentConstraint();
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(GalleryDownloadWorker.class)
                    .setConstraints(constraints)
                    .build();
            WorkManager.getInstance(getContext()).enqueueUniqueWork(
                    GalleryDownloadWorker.UNIQUE_WORK_NAME,
                    policy,
                    request);
            call.resolve();
        } catch (Exception e) {
            call.reject("enqueue error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        }
    }

    private ExistingWorkPolicy workPolicyForCurrentConstraint() {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int version = prefs.getInt(KEY_NETWORK_CONSTRAINT_VERSION, 0);
        if (version >= NETWORK_CONSTRAINT_CONNECTED_VERSION) {
            return ExistingWorkPolicy.APPEND_OR_REPLACE;
        }

        // One-time migration from the old UNMETERED work constraint. Existing
        // WorkManager requests keep their original constraints across app
        // updates, so replace the unique chain once; persistent work-order files
        // let the new CONNECTED worker resume anything that was interrupted.
        prefs.edit()
                .putInt(KEY_NETWORK_CONSTRAINT_VERSION, NETWORK_CONSTRAINT_CONNECTED_VERSION)
                .apply();
        return ExistingWorkPolicy.REPLACE;
    }

    /**
     * Read one gallery's live progress, written by the worker to
     * {@code filesDir/dl-progress/<galleryId>.json = {"current":N,"total":M}}.
     * Resolves {@code {current, total}} when the file is present and parseable;
     * resolves {@code {current: null}} (a "no progress yet" sentinel) when the file
     * is absent or unreadable. The TS poller treats a null current as "leave the
     * last known value". The in-app poller only runs on Android, so iOS omits this
     * method (the TS caller is isAndroid-gated).
     *
     * DEVICE-PENDING: verified by code review here; smoke-test on a device that the
     * advancing values reach the in-app card and that a completed gallery reads
     * absent (null) after the worker deletes the file.
     */
    @PluginMethod
    public void getProgress(PluginCall call) {
        String galleryId = call.getString("galleryId");
        if (galleryId == null || galleryId.isEmpty()) { call.reject("galleryId is required"); return; }
        File f = new File(
                new File(getContext().getFilesDir(), GalleryDownloadWorker.PROGRESS_DIR),
                galleryId + ".json");
        JSObject ret = new JSObject();
        if (!f.exists()) {
            // Absent → no active progress (not started, or already completed/cleared).
            ret.put("current", JSObject.NULL);
            call.resolve(ret);
            return;
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
            ret.put("current", obj.getInt("current"));
            ret.put("total", obj.getInt("total"));
            call.resolve(ret);
        } catch (Throwable t) {
            // Unparseable / torn write → treat as no progress this tick.
            ret.put("current", JSObject.NULL);
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
        if (galleryId == null || galleryId.isEmpty()) { call.reject("galleryId is required"); return; }
        try {
            File f = orderFile(galleryId);
            if (f.exists()) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
            File dir = handoffDir();
            File[] remaining = dir.listFiles((d, name) -> name.endsWith(".json"));
            if (remaining == null || remaining.length == 0) {
                WorkManager.getInstance(getContext())
                        .cancelUniqueWork(GalleryDownloadWorker.UNIQUE_WORK_NAME);
            }
            JSObject ret = new JSObject();
            ret.put("remaining", remaining == null ? 0 : remaining.length);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("cancel error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        }
    }
}
