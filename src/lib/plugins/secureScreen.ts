/**
 * Capacitor plugin wrapper for Android FLAG_SECURE.
 *
 * When enabled, Android hides the app from screenshots, screen recording, and
 * the recent-apps thumbnail. It is intentionally Android-only; other platforms
 * no-op so settings hydration never fails on web/iOS.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface SecureScreenPlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

const SecureScreen = registerPlugin<SecureScreenPlugin>('SecureScreen');

export async function setSecureScreen(enabled: boolean): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    await SecureScreen.setEnabled({ enabled });
  } catch {
    // Best-effort: older native builds without the plugin should keep running.
  }
}
