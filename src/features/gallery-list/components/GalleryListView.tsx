'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useVirtualGallery } from '../hooks/useVirtualGallery';
import { VirtualGalleryGrid, type VirtualGalleryGridHandle } from './VirtualGalleryGrid';
import { FloatingPageNav, type FloatingPageNavHandle } from '@/shared/components/FloatingPageNav';
import { SortSelector } from '@/shared/components/SortSelector';
import { SkeletonGrid } from './GalleryGrid';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { useT } from '@/lib/i18n/useT';
import type { SortOrder } from '@/lib/utils/types';

export function GalleryListView() {
  const [sort, setSort] = useState<SortOrder>('date_added');
  const [viewingPage, setViewingPage] = useState(1);
  const [cachedTotalPages, setCachedTotalPages] = useState(0);
  const gridRef = useRef<VirtualGalleryGridHandle>(null);
  const floatingNavRef = useRef<FloatingPageNavHandle>(null);

  const { totalLength, requestPage, getItemId, isInitialLoading, error } =
    useVirtualGallery(sort);

  const t = useT();

  const totalPages = totalLength > 0 ? Math.ceil(totalLength / PAGE_SIZE) : 0;

  // Preserve totalPages across sort resets to avoid nav flicker
  useEffect(() => {
    if (totalPages > 0) setCachedTotalPages(totalPages);
  }, [totalPages]);
  const displayTotalPages = cachedTotalPages || totalPages;

  const handleJumpToPage = useCallback((page: number) => {
    setViewingPage(page);
    gridRef.current?.scrollToPage(page);
  }, []);

  // Prevent browser from restoring scroll position on refresh — virtual grid
  // always starts at the top and the restored position would be wrong.
  useEffect(() => {
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = 'auto'; };
  }, []);

  const handleSortChange = useCallback((newSort: SortOrder) => {
    setSort(newSort);
    setViewingPage(1);
    window.scrollTo({ top: 0 });
  }, []);

  if (error && totalLength === 0) {
    return <div className="py-12 text-center text-red-500">{error}</div>;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          {t(`sort.${sort}` as const)}
          {totalLength > 0 && (
            <span className="ml-2 text-lg font-normal text-zinc-500">
              ({totalLength.toLocaleString()})
            </span>
          )}
        </h1>
        <SortSelector value={sort} onChange={handleSortChange} />
      </div>

      {isInitialLoading ? (
        <SkeletonGrid />
      ) : (
        <VirtualGalleryGrid
          ref={gridRef}
          totalLength={totalLength}
          totalPages={displayTotalPages}
          viewingPage={viewingPage}
          getItemId={getItemId}
          requestPage={requestPage}
          onWindowSlide={() => floatingNavRef.current?.suppress()}
        />
      )}

      <FloatingPageNav
        ref={floatingNavRef}
        totalItems={displayTotalPages * PAGE_SIZE}
        loadedItems={totalLength}
        pageSize={PAGE_SIZE}
        hasMore={false}
        viewingPage={viewingPage}
        onViewingPageChange={setViewingPage}
        onJumpToPage={handleJumpToPage}
      />
    </div>
  );
}
