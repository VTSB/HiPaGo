/**
 * App-wide singleton accessor for the image cache. Builds the store with the
 * user's configured cap and keeps it in sync when the setting changes (a smaller
 * cap evicts down to it). Consumed by the Settings card (stage 2) and the reader
 * / download paths (stages 3-4).
 */
import { useSettingsStore } from '@/lib/store/settings';
import { createImageCacheStore, type ImageCacheStore } from './image-cache-store';

let storePromise: Promise<ImageCacheStore> | null = null;

export function getImageCache(): Promise<ImageCacheStore> {
  if (!storePromise) {
    let prev = useSettingsStore.getState().imageCacheMaxBytes;
    storePromise = createImageCacheStore(prev);
    // Re-apply the cap whenever the setting changes (evicts on shrink).
    useSettingsStore.subscribe((state) => {
      const next = state.imageCacheMaxBytes;
      if (next !== prev) {
        prev = next;
        storePromise?.then((store) => store.setMaxBytes(next)).catch(() => {});
      }
    });
  }
  return storePromise;
}

/** Test-only: drop the cached singleton so the next getImageCache rebuilds it. */
export function __resetImageCacheSingletonForTests(): void {
  storePromise = null;
}

export { mbToBytes, bytesToMb, formatBytes } from './cache-size';
