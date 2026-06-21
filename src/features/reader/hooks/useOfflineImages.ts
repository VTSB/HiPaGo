'use client';

import { useEffect, useRef, useState } from 'react';
import { getDownload } from '@/lib/db/download';
import { createDownloadStore } from '@/lib/storage/download-store';
import { getDownloadedGalleryPages, getDownloadedImage } from '@/lib/utils/download-zip';

export interface OfflineImageDim {
  width: number;
  height: number;
}

export interface OfflineImageSource {
  index: number;
  ext: string;
  /**
   * Immediate URL when a caller already has one. Native/file URLs do not need
   * URL.revokeObjectURL.
   */
  url?: string;
  /**
   * Lazy page URL loader. May return a native/file URL or a blob URL. The
   * caller owns revoking returned blob URLs.
   */
  loadUrl?: () => Promise<string | null>;
}

export interface OfflineImagesResult {
  /**
   * Offline page sources, one per page. Null while loading or when the gallery
   * is not downloaded. Sources are cheap lazy loaders: native file URLs when
   * available, otherwise blob URLs for pages the reader mounts/displays.
   */
  sources: OfflineImageSource[] | null;
  /** Compatibility mirror for immediate URL-backed sources only. */
  urls: string[] | null;
  /**
   * Natural dimensions per page. The fast path does not pre-decode every image,
   * so this is normally null and the reader uses a stable manga-page fallback.
   */
  dims: OfflineImageDim[] | null;
  /** True when the DB row says "complete" but no pages were found in storage. */
  missing: boolean;
  /** True while the DB check + manifest load are in flight. */
  loading: boolean;
}

/**
 * For a completed download, load only its manifest and return cheap page
 * sources for the reader.
 *
 * This intentionally avoids reading every image into the JS heap before first
 * paint. Native/file URL platforms resolve those URLs lazily. SAF/content-backed
 * platforms get lazy blob loaders, so page mode reads only the mounted
 * virtualized window and scroll mode reads only images near the viewport.
 */
export function useOfflineImages(galleryId: number): OfflineImagesResult {
  const [result, setResult] = useState<OfflineImagesResult>({
    sources: null,
    urls: null,
    dims: null,
    missing: false,
    loading: true,
  });
  const runIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const runId = ++runIdRef.current;

    async function load() {
      setResult({ sources: null, urls: null, dims: null, missing: false, loading: true });

      let row: Awaited<ReturnType<typeof getDownload>>;
      try {
        row = await getDownload(galleryId);
      } catch {
        if (!cancelled) {
          setResult({ sources: null, urls: null, dims: null, missing: false, loading: false });
        }
        return;
      }

      if (cancelled || runId !== runIdRef.current) return;

      if (!row || row.status !== 'complete') {
        setResult({ sources: null, urls: null, dims: null, missing: false, loading: false });
        return;
      }

      let pages: { index: number; ext: string }[];
      try {
        pages = await getDownloadedGalleryPages(galleryId);
      } catch {
        pages = [];
      }

      if (cancelled || runId !== runIdRef.current) return;

      if (pages.length === 0) {
        setResult({ sources: null, urls: null, dims: null, missing: true, loading: false });
        return;
      }

      const store = await createDownloadStore().catch(() => null);
      if (cancelled || runId !== runIdRef.current) return;

      if (store?.imageUrl) {
        const imageUrl = store.imageUrl.bind(store);
        const sources: OfflineImageSource[] = pages.map(({ index, ext }) => ({
          index,
          ext,
          loadUrl: () => imageUrl(galleryId, index, ext).catch(() => null),
        }));
        setResult({
          sources,
          urls: null,
          dims: null,
          missing: false,
          loading: false,
        });
        return;
      }

      const sources: OfflineImageSource[] = pages.map(({ index, ext }) => ({
        index,
        ext,
        loadUrl: async () => {
          const bytes = await getDownloadedImage(galleryId, index).catch(() => null);
          if (!bytes) return null;
          const buf = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          return URL.createObjectURL(new Blob([buf]));
        },
      }));

      if (!cancelled) {
        setResult({ sources, urls: null, dims: null, missing: false, loading: false });
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [galleryId]);

  return result;
}
