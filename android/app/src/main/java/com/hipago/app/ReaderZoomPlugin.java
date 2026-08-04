package com.hipago.app;

import android.app.Activity;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.atomic.AtomicLong;

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

    private static final float MIN_WEBVIEW_ZOOM_FACTOR = 0.01f;
    private static final float MAX_WEBVIEW_ZOOM_FACTOR = 100.0f;
    private static final float SCALE_EPSILON = 0.0001f;

    /**
     * Capacitor may invoke plugin calls from different bridge threads. A
     * generation makes an older UI task a no-op if a newer reader mount or
     * unmount request arrived before that task reached the main thread.
     */
    private final AtomicLong requestGeneration = new AtomicLong();

    @PluginMethod
    public void setEnabled(PluginCall call) {
        final boolean enabled = call.getBoolean("enabled", false);
        final Bridge requestBridge = bridge;
        final Activity activity = requestBridge == null ? null : requestBridge.getActivity();

        if (activity == null) {
            enqueueZoomChange(enabled, Runnable::run, () -> null, call::resolve);
            return;
        }

        enqueueZoomChange(
            enabled,
            activity::runOnUiThread,
            () -> {
                if (bridge != requestBridge) {
                    return null;
                }
                WebView webView = requestBridge.getWebView();
                return webView == null ? null : new WebViewZoomTarget(webView);
            },
            call::resolve
        );
    }

    /** Visible to the Android unit test so UI dispatch can be deterministically reordered. */
    void enqueueZoomChange(
        boolean enabled,
        UiThreadRunner uiThread,
        ZoomTargetSupplier targetSupplier,
        Runnable completion
    ) {
        final long generation = requestGeneration.incrementAndGet();
        uiThread.run(() -> {
            try {
                if (generation != requestGeneration.get()) {
                    return;
                }

                ZoomTarget target = targetSupplier.get();
                if (target != null) {
                    applyZoomState(target, enabled);
                }
            } finally {
                completion.run();
            }
        });
    }

    static void applyZoomState(ZoomTarget target, boolean enabled) {
        if (!enabled) {
            resetCurrentScale(target);
        }

        target.setSupportZoom(enabled);
        target.setBuiltInZoomControls(enabled);
        target.setDisplayZoomControls(false);
    }

    private static void resetCurrentScale(ZoomTarget target) {
        float currentScale = target.getScale();
        if (Float.isNaN(currentScale) || Float.isInfinite(currentScale) || currentScale <= 0.0f) {
            return;
        }

        float resetFactor = 1.0f / currentScale;
        if (Float.isNaN(resetFactor) || Float.isInfinite(resetFactor) || Math.abs(resetFactor - 1.0f) <= SCALE_EPSILON) {
            return;
        }

        // WebView.zoomBy rejects factors outside this documented range. Real
        // WebView scales are much narrower, but clamping keeps teardown safe if
        // a vendor WebView temporarily reports an extreme value.
        resetFactor = Math.max(MIN_WEBVIEW_ZOOM_FACTOR, Math.min(MAX_WEBVIEW_ZOOM_FACTOR, resetFactor));
        target.zoomBy(resetFactor);
    }

    interface UiThreadRunner {
        void run(Runnable action);
    }

    interface ZoomTargetSupplier {
        ZoomTarget get();
    }

    interface ZoomTarget {
        float getScale();

        void zoomBy(float factor);

        void setSupportZoom(boolean enabled);

        void setBuiltInZoomControls(boolean enabled);

        void setDisplayZoomControls(boolean enabled);
    }

    private static final class WebViewZoomTarget implements ZoomTarget {
        private final WebView webView;
        private final WebSettings settings;

        WebViewZoomTarget(WebView webView) {
            this.webView = webView;
            this.settings = webView.getSettings();
        }

        @Override
        @SuppressWarnings("deprecation")
        public float getScale() {
            return webView.getScale();
        }

        @Override
        public void zoomBy(float factor) {
            webView.zoomBy(factor);
        }

        @Override
        public void setSupportZoom(boolean enabled) {
            settings.setSupportZoom(enabled);
        }

        @Override
        public void setBuiltInZoomControls(boolean enabled) {
            settings.setBuiltInZoomControls(enabled);
        }

        @Override
        public void setDisplayZoomControls(boolean enabled) {
            settings.setDisplayZoomControls(enabled);
        }
    }
}
