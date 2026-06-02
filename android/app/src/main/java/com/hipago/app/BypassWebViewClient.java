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
        if (request == null) {
            return super.shouldInterceptRequest(view, request);
        }
        String host = request.getUrl() != null ? request.getUrl().getHost() : null;
        if (host == null || !isBypassHost(host)) {
            return super.shouldInterceptRequest(view, request);
        }

        String method = request.getMethod();
        // Answer the CORS preflight locally. A fetch() to a bypass host is
        // cross-origin; an OPTIONS sent to the network would hit the ISP block
        // and fail the preflight (and thus the real GET). Older WebViews can
        // preflight the Range-based nozomi list reads.
        if ("OPTIONS".equalsIgnoreCase(method)) {
            return preflightResponse();
        }
        if (!"GET".equalsIgnoreCase(method)) {
            return super.shouldInterceptRequest(view, request);
        }

        Map<String, String> headers = buildUpstreamHeaders(request.getRequestHeaders());

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
            // Expose the range headers so cross-origin JS can read Content-Range:
            // nozomi pagination reads it for the total count. Without this the
            // header exists but is unreadable from fetch(), so total stays null.
            responseHeaders.put("Access-Control-Expose-Headers",
                    "Content-Range, Accept-Ranges, Content-Type");
            // Forward the upstream range headers so they are present to expose.
            // Content-Length is intentionally NOT forwarded: bypass-core may have
            // decompressed the body, so the upstream length can mismatch the
            // actual bytes; the response stream length is authoritative instead.
            for (Map.Entry<String, String> e : resp.getHeaders().entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                String k = e.getKey();
                if (k.equalsIgnoreCase("Content-Range")
                        || k.equalsIgnoreCase("Accept-Ranges")) {
                    responseHeaders.put(k, e.getValue());
                }
            }

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

    /**
     * Build the header map sent upstream through bypass-core for a GET.
     *
     * Strategy: forward the client's request headers as-is and overwrite only
     * the few that the bypass transport must own. This preserves request intent
     * the WebView set — most importantly {@code Range} (the search/index pipeline
     * issues byte-range reads for every B-tree galleries-index node and data
     * segment, and for nozomi pagination), plus conditional headers like
     * {@code If-Range} and the {@code Accept} negotiation. Dropping {@code Range}
     * was the original bug: bypass-core forwards headers verbatim, so a missing
     * Range made upstream return the full file (HTTP 200) from offset 0; the root
     * B-tree node lives at offset 0 so it decoded, but any non-zero-offset
     * sub-node fetch then re-decoded the root instead of the requested node, so
     * untyped/title search ("스프레이") found nothing while tag/nozomi browsing
     * (read from offset 0) kept working.
     *
     * Overwritten / dropped (case-insensitive, since WebView casing varies):
     *  - {@code Referer}/{@code Origin}: replaced with the spoofed hitomi values
     *    so the WebView's own cross-origin values can't leak through.
     *  - {@code Accept-Encoding}: dropped so bypass-core (rquest Chrome
     *    impersonation) owns content negotiation and transparently decompresses.
     *    Forwarding the WebView's Accept-Encoding would suppress that gunzip and
     *    hand back a compressed body, corrupting the binary index reads this code
     *    path depends on.
     *
     * Package-private + static with no Android dependencies so it is unit
     * testable on the local JVM without Robolectric.
     */
    static Map<String, String> buildUpstreamHeaders(Map<String, String> requestHeaders) {
        Map<String, String> headers = new HashMap<>();

        if (requestHeaders != null) {
            for (Map.Entry<String, String> e : requestHeaders.entrySet()) {
                String k = e.getKey();
                if (k == null || e.getValue() == null) continue;
                // Identity headers are set canonically below; let the bypass
                // transport own content-encoding/decompression.
                if (k.equalsIgnoreCase("Referer")
                        || k.equalsIgnoreCase("Origin")
                        || k.equalsIgnoreCase("Accept-Encoding")) {
                    continue;
                }
                headers.put(k, e.getValue());
            }
        }

        headers.put("Referer", "https://hitomi.la/");
        headers.put("Origin", "https://hitomi.la");
        return headers;
    }

    private static boolean isBypassHost(String host) {
        return host.endsWith(".gold-usergeneratedcontent.net")
                || host.equals("hitomi.la")
                || host.endsWith(".hitomi.la");
    }

    /** Answer a CORS preflight for a bypass host without touching the network. */
    private static WebResourceResponse preflightResponse() {
        Map<String, String> h = new HashMap<>();
        h.put("Access-Control-Allow-Origin", "*");
        h.put("Access-Control-Allow-Methods", "GET, OPTIONS");
        h.put("Access-Control-Allow-Headers", "range, Range, Content-Type");
        h.put("Access-Control-Max-Age", "86400");
        WebResourceResponse out = new WebResourceResponse(
                "text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        out.setStatusCodeAndReasonPhrase(200, "OK");
        out.setResponseHeaders(h);
        return out;
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
