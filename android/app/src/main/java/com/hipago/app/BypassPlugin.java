package com.hipago.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
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
        final Map<String, String> headers;
        try {
            NativeRequestPolicy.requireAllowedBypassUrl(url);
            headers = NativeRequestPolicy.validateHeaders(parseHeaders(call));
        } catch (Exception e) {
            call.reject("Invalid bypass request: " + e.getMessage(), e);
            return;
        }

        // Call Rust bypass-core via UniFFI bindings on background thread
        final String finalUrl = url;

        new Thread(() -> {
            try {
                BypassResponse resp = BypassKt.bypassFetch(finalUrl, headers);

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
     * Stream a URL's body to one canonical child of the app image-cache directory
     * (one chunk at a time in native code — the image never enters the JS heap).
     * The JS adapter then serves the file via Capacitor.convertFileSrc.
     * Resolves { size } = total bytes written.
     */
    @PluginMethod
    public void downloadToFile(PluginCall call) {
        String url = call.getString("url");
        String path = call.getString("path");
        final Map<String, String> headers;
        final File destination;
        try {
            NativeRequestPolicy.requireAllowedBypassUrl(url);
            headers = NativeRequestPolicy.validateHeaders(parseHeaders(call));
            destination = NativeRequestPolicy.resolveImageCacheDestination(
                    getContext().getCacheDir(),
                    path
            );
        } catch (Exception e) {
            call.reject("Invalid bypass download request: " + e.getMessage(), e);
            return;
        }

        final String finalUrl = url;

        new Thread(() -> {
            try {
                long size = BypassKt.bypassDownloadToFile(
                        finalUrl,
                        headers,
                        destination.getAbsolutePath()
                );
                JSObject result = new JSObject();
                result.put("size", size);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Bypass download failed: " + e.getMessage(), e);
            }
        }).start();
    }

    private static Map<String, String> parseHeaders(PluginCall call) {
        JSObject headersObj = call.getObject("headers", null);
        if (headersObj == null) return null;
        Map<String, String> headers = new HashMap<>();
        Iterator<String> keys = headersObj.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            headers.put(key, headersObj.optString(key, ""));
        }
        return headers;
    }
}
