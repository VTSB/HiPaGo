'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import { FavoritesView } from '@/features/favorites/components/FavoritesView';
import { HistoryView } from '@/features/history/components/HistoryView';
import { DownloadsView } from '@/features/library/components/DownloadsView';

type Segment = 'favorites' | 'history' | 'downloads';

function parseSegment(value: string | null): Segment | null {
  return value === 'favorites' || value === 'history' || value === 'downloads' ? value : null;
}

function librarySegmentHref(segment: Segment): string {
  return `/library?tab=${segment}`;
}

export function LibraryHub() {
  const t = useT();
  const isMobile = useIsMobile();
  const router = useRouter();
  const searchParams = useSearchParams();
  const libraryInitialTab = useSettingsStore((s) => s.libraryInitialTab);
  const segment = parseSegment(searchParams.get('tab')) ?? libraryInitialTab;

  // Desktop: /library stays exactly the downloads page it is today.
  if (!isMobile) {
    return <DownloadsView />;
  }

  const segments: Array<{ id: Segment; label: string }> = [
    { id: 'favorites', label: t('saved.seg.favorites') },
    { id: 'history', label: t('saved.seg.history') },
    { id: 'downloads', label: t('saved.seg.downloads') },
  ];

  return (
    <>
      <div className="mb-4">
        <h1 className="mb-3 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('saved.title')}
        </h1>
        <div role="tablist" className="flex rounded-full bg-zinc-100 p-1 dark:bg-zinc-800">
          {segments.map(({ id, label }) => {
            const active = segment === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => router.replace(librarySegmentHref(id), { scroll: false })}
                className={`min-h-10 flex-1 rounded-full text-sm font-medium transition-colors ${
                  active
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100'
                    : 'text-zinc-500'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {segment === 'favorites' && <FavoritesView embedded />}
      {segment === 'history' && <HistoryView embedded />}
      {segment === 'downloads' && <DownloadsView embedded />}
    </>
  );
}
