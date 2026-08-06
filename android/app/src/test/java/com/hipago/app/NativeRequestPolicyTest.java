package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Pure JVM regression tests for the renderer-to-native request boundary. */
public class NativeRequestPolicyTest {
    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void allowsOnlyApprovedHttpsBypassHostsOnPort443() {
        String[] allowed = {
                "https://hitomi.la/",
                "https://tagindex.hitomi.la/global/t/e.json",
                "https://ltn.gold-usergeneratedcontent.net/gg.js?cache=1",
                "https://a1.gold-usergeneratedcontent.net:443/images/a.webp"
        };
        for (String url : allowed) {
            assertTrue(url, NativeRequestPolicy.isAllowedBypassUrl(url));
        }

        String[] rejected = {
                null,
                "",
                "http://hitomi.la/",
                "https://tn.hitomi.la/image.webp",
                "https://gold-usergeneratedcontent.net/",
                "https://evilgold-usergeneratedcontent.net/",
                "https://gold-usergeneratedcontent.net.evil.example/",
                "https://user@hitomi.la/",
                "https://hitomi.la:8443/",
                "https://hitomi.la/#fragment",
                "file:///tmp/image.webp",
                "https://127.0.0.1/"
        };
        for (String url : rejected) {
            assertFalse(String.valueOf(url), NativeRequestPolicy.isAllowedBypassUrl(url));
        }
    }

    @Test
    public void normalizesAllowedHeadersAndValidatesIdentityAndRange() {
        Map<String, String> input = new LinkedHashMap<>();
        input.put("Accept", "image/avif,image/webp,*/*");
        input.put("Range", "bytes=0-18446744073709551615");
        input.put("Origin", "https://hitomi.la");
        input.put("Referer", "https://hitomi.la/");

        Map<String, String> validated = NativeRequestPolicy.validateHeaders(input);

        assertEquals("image/avif,image/webp,*/*", validated.get("accept"));
        assertEquals("bytes=0-18446744073709551615", validated.get("range"));
        assertEquals("https://hitomi.la", validated.get("origin"));
        assertEquals("https://hitomi.la/", validated.get("referer"));
        assertFalse(validated.containsKey("Accept"));
        assertNull(NativeRequestPolicy.validateHeaders(null));
        assertNull(NativeRequestPolicy.validateHeaders(new LinkedHashMap<>()));
    }

    @Test
    public void rejectsUnapprovedMalformedAndOversizedHeaders() {
        assertInvalidHeaders(singleHeader("Cookie", "session=secret"));
        assertInvalidHeaders(singleHeader("Range", "bytes=10-9"));
        assertInvalidHeaders(singleHeader("Range", "bytes=0-"));
        assertInvalidHeaders(singleHeader("Range", "bytes=0-18446744073709551616"));
        assertInvalidHeaders(singleHeader("Origin", "https://evil.example"));
        assertInvalidHeaders(singleHeader("Referer", "https://hitomi.la/path"));
        assertInvalidHeaders(singleHeader("User-Agent", "ok\r\nX-Evil: 1"));
        assertInvalidHeaders(singleHeader("Accept", repeat('a', 4097)));

        Map<String, String> duplicate = new LinkedHashMap<>();
        duplicate.put("Range", "bytes=0-1");
        duplicate.put("range", "bytes=0-1");
        assertInvalidHeaders(duplicate);

        Map<String, String> tooMany = new LinkedHashMap<>();
        for (int i = 0; i < 17; i++) tooMany.put("x-test-" + i, "x");
        assertInvalidHeaders(tooMany);
    }

    @Test
    public void confinesImageCacheDestinationToOneCanonicalCacheChild() throws Exception {
        File appCache = temp.newFolder("app-cache");
        File expected = new File(new File(appCache, "image-cache"), "safe_key-1.webp");

        assertEquals(
                expected.getCanonicalFile(),
                NativeRequestPolicy.resolveImageCacheDestination(
                        appCache,
                        expected.getAbsolutePath()
                )
        );

        assertInvalidDestination(appCache, new File(appCache, "escape.webp").getAbsolutePath());
        assertInvalidDestination(
                appCache,
                new File(appCache, "image-cache/../escape.webp").getAbsolutePath()
        );
        assertInvalidDestination(
                appCache,
                new File(appCache, "image-cache/nested/key.webp").getAbsolutePath()
        );
        assertInvalidDestination(
                appCache,
                new File(appCache, "image-cache/bad key.webp").getAbsolutePath()
        );
        assertInvalidDestination(appCache, "image-cache/relative.webp");
    }

    @Test
    public void allowsOnlyTheExactVersionMatchedUniversalReleaseAsset() {
        String valid = "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/"
                + "HiPaGo_1.2.3_android_universal.apk";
        assertEquals("1.2.3", NativeRequestPolicy.requireAllowedUpdaterAssetUrl(valid));

        String[] rejected = {
                "http://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk",
                "https://github.com:8443/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk",
                "https://user@github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk#x",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk?x=1",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.4_android_universal.apk",
                "https://github.com/VTSB/HiPaGo/releases/download/v1.2.3/app-release.apk",
                "https://github.com/attacker/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk",
                "https://objects.githubusercontent.com/VTSB/HiPaGo/releases/download/v1.2.3/HiPaGo_1.2.3_android_universal.apk"
        };
        for (String url : rejected) {
            try {
                NativeRequestPolicy.requireAllowedUpdaterAssetUrl(url);
                fail("Expected updater URL rejection: " + url);
            } catch (IllegalArgumentException expected) {
                // expected
            }
        }
    }

    @Test
    public void requiresDownloadedArchiveIdentityAndMonotonicVersionCode() {
        NativeRequestPolicy.requireValidUpdateArchive(
                "com.hipago.app",
                100,
                "com.hipago.app",
                "1.2.3",
                101,
                "1.2.3"
        );

        assertInvalidArchive("evil.app", "1.2.3", 101);
        assertInvalidArchive("com.hipago.app", "1.2.4", 101);
        assertInvalidArchive("com.hipago.app", "1.2.3", 100);
        assertInvalidArchive("com.hipago.app", "1.2.3", 99);
    }

    private static Map<String, String> singleHeader(String name, String value) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put(name, value);
        return headers;
    }

    private static void assertInvalidHeaders(Map<String, String> headers) {
        try {
            NativeRequestPolicy.validateHeaders(headers);
            fail("Expected invalid headers");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }

    private static void assertInvalidDestination(File appCache, String path) {
        try {
            NativeRequestPolicy.resolveImageCacheDestination(appCache, path);
            fail("Expected invalid destination: " + path);
        } catch (Exception expected) {
            // expected
        }
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int i = 0; i < count; i++) result.append(value);
        return result.toString();
    }

    private static void assertInvalidArchive(
            String archivePackage,
            String archiveVersion,
            long archiveVersionCode
    ) {
        try {
            NativeRequestPolicy.requireValidUpdateArchive(
                    "com.hipago.app",
                    100,
                    archivePackage,
                    archiveVersion,
                    archiveVersionCode,
                    "1.2.3"
            );
            fail("Expected invalid update archive");
        } catch (IllegalArgumentException expected) {
            // expected
        }
    }
}
