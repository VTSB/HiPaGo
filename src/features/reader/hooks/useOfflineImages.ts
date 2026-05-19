'use client';

import { useEffect, useRef, useState } from 'react';
import { getDownload } from '@/lib/db/download';
import { getDownloadedGalleryPages, getDownloadedImage } from '@/lib/utils/download-zip';

export interface OfflineImagesResult {
  /** Blob-URL array (one per page, index-aligned). Null while loading or when
   *  the gallery is not downloaded. */
  urls: string[] | null;
  /** True when the DB row says "complete" but no pages were found in storage —
   *  i.e. the stored files are missing/corrupt. */
  missing: boolean;
  /** True while the DB check + page load are in flight. */
  loading: boolean;
}

/**
 * For a gallery that has been fully downloaded (`status: 'complete'`), load
 * all page images from local storage and return them as Blob URLs.
 *
 * Lifecycle:
 *  - Blob URLs are created with URL.createObjectURL and tracked in a ref so
 *    they can be revoked when the galleryId changes or the component unmounts,
 *    preventing memory leaks.
 *  - If getDownload returns null or status !== 'complete', urls === null and
 *    the caller falls back to the network path.
 *  - If the DB row says 'complete' but the store has no pages, missing === true
 *    so the reader can show a "files missing" state.
 */
export function useOfflineImages(galleryId: number): OfflineImagesResult {
  const [result, setResult] = useState<OfflineImagesResult>({
    urls: null,
    missing: false,
    loading: true,
  });

  // Track created blob URLs so we can revoke them on galleryId change / unmount.
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    // Revoke any blob URLs from the previous gallery.
    for (const u of blobUrlsRef.current) {
      URL.revokeObjectURL(u);
    }
    blobUrlsRef.current = [];

    async function load() {
      // Reset to loading. Done inside load() rather than the effect body so
      // no setState fires synchronously in the effect (react-hooks/set-state-in-effect).
      setResult({ urls: null, missing: false, loading: true });

      // 1. Check the download DB row.
      let row: Awaited<ReturnType<typeof getDownload>>;
      try {
        row = await getDownload(galleryId);
      } catch {
        // DB unavailable — use network path.
        if (!cancelled) setResult({ urls: null, missing: false, loading: false });
        return;
      }

      if (cancelled) return;

      if (!row || row.status !== 'complete') {
        // Gallery not fully downloaded — use network path.
        setResult({ urls: null, missing: false, loading: false });
        return;
      }

      // 2. Enumerate the stored pages.
      let pages: { index: number; ext: string }[];
      try {
        pages = await getDownloadedGalleryPages(galleryId);
      } catch {
        pages = [];
      }

      if (cancelled) return;

      if (pages.length === 0) {
        // DB row says complete but storage has no manifest → files missing.
        setResult({ urls: null, missing: true, loading: false });
        return;
      }

      // 3. Load each image and create a Blob URL.
      const newUrls: string[] = [];
      for (const { index } of pages) {
        if (cancelled) return;
        let bytes: Uint8Array | null = null;
        try {
          bytes = await getDownloadedImage(galleryId, index);
        } catch {
          bytes = null;
        }
        if (bytes) {
          // Slice to a concrete ArrayBuffer (Uint8Array.buffer may be a
          // SharedArrayBuffer on some runtimes, which Blob rejects).
          const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          const blob = new Blob([buf]);
          const url = URL.createObjectURL(blob);
          blobUrlsRef.current.push(url);
          newUrls.push(url);
        } else {
          // A page's bytes are missing — treat as missing files.
          // Revoke any URLs we already created.
          for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
          blobUrlsRef.current = [];
          if (!cancelled) setResult({ urls: null, missing: true, loading: false });
          return;
        }
      }

      if (cancelled) return;
      setResult({ urls: newUrls, missing: false, loading: false });
    }

    void load();

    return () => {
      cancelled = true;
      // Revoke blob URLs when galleryId changes or component unmounts.
      for (const u of blobUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      blobUrlsRef.current = [];
    };
  }, [galleryId]);

  return result;
}
