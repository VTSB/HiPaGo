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
 * Regression guard for the Android-only title-search bug: the interceptor used
 * to rebuild the upstream header map from scratch (Referer/Origin only) and
 * dropped the caller's {@code Range} header, so every B-tree galleries-index
 * sub-node fetch returned the full file from offset 0 and untyped/title search
 * returned no results. These tests pin the contract that {@code Range} is
 * forwarded (case-insensitively) while the spoofed Referer/Origin stay fixed.
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
        assertEquals("bytes=0-463", out.get("Range"));
    }

    @Test
    public void noRangeKeyWhenRequestHasNoRange() {
        Map<String, String> req = new HashMap<>();
        req.put("Accept", "*/*");
        req.put("User-Agent", "whatever");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertFalse(out.containsKey("Range"));
        assertNull(out.get("Range"));
    }

    @Test
    public void dropsOtherWebViewSuppliedHeaders() {
        // The WebView's own Origin/Referer/Sec-* must not override the spoofed
        // values; only Range crosses over.
        Map<String, String> req = new HashMap<>();
        req.put("Origin", "http://localhost");
        req.put("Referer", "http://localhost/search");
        req.put("Sec-Fetch-Mode", "cors");
        req.put("Range", "bytes=100-200");
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertEquals("https://hitomi.la/", out.get("Referer"));
        assertEquals("https://hitomi.la", out.get("Origin"));
        assertEquals("bytes=100-200", out.get("Range"));
        assertFalse(out.containsKey("Sec-Fetch-Mode"));
        assertEquals(3, out.size());
    }

    @Test
    public void skipsNullKeysAndValues() {
        Map<String, String> req = new HashMap<>();
        req.put(null, "bytes=1-2");
        req.put("Range", null);
        Map<String, String> out = BypassWebViewClient.buildUpstreamHeaders(req);
        assertFalse(out.containsKey("Range"));
    }
}
