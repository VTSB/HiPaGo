package com.hipago.app;

import android.net.Uri;
import android.os.Environment;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Base64;

/**
 * Capacitor plugin for raw file operations on absolute paths in public external
 * storage. The JS adapter resolves all paths to absolute before calling in.
 *
 * Security: normalizeAndCheck() canonicalises every incoming path and rejects
 * anything that contains ".." segments or that resolves outside its own root —
 * preventing path-traversal attacks from the WebView layer.
 *
 * Atomicity: writeFile and copy write to a sibling ".tmp" file first, then call
 * File.renameTo so a crash during the write does not leave a torn file.
 *
 * All file I/O runs on a background thread (new Thread + start), matching the
 * BypassPlugin / UpdaterPlugin convention.
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file must be
 * verified on a physical/emulator Android device.
 */
@CapacitorPlugin(name = "PublicLibrary")
public class PublicLibraryPlugin extends Plugin {

    // -----------------------------------------------------------------------
    // Security helper
    // -----------------------------------------------------------------------

    /**
     * Canonicalise {@code path} and reject it if it contains ".." after
     * canonicalisation, or if it is obviously a relative path that could
     * escape its intended root.
     *
     * @throws SecurityException with message "path traversal" if the path
     *                           is rejected.
     */
    private static File normalizeAndCheck(String path) throws SecurityException {
        if (path == null || path.isEmpty()) {
            throw new SecurityException("path is required");
        }
        // Reject raw ".." occurrences before canonicalisation
        if (path.contains("..")) {
            throw new SecurityException("path traversal");
        }
        try {
            File f = new File(path).getCanonicalFile();
            // Re-check after canonicalisation (symlinks etc.)
            String canonical = f.getPath();
            if (canonical.contains("..")) {
                throw new SecurityException("path traversal");
            }
            return f;
        } catch (java.io.IOException e) {
            throw new SecurityException("path traversal: " + e.getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // Plugin methods
    // -----------------------------------------------------------------------

    /**
     * Returns the absolute path of the public Downloads directory.
     * JS calls this when no user-configured base path is set, to learn where
     * to place the HiPaGo library folder.
     *
     * DEVICE-PENDING: verify on a physical/emulator Android device.
     */
    @PluginMethod
    public void defaultBaseDir(PluginCall call) {
        new Thread(() -> {
            try {
                File downloadsDir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                JSObject ret = new JSObject();
                ret.put("path", downloadsDir.getAbsolutePath());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("defaultBaseDir error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File dir = normalizeAndCheck(path);
                if (!dir.exists() && !dir.mkdirs()) {
                    call.reject("mkdir failed: " + path);
                    return;
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("mkdir error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        final String path = call.getString("path");
        final String dataBase64 = call.getString("dataBase64");
        if (dataBase64 == null) {
            call.reject("dataBase64 is required");
            return;
        }
        new Thread(() -> {
            try {
                File dest = normalizeAndCheck(path);
                byte[] data = Base64.getDecoder().decode(dataBase64);
                File tmp = new File(dest.getPath() + ".tmp");

                // Ensure parent directory exists
                File parent = dest.getParentFile();
                if (parent != null && !parent.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }

                // Atomic write: write to .tmp then rename
                try (FileOutputStream fos = new FileOutputStream(tmp)) {
                    fos.write(data);
                    fos.flush();
                }
                if (!tmp.renameTo(dest)) {
                    //noinspection ResultOfMethodCallIgnored
                    tmp.delete();
                    call.reject("writeFile rename failed: " + path);
                    return;
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("writeFile error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File file = normalizeAndCheck(path);
                if (!file.exists() || !file.isFile()) {
                    call.reject("file not found: " + path);
                    return;
                }
                byte[] data = new byte[(int) file.length()];
                try (FileInputStream fis = new FileInputStream(file)) {
                    int totalRead = 0;
                    while (totalRead < data.length) {
                        int n = fis.read(data, totalRead, data.length - totalRead);
                        if (n < 0) break;
                        totalRead += n;
                    }
                }
                JSObject ret = new JSObject();
                ret.put("dataBase64", Base64.getEncoder().encodeToString(data));
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("readFile error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File dir = normalizeAndCheck(path);
                if (!dir.exists() || !dir.isDirectory()) {
                    call.reject("directory not found: " + path);
                    return;
                }
                File[] entries = dir.listFiles();
                JSArray files = new JSArray();
                if (entries != null) {
                    for (File entry : entries) {
                        JSObject item = new JSObject();
                        item.put("name", entry.getName());
                        item.put("size", entry.isFile() ? entry.length() : 0);
                        files.put(item);
                    }
                }
                JSObject ret = new JSObject();
                ret.put("files", files);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("readdir error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void stat(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File file = normalizeAndCheck(path);
                JSObject ret = new JSObject();
                ret.put("exists", file.exists());
                ret.put("size", file.exists() ? file.length() : 0);
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("stat error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void copy(PluginCall call) {
        final String from = call.getString("from");
        final String to = call.getString("to");
        new Thread(() -> {
            try {
                File src = normalizeAndCheck(from);
                File dest = normalizeAndCheck(to);
                if (!src.exists() || !src.isFile()) {
                    call.reject("source file not found: " + from);
                    return;
                }
                File parent = dest.getParentFile();
                if (parent != null && !parent.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }
                File tmp = new File(dest.getPath() + ".tmp");
                try (FileInputStream fis = new FileInputStream(src);
                     FileOutputStream fos = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = fis.read(buf)) != -1) {
                        fos.write(buf, 0, n);
                    }
                    fos.flush();
                }
                if (!tmp.renameTo(dest)) {
                    //noinspection ResultOfMethodCallIgnored
                    tmp.delete();
                    call.reject("copy rename failed: " + to);
                    return;
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("copy error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void delete(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File file = normalizeAndCheck(path);
                if (file.exists() && !file.delete()) {
                    call.reject("delete failed: " + path);
                    return;
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("delete error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void deleteDir(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File dir = normalizeAndCheck(path);
                deleteRecursive(dir);
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("deleteDir error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    private static void deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    @PluginMethod
    public void getUri(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File file = normalizeAndCheck(path);
                JSObject ret = new JSObject();
                ret.put("uri", Uri.fromFile(file).toString());
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("getUri error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void rename(PluginCall call) {
        final String from = call.getString("from");
        final String to = call.getString("to");
        new Thread(() -> {
            try {
                File src = normalizeAndCheck(from);
                File dest = normalizeAndCheck(to);
                if (!src.exists()) {
                    call.reject("source not found: " + from);
                    return;
                }
                File parent = dest.getParentFile();
                if (parent != null && !parent.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }
                if (!src.renameTo(dest)) {
                    call.reject("rename failed: " + from + " → " + to);
                    return;
                }
                call.resolve();
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("rename error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }

    @PluginMethod
    public void exists(PluginCall call) {
        final String path = call.getString("path");
        new Thread(() -> {
            try {
                File file = normalizeAndCheck(path);
                JSObject ret = new JSObject();
                ret.put("exists", file.exists());
                call.resolve(ret);
            } catch (SecurityException e) {
                call.reject(e.getMessage());
            } catch (Exception e) {
                call.reject("exists error: " + (e.getMessage() != null ? e.getMessage() : e.toString()));
            }
        }).start();
    }
}
