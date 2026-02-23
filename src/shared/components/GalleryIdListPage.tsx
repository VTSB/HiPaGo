'use client';

import { useState, useEffect } from 'react';
import { GalleryGridById } from '@/features/gallery-list/components/GalleryGrid';
import { InfiniteScrollTrigger } from '@/shared/components/InfiniteScrollTrigger';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useT } from '@/lib/i18n/useT';

const PAGE_SIZE = 25;

interface GalleryIdListPageProps {
  fetchIds: () => Promise<number[]>;
  title: string;
  emptyMessage: string;
  queryKey: string;
}

export function GalleryIdListPage({ fetchIds, title, emptyMessage, queryKey }: GalleryIdListPageProps) {
  const [allIds, setAllIds] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        const result = await fetchIds();
        if (!cancelled) setAllIds(result);
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [fetchIds]);

  const paginatedQuery = useInfiniteQuery({
    queryKey: [queryKey, allIds.length],
    queryFn: ({ pageParam }): number[] => {
      const start = (pageParam as number) * PAGE_SIZE;
      return allIds.slice(start, start + PAGE_SIZE);
    },
    initialPageParam: 0,
    getNextPageParam: (_lastPage, allPages) => {
      const loaded = allPages.length * PAGE_SIZE;
      return loaded < allIds.length ? allPages.length : undefined;
    },
    enabled: allIds.length > 0,
  });

  const visibleIds = paginatedQuery.data?.pages.flat() ?? [];

  return (
    <>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {title}
          {!isLoading && <span className="ml-2 text-lg font-normal text-zinc-500">({allIds.length.toLocaleString()})</span>}
        </h1>
      </div>
      {!isLoading && allIds.length === 0 ? (
        <p className="text-zinc-500 dark:text-zinc-400">{emptyMessage}</p>
      ) : (
        <GalleryGridById ids={visibleIds} isLoading={isLoading} />
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
        totalItems={allIds.length}
        loadedItems={visibleIds.length}
        pageSize={PAGE_SIZE}
        hasMore={paginatedQuery.hasNextPage ?? false}
        onLoadMore={() => paginatedQuery.fetchNextPage()}
      />
    </>
  );
}
