'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { DbInitializer } from '@/shared/components/DbInitializer';
import { DbErrorOverlay } from '@/shared/components/DbErrorOverlay';
import {
  initLocaleOnce,
  initializeSettingsPersistence,
  useSettingsStore,
} from '@/lib/store/settings';
import { AndroidBackButtonProvider } from '@/shared/providers/AndroidBackButtonProvider';
import { setSecureScreen } from '@/lib/plugins/secureScreen';

const LOCALE_TO_LANG: Record<string, string> = { en: 'en', ko: 'ko' };
const SETTINGS_RETRY_BASE_MS = 1000;
const SETTINGS_RETRY_MAX_MS = 30_000;

export function Providers({ children }: { children: ReactNode }) {
  const locale = useSettingsStore((s) => s.locale);
  const secureScreen = useSettingsStore((s) => s.secureScreen);
  const [settingsReady, setSettingsReady] = useState(false);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 30 * 60 * 1000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  useEffect(() => {
    let active = true;
    let released = false;
    let localeInitialized = false;
    let retryDelay = SETTINGS_RETRY_BASE_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const releaseAppInitialization = () => {
      if (!active || released) return;
      released = true;
      // Database startup must not remain blocked behind a temporarily
      // unavailable native settings plugin. A later successful retry rehydrates
      // the Zustand store and its normal subscriptions update the live UI.
      setSettingsReady(true);
    };

    const initializeLocale = () => {
      if (!active || localeInitialized) return;
      localeInitialized = true;
      // Auto-locale writes localStorage. Delay it until native restore has
      // succeeded so it cannot be mistaken for an explicit same-session user
      // change by the restore baseline comparison.
      initLocaleOnce();
    };

    const attemptSettingsInitialization = async () => {
      try {
        await initializeSettingsPersistence();
        if (!active) return;
        releaseAppInitialization();
        initializeLocale();
      } catch {
        if (!active) return;
        releaseAppInitialization();

        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, SETTINGS_RETRY_MAX_MS);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void attemptSettingsInitialization();
        }, delay);
      }
    };

    void attemptSettingsInitialization();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'auto';
    }
  }, []);

  // Sync html lang attribute with locale (Issue 15)
  useEffect(() => {
    document.documentElement.lang = LOCALE_TO_LANG[locale] || 'en';
  }, [locale]);

  useEffect(() => {
    void setSecureScreen(secureScreen);
  }, [secureScreen]);

  // Sync dark mode class with theme setting
  const theme = useSettingsStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <AndroidBackButtonProvider>
        {settingsReady && <DbInitializer />}
        <DbErrorOverlay />
        {children}
      </AndroidBackButtonProvider>
    </QueryClientProvider>
  );
}
