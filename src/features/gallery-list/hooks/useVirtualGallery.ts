'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchBrowseIds } from '@/lib/api/gallery';
import { useSettingsStore } from '@/lib/store/settings';
import { PAGE_SIZE } from '@/lib/utils/constants';
import type { SortOrder } from '@/lib/utils/types';

const MAX_ACTIVE_PAGES = 50;

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

  // Set of page indices we've requested — only grows, never shrinks (cache stays valid)
  const [neededPages, setNeededPages] = useState<ReadonlySet<number>>(() => new Set([0]));

  // Ratchet: once we've seen a totalLength, never report lower than that.
  // Prevents the virtualizer height from collapsing to 0 when pages are evicted
  // from neededPages during rapid scrolling (all evicted queries return data=undefined).
  const maxTotalLengthRef = useRef(0);

  // Reset on sort/language change
  useEffect(() => {
    setNeededPages(new Set([0]));
    maxTotalLengthRef.current = 0;
  }, [sort, language]);

  const neededPagesArray = Array.from(neededPages);

  // useQueries fetches all needed pages in parallel
  const pageQueries = useQueries({
    queries: neededPagesArray.map((pageIndex) => ({
      queryKey: ['gallery-page', language, sort, pageIndex],
      queryFn: () => fetchIdPage(language, pageIndex, sort),
      staleTime: 60_000,
    })),
  });

  // Build page map from results (order matches neededPagesArray insertion order)
  const pageMap = new Map<number, number[]>();
  let totalLength = 0;
  for (let i = 0; i < pageQueries.length; i++) {
    const data = pageQueries[i].data;
    if (data) {
      pageMap.set(neededPagesArray[i], data.ids);
      if (data.totalLength > totalLength) totalLength = data.totalLength;
    }
  }

  // Apply ratchet: once totalLength is known, never let it go back to 0
  if (totalLength > maxTotalLengthRef.current) maxTotalLengthRef.current = totalLength;
  const safeTotalLength = maxTotalLengthRef.current;

  const requestPage = useCallback((pageIndex: number) => {
    setNeededPages((prev) => {
      if (prev.has(pageIndex)) return prev;
      const next = new Set(prev);
      next.add(pageIndex);
      if (next.size > MAX_ACTIVE_PAGES) {
        const arr = Array.from(next);
        return new Set(arr.slice(-MAX_ACTIVE_PAGES));
      }
      return next;
    });
  }, []);

  const getItemId = (itemIndex: number): number | null => {
    const pageIndex = Math.floor(itemIndex / PAGE_SIZE);
    const localIndex = itemIndex % PAGE_SIZE;
    return pageMap.get(pageIndex)?.[localIndex] ?? null;
  };

  const isInitialLoading = safeTotalLength === 0 && (pageQueries[0]?.isLoading ?? true);
  const error = pageQueries[0]?.error?.message ?? null;

  return { totalLength: safeTotalLength, requestPage, getItemId, isInitialLoading, error };
}
