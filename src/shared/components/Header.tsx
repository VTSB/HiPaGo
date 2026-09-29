'use client';

import { Suspense, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SearchBar } from '@/features/search/components/SearchBar';
import { LanguageFilter } from '@/shared/components/LanguageFilter';
import { SyncStatusIndicator } from '@/shared/components/SyncStatusIndicator';
import { useT } from '@/lib/i18n/useT';
import { useScrollReveal } from '@/shared/hooks/useScrollReveal';
import { NAV_ITEMS, isNavActive } from '@/shared/nav/navItems';
import { QueueBadgeDot } from '@/shared/nav/QueueBadgeDot';

/** Desktop navigation uses the same destinations as the mobile tab bar. */
export function Header() {
  const t = useT();
  const pathname = usePathname();
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
        <nav aria-label={t('nav.main')} className="ml-auto hidden items-center gap-2 md:flex">
          <SyncStatusIndicator />
          {NAV_ITEMS.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isNavActive(pathname, n.href) ? 'page' : undefined}
              className={`relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${isNavActive(pathname, n.href) ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
            >
              {t(n.key)}
              {n.href === '/library' && <QueueBadgeDot className="absolute right-1 top-1" />}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
