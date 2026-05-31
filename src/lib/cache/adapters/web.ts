/**
 * Web ImageCacheBackend — intentionally a no-op (miss-only).
 *
 * The file-backed cache serves images through a native file URL
 * (`convertFileSrc`) streamed by the WebView, which the browser has no equivalent
 * of; and a `fetch()` of the hitomi CDN is CORS-blocked, so the browser can never
 * read the bytes to populate a cache either. On web, image display already works
 * via the plain `<img src>` plus the browser's own HTTP cache, so the persistent
 * cache simply reports empty. The Settings card then shows 0 usage, which is
 * accurate for this platform.
 */
import type { ImageCacheBackend } from '../image-cache-store';

export async function createWebImageCacheBackend(): Promise<ImageCacheBackend> {
  return {
    async statSize() {
      return null;
    },
    async download() {
      throw new Error('image cache is not supported on web');
    },
    async fileUrl() {
      throw new Error('image cache is not supported on web');
    },
    async filePath() {
      throw new Error('image cache is not supported on web');
    },
    async remove() {
      // no-op
    },
    async loadIndex() {
      return [];
    },
    async saveIndex() {
      // no-op
    },
    async clearAll() {
      // no-op
    },
  };
}
