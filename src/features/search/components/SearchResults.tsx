'use client';

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { VirtualGalleryGrid, type VirtualGalleryGridHandle } from '@/features/gallery-list/components/VirtualGalleryGrid';
import { GalleryCardById } from '@/features/gallery-list/components/GalleryCard';
import { FloatingPageNav, type FloatingPageNavHandle } from '@/shared/components/FloatingPageNav';
import { SortSelector } from '@/shared/components/SortSelector';
import { useQuery } from '@tanstack/react-query';
import { getGalleryIdsForQuery, parseCompoundQuery } from '@/lib/api/search';
import { KOREAN_LABEL_TO_TYPE } from '@/lib/utils/tag-query';
import { TagType } from '@/lib/utils/types';
import { useSettingsStore } from '@/lib/store/settings';
import { useT } from '@/lib/i18n/useT';
import { PAGE_SIZE } from '@/lib/utils/constants';
import type { SortOrder } from '@/lib/utils/types';

const VALID_SORTS: SortOrder[] = ['date_added', 'popular_year', 'popular_month', 'popular_week', 'popular_day'];

/**
 * Human-readable header for a single search term. Drops a recognized type
 * prefix (English or Korean) and turns underscores into spaces. The term is
 * shown in the script it was searched in — Korean queries stay Korean per the
 * preserve-Korean premise. Falls back to the raw query when not a tag term.
 */
function formatSearchHeader(query: string): string {
  const trimmed = query.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) return trimmed.replace(/_/g, ' ');

  const prefix = trimmed.slice(0, colonIdx);
  const name = trimmed.slice(colonIdx + 1);
  const isKnownType =
    KOREAN_LABEL_TO_TYPE[prefix] !== undefined ||
    (Object.values(TagType) as string[]).includes(prefix.toLowerCase());
  if (!isKnownType || !name) return trimmed.replace(/_/g, ' ');
  return name.replace(/_/g, ' ');
}

export function SearchResults() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') || '';
  const language = useSettingsStore((s) => s.language);
  const t = useT();

  const [sort, setSort] = useState<SortOrder>(() => {
    const s = searchParams.get('sort');
    return s && VALID_SORTS.includes(s as SortOrder) ? (s as SortOrder) : 'date_added';
  });

  const initialAt = (() => {
    const at = searchParams.get('at');
    return at ? Math.max(0, parseInt(at, 10) || 0) : 0;
  })();

  const [viewingPage, setViewingPage] = useState(() =>
    initialAt > 0 ? Math.floor(initialAt / PAGE_SIZE) + 1 : 1
  );

  const gridRef = useRef<VirtualGalleryGridHandle>(null);
  const floatingNavRef = useRef<FloatingPageNavHandle>(null);

  const isSingleTerm = parseCompoundQuery(query).length === 1;
  const numericId = /^\d+$/.test(query) ? Number(query) : null;

  const idsQuery = useQuery({
    queryKey: ['search-ids', query, language, sort],
    queryFn: () => getGalleryIdsForQuery(query, language, isSingleTerm ? sort : undefined),
    enabled: query.length > 0,
  });

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

  const filteredIds = useMemo(() => {
    if (!allIds || numericId === null) return allIds ?? [];
    return allIds.filter((id) => id !== numericId);
  }, [allIds, numericId]);

  const totalCount = allIds?.length ?? 0;

  const getItemId = useCallback((index: number): number | null => {
    return filteredIds[index] ?? null;
  }, [filteredIds]);

  const requestPage = useCallback((_pageIndex: number) => {}, []);

  const totalPages = filteredIds.length > 0 ? Math.ceil(filteredIds.length / PAGE_SIZE) : 0;

  const handleJumpToPage = useCallback((page: number) => {
    setViewingPage(page);
    gridRef.current?.scrollToPage(page);
  }, [setViewingPage]);

  // Debounced URL sync on scroll (200ms).
  // sortRef holds the latest sort so the scroll handler always uses the current
  // value without being re-subscribed on every sort change. Assigned in an
  // effect, not during render (react-hooks/refs).
  const urlTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
        window.history.replaceState(history.state, '', url.pathname + url.search);
      }, 200);
    };
    window.addEventListener('scroll', syncUrl, { passive: true });
    syncUrl();
    return () => {
      window.removeEventListener('scroll', syncUrl);
      clearTimeout(urlTimerRef.current);
    };
  }, [sort]);

  // Scroll restoration
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || filteredIds.length === 0 || initialAt <= 0) return;
    restoredRef.current = true;
    gridRef.current?.scrollToItem(initialAt);
  }, [filteredIds.length, initialAt]);

  const handleSortChange = useCallback((newSort: SortOrder) => {
    setSort(newSort);
    setViewingPage(1);
    window.scrollTo({ top: 0 });
  }, [setViewingPage]);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('search.title')}: {isSingleTerm ? formatSearchHeader(query) : query}</h1>
          <p className="text-sm text-zinc-500">
            {allIds
              ? `${totalCount.toLocaleString()} ${t('search.results')}`
              : isLoadingIds ? t('search.searching') : t('search.noResults')}
          </p>
        </div>
        <div className="shrink-0">
          {isSingleTerm ? (
            <SortSelector value={sort} onChange={handleSortChange} />
          ) : query.trim().includes(' ') ? (
            <p className="text-xs text-zinc-400" title={t('search.sortUnavailable')}>{t('search.sortUnavailable')}</p>
          ) : null}
        </div>
      </div>

      {isFallback && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {t('search.langFallback')}
        </p>
      )}

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

      {(filteredIds.length > 0 || isLoadingIds) && (
        <>
          {numericId !== null && filteredIds.length > 0 && (
            <h2 className="mb-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
              {t('search.otherResults')}
            </h2>
          )}
          <VirtualGalleryGrid
            ref={gridRef}
            totalLength={filteredIds.length}
            totalPages={totalPages}
            viewingPage={viewingPage}
            getItemId={getItemId}
            requestPage={requestPage}
            onWindowSlide={() => floatingNavRef.current?.suppress()}
          />
        </>
      )}

      <FloatingPageNav
        ref={floatingNavRef}
        totalItems={filteredIds.length}
        loadedItems={filteredIds.length}
        pageSize={PAGE_SIZE}
        hasMore={false}
        viewingPage={viewingPage}
        onViewingPageChange={setViewingPage}
        onJumpToPage={handleJumpToPage}
      />
    </div>
  );
}
