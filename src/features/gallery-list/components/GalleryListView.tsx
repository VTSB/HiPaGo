'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useVirtualGallery } from '../hooks/useVirtualGallery';
import { VirtualGalleryGrid, type VirtualGalleryGridHandle } from './VirtualGalleryGrid';
import { FloatingPageNav, type FloatingPageNavHandle } from '@/shared/components/FloatingPageNav';
import { SortSelector } from '@/shared/components/SortSelector';
import { SkeletonGrid } from './GalleryGrid';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { useT } from '@/lib/i18n/useT';
import { useSettingsStore } from '@/lib/store/settings';
import type { SortOrder } from '@/lib/utils/types';

const VALID_SORTS: SortOrder[] = [
  'date_added',
  'popular_year',
  'popular_month',
  'popular_week',
  'popular_day',
];
export function GalleryListView() {
  const searchParams = useSearchParams();

  // Read sort from URL with validation
  const [sort, setSort] = useState<SortOrder>(() => {
    const s = searchParams.get('sort');
    return s && VALID_SORTS.includes(s as SortOrder) ? (s as SortOrder) : 'date_added';
  });

  const [viewingPage, setViewingPage] = useState(1);

  const gridRef = useRef<VirtualGalleryGridHandle>(null);
  const floatingNavRef = useRef<FloatingPageNavHandle>(null);

  const { totalLength, requestPage, getItemId, isInitialLoading, error } = useVirtualGallery(sort);

  const language = useSettingsStore((s) => s.language);

  const t = useT();

  const totalPages = totalLength > 0 ? Math.ceil(totalLength / PAGE_SIZE) : 0;

  // Ratchet: once totalPages is known, never go back to 0 (prevents height collapse
  // during rapid scrolling). Use render-phase setState — the React-documented pattern
  // for derived state (react-hooks/set-state-in-effect safe). Reset to 0 when the
  // sort or language filter changes so the new (typically smaller) total replaces
  // the stale max from the prior population — otherwise switching from `all` to
  // a per-language filter leaves FloatingPageNav and the virtualizer showing the
  // all-languages page total.
  const [cachedTotalPages, setCachedTotalPages] = useState(0);
  const [prevSortForCache, setPrevSortForCache] = useState(sort);
  const [prevLanguageForCache, setPrevLanguageForCache] = useState(language);
  if (sort !== prevSortForCache || language !== prevLanguageForCache) {
    setPrevSortForCache(sort);
    setPrevLanguageForCache(language);
    setCachedTotalPages(0);
  }
  if (totalPages > cachedTotalPages) {
    setCachedTotalPages(totalPages);
  }
  const displayTotalPages = cachedTotalPages || totalPages;

  const handleJumpToPage = useCallback((page: number) => {
    setViewingPage(page);
    gridRef.current?.scrollToPage(page);
  }, []);

  const replaceUrlState = useCallback((nextSort: SortOrder) => {
    const url = new URL(window.location.href);
    url.searchParams.delete('at');
    url.searchParams.delete('page');
    if (nextSort !== 'date_added') url.searchParams.set('sort', nextSort);
    else url.searchParams.delete('sort');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }, []);

  useEffect(() => {
    replaceUrlState(sort);
  }, [replaceUrlState, sort]);

  const handleSortChange = useCallback((newSort: SortOrder) => {
    setSort(newSort);
    setViewingPage(1);
    replaceUrlState(newSort);
    window.scrollTo({ top: 0 });
  }, [replaceUrlState]);

  if (error && totalLength === 0) {
    return <div className="py-12 text-center text-red-500">{error}</div>;
  }

  return (
    <div>
      <div className="mb-4 flex flex-row items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-2xl font-bold leading-tight text-zinc-900 dark:text-zinc-100">
          {t(`sort.${sort}` as const)}
          {totalLength > 0 && (
            <span className="ml-2 text-lg font-normal text-zinc-500">
              ({totalLength.toLocaleString()})
            </span>
          )}
        </h1>
        <div className="shrink-0">
          <SortSelector value={sort} onChange={handleSortChange} />
        </div>
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
