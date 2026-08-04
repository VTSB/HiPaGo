import Foundation
import Capacitor
import BackgroundTasks
import CoreFoundation

/// Capacitor bridge for the iOS background-download backstop. The public
/// contract intentionally matches Android's `DownloadWorker` plugin, including
/// the opaque runId that distinguishes replacement attempts for one gallery.
@objc(DownloadWorkerPlugin)
public class DownloadWorkerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DownloadWorkerPlugin"
    public let jsName = "DownloadWorker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "writeWorkOrder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentRun", returnType: CAPPluginReturnPromise)
    ]

    private let fileManager = FileManager.default
    private let runs = NativeDownloadRunCoordinator.shared

    private enum WorkOrderPublication {
        case publish
        case idempotent
        case legacyReplace
        case stale
        case unknown
    }

    private enum EnqueueResult {
        case scheduled
        case stale
        case unknown
        case schedulingFailed
    }

    private enum ProgressIdentityState {
        case absent
        case current(String)
        case legacy
        case malformed
        case unreadable(NSError)
    }

    private struct CurrentRunResolution {
        let runId: String?
        let conflict: Bool
        let unknown: Bool
        let legacy: Bool

        static func current(_ runId: String?) -> CurrentRunResolution {
            CurrentRunResolution(runId: runId, conflict: false, unknown: false, legacy: false)
        }

        static let legacyState = CurrentRunResolution(
            runId: nil,
            conflict: false,
            unknown: false,
            legacy: true
        )

        static let conflictState = CurrentRunResolution(
            runId: nil,
            conflict: true,
            unknown: false,
            legacy: false
        )
        static let unknownState = CurrentRunResolution(
            runId: nil,
            conflict: false,
            unknown: true,
            legacy: false
        )
    }

    private func handoffDir() -> URL {
        DownloadBackgroundTask.shared.handoffDir()
    }

    private func progressDir() -> URL {
        DownloadBackgroundTask.shared.progressDir()
    }

    private func orderFile(galleryId: String) -> URL {
        handoffDir().appendingPathComponent("\(galleryId).json")
    }

    private func progressFile(galleryId: String) -> URL {
        progressDir().appendingPathComponent("\(galleryId).json")
    }

    /// Atomically publish an order only when the gallery pathname is absent.
    /// Repeating the exact same bytes is an idempotent no-op; any existing
    /// mismatch is stale. The shared lock linearizes this compare-and-set with
    /// background page, manifest, progress, and cleanup boundaries.
    @objc func writeWorkOrder(_ call: CAPPluginCall) {
        guard
            let galleryId = call.getString("galleryId"),
            NativeDownloadRunIdentity.isValidGalleryId(galleryId)
        else {
            call.reject("galleryId must be numeric")
            return
        }
        guard
            let runId = call.getString("runId"),
            NativeDownloadRunIdentity.isValidRunId(runId)
        else {
            call.reject("runId is invalid")
            return
        }
        guard let json = call.getString("json"), let data = json.data(using: .utf8) else {
            call.reject("json is required")
            return
        }
        guard let requestedRun = NativeDownloadRunIdentity(galleryId: galleryId, runId: runId) else {
            call.reject("work-order identity does not match request")
            return
        }
        guard DownloadBackgroundTask.shared.validateWorkOrderPayload(
            data,
            expectedRun: requestedRun
        ) else {
            call.reject("work-order payload is invalid or does not match request")
            return
        }

        do {
            let publication = try runs.withLock { () throws -> WorkOrderPublication in
                let order = orderFile(galleryId: galleryId)
                let progress = progressFile(galleryId: galleryId)
                let classification: WorkOrderPublication

                switch readNativeJSONDocument(order) {
                case .absent:
                    classification = .publish
                case .malformed, .unreadable(_):
                    classification = .unknown
                case .valid(let existing):
                    if let current = NativeDownloadRunIdentity.from(jsonObject: existing.root) {
                        if current != requestedRun {
                            classification = .stale
                        } else if !DownloadBackgroundTask.shared.validateWorkOrderPayload(
                            existing.data,
                            expectedRun: current
                        ) {
                            classification = .unknown
                        } else {
                            classification = existing.data == data ? .idempotent : .stale
                        }
                    } else if DownloadBackgroundTask.shared.isLegacyOrderDocument(
                        existing,
                        galleryId: galleryId
                    ) {
                        switch progressIdentityState(at: progress) {
                        case .absent, .legacy:
                            classification = .legacyReplace
                        case .current(_):
                            classification = .stale
                        case .malformed, .unreadable(_):
                            classification = .unknown
                        }
                    } else {
                        classification = .unknown
                    }
                }

                switch classification {
                case .idempotent, .stale, .unknown:
                    return classification
                case .publish:
                    try removeReadableProgressForNewRun(at: progress)
                case .legacyReplace:
                    try removeConfirmedLegacyProgress(at: progress)
                }
                try data.write(to: order, options: .atomic)
                return classification
            }

            switch publication {
            case .publish, .idempotent, .legacyReplace:
                call.resolve()
            case .stale:
                call.reject("stale runId")
            case .unknown:
                call.reject("existing native download state is unreadable or malformed")
            }
        } catch {
            call.reject("writeWorkOrder error: \(error.localizedDescription)")
        }
    }

    /// Schedule only if the requested run still owns the order pathname.
    @objc func enqueue(_ call: CAPPluginCall) {
        guard let requested = requestedRun(call) else { return }
        let result = runs.withLock { () -> EnqueueResult in
            switch DownloadBackgroundTask.shared.readOrderState(
                orderFile(galleryId: requested.galleryId)
            ) {
            case .absent:
                return .stale
            case .malformed, .unreadable(_):
                return .unknown
            case .valid(let order):
                guard order.run == requested else { return .stale }
                return DownloadBackgroundTask.shared.scheduleProcessingTask(
                    recordingPluginEnqueue: true
                ) ? .scheduled : .schedulingFailed
            }
        }

        switch result {
        case .scheduled:
            call.resolve()
        case .stale:
            call.reject("stale runId")
        case .unknown:
            call.reject("native work-order is unreadable or malformed")
        case .schedulingFailed:
            call.reject("background task scheduling failed")
        }
    }

    /// Cancel exactly one concrete attempt. A late cancellation for A is a strict
    /// no-op once the same pathname belongs to B.
    @objc func cancel(_ call: CAPPluginCall) {
        guard let requested = requestedRun(call) else { return }
        do {
            let result = try runs.withLock { () throws -> [String: Any] in
                let order = orderFile(galleryId: requested.galleryId)
                let progress = progressFile(galleryId: requested.galleryId)
                var cancelled = false
                var stale = false

                switch DownloadBackgroundTask.shared.readOrderState(order) {
                case .valid(let currentOrder) where currentOrder.run == requested:
                    switch progressIdentityState(at: progress) {
                    case .absent:
                        break
                    case .current(let progressRunId):
                        guard progressRunId == requested.runId else {
                            throw pluginStateError("order/progress runId conflict")
                        }
                        try fileManager.removeItem(at: progress)
                    case .legacy, .malformed, .unreadable(_):
                        throw pluginStateError("progress state is unreadable or malformed")
                    }
                    switch readNativeFile(order) {
                    case .valid(_):
                        try fileManager.removeItem(at: order)
                    case .absent:
                        break
                    case .malformed, .unreadable(_):
                        throw pluginStateError("work-order became unreadable during cancellation")
                    }
                    cancelled = true
                case .valid(_):
                    stale = true
                case .absent:
                    switch progressIdentityState(at: progress) {
                    case .absent, .legacy:
                        break
                    case .current(let progressRunId):
                        if progressRunId == requested.runId {
                            try fileManager.removeItem(at: progress)
                            cancelled = true
                        } else {
                            stale = true
                        }
                    case .malformed, .unreadable(_):
                        throw pluginStateError("progress state is unreadable or malformed")
                    }
                case .malformed, .unreadable(_):
                    throw pluginStateError("work-order state is unreadable or malformed")
                }

                let remaining = try pendingOrderCount()
                if cancelled && remaining == 0 {
                    DownloadBackgroundTask.shared.cancelPendingTask()
                }
                return [
                    "runId": requested.runId,
                    "cancelled": cancelled,
                    "stale": stale,
                    "remaining": remaining
                ]
            }
            call.resolve(result)
        } catch {
            call.reject("cancel error: \(error.localizedDescription)")
        }
    }

    /// Return progress only when the requested run still owns the order path and
    /// any progress file carries the same runId.
    @objc func getProgress(_ call: CAPPluginCall) {
        guard let requested = requestedRun(call) else { return }
        let result = runs.withLock {
            progressPayload(for: requested)
        }
        call.resolve(result)
    }

    /// Read-only identity discovery for WebView/app restart recovery. An order
    /// alone is authoritative, and progress alone is accepted for a consumed or
    /// terminal native run. If both files exist, their runIds must agree.
    @objc func getCurrentRun(_ call: CAPPluginCall) {
        guard
            let galleryId = call.getString("galleryId"),
            NativeDownloadRunIdentity.isValidGalleryId(galleryId)
        else {
            call.reject("galleryId must be numeric")
            return
        }
        let resolution = runs.withLock {
            resolveCurrentRun(galleryId: galleryId)
        }
        let resolvedRunId: Any = resolution.runId.map { $0 as Any } ?? NSNull()
        var payload: [String: Any] = ["runId": resolvedRunId]
        if resolution.conflict { payload["conflict"] = true }
        if resolution.unknown { payload["unknown"] = true }
        if resolution.legacy { payload["legacy"] = true }
        call.resolve(payload)
    }

    private func requestedRun(_ call: CAPPluginCall) -> NativeDownloadRunIdentity? {
        guard
            let galleryId = call.getString("galleryId"),
            NativeDownloadRunIdentity.isValidGalleryId(galleryId)
        else {
            call.reject("galleryId must be numeric")
            return nil
        }
        guard
            let runId = call.getString("runId"),
            NativeDownloadRunIdentity.isValidRunId(runId),
            let run = NativeDownloadRunIdentity(galleryId: galleryId, runId: runId)
        else {
            call.reject("runId is invalid")
            return nil
        }
        return run
    }

    private func pluginStateError(_ message: String) -> NSError {
        NSError(
            domain: "DownloadWorkerPlugin",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private func progressIdentityState(at file: URL) -> ProgressIdentityState {
        switch readNativeJSONDocument(file) {
        case .absent:
            return .absent
        case .malformed:
            return .malformed
        case .unreadable(let error):
            return .unreadable(error)
        case .valid(let document):
            if
                let runId = document.root["runId"] as? String,
                NativeDownloadRunIdentity.isValidRunId(runId)
            {
                return .current(runId)
            }
            return DownloadBackgroundTask.shared.isLegacyProgressDocument(document)
                ? .legacy
                : .malformed
        }
    }

    private func removeReadableProgressForNewRun(at file: URL) throws {
        switch readNativeFile(file) {
        case .absent:
            return
        case .valid(_):
            try fileManager.removeItem(at: file)
        case .malformed:
            throw pluginStateError("prior progress state is malformed")
        case .unreadable(let error):
            throw error
        }
    }

    private func removeConfirmedLegacyProgress(at file: URL) throws {
        switch progressIdentityState(at: file) {
        case .absent:
            return
        case .legacy:
            try fileManager.removeItem(at: file)
        case .current(_):
            throw pluginStateError("prior progress belongs to a current run")
        case .malformed:
            throw pluginStateError("prior progress is not confirmed legacy state")
        case .unreadable(let error):
            throw error
        }
    }

    private func pendingOrderCount() throws -> Int {
        switch DownloadBackgroundTask.shared.pendingOrderFilesState() {
        case .absent:
            return 0
        case .valid(let entries):
            return entries.count
        case .unreadable(let error):
            throw error
        }
    }

    private func resolveCurrentRun(galleryId: String) -> CurrentRunResolution {
        let order = orderFile(galleryId: galleryId)
        let progress = progressFile(galleryId: galleryId)
        let progressState = progressIdentityState(at: progress)

        switch readNativeJSONDocument(order) {
        case .absent:
            switch progressState {
            case .absent:
                return .current(nil)
            case .legacy:
                return .legacyState
            case .current(let runId):
                return .current(runId)
            case .malformed, .unreadable(_):
                return .unknownState
            }
        case .malformed, .unreadable(_):
            return .unknownState
        case .valid(let document):
            if let orderRun = NativeDownloadRunIdentity.from(jsonObject: document.root) {
                guard DownloadBackgroundTask.shared.validateWorkOrderPayload(
                    document.data,
                    expectedRun: orderRun
                ) else { return .unknownState }
                guard orderRun.galleryId == galleryId else { return .conflictState }

                switch progressState {
                case .absent:
                    return .current(orderRun.runId)
                case .current(let progressRunId):
                    return progressRunId == orderRun.runId
                        ? .current(orderRun.runId)
                        : .conflictState
                case .legacy, .malformed, .unreadable(_):
                    return .unknownState
                }
            }

            if DownloadBackgroundTask.shared.isLegacyOrderDocument(
                document,
                galleryId: galleryId
            ) {
                switch progressState {
                case .absent, .legacy:
                    // The BG drain refuses legacy orders. Reporting no current
                    // identity with an explicit legacy marker lets restart
                    // recovery publish one upgraded run without treating this
                    // pending order as ordinary absence.
                    return .legacyState
                case .current(_):
                    return .conflictState
                case .malformed, .unreadable(_):
                    return .unknownState
                }
            }

            if let otherGallery = NativeDownloadRunIdentity.galleryId(
                from: document.root["galleryId"]
            ), otherGallery != galleryId {
                return .conflictState
            }
            return .unknownState
        }
    }

    private func progressPayload(for requested: NativeDownloadRunIdentity) -> [String: Any] {
        let order = orderFile(galleryId: requested.galleryId)
        switch DownloadBackgroundTask.shared.readOrderState(order) {
        case .absent:
            break
        case .valid(let current) where current.run == requested:
            break
        case .valid(let current):
            return [
                "runId": current.run.runId,
                "current": NSNull(),
                "stale": true
            ]
        case .malformed, .unreadable(_):
            return [
                "runId": requested.runId,
                "current": NSNull(),
                "unknown": true
            ]
        }

        let progress = progressFile(galleryId: requested.galleryId)
        let document: NativeJSONDocument
        switch readNativeJSONDocument(progress) {
        case .absent:
            return ["runId": requested.runId, "current": NSNull()]
        case .malformed, .unreadable(_):
            return [
                "runId": requested.runId,
                "current": NSNull(),
                "unknown": true
            ]
        case .valid(let value):
            document = value
        }
        let root = document.root
        guard
            let actualRunId = root["runId"] as? String,
            NativeDownloadRunIdentity.isValidRunId(actualRunId)
        else {
            return ["runId": requested.runId, "current": NSNull(), "unknown": true]
        }
        guard actualRunId == requested.runId else {
            return ["runId": actualRunId, "current": NSNull(), "stale": true]
        }
        if let rawError = root["error"] {
            guard let error = rawError as? String else {
                return ["runId": actualRunId, "current": NSNull(), "unknown": true]
            }
            return ["runId": actualRunId, "current": NSNull(), "error": error]
        }
        guard
            let current = root["current"] as? NSNumber,
            let total = root["total"] as? NSNumber,
            CFGetTypeID(current) != CFBooleanGetTypeID(),
            CFGetTypeID(total) != CFBooleanGetTypeID()
        else {
            return ["runId": actualRunId, "current": NSNull(), "unknown": true]
        }
        return ["runId": actualRunId, "current": current, "total": total]
    }
}
