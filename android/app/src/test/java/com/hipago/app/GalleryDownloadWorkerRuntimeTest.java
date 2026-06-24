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
                "{\"galleryId\":123,\"pages\":[{\"index\":0}]}".getBytes(StandardCharsets.UTF_8)
        );

        File progressDir = new File(context.getFilesDir(), GalleryDownloadWorker.PROGRESS_DIR);
        assertTrue(progressDir.mkdirs());
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
        assertTrue(progress.isNull("current"));
        assertTrue(!staleProgress.exists());
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
