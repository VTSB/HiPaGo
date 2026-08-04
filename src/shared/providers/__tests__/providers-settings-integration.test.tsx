// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const nativeBackup = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(async (options: { value: string }) => {
    void options;
  }),
  clear: vi.fn(async () => {}),
}));

vi.mock('@/lib/utils/platform', () => ({ isAndroid: () => true }));
vi.mock('@/lib/plugins/settingsBackup', () => ({ SettingsBackup: nativeBackup }));
vi.mock('@/shared/components/DbInitializer', () => ({
  DbInitializer: () => <div data-testid="db-initializer" />,
}));
vi.mock('@/shared/components/DbErrorOverlay', () => ({ DbErrorOverlay: () => null }));
vi.mock('@/shared/providers/AndroidBackButtonProvider', () => ({
  AndroidBackButtonProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/lib/plugins/secureScreen', () => ({ setSecureScreen: vi.fn(async () => {}) }));

async function loadProviderAndSettings() {
  const [{ Providers }, { useSettingsStore }] = await Promise.all([
    import('../providers'),
    import('@/lib/store/settings'),
  ]);
  return { Providers, useSettingsStore };
}

async function settleInitialFailure() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function runFirstRetry() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
  });
}

describe('Providers settings restore integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
    vi.clearAllMocks();
    nativeBackup.set.mockResolvedValue(undefined);
    nativeBackup.clear.mockResolvedValue(undefined);
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('ko-KR');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('keeps native settings while applying the authoritative DbInitializer tree', async () => {
    const nativeRaw = JSON.stringify({
      state: {
        locale: 'en',
        theme: 'light',
        readerMode: 'scroll',
        downloadTreeUri: 'content://stale',
        downloadTreeName: 'Stale',
      },
      version: 8,
    });
    nativeBackup.get
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValueOnce({ value: nativeRaw });
    const { Providers, useSettingsStore } = await loadProviderAndSettings();

    render(<Providers>content</Providers>);
    await settleInitialFailure();

    expect(screen.getByTestId('db-initializer')).toBeInTheDocument();
    expect(localStorage.getItem('hipago-settings')).toBeNull();

    // DbInitializer obtains this from the live persisted SAF grant while the
    // SharedPreferences retry is still pending.
    act(() =>
      useSettingsStore
        .getState()
        .restoreDownloadTreeFromNative('content://fresh', 'Fresh Downloads'),
    );

    await runFirstRetry();

    expect(nativeBackup.get).toHaveBeenCalledTimes(2);
    const mergedRaw = localStorage.getItem('hipago-settings');
    expect(mergedRaw).not.toBeNull();
    expect(JSON.parse(mergedRaw!).state).toEqual({
      locale: 'en',
      theme: 'light',
      readerMode: 'scroll',
      downloadTreeUri: 'content://fresh',
      downloadTreeName: 'Fresh Downloads',
    });
    expect(useSettingsStore.getState().locale).toBe('en');
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(useSettingsStore.getState().readerMode).toBe('scroll');
    expect(useSettingsStore.getState().downloadTreeUri).toBe('content://fresh');
    expect(document.documentElement.lang).toBe('en');
    expect(nativeBackup.set).toHaveBeenCalledWith({ value: mergedRaw });
  });

  it('keeps an explicit user change made while the native retry is pending', async () => {
    const oldNativeRaw = JSON.stringify({
      state: { locale: 'ko', theme: 'light' },
      version: 8,
    });
    nativeBackup.get
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValueOnce({ value: oldNativeRaw });
    const { Providers, useSettingsStore } = await loadProviderAndSettings();

    render(<Providers>content</Providers>);
    await settleInitialFailure();

    act(() => useSettingsStore.getState().setTheme('dark'));
    const userLocalRaw = localStorage.getItem('hipago-settings');
    expect(userLocalRaw).not.toBeNull();

    await runFirstRetry();

    expect(nativeBackup.get).toHaveBeenCalledTimes(2);
    const mergedRaw = localStorage.getItem('hipago-settings');
    expect(mergedRaw).not.toBeNull();
    expect(mergedRaw).not.toBe(oldNativeRaw);
    expect(JSON.parse(mergedRaw!).state).toEqual({ locale: 'ko', theme: 'dark' });
    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(nativeBackup.set).toHaveBeenCalledWith({ value: mergedRaw });
  });
});
