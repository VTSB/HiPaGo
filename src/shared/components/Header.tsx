'use client';

import { Suspense, useRef } from 'react';
import Link from 'next/link';
import { SearchBar } from '@/features/search/components/SearchBar';
import { LanguageFilter } from '@/shared/components/LanguageFilter';
import { SyncStatusIndicator } from '@/shared/components/SyncStatusIndicator';
import { useT } from '@/lib/i18n/useT';
import { useScrollReveal } from '@/shared/hooks/useScrollReveal';
import { NAV_ITEMS } from '@/shared/nav/navItems';

/**
 * Top header. Desktop (>=md) is unchanged: brand + search + language filter +
 * horizontal nav. Mobile (<md) is now a slim brand bar only — the old
 * hamburger drawer is replaced by the BottomNav tab bar, and the stretched
 * mobile search field is gone (search lives in the Search tab / dedicated
 * /search page). LanguageFilter on mobile lives in Settings; SyncStatus stays
 * desktop-only (mobile surfaces DB problems via DbErrorBanner). The sticky bar
 * still gesture-slides on scroll via `--list-chrome`.
 */
export function Header() {
  const t = useT();
  const headerRef = useRef<HTMLElement | null>(null);
  useScrollReveal({
    scrollElement: typeof window !== 'undefined' ? window : null,
    targetRef: headerRef,
    varName: '--list-chrome',
  });

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-50 hidden border-b border-zinc-200 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur-sm will-change-transform md:block dark:border-zinc-800 dark:bg-zinc-950/90"
      style={{ transform: 'translateY(calc(var(--list-chrome, 0) * -100%))' }}
    >
      <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-3 px-4 py-2 md:gap-4">
        {/* Brand — left-most on every viewport (mobile replaces the old hamburger). */}
        <Link
          href="/"
          className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100"
        >
          HiPaGo
        </Link>

        {/* Search + language filter — desktop only. Mobile uses the Search tab. */}
        <div className="hidden flex-1 items-center gap-2 md:flex">
          <Suspense>
            <SearchBar />
          </Suspense>
          <LanguageFilter />
        </div>

        {/* Desktop nav */}
        <nav className="ml-auto hidden items-center gap-2 md:flex">
          <SyncStatusIndicator />
          {NAV_ITEMS.slice(0, 4).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t(n.key)}
            </Link>
          ))}
          <div className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
          <Link
            href="/settings"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {t('nav.settings')}
          </Link>
        </nav>
      </div>
    </header>
  );
}
