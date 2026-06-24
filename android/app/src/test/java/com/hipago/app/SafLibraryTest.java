package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

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
