'use client';

import { useState, useCallback, useRef } from 'react';
import { getGgConfig } from '@/lib/api/client';
import { downloadGalleryToLibrary, type DownloadProgress } from '@/lib/utils/download-zip';
import type { GalleryFile } from '@/lib/utils/types';

export function useDownloadGallery(
  id: number,
  title: string,
  thumbnail: string,
  files: GalleryFile[],
  tags: Record<string, string[]> = {},
) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    if (progress || files.length === 0) return;
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
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('Download failed:', e);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [id, title, thumbnail, files, tags, progress]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { progress, start, cancel };
}
