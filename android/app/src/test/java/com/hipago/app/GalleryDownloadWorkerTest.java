package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class GalleryDownloadWorkerTest {
    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void readsQueuePositionFromWorkOrder() throws Exception {
        File order = writeOrder("with-position.json", "{\"galleryId\":123,\"queuePosition\":7}");

        assertEquals(7L, GalleryDownloadWorker.orderQueuePosition(order));
    }

    @Test
    public void treatsMissingNullAndMalformedQueuePositionAsLegacyTail() throws Exception {
        assertEquals(
                Long.MAX_VALUE,
                GalleryDownloadWorker.orderQueuePosition(writeOrder("missing.json", "{\"galleryId\":1}"))
        );
        assertEquals(
                Long.MAX_VALUE,
                GalleryDownloadWorker.orderQueuePosition(
                        writeOrder("null.json", "{\"galleryId\":1,\"queuePosition\":null}")
                )
        );
        assertEquals(
                Long.MAX_VALUE,
                GalleryDownloadWorker.orderQueuePosition(writeOrder("bad.json", "{\"galleryId\":"))
        );
    }

    @Test
    public void malformedCleanupPreservesLegacyFoundByLockedReread() throws Exception {
        File order = writeOrder(
                "123.json",
                "{\"galleryId\":123,\"title\":\"legacy\",\"pages\":[]}"
        );

        // Calling cleanup directly models an earlier unlocked read that failed
        // transiently. The locked re-read now sees the durable legacy order.
        GalleryDownloadWorker.deleteMalformedOrderIfStillMalformed(order);

        assertTrue(order.exists());
    }

    @Test
    public void numericStringQueuePositionMatchesJsonOptLongSemantics() throws Exception {
        File order = writeOrder("string-position.json", "{\"galleryId\":123,\"queuePosition\":\"3\"}");

        assertEquals(3L, GalleryDownloadWorker.orderQueuePosition(order));
    }

    @Test
    public void comparesQueuePositionThenFilenameWithoutApi24ComparatorHelpers() throws Exception {
        File first = writeOrder("z.json", "{\"galleryId\":1,\"queuePosition\":1}");
        File second = writeOrder("a.json", "{\"galleryId\":2,\"queuePosition\":2}");
        File tie = writeOrder("b.json", "{\"galleryId\":3,\"queuePosition\":2}");

        assertTrue(GalleryDownloadWorker.compareOrderFiles(first, second) < 0);
        assertTrue(GalleryDownloadWorker.compareOrderFiles(second, tie) < 0);
        assertTrue(GalleryDownloadWorker.compareOrderFiles(tie, second) > 0);
    }

    @Test
    public void validatesWorkOrderPageRelPathsBeforeSafAccess() {
        assertTrue(GalleryDownloadWorker.isValidGalleryFolder("123", "123 Title"));
        assertTrue(GalleryDownloadWorker.isValidGalleryFolder("123", "123"));
        assertTrue(GalleryDownloadWorker.isValidRelPath(
                "HiPaGo/123 Title/0001.webp", "123", "123 Title", 0, "webp"));

        assertTrue(!GalleryDownloadWorker.isValidGalleryFolder("123", "999 Title"));
        assertTrue(!GalleryDownloadWorker.isValidGalleryFolder("123", "123/Title"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(
                "downloads/123/0001.avif", "123", "123", 0, "avif"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(
                "HiPaGo2/123/0001.webp", "123", "123", 0, "webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(
                "HiPaGo/123/0002.webp", "123", "123", 0, "webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(
                "HiPaGo/123/0001.jpg", "123", "123", 0, "webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(
                "HiPaGo/999/0001.webp", "123", "999", 0, "webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(
                null, "123", "123", 0, "webp"));
    }

    @Test
    public void validatesDownloadUrlAndExtensionBeforeNativeDownload() {
        assertTrue(GalleryDownloadWorker.isValidDownloadUrl(
                "https://aa.gold-usergeneratedcontent.net/webp/x.webp"
        ));
        assertTrue(GalleryDownloadWorker.isValidDownloadUrl(
                "https://tagindex.hitomi.la/global/t/e.json"
        ));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl(null));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl(""));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl("http://hitomi.la/x.webp"));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl("https://aa.hitomi.la/x.webp"));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl("https://hitomi.la.evil.test/x.webp"));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl("file:///tmp/x.webp"));

        assertTrue(GalleryDownloadWorker.isValidExtension("webp"));
        assertTrue(GalleryDownloadWorker.isValidExtension("avif"));
        assertTrue(GalleryDownloadWorker.isValidExtension("jpg"));
        assertTrue(!GalleryDownloadWorker.isValidExtension(null));
        assertTrue(!GalleryDownloadWorker.isValidExtension(""));
        assertTrue(!GalleryDownloadWorker.isValidExtension("../webp"));
        assertTrue(!GalleryDownloadWorker.isValidExtension("webp.tmp"));
    }

    @Test
    public void derivesManifestPathFromPageRelPath() {
        assertEquals(
                "HiPaGo/123 Title/0000.json",
                GalleryDownloadWorker.manifestPathForPage("HiPaGo/123 Title/0001.webp")
        );
        assertEquals("0000.json", GalleryDownloadWorker.manifestPathForPage("0001.webp"));
    }

    @Test
    public void decodesManifestExtsAsCommittedPrefix() {
        String[] exts = new String[3];

        int count = GalleryDownloadWorker.decodeManifestExts("[\"webp\",\"avif\"]".getBytes(StandardCharsets.UTF_8), exts);

        assertEquals(2, count);
        assertEquals("webp", exts[0]);
        assertEquals("avif", exts[1]);
        assertEquals(null, exts[2]);
    }

    @Test
    public void resumeSkipsOnlyPagesCommittedByManifest() {
        assertTrue(GalleryDownloadWorker.shouldSkipExistingPage(0, 1, 12));
        assertTrue(GalleryDownloadWorker.shouldSkipExistingPage(1, 2, 12));

        assertFalse(GalleryDownloadWorker.shouldSkipExistingPage(1, 1, 12));
        assertFalse(GalleryDownloadWorker.shouldSkipExistingPage(0, 1, 0));
        assertFalse(GalleryDownloadWorker.shouldSkipExistingPage(0, 0, 12));
    }

    @Test
    public void progressCountsOnlyManifestCommittedPages() {
        // The final page has started, but only nine pages are durable: never show
        // 10/10 until the manifest commit succeeds.
        assertEquals(9, GalleryDownloadWorker.committedProgressCount(9, 9));
        assertEquals(10, GalleryDownloadWorker.committedProgressCount(9, 10));
        assertEquals(0, GalleryDownloadWorker.committedProgressCount(0, 0));
    }

    @Test
    public void progressPercentReachesOneHundredOnlyWhenComplete() {
        assertEquals(99, GalleryDownloadWorker.progressPercent(199, 200));
        assertEquals(100, GalleryDownloadWorker.progressPercent(200, 200));
        assertEquals(100, GalleryDownloadWorker.progressPercent(201, 200));
        assertEquals(0, GalleryDownloadWorker.progressPercent(0, 0));
    }

    @Test
    public void localizesDownloadNotificationStrings() {
        assertEquals("ko", GalleryDownloadWorker.normalizeLocale("ko"));
        assertEquals("en", GalleryDownloadWorker.normalizeLocale("fr"));

        assertEquals("HiPaGo downloads", GalleryDownloadWorker.notificationTitle("en"));
        assertEquals("HiPaGo 다운로드", GalleryDownloadWorker.notificationTitle("ko"));
        assertEquals("Preparing downloads…", GalleryDownloadWorker.notificationPreparing("en"));
        assertEquals("다운로드 준비 중…", GalleryDownloadWorker.notificationPreparing("ko"));
        assertEquals(
                "Downloading 3/10 (30%)",
                GalleryDownloadWorker.notificationDownloading("en", 3, 10, 30)
        );
        assertEquals(
                "다운로드 중 3/10 (30%)",
                GalleryDownloadWorker.notificationDownloading("ko", 3, 10, 30)
        );
        assertEquals("Downloading...", GalleryDownloadWorker.notificationDownloadingIndeterminate("en"));
        assertEquals("다운로드 중…", GalleryDownloadWorker.notificationDownloadingIndeterminate("ko"));
        assertEquals("Downloads", GalleryDownloadWorker.notificationChannelName("en"));
        assertEquals("다운로드", GalleryDownloadWorker.notificationChannelName("ko"));
        assertEquals(
                "Background gallery downloads",
                GalleryDownloadWorker.notificationChannelDescription("en")
        );
        assertEquals(
                "백그라운드 갤러리 다운로드",
                GalleryDownloadWorker.notificationChannelDescription("ko")
        );
    }

    private File writeOrder(String name, String json) throws Exception {
        File file = temp.newFile(name);
        Files.write(file.toPath(), json.getBytes(StandardCharsets.UTF_8));
        return file;
    }
}
