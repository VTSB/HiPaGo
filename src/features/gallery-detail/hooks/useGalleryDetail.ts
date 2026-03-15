'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchGalleryInfo, filesToGalleryImages } from '@/lib/api/gallery';
import { galleryInfoToBlock, galleryInfoToImages } from '@/lib/api/parser';
import { getGalleryBlock, saveGalleryBlock, getGalleryImages, saveGalleryImages } from '@/lib/db/gallery';
import { GalleryBlockType } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile, GalleryImages } from '@/lib/utils/types';

const STALE_DAYS_DETAILED = 3;

export async function resolveGalleryDetail(id: number): Promise<{
  block: GalleryBlock;
  images: GalleryImages;
  files: GalleryFile[];
}> {
  // Try DB cache first - only use if DETAILED
  try {
    const cachedBlock = await getGalleryBlock(id);
    const cachedFiles = await getGalleryImages(id);
    if (cachedBlock?.type === GalleryBlockType.DETAILED && cachedFiles) {
      // SWR: return cached immediately, revalidate in background if stale
      if (isDetailStale(cachedBlock)) {
        revalidateDetail(id);
      }
      return {
        block: cachedBlock,
        images: filesToGalleryImages(id, cachedFiles),
        files: cachedFiles,
      };
    }
  } catch {
    // DB not initialized - fall through to API
  }

  // Fetch from API
  const info = await fetchGalleryInfo(id);
  const block = galleryInfoToBlock(info);
  const images = galleryInfoToImages(info);

  // Save to DB (fire-and-forget, only for valid blocks)
  if (block.type === GalleryBlockType.DETAILED) {
    saveGalleryBlock(block).catch(e => console.warn('[detail] block save failed:', e));
    saveGalleryImages(id, info.files).catch(e => console.warn('[detail] images save failed:', e));
  }

  return { block, images, files: info.files };
}

function isDetailStale(block: GalleryBlock): boolean {
  if (!block.updatedAt) return false;
  const threshold = Date.now() - STALE_DAYS_DETAILED * 24 * 60 * 60 * 1000;
  return block.updatedAt.getTime() < threshold;
}

function revalidateDetail(id: number): void {
  fetchGalleryInfo(id)
    .then((info) => {
      const block = galleryInfoToBlock(info);
      if (block.type === GalleryBlockType.DETAILED) {
        saveGalleryBlock(block).catch(() => {});
        saveGalleryImages(id, info.files).catch(() => {});
      }
    })
    .catch((e) => console.warn('[detail] Revalidation failed:', e));
}

export function useGalleryDetail(id: number) {
  const query = useQuery({
    queryKey: ['gallery-detail', id],
    queryFn: () => resolveGalleryDetail(id),
    enabled: id > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return {
    block: query.data?.block ?? null,
    images: query.data?.images ?? null,
    files: query.data?.files ?? [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
