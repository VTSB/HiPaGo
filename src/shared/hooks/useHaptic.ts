'use client';

import { useCallback } from 'react';

export interface HapticAPI {
  light: () => void;
  medium: () => void;
}

/**
 * Feature-detected haptic feedback. Uses `navigator.vibrate` on web (broadly
 * supported on Android Chromium; iOS Safari ignores). Native Capacitor
 * haptics are intentionally NOT imported here — `@capacitor/haptics` is not
 * a project dependency yet, so attempting a dynamic import would either
 * bundle a stub or hard-fail on web. A follow-up task adds the native dep
 * and routes through Capacitor on `isNativePlatform()`.
 */
export function useHaptic(): HapticAPI {
  const buzz = useCallback((ms: number) => {
    if (typeof navigator === 'undefined') return;
    if (typeof navigator.vibrate !== 'function') return;
    try { navigator.vibrate(ms); } catch { /* iOS Safari etc. */ }
  }, []);
  return {
    light: useCallback(() => buzz(10), [buzz]),
    medium: useCallback(() => buzz(20), [buzz]),
  };
}
