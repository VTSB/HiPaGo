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
import type { SortOrder } from '@/lib/utils/types';

const VALID_SORTS: SortOrder[] = ['date_added', 'popular_year', 'popular_month', 'popular_week', 'popular_day'];

export function GalleryListView() {
  const searchParams = useSearchParams();

  // Read sort from URL with validation
  const [sort, setSort] = useState<SortOrder>(() => {
    const s = searchParams.get('sort');
    return s && VALID_SORTS.includes(s as SortOrder) ? (s as SortOrder) : 'date_added';
  });

  // Read at/page from URL — migrate ?page= to ?at=
  const initialAt = (() => {
    const at = searchParams.get('at');
    if (at) return Math.max(0, parseInt(at, 10) || 0);
    const page = searchParams.get('page');
    if (page) return Math.max(0, (parseInt(page, 10) || 1) - 1) * PAGE_SIZE;
    return 0;
  })();

  const [viewingPage, setViewingPage] = useState(() =>
    initialAt > 0 ? Math.floor(initialAt / PAGE_SIZE) + 1 : 1
  );

  const gridRef = useRef<VirtualGalleryGridHandle>(null);
  const floatingNavRef = useRef<FloatingPageNavHandle>(null);

  const { totalLength, requestPage, getItemId, isInitialLoading, error } =
    useVirtualGallery(sort);

  const t = useT();

  const totalPages = totalLength > 0 ? Math.ceil(totalLength / PAGE_SIZE) : 0;

  // Ratchet: once totalPages is known, never go back to 0 (prevents height collapse
  // during rapid scrolling). Use render-phase setState — the React-documented pattern
  // for derived state (react-hooks/set-state-in-effect safe).
  const [cachedTotalPages, setCachedTotalPages] = useState(0);
  if (totalPages > cachedTotalPages) {
    setCachedTotalPages(totalPages);
  }
  const displayTotalPages = cachedTotalPages || totalPages;

  const handleJumpToPage = useCallback((page: number) => {
    setViewingPage(page);
    gridRef.current?.scrollToPage(page);
  }, []);

  useEffect(() => {
    history.scrollRestoration = 'manual';
    return () => { history.scrollRestoration = 'auto'; };
  }, []);

  // Debounced URL sync on scroll (200ms).
  // sortRef holds the latest sort so the scroll handler always uses the current
  // value without being re-subscribed on every sort change. Assigned in an
  // effect, not during render (react-hooks/refs).
  const urlTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sortRef = useRef(sort);
  useEffect(() => {
    sortRef.current = sort;
  });
  useEffect(() => {
    const syncUrl = () => {
      clearTimeout(urlTimerRef.current);
      urlTimerRef.current = setTimeout(() => {
        const url = new URL(window.location.href);
        let at = 0;
        const items = document.querySelectorAll('[data-item-index]');
        for (let i = items.length - 1; i >= 0; i--) {
          const rect = items[i].getBoundingClientRect();
          if (rect.top <= 100) {
            at = parseInt((items[i] as HTMLElement).dataset.itemIndex || '0', 10);
            break;
          }
        }
        if (at > 0) url.searchParams.set('at', String(at));
        else url.searchParams.delete('at');
        if (sortRef.current !== 'date_added') url.searchParams.set('sort', sortRef.current);
        else url.searchParams.delete('sort');
        url.searchParams.delete('page');
        window.history.replaceState(history.state, '', url.pathname + url.search);
      }, 200);
    };
    window.addEventListener('scroll', syncUrl, { passive: true });
    syncUrl(); // initial sync for sort changes
    return () => {
      window.removeEventListener('scroll', syncUrl);
      clearTimeout(urlTimerRef.current);
    };
  }, [sort]);

  // Scroll restoration
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || totalLength === 0 || initialAt <= 0) return;
    restoredRef.current = true;
    gridRef.current?.scrollToItem(initialAt);
  }, [totalLength, initialAt]);

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
      <div className="mb-5 flex flex-col gap-3 sm:mb-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-[1.75rem] font-bold leading-tight text-zinc-900 dark:text-zinc-100 sm:text-2xl">
          {t(`sort.${sort}` as const)}
          {totalLength > 0 && (
            <span className="ml-2 text-xl font-normal text-zinc-500 sm:text-lg">
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
