package com.hipago.app;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

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
 * unique worker ({@link GalleryDownloadWorker#UNIQUE_WORK_NAME}, policy KEEP)
 * drains ALL pending work-order files, so enqueueing several galleries then
 * calling enqueue once is enough — the running worker picks up the new files.
 *
 * Network constraint: {@link NetworkType#UNMETERED} (Wi-Fi/ethernet only), so a
 * metered/no network holds the work until Wi-Fi returns (WorkManager re-runs it).
 *
 * {@link #cancel} removes one gallery's work-order file; if no work-orders remain
 * it also cancels the unique work so the worker stops.
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file is verified by
 * code review here and must be smoke-tested on a physical/emulator Android
 * device (WorkManager scheduling, UNMETERED constraint, KEEP policy, cancel).
 */
@CapacitorPlugin(name = "DownloadWorker")
public class DownloadWorkerPlugin extends Plugin {

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
     * Enqueue the unique, Wi-Fi-constrained download worker. The work-order file is
     * assumed already written (via {@link #writeWorkOrder}). KEEP means a worker
     * that is already running/enqueued is left alone — it will pick up the new
     * work-order file on its current run or the next.
     */
    @PluginMethod
    public void enqueue(PluginCall call) {
        try {
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.UNMETERED)
                    .build();
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(GalleryDownloadWorker.class)
                    .setConstraints(constraints)
                    .build();
            WorkManager.getInstance(getContext()).enqueueUniqueWork(
                    GalleryDownloadWorker.UNIQUE_WORK_NAME,
                    ExistingWorkPolicy.KEEP,
                    request);
            call.resolve();
        } catch (Exception e) {
            call.reject("enqueue error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
        }
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
