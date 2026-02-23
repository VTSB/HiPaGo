'use client';

import Link from 'next/link';
import { SearchBar } from '@/features/search/components/SearchBar';
import { LanguageFilter } from '@/shared/components/LanguageFilter';
import { useT } from '@/lib/i18n/useT';

export function Header() {
  const t = useT();

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        <Link href="/" className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          HiPaGo
        </Link>
        <div className="flex flex-1 items-center gap-2">
          <SearchBar />
          <LanguageFilter />
        </div>
        <nav className="flex items-center gap-2">
          <Link href="/" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.browse')}</Link>
          <Link href="/favorites" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.favorites')}</Link>
          <Link href="/history" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.history')}</Link>
          <Link href="/settings" className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">{t('nav.settings')}</Link>
        </nav>
      </div>
    </header>
  );
}
