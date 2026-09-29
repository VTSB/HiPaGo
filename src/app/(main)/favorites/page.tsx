'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n/useT';

/** Keep old bookmarks usable while library membership stays in the existing table. */
export default function FavoritesPage() {
  const router = useRouter();
  const t = useT();
  useEffect(() => {
    router.replace('/library');
  }, [router]);
  return <Link href="/library">{t('nav.saved')}</Link>;
}
