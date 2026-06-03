'use client';

import type { CSSProperties, ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { BottomNav } from '@/shared/components/BottomNav';
import { isRootTab } from '@/shared/nav/navItems';

/**
 * Client shell for the (main) route group. Decides root-tab vs stacked from the
 * current route (and the `?q=` on /search) and:
 *  - renders the bottom tab bar ONLY on root tabs,
 *  - reserves bottom padding for the tab bar on root tabs, and drops it on
 *    stacked routes (which instead get a sticky BackBar from the page itself).
 * Must be rendered inside a <Suspense> boundary (useSearchParams).
 */
export function MainShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const root = isRootTab(pathname, searchParams.has('q'));

  // The floating page chip (FloatingPageNav) reads --page-chip-bottom: above
  // the tab bar on root tabs, but near the bottom on stacked routes (no tab
  // bar there, so it must not float --bottom-nav-h high). Custom properties
  // inherit down the DOM, so the fixed chip inside <main> picks this up.
  const chipBottom = root
    ? 'calc(var(--bottom-nav-h) + 0.5rem)'
    : 'calc(1rem + env(safe-area-inset-bottom))';

  return (
    <>
      <main
        style={{ '--page-chip-bottom': chipBottom } as CSSProperties}
        className={
          root
            ? 'mx-auto max-w-7xl px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(var(--bottom-nav-h)+3rem)] sm:pt-6 md:pb-6'
            : 'mx-auto max-w-7xl px-4 pt-0 pb-[calc(1.5rem+env(safe-area-inset-bottom))] md:pt-6 md:pb-10'
        }
      >
        {children}
      </main>
      {root && <BottomNav />}
    </>
  );
}
