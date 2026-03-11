'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchGalleryBlockHtmlById, createLoadingBlock } from '@/lib/api/gallery';
import { getGalleryBlock, saveGalleryBlock } from '@/lib/db/gallery';
import type { GalleryBlock } from '@/lib/utils/types';

export const galleryBlockQueryKey = (id: number) => ['gallery-block', id] as const;

export async function resolveBlock(id: number, signal?: AbortSignal): Promise<GalleryBlock> {
  // Try local DB first — silently skip if DB not initialized
  try {
    const local = await getGalleryBlock(id);
    if (local) return local;
  } catch {
    // Recoverable: WASM DB not initialized or query failed — fall through to remote fetch
  }
  const block = await fetchGalleryBlockHtmlById(id, signal);
  saveGalleryBlock(block).catch((e) => console.warn('[gallery-block] DB save failed:', e));
  return block;
}

/**
 * Individually fetches and caches a single gallery block.
 * Returns a LOADING placeholder immediately, swapped with real data once resolved.
 */
export function useGalleryBlock(id: number): GalleryBlock {
  const { data } = useQuery({
    queryKey: galleryBlockQueryKey(id),
    queryFn: ({ signal }) => resolveBlock(id, signal),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return data ?? createLoadingBlock(id);
}
