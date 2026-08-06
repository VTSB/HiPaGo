'use client';

import { useCallback, useSyncExternalStore } from 'react';

const DUAL_PAGE_QUERY = '(min-width: 640px)';

/** Matches the Tailwind `sm` breakpoint used to expose the two-page control. */
export function useSupportsDualPage(): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const media = window.matchMedia(DUAL_PAGE_QUERY);
    media.addEventListener('change', onStoreChange);
    return () => media.removeEventListener('change', onStoreChange);
  }, []);

  const getSnapshot = useCallback(() => window.matchMedia(DUAL_PAGE_QUERY).matches, []);
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
