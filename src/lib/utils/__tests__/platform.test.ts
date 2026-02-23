// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('platform detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('isTauri', () => {
    it('returns false when window is undefined (SSR)', async () => {
      const { isTauri } = await import('../platform');
      // In node env, window is undefined
      expect(isTauri()).toBe(false);
    });
  });

  describe('isCapacitor', () => {
    it('returns false when window is undefined (SSR)', async () => {
      const { isCapacitor } = await import('../platform');
      expect(isCapacitor()).toBe(false);
    });
  });

  describe('isNativePlatform', () => {
    it('returns false when neither Tauri nor Capacitor', async () => {
      const { isNativePlatform } = await import('../platform');
      expect(isNativePlatform()).toBe(false);
    });
  });
});
