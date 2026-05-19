'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { SearchBar } from '@/features/search/components/SearchBar';
import { LanguageFilter } from '@/shared/components/LanguageFilter';
import { SyncStatusIndicator } from '@/shared/components/SyncStatusIndicator';
import { useT } from '@/lib/i18n/useT';

export function Header() {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-4 px-4 py-2">
        <Link href="/" className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          HiPaGo
        </Link>
        <div className="flex flex-1 items-center gap-2">
          <Suspense><SearchBar /></Suspense>
          <div className="hidden md:block">
            <LanguageFilter />
          </div>
        </div>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-2">
          <SyncStatusIndicator />
          <Link href="/" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.browse')}</Link>
          <Link href="/favorites" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.favorites')}</Link>
          <Link href="/history" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.history')}</Link>
          <Link href="/library" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.library')}</Link>
          <div className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
          <Link href="/settings" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.settings')}</Link>
        </nav>

        {/* Hamburger button — mobile only */}
        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((prev) => !prev)}
          className="md:hidden flex items-center justify-center rounded-md p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          {menuOpen ? (
            /* X icon */
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          ) : (
            /* Hamburger icon */
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-zinc-200 bg-white/95 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95">
          <nav className="mx-auto flex max-w-7xl flex-col px-4 py-2">
            <Link
              href="/"
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t('nav.browse')}
            </Link>
            <Link
              href="/favorites"
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t('nav.favorites')}
            </Link>
            <Link
              href="/history"
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t('nav.history')}
            </Link>
            <Link
              href="/library"
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t('nav.library')}
            </Link>
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              {t('nav.settings')}
            </Link>
            <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <LanguageFilter />
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
