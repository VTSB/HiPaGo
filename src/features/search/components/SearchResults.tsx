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

function combineDefaultFilter(query: string, defaultFilterQuery: string): string {
  return [query.trim(), defaultFilterQuery.trim()].filter(Boolean).join(' ');
}

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
  const defaultFilterQuery = useSettingsStore((s) => s.defaultFilterQuery);
  const t = useT();

  const [sort, setSort] = useState<SortOrder>(() => {
    const s = searchParams.get('sort');
    return s && VALID_SORTS.includes(s as SortOrder) ? (s as SortOrder) : 'date_added';
  });

  const [viewingPage, setViewingPage] = useState(1);

  const gridRef = useRef<VirtualGalleryGridHandle>(null);
  const floatingNavRef = useRef<FloatingPageNavHandle>(null);

  const executedQuery = combineDefaultFilter(query, defaultFilterQuery);
  const isSingleTerm = parseCompoundQuery(executedQuery).length === 1;
  const numericId = /^\d+$/.test(query) ? Number(query) : null;

  // gcTime keeps result ids cached across detail visits so a back navigation
  // renders the grid at full height synchronously — native scroll restoration
  // needs the document height to be correct before it lands (REQ__list-scroll-restoration).
  const SEARCH_IDS_GC_TIME = 30 * 60_000;

  const idsQuery = useQuery({
    queryKey: ['search-ids', query, defaultFilterQuery, language, sort],
    queryFn: () => getGalleryIdsForQuery(executedQuery, language, isSingleTerm ? sort : undefined),
    enabled: query.length > 0,
    gcTime: SEARCH_IDS_GC_TIME,
  });

  const langQueryDone = !idsQuery.isLoading && language !== 'all' && query.length > 0;
  const langQueryEmpty = langQueryDone && (idsQuery.isError || (idsQuery.data !== undefined && idsQuery.data.length === 0));
  const fallbackQuery = useQuery({
    queryKey: ['search-ids', query, defaultFilterQuery, 'all', sort],
    queryFn: () => getGalleryIdsForQuery(executedQuery, 'all', isSingleTerm ? sort : undefined),
    enabled: langQueryEmpty,
    gcTime: SEARCH_IDS_GC_TIME,
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

  const requestPage = useCallback(() => {}, []);

  const totalPages = filteredIds.length > 0 ? Math.ceil(filteredIds.length / PAGE_SIZE) : 0;

  const handleJumpToPage = useCallback((page: number) => {
    setViewingPage(page);
    gridRef.current?.scrollToPage(page);
  }, [setViewingPage]);

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
  }, [replaceUrlState, setViewingPage]);

  // No query yet (dedicated /search entry before typing): render nothing so the
  // search input + its recent/popular dropdown own the screen. Avoids a stray
  // "Search: / No results" header on the empty search page.
  if (!query.trim()) return null;

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('search.title')}: {isSingleTerm ? formatSearchHeader(query) : query}</h1>
          <p className="text-sm text-zinc-500">
            {allIds
              ? `${totalCount.toLocaleString()} ${t('search.results')}`
              : isLoadingIds ? t('search.searching') : t('search.noResults')}
          </p>
        </div>
        {isSingleTerm ? (
          <div className="shrink-0">
            <SortSelector value={sort} onChange={handleSortChange} />
          </div>
        ) : query.trim().includes(' ') ? (
          <p
            className="min-w-0 shrink break-words text-right text-xs text-zinc-400"
            title={t('search.sortUnavailable')}
          >
            {t('search.sortUnavailable')}
          </p>
        ) : null}
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
