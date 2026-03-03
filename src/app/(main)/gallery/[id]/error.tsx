'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n/useT';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-4 py-12">
      <h2 className="text-lg font-semibold text-red-500">{t('error.galleryFailed')}</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{error.message}</p>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {t('error.tryAgain')}
        </button>
        <Link
          href="/"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {t('error.backHome')}
        </Link>
      </div>
    </div>
  );
}
