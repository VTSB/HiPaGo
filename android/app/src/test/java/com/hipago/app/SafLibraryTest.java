package com.hipago.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileNotFoundException;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import android.content.Context;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;

import androidx.documentfile.provider.DocumentFile;
import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 34)
public class SafLibraryTest {
    private static final String PROVIDER_AUTHORITY = "com.hipago.test.documents";
    private static final Method ASSERT_SAFE = assertSafeMethod();
    private static final Method ASSERT_BELOW_ROOT = assertBelowRootMethod();

    private Context context;
    private FakeDocumentsProvider provider;
    private SafLibrary providerLibrary;

    @Before
    public void setUpProvider() {
        context = ApplicationProvider.getApplicationContext();
        ProviderInfo info = new ProviderInfo();
        info.authority = PROVIDER_AUTHORITY;
        info.exported = true;
        info.grantUriPermissions = true;
        info.readPermission = android.Manifest.permission.MANAGE_DOCUMENTS;
        info.writePermission = android.Manifest.permission.MANAGE_DOCUMENTS;
        provider = Robolectric.buildContentProvider(FakeDocumentsProvider.class).create(info).get();
        provider.reset();

        Uri tree = DocumentsContract.buildTreeDocumentUri(PROVIDER_AUTHORITY, FakeDocumentsProvider.ROOT_ID);
        Uri rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, FakeDocumentsProvider.ROOT_ID);
        DocumentFile root = DocumentFile.fromSingleUri(context, rootUri);
        providerLibrary = new SafLibrary(context) {
            @Override
            public synchronized DocumentFile rootDir() {
                return root;
            }
        };
    }

    @Test
    public void allowsRelativeDownloadPaths() throws Exception {
        assertSafe("HiPaGo");
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
        assertSecurityException(".", "path traversal");
        assertSecurityException("OtherSibling/x.webp", "path must be inside HiPaGo");
        assertSecurityException("HiPaGo2/x.webp", "path must be inside HiPaGo");
        assertSecurityException("HiPaGo/.", "path traversal");
        assertSecurityException("HiPaGo//x.webp", "path traversal");
        assertSecurityException("HiPaGo/x.webp/", "path traversal");
        assertSecurityException("HiPaGo\\x.webp", "path traversal");
        assertSecurityException("HiPaGo/\0x.webp", "path traversal");
    }

    @Test
    public void derivesFileAndTempNamesForSafPublish() {
        assertEquals("0001.webp", SafLibrary.fileNameForPath("HiPaGo/123/0001.webp"));
        assertEquals("0001.webp", SafLibrary.fileNameForPath("0001.webp"));

        assertEquals(".0001.webp.tmp-2a", SafLibrary.tempNameForPublish("0001.webp", 42L));
        assertEquals(".0001.webp.bak-2a", SafLibrary.backupNameForPublish("0001.webp", 42L));
    }

    @Test
    public void fileAndDeleteTargetsMustBeBelowLibraryRoot() throws Exception {
        assertBelowRoot("HiPaGo/123/0001.webp");
        assertBelowRootSecurityException("HiPaGo", "path must be below HiPaGo root");
        assertBelowRootSecurityException("OtherSibling", "path must be inside HiPaGo");
    }

    @Test
    public void copySourceMustBeCanonicalFileInsideAllowedCacheRoot() throws Exception {
        File root = Files.createTempDirectory("hipago-saf-copy").toFile();
        File imageCache = new File(root, "image-cache");
        File sibling = new File(root, "other");
        File prefixSibling = new File(root, "image-cache-evil");
        assertTrue(imageCache.mkdirs());
        assertTrue(sibling.mkdirs());
        assertTrue(prefixSibling.mkdirs());
        File allowed = new File(imageCache, "0001.webp");
        File outside = new File(sibling, "secret.db");
        File prefixed = new File(prefixSibling, "secret.db");
        assertTrue(allowed.createNewFile());
        assertTrue(outside.createNewFile());
        assertTrue(prefixed.createNewFile());

        assertEquals(allowed.getCanonicalFile(),
                SafLibrary.canonicalSourceWithin(imageCache, allowed.getAbsolutePath()));
        assertEquals(allowed.getCanonicalFile(),
                SafLibrary.canonicalSourceWithin(imageCache, allowed.toURI().toString()));

        assertSourceRejected(imageCache, outside.getAbsolutePath());
        assertSourceRejected(imageCache, prefixed.getAbsolutePath());
        assertSourceRejected(imageCache, imageCache.getAbsolutePath());
        assertSourceRejected(imageCache, "content://provider/document/secret");
        assertSourceRejected(imageCache, "https://example.test/image.webp");
        assertSourceRejected(imageCache, "file://remote-host/secret");
        assertSourceRejected(imageCache, allowed.toURI() + "?query=1");
        assertSourceRejected(imageCache, allowed.toURI() + "#fragment");
    }

    @Test
    public void statSeparatesPresentAbsentAndProviderFailure() throws Exception {
        SafLibrary.PathStat present = providerLibrary.stat("HiPaGo/gallery/0001.webp");
        assertTrue(present.exists);
        assertFalse(present.directory);
        assertEquals(123L, present.size);

        SafLibrary.PathStat absent = providerLibrary.stat("HiPaGo/gallery/missing.webp");
        assertFalse(absent.exists);
        assertEquals(0L, absent.size);

        provider.failQueries = true;
        assertProviderFailure(() -> providerLibrary.stat("HiPaGo/gallery/0001.webp"));
    }

    @Test
    public void mutationResolutionFailsClosedBeforeCreatingOrDeleting() throws Exception {
        provider.failQueries = true;

        assertProviderFailure(() -> providerLibrary.mkdir("HiPaGo/new-gallery"));

        assertEquals(0, provider.createCount);
        assertEquals(0, provider.deleteCount);
        assertEquals(0, provider.renameCount);
    }

    @Test
    public void mkdirUsesProviderBackedCreateAndVerification() throws Exception {
        assertTrue(providerLibrary.mkdir("HiPaGo/new-gallery"));
        assertEquals(1, provider.createCount);
        SafLibrary.PathStat created = providerLibrary.stat("HiPaGo/new-gallery");
        assertTrue(created.exists);
        assertTrue(created.directory);
    }

    @Test
    public void renamedCachedDirectoryIsResolvedAgainByExactPath() throws Exception {
        assertTrue(providerLibrary.mkdir("HiPaGo/gallery"));
        assertEquals(0, provider.createCount);

        provider.renameDocument(FakeDocumentsProvider.GALLERY_ID, "renamed-gallery");

        assertTrue(providerLibrary.mkdir("HiPaGo/gallery"));
        assertEquals(1, provider.createCount);
        assertTrue(providerLibrary.stat("HiPaGo/gallery").directory);
        assertTrue(providerLibrary.stat("HiPaGo/renamed-gallery").directory);
    }

    @Test
    public void listSeparatesExistingEmptyMissingAndProviderFailure() throws Exception {
        SafLibrary.DirectoryEntry[] empty = providerLibrary.listDir("HiPaGo/empty");
        assertTrue(empty != null);
        assertEquals(0, empty.length);

        assertNull(providerLibrary.listDir("HiPaGo/missing"));

        provider.failQueries = true;
        assertProviderFailure(() -> providerLibrary.listDir("HiPaGo/empty"));
    }

    @Test
    public void deleteRequiresConfirmedAbsenceAfterProviderCall() throws Exception {
        assertTrue(providerLibrary.delete("HiPaGo/gallery/missing.webp"));
        assertEquals(0, provider.deleteCount);

        assertTrue(providerLibrary.delete("HiPaGo/gallery/0001.webp"));
        assertEquals(1, provider.deleteCount);
        assertFalse(providerLibrary.stat("HiPaGo/gallery/0001.webp").exists);

        provider.reset();
        provider.noOpDelete = true;
        assertFalse(providerLibrary.delete("HiPaGo/gallery/0001.webp"));
        assertEquals(1, provider.deleteCount);

        provider.reset();
        provider.failDelete = true;
        assertProviderFailure(() -> providerLibrary.delete("HiPaGo/gallery/0001.webp"));

        provider.reset();
        provider.failQueryAfterDelete = true;
        assertProviderFailure(() -> providerLibrary.delete("HiPaGo/gallery/0001.webp"));
    }

    @Test
    public void recursiveDeleteCannotTargetLibraryRootOrSibling() throws Exception {
        assertOperationSecurityException(() -> providerLibrary.deleteDir("HiPaGo"));
        assertOperationSecurityException(() -> providerLibrary.deleteDir("OtherSibling"));
        assertOperationSecurityException(() -> providerLibrary.delete("HiPaGo"));
        assertEquals(0, provider.deleteCount);
    }

    @Test
    public void treeIdentityChangeInvalidatesRootAndDirectoryCaches() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        SafLibrary library = new SafLibrary(context);
        Uri firstTree = Uri.parse("content://provider/tree/first");
        Uri secondTree = Uri.parse("content://provider/tree/second");

        assertTrue(library.bindCacheToTree(firstTree));

        File root = Files.createTempDirectory("hipago-saf-cache").toFile();
        DocumentFile cachedRoot = DocumentFile.fromFile(root);
        cachedRootField().set(library, cachedRoot);
        directoryCache(library).put("HiPaGo", cachedRoot);

        // Rebinding the same tree preserves reusable handles.
        assertFalse(library.bindCacheToTree(firstTree));
        assertSame(cachedRoot, cachedRootField().get(library));
        assertEquals(1, directoryCache(library).size());

        // Simulate the plugin's separate SafLibrary instance changing the shared
        // preference. rootDir() must observe it before considering the old root.
        assertTrue(context.getSharedPreferences(SafLibrary.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(SafLibrary.KEY_TREE_URI, secondTree.toString())
                .commit());
        assertNull(library.rootDir()); // no persisted grant in this JVM test
        assertNull(cachedRootField().get(library));
        assertTrue(directoryCache(library).isEmpty());
        assertEquals(secondTree, cachedTreeUriField().get(library));

        library.clearTreeUri();
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

    private static Method assertBelowRootMethod() {
        try {
            Method method = SafLibrary.class.getDeclaredMethod("assertBelowLibraryRoot", String.class);
            method.setAccessible(true);
            return method;
        } catch (NoSuchMethodException e) {
            throw new AssertionError(e);
        }
    }

    private static Field cachedRootField() throws Exception {
        Field field = SafLibrary.class.getDeclaredField("cachedRoot");
        field.setAccessible(true);
        return field;
    }

    private static Field cachedTreeUriField() throws Exception {
        Field field = SafLibrary.class.getDeclaredField("cachedTreeUri");
        field.setAccessible(true);
        return field;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, DocumentFile> directoryCache(SafLibrary library) throws Exception {
        Field field = SafLibrary.class.getDeclaredField("dirCache");
        field.setAccessible(true);
        return (Map<String, DocumentFile>) field.get(library);
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

    private static void assertBelowRoot(String path) throws Exception {
        ASSERT_BELOW_ROOT.invoke(null, path);
    }

    private static void assertBelowRootSecurityException(String path, String message) throws Exception {
        try {
            assertBelowRoot(path);
            fail("Expected SecurityException");
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            if (!(cause instanceof SecurityException)) throw e;
            assertEquals(message, cause.getMessage());
        }
    }

    private static void assertSourceRejected(File allowedRoot, String source) throws Exception {
        try {
            SafLibrary.canonicalSourceWithin(allowedRoot, source);
            fail("Expected copy source rejection: " + source);
        } catch (SecurityException | java.io.FileNotFoundException expected) {
            // Expected security boundary rejection.
        } catch (Exception expected) {
            assertEquals("source file not found", expected.getMessage());
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    private static void assertProviderFailure(ThrowingRunnable operation) throws Exception {
        try {
            operation.run();
            fail("Expected SAF provider failure");
        } catch (SecurityException | IllegalStateException expected) {
            // Provider failures must propagate instead of becoming absent/empty.
        }
    }

    private static void assertOperationSecurityException(ThrowingRunnable operation) throws Exception {
        try {
            operation.run();
            fail("Expected SecurityException");
        } catch (SecurityException expected) {
            // Expected path-boundary rejection.
        }
    }

    /** In-memory DocumentsProvider used to exercise present/absent/error states. */
    public static class FakeDocumentsProvider extends DocumentsProvider {
        static final String ROOT_ID = "root";
        private static final String LIBRARY_ID = "library";
        private static final String GALLERY_ID = "gallery";
        private static final String IMAGE_ID = "image";
        private static final String EMPTY_ID = "empty";

        private static final String[] DEFAULT_COLUMNS = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_FLAGS
        };

        private final Map<String, FakeDocument> documents = new LinkedHashMap<>();
        boolean failQueries;
        boolean failDelete;
        boolean noOpDelete;
        boolean failQueryAfterDelete;
        int deleteCount;
        int createCount;
        int renameCount;

        @Override
        public boolean onCreate() {
            reset();
            return true;
        }

        void reset() {
            documents.clear();
            add(ROOT_ID, null, "root", DocumentsContract.Document.MIME_TYPE_DIR, 0L);
            add(LIBRARY_ID, ROOT_ID, "HiPaGo", DocumentsContract.Document.MIME_TYPE_DIR, 0L);
            add(GALLERY_ID, LIBRARY_ID, "gallery", DocumentsContract.Document.MIME_TYPE_DIR, 0L);
            add(IMAGE_ID, GALLERY_ID, "0001.webp", "image/webp", 123L);
            add(EMPTY_ID, LIBRARY_ID, "empty", DocumentsContract.Document.MIME_TYPE_DIR, 0L);
            failQueries = false;
            failDelete = false;
            noOpDelete = false;
            failQueryAfterDelete = false;
            deleteCount = 0;
            createCount = 0;
            renameCount = 0;
        }

        private void add(String id, String parentId, String name, String mimeType, long size) {
            documents.put(id, new FakeDocument(id, parentId, name, mimeType, size));
        }

        @Override
        public Cursor queryRoots(String[] projection) {
            return new MatrixCursor(projection != null ? projection : new String[0]);
        }

        @Override
        public Cursor queryDocument(String documentId, String[] projection)
                throws FileNotFoundException {
            failQueryIfRequested();
            FakeDocument document = documents.get(documentId);
            if (document == null) throw new FileNotFoundException(documentId);
            ArrayList<FakeDocument> rows = new ArrayList<>();
            rows.add(document);
            return cursor(projection, rows);
        }

        @Override
        public Cursor queryChildDocuments(
                String parentDocumentId,
                String[] projection,
                String sortOrder
        ) {
            failQueryIfRequested();
            ArrayList<FakeDocument> rows = new ArrayList<>();
            for (FakeDocument document : documents.values()) {
                if (parentDocumentId.equals(document.parentId)) rows.add(document);
            }
            return cursor(projection, rows);
        }

        @Override
        public ParcelFileDescriptor openDocument(
                String documentId,
                String mode,
                CancellationSignal signal
        ) throws FileNotFoundException {
            throw new FileNotFoundException(documentId);
        }

        @Override
        public String createDocument(String parentDocumentId, String mimeType, String displayName)
                throws FileNotFoundException {
            createCount++;
            if (!documents.containsKey(parentDocumentId)) {
                throw new FileNotFoundException(parentDocumentId);
            }
            String id = "created-" + createCount;
            add(id, parentDocumentId, displayName, mimeType, 0L);
            return id;
        }

        @Override
        public String renameDocument(String documentId, String displayName)
                throws FileNotFoundException {
            renameCount++;
            FakeDocument current = documents.get(documentId);
            if (current == null) throw new FileNotFoundException(documentId);
            documents.put(
                    documentId,
                    new FakeDocument(
                            current.id,
                            current.parentId,
                            displayName,
                            current.mimeType,
                            current.size
                    )
            );
            return documentId;
        }

        @Override
        public void deleteDocument(String documentId) throws FileNotFoundException {
            deleteCount++;
            if (failDelete) throw new SecurityException("provider delete failure");
            if (!documents.containsKey(documentId)) throw new FileNotFoundException(documentId);
            if (noOpDelete) return;

            ArrayList<String> pending = new ArrayList<>();
            pending.add(documentId);
            for (int i = 0; i < pending.size(); i++) {
                String parent = pending.get(i);
                for (FakeDocument document : new ArrayList<>(documents.values())) {
                    if (parent.equals(document.parentId)) pending.add(document.id);
                }
            }
            for (String id : pending) documents.remove(id);
            if (failQueryAfterDelete) failQueries = true;
        }

        @Override
        public boolean isChildDocument(String parentDocumentId, String documentId) {
            FakeDocument current = documents.get(documentId);
            while (current != null && current.parentId != null) {
                if (parentDocumentId.equals(current.parentId)) return true;
                current = documents.get(current.parentId);
            }
            return false;
        }

        private void failQueryIfRequested() {
            if (failQueries) throw new SecurityException("provider query failure");
        }

        private static Cursor cursor(String[] requested, List<FakeDocument> rows) {
            String[] columns = requested != null ? requested : DEFAULT_COLUMNS;
            MatrixCursor cursor = new MatrixCursor(columns);
            for (FakeDocument document : rows) {
                MatrixCursor.RowBuilder row = cursor.newRow();
                for (String column : columns) {
                    if (DocumentsContract.Document.COLUMN_DOCUMENT_ID.equals(column)) {
                        row.add(document.id);
                    } else if (DocumentsContract.Document.COLUMN_DISPLAY_NAME.equals(column)) {
                        row.add(document.name);
                    } else if (DocumentsContract.Document.COLUMN_MIME_TYPE.equals(column)) {
                        row.add(document.mimeType);
                    } else if (DocumentsContract.Document.COLUMN_SIZE.equals(column)) {
                        row.add(document.size);
                    } else if (DocumentsContract.Document.COLUMN_FLAGS.equals(column)) {
                        row.add(DocumentsContract.Document.FLAG_SUPPORTS_DELETE);
                    } else {
                        row.add(null);
                    }
                }
            }
            return cursor;
        }

        private static final class FakeDocument {
            final String id;
            final String parentId;
            final String name;
            final String mimeType;
            final long size;

            FakeDocument(String id, String parentId, String name, String mimeType, long size) {
                this.id = id;
                this.parentId = parentId;
                this.name = name;
                this.mimeType = mimeType;
                this.size = size;
            }
        }
    }
}
