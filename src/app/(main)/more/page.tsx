'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n/useT';
import { useDbStatusStore } from '@/lib/store/db-status';

const destinations = [
  { href: '/history', title: 'nav.history', description: 'more.history.desc' },
  { href: '/settings', title: 'nav.settings', description: 'more.settings.desc' },
] as const;

export default function MorePage() {
  const t = useT();
  const needsAttention = useDbStatusStore((s) => Boolean(s.dbError || s.syncError));
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{t('nav.more')}</h1>
      <ul className="divide-y divide-zinc-200 overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {destinations.map((destination) => (
          <li key={destination.href}>
            <Link
              href={destination.href}
              className="flex min-h-20 items-center gap-4 px-4 py-4 hover:bg-zinc-50 active:bg-zinc-100 sm:px-5 dark:hover:bg-zinc-800 dark:active:bg-zinc-800"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {t(destination.title)}
                </p>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {t(destination.description)}
                </p>
              </div>
              {destination.href === '/settings' && needsAttention && (
                <span className="shrink-0 text-xs font-medium text-amber-600 dark:text-amber-400">
                  {t('settings.needsAttention')}
                </span>
              )}
              <span aria-hidden="true" className="text-xl text-zinc-400">
                ›
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
