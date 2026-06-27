package com.hipago.app;

import android.os.Build;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Hides app content from Android's recent-apps thumbnail while allowing normal
 * foreground screenshots where the platform supports separate recents control.
 */
@CapacitorPlugin(name = "SecureScreen")
public class SecureScreenPlugin extends Plugin {
    private boolean enabled = false;
    private boolean resumed = true;

    @PluginMethod
    public void setEnabled(PluginCall call) {
        final boolean nextEnabled = call.getBoolean("enabled", false);
        getActivity().runOnUiThread(() -> {
            enabled = nextEnabled;
            applyProtection();
            call.resolve();
        });
    }

    @Override
    protected void handleOnResume() {
        resumed = true;
        getActivity().runOnUiThread(this::applyProtection);
    }

    @Override
    protected void handleOnPause() {
        resumed = false;
        getActivity().runOnUiThread(this::applyProtection);
    }

    private void applyProtection() {
        Window window = getActivity().getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getActivity().setRecentsScreenshotEnabled(!enabled);
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            return;
        }

        // Pre-Android 13 has no separate recent-apps thumbnail API. Keep
        // screenshots enabled while the app is foregrounded, then enable
        // FLAG_SECURE only as the activity leaves the screen so recents avoids
        // capturing content.
        if (enabled && !resumed) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }
}
