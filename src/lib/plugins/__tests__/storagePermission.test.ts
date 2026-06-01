import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — initialized before vi.mock factory runs (module-level registerPlugin)
const { isGranted, request, platform } = vi.hoisted(() => ({
  isGranted: vi.fn(),
  request: vi.fn(),
  platform: { value: 'android' },
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ isGranted, request }),
  Capacitor: { getPlatform: () => platform.value },
}));

import { StoragePermission } from '../storagePermission';

describe('StoragePermission wrapper', () => {
  beforeEach(() => {
    isGranted.mockReset();
    request.mockReset();
    platform.value = 'android';
  });

  // --- shape ---

  it('exposes isGranted and request methods', () => {
    expect(typeof StoragePermission.isGranted).toBe('function');
    expect(typeof StoragePermission.request).toBe('function');
  });

  // --- delegation on Android ---

  it('delegates isGranted to native on Android', async () => {
    isGranted.mockResolvedValue({ granted: true });
    const result = await StoragePermission.isGranted();
    expect(isGranted).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ granted: true });
  });

  it('delegates request to native on Android', async () => {
    request.mockResolvedValue(undefined);
    await StoragePermission.request();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('passes through granted:false from native', async () => {
    isGranted.mockResolvedValue({ granted: false });
    const result = await StoragePermission.isGranted();
    expect(result).toEqual({ granted: false });
  });

  // --- no-op on web ---

  it('returns granted:true without calling native on web', async () => {
    platform.value = 'web';
    const result = await StoragePermission.isGranted();
    expect(isGranted).not.toHaveBeenCalled();
    expect(result).toEqual({ granted: true });
  });

  it('resolves request without calling native on web', async () => {
    platform.value = 'web';
    await expect(StoragePermission.request()).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  // --- no-op on ios ---

  it('returns granted:true without calling native on ios', async () => {
    platform.value = 'ios';
    const result = await StoragePermission.isGranted();
    expect(isGranted).not.toHaveBeenCalled();
    expect(result).toEqual({ granted: true });
  });

  it('resolves request without calling native on ios', async () => {
    platform.value = 'ios';
    await expect(StoragePermission.request()).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
