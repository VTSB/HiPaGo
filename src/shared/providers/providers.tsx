'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { DbInitializer } from '@/shared/components/DbInitializer';
import { DbErrorOverlay } from '@/shared/components/DbErrorOverlay';
import { initLocaleOnce, useSettingsStore } from '@/lib/store/settings';
import { AndroidBackButtonProvider } from '@/shared/providers/AndroidBackButtonProvider';

const LOCALE_TO_LANG: Record<string, string> = { en: 'en', ko: 'ko' };

export function Providers({ children }: { children: ReactNode }) {
  const locale = useSettingsStore((s) => s.locale);
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
    initLocaleOnce();
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

  // Sync dark mode class with theme setting
  const theme = useSettingsStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <AndroidBackButtonProvider>
        <DbInitializer />
        <DbErrorOverlay />
        {children}
      </AndroidBackButtonProvider>
    </QueryClientProvider>
  );
}
