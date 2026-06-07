'use client';

import { useState, useCallback } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { fetchBrowseIds } from '@/lib/api/gallery';
import { getGalleryIdsForQuery } from '@/lib/api/search';
import { useSettingsStore } from '@/lib/store/settings';
import { PAGE_SIZE } from '@/lib/utils/constants';
import type { SortOrder } from '@/lib/utils/types';

const MAX_ACTIVE_PAGES = 50;
const PREFETCH_AHEAD_PAGES = 3;
const TOTAL_LENGTH_CACHE_PREFIX = 'hipago:listTotalLength';

function expandPageWindow(pageIndex: number): number[] {
  return Array.from(
    { length: PREFETCH_AHEAD_PAGES + 1 },
    (_, offset) => pageIndex + offset,
  );
}

function capActivePages(pages: Set<number>): Set<number> {
  if (pages.size <= MAX_ACTIVE_PAGES) return pages;
  const arr = Array.from(pages);
  return new Set(arr.slice(-MAX_ACTIVE_PAGES));
}

function totalLengthCacheKey(language: string, sort: SortOrder, defaultFilterQuery: string): string {
  return `${TOTAL_LENGTH_CACHE_PREFIX}:${language}:${sort}:${defaultFilterQuery}`;
}

function readCachedTotalLength(language: string, sort: SortOrder, defaultFilterQuery: string): number {
  if (typeof sessionStorage === 'undefined') return 0;
  try {
    const raw = sessionStorage.getItem(totalLengthCacheKey(language, sort, defaultFilterQuery));
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeCachedTotalLength(
  language: string,
  sort: SortOrder,
  defaultFilterQuery: string,
  value: number,
): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(totalLengthCacheKey(language, sort, defaultFilterQuery), String(value));
  } catch {
    // sessionStorage unavailable; degrade silently.
  }
}

async function fetchIdPage(language: string, pageIndex: number, sort: SortOrder) {
  const { idList, length } = await fetchBrowseIds(language, pageIndex, PAGE_SIZE, sort);
  return { ids: idList as number[], totalLength: length as number };
}

/**
 * On-demand gallery ID fetching for virtual scroll.
 * Pages are fetched in parallel as they scroll into view.
 * requestPage(n) is idempotent — safe to call on every render.
 */
export function useVirtualGallery(sort: SortOrder = 'date_added') {
  const language = useSettingsStore((s) => s.language);
  const defaultFilterQuery = useSettingsStore((s) => s.defaultFilterQuery).trim();

  // Set of page indices we've requested — only grows until capped.
  // Seed a few pages ahead so Android WebView has IDs ready even if scroll
  // virtualizer updates arrive late or only cover the first mobile rows.
  const [neededPages, setNeededPages] = useState<ReadonlySet<number>>(
    () => new Set(expandPageWindow(0)),
  );

  // Ratchet: once we've seen a totalLength, never report lower than that.
  // Prevents the virtualizer height from collapsing to 0 when pages are evicted
  // from neededPages during rapid scrolling (all evicted queries return data=undefined).
  // Seeded from sessionStorage so the container height is correct on cold mount
  // — that's what lets native scroll restoration land at the right scrollTop
  // before the first page query resolves.
  const [maxTotalLength, setMaxTotalLength] = useState(() =>
    readCachedTotalLength(language, sort, defaultFilterQuery),
  );

  // Reset on sort/language change — track previous values to detect changes.
  // Using render-phase setState (calling setState during render) is the React-documented
  // pattern for derived state resets; it does not trigger set-state-in-effect.
  const [prevSort, setPrevSort] = useState(sort);
  const [prevLanguage, setPrevLanguage] = useState(language);
  const [prevDefaultFilterQuery, setPrevDefaultFilterQuery] = useState(defaultFilterQuery);
  if (
    sort !== prevSort ||
    language !== prevLanguage ||
    defaultFilterQuery !== prevDefaultFilterQuery
  ) {
    setPrevSort(sort);
    setPrevLanguage(language);
    setPrevDefaultFilterQuery(defaultFilterQuery);
    setNeededPages(new Set(expandPageWindow(0)));
    // Seed from the new key's cache so the container height for the
    // newly-selected filter is correct synchronously.
    setMaxTotalLength(readCachedTotalLength(language, sort, defaultFilterQuery));
  }

  const neededPagesArray = Array.from(neededPages);
  const hasDefaultFilter = defaultFilterQuery.length > 0;

  const filteredIdsQuery = useQuery({
    queryKey: ['gallery-default-filter', language, sort, defaultFilterQuery],
    queryFn: () => getGalleryIdsForQuery(defaultFilterQuery, language, sort),
    enabled: hasDefaultFilter,
    staleTime: 60_000,
  });

  // useQueries fetches all needed pages in parallel
  const pageQueries = useQueries({
    queries: hasDefaultFilter ? [] : neededPagesArray.map((pageIndex) => ({
      queryKey: ['gallery-page', language, sort, pageIndex],
      queryFn: () => fetchIdPage(language, pageIndex, sort),
      staleTime: 60_000,
    })),
  });

  // Build page map from results (order matches neededPagesArray insertion order)
  const pageMap = new Map<number, number[]>();
  let totalLength = hasDefaultFilter ? (filteredIdsQuery.data?.length ?? 0) : 0;
  for (let i = 0; i < pageQueries.length; i++) {
    const data = pageQueries[i].data;
    if (data) {
      pageMap.set(neededPagesArray[i], data.ids);
      if (data.totalLength > totalLength) totalLength = data.totalLength;
    }
  }

  // Apply ratchet via render-phase setState: React re-renders immediately when
  // setState is called during render, so the returned safeTotalLength is always
  // correct without reading/writing a ref during render (react-hooks/refs).
  if (totalLength > maxTotalLength) {
    setMaxTotalLength(totalLength);
    writeCachedTotalLength(language, sort, defaultFilterQuery, totalLength);
  }
  const safeTotalLength = maxTotalLength > 0 ? maxTotalLength : totalLength;

  const requestPage = useCallback((pageIndex: number) => {
    setNeededPages((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const page of expandPageWindow(pageIndex)) {
        if (next.has(page)) continue;
        next.add(page);
        changed = true;
      }
      if (!changed) return prev;
      return capActivePages(next);
    });
  }, []);

  const getItemId = (itemIndex: number): number | null => {
    if (hasDefaultFilter) {
      return filteredIdsQuery.data?.[itemIndex] ?? null;
    }
    const pageIndex = Math.floor(itemIndex / PAGE_SIZE);
    const localIndex = itemIndex % PAGE_SIZE;
    return pageMap.get(pageIndex)?.[localIndex] ?? null;
  };

  const isInitialLoading = hasDefaultFilter
    ? filteredIdsQuery.isLoading
    : safeTotalLength === 0 && (pageQueries[0]?.isLoading ?? true);
  const error = hasDefaultFilter
    ? filteredIdsQuery.error?.message ?? null
    : pageQueries[0]?.error?.message ?? null;

  return { totalLength: safeTotalLength, requestPage, getItemId, isInitialLoading, error };
}
