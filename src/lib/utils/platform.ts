'use client';

/**
 * Runtime platform detection for Tauri / Capacitor / Browser.
 * In browser (plain Next.js), both isTauri and isCapacitor return false,
 * and all requests go through /api proxy routes.
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

export function isCapacitor(): boolean {
  return typeof window !== 'undefined' && 'Capacitor' in window;
}

/** True when running inside a native shell (Tauri or Capacitor). */
export function isNativePlatform(): boolean {
  return isTauri() || isCapacitor();
}
