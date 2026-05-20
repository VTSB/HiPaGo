// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('platform detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  describe('isTauri', () => {
    it('returns false when window is undefined (SSR)', async () => {
      const { isTauri } = await import('../platform');
      // In node env, window is undefined
      expect(isTauri()).toBe(false);
    });

    it('returns true when window.__TAURI_INTERNALS__ exists (Tauri v2)', async () => {
      vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
      vi.resetModules();
      const { isTauri } = await import('../platform');
      expect(isTauri()).toBe(true);
    });

    it('returns false on legacy __TAURI__-only global (Tauri v1, intentionally unsupported)', async () => {
      vi.stubGlobal('window', { __TAURI__: {} });
      vi.resetModules();
      const { isTauri } = await import('../platform');
      expect(isTauri()).toBe(false);
    });
  });

  describe('isCapacitor', () => {
    it('returns false when window is undefined (SSR)', async () => {
      const { isCapacitor } = await import('../platform');
      expect(isCapacitor()).toBe(false);
    });

    it('returns true when Capacitor.isNativePlatform() is true (Android/iOS)', async () => {
      vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
      vi.resetModules();
      const { isCapacitor } = await import('../platform');
      expect(isCapacitor()).toBe(true);
    });

    // Regression: @capacitor/core injects window.Capacitor on plain web
    // too (the moment any code calls registerPlugin). A bare existence
    // check used to flip isCapacitor() to true here, which then routed
    // client.ts → Bypass.fetch → "Plugin Bypass is not implemented on web".
    it('returns false when window.Capacitor exists but isNativePlatform() is false (web shim)', async () => {
      vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } });
      vi.resetModules();
      const { isCapacitor } = await import('../platform');
      expect(isCapacitor()).toBe(false);
    });
  });

  describe('isNativePlatform', () => {
    it('returns false when neither Tauri nor Capacitor', async () => {
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(false);
    });

    it('returns true when Tauri v2 is present', async () => {
      vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
      vi.resetModules();
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(true);
    });

    it('returns true when Capacitor native is present', async () => {
      vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
      vi.resetModules();
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(true);
    });

    it('returns false when only the Capacitor web shim is present', async () => {
      vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } });
      vi.resetModules();
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(false);
    });
  });
});
