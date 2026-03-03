import Capacitor
import bypass

/// Capacitor plugin for ISP bypass on iOS.
/// Wraps the Rust bypass-core library via UniFFI Swift bindings.
@objc(BypassPlugin)
public class BypassPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BypassPlugin"
    public let jsName = "Bypass"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "fetch", returnType: CAPPluginReturnPromise)
    ]

    @objc func fetch(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), !url.isEmpty else {
            call.reject("URL is required")
            return
        }

        // Parse optional headers
        var headers: [String: String]? = nil
        if let headersObj = call.getObject("headers") {
            headers = [:]
            for (key, value) in headersObj {
                if let strValue = value as? String {
                    headers?[key] = strValue
                }
            }
        }

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
}
