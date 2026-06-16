'use client';

import { useEffect, useRef, useState } from 'react';
import { getDownload } from '@/lib/db/download';
import { getDownloadedGalleryPages, getDownloadedImage } from '@/lib/utils/download-zip';

export interface OfflineImageDim {
  width: number;
  height: number;
}

export interface OfflineImagesResult {
  /** Blob-URL array (one per page, index-aligned). Null while loading or when
   *  the gallery is not downloaded. */
  urls: string[] | null;
  /** Natural pixel dimensions per page (index-aligned with urls), read from the
   *  downloaded image bytes themselves so the reader lays out with the real
   *  aspect ratio offline. {0,0} for a page whose dims could not be decoded
   *  (e.g. createImageBitmap unavailable); null when not downloaded/loading. */
  dims: OfflineImageDim[] | null;
  /** True when the DB row says "complete" but no pages were found in storage —
   *  i.e. the stored files are missing/corrupt. */
  missing: boolean;
  /** True while the DB check + page load are in flight. */
  loading: boolean;
}

/** Read an image blob's natural dimensions. Returns {0,0} when decoding is not
 *  possible (createImageBitmap missing, e.g. jsdom) or the bytes are undecodable.
 *  The bitmap is closed immediately — only the dimensions are kept. */
async function decodeDimensions(blob: Blob): Promise<OfflineImageDim> {
  if (typeof createImageBitmap !== 'function') return { width: 0, height: 0 };
  try {
    const bmp = await createImageBitmap(blob);
    const dim = { width: bmp.width, height: bmp.height };
    bmp.close();
    return dim;
  } catch {
    return { width: 0, height: 0 };
  }
}

/**
 * For a gallery that has been fully downloaded (`status: 'complete'`), load
 * all page images from local storage and return them as Blob URLs plus their
 * natural dimensions (decoded from the bytes — no stored metadata needed).
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
    dims: null,
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
      setResult({ urls: null, dims: null, missing: false, loading: true });

      // 1. Check the download DB row.
      let row: Awaited<ReturnType<typeof getDownload>>;
      try {
        row = await getDownload(galleryId);
      } catch {
        // DB unavailable — use network path.
        if (!cancelled) setResult({ urls: null, dims: null, missing: false, loading: false });
        return;
      }

      if (cancelled) return;

      if (!row || row.status !== 'complete') {
        // Gallery not fully downloaded — use network path.
        setResult({ urls: null, dims: null, missing: false, loading: false });
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
        setResult({ urls: null, dims: null, missing: true, loading: false });
        return;
      }

      // 3. Load each image, create a Blob URL, and read its natural dimensions.
      const newUrls: string[] = [];
      const newDims: OfflineImageDim[] = [];
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
          // Real aspect ratio from the downloaded bytes (the dimensions live in
          // the image itself — no need to have stored metadata at download time).
          const dim = await decodeDimensions(blob);
          if (cancelled) return;
          newDims.push(dim);
        } else {
          // A page's bytes are missing — treat as missing files.
          // Revoke any URLs we already created.
          for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
          blobUrlsRef.current = [];
          if (!cancelled) setResult({ urls: null, dims: null, missing: true, loading: false });
          return;
        }
      }

      if (cancelled) return;
      setResult({ urls: newUrls, dims: newDims, missing: false, loading: false });
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
