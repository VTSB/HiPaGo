'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GalleryGridById } from '@/features/gallery-list/components/GalleryGrid';
import { InfiniteScrollTrigger } from '@/shared/components/InfiniteScrollTrigger';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { usePaginatedIds } from '@/shared/hooks/usePaginatedIds';
import { Spinner } from '@/shared/components/Spinner';
import { FilterBar } from '@/shared/components/FilterBar';
import { getFavoriteIds } from '@/lib/db/gallery';
import { filterFavoritesByTags } from '@/lib/db/search-local';
import { useT } from '@/lib/i18n/useT';
import type { TagType } from '@/lib/utils/types';

const PAGE_SIZE = 25;

export default function FavoritesPage() {
  const t = useT();
  const [filters, setFilters] = useState<{ tags: Array<{ type: TagType; name: string }>; titleQuery: string }>({ tags: [], titleQuery: '' });
  const hasFilters = filters.tags.length > 0 || filters.titleQuery.length > 0;

  const { data: allIds, isLoading } = useQuery({
    queryKey: ['favorites-pages'],
    queryFn: () => getFavoriteIds(),
    staleTime: 0,
  });

  const { data: filteredIds, isLoading: isFilterLoading } = useQuery({
    queryKey: ['favorites-filtered', filters],
    queryFn: () => filterFavoritesByTags(filters.tags, filters.titleQuery || undefined),
    enabled: hasFilters,
    staleTime: 0,
  });

  const activeIds = hasFilters ? filteredIds : allIds;
  const activeLoading = hasFilters ? isFilterLoading : isLoading;

  const { visibleIds, hasNextPage, isFetchingNextPage, fetchNextPage } = usePaginatedIds(
    activeIds && activeIds.length > 0 ? activeIds : undefined,
    PAGE_SIZE,
    hasFilters ? ['favorites-filtered-pages', filters] : ['favorites-pages'],
  );

  const totalCount = activeIds?.length ?? 0;

  return (
    <>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t('favorites.title')}
          {!activeLoading && <span className="ml-2 text-lg font-normal text-zinc-500">({totalCount.toLocaleString()})</span>}
        </h1>
      </div>

      <div className="mb-4">
        <FilterBar onFilterChange={setFilters} placeholder={t('search.placeholder')} />
      </div>

      {activeLoading ? (
        <div className="flex justify-center py-12"><Spinner size="md" /></div>
      ) : totalCount === 0 ? (
        <p className="text-zinc-500 dark:text-zinc-400">
          {hasFilters ? t('search.noResults') : t('favorites.empty')}
        </p>
      ) : (
        <GalleryGridById ids={visibleIds} isLoading={false} />
      )}
      <InfiniteScrollTrigger
        hasMore={hasNextPage}
        isFetching={isFetchingNextPage}
        onLoadMore={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage(); }}
      />
      <FloatingPageNav
        totalItems={totalCount}
        loadedItems={visibleIds.length}
        pageSize={PAGE_SIZE}
        hasMore={hasNextPage}
        onLoadMore={fetchNextPage}
      />
    </>
  );
}
