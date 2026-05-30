package com.hipago.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Map;

import uniffi.bypass.BypassKt;
import uniffi.bypass.BypassResponse;

/**
 * Routes hitomi/CDN requests through bypass-core so the WebView loads them as
 * ordinary {@code <img>} / {@code fetch()} resources. This is the native
 * equivalent of the web build's {@code /api/img} proxy: on native, url-resolver.ts
 * already addresses real {@code https://…} hitomi/CDN URLs, and this interceptor
 * transparently fetches them through the Rust bypass pipeline (DoH + TLS
 * fragmentation). Everything else — including Capacitor's own local app assets —
 * falls through to {@link BridgeWebViewClient}.
 *
 * Calling {@code bypass_fetch} directly in Kotlin is the whole point: it removes
 * the old JS-plugin path that serialized image bytes as a per-byte JSON array
 * across the Capacitor bridge.
 */
public class BypassWebViewClient extends BridgeWebViewClient {

    public BypassWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request == null || !"GET".equalsIgnoreCase(request.getMethod())) {
            return super.shouldInterceptRequest(view, request);
        }
        String host = request.getUrl() != null ? request.getUrl().getHost() : null;
        if (host == null || !isBypassHost(host)) {
            return super.shouldInterceptRequest(view, request);
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", "https://hitomi.la/");
        headers.put("Origin", "https://hitomi.la");

        try {
            BypassResponse resp = BypassKt.bypassFetch(request.getUrl().toString(), headers);

            String mime = "application/octet-stream";
            for (Map.Entry<String, String> e : resp.getHeaders().entrySet()) {
                if ("content-type".equalsIgnoreCase(e.getKey()) && e.getValue() != null) {
                    mime = e.getValue().split(";")[0].trim();
                    break;
                }
            }

            Map<String, String> responseHeaders = new HashMap<>();
            // Cross-origin fetch() reads need CORS; <img> does not, but it is harmless.
            responseHeaders.put("Access-Control-Allow-Origin", "*");

            int status = resp.getStatus() >= 100 ? resp.getStatus() : 200;
            WebResourceResponse out = new WebResourceResponse(
                    mime, null, new ByteArrayInputStream(resp.getBody()));
            out.setStatusCodeAndReasonPhrase(status, reasonPhrase(status));
            out.setResponseHeaders(responseHeaders);
            return out;
        } catch (Exception e) {
            // Let the default loader handle it (it will fail ISP-blocked) so the
            // <img>/fetch surfaces a concrete error instead of this throwing.
            return super.shouldInterceptRequest(view, request);
        }
    }

    private static boolean isBypassHost(String host) {
        return host.endsWith(".gold-usergeneratedcontent.net")
                || host.equals("hitomi.la")
                || host.endsWith(".hitomi.la");
    }

    /** WebResourceResponse rejects a null/empty reason phrase on some API levels. */
    private static String reasonPhrase(int status) {
        switch (status) {
            case 200: return "OK";
            case 206: return "Partial Content";
            case 301: return "Moved Permanently";
            case 302: return "Found";
            case 304: return "Not Modified";
            case 404: return "Not Found";
            case 429: return "Too Many Requests";
            case 503: return "Service Unavailable";
            default:  return status < 400 ? "OK" : "Error";
        }
    }
}
