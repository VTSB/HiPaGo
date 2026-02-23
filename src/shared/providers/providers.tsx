'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { DbInitializer } from '@/shared/components/DbInitializer';
import { initLocaleOnce } from '@/lib/store/settings';

export function Providers({ children }: { children: ReactNode }) {
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

  return (
    <QueryClientProvider client={queryClient}>
      <DbInitializer />
      {children}
    </QueryClientProvider>
  );
}
