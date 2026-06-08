import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setEnabled, platform } = vi.hoisted(() => ({
  setEnabled: vi.fn(),
  platform: { value: 'web' },
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ setEnabled }),
  Capacitor: { getPlatform: () => platform.value },
}));

import { setSecureScreen } from '../secureScreen';

describe('setSecureScreen', () => {
  beforeEach(() => {
    setEnabled.mockReset();
    setEnabled.mockResolvedValue(undefined);
  });

  it('is a no-op on web', async () => {
    platform.value = 'web';
    await setSecureScreen(true);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('is a no-op on iOS', async () => {
    platform.value = 'ios';
    await setSecureScreen(true);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it('calls the native plugin on Android', async () => {
    platform.value = 'android';
    await setSecureScreen(true);
    expect(setEnabled).toHaveBeenCalledWith({ enabled: true });
    await setSecureScreen(false);
    expect(setEnabled).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('swallows native errors', async () => {
    platform.value = 'android';
    setEnabled.mockRejectedValueOnce(new Error('not implemented'));
    await expect(setSecureScreen(true)).resolves.toBeUndefined();
  });
});
