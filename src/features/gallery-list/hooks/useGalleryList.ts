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
 * Individual block fetching is handled by useGalleryBlock per card.
 */
export function useGalleryList(viewingPage = 1, sort: SortOrder = 'date_added') {
  const language = useSettingsStore((s) => s.language);

  const query = useInfiniteQuery({
    queryKey: ['gallery-ids', language, sort],
    queryFn: ({ pageParam }) => fetchIdPage(language, pageParam as number, sort),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.hasMore ? (lastPageParam as number) + 1 : undefined,
  });

  // Prefetch ahead of current viewing page
  useEffect(() => {
    if (!query.data || query.isFetchingNextPage || !query.hasNextPage) return;
    const loadedPages = query.data.pages.length;
    const targetPages = viewingPage + PREFETCH_AHEAD;
    if (loadedPages < targetPages) {
      query.fetchNextPage();
    }
  }, [query.data?.pages.length, query.isFetchingNextPage, query.hasNextPage, viewingPage]);

  const ids = query.data?.pages.flatMap((p) => p.ids) ?? [];
  const totalLength = query.data?.pages[0]?.totalLength ?? 0;
  const loadedPages = query.data?.pages.length ?? 0;
  const totalPages = totalLength > 0 ? Math.ceil(totalLength / PAGE_SIZE) : 0;

  return {
    ids,
    loading: query.isLoading,
    error: query.error?.message ?? null,
    hasMore: query.hasNextPage ?? false,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
    isFetchingMore: query.isFetchingNextPage,
    loadedPages,
    totalPages,
    totalLength,
  };
}
