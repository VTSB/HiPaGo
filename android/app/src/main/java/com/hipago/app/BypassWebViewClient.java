package com.hipago.app;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

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
     * Strategy: synthesize a stable browser-like request shape for bypass-core,
     * then copy the WebView request headers except transport/privacy headers the
     * native bypass transport must own. The list/search pipeline issues
     * byte-range reads for nozomi pagination and B-tree index nodes. Dropping
     * {@code Range} or related conditional headers makes upstream return the
     * wrong bytes, so Android must mirror the web proxy's forward-most contract.
     *
     * Package-private + static with no Android dependencies so it is unit
     * testable on the local JVM without Robolectric.
     */
    static Map<String, String> buildUpstreamHeaders(Map<String, String> requestHeaders) {
        Map<String, String> headers = new HashMap<>();
        putHeader(headers, "User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
        putHeader(headers, "Accept", "*/*");
        putHeader(headers, "Accept-Language", "en-US,en;q=0.9");
        putHeader(headers, "Sec-Fetch-Site", "cross-site");
        putHeader(headers, "Sec-Fetch-Mode", "cors");
        putHeader(headers, "Sec-Fetch-Dest", "empty");

        if (requestHeaders != null) {
            for (Map.Entry<String, String> e : requestHeaders.entrySet()) {
                String k = e.getKey();
                if (k == null || e.getValue() == null) continue;
                if (shouldDropRequestHeader(k)) continue;
                putHeader(headers, canonicalHeaderName(k), e.getValue());
            }
        }
        putHeader(headers, "Referer", "https://hitomi.la/");
        putHeader(headers, "Origin", "https://hitomi.la");
        return headers;
    }

    private static final Set<String> DENIED_REQUEST_HEADERS = new HashSet<>(Arrays.asList(
            "referer",
            "origin",
            "accept-encoding",
            "cookie",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-real-ip",
            "forwarded",
            "host",
            "connection",
            "keep-alive",
            "proxy-connection",
            "transfer-encoding",
            "te",
            "upgrade",
            "content-length"
    ));

    private static boolean shouldDropRequestHeader(String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        return DENIED_REQUEST_HEADERS.contains(lower)
                || lower.startsWith("x-middleware-")
                || lower.startsWith("x-invoke-")
                || lower.startsWith("x-nextjs-");
    }

    private static String canonicalHeaderName(String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        switch (lower) {
            case "range": return "Range";
            case "if-range": return "If-Range";
            case "if-none-match": return "If-None-Match";
            case "if-modified-since": return "If-Modified-Since";
            case "accept": return "Accept";
            case "accept-language": return "Accept-Language";
            case "user-agent": return "User-Agent";
            case "content-type": return "Content-Type";
            case "sec-fetch-site": return "Sec-Fetch-Site";
            case "sec-fetch-mode": return "Sec-Fetch-Mode";
            case "sec-fetch-dest": return "Sec-Fetch-Dest";
            default: return key;
        }
    }

    private static void putHeader(Map<String, String> headers, String key, String value) {
        String existing = null;
        for (String k : headers.keySet()) {
            if (k.equalsIgnoreCase(key)) {
                existing = k;
                break;
            }
        }
        if (existing != null) {
            headers.remove(existing);
        }
        headers.put(key, value);
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
