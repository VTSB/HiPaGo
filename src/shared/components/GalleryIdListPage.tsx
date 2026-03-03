'use client';

import { useQuery } from '@tanstack/react-query';
import { GalleryGridById } from '@/features/gallery-list/components/GalleryGrid';
import { InfiniteScrollTrigger } from '@/shared/components/InfiniteScrollTrigger';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { usePaginatedIds } from '@/shared/hooks/usePaginatedIds';
import { useT } from '@/lib/i18n/useT';

const PAGE_SIZE = 25;

interface GalleryIdListPageProps {
  fetchIds: () => Promise<number[]>;
  title: string;
  emptyMessage: string;
  queryKey: string;
}

export function GalleryIdListPage({ fetchIds, title, emptyMessage, queryKey }: GalleryIdListPageProps) {
  const t = useT();

  const { data: allIds, isLoading } = useQuery({
    queryKey: [queryKey],
    queryFn: () => fetchIds(),
    staleTime: 0,
  });

  const { visibleIds, hasNextPage, isFetchingNextPage, fetchNextPage } = usePaginatedIds(
    allIds && allIds.length > 0 ? allIds : undefined,
    PAGE_SIZE,
    [queryKey],
  );

  const totalCount = allIds?.length ?? 0;

  return (
    <>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {title}
          {!isLoading && <span className="ml-2 text-lg font-normal text-zinc-500">({totalCount.toLocaleString()})</span>}
        </h1>
      </div>
      {!isLoading && totalCount === 0 ? (
        <p className="text-zinc-500 dark:text-zinc-400">{emptyMessage}</p>
      ) : (
        <GalleryGridById ids={visibleIds} isLoading={isLoading} />
      )}
      <InfiniteScrollTrigger
        hasMore={hasNextPage}
        isFetching={isFetchingNextPage}
        onLoadMore={() => {
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
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
