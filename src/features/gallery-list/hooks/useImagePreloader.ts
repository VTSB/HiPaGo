'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { GalleryBlockType } from '@/lib/utils/types';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import { preloadImageSource } from '@/shared/components/AbortableImage';
import { galleryBlockQueryKey, resolveBlock } from './useGalleryBlock';

interface Options {
  getItemId: (index: number) => number | null;
  viewingPage: number;
  visibleStartItem: number;
  visibleEndItem: number;
  totalLength: number;
  requestPage: (pageIndex: number) => void;
}

/** One logical page on either side, independent of mounted overscan rows. */
export function useImagePreloader({
  getItemId, viewingPage, visibleStartItem, visibleEndItem, totalLength, requestPage,
}: Options) {
  const queryClient = useQueryClient();
  const pageCount = Math.ceil(totalLength / PAGE_SIZE);
  const current = Math.max(0, Math.min(viewingPage - 1, pageCount - 1));
  const first = Math.max(0, current - 1);
  const last = Math.min(pageCount - 1, current + 1);
  const viewport = useRef({ start: visibleStartItem, end: visibleEndItem });
  useEffect(() => {
    viewport.current = { start: visibleStartItem, end: visibleEndItem };
  }, [visibleStartItem, visibleEndItem]);

  useEffect(() => {
    if (!pageCount) return;
    requestPage(current);
    if (current < last) requestPage(current + 1);
    if (current > first) requestPage(current - 1);
  }, [current, first, last, pageCount, requestPage]);

  // Callbacks/query results can change identity on every render. Only changed
  // page/ID contents should replace the warming generation.
  const entries: Array<[number, number]> = [];
  for (let index = first * PAGE_SIZE; index < Math.min(totalLength, (last + 1) * PAGE_SIZE); index++) {
    const id = getItemId(index);
    if (id !== null) entries.push([index, id]);
  }
  const population = JSON.stringify(entries);

  useEffect(() => {
    const pending = JSON.parse(population) as Array<[number, number]>;
    if (!pending.length) return;
    const controller = new AbortController();
    const metadata = new Set<number>();
    const seen = new Set<number>();
    const distance = (index: number) => Math.max(viewport.current.start - index, index - viewport.current.end, 0);
    let active = 0;

    const pump = () => {
      // Retain each warm task until its image settles, not merely its metadata.
      while (!controller.signal.aborted && active < 2 && pending.length) {
        pending.sort((a, b) => distance(a[0]) - distance(b[0]) || b[0] - a[0]);
        const [index, id] = pending.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        active++;
        metadata.add(id);
        void queryClient.fetchQuery({
          queryKey: galleryBlockQueryKey(id),
          queryFn: ({ signal }) => resolveBlock(id, signal, undefined, 2),
          staleTime: 5 * 60 * 1000,
          gcTime: 30 * 60 * 1000,
        }).then(async (block) => {
          metadata.delete(id);
          if (controller.signal.aborted || !block.thumbnail ||
              block.type === GalleryBlockType.LOADING || block.type === GalleryBlockType.FAILED) return;
          await preloadImageSource(resolveThumbnailUrl(block.thumbnail), controller.signal, () => distance(index));
        }).catch(() => {
          // Warming is best effort. A mounted card owns its visible error state.
        }).finally(() => {
          metadata.delete(id);
          active--;
          pump();
        });
      }
    };
    // Let mounted cards subscribe to demand queries before warming starts.
    const timer = setTimeout(pump, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
      for (const id of metadata) {
        const queryKey = galleryBlockQueryKey(id);
        const query = queryClient.getQueryCache().find({ queryKey, exact: true });
        // A now-visible card may have joined this metadata request.
        if (query && !query.isActive()) {
          void queryClient.cancelQueries({ queryKey, exact: true });
        }
      }
    };
  }, [population, current, queryClient]);
}
