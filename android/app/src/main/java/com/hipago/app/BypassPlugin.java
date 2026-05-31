package com.hipago.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

import uniffi.bypass.BypassKt;
import uniffi.bypass.BypassResponse;

/**
 * Capacitor plugin for ISP bypass on Android.
 * Wraps the Rust bypass-core library via UniFFI Kotlin bindings.
 */
@CapacitorPlugin(name = "Bypass")
public class BypassPlugin extends Plugin {

    @PluginMethod
    public void fetch(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        // Parse optional headers
        Map<String, String> headers = null;
        JSObject headersObj = call.getObject("headers", null);
        if (headersObj != null) {
            headers = new HashMap<>();
            Iterator<String> keys = headersObj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                headers.put(key, headersObj.optString(key, ""));
            }
        }

        // Call Rust bypass-core via UniFFI bindings on background thread
        final Map<String, String> finalHeaders = headers;
        final String finalUrl = url;

        new Thread(() -> {
            try {
                BypassResponse resp = BypassKt.bypassFetch(finalUrl, finalHeaders);

                JSObject result = new JSObject();
                result.put("status", resp.getStatus());

                // Convert headers
                JSObject respHeaders = new JSObject();
                for (Map.Entry<String, String> entry : resp.getHeaders().entrySet()) {
                    respHeaders.put(entry.getKey(), entry.getValue());
                }
                result.put("headers", respHeaders);

                // Convert body to JSON array of bytes
                JSONArray bodyArray = new JSONArray();
                for (byte b : resp.getBody()) {
                    bodyArray.put(b & 0xFF);
                }
                result.put("body", bodyArray);

                call.resolve(result);
            } catch (Exception e) {
                call.reject("Bypass fetch failed: " + e.getMessage(), e);
            }
        }).start();
    }

    /**
     * Stream a URL's body straight to an absolute file path (one chunk at a time
     * in native code — the image never enters the JS heap). Used by the persistent
     * image cache; the JS adapter then serves the file via Capacitor.convertFileSrc.
     * Resolves { size } = total bytes written.
     */
    @PluginMethod
    public void downloadToFile(PluginCall call) {
        String url = call.getString("url");
        String path = call.getString("path");
        if (url == null || url.isEmpty()) {
            call.reject("URL is required");
            return;
        }
        if (path == null || path.isEmpty()) {
            call.reject("path is required");
            return;
        }

        Map<String, String> headers = null;
        JSObject headersObj = call.getObject("headers", null);
        if (headersObj != null) {
            headers = new HashMap<>();
            Iterator<String> keys = headersObj.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                headers.put(key, headersObj.optString(key, ""));
            }
        }

        final Map<String, String> finalHeaders = headers;
        final String finalUrl = url;
        final String finalPath = path;

        new Thread(() -> {
            try {
                long size = BypassKt.bypassDownloadToFile(finalUrl, finalHeaders, finalPath);
                JSObject result = new JSObject();
                result.put("size", size);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Bypass download failed: " + e.getMessage(), e);
            }
        }).start();
    }
}
