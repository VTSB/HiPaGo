package com.hipago.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for all-files external storage access (MANAGE_EXTERNAL_STORAGE).
 *
 * On API 30+ (Android 11+) the system requires the user to grant
 * "All files access" via a Settings screen — there is no runtime-permission
 * dialog for this level. On API < 30 the legacy WRITE_EXTERNAL_STORAGE
 * permission (declared in the manifest with maxSdkVersion="29") is used.
 *
 * Methods:
 *   isGranted() → {granted: boolean}
 *   request()   → resolves when the system Settings screen has been launched
 *                  (mirrors UpdaterPlugin.install which also resolves on
 *                   settings-UI open, not on user action).
 *
 * DEVICE-PENDING: Java is not compiled in the sandbox; this file must be
 * verified on a physical/emulator Android device.
 */
@CapacitorPlugin(name = "StoragePermission")
public class StoragePermissionPlugin extends Plugin {

    @PluginMethod
    public void isGranted(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // API 30+: MANAGE_EXTERNAL_STORAGE / all-files access
            ret.put("granted", Environment.isExternalStorageManager());
        } else {
            // API < 30: check legacy WRITE_EXTERNAL_STORAGE grant
            int result = ContextCompat.checkSelfPermission(
                    getContext(),
                    android.Manifest.permission.WRITE_EXTERNAL_STORAGE);
            ret.put("granted", result == android.content.pm.PackageManager.PERMISSION_GRANTED);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // API 30+: open the per-app all-files-access settings screen
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (ActivityNotFoundException e) {
                // Some OEMs don't implement the per-app variant; fall back to
                // the generic all-files-access management screen.
                Intent fallback = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getContext().startActivity(fallback);
                } catch (ActivityNotFoundException e2) {
                    call.reject("Could not open storage-permission settings: " + e2.getMessage());
                    return;
                }
            }
            // Resolve immediately after launching the Settings UI (the user
            // may still cancel or deny — the caller must re-check isGranted).
            call.resolve();
        } else {
            // API < 30: use Capacitor's built-in runtime permission request.
            // The permission is declared in the manifest with maxSdkVersion="29".
            pluginRequestPermissions(
                    new String[]{ android.Manifest.permission.WRITE_EXTERNAL_STORAGE },
                    1001);
            // Resolve after issuing the request; the caller re-checks isGranted
            // once the permission dialog is dismissed.
            call.resolve();
        }
    }
}
