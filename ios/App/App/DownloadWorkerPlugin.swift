import Foundation
import Capacitor
import BackgroundTasks

/// Capacitor plugin bridging the TS download queue to the iOS best-effort
/// background download task (Task D). It exposes the SAME JS interface (jsName
/// "DownloadWorker", methods `writeWorkOrder` / `enqueue` / `cancel`) as the
/// Android `DownloadWorkerPlugin.java` — the TS layer
/// (src/lib/plugins/downloadWorker.ts) is platform-agnostic; each platform ships
/// its own native implementation and Capacitor auto-discovers the right one.
///
/// Unlike Android (where the WorkManager worker is the SOLE downloader), on iOS
/// this is a BACKSTOP: the in-process TS foreground downloader still runs while
/// the app is open. `writeWorkOrder` persists a work-order so a backgrounding app
/// can resume it; `enqueue` submits the `BGProcessingTask`; `cancel` drops a
/// gallery's work-order and cancels the pending request once the queue is empty.
///
/// Handoff dir: `<ApplicationSupport>/dl-queue/<galleryId>.json` — the same dir
/// `DownloadBackgroundTask` reads (see `DownloadBackgroundTask.handoffDir()`).
///
/// DEVICE-PENDING: the sandbox cannot build or run iOS. Verified by code review
/// here; smoke-test on a physical device (work-order persisted, BGTask submitted,
/// cancel removes the file + cancels the request when the queue empties).
@objc(DownloadWorkerPlugin)
public class DownloadWorkerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DownloadWorkerPlugin"
    public let jsName = "DownloadWorker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "writeWorkOrder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let fileManager = FileManager.default

    /// Handoff dir, resolved through `DownloadBackgroundTask` so the writer and
    /// the reader can never disagree on the location.
    private func handoffDir() -> URL {
        DownloadBackgroundTask.shared.handoffDir()
    }

    private func orderFile(galleryId: String) -> URL {
        handoffDir().appendingPathComponent("\(galleryId).json")
    }

    /// Persist a work-order JSON to `<ApplicationSupport>/dl-queue/<galleryId>.json`
    /// so the background task can read it. TS passes the already-serialized JSON
    /// string and the galleryId (used only for the filename). Does NOT schedule the
    /// task — call `enqueue` after.
    @objc func writeWorkOrder(_ call: CAPPluginCall) {
        guard let galleryId = call.getString("galleryId"), !galleryId.isEmpty else {
            call.reject("galleryId is required")
            return
        }
        guard let json = call.getString("json") else {
            call.reject("json is required")
            return
        }
        do {
            let url = orderFile(galleryId: galleryId)
            try json.data(using: .utf8)?.write(to: url, options: .atomic)
            call.resolve()
        } catch {
            call.reject("writeWorkOrder error: \(error.localizedDescription)")
        }
    }

    /// Submit a `BGProcessingTaskRequest` for the download identifier. The
    /// work-order file is assumed already written (via `writeWorkOrder`).
    /// Submitting again with the same identifier replaces any pending request —
    /// so enqueueing several galleries then calling enqueue once is sufficient;
    /// when the task eventually runs it drains every pending work-order. Submit is
    /// best-effort (see `DownloadBackgroundTask.scheduleProcessingTask`).
    @objc func enqueue(_ call: CAPPluginCall) {
        DownloadBackgroundTask.shared.scheduleProcessingTask()
        call.resolve()
    }

    /// Cancel one gallery's pending background download: remove its work-order
    /// file so the task skips it. When no work-orders remain, also cancel the
    /// pending `BGProcessingTaskRequest` so the OS does not wake us for an empty
    /// queue. Resolves `{ remaining }` — the count of work-orders still pending
    /// (mirrors the Android plugin's return).
    @objc func cancel(_ call: CAPPluginCall) {
        guard let galleryId = call.getString("galleryId"), !galleryId.isEmpty else {
            call.reject("galleryId is required")
            return
        }
        let file = orderFile(galleryId: galleryId)
        try? fileManager.removeItem(at: file)

        let remaining: Int
        if let entries = try? fileManager.contentsOfDirectory(
            at: handoffDir(), includingPropertiesForKeys: nil
        ) {
            remaining = entries.filter { $0.pathExtension == "json" }.count
        } else {
            remaining = 0
        }

        if remaining == 0 {
            DownloadBackgroundTask.shared.cancelPendingTask()
        }
        call.resolve(["remaining": remaining])
    }
}
