'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchGalleryBlockHtmlById, createLoadingBlock } from '@/lib/api/gallery';
import { getGalleryBlock, saveGalleryBlock } from '@/lib/db/gallery';
import type { GalleryBlock } from '@/lib/utils/types';

async function resolveBlock(id: number): Promise<GalleryBlock> {
  // Try local DB first — silently skip if DB not initialized
  try {
    const local = await getGalleryBlock(id);
    if (local) return local;
  } catch {
    // DB not available — fall through to remote
  }
  const block = await fetchGalleryBlockHtmlById(id);
  saveGalleryBlock(block).catch(() => {});
  return block;
}

/**
 * Individually fetches and caches a single gallery block.
 * Returns a LOADING placeholder immediately, swapped with real data once resolved.
 */
export function useGalleryBlock(id: number): GalleryBlock {
  const { data } = useQuery({
    queryKey: ['gallery-block', id],
    queryFn: () => resolveBlock(id),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return data ?? createLoadingBlock(id);
}
