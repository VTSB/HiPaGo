'use client';

import { useEffect, useRef } from 'react';
import { Spinner } from './Spinner';

interface InfiniteScrollTriggerProps {
  hasMore: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
  /** How far before the end (in px) to trigger loading. Default 800. */
  rootMargin?: string;
}

export function InfiniteScrollTrigger({
  hasMore,
  isFetching,
  onLoadMore,
  rootMargin = '0px 0px 800px 0px',
}: InfiniteScrollTriggerProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !isFetching) {
          onLoadMore();
        }
      },
      { rootMargin },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isFetching, onLoadMore, rootMargin]);

  if (!hasMore) return null;

  return (
    <div ref={sentinelRef} className="flex justify-center py-8">
      {isFetching && <Spinner size="sm" className="h-6 w-6" />}
    </div>
  );
}
