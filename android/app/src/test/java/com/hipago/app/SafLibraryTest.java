package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;

import androidx.documentfile.provider.DocumentFile;

import org.junit.Test;

public class SafLibraryTest {
    private static final Method ASSERT_SAFE = assertSafeMethod();

    @Test
    public void allowsRelativeDownloadPaths() throws Exception {
        assertSafe("HiPaGo/123 Title/0001.webp");
        assertSafe("HiPaGo/123/0000.json");
    }

    @Test
    public void rejectsMissingAndTraversalPaths() throws Exception {
        assertSecurityException(null, "path is required");
        assertSecurityException("", "path is required");
        assertSecurityException("/HiPaGo/x.webp", "path traversal");
        assertSecurityException("HiPaGo/../x.webp", "path traversal");
        assertSecurityException("../x.webp", "path traversal");
    }

    @Test
    public void derivesFileAndTempNamesForSafPublish() {
        assertEquals("0001.webp", SafLibrary.fileNameForPath("HiPaGo/123/0001.webp"));
        assertEquals("0001.webp", SafLibrary.fileNameForPath("0001.webp"));

        assertEquals(".0001.webp.tmp-2a", SafLibrary.tempNameForPublish("0001.webp", 42L));
    }

    @Test
    public void directoryDeleteOnlySucceedsWhenMissingOrActuallyDeleted() throws Exception {
        File root = Files.createTempDirectory("hipago-saf-delete").toFile();
        File directory = new File(root, "gallery");
        File child = new File(directory, "0001.webp");
        assertTrue(directory.mkdirs());
        assertTrue(child.createNewFile());

        assertTrue(SafLibrary.deleteResolvedDirectory(DocumentFile.fromFile(directory)));
        assertFalse(directory.exists());

        File missing = new File(root, "already-gone");
        assertTrue(SafLibrary.deleteResolvedDirectory(DocumentFile.fromFile(missing)));

        File notDirectory = new File(root, "not-a-directory");
        assertTrue(notDirectory.createNewFile());
        assertFalse(SafLibrary.deleteResolvedDirectory(DocumentFile.fromFile(notDirectory)));
        assertTrue(notDirectory.exists());

        assertTrue(notDirectory.delete());
        assertTrue(root.delete());
    }

    private static Method assertSafeMethod() {
        try {
            Method method = SafLibrary.class.getDeclaredMethod("assertSafe", String.class);
            method.setAccessible(true);
            return method;
        } catch (NoSuchMethodException e) {
            throw new AssertionError(e);
        }
    }

    private static void assertSafe(String path) throws Exception {
        ASSERT_SAFE.invoke(null, path);
    }

    private static void assertSecurityException(String path, String message) throws Exception {
        try {
            assertSafe(path);
            fail("Expected SecurityException");
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            if (!(cause instanceof SecurityException)) {
                throw e;
            }
            assertEquals(message, cause.getMessage());
        }
    }
}
