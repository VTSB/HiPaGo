/**
 * Pure work-order resolution for a gallery download.
 *
 * Extracts the per-page URL + ext derivation that download-zip and the native
 * workers (later task) both need: for each page, the 'auto' (avif > webp >
 * original) image URL and the extension that URL actually points at.
 *
 * This is intentionally side-effect-free so it can be unit-tested directly and
 * persisted for a native worker without re-deriving anything.
 */
import { getImageUrl } from './image-url';
import type { GalleryFile, GgConfig } from './types';

export interface WorkOrderItem {
  index: number;
  url: string;
  ext: string;
}

/**
 * Resolve the ordered list of {index, url, ext} for a gallery's pages.
 *
 * Mirrors the logic previously inline in downloadGalleryToLibrary:
 *   - url  = getImageUrl(file, ggConfig, 'auto')   // avif > webp > original
 *   - ext  = url.split('?')[0].split('.').pop() || 'webp'
 *
 * The ext here is the URL-derived ext (used for the cache-copy filename + its
 * manifest entry). The network path may still refine it from content-type, but
 * for the cache-copy path this is the authoritative ext.
 */
export function resolveWorkOrder(files: GalleryFile[], ggConfig: GgConfig): WorkOrderItem[] {
  return files.map((file, index) => {
    const url = getImageUrl(file, ggConfig, 'auto');
    const ext = url.split('?')[0].split('.').pop() || 'webp';
    return { index, url, ext };
  });
}
