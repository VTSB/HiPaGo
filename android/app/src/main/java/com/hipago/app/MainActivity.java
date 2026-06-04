package com.hipago.app;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BypassPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        registerPlugin(ReaderZoomPlugin.class);
        registerPlugin(PublicLibraryPlugin.class);
        super.onCreate(savedInstanceState);
        installBackButtonHandler();
        installBypassInterceptor();
    }

    /**
     * Route hitomi/CDN requests through bypass-core at the WebView layer so the
     * app can load them as ordinary {@code <img>}/{@code fetch()} resources
     * (see {@link BypassWebViewClient}). Extends Capacitor's own client, so local
     * app assets and routing are preserved.
     */
    private void installBypassInterceptor() {
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setWebViewClient(new BypassWebViewClient(bridge));
        }
    }

    private void installBackButtonHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleNativeBackButton();
            }
        });
    }

    private void handleNativeBackButton() {
        if (bridge == null || bridge.getWebView() == null) {
            finish();
            return;
        }

        WebView webView = bridge.getWebView();
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__hipagoHandleAndroidBack&&window.__hipagoHandleAndroidBack());}catch(e){return false;}})();",
                handled -> {
                    if (!"true".equals(handled)) {
                        finish();
                    }
                });
    }
}
