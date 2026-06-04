package com.hipago.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.net.Uri;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Capacitor plugin for the user's download library, backed by the Storage
 * Access Framework (SAF) instead of all-files-access + absolute File I/O.
 *
 * Model: the user picks ONE parent folder via {@code ACTION_OPEN_DOCUMENT_TREE}
 * ({@link #openDocumentTree}). We take a persistable URI permission for just
 * that tree and remember it in SharedPreferences. Every other method takes a
 * RELATIVE path under that tree (e.g. {@code "HiPaGo/12345 Title/0001.webp"})
 * and resolves it to a {@code content://} document URI via DocumentFile.
 *
 * No MANAGE_EXTERNAL_STORAGE, no WRITE_EXTERNAL_STORAGE — the only grant is the
 * single persisted tree the user chose.
 *
 * Performance: directory DocumentFile handles are cached by relative path
 * ({@link #dirCache}) so a download of N images resolves the gallery directory
 * once, then creates child files directly instead of re-walking the tree.
 *
 * Atomicity: image writes go straight to the final document (a torn image on a
 * killed process is recoverable — the download loop already tolerates partial
 * galleries). Overwrites (the per-page manifest rewrite) truncate the existing
 * document in place via {@code openOutputStream(uri, "wt")}, so they never pile
 * up as "0000 (1).json".
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file is verified by
 * code review here and must be smoke-tested on a physical/emulator Android
 * device (the activity-result + persisted-permission path especially).
 */
@CapacitorPlugin(name = "PublicLibrary")
public class PublicLibraryPlugin extends Plugin {

    private static final String PREFS = "hipago_download_tree";
    private static final String KEY_TREE_URI = "tree_uri";

    /** relative dir path ("HiPaGo/12345 Title") → resolved DocumentFile. */
    private final Map<String, DocumentFile> dirCache = new ConcurrentHashMap<>();

    /** Cached tree root DocumentFile so per-file ops skip repeated resolution. */
    private volatile DocumentFile cachedRoot;

    /**
     * All file ops run on ONE background thread, not a new thread per call. This
     * serializes directory/file resolution + creation so concurrent downloads
     * cannot corrupt {@link #dirCache} or race {@code findFile→createFile} into
     * a duplicate "name (1)". It also bounds thread churn.
     */
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // -----------------------------------------------------------------------
    // Tree (persisted folder) management
    // -----------------------------------------------------------------------

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private Uri getTreeUri() {
        String s = prefs().getString(KEY_TREE_URI, null);
        return s == null ? null : Uri.parse(s);
    }

    /** Whether the persisted tree URI still has a live, writable permission. */
    private boolean isTreeValid(Uri tree) {
        if (tree == null) return false;
        boolean persisted = false;
        List<UriPermission> perms = getContext().getContentResolver().getPersistedUriPermissions();
        for (UriPermission p : perms) {
            if (p.getUri().equals(tree) && p.isWritePermission()) {
                persisted = true;
                break;
            }
        }
        if (!persisted) return false;
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        return root != null && root.canWrite();
    }

    /**
     * The tree root for file ops. Cached after first resolution so each
     * writeFile/copy does not re-read prefs or re-validate (validity is gated
     * once per download via {@link #getTree}). fromTreeUri itself does no IPC.
     */
    private DocumentFile rootDir() {
        if (cachedRoot != null) return cachedRoot;
        Uri tree = getTreeUri();
        if (tree == null) return null;
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
        if (root == null) return null;
        cachedRoot = root;
        return root;
    }

    @PluginMethod
    public void openDocumentTree(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "onTreePicked");
    }

    @ActivityCallback
    private void onTreePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            int flags = result.getData().getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (flags == 0) {
                flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            }
            getContext().getContentResolver().takePersistableUriPermission(tree, flags);
            prefs().edit().putString(KEY_TREE_URI, tree.toString()).apply();
            dirCache.clear();
            cachedRoot = null;

            DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
            JSObject ret = new JSObject();
            ret.put("treeUri", tree.toString());
            ret.put("displayName", root != null && root.getName() != null ? root.getName() : "");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("openDocumentTree error: " + msg(e));
        }
    }

    /** Returns the currently persisted tree, its display name, and validity. */
    @PluginMethod
    public void getTree(PluginCall call) {
        Uri tree = getTreeUri();
        boolean valid = isTreeValid(tree);
        JSObject ret = new JSObject();
        ret.put("treeUri", tree != null ? tree.toString() : null);
        if (valid) {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), tree);
            ret.put("displayName", root != null && root.getName() != null ? root.getName() : "");
        } else {
            ret.put("displayName", null);
        }
        ret.put("valid", valid);
        call.resolve(ret);
    }

    /** Release the persisted permission and forget the tree. */
    @PluginMethod
    public void clearTree(PluginCall call) {
        Uri tree = getTreeUri();
        if (tree != null) {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(
                        tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
                // Already released / never held — fine.
            }
        }
        prefs().edit().remove(KEY_TREE_URI).apply();
        dirCache.clear();
        cachedRoot = null;
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // Path resolution helpers (relative path under the tree → DocumentFile)
    // -----------------------------------------------------------------------

    private static String msg(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }

    /** Reject absolute paths and ".." traversal in a relative path. */
    private static String[] safeSegments(String relPath) {
        if (relPath == null || relPath.isEmpty()) {
            throw new SecurityException("path is required");
        }
        if (relPath.startsWith("/") || relPath.contains("..")) {
            throw new SecurityException("path traversal");
        }
        return relPath.split("/");
    }

    /**
     * Resolve a relative DIRECTORY path under the tree.
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
        safeSegments(relPath);
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
        safeSegments(relPath);
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

    @PluginMethod
    public void mkdir(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile dir = resolveDir(path, true);
                if (dir == null) { call.reject("mkdir failed: " + path); return; }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("mkdir error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        final String path = call.getString("path");
        final String dataBase64 = call.getString("dataBase64");
        if (dataBase64 == null) { call.reject("dataBase64 is required"); return; }
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                byte[] data = Base64.getDecoder().decode(dataBase64);
                Uri uri = ensureFileUri(path);
                if (uri == null) { call.reject("writeFile create failed: " + path); return; }
                writeBytes(uri, data);
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("writeFile error: " + msg(e));
            }
        });
    }

    private void writeBytes(Uri uri, byte[] data) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        try (OutputStream os = cr.openOutputStream(uri, "wt")) {
            if (os == null) throw new Exception("openOutputStream returned null");
            os.write(data);
            os.flush();
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile file = resolveFile(path);
                if (file == null || !file.isFile()) { call.reject("file not found: " + path); return; }
                byte[] data = readAll(file.getUri());
                JSObject ret = new JSObject();
                ret.put("dataBase64", Base64.getEncoder().encodeToString(data));
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("readFile error: " + msg(e));
            }
        });
    }

    private byte[] readAll(Uri uri) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        try (InputStream is = cr.openInputStream(uri);
             java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream()) {
            if (is == null) throw new Exception("openInputStream returned null");
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile dir = resolveDir(path, false);
                if (dir == null || !dir.isDirectory()) { call.reject("directory not found: " + path); return; }
                JSArray files = new JSArray();
                for (DocumentFile entry : dir.listFiles()) {
                    String name = entry.getName();
                    if (name == null) continue; // keep the DirEntry.name: string contract honest
                    JSObject item = new JSObject();
                    item.put("name", name);
                    item.put("size", entry.isFile() ? entry.length() : 0);
                    files.put(item);
                }
                JSObject ret = new JSObject();
                ret.put("files", files);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("readdir error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void stat(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile file = resolveFile(path);
                JSObject ret = new JSObject();
                ret.put("exists", file != null && file.exists());
                ret.put("size", file != null && file.isFile() ? file.length() : 0);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("stat error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void exists(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile file = resolveFile(path);
                JSObject ret = new JSObject();
                ret.put("exists", file != null && file.exists());
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("exists error: " + msg(e));
            }
        });
    }

    /**
     * Copy a LOCAL source file (absolute or file:// path, e.g. the image cache)
     * into the tree at relative {@code to}. The source stays a normal File; only
     * the destination is a content URI.
     */
    @PluginMethod
    public void copy(PluginCall call) {
        final String from = call.getString("from");
        final String to = call.getString("to");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                if (from == null) { call.reject("from is required"); return; }
                String srcPath = from.startsWith("file://") ? Uri.parse(from).getPath() : from;
                File src = new File(srcPath);
                if (!src.exists() || !src.isFile()) { call.reject("source file not found: " + from); return; }
                Uri uri = ensureFileUri(to);
                if (uri == null) { call.reject("copy create failed: " + to); return; }
                ContentResolver cr = getContext().getContentResolver();
                try (FileInputStream fis = new FileInputStream(src);
                     OutputStream os = cr.openOutputStream(uri, "wt")) {
                    if (os == null) throw new Exception("openOutputStream returned null");
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = fis.read(buf)) != -1) os.write(buf, 0, n);
                    os.flush();
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("copy error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void delete(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile file = resolveFile(path);
                if (file != null && file.exists() && !file.delete()) {
                    call.reject("delete failed: " + path);
                    return;
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("delete error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void deleteDir(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile dir = resolveDir(path, false);
                if (dir != null && dir.exists()) {
                    dir.delete(); // DocumentFile.delete removes the subtree.
                }
                // Drop any cached handles under this path.
                dirCache.keySet().removeIf(k -> k.equals(path) || k.startsWith(path + "/"));
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("deleteDir error: " + msg(e));
            }
        });
    }

    /** Returns the content:// document URI for a relative path (or null). */
    @PluginMethod
    public void getUri(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (rootDir() == null) { call.reject("NO_TREE"); return; }
                DocumentFile file = resolveFile(path);
                JSObject ret = new JSObject();
                ret.put("uri", file != null ? file.getUri().toString() : null);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("getUri error: " + msg(e));
            }
        });
    }
}
