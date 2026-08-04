package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class NativeDownloadRunTest {
    private static final String RUN_A = "run-aaaaaaaaaaaaaaaa";
    private static final String RUN_B = "run-bbbbbbbbbbbbbbbb";

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    @Test
    public void parsesAndMatchesGalleryAndRunIdentity() throws Exception {
        NativeDownloadRun run = NativeDownloadRun.fromOrder(
                new JSONObject("{\"galleryId\":123,\"runId\":\"" + RUN_A + "\"}")
        );

        assertNotNull(run);
        assertEquals("123", run.galleryId);
        assertEquals(RUN_A, run.runId);
        assertTrue(run.equalsIdentity(NativeDownloadRun.create("123", RUN_A)));
        assertFalse(run.equalsIdentity(NativeDownloadRun.create("123", RUN_B)));
    }

    @Test
    public void staleRunCannotDeleteReplacementOrder() throws Exception {
        File order = writeJson(
                "123.json",
                "{\"galleryId\":123,\"runId\":\"" + RUN_B + "\"}"
        );
        NativeDownloadRun stale = NativeDownloadRun.create("123", RUN_A);

        assertFalse(stale.matchesOrderFile(order));
        assertFalse(stale.deleteOrderFileIfCurrent(order));
        assertTrue(order.exists());
        assertEquals(RUN_B, NativeDownloadRun.fromOrderFile(order).runId);
    }

    @Test
    public void staleRunCannotDeleteReplacementProgress() throws Exception {
        File progress = writeJson(
                "progress.json",
                "{\"runId\":\"" + RUN_B + "\",\"current\":1,\"total\":2}"
        );
        NativeDownloadRun stale = NativeDownloadRun.create("123", RUN_A);

        assertFalse(stale.matchesProgressFile(progress));
        assertFalse(stale.deleteProgressFileIfOwned(progress));
        assertTrue(progress.exists());
        assertEquals(RUN_B, NativeDownloadRun.progressRunId(progress));
    }

    @Test
    public void currentRunCanDeleteOnlyItsOwnFiles() throws Exception {
        File order = writeJson(
                "456.json",
                "{\"galleryId\":456,\"runId\":\"" + RUN_A + "\"}"
        );
        File progress = writeJson(
                "456-progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":1,\"total\":2}"
        );
        NativeDownloadRun current = NativeDownloadRun.create("456", RUN_A);

        assertTrue(current.deleteProgressFileIfOwned(progress));
        assertTrue(current.deleteOrderFileIfCurrent(order));
        assertFalse(progress.exists());
        assertFalse(order.exists());
    }

    @Test
    public void rejectsMalformedOrUnsafeIdentityFields() throws Exception {
        assertNull(NativeDownloadRun.create("../123", RUN_A));
        assertNull(NativeDownloadRun.create("123", "too-short"));
        assertNull(NativeDownloadRun.create("123", "run/aaaaaaaaaaaaaaaa"));
        assertNull(NativeDownloadRun.fromOrder(new JSONObject("{\"galleryId\":123}")));
    }

    @Test
    public void returnsOneStableLockPerGalleryWithoutApi24Methods() {
        Object first = NativeDownloadRun.lockFor("123");
        Object second = NativeDownloadRun.lockFor("123");
        Object otherGallery = NativeDownloadRun.lockFor("456");

        assertTrue(first == second);
        assertFalse(first == otherGallery);
    }

    @Test
    public void schedulerLockSerializesQueueOperationsAcrossGalleries() throws Exception {
        Object schedulerLock = NativeDownloadRun.schedulerLock();
        assertTrue(schedulerLock == NativeDownloadRun.schedulerLock());

        CountDownLatch cancelEntered = new CountDownLatch(1);
        CountDownLatch allowCancelToFinish = new CountDownLatch(1);
        CountDownLatch enqueueAttempting = new CountDownLatch(1);
        CountDownLatch enqueueEntered = new CountDownLatch(1);
        AtomicBoolean cancelActionFinished = new AtomicBoolean(false);
        AtomicBoolean enqueueObservedFinishedCancel = new AtomicBoolean(false);
        AtomicReference<Throwable> threadFailure = new AtomicReference<>();

        Thread cancelThread = new Thread(() -> {
            try {
                NativeDownloadRun.withQueueTransaction("123", () -> {
                    cancelEntered.countDown();
                    try {
                        allowCancelToFinish.await();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return null;
                    }
                    cancelActionFinished.set(true);
                    return null;
                });
            } catch (Throwable error) {
                threadFailure.compareAndSet(null, error);
            }
        });
        Thread enqueueThread = new Thread(() -> {
            enqueueAttempting.countDown();
            try {
                NativeDownloadRun.withQueueTransaction("456", () -> {
                    enqueueObservedFinishedCancel.set(cancelActionFinished.get());
                    enqueueEntered.countDown();
                    return null;
                });
            } catch (Throwable error) {
                threadFailure.compareAndSet(null, error);
            }
        });

        cancelThread.start();
        assertTrue(cancelEntered.await(1, TimeUnit.SECONDS));
        enqueueThread.start();
        assertTrue(enqueueAttempting.await(1, TimeUnit.SECONDS));
        assertFalse(enqueueEntered.await(100, TimeUnit.MILLISECONDS));

        allowCancelToFinish.countDown();
        cancelThread.join(1_000);
        enqueueThread.join(1_000);

        assertFalse(cancelThread.isAlive());
        assertFalse(enqueueThread.isAlive());
        assertNull(threadFailure.get());
        assertTrue(enqueueEntered.await(0, TimeUnit.MILLISECONDS));
        assertTrue(enqueueObservedFinishedCancel.get());
    }

    private File writeJson(String name, String json) throws Exception {
        File file = temp.newFile(name);
        Files.write(file.toPath(), json.getBytes(StandardCharsets.UTF_8));
        return file;
    }
}
