'use client';

import { useState, useEffect } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

/**
 * Returns true when the viewport matches the mobile breakpoint (max-width: 767px).
 * SSR-safe: defaults to false on the server and on the first client render to
 * avoid hydration mismatches; reads the initial value via rAF after mount so
 * the setState call is not synchronous within the effect body.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    // Defer initial state read out of the effect body to satisfy
    // react-hooks/set-state-in-effect (same rAF pattern as Header.tsx drawer).
    const frame = window.requestAnimationFrame(() => setIsMobile(mql.matches));
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => {
      window.cancelAnimationFrame(frame);
      mql.removeEventListener('change', handler);
    };
  }, []);

  return isMobile;
}
