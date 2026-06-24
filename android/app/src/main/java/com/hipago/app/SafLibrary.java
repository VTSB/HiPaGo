package com.hipago.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.net.Uri;

import androidx.documentfile.provider.DocumentFile;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file is verified by
 * code review here and must be smoke-tested on a physical/emulator Android
 * device (the persisted-permission + DocumentFile resolution path especially).
 */
public class SafLibrary {

    static final String PREFS = "hipago_download_tree";
    static final String KEY_TREE_URI = "tree_uri";

    private final Context context;

    /** relative dir path ("HiPaGo/12345 Title") → resolved DocumentFile. */
    private final Map<String, DocumentFile> dirCache = new ConcurrentHashMap<>();

    /** Cached tree root DocumentFile so per-file ops skip repeated resolution. */
    private volatile DocumentFile cachedRoot;

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
    public void setTreeUri(Uri tree) {
        prefs().edit().putString(KEY_TREE_URI, tree.toString()).apply();
        invalidate();
    }

    /** Forget the tree URI (called by the plugin's clearTree). */
    public void clearTreeUri() {
        prefs().edit().remove(KEY_TREE_URI).apply();
        invalidate();
    }

    /** Drop cached handles — call after the tree changes. */
    public void invalidate() {
        dirCache.clear();
        cachedRoot = null;
    }

    /**
     * The tree root for file ops. Cached after first resolution, but guarded by
     * the persisted write grant and {@link DocumentFile#canWrite()} so a revoked
     * SAF permission does not look writable to the background worker forever.
     */
    public DocumentFile rootDir() {
        Uri tree = getTreeUri();
        if (tree == null) return null;
        if (!hasPersistedWritePermission(tree)) {
            cachedRoot = null;
            return null;
        }
        if (cachedRoot != null) {
            if (cachedRoot.canWrite()) return cachedRoot;
            cachedRoot = null;
            return null;
        }
        DocumentFile root = DocumentFile.fromTreeUri(context, tree);
        if (root == null || !root.canWrite()) return null;
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

    /** Reject absolute paths and ".." traversal in a relative path. */
    private static void assertSafe(String relPath) {
        if (relPath == null || relPath.isEmpty()) {
            throw new SecurityException("path is required");
        }
        if (relPath.startsWith("/")) {
            throw new SecurityException("path traversal");
        }
        for (String segment : relPath.split("/")) {
            if (segment.equals("..")) {
                throw new SecurityException("path traversal");
            }
        }
    }

    /**
     * Resolve a relative DIRECTORY path under the tree.
     *
     * @param create create missing directories when true; return null on first
     *               missing segment when false.
     */
    private DocumentFile resolveDir(String relDirPath, boolean create) {
        DocumentFile cur = rootDir();
        if (cur == null) return null;
        if (relDirPath == null || relDirPath.isEmpty()) return cur;

        DocumentFile cached = dirCache.get(relDirPath);
        if (cached != null && cached.exists()) return cached;

        StringBuilder built = new StringBuilder();
        for (String seg : relDirPath.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) return null;
            if (built.length() > 0) built.append("/");
            built.append(seg);
            String key = built.toString();

            DocumentFile next = dirCache.get(key);
            if (next == null || !next.exists()) {
                next = cur.findFile(seg);
                if (next == null) {
                    if (!create) return null;
                    next = cur.createDirectory(seg);
                    if (next == null) return null;
                } else if (!next.isDirectory()) {
                    return null;
                }
                dirCache.put(key, next);
            }
            cur = next;
        }
        return cur;
    }

    private static int lastSlash(String p) {
        return p.lastIndexOf('/');
    }

    /** Resolve a relative FILE path to its DocumentFile, or null if missing. */
    private DocumentFile resolveFile(String relPath) {
        assertSafe(relPath);
        int idx = lastSlash(relPath);
        String dirPart = idx < 0 ? "" : relPath.substring(0, idx);
        String name = idx < 0 ? relPath : relPath.substring(idx + 1);
        DocumentFile dir = resolveDir(dirPart, false);
        if (dir == null) return null;
        return dir.findFile(name);
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
    private Uri ensureFileUri(String relPath) {
        assertSafe(relPath);
        int idx = lastSlash(relPath);
        String dirPart = idx < 0 ? "" : relPath.substring(0, idx);
        String name = idx < 0 ? relPath : relPath.substring(idx + 1);
        DocumentFile dir = resolveDir(dirPart, true);
        if (dir == null) return null;
        DocumentFile existing = dir.findFile(name);
        if (existing != null) return existing.getUri();
        DocumentFile created = dir.createFile(mimeFor(name), name);
        return created != null ? created.getUri() : null;
    }

    // -----------------------------------------------------------------------
    // File operations (all relative paths under the tree)
    // -----------------------------------------------------------------------

    /** Create a directory and all parents. Returns false when no tree / failure. */
    public boolean mkdir(String relDirPath) {
        if (rootDir() == null) return false;
        return resolveDir(relDirPath, true) != null;
    }

    /** Whether a relative path (file or directory) currently exists. */
    public boolean exists(String relPath) {
        if (rootDir() == null) return false;
        DocumentFile file = resolveFile(relPath);
        return file != null && file.exists();
    }

    /**
     * Write bytes to a relative file path, truncating an existing file in place
     * ("wt"). Creates parent directories as needed.
     */
    public void writeBytes(String relPath, byte[] data) throws Exception {
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
        if (rootDir() == null) throw new Exception("NO_TREE");
        DocumentFile file = resolveFile(relPath);
        if (file == null || !file.isFile()) return null;
        ContentResolver cr = context.getContentResolver();
        try (InputStream is = cr.openInputStream(file.getUri());
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
     * a normal File; only the destination is a content URI. Returns bytes written.
     */
    public long copyFromFile(String from, String toRelPath) throws Exception {
        if (rootDir() == null) throw new Exception("NO_TREE");
        if (from == null) throw new Exception("from is required");
        String srcPath = from.startsWith("file://") ? Uri.parse(from).getPath() : from;
        File src = new File(srcPath);
        if (!src.exists() || !src.isFile()) {
            throw new Exception("source file not found: " + from);
        }
        Uri uri = ensureFileUri(toRelPath);
        if (uri == null) throw new Exception("copy create failed: " + toRelPath);
        ContentResolver cr = context.getContentResolver();
        long written = 0;
        try (FileInputStream fis = new FileInputStream(src);
             OutputStream os = cr.openOutputStream(uri, "wt")) {
            if (os == null) throw new Exception("openOutputStream returned null");
            byte[] buf = new byte[65536];
            int n;
            while ((n = fis.read(buf)) != -1) {
                os.write(buf, 0, n);
                written += n;
            }
            os.flush();
        }
        return written;
    }

    /** Return the file size for a relative file, or -1 when missing/unknown. */
    public long size(String relPath) {
        if (rootDir() == null) return -1L;
        DocumentFile file = resolveFile(relPath);
        if (file == null || !file.isFile()) return -1L;
        return file.length();
    }

    /** Delete a single relative file. No-op when missing. Returns false on a hard failure. */
    public boolean delete(String relPath) {
        if (rootDir() == null) return false;
        DocumentFile file = resolveFile(relPath);
        if (file != null && file.exists()) {
            return file.delete();
        }
        return true;
    }

    /** Recursively delete a relative directory and drop any cached handles under it. */
    public void deleteDir(String relPath) {
        if (rootDir() == null) return;
        DocumentFile dir = resolveDir(relPath, false);
        if (dir != null && dir.exists()) {
            dir.delete(); // DocumentFile.delete removes the subtree.
        }
        dirCache.keySet().removeIf(k -> k.equals(relPath) || k.startsWith(relPath + "/"));
    }

    /**
     * List the entries of a relative directory, or null when the directory does
     * not exist / is not a directory. Returns the raw DocumentFile[] so the
     * caller can read each entry's name + length.
     */
    public DocumentFile[] listDir(String relDirPath) {
        if (rootDir() == null) return null;
        DocumentFile dir = resolveDir(relDirPath, false);
        if (dir == null || !dir.isDirectory()) return null;
        return dir.listFiles();
    }

    /** Returns the content:// document URI for a relative path (or null). */
    public Uri getUri(String relPath) {
        if (rootDir() == null) return null;
        DocumentFile file = resolveFile(relPath);
        return file != null ? file.getUri() : null;
    }

    /** Returns the byte length of a relative file (0 when missing / not a file). */
    public long length(String relPath) {
        if (rootDir() == null) return 0;
        DocumentFile file = resolveFile(relPath);
        return file != null && file.isFile() ? file.length() : 0;
    }
}
