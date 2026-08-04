import Foundation
import BackgroundTasks
import CoreFoundation

enum NativeFileReadState<Value> {
    case absent
    case valid(Value)
    case malformed
    case unreadable(NSError)
}

struct NativeJSONDocument {
    let data: Data
    let root: [String: Any]
}

private func isMissingNativeFileError(_ error: NSError) -> Bool {
    error.domain == NSCocoaErrorDomain &&
        (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError)
}

func readNativeFile(_ file: URL) -> NativeFileReadState<Data> {
    do {
        return .valid(try Data(contentsOf: file))
    } catch {
        let nsError = error as NSError
        return isMissingNativeFileError(nsError) ? .absent : .unreadable(nsError)
    }
}

func readNativeJSONDocument(_ file: URL) -> NativeFileReadState<NativeJSONDocument> {
    switch readNativeFile(file) {
    case .absent:
        return .absent
    case .unreadable(let error):
        return .unreadable(error)
    case .malformed:
        return .malformed
    case .valid(let data):
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return .malformed }
        return .valid(NativeJSONDocument(data: data, root: root))
    }
}

/// iOS equivalent of Android's NativeRequestPolicy. Work-order JSON originates
/// in the WebView, so it is untrusted at the native boundary even when the
/// current TypeScript producer is correct.
enum NativeDownloadRequestPolicy {
    private static let maximumHeaderCount = 16
    private static let maximumHeaderNameLength = 64
    private static let maximumHeaderValueLength = 4096
    private static let maximumExtensionLength = 16
    private static let maximumCacheKeyLength = 200
    private static let allowedHeaders: Set<String> = [
        "accept",
        "accept-language",
        "origin",
        "range",
        "referer",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "user-agent"
    ]

    static func isAllowedBypassURL(_ rawURL: String) -> Bool {
        guard
            !rawURL.isEmpty,
            let components = URLComponents(string: rawURL),
            components.url != nil,
            components.scheme?.lowercased() == "https",
            components.user == nil,
            components.password == nil,
            components.fragment == nil,
            (components.port == nil || components.port == 443),
            let host = components.host?.lowercased(),
            !host.isEmpty
        else { return false }

        return host == "hitomi.la" ||
            host == "tagindex.hitomi.la" ||
            (host.hasSuffix(".gold-usergeneratedcontent.net") &&
                host != "gold-usergeneratedcontent.net")
    }

    static func validateHeaders(_ raw: Any?) -> [String: String]? {
        if raw == nil || raw is NSNull { return [:] }
        guard let source = raw as? [String: Any], source.count <= maximumHeaderCount else {
            return nil
        }

        var normalized: [String: String] = [:]
        for (name, rawValue) in source {
            guard let value = rawValue as? String else { return nil }
            let lowerName = name.lowercased()
            guard
                allowedHeaders.contains(lowerName),
                !name.isEmpty,
                name.count <= maximumHeaderNameLength,
                value.utf8.count <= maximumHeaderValueLength,
                !name.contains("\r"),
                !name.contains("\n"),
                !value.contains("\r"),
                !value.contains("\n"),
                normalized[lowerName] == nil
            else { return nil }

            if lowerName == "range" && !isValidByteRange(value) { return nil }
            if lowerName == "origin" && value != "https://hitomi.la" { return nil }
            if lowerName == "referer" && value != "https://hitomi.la/" { return nil }
            normalized[lowerName] = value
        }
        return normalized
    }

    static func isValidExtension(_ ext: String) -> Bool {
        guard !ext.isEmpty, ext.count <= maximumExtensionLength else { return false }
        return ext.unicodeScalars.allSatisfy { scalar in
            let value = scalar.value
            let alpha = (65...90).contains(value) || (97...122).contains(value)
            let digit = (48...57).contains(value)
            return alpha || digit
        }
    }

    static func expectedRelPath(galleryId: String, index: Int, ext: String) -> String {
        "downloads/\(galleryId)/\(String(format: "%04d", index + 1)).\(ext)"
    }

    /// Resolve a renderer-supplied absolute path to one canonical direct child
    /// of `<app caches>/image-cache`. Resolving symlinks on both paths prevents
    /// traversal through a stale link inside the cache tree.
    static func resolveImageCacheDestination(
        _ rawPath: String,
        fileManager: FileManager = .default
    ) -> URL? {
        guard
            !rawPath.isEmpty,
            (rawPath as NSString).isAbsolutePath,
            let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
        else { return nil }

        let destination = URL(fileURLWithPath: rawPath, isDirectory: false)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let root = caches
            .appendingPathComponent("image-cache", isDirectory: true)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let cacheKey = destination.lastPathComponent
        guard
            destination.deletingLastPathComponent().path == root.path,
            isValidCacheKey(cacheKey)
        else { return nil }
        return destination
    }

    private static func isValidByteRange(_ value: String) -> Bool {
        guard value.hasPrefix("bytes=") else { return false }
        let bounds = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard
            bounds.count == 2,
            bounds.allSatisfy({ bound in
                !bound.isEmpty && bound.unicodeScalars.allSatisfy {
                    (48...57).contains($0.value)
                }
            }),
            let start = UInt64(String(bounds[0])),
            let end = UInt64(String(bounds[1]))
        else { return false }
        return start <= end
    }

    private static func isValidCacheKey(_ cacheKey: String) -> Bool {
        guard
            !cacheKey.isEmpty,
            cacheKey.utf8.count <= maximumCacheKeyLength,
            cacheKey != ".",
            cacheKey != ".."
        else { return false }
        return cacheKey.unicodeScalars.allSatisfy { scalar in
            let value = scalar.value
            let alpha = (65...90).contains(value) || (97...122).contains(value)
            let digit = (48...57).contains(value)
            return alpha || digit || value == 46 || value == 95 || value == 45
        }
    }
}

/// Immutable identity for one concrete native download attempt. Gallery id is
/// the logical queue key; runId changes for every replacement/retry.
struct NativeDownloadRunIdentity: Equatable {
    private static let minimumRunIdLength = 16
    private static let maximumRunIdLength = 128

    let galleryId: String
    let runId: String

    init?(galleryId: String, runId: String) {
        guard
            Self.isValidGalleryId(galleryId),
            Self.isValidRunId(runId)
        else { return nil }
        self.galleryId = galleryId
        self.runId = runId
    }

    static func isValidGalleryId(_ galleryId: String) -> Bool {
        !galleryId.isEmpty && galleryId.unicodeScalars.allSatisfy {
            (48...57).contains($0.value)
        }
    }

    static func isValidRunId(_ runId: String) -> Bool {
        guard
            runId.count >= minimumRunIdLength,
            runId.count <= maximumRunIdLength
        else { return false }
        return runId.unicodeScalars.allSatisfy { scalar in
            let value = scalar.value
            let alpha = (65...90).contains(value) || (97...122).contains(value)
            let digit = (48...57).contains(value)
            return alpha || digit || value == 45 || value == 95
        }
    }

    static func from(jsonData: Data) -> NativeDownloadRunIdentity? {
        guard
            let root = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
            let identity = from(jsonObject: root)
        else { return nil }
        return identity
    }

    static func from(jsonObject root: [String: Any]) -> NativeDownloadRunIdentity? {
        guard
            let galleryId = galleryId(from: root["galleryId"]),
            let runId = root["runId"] as? String
        else { return nil }
        return NativeDownloadRunIdentity(galleryId: galleryId, runId: runId)
    }

    static func orderFileState(at file: URL) -> NativeFileReadState<NativeDownloadRunIdentity> {
        switch readNativeJSONDocument(file) {
        case .absent:
            return .absent
        case .malformed:
            return .malformed
        case .unreadable(let error):
            return .unreadable(error)
        case .valid(let document):
            guard let identity = from(jsonObject: document.root) else { return .malformed }
            return .valid(identity)
        }
    }

    static func progressFileState(at file: URL) -> NativeFileReadState<String> {
        switch readNativeJSONDocument(file) {
        case .absent:
            return .absent
        case .malformed:
            return .malformed
        case .unreadable(let error):
            return .unreadable(error)
        case .valid(let document):
            guard
                let runId = document.root["runId"] as? String,
                isValidRunId(runId)
            else { return .malformed }
            return .valid(runId)
        }
    }

    static func galleryId(from raw: Any?) -> String? {
        if let string = raw as? String, isValidGalleryId(string) { return string }
        guard let number = raw as? NSNumber else { return nil }
        // JSON booleans also bridge as NSNumber; never turn `true` into gallery 1.
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let string = number.stringValue
        return isValidGalleryId(string) ? string : nil
    }
}

/// One process-wide recursive lock linearizes plugin calls with BGTask publish
/// and cleanup boundaries. iOS runs the drain loop sequentially, so a global
/// lock is both simple and short-held (network downloads happen outside it).
final class NativeDownloadRunCoordinator {
    static let shared = NativeDownloadRunCoordinator()

    private let lock = NSRecursiveLock()

    private init() {}

    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    enum Ownership {
        case current
        case absent
        case stale
        case malformed
        case unreadable(NSError)
    }

    func orderOwnership(_ run: NativeDownloadRunIdentity, at orderFile: URL) -> Ownership {
        withLock {
            switch NativeDownloadRunIdentity.orderFileState(at: orderFile) {
            case .absent:
                return .absent
            case .malformed:
                return .malformed
            case .unreadable(let error):
                return .unreadable(error)
            case .valid(let current):
                return current == run ? .current : .stale
            }
        }
    }

    func orderIsCurrent(_ run: NativeDownloadRunIdentity, at orderFile: URL) -> Bool {
        if case .current = orderOwnership(run, at: orderFile) { return true }
        return false
    }
}

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

    /// Generation-tagged progress files read by DownloadWorker.getProgress.
    static let progressDirName = "dl-progress"

    /// Subdirectory of `Directory.Data` the gallery images live under
    /// (`CapacitorDownloadStore.DOWNLOADS_DIR`).
    private static let downloadsDirName = "downloads"

    /// Manifest filename written into each gallery folder: a JSON array of
    /// per-page extensions (e.g. `["webp","webp"]`). Matches `imageFileName(-1)`
    /// → "0000.json" and `encodeManifest`/`decodeManifest` in download-zip.ts.
    private static let manifestFileName = "0000.json"

    private let fileManager = FileManager.default
    private let runs = NativeDownloadRunCoordinator.shared
    private var activeStopFlag: AtomicFlag?
    private var enqueueGeneration: UInt64 = 0

    enum QueueDrainResult {
        case drained
        case parkedOnly
        case retryable
        case stopped

        var completedSuccessfully: Bool {
            switch self {
            case .drained, .parkedOnly:
                return true
            case .retryable, .stopped:
                return false
            }
        }
    }

    enum PendingQueueDisposition {
        case empty
        case parkedOnly
        case actionable
        case retryable
    }

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

    /// Absolute URL of the app-private native progress directory.
    func progressDir() -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let dir = base.appendingPathComponent(Self.progressDirName, isDirectory: true)
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
        let observedEnqueueGeneration = runs.withLock { () -> UInt64 in
            // BGTaskScheduler should serialize this identifier, but stop any
            // prior drain defensively before installing the active flag.
            activeStopFlag?.set()
            activeStopFlag = cancelled
            return enqueueGeneration
        }
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
            let drainResult = self.drainQueue(shouldStop: { cancelled.value })
            var success = drainResult.completedSuccessfully && !cancelled.value
            self.runs.withLock {
                // A plugin enqueue after this task started owns the newest pending
                // request. Do not let the older task cancel or delay it.
                if self.activeStopFlag === cancelled &&
                    self.enqueueGeneration == observedEnqueueGeneration {
                    // Linearize the empty-check and cancel/reschedule decision with
                    // plugin write/enqueue.
                    if success {
                        switch self.pendingQueueDisposition() {
                        case .actionable:
                            if !self.scheduleProcessingTask() { success = false }
                        case .parkedOnly, .empty:
                            self.cancelPendingTask()
                        case .retryable:
                            _ = self.scheduleProcessingTask(after: 5 * 60)
                            success = false
                        }
                    } else {
                        _ = self.scheduleProcessingTask(after: 5 * 60)
                    }
                }
                if self.activeStopFlag === cancelled {
                    self.activeStopFlag = nil
                }
            }
            task.setTaskCompleted(success: success)
        }
    }

    /// Called synchronously from AppDelegate before foreground JS resumes. Taking
    /// the generation lock waits out any in-flight native publish, then the flag
    /// prevents a native network result from publishing after the app is active.
    func stopForForeground() {
        runs.withLock {
            activeStopFlag?.set()
        }
    }

    /// Submit a `BGProcessingTaskRequest` for the download identifier. Shared by
    /// `run` (reschedule) and `DownloadWorkerPlugin.enqueue` (initial submit).
    /// `requiresNetworkConnectivity` is set because every page is a network
    /// download. The return value distinguishes an accepted request from a
    /// synchronous scheduling failure.
    @discardableResult
    func scheduleProcessingTask(
        after delay: TimeInterval? = nil,
        recordingPluginEnqueue: Bool = false
    ) -> Bool {
        return runs.withLock {
            let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
            request.requiresNetworkConnectivity = true
            request.requiresExternalPower = false
            if let delay, delay > 0 {
                request.earliestBeginDate = Date(timeIntervalSinceNow: delay)
            } else {
                request.earliestBeginDate = nil
            }
            do {
                try BGTaskScheduler.shared.submit(request)
                if recordingPluginEnqueue { enqueueGeneration &+= 1 }
                return true
            } catch {
                if isCoalescedPendingRequestError(error) {
                    // This app permits only this one BGProcessingTask identifier.
                    // A quota rejection therefore means an equivalent request is
                    // already pending; preserve the newly written order and let
                    // that request drain it.
                    if recordingPluginEnqueue { enqueueGeneration &+= 1 }
                    NSLog("[DownloadBackgroundTask] schedule coalesced with pending request")
                    return true
                }
                // Execution remains best-effort after submission, but a synchronous
                // rejection is actionable and must reach the plugin caller.
                NSLog("[DownloadBackgroundTask] schedule failed: \(error.localizedDescription)")
                return false
            }
        }
    }

    private func isCoalescedPendingRequestError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == BGTaskScheduler.errorDomain &&
            nsError.code == BGTaskScheduler.Error.Code.tooManyPendingTaskRequests.rawValue
    }

    /// Cancel the pending processing request (used when the queue empties).
    func cancelPendingTask() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskIdentifier)
    }

    enum PendingOrderFilesState {
        case absent
        case valid([URL])
        case unreadable(NSError)
    }

    func pendingOrderFilesState() -> PendingOrderFilesState {
        do {
            let entries = try fileManager.contentsOfDirectory(
                at: handoffDir(), includingPropertiesForKeys: nil
            )
            return .valid(entries.filter { $0.pathExtension == "json" })
        } catch {
            let nsError = error as NSError
            return isMissingNativeFileError(nsError) ? .absent : .unreadable(nsError)
        }
    }

    func pendingQueueDisposition() -> PendingQueueDisposition {
        let orderFiles: [URL]
        switch pendingOrderFilesState() {
        case .absent:
            return .empty
        case .unreadable(let error):
            NSLog("[DownloadBackgroundTask] queue read failed: \(error.localizedDescription)")
            return .retryable
        case .valid(let files):
            orderFiles = files
        }

        var hasActionableOrder = false
        var hasParkedLegacy = false
        var hasRetryableState = false
        for orderFile in orderFiles {
            switch readOrderState(orderFile) {
            case .absent:
                continue
            case .valid(_):
                hasActionableOrder = true
            case .unreadable(let error):
                NSLog("[DownloadBackgroundTask] order read failed: \(error.localizedDescription)")
                hasRetryableState = true
            case .malformed:
                let galleryId = orderFile.deletingPathExtension().lastPathComponent
                switch readNativeJSONDocument(orderFile) {
                case .valid(let document)
                    where isLegacyOrderDocument(document, galleryId: galleryId):
                    hasParkedLegacy = true
                case .absent:
                    continue
                case .valid(_), .malformed:
                    hasRetryableState = true
                case .unreadable(let error):
                    NSLog("[DownloadBackgroundTask] order read failed: \(error.localizedDescription)")
                    hasRetryableState = true
                }
            }
        }

        if hasRetryableState { return .retryable }
        if hasActionableOrder { return .actionable }
        if hasParkedLegacy { return .parkedOnly }
        return .empty
    }

    // MARK: - Drain loop (testable inner routine)

    /// Drain every actionable work-order and distinguish a queue containing only
    /// confirmed pre-runId state parked for foreground generation upgrade.
    ///
    /// Pulled out of `run(task:)` so it can be exercised directly in a unit/host
    /// test (pass an in-memory `shouldStop` and a seeded handoff dir) without a
    /// live `BGProcessingTask`.
    @discardableResult
    func drainQueue(shouldStop: () -> Bool) -> QueueDrainResult {
        let orderFiles: [URL]
        switch pendingOrderFilesState() {
        case .absent:
            return .drained
        case .unreadable(let error):
            NSLog("[DownloadBackgroundTask] queue enumeration failed: \(error.localizedDescription)")
            return .retryable
        case .valid(let files):
            orderFiles = files
        }
        if orderFiles.isEmpty { return .drained }

        var readableOrders: [(file: URL, order: WorkOrder)] = []
        var hasParkedLegacy = false
        var hasRetryableState = false
        for orderFile in orderFiles {
            if shouldStop() { return .stopped }

            switch readOrderState(orderFile) {
            case .absent:
                continue
            case .valid(let order):
                readableOrders.append((orderFile, order))
            case .malformed:
                // A confirmed pre-runId order is intentionally parked for the
                // foreground bridge's one-time generation upgrade. It is not
                // retryable by this runId-aware BG worker, so do not schedule a
                // perpetual five-minute wake loop while preserving it. Truly
                // malformed state remains indeterminate and retryable/fail-closed.
                let galleryId = orderFile.deletingPathExtension().lastPathComponent
                switch readNativeJSONDocument(orderFile) {
                case .valid(let document)
                    where isLegacyOrderDocument(document, galleryId: galleryId):
                    hasParkedLegacy = true
                    continue
                case .absent:
                    continue
                case .valid(_), .malformed, .unreadable(_):
                    hasRetryableState = true
                }
            case .unreadable(let error):
                NSLog("[DownloadBackgroundTask] order read failed: \(error.localizedDescription)")
                hasRetryableState = true
            }
        }

        readableOrders.sort { compareOrders($0, $1) }
        for item in readableOrders {
            if shouldStop() { return .stopped }
            let orderFile = item.file
            let order = item.order

            let outcome = processGallery(order, orderFile: orderFile, shouldStop: shouldStop)
            if shouldStop() { return .stopped }
            switch outcome {
            case .completed:
                if finishRunIfCurrent(order.run, at: orderFile, shouldStop: shouldStop) == .failed {
                    hasRetryableState = true
                }
            case .stale:
                continue
            case .partial:
                switch runs.orderOwnership(order.run, at: orderFile) {
                case .current:
                    writeProgressFailure(
                        order.run,
                        orderFile: orderFile,
                        shouldStop: shouldStop
                    )
                    hasRetryableState = true
                case .absent, .stale:
                    continue
                case .malformed, .unreadable(_):
                    hasRetryableState = true
                }
            case .stopped:
                // Expired mid-gallery: KEEP the work-order, report not-drained.
                return .stopped
            }
        }
        if hasRetryableState { return .retryable }
        return hasParkedLegacy ? .parkedOnly : .drained
    }

    private enum GalleryOutcome {
        case completed
        case stale
        case partial
        case stopped
    }

    private enum PublishResult: Equatable {
        case published
        case stale
        case failed
    }

    private enum CompletedCleanupResult: Equatable {
        case completed
        case stale
        case failed
    }

    private enum ManifestReadResult: Equatable {
        case committed(Int)
        case unreadable
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
        switch runs.orderOwnership(order.run, at: orderFile) {
        case .current:
            break
        case .absent, .stale:
            return .stale
        case .malformed, .unreadable(_):
            return .partial
        }
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

        let directoryResult = runs.withLock { () -> PublishResult in
            let permission = publishPermission(
                run: order.run,
                orderFile: orderFile,
                shouldStop: shouldStop
            )
            guard permission == .published else { return permission }
            do {
                try fileManager.createDirectory(at: galleryDir, withIntermediateDirectories: true)
                return .published
            } catch {
                return .failed
            }
        }
        if directoryResult == .stale { return .stale }
        if directoryResult == .failed {
            return .partial
        }

        // Only a valid manifest prefix proves that an existing destination was
        // fully committed. A non-zero file without that commit may be a torn
        // foreground write left by suspension/termination and must be replaced.
        var exts = pages.map { $0.ext }
        let committedCount: Int
        switch readCommittedManifest(galleryDir: galleryDir, pages: pages, exts: &exts) {
        case .committed(let count):
            committedCount = count
        case .unreadable:
            return .partial
        }

        for (i, page) in pages.enumerated() {
            if shouldStop() { return .stopped }
            switch runs.orderOwnership(order.run, at: orderFile) {
            case .current:
                break
            case .absent, .stale:
                return .stale
            case .malformed, .unreadable(_):
                return .partial
            }

            exts[i] = page.ext
            let dest = galleryDir.appendingPathComponent(
                pageFileName(index: page.index, ext: page.ext)
            )

            // Resume: a page already on disk is skipped (idempotent overlap with
            // the foreground downloader, which suspends while backgrounded).
            if i < committedCount && isNonEmptyFile(dest) {
                writeProgress(
                    order.run,
                    orderFile: orderFile,
                    current: i + 1,
                    total: pages.count,
                    shouldStop: shouldStop
                )
                continue
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
                guard isNonEmptyFile(temp) else {
                    try? fileManager.removeItem(at: temp)
                    return .partial
                }
                let pagePublish = publishPage(
                    run: order.run,
                    orderFile: orderFile,
                    temp: temp,
                    destination: dest,
                    shouldStop: shouldStop
                )
                if pagePublish == .stale {
                    try? fileManager.removeItem(at: temp)
                    return .stale
                }
                if pagePublish == .failed {
                    try? fileManager.removeItem(at: temp)
                    return .partial
                }
            } catch {
                // Page hard-failure (URL/gg expiry, network). Leave the gallery
                // partial; TS re-resolves / reconciles on next open.
                try? fileManager.removeItem(at: temp)
                return .partial
            }

            // Incremental manifest write (first i+1 exts) after each placed page.
            let manifest = writeManifest(
                run: order.run,
                orderFile: orderFile,
                galleryDir: galleryDir,
                exts: Array(exts.prefix(i + 1)),
                shouldStop: shouldStop
            )
            if manifest == .stale { return .stale }
            if manifest == .failed { return .partial }
            writeProgress(
                order.run,
                orderFile: orderFile,
                current: i + 1,
                total: pages.count,
                shouldStop: shouldStop
            )
        }

        // All pages present → write the final, full manifest once more (defensive).
        let finalManifest = writeManifest(
            run: order.run,
            orderFile: orderFile,
            galleryDir: galleryDir,
            exts: exts,
            shouldStop: shouldStop
        )
        if finalManifest == .stale { return .stale }
        if finalManifest == .failed { return .partial }
        writeProgress(
            order.run,
            orderFile: orderFile,
            current: pages.count,
            total: pages.count,
            shouldStop: shouldStop
        )
        return .completed
    }

    /// Publish one downloaded temp file only while this run still owns the order.
    private func publishPage(
        run: NativeDownloadRunIdentity,
        orderFile: URL,
        temp: URL,
        destination: URL,
        shouldStop: () -> Bool
    ) -> PublishResult {
        runs.withLock {
            let permission = publishPermission(
                run: run,
                orderFile: orderFile,
                shouldStop: shouldStop
            )
            guard permission == .published else { return permission }
            do {
                if fileManager.fileExists(atPath: destination.path) {
                    try fileManager.removeItem(at: destination)
                }
                try fileManager.moveItem(at: temp, to: destination)
                return .published
            } catch {
                return .failed
            }
        }
    }

    /// Convert a tri-state order read into a publication decision. An absent or
    /// replaced order revokes this run; malformed/unreadable state is ambiguous
    /// and therefore fails closed without publishing.
    private func publishPermission(
        run: NativeDownloadRunIdentity,
        orderFile: URL,
        shouldStop: () -> Bool
    ) -> PublishResult {
        if shouldStop() { return .stale }
        switch runs.orderOwnership(run, at: orderFile) {
        case .current:
            return .published
        case .absent, .stale:
            return .stale
        case .malformed, .unreadable(_):
            return .failed
        }
    }

    private func isNonEmptyFile(_ url: URL) -> Bool {
        guard fileManager.fileExists(atPath: url.path) else { return false }
        guard
            let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
            let size = values.fileSize
        else { return false }
        return size > 0
    }

    /// Treat the manifest as the page commit log. Only an exact, valid prefix
    /// of this order proves corresponding files safe to resume-skip.
    private func readCommittedManifest(
        galleryDir: URL,
        pages: [WorkPage],
        exts: inout [String]
    ) -> ManifestReadResult {
        let manifestURL = galleryDir.appendingPathComponent(Self.manifestFileName)
        switch readNativeFile(manifestURL) {
        case .absent, .malformed:
            return .committed(0)
        case .unreadable(let error):
            NSLog("[DownloadBackgroundTask] manifest read failed: \(error.localizedDescription)")
            return .unreadable
        case .valid(let data):
            guard
                let manifest = try? JSONSerialization.jsonObject(with: data) as? [Any],
                manifest.count <= pages.count
            else { return .committed(0) }

            for (index, rawExtension) in manifest.enumerated() {
                guard
                    let ext = rawExtension as? String,
                    NativeDownloadRequestPolicy.isValidExtension(ext),
                    ext == pages[index].ext
                else { return .committed(0) }
                exts[index] = ext
            }
            return .committed(manifest.count)
        }
    }

    /// Write `<galleryDir>/0000.json` as a JSON array of exts, e.g.
    /// `["webp","webp"]`. Matches `encodeManifest` in download-zip.ts
    /// (`JSON.stringify(exts)`) so `decodeManifest`/`getDownloadedGalleryPages`
    /// reads it unchanged. The identity check and atomic write share one lock, so
    /// run A can never overwrite run B's manifest after B is published.
    private func writeManifest(
        run: NativeDownloadRunIdentity,
        orderFile: URL,
        galleryDir: URL,
        exts: [String],
        shouldStop: () -> Bool
    ) -> PublishResult {
        let manifestURL = galleryDir.appendingPathComponent(Self.manifestFileName)
        return runs.withLock {
            let permission = publishPermission(
                run: run,
                orderFile: orderFile,
                shouldStop: shouldStop
            )
            guard permission == .published else { return permission }
            do {
                // JSONSerialization on a [String] produces a compact array identical to
                // JSON.stringify(string[]) — no pretty-printing, no extra whitespace.
                let data = try JSONSerialization.data(withJSONObject: exts, options: [])
                try data.write(to: manifestURL, options: .atomic)
                return .published
            } catch {
                NSLog("[DownloadBackgroundTask] manifest write failed: \(error.localizedDescription)")
                return .failed
            }
        }
    }

    private func progressFile(for run: NativeDownloadRunIdentity) -> URL {
        progressDir().appendingPathComponent("\(run.galleryId).json")
    }

    /// Best-effort generation-tagged progress publication. A replacement between
    /// pages makes this a no-op rather than allowing A to overwrite B's progress.
    private func writeProgress(
        _ run: NativeDownloadRunIdentity,
        orderFile: URL,
        current: Int?,
        total: Int? = nil,
        error: String? = nil,
        shouldStop: () -> Bool
    ) {
        runs.withLock {
            guard publishPermission(
                run: run,
                orderFile: orderFile,
                shouldStop: shouldStop
            ) == .published else { return }
            let currentValue: Any = current.map { $0 as Any } ?? NSNull()
            var payload: [String: Any] = [
                "runId": run.runId,
                "current": currentValue
            ]
            if let total { payload["total"] = total }
            if let error { payload["error"] = error }
            guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
            try? data.write(to: progressFile(for: run), options: .atomic)
        }
    }

    private func writeProgressFailure(
        _ run: NativeDownloadRunIdentity,
        orderFile: URL,
        shouldStop: () -> Bool
    ) {
        writeProgress(
            run,
            orderFile: orderFile,
            current: nil,
            error: "Background download failed",
            shouldStop: shouldStop
        )
    }

    /// Remove the matching progress sentinel and work order as one generation-
    /// locked completion boundary. Ambiguous state or cleanup errors are never
    /// reported as success.
    private func finishRunIfCurrent(
        _ run: NativeDownloadRunIdentity,
        at orderFile: URL,
        shouldStop: () -> Bool
    ) -> CompletedCleanupResult {
        runs.withLock {
            if shouldStop() { return .failed }
            switch runs.orderOwnership(run, at: orderFile) {
            case .absent, .stale:
                return .stale
            case .malformed, .unreadable(_):
                return .failed
            case .current:
                break
            }

            let progress = progressFile(for: run)
            switch NativeDownloadRunIdentity.progressFileState(at: progress) {
            case .absent:
                break
            case .valid(let progressRunId):
                guard progressRunId == run.runId else { return .failed }
                do {
                    try fileManager.removeItem(at: progress)
                } catch {
                    NSLog("[DownloadBackgroundTask] progress cleanup failed: \(error.localizedDescription)")
                    return .failed
                }
            case .malformed, .unreadable(_):
                return .failed
            }

            do {
                try fileManager.removeItem(at: orderFile)
                return .completed
            } catch {
                NSLog("[DownloadBackgroundTask] order cleanup failed: \(error.localizedDescription)")
                return .failed
            }
        }
    }

    // MARK: - Work-order parsing

    /// One page of a work-order after strict native-boundary validation.
    struct WorkPage {
        let index: Int
        let url: String
        let ext: String
        let headers: [String: String]
    }

    struct WorkOrder {
        let galleryId: Int
        let run: NativeDownloadRunIdentity
        let queuePosition: Double?
        let pages: [WorkPage]
    }

    /// Parse a work-order JSON file. Renderer-controlled URL, header, index,
    /// extension, and relative-path values are validated before native use.
    /// Shape (written by TS `writeWorkOrder`):
    ///   { "galleryId": 12345, "runId": "opaque-attempt-id",
    ///     "pages": [ { "index": 0, "url": "https://…",
    ///       "ext": "webp", "headers": { "Referer": … } }, … ] }
    func readOrderState(_ file: URL) -> NativeFileReadState<WorkOrder> {
        switch readNativeJSONDocument(file) {
        case .absent:
            return .absent
        case .malformed:
            return .malformed
        case .unreadable(let error):
            return .unreadable(error)
        case .valid(let document):
            guard let order = parseWorkOrder(
                document.root,
                expectedFileGalleryId: file.deletingPathExtension().lastPathComponent,
                legacyRun: nil
            ) else { return .malformed }
            return .valid(order)
        }
    }

    func validateWorkOrderPayload(
        _ data: Data,
        expectedRun: NativeDownloadRunIdentity
    ) -> Bool {
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let order = parseWorkOrder(
                root,
                expectedFileGalleryId: expectedRun.galleryId,
                legacyRun: nil
            )
        else { return false }
        return order.run == expectedRun
    }

    /// Authorize one upgrade path for a readable, same-gallery order from the
    /// pre-runId format. The requested replacement is validated separately.
    func isLegacyOrderDocument(_ document: NativeJSONDocument, galleryId: String) -> Bool {
        let root = document.root
        guard
            NativeDownloadRunIdentity.galleryId(from: root["galleryId"]) == galleryId,
            root["runId"] == nil || root["runId"] is NSNull,
            root["pages"] is [Any]
        else { return false }
        return true
    }

    func isLegacyProgressDocument(_ document: NativeJSONDocument) -> Bool {
        let root = document.root
        return (root["runId"] == nil || root["runId"] is NSNull) && root["current"] != nil
    }

    private enum QueuePositionParse {
        case valid(Double?)
        case invalid
    }

    private func parseWorkOrder(
        _ root: [String: Any],
        expectedFileGalleryId: String?,
        legacyRun: NativeDownloadRunIdentity?
    ) -> WorkOrder? {
        guard
            let galleryIdString = NativeDownloadRunIdentity.galleryId(from: root["galleryId"]),
            expectedFileGalleryId == nil || expectedFileGalleryId == galleryIdString,
            let galleryId = Int(galleryIdString),
            String(galleryId) == galleryIdString
        else { return nil }

        let run: NativeDownloadRunIdentity
        if let parsedRun = NativeDownloadRunIdentity.from(jsonObject: root) {
            guard legacyRun == nil else { return nil }
            run = parsedRun
        } else {
            guard
                let legacyRun,
                legacyRun.galleryId == galleryIdString,
                root["runId"] == nil || root["runId"] is NSNull
            else { return nil }
            run = legacyRun
        }

        let queuePosition: Double?
        switch parseQueuePosition(root["queuePosition"]) {
        case .valid(let value):
            queuePosition = value
        case .invalid:
            return nil
        }

        guard let rawPages = root["pages"] as? [[String: Any]] else { return nil }
        var pages: [WorkPage] = []
        pages.reserveCapacity(rawPages.count)
        for (expectedIndex, rawPage) in rawPages.enumerated() {
            guard
                exactPageIndex(rawPage["index"], expected: expectedIndex),
                let url = rawPage["url"] as? String,
                NativeDownloadRequestPolicy.isAllowedBypassURL(url),
                let ext = rawPage["ext"] as? String,
                NativeDownloadRequestPolicy.isValidExtension(ext),
                let relPath = rawPage["relPath"] as? String,
                relPath == NativeDownloadRequestPolicy.expectedRelPath(
                    galleryId: galleryIdString,
                    index: expectedIndex,
                    ext: ext
                ),
                let headers = NativeDownloadRequestPolicy.validateHeaders(rawPage["headers"])
            else { return nil }
            pages.append(WorkPage(index: expectedIndex, url: url, ext: ext, headers: headers))
        }

        return WorkOrder(
            galleryId: galleryId,
            run: run,
            queuePosition: queuePosition,
            pages: pages
        )
    }

    private func exactPageIndex(_ raw: Any?, expected: Int) -> Bool {
        guard
            let number = raw as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            number.doubleValue.isFinite,
            number.doubleValue == Double(expected),
            number.intValue == expected
        else { return false }
        return true
    }

    private func parseQueuePosition(_ raw: Any?) -> QueuePositionParse {
        if raw == nil || raw is NSNull { return .valid(nil) }
        guard
            let number = raw as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            number.doubleValue.isFinite
        else { return .invalid }
        return .valid(number.doubleValue)
    }

    private func compareOrders(
        _ lhs: (file: URL, order: WorkOrder),
        _ rhs: (file: URL, order: WorkOrder)
    ) -> Bool {
        switch (lhs.order.queuePosition, rhs.order.queuePosition) {
        case let (l?, r?) where l != r:
            return l < r
        case (.some, nil):
            return true
        case (nil, .some):
            return false
        default:
            return lhs.file.lastPathComponent < rhs.file.lastPathComponent
        }
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
