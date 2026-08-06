'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDownload } from '@/lib/db/download';
import { createDownloadStore } from '@/lib/storage/download-store';
import { getDownloadedGalleryPages } from '@/lib/utils/download-zip';

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
  /** True when a completed gallery's manifest or a requested page is absent. */
  missing: boolean;
  /** Storage/DB failure. Distinct from a file that is verifiably absent. */
  error: Error | null;
  /** Retry the DB, manifest, and storage initialization checks. */
  retry: () => void;
  /** True while the DB check + manifest load are in flight. */
  loading: boolean;
}

type OfflineImagesState = Omit<OfflineImagesResult, 'retry'>;

interface OwnedOfflineImagesState {
  galleryId: number;
  retryToken: number;
  value: OfflineImagesState;
}

function createLoadingState(): OfflineImagesState {
  return {
    sources: null,
    urls: null,
    dims: null,
    missing: false,
    error: null,
    loading: true,
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken((token) => token + 1), []);
  const [ownedResult, setOwnedResult] = useState<OwnedOfflineImagesState>(() => ({
    galleryId,
    retryToken,
    value: createLoadingState(),
  }));
  const runIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const runId = ++runIdRef.current;

    async function load() {
      setOwnedResult({
        galleryId,
        retryToken,
        value: createLoadingState(),
      });

      const reportError = (error: unknown) => {
        if (cancelled || runId !== runIdRef.current) return;
        setOwnedResult((current) =>
          current.galleryId === galleryId && current.retryToken === retryToken
            ? {
                ...current,
                value: {
                  ...current.value,
                  missing: false,
                  error: asError(error),
                  loading: false,
                },
              }
            : current,
        );
      };

      const reportMissing = () => {
        if (cancelled || runId !== runIdRef.current) return;
        setOwnedResult((current) =>
          current.galleryId !== galleryId || current.retryToken !== retryToken
            ? current
            : current.value.error
              ? current
              : {
                  ...current,
                  value: {
                    ...current.value,
                    missing: true,
                    loading: false,
                  },
                },
        );
      };

      let row: Awaited<ReturnType<typeof getDownload>>;
      try {
        row = await getDownload(galleryId);
      } catch (error) {
        reportError(error);
        return;
      }

      if (cancelled || runId !== runIdRef.current) return;

      if (!row || row.status !== 'complete') {
        setOwnedResult({
          galleryId,
          retryToken,
          value: {
            sources: null,
            urls: null,
            dims: null,
            missing: false,
            error: null,
            loading: false,
          },
        });
        return;
      }

      const lookup = { folderName: row.folderName ?? null };
      const expectedPageCount = row.pageCount ?? 0;
      let pages: { index: number; ext: string }[];
      try {
        pages = await getDownloadedGalleryPages(galleryId, lookup);
      } catch (error) {
        reportError(error);
        return;
      }

      if (cancelled || runId !== runIdRef.current) return;

      const validManifest =
        pages.length > 0 &&
        (expectedPageCount <= 0 || pages.length === expectedPageCount) &&
        pages.every(({ index, ext }, position) => index === position && ext.length > 0);
      if (!validManifest) {
        setOwnedResult({
          galleryId,
          retryToken,
          value: {
            sources: null,
            urls: null,
            dims: null,
            missing: true,
            error: null,
            loading: false,
          },
        });
        return;
      }

      let store: Awaited<ReturnType<typeof createDownloadStore>>;
      try {
        store = await createDownloadStore();
      } catch (error) {
        reportError(error);
        return;
      }
      if (cancelled || runId !== runIdRef.current) return;

      if (store.imageUrl) {
        const imageUrl = store.imageUrl.bind(store);
        const sources: OfflineImageSource[] = pages.map(({ index, ext }) => ({
          index,
          ext,
          loadUrl: async () => {
            try {
              const url = await imageUrl(galleryId, index, ext);
              if (!url) reportMissing();
              return url;
            } catch (error) {
              reportError(error);
              throw error;
            }
          },
        }));
        setOwnedResult({
          galleryId,
          retryToken,
          value: {
            sources,
            urls: null,
            dims: null,
            missing: false,
            error: null,
            loading: false,
          },
        });
        return;
      }

      const sources: OfflineImageSource[] = pages.map(({ index, ext }) => ({
        index,
        ext,
        loadUrl: async () => {
          try {
            const bytes = await store.getImage(galleryId, index, ext, lookup);
            if (!bytes || bytes.byteLength === 0) {
              reportMissing();
              return null;
            }
            const buf = bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
            return URL.createObjectURL(new Blob([buf]));
          } catch (error) {
            reportError(error);
            throw error;
          }
        },
      }));

      if (!cancelled) {
        setOwnedResult({
          galleryId,
          retryToken,
          value: {
            sources,
            urls: null,
            dims: null,
            missing: false,
            error: null,
            loading: false,
          },
        });
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [galleryId, retryToken]);

  const result =
    ownedResult.galleryId === galleryId && ownedResult.retryToken === retryToken
      ? ownedResult.value
      : createLoadingState();

  return { ...result, retry };
}
