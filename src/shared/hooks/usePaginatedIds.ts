'use client';

import { useInfiniteQuery } from '@tanstack/react-query';

interface UsePaginatedIdsResult {
  visibleIds: number[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

export function usePaginatedIds(
  ids: number[] | undefined,
  pageSize: number,
  queryKey: readonly unknown[],
): UsePaginatedIdsResult {
  const query = useInfiniteQuery({
    queryKey: [...queryKey, ids ? `${ids[0]}-${ids[ids.length - 1]}-${ids.length}` : undefined],
    queryFn: ({ pageParam }): number[] => {
      if (!ids) return [];
      const start = (pageParam as number) * pageSize;
      return ids.slice(start, start + pageSize);
    },
    initialPageParam: 0,
    getNextPageParam: (_lastPage, allPages) => {
      if (!ids) return undefined;
      const loaded = allPages.length * pageSize;
      return loaded < ids.length ? allPages.length : undefined;
    },
    enabled: (ids?.length ?? 0) > 0,
  });

  return {
    visibleIds: query.data?.pages.flat() ?? [],
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
  };
}
