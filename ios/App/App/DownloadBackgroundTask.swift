import Foundation
import BackgroundTasks
import bypass

/// Task D — iOS best-effort background download.
///
/// iOS keeps the in-process TS foreground downloader (the
/// `CapacitorDownloadStore` path) while the app is open. ADDITIONALLY, when a
/// download is pending, the TS layer writes a work-order JSON to disk and submits
/// a `BGProcessingTask`. When iOS later grants that task some time, this routine
/// resumes the pending work-orders from disk — downloading each page through the
/// Rust bypass core (`bypassDownloadToFile`, preserving the ISP bypass) and
/// placing it where the in-app reader/library expect.
///
/// Background completion is **best-effort and NOT guaranteed**: iOS governs how
/// much time (if any) the task gets. If the task is expired before the queue
/// drains, the partial gallery is left on disk (resume-skip makes the next run
/// idempotent) and the task reschedules itself. Anything not finished in the
/// background simply continues when the app is next opened (foreground +
/// reconcileQueue).
///
/// A plain background `URLSession` is intentionally NOT used: it cannot route
/// through bypass-core's custom TLS. The Rust core is used instead, accepting the
/// OS-limited-time tradeoff.
///
/// DEVICE-PENDING: the sandbox cannot build or run iOS. This file is verified by
/// code review here and must be smoke-tested on a physical device:
///   - the "Background Modes → Background processing" capability is enabled
///     (Info.plist alone is not enough — see Info.plist comment),
///   - backgrounding the app mid-download makes progress / completes within the
///     OS-granted window,
///   - files land at EXACTLY the @capacitor/filesystem `Directory.Data` path the
///     reader uses (see `dataDownloadsDir()` below — the #1 correctness risk),
///   - expiry leaves a resumable partial gallery and reschedules.
final class DownloadBackgroundTask {
    static let shared = DownloadBackgroundTask()

    /// MUST match `BGTaskSchedulerPermittedIdentifiers` in Info.plist, the
    /// identifier registered in `AppDelegate`, and the request submitted by
    /// `DownloadWorkerPlugin.enqueue`.
    static let taskIdentifier = "com.hipago.app.download"

    /// Handoff dir basename. The Swift plugin (`DownloadWorkerPlugin`) writes
    /// `<ApplicationSupport>/dl-queue/<galleryId>.json` and this task reads from
    /// the SAME dir — mirroring the Android `filesDir/dl-queue/<id>.json` contract
    /// (`GalleryDownloadWorker.HANDOFF_DIR`), but on iOS the handoff lives in
    /// Application Support (app-private, not user-visible, survives relaunch and
    /// is backed up — appropriate for a small queue file).
    static let handoffDirName = "dl-queue"

    /// Subdirectory of `Directory.Data` the gallery images live under
    /// (`CapacitorDownloadStore.DOWNLOADS_DIR`).
    private static let downloadsDirName = "downloads"

    /// Manifest filename written into each gallery folder: a JSON array of
    /// per-page extensions (e.g. `["webp","webp"]`). Matches `imageFileName(-1)`
    /// → "0000.json" and `encodeManifest`/`decodeManifest` in download-zip.ts.
    private static let manifestFileName = "0000.json"

    private let fileManager = FileManager.default

    private init() {}

    // MARK: - Path resolution (the load-bearing contract)

    /// Absolute URL of the app handoff dir where work-orders are stored.
    /// Application Support is created lazily by the system; we ensure it exists.
    func handoffDir() -> URL {
        // `.applicationSupportDirectory` is not guaranteed to exist yet on a
        // fresh install, so create it (with intermediates) before use.
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let dir = base.appendingPathComponent(Self.handoffDirName, isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Absolute URL of `<Directory.Data>/downloads`, where each gallery is stored
    /// as `downloads/<galleryId>/NNNN.ext` + `0000.json`.
    ///
    /// PATH CONTRACT (the #1 correctness risk for this task) — must equal the path
    /// `@capacitor/filesystem`'s `Directory.Data` resolves to on iOS:
    ///
    /// `CapacitorDownloadStore` (src/lib/storage/adapters/capacitor.ts) writes to
    /// `Directory.Data` with relative path `downloads/<galleryId>/<NNNN.ext>`.
    /// In the capacitor-filesystem iOS plugin
    /// (node_modules/@capacitor/filesystem/ios/Sources/FilesystemPlugin/
    /// Filesystem.swift → `getDirectory`), the JS enum values map as:
    ///     "CACHE"   → .cachesDirectory
    ///     "LIBRARY" → .libraryDirectory
    ///     default   → .documentDirectory
    /// `Directory.Data` is `"DATA"` (definitions.d.ts: `Data = "DATA"`), which
    /// falls into the `default` branch → **`.documentDirectory`**. The plugin then
    /// resolves it with `FileManager.default.urls(for:in:.userDomainMask).first`
    /// and appends the relative path. We reproduce that EXACTLY here so the files
    /// this task writes are the same files the reader reads.
    ///
    ///   <app sandbox>/Documents/downloads/<galleryId>/0001.webp
    ///                                                 /0000.json
    func dataDownloadsDir() -> URL? {
        guard let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        else { return nil }
        return documents.appendingPathComponent(Self.downloadsDirName, isDirectory: true)
    }

    /// `<Directory.Data>/downloads/<galleryId>` — numeric-only folder name
    /// (`CapacitorDownloadStore.galleryPath` → `galleryFolderName(galleryId)` =
    /// `String(galleryId)`; NO title, unlike Android's `HiPaGo/<id title>`).
    private func galleryDir(galleryId: Int) -> URL? {
        dataDownloadsDir()?.appendingPathComponent(String(galleryId), isDirectory: true)
    }

    /// `downloads/<id>/NNNN.ext` page filename: 1-based, zero-padded to 4 digits
    /// (`imageFileName(index, ext)` in download-store.ts).
    private func pageFileName(index: Int, ext: String) -> String {
        String(format: "%04d.%@", index + 1, ext)
    }

    // MARK: - BGTask entry point

    /// Entry point invoked by the `BGTaskScheduler` launch handler registered in
    /// `AppDelegate`. Wires the OS expiration handler to a cooperative cancel
    /// flag, runs the drain loop on a background queue, reschedules if work
    /// remains, and reports completion to the OS.
    func run(task: BGProcessingTask) {
        let cancelled = AtomicFlag()
        task.expirationHandler = {
            // The OS is reclaiming our time. Signal the loop to stop after the
            // current page; the partial gallery stays on disk (resume-skip) and
            // the completion block below queues a follow-up request.
            cancelled.set()
        }

        DispatchQueue.global(qos: .background).async { [weak self] in
            guard let self = self else {
                task.setTaskCompleted(success: false)
                return
            }
            let drained = self.drainQueue(shouldStop: { cancelled.value })
            let success = drained && !cancelled.value
            if success {
                if self.hasPendingWorkOrders() {
                    self.scheduleProcessingTask()
                } else {
                    self.cancelPendingTask()
                }
            } else {
                self.scheduleProcessingTask()
            }
            task.setTaskCompleted(success: success)
        }
    }

    /// Submit a `BGProcessingTaskRequest` for the download identifier. Shared by
    /// `run` (reschedule) and `DownloadWorkerPlugin.enqueue` (initial submit).
    /// `requiresNetworkConnectivity` is set because every page is a network
    /// download; `earliestBeginDate` is left nil so iOS may grant time as soon as
    /// it sees fit. Best-effort: a submit failure (e.g. identifier not permitted,
    /// simulator) is swallowed — the foreground path still downloads.
    func scheduleProcessingTask() {
        let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = nil
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Best-effort scheduling; never propagate (background is not
            // guaranteed and the in-process foreground downloader is the primary
            // path). A submit can throw on the simulator or when the capability
            // is missing — both are surfaced by device QA, not at runtime.
            NSLog("[DownloadBackgroundTask] schedule failed: \(error.localizedDescription)")
        }
    }

    /// Cancel the pending processing request (used when the queue empties).
    func cancelPendingTask() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)
    }

    func hasPendingWorkOrders() -> Bool {
        guard
            let entries = try? fileManager.contentsOfDirectory(
                at: handoffDir(), includingPropertiesForKeys: nil
            )
        else { return false }
        return entries.contains { $0.pathExtension == "json" }
    }

    // MARK: - Drain loop (testable inner routine)

    /// Drain every pending work-order. Returns true when the whole queue was
    /// processed (each gallery either fully downloaded → work-order deleted, or
    /// left partial on a page failure → work-order KEPT for a later resume) WITHOUT
    /// being asked to stop. Returns false if `shouldStop()` cut the run short.
    ///
    /// Pulled out of `run(task:)` so it can be exercised directly in a unit/host
    /// test (pass an in-memory `shouldStop` and a seeded handoff dir) without a
    /// live `BGProcessingTask`.
    @discardableResult
    func drainQueue(shouldStop: () -> Bool) -> Bool {
        let dir = handoffDir()
        let orderFiles: [URL]
        do {
            orderFiles = try fileManager.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil
            )
            .filter { $0.pathExtension == "json" }
            // Stable order (TS names files <galleryId>.json) so behaviour is
            // deterministic — mirrors the Android worker's name sort.
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        } catch {
            // No handoff dir / unreadable → nothing pending. Treat as drained.
            return true
        }

        if orderFiles.isEmpty { return true }

        var fullyDrained = true
        for orderFile in orderFiles {
            if shouldStop() { return false }

            guard let order = readOrder(orderFile) else {
                // Unparseable work-order — drop it so it cannot wedge the queue
                // (matches GalleryDownloadWorker.readOrder == null → delete).
                try? fileManager.removeItem(at: orderFile)
                continue
            }

            let outcome = processGallery(order, orderFile: orderFile, shouldStop: shouldStop)
            switch outcome {
            case .completed:
                // Full success → remove the work-order so it is not reprocessed.
                try? fileManager.removeItem(at: orderFile)
            case .partial:
                // A page failed: leave the gallery partial and KEEP the work-order
                // so the next background run / foreground reconcile resumes it.
                fullyDrained = false
            case .stopped:
                // Expired mid-gallery: KEEP the work-order, report not-drained.
                return false
            }
        }
        return fullyDrained
    }

    private enum GalleryOutcome {
        case completed
        case partial
        case stopped
    }

    /// Download every page of one gallery, writing into
    /// `<Data>/downloads/<id>/NNNN.ext` and rewriting `0000.json` incrementally.
    /// Skips pages already on disk (resume). Mirrors `GalleryDownloadWorker.
    /// processGallery` and the TS `downloadGalleryToLibrary` page loop.
    private func processGallery(
        _ order: WorkOrder,
        orderFile: URL,
        shouldStop: () -> Bool
    ) -> GalleryOutcome {
        let pages = order.pages
        if pages.isEmpty {
            // Nothing to download — treat as complete so the work-order clears.
            return .completed
        }

        guard let galleryDir = galleryDir(galleryId: order.galleryId) else {
            // Could not resolve the Data dir — leave partial (do not lose the
            // work-order); extremely unlikely on a real device.
            return .partial
        }

        do {
            try fileManager.createDirectory(at: galleryDir, withIntermediateDirectories: true)
        } catch {
            return .partial
        }

        // The manifest is the per-page ext array, written incrementally so the TS
        // reader/reconcile sees the gallery growing.
        var exts = [String](repeating: "webp", count: pages.count)

        for (i, page) in pages.enumerated() {
            if shouldStop() { return .stopped }
            if !fileManager.fileExists(atPath: orderFile.path) {
                // Foreground pause/cancel removed the handoff while this task was
                // already running. Stop this gallery without rescheduling it.
                return .completed
            }

            exts[i] = page.ext
            let dest = galleryDir.appendingPathComponent(
                pageFileName(index: page.index, ext: page.ext)
            )

            // Resume: a page already on disk is skipped (idempotent overlap with
            // the foreground downloader, which suspends while backgrounded).
            if isNonEmptyFile(dest) {
                continue
            }
            if fileManager.fileExists(atPath: dest.path) {
                try? fileManager.removeItem(at: dest)
            }

            // Download via the Rust bypass core to a temp file in the caches dir,
            // then move it into place. The image never enters the JS heap (this is
            // native code). bypassDownloadToFile writes the destPath directly, so
            // we point it at a temp file and atomically move on success — a partial
            // write from an interrupted download never masquerades as a finished
            // page (which resume-skip would then wrongly skip).
            let tempDir = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
                ?? fileManager.temporaryDirectory
            let temp = tempDir.appendingPathComponent("dl-\(UUID().uuidString).\(page.ext)")
            do {
                _ = try bypassDownloadToFile(
                    url: page.url,
                    headers: page.headers.isEmpty ? nil : page.headers,
                    destPath: temp.path
                )
                if shouldStop() {
                    try? fileManager.removeItem(at: temp)
                    return .stopped
                }
                if !fileManager.fileExists(atPath: orderFile.path) {
                    try? fileManager.removeItem(at: temp)
                    return .completed
                }
                guard isNonEmptyFile(temp) else {
                    try? fileManager.removeItem(at: temp)
                    return .partial
                }
                // Move temp → final. Remove any stale dest first (defensive: a
                // zero-byte/partial leftover from a prior crashed run).
                if fileManager.fileExists(atPath: dest.path) {
                    try? fileManager.removeItem(at: dest)
                }
                try fileManager.moveItem(at: temp, to: dest)
            } catch {
                // Page hard-failure (URL/gg expiry, network). Leave the gallery
                // partial; TS re-resolves / reconciles on next open.
                try? fileManager.removeItem(at: temp)
                return .partial
            }

            // Incremental manifest write (first i+1 exts) after each placed page.
            if !writeManifest(galleryDir: galleryDir, exts: Array(exts.prefix(i + 1))) {
                return .partial
            }
        }

        // All pages present → write the final, full manifest once more (defensive).
        return writeManifest(galleryDir: galleryDir, exts: exts) ? .completed : .partial
    }

    private func isNonEmptyFile(_ url: URL) -> Bool {
        guard fileManager.fileExists(atPath: url.path) else { return false }
        guard
            let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
            let size = values.fileSize
        else { return false }
        return size > 0
    }

    /// Write `<galleryDir>/0000.json` as a JSON array of exts, e.g.
    /// `["webp","webp"]`. Matches `encodeManifest` in download-zip.ts
    /// (`JSON.stringify(exts)`) so `decodeManifest`/`getDownloadedGalleryPages`
    /// reads it unchanged. Returning false keeps the work-order pending so the
    /// next run can rebuild the manifest from the files already present.
    private func writeManifest(galleryDir: URL, exts: [String]) -> Bool {
        let manifestURL = galleryDir.appendingPathComponent(Self.manifestFileName)
        do {
            // JSONSerialization on a [String] produces a compact array identical to
            // JSON.stringify(string[]) — no pretty-printing, no extra whitespace.
            let data = try JSONSerialization.data(withJSONObject: exts, options: [])
            try data.write(to: manifestURL, options: .atomic)
            return true
        } catch {
            NSLog("[DownloadBackgroundTask] manifest write failed: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Work-order parsing

    /// One page of a work-order. Mirrors the TS `WorkOrderItem` plus headers.
    /// iOS does NOT consume `relPath` (it builds the numeric `downloads/<id>/`
    /// path itself from galleryId+index+ext — see `pageFileName`/`galleryDir`),
    /// so `relPath` is ignored if present.
    struct WorkPage {
        let index: Int
        let url: String
        let ext: String
        let headers: [String: String]
    }

    struct WorkOrder {
        let galleryId: Int
        let pages: [WorkPage]
    }

    /// Parse a work-order JSON file. Tolerant of the extra Android fields
    /// (`title`, `folderName`, per-page `relPath`) — iOS reads only what it needs.
    /// Shape (written by TS `writeWorkOrder`):
    ///   { "galleryId": 12345, "pages": [ { "index": 0, "url": "https://…",
    ///       "ext": "webp", "headers": { "Referer": … } }, … ] }
    private func readOrder(_ file: URL) -> WorkOrder? {
        guard
            let data = try? Data(contentsOf: file),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        // galleryId may arrive as a JSON number; NSNumber bridges to Int.
        guard let galleryId = (root["galleryId"] as? NSNumber)?.intValue
            ?? (root["galleryId"] as? Int)
        else { return nil }

        let rawPages = root["pages"] as? [[String: Any]] ?? []
        let pages: [WorkPage] = rawPages.compactMap { p in
            guard
                let url = p["url"] as? String,
                !url.isEmpty
            else { return nil }
            let index = (p["index"] as? NSNumber)?.intValue ?? (p["index"] as? Int) ?? 0
            let ext = (p["ext"] as? String) ?? "webp"
            var headers: [String: String] = [:]
            if let h = p["headers"] as? [String: Any] {
                for (k, v) in h {
                    if let sv = v as? String { headers[k] = sv }
                }
            }
            return WorkPage(index: index, url: url, ext: ext, headers: headers)
        }
        return WorkOrder(galleryId: galleryId, pages: pages)
    }
}

/// Tiny thread-safe boolean used to bridge the OS `expirationHandler` (which may
/// fire on an arbitrary thread) to the background drain loop. A serial-queue
/// guard is sufficient — the loop only ever reads it between pages.
private final class AtomicFlag {
    private var flag = false
    private let queue = DispatchQueue(label: "com.hipago.app.download.expiry")

    var value: Bool {
        queue.sync { flag }
    }

    func set() {
        queue.sync { flag = true }
    }
}
