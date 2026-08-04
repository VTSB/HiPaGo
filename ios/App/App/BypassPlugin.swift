import Capacitor

/// Capacitor plugin for ISP bypass on iOS.
/// Wraps the Rust bypass-core library via UniFFI Swift bindings.
@objc(BypassPlugin)
public class BypassPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BypassPlugin"
    public let jsName = "Bypass"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fetch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadToFile", returnType: CAPPluginReturnPromise)
    ]

    @objc func fetch(_ call: CAPPluginCall) {
        guard
            let url = call.getString("url"),
            NativeDownloadRequestPolicy.isAllowedBypassURL(url),
            let validatedHeaders = NativeDownloadRequestPolicy.validateHeaders(
                call.getObject("headers")
            )
        else {
            call.reject("Invalid bypass request")
            return
        }
        let headers = validatedHeaders.isEmpty ? nil : validatedHeaders

        // Run on background queue
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let resp = try bypassFetch(url: url, headers: headers)

                var result: [String: Any] = [:]
                result["status"] = resp.status
                result["headers"] = resp.headers
                result["body"] = resp.body.map { Int($0) }

                call.resolve(result as PluginCallResultData)
            } catch {
                call.reject("Bypass fetch failed: \(error.localizedDescription)")
            }
        }
    }

    /// Stream a URL's body straight to a canonical direct child of the app's
    /// image-cache directory (one chunk at a time in native code — the image never
    /// enters the JS heap). The JS adapter serves it via Capacitor.convertFileSrc.
    /// Resolves { size } = total bytes written.
    @objc func downloadToFile(_ call: CAPPluginCall) {
        guard
            let url = call.getString("url"),
            NativeDownloadRequestPolicy.isAllowedBypassURL(url),
            let path = call.getString("path"),
            let destination = NativeDownloadRequestPolicy.resolveImageCacheDestination(path),
            let validatedHeaders = NativeDownloadRequestPolicy.validateHeaders(
                call.getObject("headers")
            )
        else {
            call.reject("Invalid bypass download request")
            return
        }
        let headers = validatedHeaders.isEmpty ? nil : validatedHeaders
        let destinationPath = destination.path

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let size = try bypassDownloadToFile(
                    url: url,
                    headers: headers,
                    destPath: destinationPath
                )
                call.resolve(["size": size])
            } catch {
                call.reject("Bypass download failed: \(error.localizedDescription)")
            }
        }
    }
}
