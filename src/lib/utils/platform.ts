'use client';

/**
 * Runtime platform detection for Tauri / Capacitor / Browser.
 *
 * In a plain browser (Next.js dev or static export), both isTauri and
 * isCapacitor return false and all requests go through /api proxy routes.
 *
 * Bug guard: `@capacitor/core` injects `window.Capacitor` on plain web
 * too (the moment any code calls registerPlugin), so a bare existence
 * check on `Capacitor` would mis-route web → native plugin and throw
 * "Plugin X is not implemented on web". We use `isNativePlatform()` —
 * Capacitor's own predicate — which returns false on web. Same shape
 * for Tauri 2: the runtime global is `__TAURI_INTERNALS__`, not the v1
 * `__TAURI__` that's no longer set.
 */

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isCapacitor(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/** True when running inside a native shell (Tauri or Capacitor). */
export function isNativePlatform(): boolean {
  return isTauri() || isCapacitor();
}
