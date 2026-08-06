package com.hipago.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;

import androidx.documentfile.provider.DocumentFile;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Shared Storage Access Framework (SAF) file helper.
 *
 * Holds the SAF tree-resolution + write/copy/read/exists/mkdir logic that used
 * to be private to {@link PublicLibraryPlugin}, so BOTH the plugin (on the
 * Capacitor activity context) and {@link GalleryDownloadWorker} (on the worker's
 * application context) write to the IDENTICAL location with IDENTICAL semantics.
 *
 * Model: the user picks ONE parent folder via {@code ACTION_OPEN_DOCUMENT_TREE}
 * (in the plugin) and we persist that tree's URI in SharedPreferences
 * ({@link #PREFS}/{@link #KEY_TREE_URI}). Every method here takes a RELATIVE path
 * under that tree (e.g. {@code "HiPaGo/12345 Title/0001.webp"}) and resolves it
 * to a {@code content://} document URI via DocumentFile.
 *
 * Construct ONE instance per logical unit of work (the plugin keeps a single
 * long-lived instance; the worker creates a fresh one per run). Each instance is
 * single-thread-disciplined by its caller: {@link PublicLibraryPlugin} serializes
 * all ops on its single-thread executor, and {@link GalleryDownloadWorker} is
 * itself sequential (one gallery, one page at a time). The {@link #dirCache} is a
 * ConcurrentHashMap so it stays safe even if a caller ever parallelizes.
 *
 * JVM tests cover provider present/absent/error distinctions. Persisted-grant
 * behavior with a real third-party DocumentsProvider still requires device QA.
 */
public class SafLibrary {

    static final String PREFS = "hipago_download_tree";
    static final String KEY_TREE_URI = "tree_uri";
    static final String LIBRARY_ROOT = "HiPaGo";
    static final String IMAGE_CACHE_ROOT = "image-cache";

    private static final String[] DOCUMENT_PROJECTION = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
    };

    private final Context context;

    /** relative dir path ("HiPaGo/12345 Title") → resolved DocumentFile. */
    private final Map<String, Uri> dirCache = new ConcurrentHashMap<>();

    /** Cached tree root DocumentFile so per-file ops skip repeated resolution. */
    private volatile DocumentFile cachedRoot;

    /** URI that owns cachedRoot and every entry in dirCache. */
    private volatile Uri cachedTreeUri;

    /** Immutable provider metadata. A missing row is represented by null; errors throw. */
    private static final class DocumentEntry {
        final Uri uri;
        final String name;
        final String mimeType;
        final long size;

        DocumentEntry(Uri uri, String name, String mimeType, long size) {
            this.uri = uri;
            this.name = name;
            this.mimeType = mimeType;
            this.size = size;
        }

        boolean isDirectory() {
            return DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType);
        }

        boolean isFile() {
            return !isDirectory();
        }
    }

    /** Stat result with absence kept separate from provider/query failures. */
    public static final class PathStat {
        private static final PathStat ABSENT = new PathStat(false, false, 0L);

        public final boolean exists;
        public final boolean directory;
        public final long size;

        private PathStat(boolean exists, boolean directory, long size) {
            this.exists = exists;
            this.directory = directory;
            this.size = size;
        }

        static PathStat absent() {
            return ABSENT;
        }

        static PathStat present(DocumentEntry entry) {
            return new PathStat(true, entry.isDirectory(), entry.isFile() ? entry.size : 0L);
        }
    }

    /** Directory metadata returned without DocumentFile's exception-swallowing accessors. */
    public static final class DirectoryEntry {
        public final String name;
        public final boolean file;
        public final long size;

        private DirectoryEntry(DocumentEntry entry) {
            this.name = entry.name;
            this.file = entry.isFile();
            this.size = file ? entry.size : 0L;
        }
    }

    /**
     * @param context any Context whose application can read the persisted tree
     *                permission — the Capacitor activity OR the worker's
     *                applicationContext both work (the grant is process-wide).
     */
    public SafLibrary(Context context) {
        // Use the application context to avoid leaking a short-lived context and
        // to stay valid for the lifetime of a background worker.
        this.context = context.getApplicationContext();
    }

    // -----------------------------------------------------------------------
    // Tree (persisted folder) resolution
    // -----------------------------------------------------------------------

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** The persisted tree URI, or null when no folder has been picked. */
    public Uri getTreeUri() {
        String s = prefs().getString(KEY_TREE_URI, null);
        return s == null ? null : Uri.parse(s);
    }

    /** Persist the tree URI (called by the plugin after the user picks a folder). */
    public synchronized void setTreeUri(Uri tree) {
        prefs().edit().putString(KEY_TREE_URI, tree.toString()).apply();
        invalidate();
    }

    /** Forget the tree URI (called by the plugin's clearTree). */
    public synchronized void clearTreeUri() {
        prefs().edit().remove(KEY_TREE_URI).apply();
        invalidate();
    }

    /** Drop cached handles — call after the tree changes. */
    public synchronized void invalidate() {
        cachedTreeUri = null;
        clearCachedHandles();
    }

    private void clearCachedHandles() {
        dirCache.clear();
        cachedRoot = null;
    }

    /**
     * Bind all cached DocumentFile handles to one persisted tree URI. The worker
     * and Capacitor plugin keep separate SafLibrary instances, so a tree change
     * can arrive through SharedPreferences without invoking invalidate() here.
     *
     * @return true when the identity changed and cached handles were discarded.
     *         Package-private for the JVM cache-identity contract test.
     */
    synchronized boolean bindCacheToTree(Uri tree) {
        if (Objects.equals(cachedTreeUri, tree)) return false;
        clearCachedHandles();
        cachedTreeUri = tree;
        return true;
    }

    /**
     * The tree root for file ops. Cached after first resolution, but guarded by
     * the persisted write grant and a direct provider query so query failures do
     * not collapse into the same state as a genuinely missing/revoked tree.
     */
    public synchronized DocumentFile rootDir() {
        Uri tree = getTreeUri();
        bindCacheToTree(tree);
        if (tree == null) return null;
        if (!hasPersistedWritePermission(tree)) {
            clearCachedHandles();
            return null;
        }
        if (cachedRoot != null) {
            DocumentEntry rootEntry = queryDocument(cachedRoot.getUri());
            if (rootEntry == null) {
                clearCachedHandles();
                return null;
            }
            if (!rootEntry.isDirectory()) {
                throw new IllegalStateException("SAF tree root is not a directory");
            }
            Uri currentTree = getTreeUri();
            if (tree.equals(currentTree)) return cachedRoot;
            bindCacheToTree(currentTree);
            return null;
        }
        DocumentFile root = DocumentFile.fromTreeUri(context, tree);
        if (root == null) return null;
        DocumentEntry rootEntry = queryDocument(root.getUri());
        if (rootEntry == null) return null;
        if (!rootEntry.isDirectory()) {
            throw new IllegalStateException("SAF tree root is not a directory");
        }
        Uri currentTree = getTreeUri();
        if (!tree.equals(currentTree)) {
            bindCacheToTree(currentTree);
            return null;
        }
        cachedRoot = root;
        return root;
    }

    /** Whether a writable tree is currently available. */
    public boolean hasTree() {
        return rootDir() != null;
    }

    private boolean hasPersistedWritePermission(Uri tree) {
        ContentResolver cr = context.getContentResolver();
        List<UriPermission> perms = cr.getPersistedUriPermissions();
        for (UriPermission p : perms) {
            if (p.getUri().equals(tree) && p.isWritePermission()) {
                return true;
            }
        }
        return false;
    }

    // -----------------------------------------------------------------------
    // Path resolution helpers (relative path under the tree → DocumentFile)
    // -----------------------------------------------------------------------

    /**
     * Accept only canonical relative paths inside the app-owned HiPaGo child of
     * the user-selected tree. Rejecting empty and dot segments avoids multiple
     * spellings of the same provider document at the security boundary.
     */
    private static void assertSafe(String relPath) {
        if (relPath == null || relPath.isEmpty()) {
            throw new SecurityException("path is required");
        }
        if (relPath.startsWith("/") || relPath.indexOf('\\') >= 0 || relPath.indexOf('\0') >= 0) {
            throw new SecurityException("path traversal");
        }
        String[] segments = relPath.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) {
                throw new SecurityException("path traversal");
            }
        }
        if (segments.length == 0 || !LIBRARY_ROOT.equals(segments[0])) {
            throw new SecurityException("path must be inside HiPaGo");
        }
    }

    /** Destructive calls may never target the app-owned library root itself. */
    private static void assertDeletable(String relPath) {
        assertBelowLibraryRoot(relPath);
    }

    /** File writes/copies/deletes must target an entry below, never the root. */
    private static void assertBelowLibraryRoot(String relPath) {
        assertSafe(relPath);
        if (LIBRARY_ROOT.equals(relPath)) {
            throw new SecurityException("path must be below HiPaGo root");
        }
    }

    /**
     * Query children directly so provider exceptions stay exceptions. By
     * contrast, DocumentFile.findFile/listFiles/exists convert several provider
     * failures into null, false, or an empty array, which is indistinguishable
     * from a genuinely absent document.
     */
    private List<DocumentEntry> queryChildren(Uri parentUri) {
        String parentId = DocumentsContract.getDocumentId(parentUri);
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(parentUri, parentId);
        ContentResolver resolver = context.getContentResolver();
        ArrayList<DocumentEntry> entries = new ArrayList<>();
        Cursor queried;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            queried = resolver.query(childrenUri, DOCUMENT_PROJECTION, Bundle.EMPTY, null);
        } else {
            queried = resolver.query(childrenUri, DOCUMENT_PROJECTION, null, null, null);
        }
        try (Cursor cursor = queried) {
            if (cursor == null) {
                throw new IllegalStateException("SAF provider returned a null cursor");
            }
            int idColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_SIZE);
            while (cursor.moveToNext()) {
                String id = cursor.getString(idColumn);
                String name = cursor.getString(nameColumn);
                String mime = cursor.getString(mimeColumn);
                if (id == null || name == null || mime == null) {
                    throw new IllegalStateException("SAF provider returned malformed metadata");
                }
                long size = cursor.isNull(sizeColumn) ? 0L : Math.max(0L, cursor.getLong(sizeColumn));
                Uri uri = DocumentsContract.buildDocumentUriUsingTree(parentUri, id);
                entries.add(new DocumentEntry(uri, name, mime, size));
            }
        }
        return entries;
    }

    /** Query one known document URI without DocumentFile's exception collapsing. */
    private DocumentEntry queryDocument(Uri documentUri) {
        ContentResolver resolver = context.getContentResolver();
        Cursor queried;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            queried = resolver.query(documentUri, DOCUMENT_PROJECTION, Bundle.EMPTY, null);
        } else {
            queried = resolver.query(documentUri, DOCUMENT_PROJECTION, null, null, null);
        }
        try (Cursor cursor = queried) {
            if (cursor == null) {
                throw new IllegalStateException("SAF provider returned a null cursor");
            }
            if (!cursor.moveToFirst()) return null;
            int idColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            int mimeColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_MIME_TYPE);
            int sizeColumn = cursor.getColumnIndexOrThrow(
                    DocumentsContract.Document.COLUMN_SIZE);
            String id = cursor.getString(idColumn);
            String name = cursor.getString(nameColumn);
            String mime = cursor.getString(mimeColumn);
            if (id == null || name == null || mime == null) {
                throw new IllegalStateException("SAF provider returned malformed metadata");
            }
            long size = cursor.isNull(sizeColumn) ? 0L : Math.max(0L, cursor.getLong(sizeColumn));
            Uri uri = DocumentsContract.buildDocumentUriUsingTree(documentUri, id);
            if (cursor.moveToNext()) {
                throw new IllegalStateException("SAF provider returned duplicate document rows");
            }
            return new DocumentEntry(uri, name, mime, size);
        }
    }

    /** null means confirmed absent; provider and cursor failures propagate. */
    private DocumentEntry findChild(Uri parentUri, String name) {
        DocumentEntry match = null;
        for (DocumentEntry entry : queryChildren(parentUri)) {
            if (!name.equals(entry.name)) continue;
            if (match != null) {
                throw new IllegalStateException("SAF provider returned duplicate child names");
            }
            match = entry;
        }
        return match;
    }

    private static boolean sameDocument(Uri left, Uri right) {
        return left != null
                && right != null
                && Objects.equals(left.getAuthority(), right.getAuthority())
                && Objects.equals(
                        DocumentsContract.getDocumentId(left),
                        DocumentsContract.getDocumentId(right)
                );
    }

    private DocumentEntry createChild(Uri parentUri, String mimeType, String name) throws Exception {
        Uri created = DocumentsContract.createDocument(
                context.getContentResolver(),
                parentUri,
                mimeType,
                name
        );
        if (created == null) throw new Exception("SAF provider create returned null");
        DocumentEntry createdEntry = queryDocument(created);
        if (createdEntry == null || !name.equals(createdEntry.name)) {
            throw new Exception("SAF provider created an unexpected document");
        }
        DocumentEntry confirmed = findChild(parentUri, name);
        if (confirmed == null || !sameDocument(created, confirmed.uri)) {
            throw new Exception("SAF provider did not publish created document");
        }
        return confirmed;
    }

    private void deleteChild(Uri parentUri, DocumentEntry child) throws Exception {
        boolean deleted = DocumentsContract.deleteDocument(context.getContentResolver(), child.uri);
        DocumentEntry remaining = findChild(parentUri, child.name);
        if (!deleted || remaining != null) {
            throw new Exception("SAF provider delete was not durable: " + child.name);
        }
    }

    private DocumentEntry renameChild(
            Uri parentUri,
            DocumentEntry child,
            String newName
    ) throws Exception {
        Uri renamed = DocumentsContract.renameDocument(
                context.getContentResolver(),
                child.uri,
                newName
        );
        if (renamed == null) throw new Exception("SAF provider rename returned null");
        DocumentEntry renamedEntry = queryDocument(renamed);
        if (renamedEntry == null || !newName.equals(renamedEntry.name)) {
            throw new Exception("SAF provider renamed to an unexpected document");
        }
        if (findChild(parentUri, child.name) != null) {
            throw new Exception("SAF provider retained old name after rename");
        }
        DocumentEntry confirmed = findChild(parentUri, newName);
        if (confirmed == null || !sameDocument(renamed, confirmed.uri)) {
            throw new Exception("SAF provider did not publish renamed document");
        }
        return confirmed;
    }

    /** Resolve one validated app path without DocumentFile's absent/error collapse. */
    private DocumentEntry resolveExisting(String relPath) {
        assertSafe(relPath);
        DocumentFile root = rootDir();
        if (root == null) throw new IllegalStateException("NO_TREE");

        Uri parentUri = root.getUri();
        String[] segments = relPath.split("/", -1);
        DocumentEntry current = null;
        for (int i = 0; i < segments.length; i++) {
            current = findChild(parentUri, segments[i]);
            if (current == null) return null;
            if (i + 1 < segments.length && !current.isDirectory()) return null;
            parentUri = current.uri;
        }
        return current;
    }

    /**
     * Resolve a relative DIRECTORY path under the tree.
     *
     * @param create create missing directories when true; return null on first
     *               missing segment when false.
     */
    private DocumentEntry resolveDir(String relDirPath, boolean create) throws Exception {
        assertSafe(relDirPath);
        DocumentFile root = rootDir();
        if (root == null) return null;

        Uri cachedUri = dirCache.get(relDirPath);
        if (cachedUri != null) {
            DocumentEntry cached = queryDocument(cachedUri);
            if (cached != null) {
                if (!cached.isDirectory()) {
                    throw new Exception("cached SAF path is not a directory: " + relDirPath);
                }
                if (fileNameForPath(relDirPath).equals(cached.name)) return cached;
            }
            dirCache.remove(relDirPath, cachedUri);
        }

        Uri parentUri = root.getUri();
        DocumentEntry current = null;
        StringBuilder built = new StringBuilder();
        for (String segment : relDirPath.split("/", -1)) {
            if (built.length() > 0) built.append('/');
            built.append(segment);
            String key = built.toString();

            current = findChild(parentUri, segment);
            if (current == null) {
                if (!create) return null;
                current = createChild(
                        parentUri,
                        DocumentsContract.Document.MIME_TYPE_DIR,
                        segment
                );
            }
            if (!current.isDirectory()) {
                throw new Exception("SAF path component is not a directory: " + key);
            }
            parentUri = current.uri;
            dirCache.put(key, current.uri);
        }
        return current;
    }

    private static int lastSlash(String p) {
        return p.lastIndexOf('/');
    }

    static String fileNameForPath(String relPath) {
        int idx = lastSlash(relPath);
        return idx < 0 ? relPath : relPath.substring(idx + 1);
    }

    static String tempNameForPublish(String finalName, long nonce) {
        return "." + finalName + ".tmp-" + Long.toHexString(nonce);
    }

    static String backupNameForPublish(String finalName, long nonce) {
        return "." + finalName + ".bak-" + Long.toHexString(nonce);
    }

    private static String mimeFor(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".avif")) return "image/avif";
        if (lower.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    /**
     * Resolve (creating parents) the destination document URI for a relative
     * file path. Reuses an existing document of the same name (so overwrites
     * truncate in place instead of creating "name (1)").
     */
    private Uri ensureFileUri(String relPath) throws Exception {
        assertBelowLibraryRoot(relPath);
        int idx = lastSlash(relPath);
        String dirPart = idx < 0 ? "" : relPath.substring(0, idx);
        String name = idx < 0 ? relPath : relPath.substring(idx + 1);
        DocumentEntry dir = resolveDir(dirPart, true);
        if (dir == null) return null;
        DocumentEntry existing = findChild(dir.uri, name);
        if (existing != null) {
            if (!existing.isFile()) throw new Exception("destination is not a file: " + relPath);
            return existing.uri;
        }
        return createChild(dir.uri, mimeFor(name), name).uri;
    }

    // -----------------------------------------------------------------------
    // File operations (all relative paths under the tree)
    // -----------------------------------------------------------------------

    /** Create a directory and all parents. Returns false when no tree / failure. */
    public boolean mkdir(String relDirPath) throws Exception {
        assertSafe(relDirPath);
        if (rootDir() == null) return false;
        return resolveDir(relDirPath, true) != null;
    }

    /** Stat a path; absence is a value while provider/query failure is an exception. */
    public PathStat stat(String relPath) {
        DocumentEntry entry = resolveExisting(relPath);
        return entry == null ? PathStat.absent() : PathStat.present(entry);
    }

    /** Whether a relative path (file or directory) currently exists. */
    public boolean exists(String relPath) {
        return stat(relPath).exists;
    }

    /**
     * Write bytes to a relative file path, truncating an existing file in place
     * ("wt"). Creates parent directories as needed.
     */
    public void writeBytes(String relPath, byte[] data) throws Exception {
        assertBelowLibraryRoot(relPath);
        if (rootDir() == null) throw new Exception("NO_TREE");
        Uri uri = ensureFileUri(relPath);
        if (uri == null) throw new Exception("writeBytes create failed: " + relPath);
        ContentResolver cr = context.getContentResolver();
        try (OutputStream os = cr.openOutputStream(uri, "wt")) {
            if (os == null) throw new Exception("openOutputStream returned null");
            os.write(data);
            os.flush();
        }
    }

    /** Read all bytes of a relative file path, or null when missing. */
    public byte[] readBytes(String relPath) throws Exception {
        DocumentEntry file = resolveExisting(relPath);
        if (file == null || !file.isFile()) return null;
        ContentResolver cr = context.getContentResolver();
        try (InputStream is = cr.openInputStream(file.uri);
             java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream()) {
            if (is == null) throw new Exception("openInputStream returned null");
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    /**
     * Copy a LOCAL source file (absolute or {@code file://} path, e.g. a temp in
     * the cache dir) into the tree at relative {@code toRelPath}. The source stays
     * a normal File; only the destination is a content URI. Writes go to a sibling
     * temp document first, then publish by rename so a killed provider write does
     * not leave partial bytes under the final filename. Returns bytes written.
     */
    static File canonicalSourceWithin(File allowedRoot, String from) throws Exception {
        if (from == null) throw new Exception("from is required");
        String srcPath;
        Uri parsed = Uri.parse(from);
        if (parsed.getScheme() != null && !new File(from).isAbsolute()) {
            if (!"file".equals(parsed.getScheme()) || (parsed.getAuthority() != null
                    && !parsed.getAuthority().isEmpty()) || parsed.getQuery() != null
                    || parsed.getFragment() != null) {
                throw new SecurityException("copy source must be a local app-cache file");
            }
            srcPath = parsed.getPath();
        } else {
            srcPath = from;
        }
        if (srcPath == null || srcPath.isEmpty()) throw new Exception("source file not found");

        File root = allowedRoot.getCanonicalFile();
        File src = new File(srcPath).getCanonicalFile();
        String rootPrefix = root.getPath() + File.separator;
        if (!src.equals(root) && !src.getPath().startsWith(rootPrefix)) {
            throw new SecurityException("copy source is outside the allowed app cache");
        }
        if (!src.exists() || !src.isFile()) {
            throw new Exception("source file not found");
        }
        return src;
    }

    /** Worker-only copy: native download temp files may live anywhere in app cache. */
    long copyFromFile(String from, String toRelPath) throws Exception {
        return copyFromAllowedCache(from, toRelPath, context.getCacheDir());
    }

    /** Renderer-facing copy: only persistent image-cache blobs may be published. */
    public long copyFromImageCacheFile(String from, String toRelPath) throws Exception {
        return copyFromAllowedCache(from, toRelPath,
                new File(context.getCacheDir(), IMAGE_CACHE_ROOT));
    }

    private long copyFromAllowedCache(String from, String toRelPath, File allowedRoot) throws Exception {
        assertBelowLibraryRoot(toRelPath);
        File src = canonicalSourceWithin(allowedRoot, from);
        if (rootDir() == null) throw new Exception("NO_TREE");
        int idx = lastSlash(toRelPath);
        String dirPart = idx < 0 ? "" : toRelPath.substring(0, idx);
        String finalName = fileNameForPath(toRelPath);
        DocumentEntry dir = resolveDir(dirPart, true);
        if (dir == null) throw new Exception("copy create failed: " + toRelPath);

        long nonce = System.nanoTime();
        String tempName = tempNameForPublish(finalName, nonce);
        String backupName = backupNameForPublish(finalName, nonce);
        DocumentEntry existingTemp = findChild(dir.uri, tempName);
        if (existingTemp != null) {
            deleteChild(dir.uri, existingTemp);
        }
        if (findChild(dir.uri, backupName) != null) {
            throw new Exception("copy backup name collision: " + backupName);
        }
        DocumentEntry temp = createChild(dir.uri, mimeFor(finalName), tempName);

        ContentResolver cr = context.getContentResolver();
        long written = 0;
        boolean published = false;
        boolean oldFinalMoved = false;
        try {
            try (FileInputStream fis = new FileInputStream(src);
                 OutputStream os = cr.openOutputStream(temp.uri, "wt")) {
                if (os == null) throw new Exception("openOutputStream returned null");
                byte[] buf = new byte[65536];
                int n;
                while ((n = fis.read(buf)) != -1) {
                    os.write(buf, 0, n);
                    written += n;
                }
                os.flush();
            }

            long sourceSize = src.length();
            DocumentEntry writtenTemp = findChild(dir.uri, tempName);
            if (sourceSize <= 0
                    || written != sourceSize
                    || writtenTemp == null
                    || !writtenTemp.isFile()
                    || writtenTemp.size != sourceSize) {
                throw new Exception("incomplete temp SAF write");
            }

            DocumentEntry existingFinal = findChild(dir.uri, finalName);
            if (existingFinal != null) {
                if (!existingFinal.isFile()) throw new Exception("destination is not a file: " + toRelPath);
                renameChild(dir.uri, existingFinal, backupName);
                oldFinalMoved = true;
            }
            DocumentEntry finalEntry = renameChild(dir.uri, writtenTemp, finalName);
            published = true;
            if (!finalEntry.isFile() || finalEntry.size != sourceSize) {
                throw new Exception("copy publish verification failed: " + toRelPath);
            }
            if (oldFinalMoved) {
                // The verified final file is now the commit point. Backup cleanup
                // must not turn a successful publication into an error: the worker
                // responds to copy errors by deleting the destination, which would
                // otherwise discard both the newly verified file and a provider-side
                // backup that may already have been deleted successfully.
                try {
                    DocumentEntry backup = findChild(dir.uri, backupName);
                    if (backup != null) deleteChild(dir.uri, backup);
                } catch (Throwable cleanupError) {
                    // A hidden, uniquely named backup is safe to leave behind. A
                    // later maintenance pass may remove it, while readers continue
                    // to use the already verified final file.
                }
                oldFinalMoved = false;
            }
            return written;
        } catch (Throwable t) {
            try {
                DocumentEntry backup = findChild(dir.uri, backupName);
                if (oldFinalMoved || backup != null) {
                    DocumentEntry failedFinal = findChild(dir.uri, finalName);
                    if (failedFinal != null) deleteChild(dir.uri, failedFinal);
                    if (backup == null) {
                        throw new Exception("copy rollback backup is missing");
                    }
                    renameChild(dir.uri, backup, finalName);
                    oldFinalMoved = false;
                    published = false;
                } else if (published) {
                    DocumentEntry failedFinal = findChild(dir.uri, finalName);
                    if (failedFinal != null) deleteChild(dir.uri, failedFinal);
                    published = false;
                }
                DocumentEntry staleTemp = findChild(dir.uri, tempName);
                if (staleTemp != null) deleteChild(dir.uri, staleTemp);
            } catch (Throwable rollbackError) {
                t.addSuppressed(rollbackError);
            }
            if (t instanceof Exception) throw (Exception) t;
            throw new Exception(t);
        }
    }

    /** Return the file size for a relative file, or -1 when missing/unknown. */
    public long size(String relPath) {
        PathStat stat = stat(relPath);
        return !stat.exists || stat.directory ? -1L : stat.size;
    }

    /** Delete a single relative file. No-op when missing. Returns false on a hard failure. */
    public boolean delete(String relPath) {
        assertDeletable(relPath);
        DocumentEntry file = resolveExisting(relPath);
        if (file == null) return true;
        if (!file.isFile()) return false;
        try {
            if (!DocumentsContract.deleteDocument(context.getContentResolver(), file.uri)) return false;
            return resolveExisting(relPath) == null;
        } catch (java.io.FileNotFoundException e) {
            throw new IllegalStateException("SAF delete failed", e);
        }
    }

    /**
     * Recursively delete a relative directory and drop cached handles only when
     * it is confirmed absent/deleted. Runtime provider/I/O errors deliberately
     * propagate to the plugin caller.
     */
    public boolean deleteDir(String relPath) {
        assertDeletable(relPath);
        DocumentEntry dir = resolveExisting(relPath);
        if (dir == null) return true;
        if (!dir.isDirectory()) return false;
        try {
            if (!DocumentsContract.deleteDocument(context.getContentResolver(), dir.uri)) return false;
            if (resolveExisting(relPath) != null) return false;
        } catch (java.io.FileNotFoundException e) {
            throw new IllegalStateException("SAF directory delete failed", e);
        }
        for (String key : new ArrayList<>(dirCache.keySet())) {
            if (key.equals(relPath) || key.startsWith(relPath + "/")) {
                dirCache.remove(key);
            }
        }
        return true;
    }

    /**
     * List the entries of a relative directory, or null when the directory does
     * not exist / is not a directory. Provider query failures propagate.
     */
    public DirectoryEntry[] listDir(String relDirPath) {
        DocumentEntry dir = resolveExisting(relDirPath);
        if (dir == null || !dir.isDirectory()) return null;
        List<DocumentEntry> children = queryChildren(dir.uri);
        DirectoryEntry[] result = new DirectoryEntry[children.size()];
        for (int i = 0; i < children.size(); i++) {
            result[i] = new DirectoryEntry(children.get(i));
        }
        return result;
    }

    /** Returns the content:// document URI for a relative path (or null). */
    public Uri getUri(String relPath) {
        DocumentEntry file = resolveExisting(relPath);
        return file != null ? file.uri : null;
    }

    /** Returns the byte length of a relative file (0 when missing / not a file). */
    public long length(String relPath) {
        PathStat stat = stat(relPath);
        return stat.exists && !stat.directory ? stat.size : 0L;
    }
}
