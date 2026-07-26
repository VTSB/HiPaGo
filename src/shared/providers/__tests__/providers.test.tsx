// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Providers } from '../providers';

vi.mock('@/shared/components/DbInitializer', () => ({
  DbInitializer: () => null,
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
  it('keeps browser history scroll restoration enabled', () => {
    window.history.scrollRestoration = 'manual';

    render(<Providers>content</Providers>);

    expect(window.history.scrollRestoration).toBe('auto');
  });
});
