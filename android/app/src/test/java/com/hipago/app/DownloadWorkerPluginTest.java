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
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34)
public class DownloadWorkerPluginTest {
    private static final String RUN_A = "run-aaaaaaaaaaaaaaaa";
    private static final String RUN_B = "run-bbbbbbbbbbbbbbbb";

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
        File file = writeProgress(
                "progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":4,\"total\":10}"
        );

        JSObject progress = DownloadWorkerPlugin.readProgressFile(file, RUN_A);

        assertEquals(RUN_A, progress.getString("runId"));
        assertEquals(4, progress.getInt("current"));
        assertEquals(10, progress.getInt("total"));
    }

    @Test
    public void readsProgressFailureSentinelForForegroundPoller() throws Exception {
        File file = writeProgress(
                "failed.json",
                "{\"runId\":\"" + RUN_A
                        + "\",\"current\":null,\"error\":\"Select a download folder\"}"
        );

        JSObject progress = DownloadWorkerPlugin.readProgressFile(file, RUN_A);

        assertEquals(RUN_A, progress.getString("runId"));
        assertTrue(progress.isNull("current"));
        assertEquals("Select a download folder", progress.getString("error"));
    }

    @Test
    public void returnsNullCurrentWhenProgressFileIsAbsentOrMalformed() throws Exception {
        JSObject absent = DownloadWorkerPlugin.readProgressFile(
                new File(temp.getRoot(), "missing.json"),
                RUN_A
        );
        JSObject malformed = DownloadWorkerPlugin.readProgressFile(
                writeProgress("bad.json", "{\"current\":"),
                RUN_A
        );

        assertEquals(RUN_A, absent.getString("runId"));
        assertTrue(absent.isNull("current"));
        assertTrue(!absent.has("error"));
        assertEquals(RUN_A, malformed.getString("runId"));
        assertTrue(malformed.isNull("current"));
        assertTrue(!malformed.has("error"));
    }

    @Test
    public void rejectsProgressOwnedByAReplacementRun() throws Exception {
        File file = writeProgress(
                "replacement.json",
                "{\"runId\":\"" + RUN_B + "\",\"current\":7,\"total\":10}"
        );

        JSObject progress = DownloadWorkerPlugin.readProgressFile(file, RUN_A);

        assertEquals(RUN_B, progress.getString("runId"));
        assertTrue(progress.isNull("current"));
        assertTrue(progress.getBool("stale"));
        assertTrue(!progress.has("total"));
    }

    @Test
    public void rejectsOldPollAfterReplacementOrderBeforeFirstProgress() throws Exception {
        File replacementOrder = writeProgress(
                "replacement-order.json",
                "{\"galleryId\":123,\"runId\":\"" + RUN_B + "\"}"
        );
        File missingProgress = new File(temp.getRoot(), "replacement-not-started.json");

        JSObject progress = DownloadWorkerPlugin.readProgressForRun(
                "123",
                replacementOrder,
                missingProgress,
                RUN_A
        );

        assertEquals(RUN_B, progress.getString("runId"));
        assertTrue(progress.isNull("current"));
        assertTrue(progress.getBool("stale"));
    }

    @Test
    public void matchingOrderWithoutProgressIsNotReportedAsStale() throws Exception {
        File order = writeProgress(
                "matching-order-no-progress.json",
                "{\"galleryId\":123,\"runId\":\"" + RUN_A + "\"}"
        );
        File missingProgress = new File(temp.getRoot(), "matching-not-started.json");

        JSObject progress = DownloadWorkerPlugin.readProgressForRun(
                "123",
                order,
                missingProgress,
                RUN_A
        );

        assertEquals(RUN_A, progress.getString("runId"));
        assertTrue(progress.isNull("current"));
        assertTrue(!progress.has("stale"));
    }

    @Test
    public void discoversCurrentRunFromOrderBeforeProgressStarts() throws Exception {
        File order = writeProgress(
                "123-order.json",
                "{\"galleryId\":123,\"runId\":\"" + RUN_A + "\"}"
        );
        File missingProgress = new File(temp.getRoot(), "missing-progress.json");

        assertEquals(
                RUN_A,
                DownloadWorkerPlugin.resolveCurrentRunId("123", order, missingProgress)
        );
    }

    @Test
    public void discoversCurrentRunFromProgressAfterOrderWasConsumed() throws Exception {
        File missingOrder = new File(temp.getRoot(), "missing-order.json");
        File progress = writeProgress(
                "123-progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":4,\"total\":10}"
        );

        assertEquals(
                RUN_A,
                DownloadWorkerPlugin.resolveCurrentRunId("123", missingOrder, progress)
        );
    }

    @Test
    public void discoversRunOnlyWhenOrderAndProgressAgree() throws Exception {
        File order = writeProgress(
                "123-matching-order.json",
                "{\"galleryId\":123,\"runId\":\"" + RUN_A + "\"}"
        );
        File matchingProgress = writeProgress(
                "123-matching-progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":4,\"total\":10}"
        );
        File replacementProgress = writeProgress(
                "123-replacement-progress.json",
                "{\"runId\":\"" + RUN_B + "\",\"current\":1,\"total\":10}"
        );

        assertEquals(
                RUN_A,
                DownloadWorkerPlugin.resolveCurrentRunId("123", order, matchingProgress)
        );
        assertNull(DownloadWorkerPlugin.resolveCurrentRunId("123", order, replacementProgress));
    }

    @Test
    public void distinguishesConflictingRunIdentitiesFromUnknownState() throws Exception {
        File order = writeProgress(
                "resolution-order.json",
                "{\"galleryId\":123,\"runId\":\"" + RUN_A + "\"}"
        );
        File conflictingProgress = writeProgress(
                "resolution-conflict.json",
                "{\"runId\":\"" + RUN_B + "\",\"current\":1,\"total\":2}"
        );
        File malformedProgress = writeProgress(
                "resolution-unknown.json",
                "{\"current\":1,\"total\":2}"
        );

        DownloadWorkerPlugin.CurrentRunResolution conflict =
                DownloadWorkerPlugin.resolveCurrentRun("123", order, conflictingProgress);
        DownloadWorkerPlugin.CurrentRunResolution unknown =
                DownloadWorkerPlugin.resolveCurrentRun("123", order, malformedProgress);

        assertNull(conflict.runId);
        assertTrue(conflict.conflict);
        assertTrue(!conflict.unknown);
        assertNull(unknown.runId);
        assertTrue(!unknown.conflict);
        assertTrue(unknown.unknown);
    }

    @Test
    public void exposesOnlyStrictlyConfirmedLegacyStateForRestartUpgrade() throws Exception {
        File legacyOrder = writeProgress(
                "resolution-legacy-order.json",
                "{\"galleryId\":123,\"title\":\"old\",\"pages\":[]}"
        );
        File missingProgress = new File(temp.getRoot(), "resolution-legacy-missing.json");
        File legacyProgress = writeProgress(
                "resolution-legacy-progress.json",
                "{\"current\":2,\"total\":10}"
        );
        File currentProgress = writeProgress(
                "resolution-legacy-current-progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":2,\"total\":10}"
        );
        File malformedProgress = writeProgress(
                "resolution-legacy-malformed-progress.json",
                "{\"current\":"
        );

        DownloadWorkerPlugin.CurrentRunResolution withoutProgress =
                DownloadWorkerPlugin.resolveCurrentRun("123", legacyOrder, missingProgress);
        DownloadWorkerPlugin.CurrentRunResolution withLegacyProgress =
                DownloadWorkerPlugin.resolveCurrentRun("123", legacyOrder, legacyProgress);
        DownloadWorkerPlugin.CurrentRunResolution legacyProgressAfterOrderDelete =
                DownloadWorkerPlugin.resolveCurrentRun("123", missingProgress, legacyProgress);
        DownloadWorkerPlugin.CurrentRunResolution withCurrentProgress =
                DownloadWorkerPlugin.resolveCurrentRun("123", legacyOrder, currentProgress);
        DownloadWorkerPlugin.CurrentRunResolution withMalformedProgress =
                DownloadWorkerPlugin.resolveCurrentRun("123", legacyOrder, malformedProgress);

        assertNull(withoutProgress.runId);
        assertTrue(withoutProgress.legacy);
        assertTrue(!withoutProgress.conflict);
        assertTrue(!withoutProgress.unknown);
        assertNull(withLegacyProgress.runId);
        assertTrue(withLegacyProgress.legacy);
        assertNull(legacyProgressAfterOrderDelete.runId);
        assertTrue(legacyProgressAfterOrderDelete.legacy);
        assertTrue(withCurrentProgress.conflict);
        assertTrue(!withCurrentProgress.legacy);
        assertTrue(withMalformedProgress.unknown);
        assertTrue(!withMalformedProgress.legacy);
    }

    @Test
    public void doesNotDiscoverCorruptOrCrossGalleryOrderIdentity() throws Exception {
        File crossGalleryOrder = writeProgress(
                "cross-gallery-order.json",
                "{\"galleryId\":999,\"runId\":\"" + RUN_A + "\"}"
        );
        File corruptOrder = writeProgress("corrupt-order.json", "{\"galleryId\":123}");
        File missingProgress = new File(temp.getRoot(), "absent-progress.json");

        assertNull(
                DownloadWorkerPlugin.resolveCurrentRunId("123", crossGalleryOrder, missingProgress)
        );
        assertNull(DownloadWorkerPlugin.resolveCurrentRunId("123", corruptOrder, missingProgress));
    }

    @Test
    public void permitsOnlySameRunIdempotentRewriteWhileOrderExists() throws Exception {
        String json = "{\"galleryId\":123,\"runId\":\"" + RUN_A + "\"}";
        File order = writeProgress(
                "existing-order.json",
                json
        );

        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.IDEMPOTENT,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        order,
                        NativeDownloadRun.create("123", RUN_A),
                        json.getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.STALE,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        order,
                        NativeDownloadRun.create("123", RUN_A),
                        (json + " ").getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.STALE,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        order,
                        NativeDownloadRun.create("123", RUN_B),
                        json.getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.STALE,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        order,
                        NativeDownloadRun.create("456", RUN_A),
                        json.getBytes(StandardCharsets.UTF_8)
                ));
    }

    @Test
    public void permitsNewRunOnlyAfterPriorOrderIsAbsent() throws Exception {
        File missingOrder = new File(temp.getRoot(), "cancelled-order.json");
        File corruptOrder = writeProgress("corrupt-existing-order.json", "{\"galleryId\":123}");

        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.PUBLISH,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        missingOrder,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.UNKNOWN,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        corruptOrder,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
    }

    @Test
    public void replacesOnlyConfirmedMatchingLegacyOrderAndProgress() throws Exception {
        File legacyOrder = writeProgress(
                "legacy-order.json",
                "{\"galleryId\":123,\"title\":\"old\",\"pages\":[]}"
        );
        File legacyProgress = writeProgress(
                "legacy-progress.json",
                "{\"current\":2,\"total\":10}"
        );
        File currentProgress = writeProgress(
                "current-progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":2,\"total\":10}"
        );

        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.LEGACY_REPLACE,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        legacyOrder,
                        new File(temp.getRoot(), "missing-legacy-progress.json"),
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.LEGACY_REPLACE,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        legacyOrder,
                        legacyProgress,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.STALE,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        legacyOrder,
                        currentProgress,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
    }

    @Test
    public void legacyMigrationFailsClosedForForeignMalformedOrUnreadableState() throws Exception {
        File foreignLegacy = writeProgress(
                "foreign-legacy.json",
                "{\"galleryId\":999,\"pages\":[]}"
        );
        File malformedProgress = writeProgress("malformed-legacy-progress.json", "{\"current\":");
        File legacyOrder = writeProgress(
                "legacy-with-malformed-progress.json",
                "{\"galleryId\":123,\"pages\":[]}"
        );
        File unreadableOrder = temp.newFolder("unreadable-order.json");

        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.UNKNOWN,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        foreignLegacy,
                        null,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.UNKNOWN,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        legacyOrder,
                        malformedProgress,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
        assertEquals(DownloadWorkerPlugin.WorkOrderPublication.UNKNOWN,
                DownloadWorkerPlugin.classifyWorkOrderPublication(
                        unreadableOrder,
                        null,
                        NativeDownloadRun.create("123", RUN_B),
                        "new".getBytes(StandardCharsets.UTF_8)
                ));
    }

    @Test
    public void deletesOnlyStrictlyConfirmedLegacyProgress() throws Exception {
        File legacy = writeProgress("delete-legacy-progress.json", "{\"current\":1,\"total\":2}");
        DownloadWorkerPlugin.deleteConfirmedLegacyProgress(legacy);
        assertTrue(!legacy.exists());

        File current = writeProgress(
                "keep-current-progress.json",
                "{\"runId\":\"" + RUN_A + "\",\"current\":1,\"total\":2}"
        );
        try {
            DownloadWorkerPlugin.deleteConfirmedLegacyProgress(current);
            throw new AssertionError("current progress must not be deleted as legacy");
        } catch (Exception expected) {
            assertTrue(current.exists());
        }
    }

    @Test
    public void countsOnlyPublishedOrdersAndFailsClosedWhenEnumerationFails() throws Exception {
        File queue = temp.newFolder("queue");
        Files.write(
                new File(queue, "123.json").toPath(),
                "{}".getBytes(StandardCharsets.UTF_8)
        );
        Files.write(
                new File(queue, "456.json").toPath(),
                "{}".getBytes(StandardCharsets.UTF_8)
        );
        Files.write(
                new File(queue, "789.json.tmp").toPath(),
                "{}".getBytes(StandardCharsets.UTF_8)
        );

        assertEquals(2, DownloadWorkerPlugin.countPendingWorkOrders(queue));

        File missing = new File(temp.getRoot(), "missing-queue");
        try {
            DownloadWorkerPlugin.countPendingWorkOrders(missing);
            throw new AssertionError("missing queue must fail closed");
        } catch (Exception error) {
            assertEquals("work-order enumeration failed", error.getMessage());
        }
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
