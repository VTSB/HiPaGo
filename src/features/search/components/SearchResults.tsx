'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { GalleryGridById } from '@/features/gallery-list/components/GalleryGrid';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import { InfiniteScrollTrigger } from '@/shared/components/InfiniteScrollTrigger';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { SortSelector } from '@/shared/components/SortSelector';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { getGalleryIdsForQuery } from '@/lib/api/search';
import { parseCompoundQuery } from '@/lib/api/search';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import type { SortOrder } from '@/lib/utils/types';

const RESULTS_PER_PAGE = 25;

export function SearchResults() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') || '';
  const language = useSettingsStore((s) => s.language);
  const t = useT();
  const [sort, setSort] = useState<SortOrder>('date_added');

  // Sort only works for single-term typed queries (nozomi-based)
  const isSingleTerm = parseCompoundQuery(query).length === 1;

  // Detect numeric query (gallery ID)
  const numericId = /^\d+$/.test(query) ? Number(query) : null;

  const idsQuery = useQuery({
    queryKey: ['search-ids', query, language, sort],
    queryFn: () => getGalleryIdsForQuery(query, language, isSingleTerm ? sort : undefined),
    enabled: query.length > 0,
  });

  // Fallback: when a specific language returns 0 results or errors, retry with 'all'
  const langQueryDone = !idsQuery.isLoading && language !== 'all' && query.length > 0;
  const langQueryEmpty = langQueryDone && (idsQuery.isError || (idsQuery.data !== undefined && idsQuery.data.length === 0));
  const fallbackQuery = useQuery({
    queryKey: ['search-ids', query, 'all', sort],
    queryFn: () => getGalleryIdsForQuery(query, 'all', isSingleTerm ? sort : undefined),
    enabled: langQueryEmpty,
  });

  const isFallback = langQueryEmpty && (fallbackQuery.data?.length ?? 0) > 0;
  const allIds = isFallback ? fallbackQuery.data : idsQuery.data;
  const isLoadingIds = idsQuery.isLoading || (langQueryEmpty && fallbackQuery.isLoading);

  // Filter out the featured numeric ID from regular results to avoid duplication
  const filteredIds = useMemo(() => {
    if (!allIds || numericId === null) return allIds;
    return allIds.filter((id) => id !== numericId);
  }, [allIds, numericId]);

  // Paginate the IDs for infinite scroll
  const paginatedQuery = useInfiniteQuery({
    queryKey: ['search-id-pages', query, filteredIds?.length, sort],
    queryFn: ({ pageParam }): number[] => {
      if (!filteredIds) return [];
      const start = (pageParam as number) * RESULTS_PER_PAGE;
      return filteredIds.slice(start, start + RESULTS_PER_PAGE);
    },
    initialPageParam: 0,
    getNextPageParam: (_lastPage, allPages) => {
      if (!filteredIds) return undefined;
      const loaded = allPages.length * RESULTS_PER_PAGE;
      return loaded < filteredIds.length ? allPages.length : undefined;
    },
    enabled: !!filteredIds?.length,
  });

  const visibleIds = paginatedQuery.data?.pages.flat() ?? [];
  const totalCount = (allIds?.length ?? 0);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('search.title')}: {query}</h1>
          <p className="text-sm text-zinc-500">
            {allIds
              ? `${totalCount.toLocaleString()} ${t('search.results')}`
              : isLoadingIds ? t('search.searching') : t('search.noResults')}
          </p>
        </div>
        {isSingleTerm && <SortSelector value={sort} onChange={setSort} />}
      </div>

      {isFallback && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {t('search.langFallback')}
        </p>
      )}

      {/* Featured gallery card for numeric queries */}
      {numericId !== null && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Gallery #{numericId}
          </h2>
          <div className="max-w-[200px]">
            <GalleryCardById id={numericId} />
          </div>
        </div>
      )}

      {/* Regular search results */}
      {(visibleIds.length > 0 || isLoadingIds) && (
        <>
          {numericId !== null && filteredIds && filteredIds.length > 0 && (
            <h2 className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
              {t('search.otherResults')}
            </h2>
          )}
          <GalleryGridById ids={visibleIds} isLoading={isLoadingIds} />
        </>
      )}

      <InfiniteScrollTrigger
        hasMore={paginatedQuery.hasNextPage ?? false}
        isFetching={paginatedQuery.isFetchingNextPage}
        onLoadMore={() => {
          if (paginatedQuery.hasNextPage && !paginatedQuery.isFetchingNextPage) {
            paginatedQuery.fetchNextPage();
          }
        }}
      />
      <FloatingPageNav
        totalItems={totalCount}
        loadedItems={visibleIds.length}
        pageSize={RESULTS_PER_PAGE}
        hasMore={paginatedQuery.hasNextPage ?? false}
        onLoadMore={() => paginatedQuery.fetchNextPage()}
      />
    </div>
  );
}
