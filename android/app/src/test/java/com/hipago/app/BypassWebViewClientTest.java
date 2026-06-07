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
 * Contract: synthesize stable browser-like headers, forward safe WebView
 * request headers, and spoof {@code Referer}/{@code Origin}. Regression guard
 * for Android list/search pagination: dropping byte-range headers makes later
 * pages and non-root B-tree index reads decode bytes from offset 0.
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
    public void forwardsSafeWebViewClientHeaders() {
        Map<String, String> req = new HashMap<>();
        req.put("Range", "bytes=100-200");
        req.put("If-Range", "\"etag-xyz\"");
        req.put("Accept", "image/avif,image/webp,*/*");
        req.put("Sec-Fetch-Mode", "no-cors");
        req.put("Sec-Fetch-Dest", "image");
        req.put("X-Client-Trace", "abc123");
        req.put("X-Requested-With", "com.hipago.app");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=100-200", out.get("Range"));
        assertEquals("\"etag-xyz\"", out.get("If-Range"));
        assertEquals("image/avif,image/webp,*/*", out.get("Accept"));
        assertEquals("no-cors", out.get("Sec-Fetch-Mode"));
        assertEquals("image", out.get("Sec-Fetch-Dest"));
        assertEquals("abc123", out.get("X-Client-Trace"));
        assertEquals("com.hipago.app", out.get("X-Requested-With"));
    }

    @Test
    public void forwardsRangeRelatedHeadersRegardlessOfHeaderNameCasing() {
        Map<String, String> req = new HashMap<>();
        req.put("range", "bytes=2048-4095");
        req.put("if-range", "\"etag-lower\"");
        req.put("if-none-match", "\"etag-next\"");
        req.put("if-modified-since", "Sun, 07 Jun 2026 00:00:00 GMT");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=2048-4095", out.get("Range"));
        assertEquals("\"etag-lower\"", out.get("If-Range"));
        assertEquals("\"etag-next\"", out.get("If-None-Match"));
        assertEquals("Sun, 07 Jun 2026 00:00:00 GMT", out.get("If-Modified-Since"));
        assertFalse(out.containsKey("range"));
        assertFalse(out.containsKey("if-range"));
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
    public void dropsUnsafeHeadersCaseInsensitively() {
        Map<String, String> req = new HashMap<>();
        req.put("Cookie", "session=secret");
        req.put("host", "localhost");
        req.put("Content-Length", "123");
        req.put("Connection", "keep-alive");
        req.put("TE", "trailers");
        req.put("x-forwarded-for", "127.0.0.1");
        req.put("X-Real-IP", "127.0.0.1");
        req.put("x-middleware-prefetch", "1");
        req.put("x-invoke-path", "/api/hitomi");
        req.put("x-nextjs-data", "1");
        req.put("Range", "bytes=0-9");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=0-9", out.get("Range"));
        assertFalse(out.containsKey("Cookie"));
        assertFalse(out.containsKey("host"));
        assertFalse(out.containsKey("Content-Length"));
        assertFalse(out.containsKey("Connection"));
        assertFalse(out.containsKey("TE"));
        assertFalse(out.containsKey("x-forwarded-for"));
        assertFalse(out.containsKey("X-Real-IP"));
        assertFalse(out.containsKey("x-middleware-prefetch"));
        assertFalse(out.containsKey("x-invoke-path"));
        assertFalse(out.containsKey("x-nextjs-data"));
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
