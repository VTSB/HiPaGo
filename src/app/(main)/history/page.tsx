'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRecentlyViewedWithDates } from '@/lib/db/gallery';
import { filterHistoryByTags } from '@/lib/db/search-local';
import { GalleryGridById } from '@/features/gallery-list/components/GalleryGrid';
import { Spinner } from '@/shared/components/Spinner';
import { FilterBar } from '@/shared/components/FilterBar';
import { InfiniteScrollTrigger } from '@/shared/components/InfiniteScrollTrigger';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { usePaginatedIds } from '@/shared/hooks/usePaginatedIds';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import type { TagType } from '@/lib/utils/types';

function toDateKey(viewedAt: string): string {
  const d = new Date(viewedAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateLabel(dateKey: string, locale: 'en' | 'ko'): string {
  const now = new Date();
  const todayKey = toDateKey(now.toISOString());

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday.toISOString());

  if (dateKey === todayKey) return locale === 'ko' ? '오늘' : 'Today';
  if (dateKey === yesterdayKey) return locale === 'ko' ? '어제' : 'Yesterday';

  const [y, m, d] = dateKey.split('-').map(Number);
  if (locale === 'ko') {
    return `${y}년 ${m}월 ${d}일`;
  }
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function groupByDate(entries: Array<{ galleryId: number; viewedAt: string }>): Array<{ dateKey: string; ids: number[] }> {
  const map = new Map<string, number[]>();
  const order: string[] = [];
  for (const { galleryId, viewedAt } of entries) {
    const key = toDateKey(viewedAt);
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
      order.push(key);
    }
    list.push(galleryId);
  }
  return order.map((dateKey) => ({ dateKey, ids: map.get(dateKey)! }));
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 pb-2 pt-4 first:pt-0">
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <span className="shrink-0 text-sm font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

const PAGE_SIZE = 25;

export default function HistoryPage() {
  const t = useT();
  const locale = useSettingsStore((s) => s.locale);

  const [filters, setFilters] = useState<{ tags: Array<{ type: TagType; name: string }>; titleQuery: string }>({ tags: [], titleQuery: '' });
  const hasFilters = filters.tags.length > 0 || filters.titleQuery.length > 0;

  const { data: entries, isLoading } = useQuery({
    queryKey: ['history-grouped'],
    queryFn: () => getRecentlyViewedWithDates(),
    staleTime: 0,
  });

  const { data: filteredIds, isLoading: isFilterLoading } = useQuery({
    queryKey: ['history-filtered', filters],
    queryFn: () => filterHistoryByTags(filters.tags, filters.titleQuery || undefined),
    enabled: hasFilters,
    staleTime: 0,
  });

  const { visibleIds, hasNextPage, isFetchingNextPage, fetchNextPage } = usePaginatedIds(
    hasFilters && filteredIds && filteredIds.length > 0 ? filteredIds : undefined,
    PAGE_SIZE,
    ['history-filtered-pages', filters],
  );

  const totalCount = entries?.length ?? 0;
  const groups = entries ? groupByDate(entries) : [];

  return (
    <>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('history.title')}
          {!isLoading && <span className="ml-2 text-lg font-normal text-zinc-500">({totalCount.toLocaleString()})</span>}
        </h1>
      </div>

      {/* Filter bar */}
      <div className="mb-4">
        <FilterBar onFilterChange={setFilters} placeholder={t('search.placeholder')} />
      </div>

      {hasFilters ? (
        isFilterLoading ? (
          <div className="flex justify-center py-12"><Spinner size="md" /></div>
        ) : filteredIds && filteredIds.length > 0 ? (
          <>
            <p className="mb-3 text-sm text-zinc-500">{filteredIds.length.toLocaleString()} {t('search.results')}</p>
            <GalleryGridById ids={visibleIds} isLoading={false} />
            <InfiniteScrollTrigger hasMore={hasNextPage} isFetching={isFetchingNextPage} onLoadMore={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage(); }} />
            <FloatingPageNav totalItems={filteredIds.length} loadedItems={visibleIds.length} pageSize={PAGE_SIZE} hasMore={hasNextPage} onLoadMore={fetchNextPage} />
          </>
        ) : (
          <p className="text-zinc-500 dark:text-zinc-400">{t('search.noResults')}</p>
        )
      ) : (
        isLoading ? (
          <div className="flex justify-center py-12"><Spinner size="md" /></div>
        ) : totalCount === 0 ? (
          <p className="text-zinc-500 dark:text-zinc-400">{t('history.empty')}</p>
        ) : (
          <div className="space-y-4">
            {groups.map(({ dateKey, ids }) => (
              <div key={dateKey}>
                <DateDivider label={formatDateLabel(dateKey, locale)} />
                <GalleryGridById ids={ids} isLoading={false} />
              </div>
            ))}
          </div>
        )
      )}
    </>
  );
}
