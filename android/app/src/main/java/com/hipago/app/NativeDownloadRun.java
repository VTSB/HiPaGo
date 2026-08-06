package com.hipago.app;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Immutable identity for one native gallery-download attempt.
 *
 * <p>The gallery id identifies the logical download while {@code runId}
 * identifies one concrete attempt. Every mutable native boundary (work-order,
 * progress, SAF publish, and cleanup) compares both values while holding the
 * per-gallery lock. This prevents an older worker from treating a replacement
 * work-order for the same gallery as its own.</p>
 */
final class NativeDownloadRun {
    @FunctionalInterface
    interface QueueOperation<T> {
        T run() throws Exception;
    }

    private static final int MIN_RUN_ID_LENGTH = 16;
    private static final int MAX_RUN_ID_LENGTH = 128;
    private static final Object SCHEDULER_LOCK = new Object();
    private static final ConcurrentHashMap<String, Object> LOCKS = new ConcurrentHashMap<>();

    final String galleryId;
    final String runId;

    private NativeDownloadRun(String galleryId, String runId) {
        this.galleryId = galleryId;
        this.runId = runId;
    }

    static NativeDownloadRun create(String galleryId, String runId) {
        if (!isNumericGalleryId(galleryId) || !isValidRunId(runId)) return null;
        return new NativeDownloadRun(galleryId, runId);
    }

    static Object lockFor(String galleryId) {
        Object existing = LOCKS.get(galleryId);
        if (existing != null) return existing;
        Object created = new Object();
        Object raced = LOCKS.putIfAbsent(galleryId, created);
        return raced == null ? created : raced;
    }

    /**
     * Serializes operations that inspect or mutate the single WorkManager queue.
     * Callers that also need a gallery lock must acquire this lock first.
     */
    static Object schedulerLock() {
        return SCHEDULER_LOCK;
    }

    /**
     * Runs one operation against the process-wide WorkManager chain and one
     * gallery identity with a single, testable lock order.
     */
    static <T> T withQueueTransaction(String galleryId, QueueOperation<T> operation) throws Exception {
        synchronized (SCHEDULER_LOCK) {
            synchronized (lockFor(galleryId)) {
                return operation.run();
            }
        }
    }

    static NativeDownloadRun fromOrder(JSONObject order) {
        if (order == null) return null;
        Object rawGalleryId = order.opt("galleryId");
        if (rawGalleryId == null || rawGalleryId == JSONObject.NULL) return null;
        String galleryId = String.valueOf(rawGalleryId);
        String runId = order.optString("runId", null);
        return create(galleryId, runId);
    }

    static NativeDownloadRun fromOrderFile(File file) {
        return fromOrder(readJson(file));
    }

    static JSONObject readJson(File file) {
        if (file == null || !file.isFile()) return null;
        try {
            long length = file.length();
            if (length <= 0 || length > Integer.MAX_VALUE) return null;
            byte[] bytes = new byte[(int) length];
            try (FileInputStream fis = new FileInputStream(file)) {
                int off = 0;
                int n;
                while (off < bytes.length && (n = fis.read(bytes, off, bytes.length - off)) != -1) {
                    off += n;
                }
                if (off != bytes.length) return null;
            }
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (Throwable ignored) {
            return null;
        }
    }

    static String progressRunId(File file) {
        JSONObject progress = readJson(file);
        if (progress == null) return null;
        String runId = progress.optString("runId", null);
        return isValidRunId(runId) ? runId : null;
    }

    boolean matchesOrderFile(File orderFile) {
        NativeDownloadRun current = fromOrderFile(orderFile);
        return equalsIdentity(current);
    }

    boolean matchesProgressFile(File progressFile) {
        return runId.equals(progressRunId(progressFile));
    }

    boolean deleteOrderFileIfCurrent(File orderFile) {
        synchronized (lockFor(galleryId)) {
            if (!matchesOrderFile(orderFile)) return false;
            return !orderFile.exists() || orderFile.delete();
        }
    }

    boolean deleteProgressFileIfOwned(File progressFile) {
        synchronized (lockFor(galleryId)) {
            if (!matchesProgressFile(progressFile)) return false;
            return !progressFile.exists() || progressFile.delete();
        }
    }

    boolean equalsIdentity(NativeDownloadRun other) {
        return other != null
                && galleryId.equals(other.galleryId)
                && runId.equals(other.runId);
    }

    String key() {
        return galleryId + ":" + runId;
    }

    static boolean isValidRunId(String runId) {
        if (runId == null
                || runId.length() < MIN_RUN_ID_LENGTH
                || runId.length() > MAX_RUN_ID_LENGTH) {
            return false;
        }
        for (int i = 0; i < runId.length(); i++) {
            char c = runId.charAt(i);
            boolean alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            boolean digit = c >= '0' && c <= '9';
            if (!alpha && !digit && c != '-' && c != '_') return false;
        }
        return true;
    }

    private static boolean isNumericGalleryId(String galleryId) {
        if (galleryId == null || galleryId.isEmpty()) return false;
        for (int i = 0; i < galleryId.length(); i++) {
            char c = galleryId.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }
}
