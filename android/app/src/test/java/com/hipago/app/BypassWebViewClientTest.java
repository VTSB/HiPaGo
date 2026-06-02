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
 * Contract: forward the client's request headers as-is, overwriting only the
 * headers the bypass transport must own — {@code Referer}/{@code Origin}
 * (spoofed) and {@code Accept-Encoding} (dropped so bypass-core owns
 * decompression). Regression guard for the Android-only title-search bug where
 * the {@code Range} header was dropped, so every non-root B-tree
 * galleries-index fetch returned the full file from offset 0 and untyped/title
 * search returned no results.
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
        assertEquals("bytes=0-463", out.get("range"));
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
    public void forwardsArbitraryClientHeaders() {
        // The whole point: anything the client set (other than the overwritten
        // identity / transport headers) passes through unchanged.
        Map<String, String> req = new HashMap<>();
        req.put("Range", "bytes=100-200");
        req.put("If-Range", "\"etag-xyz\"");
        req.put("Accept", "image/avif,image/webp,*/*");
        req.put("Sec-Fetch-Mode", "cors");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("bytes=100-200", out.get("Range"));
        assertEquals("\"etag-xyz\"", out.get("If-Range"));
        assertEquals("image/avif,image/webp,*/*", out.get("Accept"));
        assertEquals("cors", out.get("Sec-Fetch-Mode"));
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
    public void dropsAcceptEncodingSoTransportOwnsDecompression() {
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
        // Only the two canonical identity headers remain.
        assertEquals(2, out.size());
        assertTrue(out.containsKey("Referer"));
        assertTrue(out.containsKey("Origin"));
    }
}
