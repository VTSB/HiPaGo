package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.JSObject;

import java.io.File;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DownloadWorkerPluginTest {
    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private static final Method WORK_ORDER_GALLERY_ID = workOrderGalleryIdMethod();

    @Test
    public void readsNumericGalleryIdFromWorkOrderJson() throws Exception {
        assertEquals("123", workOrderGalleryId("{\"galleryId\":123}"));
    }

    @Test
    public void readsStringGalleryIdFromWorkOrderJson() throws Exception {
        assertEquals("123", workOrderGalleryId("{\"galleryId\":\"123\"}"));
    }

    @Test
    public void returnsNullWhenGalleryIdIsMissingNullOrMalformed() throws Exception {
        assertNull(workOrderGalleryId("{}"));
        assertNull(workOrderGalleryId("{\"galleryId\":null}"));
        assertNull(workOrderGalleryId("{\"galleryId\":"));
    }

    @Test
    public void acceptsOnlyNumericGalleryIdsForNativeFileBoundaries() {
        assertTrue(DownloadWorkerPlugin.isValidGalleryId("12345"));
        assertTrue(!DownloadWorkerPlugin.isValidGalleryId(null));
        assertTrue(!DownloadWorkerPlugin.isValidGalleryId(""));
        assertTrue(!DownloadWorkerPlugin.isValidGalleryId("../123"));
        assertTrue(!DownloadWorkerPlugin.isValidGalleryId("123/456"));
        assertTrue(!DownloadWorkerPlugin.isValidGalleryId("abc123"));
    }

    @Test
    public void readsProgressFileValuesForForegroundPoller() throws Exception {
        File file = writeProgress("progress.json", "{\"current\":4,\"total\":10}");

        JSObject progress = DownloadWorkerPlugin.readProgressFile(file);

        assertEquals(4, progress.getInt("current"));
        assertEquals(10, progress.getInt("total"));
    }

    @Test
    public void readsProgressFailureSentinelForForegroundPoller() throws Exception {
        File file = writeProgress("failed.json", "{\"current\":null,\"error\":\"Select a download folder\"}");

        JSObject progress = DownloadWorkerPlugin.readProgressFile(file);

        assertTrue(progress.isNull("current"));
        assertEquals("Select a download folder", progress.getString("error"));
    }

    @Test
    public void returnsNullCurrentWhenProgressFileIsAbsentOrMalformed() throws Exception {
        JSObject absent = DownloadWorkerPlugin.readProgressFile(new File(temp.getRoot(), "missing.json"));
        JSObject malformed = DownloadWorkerPlugin.readProgressFile(writeProgress("bad.json", "{\"current\":"));

        assertTrue(absent.isNull("current"));
        assertTrue(!absent.has("error"));
        assertTrue(malformed.isNull("current"));
        assertTrue(!malformed.has("error"));
    }

    private static Method workOrderGalleryIdMethod() {
        try {
            Method method = DownloadWorkerPlugin.class.getDeclaredMethod(
                    "workOrderGalleryId",
                    String.class
            );
            method.setAccessible(true);
            return method;
        } catch (NoSuchMethodException e) {
            throw new AssertionError(e);
        }
    }

    private static String workOrderGalleryId(String json) throws Exception {
        return (String) WORK_ORDER_GALLERY_ID.invoke(new DownloadWorkerPlugin(), json);
    }

    private File writeProgress(String name, String json) throws Exception {
        File file = temp.newFile(name);
        Files.write(file.toPath(), json.getBytes(StandardCharsets.UTF_8));
        return file;
    }
}
