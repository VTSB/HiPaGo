package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.lang.reflect.Method;

import org.junit.Test;

public class DownloadWorkerPluginTest {
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
}
