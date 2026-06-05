package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

/**
 * Local JVM unit tests for {@link BypassWebViewClient#buildUpstreamHeaders}.
 *
 * Contract: synthesize stable browser-like headers, copy only the caller's
 * {@code Range} header, and spoof {@code Referer}/{@code Origin}. Regression
 * guard for Android list/search pagination: dropping {@code Range} makes later
 * pages and non-root B-tree index reads decode bytes from offset 0.
 * WebView-only/request-context headers are intentionally dropped so they do not
 * leak through the native bypass transport.
 */
public class BypassWebViewClientTest {

    @Test
    public void alwaysSpoofsRefererAndOrigin() {
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(null);
        assertEquals("https://hitomi.la/", out.get("Referer"));
        assertEquals("https://hitomi.la", out.get("Origin"));
        assertFalse(out.containsKey("Range"));
    }

    @Test
    public void synthesizesBrowserLikeDefaults() {
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(null);
        assertEquals("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", out.get("User-Agent"));
        assertEquals("*/*", out.get("Accept"));
        assertEquals("en-US,en;q=0.9", out.get("Accept-Language"));
        assertEquals("cross-site", out.get("Sec-Fetch-Site"));
        assertEquals("cors", out.get("Sec-Fetch-Mode"));
        assertEquals("empty", out.get("Sec-Fetch-Dest"));
    }

    @Test
    public void forwardsRangeHeaderVerbatim() {
        Map<String, String> req = new HashMap<>();
        req.put("Range", "bytes=12345-12808");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=12345-12808", out.get("Range"));
        // Referer/Origin must survive alongside the forwarded Range.
        assertEquals("https://hitomi.la/", out.get("Referer"));
        assertEquals("https://hitomi.la", out.get("Origin"));
    }

    @Test
    public void forwardsRangeRegardlessOfHeaderNameCasing() {
        Map<String, String> req = new HashMap<>();
        req.put("range", "bytes=0-463"); // WebView may report a lowercased name
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=0-463", out.get("Range"));
        assertFalse(out.containsKey("range"));
    }

    @Test
    public void noRangeKeyWhenRequestHasNoRange() {
        Map<String, String> req = new HashMap<>();
        req.put("Accept", "*/*");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertFalse(out.containsKey("Range"));
        assertNull(out.get("Range"));
    }

    @Test
    public void dropsWebViewClientHeadersExceptRange() {
        Map<String, String> req = new HashMap<>();
        req.put("Range", "bytes=100-200");
        req.put("If-Range", "\"etag-xyz\"");
        req.put("Accept", "image/avif,image/webp,*/*");
        req.put("Sec-Fetch-Mode", "no-cors");
        req.put("Sec-Fetch-Dest", "image");
        req.put("X-Requested-With", "com.hipago.app");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=100-200", out.get("Range"));
        assertFalse(out.containsKey("If-Range"));
        assertFalse(out.containsKey("X-Requested-With"));
        // Browser-like defaults are synthesized; WebView-provided variants do
        // not override them.
        assertEquals("*/*", out.get("Accept"));
        assertEquals("cors", out.get("Sec-Fetch-Mode"));
        assertEquals("empty", out.get("Sec-Fetch-Dest"));
    }

    @Test
    public void spoofedRefererOriginOverrideClientValues() {
        Map<String, String> req = new HashMap<>();
        req.put("Origin", "http://localhost");
        req.put("Referer", "http://localhost/search");
        req.put("Range", "bytes=1-2");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("https://hitomi.la/", out.get("Referer"));
        assertEquals("https://hitomi.la", out.get("Origin"));
        assertEquals("bytes=1-2", out.get("Range"));
        // No leftover lowercase/localhost identity values leaked through.
        assertFalse(out.containsValue("http://localhost"));
        assertFalse(out.containsValue("http://localhost/search"));
    }

    @Test
    public void dropsAcceptEncoding() {
        Map<String, String> req = new HashMap<>();
        req.put("Accept-Encoding", "gzip, deflate, br");
        req.put("Range", "bytes=0-9");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertFalse(out.containsKey("Accept-Encoding"));
        assertEquals("bytes=0-9", out.get("Range"));
    }

    @Test
    public void dropsAcceptEncodingCaseInsensitively() {
        Map<String, String> req = new HashMap<>();
        req.put("accept-encoding", "gzip");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertFalse(out.containsKey("accept-encoding"));
        assertFalse(out.containsKey("Accept-Encoding"));
    }

    @Test
    public void skipsNullKeysAndValues() {
        Map<String, String> req = new HashMap<>();
        req.put(null, "bytes=1-2");
        req.put("Range", null);
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertFalse(out.containsKey("Range"));
        // Browser-like defaults plus the two canonical identity headers remain.
        assertTrue(out.containsKey("Referer"));
        assertTrue(out.containsKey("Origin"));
        assertTrue(out.containsKey("User-Agent"));
        assertTrue(out.containsKey("Accept"));
    }
}
