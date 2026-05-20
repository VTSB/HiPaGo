'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SearchBar } from '@/features/search/components/SearchBar';
import { LanguageFilter } from '@/shared/components/LanguageFilter';
import { SyncStatusIndicator } from '@/shared/components/SyncStatusIndicator';
import { useT } from '@/lib/i18n/useT';

const NAV = [
  { href: '/', key: 'nav.browse' as const, icon: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M3 9.75 12 3l9 6.75V21a.75.75 0 0 1-.75.75h-4.5v-7.5h-7.5v7.5h-4.5A.75.75 0 0 1 3 21V9.75z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) },
  { href: '/favorites', key: 'nav.favorites' as const, icon: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="m11.48 3.5 2.13 5.11a.56.56 0 0 0 .47.34l5.52.45c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.55l1.29 5.39a.56.56 0 0 1-.84.6l-4.73-2.88a.56.56 0 0 0-.58 0l-4.73 2.88a.56.56 0 0 1-.84-.6l1.29-5.39a.56.56 0 0 0-.18-.55l-4.2-3.6c-.38-.33-.18-.95.32-.99l5.52-.45a.56.56 0 0 0 .47-.34l2.13-5.11a.56.56 0 0 1 1.04 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) },
  { href: '/history', key: 'nav.history' as const, icon: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M12 7v5l3 1.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) },
  { href: '/library', key: 'nav.library' as const, icon: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M4 4h4v16H4zM10 4h4v16h-4zM18 4l2 16-2 .25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) },
  { href: '/settings', key: 'nav.settings' as const, icon: (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
      <path d="M19.14 12.94a7.55 7.55 0 0 0 .06-.94c0-.32-.03-.62-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.66 8.87a.5.5 0 0 0 .12.61l2.03 1.58a7.55 7.55 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.61z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) },
];

export function Header() {
  const t = useT();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close drawer when route changes (e.g. user taps a link).
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // ESC to dismiss + lock body scroll while drawer is open.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const isActive = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex min-h-14 max-w-7xl items-center gap-3 px-4 py-2 md:gap-4">
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
            {NAV.slice(0, 4).map((n) => (
              <Link key={n.href} href={n.href} className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
                {t(n.key)}
              </Link>
            ))}
            <div className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
            <Link href="/settings" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
              {t('nav.settings')}
            </Link>
          </nav>

          {/* Hamburger — mobile only */}
          <button
            type="button"
            aria-label={menuOpen ? t('mobile.menu.close') : t('mobile.menu.open')}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((prev) => !prev)}
            className="md:hidden flex h-11 w-11 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </header>

      {/* Mobile overlay drawer */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true">
          {/* Backdrop */}
          <button
            type="button"
            aria-label={t('mobile.menu.close')}
            onClick={() => setMenuOpen(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px] transition-opacity"
          />
          {/* Drawer panel — slides in from the right, takes ~80vw */}
          <div className="absolute inset-y-0 right-0 flex w-[80%] max-w-sm flex-col bg-white shadow-2xl dark:bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">HiPaGo</span>
              <button
                type="button"
                aria-label={t('mobile.menu.close')}
                onClick={() => setMenuOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-2">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive(n.href)
                      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                  }`}
                >
                  <span className="text-zinc-500 dark:text-zinc-400">{n.icon}</span>
                  <span>{t(n.key)}</span>
                </Link>
              ))}
              <div className="mx-3 my-3 h-px bg-zinc-200 dark:bg-zinc-800" />
              <div className="px-3 pt-1">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {t('langFilter.label')}
                </p>
                <LanguageFilter />
              </div>
              <div className="px-3 pt-3">
                <SyncStatusIndicator />
              </div>
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
