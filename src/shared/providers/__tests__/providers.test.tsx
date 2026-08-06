// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Providers } from '../providers';
import { initLocaleOnce, initializeSettingsPersistence } from '@/lib/store/settings';

vi.mock('@/shared/components/DbInitializer', () => ({
  DbInitializer: () => <div data-testid="db-initializer" />,
}));

vi.mock('@/shared/components/DbErrorOverlay', () => ({
  DbErrorOverlay: () => null,
}));

vi.mock('@/shared/providers/AndroidBackButtonProvider', () => ({
  AndroidBackButtonProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/plugins/secureScreen', () => ({
  setSecureScreen: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  initLocaleOnce: vi.fn(),
  initializeSettingsPersistence: vi.fn(async () => {}),
  useSettingsStore: (
    sel: (s: { locale: string; theme: string; secureScreen: boolean }) => unknown,
  ) => sel({ locale: 'en', theme: 'light', secureScreen: false }),
}));

describe('Providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(initializeSettingsPersistence).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps browser history scroll restoration enabled', async () => {
    window.history.scrollRestoration = 'manual';

    render(<Providers>content</Providers>);
    await act(async () => Promise.resolve());

    expect(window.history.scrollRestoration).toBe('auto');
  });

  it('releases app initialization after a settings failure and retries in the same session', async () => {
    vi.useFakeTimers();
    vi.mocked(initializeSettingsPersistence)
      .mockRejectedValueOnce(new Error('plugin unavailable'))
      .mockResolvedValue(undefined);

    render(<Providers>content</Providers>);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('db-initializer')).toBeInTheDocument();
    expect(initLocaleOnce).not.toHaveBeenCalled();
    expect(initializeSettingsPersistence).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(initializeSettingsPersistence).toHaveBeenCalledTimes(2);
    expect(initLocaleOnce).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending settings retry when the provider unmounts', async () => {
    vi.useFakeTimers();
    vi.mocked(initializeSettingsPersistence).mockRejectedValue(new Error('plugin unavailable'));

    const { unmount } = render(<Providers>content</Providers>);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(initializeSettingsPersistence).toHaveBeenCalledTimes(1);
    expect(initLocaleOnce).not.toHaveBeenCalled();
  });
});
