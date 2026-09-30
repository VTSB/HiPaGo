'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n/useT';
import { BackBar } from '@/shared/components/BackBar';
import { SettingsNavigation } from '@/features/settings/components/SettingsNavigation';

export default function SettingsPage() {
  const t = useT();

  return (
    <div className="mx-auto max-w-2xl">
      <BackBar title={t('settings.title')} fallbackHref="/more" />
      <Link
        href="/more"
        className="mb-4 hidden text-sm text-zinc-500 hover:text-zinc-900 md:inline-block dark:hover:text-zinc-100"
      >
        ← {t('nav.more')}
      </Link>
      <h1 className="mb-2 hidden text-2xl font-bold text-zinc-900 md:block dark:text-zinc-100">
        {t('settings.title')}
      </h1>
      <p className="mb-6 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
        {t('settings.subtitle')}
      </p>
      <SettingsNavigation />
    </div>
  );
}
