'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import { SavedGalleryGrid, type SavedGalleryGridHandle } from '@/features/gallery-list/components/SavedGalleryGrid';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { DbErrorBanner } from '@/shared/components/DbErrorBanner';
import { DbStageSpinner } from '@/shared/components/DbStageSpinner';
import { FilterBar } from '@/shared/components/FilterBar';
import { getFavoriteIds } from '@/lib/db/gallery';
import { filterFavoritesByTags } from '@/lib/db/search-local';
import { useT } from '@/lib/i18n/useT';
import type { TagType } from '@/lib/utils/types';

const PAGE_SIZE = 25;

export function FavoritesView({ embedded = false }: { embedded?: boolean }) {
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

  const gridRef = useRef<SavedGalleryGridHandle>(null);
  const groups = useMemo(() => [{ key: 'favorites', items: activeIds ?? [] }], [activeIds]);

  const totalCount = activeIds?.length ?? 0;
  const showFilterBar = !isLoading && ((allIds?.length ?? 0) > 0 || hasFilters);

  return (
    <>
      {!embedded && (
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {t('favorites.title')}
            {!activeLoading && <span className="ml-2 text-lg font-normal text-zinc-500">({totalCount.toLocaleString()})</span>}
          </h1>
        </div>
      )}

      <DbErrorBanner />

      {/* Hide FilterBar entirely when the list is empty and no filter is
          active — the duplicate search input on top of an empty page was
          confusing on mobile and added clutter on desktop. */}
      {showFilterBar && (
        <div className="mb-4">
          <FilterBar onFilterChange={setFilters} placeholder={t('search.placeholder')} />
        </div>
      )}

      {activeLoading ? (
        <DbStageSpinner />
      ) : totalCount === 0 ? (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-14 w-14 text-zinc-300 dark:text-zinc-700"
            aria-hidden="true"
          >
            <path d="m11.48 3.5 2.13 5.11a.56.56 0 0 0 .47.34l5.52.45c.5.04.7.66.32.99l-4.2 3.6a.56.56 0 0 0-.18.55l1.29 5.39a.56.56 0 0 1-.84.6l-4.73-2.88a.56.56 0 0 0-.58 0l-4.73 2.88a.56.56 0 0 1-.84-.6l1.29-5.39a.56.56 0 0 0-.18-.55l-4.2-3.6c-.38-.33-.18-.95.32-.99l5.52-.45a.56.56 0 0 0 .47-.34l2.13-5.11a.56.56 0 0 1 1.04 0z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <p className="max-w-xs text-sm text-zinc-500 dark:text-zinc-400">
            {hasFilters ? t('search.noResults') : t('favorites.empty')}
          </p>
          {!hasFilters && (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {t('empty.browseGalleries')}
            </Link>
          )}
        </div>
      ) : (
        <SavedGalleryGrid ref={gridRef} groups={groups} getItemKey={(id) => id} renderItem={(id) => <GalleryCardById id={id} />} />
      )}
      <FloatingPageNav
        totalItems={totalCount}
        loadedItems={totalCount}
        pageSize={PAGE_SIZE}
        onJumpToPage={(page) => gridRef.current?.scrollToItem((page - 1) * PAGE_SIZE)}
      />
    </>
  );
}
