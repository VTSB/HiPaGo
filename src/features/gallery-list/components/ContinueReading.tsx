'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getContinueReading } from '@/lib/db/library';
import { listDownloads } from '@/lib/db/download';
import { GalleryCardById } from './GalleryCard';
import { readerHref } from '@/lib/utils/routes';
import { useT } from '@/lib/i18n/useT';

export function ContinueReading() {
  const t = useT();
  const { data: entries = [] } = useQuery({ queryKey: ['continue-reading'], queryFn: () => getContinueReading(6), staleTime: 0 });
  const { data: downloads = [] } = useQuery({ queryKey: ['library-downloads'], queryFn: listDownloads, enabled: entries.length > 0 });
  if (!entries.length) return null;
  return <section aria-label={t('actions.continue')} className="mb-8">
    <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">{t('actions.continue')}</h2><Link href="/history" className="text-sm text-zinc-500">{t('history.title')} →</Link></div>
    <div className="flex gap-3 overflow-x-auto pb-2">
      {entries.map(entry => <div key={entry.galleryId} className="w-32 shrink-0 sm:w-36">
        <GalleryCardById id={entry.galleryId} download={downloads.find(d => d.galleryId === entry.galleryId)} />
        <Link href={readerHref(entry.galleryId, entry.lastPage + 1)} className="mt-2 block rounded-lg bg-zinc-200 px-2 py-2 text-center text-xs dark:bg-zinc-800">{t('actions.continue')} · {entry.lastPage + 1}/{entry.totalPages}</Link>
      </div>)}
    </div>
  </section>;
}
