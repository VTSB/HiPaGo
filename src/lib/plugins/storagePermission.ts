/**
 * Capacitor plugin wrapper for StoragePermission (Android all-files access).
 *
 * On Android 11+ (API 30+) this maps to MANAGE_EXTERNAL_STORAGE /
 * ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION.
 * On Android ≤ 10 (API < 30) it maps to the legacy WRITE_EXTERNAL_STORAGE
 * runtime permission.
 *
 * On non-Android platforms both methods are no-ops (isGranted returns true
 * because web/Tauri do not need the Android permission gate).
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

export interface StoragePermissionPlugin {
  /** Returns whether the all-files/write-external-storage permission is granted. */
  isGranted(): Promise<{ granted: boolean }>;
  /**
   * Opens the system Settings screen for granting the permission (API 30+)
   * or issues the runtime permission request dialog (API < 30).
   * Resolves after the screen has been launched; the caller must re-check
   * isGranted once the user returns.
   */
  request(): Promise<void>;
}

const _plugin = registerPlugin<StoragePermissionPlugin>('StoragePermission');

/**
 * Wrapped plugin that is a no-op on non-Android platforms.
 * isGranted() returns {granted: true} on web/Tauri so that non-Android
 * code paths do not need a platform check before calling.
 */
export const StoragePermission: StoragePermissionPlugin = {
  isGranted: () => {
    if (Capacitor.getPlatform() !== 'android') {
      return Promise.resolve({ granted: true });
    }
    return _plugin.isGranted();
  },
  request: () => {
    if (Capacitor.getPlatform() !== 'android') {
      return Promise.resolve();
    }
    return _plugin.request();
  },
};
