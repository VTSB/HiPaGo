'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { galleryBlockQueryKey, resolveBlock } from './useGalleryBlock';
import { PAGE_SIZE } from '@/lib/utils/constants';
import { resolveThumbnailUrl } from '@/lib/api/url-resolver';
import { GalleryBlockType } from '@/lib/utils/types';
import type { GalleryBlock } from '@/lib/utils/types';
import type { VirtualItem } from '@tanstack/react-virtual';

interface UseImagePreloaderOptions {
  getItemId: (itemIndex: number) => number | null;
  virtualItems: VirtualItem[];
  windowStartItem: number;
  actualCols: number;
  totalLength: number;
  requestPage: (pageIndex: number) => void;
  preloadRows?: number;
}

export function useImagePreloader({
  getItemId,
  virtualItems,
  windowStartItem,
  actualCols,
  totalLength,
  requestPage,
  preloadRows = 5,
}: UseImagePreloaderOptions): void {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const idleCallbacksRef = useRef<number[]>([]);

  useEffect(() => {
    if (virtualItems.length === 0) return;

    clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      cancelAllIdleCallbacks(idleCallbacksRef.current);
      idleCallbacksRef.current = [];

      const visibleMinRow = virtualItems[0].index;
      const visibleMaxRow = virtualItems[virtualItems.length - 1].index;

      const totalRows = totalLength > 0 ? Math.ceil(totalLength / actualCols) : 0;
      const preloadMinRow = Math.max(0, visibleMinRow - preloadRows);
      const preloadMaxRow = Math.min(totalRows - 1, visibleMaxRow + preloadRows);

      const idsToPreload: number[] = [];

      const addRowIds = (rowIndex: number) => {
        for (let col = 0; col < actualCols; col++) {
          const itemIndex = windowStartItem + rowIndex * actualCols + col;
          if (itemIndex >= totalLength) break;
          const id = getItemId(itemIndex);
          if (id !== null) idsToPreload.push(id);
        }
      };

      for (let row = preloadMinRow; row < visibleMinRow; row++) {
        const itemIndex = windowStartItem + row * actualCols;
        requestPage(Math.floor(itemIndex / PAGE_SIZE));
        addRowIds(row);
      }
      for (let row = visibleMaxRow + 1; row <= preloadMaxRow; row++) {
        const itemIndex = windowStartItem + row * actualCols;
        requestPage(Math.floor(itemIndex / PAGE_SIZE));
        addRowIds(row);
      }

      if (idsToPreload.length === 0) return;

      let activeCount = 0;
      let nextIndex = 0;

      const scheduleNext = () => {
        while (activeCount < 6 && nextIndex < idsToPreload.length) {
          const id = idsToPreload[nextIndex++];
          activeCount++;

          const handle = scheduleIdle(() => {
            queryClient
              .prefetchQuery({
                queryKey: galleryBlockQueryKey(id),
                queryFn: ({ signal }) => resolveBlock(id, signal),
                staleTime: 5 * 60 * 1000,
                gcTime: 30 * 60 * 1000,
              })
              .then(() => {
                // After block data is cached, preload the thumbnail image
                const block = queryClient.getQueryData<GalleryBlock>(galleryBlockQueryKey(id));
                if (block && block.type !== GalleryBlockType.LOADING && block.type !== GalleryBlockType.FAILED && block.thumbnail) {
                  const img = new Image();
                  img.src = resolveThumbnailUrl(block.thumbnail);
                }
              })
              .finally(() => {
                activeCount--;
                scheduleNext();
              });
          });
          idleCallbacksRef.current.push(handle);
        }
      };

      scheduleNext();
    }, 300);

    return () => {
      clearTimeout(debounceRef.current);
    };
  }, [virtualItems, windowStartItem, actualCols, totalLength, preloadRows, getItemId, requestPage, queryClient]);

  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      cancelAllIdleCallbacks(idleCallbacksRef.current);
    };
  }, []);
}

function scheduleIdle(fn: () => void): number {
  if (typeof requestIdleCallback !== 'undefined') {
    return requestIdleCallback(fn);
  }
  return setTimeout(fn, 0) as unknown as number;
}

function cancelAllIdleCallbacks(handles: number[]): void {
  for (const handle of handles) {
    if (typeof cancelIdleCallback !== 'undefined') {
      cancelIdleCallback(handle);
    } else {
      clearTimeout(handle);
    }
  }
}
