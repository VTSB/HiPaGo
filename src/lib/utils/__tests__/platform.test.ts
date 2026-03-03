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

    it('returns true when window.__TAURI__ exists', async () => {
      vi.stubGlobal('window', { __TAURI__: {} });
      vi.resetModules();
      const { isTauri } = await import('../platform');
      expect(isTauri()).toBe(true);
    });
  });

  describe('isCapacitor', () => {
    it('returns false when window is undefined (SSR)', async () => {
      const { isCapacitor } = await import('../platform');
      expect(isCapacitor()).toBe(false);
    });

    it('returns true when window.Capacitor exists', async () => {
      vi.stubGlobal('window', { Capacitor: {} });
      vi.resetModules();
      const { isCapacitor } = await import('../platform');
      expect(isCapacitor()).toBe(true);
    });
  });

  describe('isNativePlatform', () => {
    it('returns false when neither Tauri nor Capacitor', async () => {
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(false);
    });

    it('returns true when Tauri is present', async () => {
      vi.stubGlobal('window', { __TAURI__: {} });
      vi.resetModules();
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(true);
    });

    it('returns true when Capacitor is present', async () => {
      vi.stubGlobal('window', { Capacitor: {} });
      vi.resetModules();
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(true);
    });
  });
});
