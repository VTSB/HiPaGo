'use client';

import { useState, useCallback, useRef } from 'react';
import { getGgConfig, ApiError } from '@/lib/api/client';
import { downloadGalleryToLibrary, type DownloadProgress } from '@/lib/utils/download-zip';
import { DownloadCancelledError } from '@/lib/storage/download-store';
import type { GalleryFile } from '@/lib/utils/types';

export function useDownloadGallery(
  id: number,
  title: string,
  thumbnail: string,
  files: GalleryFile[],
  tags: Record<string, string[]> = {},
) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    if (progress || files.length === 0) return;
    setError(null);
    try {
      const config = await getGgConfig();
      abortRef.current = new AbortController();
      setProgress({ current: 0, total: files.length });
      await downloadGalleryToLibrary(
        id,
        title,
        thumbnail,
        files,
        config,
        tags,
        setProgress,
        abortRef.current.signal,
      );
    } catch (e) {
      // User-cancel paths are silent (no error shown): aborting the download, or
      // backing out of the Android SAF folder picker.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (e instanceof DownloadCancelledError) return;
      console.error('Download failed:', e);
      if (e instanceof ApiError) {
        setError(`Download failed (HTTP ${e.status})`);
      } else if (e instanceof Error && e.message) {
        // Surface the REAL reason (e.g. NO_TREE, mkdir failed, native message)
        // instead of a flat 'Download failed' — on-device failures stay diagnosable.
        setError(e.message);
      } else {
        setError('Download failed');
      }
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [id, title, thumbnail, files, tags, progress]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { progress, start, cancel, error };
}
