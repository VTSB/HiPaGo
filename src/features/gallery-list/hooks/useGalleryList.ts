'use client';

import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchBrowseIds } from '@/lib/api/gallery';
import { useSettingsStore } from '@/lib/store/settings';
import { PAGE_SIZE } from '@/lib/utils/constants';
import type { SortOrder } from '@/lib/utils/types';

const PREFETCH_AHEAD = 3;

interface IdPage {
  ids: number[];
  hasMore: boolean;
  totalLength: number;
}

async function fetchIdPage(language: string, pageParam: number, sort?: SortOrder): Promise<IdPage> {
  const { idList, length } = await fetchBrowseIds(language, pageParam, PAGE_SIZE, sort);
  const hasMore = (pageParam + 1) * PAGE_SIZE < length;
  return { ids: idList, hasMore, totalLength: length };
}

/**
 * Manages gallery ID pagination with infinite scroll.
 * startPage sets the initial fetch target for fast page jumps.
 * Bidirectional scroll (fetchPreviousPage) enables scrolling above the jump target.
 */
export function useGalleryList(startPage = 0, viewingPage = 1, sort: SortOrder = 'date_added') {
  const language = useSettingsStore((s) => s.language);

  const query = useInfiniteQuery({
    queryKey: ['gallery-ids', language, sort, startPage],
    queryFn: ({ pageParam }) => fetchIdPage(language, pageParam as number, sort),
    initialPageParam: startPage,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasMore ? (lastPageParam as number) + 1 : undefined,
    getPreviousPageParam: (_firstPage, _allPages, firstPageParam) =>
      (firstPageParam as number) > 0 ? (firstPageParam as number) - 1 : undefined,
    staleTime: 60_000,
  });

  const { data, isFetchingNextPage, hasNextPage, fetchNextPage } = query;

  // Prefetch ahead of current viewing page
  useEffect(() => {
    if (!data || isFetchingNextPage || !hasNextPage) return;
    const loadedPages = data.pages.length;
    if (loadedPages < 1) return;
    if (loadedPages < viewingPage - startPage + PREFETCH_AHEAD) {
      fetchNextPage();
    }
  }, [data, isFetchingNextPage, hasNextPage, fetchNextPage, viewingPage, startPage]);

  const ids = query.data?.pages.flatMap((p) => p.ids) ?? [];
  const totalLength = query.data?.pages[0]?.totalLength ?? 0;
  const loadedPages = query.data?.pages.length ?? 0;
  const totalPages = totalLength > 0 ? Math.ceil(totalLength / PAGE_SIZE) : 0;
  const isJumping = query.isFetching && ids.length === 0;
  const earliestLoadedPage = (query.data?.pageParams[0] as number) ?? startPage;

  return {
    ids,
    loading: query.isLoading,
    isJumping,
    error: query.error?.message ?? null,
    hasMore: query.hasNextPage ?? false,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
    isFetchingMore: query.isFetchingNextPage,
    hasPrevious: query.hasPreviousPage ?? false,
    loadPrevious: () => {
      if (query.hasPreviousPage && !query.isFetchingPreviousPage) query.fetchPreviousPage();
    },
    isFetchingPrevious: query.isFetchingPreviousPage,
    earliestLoadedPage,
    loadedPages,
    totalPages,
    totalLength,
  };
}
