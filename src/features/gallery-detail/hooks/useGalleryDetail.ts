'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchGalleryInfo, filesToGalleryImages } from '@/lib/api/gallery';
import { galleryInfoToBlock, galleryInfoToImages } from '@/lib/api/parser';
import { getGalleryBlock, saveGalleryBlock, getGalleryImages, saveGalleryImages } from '@/lib/db/gallery';
import { getDownload, deserializeTags } from '@/lib/db/download';
import { getDownloadedGalleryPages, hasCompleteDownloadedGallery } from '@/lib/utils/download-zip';
import { GalleryBlockType } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile, GalleryImages, TagType } from '@/lib/utils/types';

/**
 * Last-resort offline fallback for a DOWNLOADED gallery: when the network
 * gallery-info fetch fails (offline / hitomi down) AND the gallery-cache tables
 * are also empty, build a minimal detail from the `download` row + the on-disk
 * page manifest so the detail page renders (title, tags, page count, working
 * Read button) instead of spinning forever. Returns null when there is no
 * download row or no pages on disk (nothing to show), so the caller re-throws
 * the original network error.
 *
 * Thumbnails need hitomi hashes we don't have offline, so the synthesized files
 * carry empty name/hash — the per-page thumbnail grid is blank offline, but the
 * reader serves the real images from disk (useOfflineImages). Marked
 * NOT_DETAILED so the detail page hides the network-only mediaType/language line.
 */
async function offlineDownloadFallback(
  id: number,
): Promise<{ block: GalleryBlock; images: GalleryImages; files: GalleryFile[] } | null> {
  let row: Awaited<ReturnType<typeof getDownload>>;
  try {
    row = await getDownload(id);
  } catch {
    return null;
  }
  if (!row) return null;
  if (row.status !== 'complete') return null;
  const lookup = { folderName: row.folderName ?? null };

  let completeOnDisk = false;
  try {
    completeOnDisk = await hasCompleteDownloadedGallery(id, row.pageCount, lookup);
  } catch {
    completeOnDisk = false;
  }
  if (!completeOnDisk) return null;

  let pages: { index: number; ext: string }[] = [];
  try {
    pages = await getDownloadedGalleryPages(id, lookup);
  } catch {
    pages = [];
  }
  if (pages.length === 0) return null;
  if (row.pageCount > 0 && pages.length < row.pageCount) return null;

  const files: GalleryFile[] = pages
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((p) => ({
      width: 0,
      height: 0,
      haswebp: p.ext === 'webp' ? 1 : 0,
      hasavif: p.ext === 'avif' ? 1 : 0,
      hasavifsmalltn: 0,
      name: '',
      hash: '',
    }));

  const block: GalleryBlock = {
    id,
    type: GalleryBlockType.NOT_DETAILED,
    title: row.title,
    date: new Date(row.downloadedAt),
    tags: deserializeTags(row.tags) as Partial<Record<TagType, string[]>>,
    thumbnail: row.thumbnail,
    related: [],
  };

  return { block, images: filesToGalleryImages(id, files), files };
}

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
  let info;
  try {
    info = await fetchGalleryInfo(id);
  } catch (e) {
    // Network/parse failed (e.g. offline). For a downloaded gallery whose
    // gallery-cache is also gone, fall back to the download row + on-disk
    // manifest so the detail still renders instead of spinning/erroring forever.
    const fallback = await offlineDownloadFallback(id);
    if (fallback) return fallback;
    throw e;
  }
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
    // Don't retry on 404 (deleted gallery) — only retry on transient errors
    retry: (failureCount, error) => {
      if (error && 'status' in error && (error as { status: number }).status === 404) return false;
      return failureCount < 2;
    },
  });

  return {
    block: query.data?.block ?? null,
    images: query.data?.images ?? null,
    files: query.data?.files ?? [],
    isLoading: query.isLoading,
    error: query.error,
    retry: query.refetch,
  };
}
