'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { DbInitializer } from '@/shared/components/DbInitializer';
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
        {children}
      </AndroidBackButtonProvider>
    </QueryClientProvider>
  );
}
