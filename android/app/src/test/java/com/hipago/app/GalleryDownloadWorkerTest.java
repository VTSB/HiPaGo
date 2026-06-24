package com.hipago.app;

import static org.junit.Assert.assertEquals;

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

    private File writeOrder(String name, String json) throws Exception {
        File file = temp.newFile(name);
        Files.write(file.toPath(), json.getBytes(StandardCharsets.UTF_8));
        return file;
    }
}
