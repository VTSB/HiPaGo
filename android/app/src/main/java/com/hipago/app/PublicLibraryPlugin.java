package com.hipago.app;

import android.app.Activity;
import android.content.Intent;
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
 * and resolves it to a {@code content://} document URI.
 *
 * The SAF tree-resolution + file-write/copy/read/exists logic now lives in the
 * shared {@link SafLibrary} so the background {@link GalleryDownloadWorker} can
 * write to the IDENTICAL location with IDENTICAL semantics (AC-002). This plugin
 * delegates every file op to a single long-lived SafLibrary instance; its
 * JS-facing {@code @PluginMethod} contract is unchanged.
 *
 * No MANAGE_EXTERNAL_STORAGE, no WRITE_EXTERNAL_STORAGE — the only grant is the
 * single persisted tree the user chose.
 *
 * Performance: directory DocumentFile handles are cached inside SafLibrary, so a
 * download of N images resolves the gallery directory once.
 *
 * Atomicity: image writes go straight to the final document via {@code "wt"} so
 * overwrites (the per-page manifest rewrite) truncate in place instead of piling
 * up as "0000 (1).json".
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file is verified by
 * code review here and must be smoke-tested on a physical/emulator Android
 * device (the activity-result + persisted-permission path especially).
 */
@CapacitorPlugin(name = "PublicLibrary")
public class PublicLibraryPlugin extends Plugin {

    /**
     * Shared SAF helper. Lazily created against the plugin context the first time
     * a file op runs (the context is not available at field-init time).
     */
    private volatile SafLibrary saf;

    /**
     * All file ops run on ONE background thread, not a new thread per call. This
     * serializes directory/file resolution + creation so concurrent downloads
     * cannot corrupt the SafLibrary dir cache or race {@code findFile→createFile}
     * into a duplicate "name (1)". It also bounds thread churn.
     */
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private SafLibrary saf() {
        SafLibrary local = saf;
        if (local == null) {
            synchronized (this) {
                local = saf;
                if (local == null) {
                    local = new SafLibrary(getContext());
                    saf = local;
                }
            }
        }
        return local;
    }

    private static String msg(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }

    // -----------------------------------------------------------------------
    // Tree (persisted folder) management
    // -----------------------------------------------------------------------

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
            saf().setTreeUri(tree);

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
        Uri tree = saf().getTreeUri();
        boolean valid = saf().hasTree();
        JSObject ret = new JSObject();
        ret.put("treeUri", tree != null ? tree.toString() : null);
        if (valid) {
            DocumentFile root = saf().rootDir();
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
        Uri tree = saf().getTreeUri();
        if (tree != null) {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(
                        tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
                // Already released / never held — fine.
            }
        }
        saf().clearTreeUri();
        call.resolve();
    }

    // -----------------------------------------------------------------------
    // File operations (all relative paths under the tree; delegate to SafLibrary)
    // -----------------------------------------------------------------------

    @PluginMethod
    public void mkdir(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                if (!saf().mkdir(path)) { call.reject("mkdir failed: " + path); return; }
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                byte[] data = android.util.Base64.decode(dataBase64, android.util.Base64.NO_WRAP);
                saf().writeBytes(path, data);
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("writeFile error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                byte[] data = saf().readBytes(path);
                if (data == null) { call.reject("file not found: " + path); return; }
                JSObject ret = new JSObject();
                ret.put("dataBase64", android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP));
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("readFile error: " + msg(e));
            }
        });
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        final String path = call.getString("path");
        io.execute(() -> {
            try {
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                SafLibrary.DirectoryEntry[] entries = saf().listDir(path);
                if (entries == null) { call.reject("directory not found: " + path); return; }
                JSArray files = new JSArray();
                for (SafLibrary.DirectoryEntry entry : entries) {
                    JSObject item = new JSObject();
                    item.put("name", entry.name);
                    item.put("size", entry.file ? entry.size : 0);
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                SafLibrary.PathStat stat = saf().stat(path);
                JSObject ret = new JSObject();
                ret.put("exists", stat.exists);
                ret.put("size", stat.exists && !stat.directory ? stat.size : 0);
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                JSObject ret = new JSObject();
                ret.put("exists", saf().exists(path));
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                saf().copyFromImageCacheFile(from, to);
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                if (!saf().delete(path)) { call.reject("delete failed: " + path); return; }
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                if (!saf().deleteDir(path)) { call.reject("deleteDir failed: " + path); return; }
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
                if (!saf().hasTree()) { call.reject("NO_TREE"); return; }
                Uri uri = saf().getUri(path);
                JSObject ret = new JSObject();
                ret.put("uri", uri != null ? uri.toString() : null);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("getUri error: " + msg(e));
            }
        });
    }
}
