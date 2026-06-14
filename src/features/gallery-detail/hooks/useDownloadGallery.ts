'use client';

import { useCallback, useEffect } from 'react';
import { useDownloadProgressStore } from '@/lib/store/download-progress';
import type { GalleryFile } from '@/lib/utils/types';

export function useDownloadGallery(
  id: number,
  title: string,
  thumbnail: string,
  files: GalleryFile[],
  tags: Record<string, string[]> = {},
) {
  // Read this gallery's live download state from the global store so progress
  // survives navigating away from and back to the detail screen.
  const entry = useDownloadProgressStore((s) => s.entries[id]);
  const isDownloaded = useDownloadProgressStore((s) => s.downloaded[id] ?? false);
  const startDownload = useDownloadProgressStore((s) => s.start);
  const cancelDownload = useDownloadProgressStore((s) => s.cancel);
  const refreshDownloaded = useDownloadProgressStore((s) => s.refreshDownloaded);

  // Load persisted download status so a previously-completed download is
  // reflected when revisiting the gallery.
  useEffect(() => {
    refreshDownloaded(id);
  }, [id, refreshDownloaded]);

  const start = useCallback(
    () => startDownload({ id, title, thumbnail, files, tags }),
    [startDownload, id, title, thumbnail, files, tags],
  );

  const cancel = useCallback(() => cancelDownload(id), [cancelDownload, id]);

  return {
    progress: entry?.progress ?? null,
    error: entry?.error ?? null,
    isDownloaded,
    /** The gallery's queue position while it is queued-but-not-yet-started, else null.
     *  Lets the button render "Queued (#N)" instead of a dead/disabled state. */
    queuedPosition: entry?.queued ? (entry.position ?? null) : null,
    start,
    cancel,
  };
}
