package com.hipago.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsProvider;

import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowContentResolver;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, manifest = Config.NONE, shadows = SafLibraryProviderTest.ProviderContentResolver.class)
public class SafLibraryProviderTest {
    private static final String AUTHORITY = "com.hipago.test.documents";
    private static final String ROOT = "volume:chosen";
    private static final int GRANTS = Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private Context context;
    private CountingProvider provider;
    private SafLibrary saf;
    private Uri tree;

    @Before
    public void setUp() throws Exception {
        // URI access itself is allowed in the fixture; SafLibrary must still
        // enforce the real ContentResolver persisted-grant list on every call.
        context = new ContextWrapper(RuntimeEnvironment.getApplication()) {
            @Override public Context getApplicationContext() { return this; }
            @Override public int checkCallingOrSelfUriPermission(Uri uri, int modeFlags) {
                return PackageManager.PERMISSION_GRANTED;
            }
        };
        context.getSharedPreferences(SafLibrary.PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        ProviderInfo info = new ProviderInfo();
        info.name = CountingProvider.class.getName();
        info.packageName = context.getPackageName();
        info.authority = AUTHORITY;
        info.exported = true;
        info.grantUriPermissions = true;
        info.readPermission = "android.permission.MANAGE_DOCUMENTS";
        info.writePermission = "android.permission.MANAGE_DOCUMENTS";
        ResolveInfo resolved = new ResolveInfo();
        resolved.providerInfo = info;
        Shadows.shadowOf(context.getPackageManager()).addResolveInfoForIntent(
                new Intent(DocumentsContract.PROVIDER_INTERFACE), resolved);
        provider = new CountingProvider();
        provider.attachInfo(context, info);
        ShadowContentResolver.registerProviderInternal(AUTHORITY, provider);
        provider.add(ROOT, null, "Chosen", Document.MIME_TYPE_DIR, null);
        provider.add("opaque:library", ROOT, "HiPaGo", Document.MIME_TYPE_DIR, null);
        provider.add("opaque:gallery/%", "opaque:library", "123 Title", Document.MIME_TYPE_DIR, null);
        tree = DocumentsContract.buildTreeDocumentUri(AUTHORITY, ROOT);
        context.getContentResolver().takePersistableUriPermission(tree, GRANTS);
        saf = new SafLibrary(context);
        saf.setTreeUri(tree);
    }

    @Test
    public void lookupQueryCountDoesNotGrowWithSiblingCountAndKeepsTreeDocumentId() throws Exception {
        provider.add("opaque:file/001", "opaque:gallery/%", "0001.webp", "image/webp", "image");
        Uri expected = DocumentsContract.buildDocumentUriUsingTree(tree, "opaque:file/001");
        assertEquals(expected, saf.getUri("HiPaGo/123 Title/0001.webp"));
        provider.resetQueries();
        assertEquals(expected, saf.getUri("HiPaGo/123 Title/0001.webp"));
        int smallCount = provider.queryCount;
        for (int i = 0; i < 1000; i++) {
            provider.add("sibling:" + i, "opaque:gallery/%", "other" + i, "image/webp", null);
            provider.add("gallery:" + i, "opaque:library", "Other " + i, Document.MIME_TYPE_DIR, null);
        }
        // Move the target to the end to require scanning all rows.
        provider.nodes.put("opaque:file/001", provider.nodes.remove("opaque:file/001"));
        provider.nodes.put("opaque:gallery/%", provider.nodes.remove("opaque:gallery/%"));
        provider.resetQueries();
        assertEquals(expected, saf.getUri("HiPaGo/123 Title/0001.webp"));
        assertEquals(smallCount, provider.queryCount);
        assertEquals(3, provider.childQueries.size());
        for (List<String> columns : provider.childQueries) {
            assertEquals(Arrays.asList(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME), columns);
        }
    }

    @Test
    public void listingReadsAllMetadataInOneQueryWithoutPerEntryRequests() throws Exception {
        for (int i = 0; i < 1000; i++) {
            provider.add("page:" + i, "opaque:gallery/%", "page" + i, "image/webp", "bytes");
        }
        provider.add("subdir", "opaque:gallery/%", "Directory", Document.MIME_TYPE_DIR, "ignored");
        provider.add("unknown", "opaque:gallery/%", "Unknown", null, "ignored");
        provider.add("nullsize", "opaque:gallery/%", "Null size", "image/webp", null);
        provider.add("nameless", "opaque:gallery/%", null, "image/webp", "bytes");
        provider.resetQueries();
        List<SafLibrary.DirectoryEntry> entries = saf.listDir("HiPaGo/123 Title");
        assertEquals(1003, entries.size());
        assertEquals("page0", entries.get(0).name);
        assertEquals(5, entries.get(0).size);
        assertEquals(0, entries.get(1000).size);
        assertEquals(0, entries.get(1001).size);
        assertEquals(0, entries.get(1002).size);
        assertEquals(3, provider.childQueries.size());
        assertEquals(Arrays.asList(Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE),
                provider.childQueries.get(2));
        assertTrue("metadata queries must not grow with file count", provider.queryCount < 20);
        assertEquals(provider.cursorCount, provider.closedCursorCount);
    }

    @Test
    public void namesAreCaseSensitiveAndExternalRenamesAndDeletesAreFresh() throws Exception {
        provider.add("page", "opaque:gallery/%", "0001.webp", "image/webp", "bytes");
        assertNull(saf.getUri("HiPaGo/123 title/0001.webp"));
        assertNull(saf.getUri("HiPaGo/123 Title/0001.WEBP"));
        assertTrue(saf.exists("HiPaGo/123 Title/0001.webp"));
        provider.nodes.get("opaque:gallery/%").name = "Renamed";
        assertNull(saf.getUri("HiPaGo/123 Title/0001.webp"));
        assertTrue(saf.exists("HiPaGo/Renamed/0001.webp"));
        provider.nodes.remove("page");
        assertFalse(saf.exists("HiPaGo/Renamed/0001.webp"));
    }

    @Test
    public void missingAndRevokedGrantsNeverReuseResolvedHandles() throws Exception {
        provider.add("page", "opaque:gallery/%", "0001.webp", "image/webp", "bytes");
        assertTrue(saf.exists("HiPaGo/123 Title/0001.webp"));
        context.getContentResolver().releasePersistableUriPermission(tree, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        provider.resetQueries();
        assertNull(saf.getUri("HiPaGo/123 Title/0001.webp"));
        assertNull(saf.listDir("HiPaGo/123 Title"));
        assertFalse(saf.exists("HiPaGo/123 Title/0001.webp"));
        assertEquals(0, provider.queryCount);
        saf.clearTreeUri();
        assertFalse(saf.hasTree());
    }

    @Test
    public void anotherInstanceChangingTheTreeCannotReuseOldRoot() throws Exception {
        provider.add("second-root", null, "Second", Document.MIME_TYPE_DIR, null);
        provider.add("old", ROOT, "same.json", "application/json", "old");
        provider.add("new", "second-root", "same.json", "application/json", "new");
        assertEquals("old", DocumentsContract.getDocumentId(saf.getUri("same.json")));
        Uri secondTree = DocumentsContract.buildTreeDocumentUri(AUTHORITY, "second-root");
        context.getContentResolver().takePersistableUriPermission(secondTree, GRANTS);
        new SafLibrary(context).setTreeUri(secondTree);
        assertEquals(DocumentsContract.buildDocumentUriUsingTree(secondTree, "new"), saf.getUri("same.json"));
    }

    @Test
    public void nestedCreationReadOverwriteAndCopyPublishStayInSelectedDirectory() throws Exception {
        saf.writeBytes("HiPaGo/New/0000.json", "manifest".getBytes(StandardCharsets.UTF_8));
        saf.writeBytes("HiPaGo/New/0000.json", "{}".getBytes(StandardCharsets.UTF_8));
        assertArrayEquals("{}".getBytes(StandardCharsets.UTF_8), saf.readBytes("HiPaGo/New/0000.json"));
        assertEquals(1, saf.listDir("HiPaGo/New").size());
        File source = File.createTempFile("saf-copy", ".webp", context.getCacheDir());
        Files.write(source.toPath(), "complete image".getBytes(StandardCharsets.UTF_8));
        assertEquals(source.length(), saf.copyFromFile(source.getPath(), "HiPaGo/New/0001.webp"));
        assertArrayEquals(Files.readAllBytes(source.toPath()), saf.readBytes("HiPaGo/New/0001.webp"));
        assertEquals(2, saf.listDir("HiPaGo/New").size());
        assertEquals(1, saf.listDir("").size());
    }

    @Test
    public void unsafeDirectoryPathsCannotCreateOrListOutsideTree() {
        for (String path : Arrays.asList("/HiPaGo", "HiPaGo/../Elsewhere")) {
            try { saf.mkdir(path); fail("Expected rejected mkdir"); }
            catch (SecurityException expected) { /* expected */ }
            try { saf.listDir(path); fail("Expected rejected listing"); }
            catch (SecurityException expected) { /* expected */ }
        }
        assertEquals(3, provider.nodes.size());
    }

    @Test
    public void failedChildQueryDoesNotLookMissingAndCreateDuplicateDocuments() throws Exception {
        provider.failChildren = true;
        try {
            saf.writeBytes("HiPaGo/new.json", new byte[] { 1 });
            fail("Expected query failure");
        } catch (IllegalStateException expected) {
            assertEquals("Unable to query directory", expected.getMessage());
        }
        assertEquals(3, provider.nodes.size());
    }

    @Implements(ContentResolver.class)
    public static class ProviderContentResolver extends ShadowContentResolver {
        @Implementation
        protected Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
            // Robolectric 4.12 calls the provider's legacy query directly. Real
            // Android converts this call to Bundle arguments in its transport;
            // modern DocumentsProvider deliberately rejects the legacy form.
            Bundle args = new Bundle();
            args.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
            args.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs);
            args.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sortOrder);
            return super.query(uri, projection, args, null);
        }
    }

    public static class CountingProvider extends DocumentsProvider {
        final Map<String, Node> nodes = new LinkedHashMap<>();
        final List<List<String>> childQueries = new ArrayList<>();
        int queryCount;
        int cursorCount;
        int closedCursorCount;
        boolean failChildren;
        int sequence;

        void add(String id, String parent, String name, String mime, String bytes) throws Exception {
            File file = File.createTempFile("saf-node", ".bin", getContext().getCacheDir());
            if (bytes != null) Files.write(file.toPath(), bytes.getBytes(StandardCharsets.UTF_8));
            nodes.put(id, new Node(id, parent, name, mime, file, bytes == null));
        }

        void resetQueries() { queryCount = 0; childQueries.clear(); }
        @Override public boolean onCreate() { return true; }
        @Override public Cursor queryRoots(String[] projection) { return new MatrixCursor(new String[0]); }

        @Override public Cursor queryDocument(String documentId, String[] projection) {
            queryCount++;
            MatrixCursor cursor = cursor(projection);
            Node node = nodes.get(documentId);
            if (node != null) addRow(cursor, projection, node);
            return cursor;
        }

        @Override public Cursor queryChildDocuments(String parentDocumentId, String[] projection, String sortOrder) {
            queryCount++;
            childQueries.add(Arrays.asList(projection.clone()));
            if (failChildren) return null;
            MatrixCursor cursor = cursor(projection);
            for (Node node : nodes.values()) {
                if (parentDocumentId.equals(node.parent)) addRow(cursor, projection, node);
            }
            return cursor;
        }

        private MatrixCursor cursor(String[] projection) {
            cursorCount++;
            return new MatrixCursor(projection) {
                @Override public void close() {
                    if (!isClosed()) closedCursorCount++;
                    super.close();
                }
            };
        }

        private void addRow(MatrixCursor cursor, String[] projection, Node node) {
            Object[] values = new Object[projection.length];
            for (int i = 0; i < projection.length; i++) {
                switch (projection[i]) {
                    case Document.COLUMN_DOCUMENT_ID: values[i] = node.id; break;
                    case Document.COLUMN_DISPLAY_NAME: values[i] = node.name; break;
                    case Document.COLUMN_MIME_TYPE: values[i] = node.mime; break;
                    case Document.COLUMN_SIZE: values[i] = node.unknownSize ? null : node.file.length(); break;
                    case Document.COLUMN_FLAGS: values[i] = Document.FLAG_SUPPORTS_WRITE | Document.FLAG_DIR_SUPPORTS_CREATE; break;
                    default: values[i] = null;
                }
            }
            cursor.addRow(values);
        }

        @Override public boolean isChildDocument(String parentDocumentId, String documentId) {
            Node node = nodes.get(documentId);
            while (node != null && node.parent != null) {
                if (parentDocumentId.equals(node.parent)) return true;
                node = nodes.get(node.parent);
            }
            return false;
        }

        @Override public ParcelFileDescriptor openDocument(String documentId, String mode, CancellationSignal signal)
                throws FileNotFoundException {
            Node node = nodes.get(documentId);
            if (node == null) throw new FileNotFoundException(documentId);
            if (mode.contains("w")) node.unknownSize = false;
            return ParcelFileDescriptor.open(node.file, ParcelFileDescriptor.parseMode(mode));
        }

        @Override public String createDocument(String parentId, String mime, String name) throws FileNotFoundException {
            String id = "created:" + (++sequence);
            try { add(id, parentId, name, mime, ""); }
            catch (Exception e) { throw new FileNotFoundException(e.getMessage()); }
            return id;
        }

        @Override public String renameDocument(String id, String name) { nodes.get(id).name = name; return id; }
        @Override public void deleteDocument(String id) { nodes.remove(id); }
    }

    private static class Node {
        final String id;
        final String parent;
        String name;
        final String mime;
        final File file;
        boolean unknownSize;
        Node(String id, String parent, String name, String mime, File file, boolean unknownSize) {
            this.id = id; this.parent = parent; this.name = name; this.mime = mime;
            this.file = file; this.unknownSize = unknownSize;
        }
    }
}
