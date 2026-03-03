'use client';

import { useState, useCallback, useRef } from 'react';
import { getGgConfig } from '@/lib/api/client';
import { downloadGalleryAsZip, type DownloadProgress } from '@/lib/utils/download-zip';
import type { GalleryFile } from '@/lib/utils/types';

export function useDownloadGallery(id: number, title: string, files: GalleryFile[]) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async () => {
    if (progress || files.length === 0) return;
    try {
      const config = await getGgConfig();
      abortRef.current = new AbortController();
      setProgress({ current: 0, total: files.length });
      await downloadGalleryAsZip(id, title, files, config, setProgress, abortRef.current.signal);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      console.error('Download failed:', e);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }, [id, title, files, progress]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { progress, start, cancel };
}
