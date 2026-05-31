'use client';

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { fetchGalleryBlockHtmlById, createLoadingBlock, createFailedBlock } from '@/lib/api/gallery';
import { getGalleryBlock, saveGalleryBlock } from '@/lib/db/gallery';
import type { GalleryBlock } from '@/lib/utils/types';
import { GalleryBlockType } from '@/lib/utils/types';

export const galleryBlockQueryKey = (id: number) => ['gallery-block', id] as const;

export async function resolveBlock(id: number, signal?: AbortSignal, queryClient?: QueryClient): Promise<GalleryBlock> {
  // Try local DB first — silently skip if DB not initialized
  try {
    const local = await getGalleryBlock(id);
    if (local) {
      // SWR: return cached immediately, revalidate in background if stale
      if (isStale(local)) {
        revalidateBlock(id, queryClient);
      }
      return local;
    }
  } catch {
    // Recoverable: WASM DB not initialized or query failed — fall through to remote fetch
  }
  try {
    const block = await fetchGalleryBlockHtmlById(id, signal);
    if (block.type === GalleryBlockType.NOT_DETAILED || block.type === GalleryBlockType.DETAILED) {
      saveGalleryBlock(block).catch((e) => console.warn('[gallery-block] DB save failed:', e));
    }
    return block;
  } catch (e) {
    // Offline with no cached block (e.g. History of a gallery never fetched): show
    // a graceful FAILED placeholder instead of an endless LOADING skeleton. When
    // online, rethrow so React Query retries a transient failure as before.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return createFailedBlock(id);
    }
    throw e;
  }
}

function isStale(block: GalleryBlock): boolean {
  if (!block.updatedAt) return false;
  const days = block.type === GalleryBlockType.DETAILED ? 3 : 7;
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  return block.updatedAt.getTime() < threshold;
}

/** Background revalidation — updates DB and React Query cache */
function revalidateBlock(id: number, queryClient?: QueryClient): void {
  fetchGalleryBlockHtmlById(id)
    .then((block) => {
      if (block.type === GalleryBlockType.NOT_DETAILED || block.type === GalleryBlockType.DETAILED) {
        saveGalleryBlock(block).catch((e) => console.warn('[gallery-block] DB save failed:', e));
        // Update React Query cache so UI reflects the fresh data immediately
        if (queryClient) {
          queryClient.setQueryData(galleryBlockQueryKey(id), block);
        }
      }
    })
    .catch((e) => console.warn('[gallery-block] Revalidation failed:', e));
}

/**
 * Individually fetches and caches a single gallery block.
 * Returns a LOADING placeholder immediately, swapped with real data once resolved.
 */
export function useGalleryBlock(id: number): GalleryBlock {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: galleryBlockQueryKey(id),
    queryFn: ({ signal }) => resolveBlock(id, signal, queryClient),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return data ?? createLoadingBlock(id);
}
