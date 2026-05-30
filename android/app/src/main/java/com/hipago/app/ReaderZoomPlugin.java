package com.hipago.app;

import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Toggles native WebView pinch-to-zoom on demand.
 *
 * Android WebView disables pinch-zoom by default even when the page viewport
 * permits it (unlike iOS WKWebView). Enabling it globally would make EVERY
 * screen zoomable, which is unwanted — only the reader should zoom. So the web
 * layer calls setEnabled(true) while the reader is mounted and setEnabled(false)
 * when it unmounts. The on-screen +/- zoom buttons stay hidden either way.
 */
@CapacitorPlugin(name = "ReaderZoom")
public class ReaderZoomPlugin extends Plugin {

    @PluginMethod
    public void setEnabled(PluginCall call) {
        final boolean enabled = call.getBoolean("enabled", false);
        getActivity().runOnUiThread(() -> {
            if (bridge == null || bridge.getWebView() == null) {
                call.resolve();
                return;
            }
            WebView webView = bridge.getWebView();
            WebSettings settings = webView.getSettings();
            settings.setSupportZoom(enabled);
            settings.setBuiltInZoomControls(enabled);
            settings.setDisplayZoomControls(false);
            call.resolve();
        });
    }
}
