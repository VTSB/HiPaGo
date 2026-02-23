'use client';

import { useState, useCallback } from 'react';
import { useGalleryList } from '../hooks/useGalleryList';
import { GalleryGridById } from './GalleryGrid';
import { InfiniteScrollTrigger } from '@/shared/components/InfiniteScrollTrigger';
import { FloatingPageNav } from '@/shared/components/FloatingPageNav';
import { SortSelector } from '@/shared/components/SortSelector';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { useT } from '@/lib/i18n/useT';
import type { SortOrder } from '@/lib/utils/types';

export function GalleryListView() {
  const [sort, setSort] = useState<SortOrder>('date_added');
  const { ids, loading, error, hasMore, loadMore, isFetchingMore, totalPages, totalLength } = useGalleryList(1, sort);
  const t = useT();

  const handleSortChange = useCallback((newSort: SortOrder) => {
    setSort(newSort);
    window.scrollTo({ top: 0 });
  }, []);

  if (error && ids.length === 0) {
    return <div className="py-12 text-center text-red-500">{error}</div>;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t(`sort.${sort}` as const)}
          {totalLength > 0 && <span className="ml-2 text-lg font-normal text-zinc-500">({totalLength.toLocaleString()})</span>}
        </h1>
        <SortSelector value={sort} onChange={handleSortChange} />
      </div>
      <GalleryGridById ids={ids} isLoading={loading && ids.length === 0} />
      <InfiniteScrollTrigger
        hasMore={hasMore}
        isFetching={isFetchingMore}
        onLoadMore={loadMore}
      />
      <FloatingPageNav
        totalItems={totalPages * PAGE_SIZE}
        loadedItems={ids.length}
        pageSize={PAGE_SIZE}
        hasMore={hasMore}
        onLoadMore={loadMore}
      />
    </div>
  );
}
