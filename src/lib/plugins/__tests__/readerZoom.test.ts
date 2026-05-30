import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so they are initialized before the (hoisted) vi.mock factory runs —
// registerPlugin is invoked at readerZoom.ts module top-level (import time).
const { setEnabled, platform } = vi.hoisted(() => ({
  setEnabled: vi.fn(),
  platform: { value: 'web' },
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ setEnabled }),
  Capacitor: { getPlatform: () => platform.value },
}));

import { setReaderZoom } from '../readerZoom';

describe('setReaderZoom', () => {
  beforeEach(() => {
    setEnabled.mockReset();
    setEnabled.mockResolvedValue(undefined);
  });

  it('is a no-op on web (never calls native)', async () => {
    platform.value = 'web';
    await setReaderZoom(true);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('is a no-op on iOS (viewport-governed there)', async () => {
    platform.value = 'ios';
    await setReaderZoom(true);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('calls the native plugin on Android', async () => {
    platform.value = 'android';
    await setReaderZoom(true);
    expect(setEnabled).toHaveBeenCalledWith({ enabled: true });
    await setReaderZoom(false);
    expect(setEnabled).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('swallows native errors (never throws into the reader)', async () => {
    platform.value = 'android';
    setEnabled.mockRejectedValueOnce(new Error('not implemented'));
    await expect(setReaderZoom(true)).resolves.toBeUndefined();
  });
});
