package com.hipago.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Native backup for the versioned Zustand settings payload. */
@CapacitorPlugin(name = "SettingsBackup")
public class SettingsBackupPlugin extends Plugin {
    private static final String PREFS = "hipago_settings_backup";
    private static final String KEY_PAYLOAD = "payload";
    private static final int MAX_PAYLOAD_BYTES = 1024 * 1024;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        result.put("value", prefs().getString(KEY_PAYLOAD, null));
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String value = call.getString("value");
        if (value == null) {
            call.reject("value is required");
            return;
        }
        if (value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > MAX_PAYLOAD_BYTES) {
            call.reject("settings payload is too large");
            return;
        }
        if (prefs().edit().putString(KEY_PAYLOAD, value).commit()) {
            call.resolve();
        } else {
            call.reject("failed to persist settings backup");
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        if (prefs().edit().remove(KEY_PAYLOAD).commit()) {
            call.resolve();
        } else {
            call.reject("failed to clear settings backup");
        }
    }
}
