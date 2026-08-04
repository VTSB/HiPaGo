package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.work.ListenableWorker;
import androidx.work.testing.TestListenableWorkerBuilder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class GalleryDownloadWorkerRuntimeTest {
    private static final String RUN_ID = "run-aaaaaaaaaaaaaaaa";

    private Context context;

    @Before
    public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        deleteRecursively(new File(context.getFilesDir(), GalleryDownloadWorker.HANDOFF_DIR));
        deleteRecursively(new File(context.getFilesDir(), GalleryDownloadWorker.PROGRESS_DIR));
        context.getSharedPreferences(SafLibrary.PREFS, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void noSafTreeKeepsWorkOrderAndWritesFailureProgress() throws Exception {
        File handoffDir = new File(context.getFilesDir(), GalleryDownloadWorker.HANDOFF_DIR);
        assertTrue(handoffDir.mkdirs());
        File orderFile = new File(handoffDir, "123.json");
        Files.write(
                orderFile.toPath(),
                ("{\"galleryId\":123,\"runId\":\"" + RUN_ID
                        + "\",\"pages\":[{\"index\":0}]}").getBytes(StandardCharsets.UTF_8)
        );

        File progressDir = new File(context.getFilesDir(), GalleryDownloadWorker.PROGRESS_DIR);
        assertTrue(progressDir.mkdirs());
        File activeProgress = new File(progressDir, "123.json");
        Files.write(
                activeProgress.toPath(),
                ("{\"runId\":\"" + RUN_ID + "\",\"current\":1,\"total\":2}")
                        .getBytes(StandardCharsets.UTF_8)
        );
        File staleProgress = new File(progressDir, "999.json");
        Files.write(staleProgress.toPath(), "{\"current\":1,\"total\":2}".getBytes(StandardCharsets.UTF_8));

        GalleryDownloadWorker worker = TestListenableWorkerBuilder
                .from(context, GalleryDownloadWorker.class)
                .build();

        ListenableWorker.Result result = worker.doWork();

        assertEquals(ListenableWorker.Result.success(), result);
        assertTrue(orderFile.exists());
        JSONObject progress = new JSONObject(
                new String(
                        Files.readAllBytes(new File(progressDir, "123.json").toPath()),
                        StandardCharsets.UTF_8
                )
        );
        assertEquals("Select a download folder", progress.getString("error"));
        assertEquals(RUN_ID, progress.getString("runId"));
        assertTrue(progress.isNull("current"));
        assertTrue(!staleProgress.exists());
    }

    @Test
    public void safSizeProviderFailureReturnsRetryAndKeepsCurrentOrder() throws Exception {
        File orderFile = writeSinglePageOrder("HiPaGo/123 Title/0001.webp", "123 Title");
        GalleryDownloadWorker worker = TestListenableWorkerBuilder
                .from(context, GalleryDownloadWorker.class)
                .build();
        FailingSizeSafLibrary saf = new FailingSizeSafLibrary(context);
        worker.setSafForTesting(saf);

        ListenableWorker.Result result = worker.doWork();

        assertEquals(ListenableWorker.Result.retry(), result);
        assertTrue(orderFile.exists());
        assertEquals(1, saf.sizeCalls);
        JSONObject progress = new JSONObject(
                new String(
                        Files.readAllBytes(new File(
                                context.getFilesDir(),
                                GalleryDownloadWorker.PROGRESS_DIR + "/123.json"
                        ).toPath()),
                        StandardCharsets.UTF_8
                )
        );
        assertEquals(RUN_ID, progress.getString("runId"));
        assertTrue(progress.isNull("current"));
        assertEquals("Background download failed", progress.getString("error"));
    }

    @Test
    public void safTreeProviderFailureReturnsRetryAndKeepsCurrentOrder() throws Exception {
        File orderFile = writeSinglePageOrder("HiPaGo/123 Title/0001.webp", "123 Title");
        GalleryDownloadWorker worker = TestListenableWorkerBuilder
                .from(context, GalleryDownloadWorker.class)
                .build();
        worker.setSafForTesting(new ThrowingHasTreeSafLibrary(context));

        ListenableWorker.Result result = worker.doWork();

        assertEquals(ListenableWorker.Result.retry(), result);
        assertTrue(orderFile.exists());
    }

    @Test
    public void releasedLegacyOrderAndProgressSurviveUntilPluginMigration() throws Exception {
        File orderFile = writeSinglePageOrder("HiPaGo/123 Title/0001.webp", "123 Title");
        JSONObject legacyOrder = new JSONObject(
                new String(Files.readAllBytes(orderFile.toPath()), StandardCharsets.UTF_8)
        );
        legacyOrder.remove("runId");
        Files.write(orderFile.toPath(), legacyOrder.toString().getBytes(StandardCharsets.UTF_8));

        File progressDir = new File(context.getFilesDir(), GalleryDownloadWorker.PROGRESS_DIR);
        assertTrue(progressDir.mkdirs());
        File progressFile = new File(progressDir, "123.json");
        Files.write(
                progressFile.toPath(),
                "{\"current\":1,\"total\":2}".getBytes(StandardCharsets.UTF_8)
        );

        GalleryDownloadWorker worker = TestListenableWorkerBuilder
                .from(context, GalleryDownloadWorker.class)
                .build();
        FailingSizeSafLibrary saf = new FailingSizeSafLibrary(context);
        worker.setSafForTesting(saf);

        ListenableWorker.Result result = worker.doWork();

        assertEquals(ListenableWorker.Result.success(), result);
        assertTrue(orderFile.exists());
        assertTrue(progressFile.exists());
        assertEquals(0, saf.sizeCalls);
    }

    @Test
    public void nonLibraryPagePathIsUnrecoverableBeforeSafAccess() throws Exception {
        File orderFile = writeSinglePageOrder("downloads/123/0001.webp", "123");
        GalleryDownloadWorker worker = TestListenableWorkerBuilder
                .from(context, GalleryDownloadWorker.class)
                .build();
        FailingSizeSafLibrary saf = new FailingSizeSafLibrary(context);
        worker.setSafForTesting(saf);

        ListenableWorker.Result result = worker.doWork();

        assertEquals(ListenableWorker.Result.success(), result);
        assertTrue(!orderFile.exists());
        assertEquals(0, saf.sizeCalls);
    }

    private File writeSinglePageOrder(String relPath, String folderName) throws Exception {
        File handoffDir = new File(context.getFilesDir(), GalleryDownloadWorker.HANDOFF_DIR);
        assertTrue(handoffDir.mkdirs());
        File orderFile = new File(handoffDir, "123.json");
        JSONObject page = new JSONObject();
        page.put("index", 0);
        page.put("url", "https://aa.gold-usergeneratedcontent.net/webp/x.webp");
        page.put("ext", "webp");
        page.put("relPath", relPath);
        JSONObject order = new JSONObject();
        order.put("galleryId", 123);
        order.put("runId", RUN_ID);
        order.put("folderName", folderName);
        order.put("pages", new org.json.JSONArray().put(page));
        Files.write(orderFile.toPath(), order.toString().getBytes(StandardCharsets.UTF_8));
        return orderFile;
    }

    private static final class FailingSizeSafLibrary extends SafLibrary {
        int sizeCalls;

        FailingSizeSafLibrary(Context context) {
            super(context);
        }

        @Override
        public boolean hasTree() {
            return true;
        }

        @Override
        public byte[] readBytes(String relPath) {
            return null;
        }

        @Override
        public long size(String relPath) {
            sizeCalls++;
            throw new IllegalStateException("provider query failed");
        }
    }

    private static final class ThrowingHasTreeSafLibrary extends SafLibrary {
        ThrowingHasTreeSafLibrary(Context context) {
            super(context);
        }

        @Override
        public boolean hasTree() {
            throw new IllegalStateException("provider query failed");
        }
    }

    private static void deleteRecursively(File file) throws Exception {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(file.toPath());
    }
}
