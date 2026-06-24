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
    public void numericStringQueuePositionMatchesJsonOptLongSemantics() throws Exception {
        File order = writeOrder("string-position.json", "{\"galleryId\":123,\"queuePosition\":\"3\"}");

        assertEquals(3L, GalleryDownloadWorker.orderQueuePosition(order));
    }

    @Test
    public void validatesWorkOrderPageRelPathsBeforeSafAccess() {
        assertTrue(GalleryDownloadWorker.isValidRelPath("HiPaGo/123 Title/0001.webp"));
        assertTrue(GalleryDownloadWorker.isValidRelPath("downloads/123/0001.avif"));

        assertTrue(!GalleryDownloadWorker.isValidRelPath(null));
        assertTrue(!GalleryDownloadWorker.isValidRelPath(""));
        assertTrue(!GalleryDownloadWorker.isValidRelPath("/HiPaGo/123/0001.webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath("HiPaGo/123/"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath("HiPaGo/../0001.webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath("HiPaGo//0001.webp"));
        assertTrue(!GalleryDownloadWorker.isValidRelPath("HiPaGo\\123\\0001.webp"));
    }

    @Test
    public void validatesDownloadUrlAndExtensionBeforeNativeDownload() {
        assertTrue(GalleryDownloadWorker.isValidDownloadUrl("https://aa.hitomi.la/webp/x.webp"));
        assertTrue(GalleryDownloadWorker.isValidDownloadUrl("http://example.test/x.webp"));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl(null));
        assertTrue(!GalleryDownloadWorker.isValidDownloadUrl(""));
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

    private File writeOrder(String name, String json) throws Exception {
        File file = temp.newFile(name);
        Files.write(file.toPath(), json.getBytes(StandardCharsets.UTF_8));
        return file;
    }
}
