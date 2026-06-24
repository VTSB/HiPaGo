'use client';

import { useEffect, useState } from 'react';
import { getDownload } from '@/lib/db/download';
import { hasCompleteDownloadedGallery } from '@/lib/utils/download-zip';
import { useDownloadProgressStore } from '@/lib/store/download-progress';

export interface DownloadedFilesPresence {
  /** True ONLY when the DB row is 'complete' but the on-disk image files are
   *  gone/short (deleted, or never fully written). The detail page uses this to
   *  show a "files missing · re-download" affordance at the download button. */
  filesMissing: boolean;
  /** True while the disk check is in flight. */
  checking: boolean;
}

/**
 * Verify that a gallery the store reports as downloaded ('complete') actually
 * has its image files on disk. A transient storage read error is treated as
 * "present" (filesMissing=false) so we never wrongly nag a re-download.
 *
 * Re-checks when the gallery changes, when its downloaded flag flips, and when
 * an active (re)download for it starts/finishes — so the button leaves the
 * "missing" state automatically once the files are restored. The store reads use
 * primitive selectors (boolean), so per-percent progress churn does NOT
 * re-trigger the disk read.
 */
export function useDownloadedFilesPresent(id: number): DownloadedFilesPresence {
  const isDownloaded = useDownloadProgressStore((s) => s.downloaded[id] ?? false);
  const downloadActive = useDownloadProgressStore((s) => s.entries[id]?.progress != null);
  const [state, setState] = useState<DownloadedFilesPresence>({
    filesMissing: false,
    checking: true,
  });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Reset inside the async fn (not synchronously in the effect body) to
      // satisfy react-hooks/set-state-in-effect.
      setState({ filesMissing: false, checking: true });
      // Only a completed download can have "missing" files; everything else is
      // handled by the normal not-downloaded / downloading button states.
      if (!isDownloaded || downloadActive) {
        if (!cancelled) setState({ filesMissing: false, checking: false });
        return;
      }
      try {
        const row = await getDownload(id);
        if (cancelled) return;
        if (!row || row.status !== 'complete') {
          setState({ filesMissing: false, checking: false });
          return;
        }
        const completeOnDisk = await hasCompleteDownloadedGallery(id, row.pageCount);
        if (cancelled) return;
        setState({ filesMissing: !completeOnDisk, checking: false });
      } catch {
        // Transient/unknown storage error — assume present, don't nag.
        if (!cancelled) setState({ filesMissing: false, checking: false });
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, [id, isDownloaded, downloadActive]);

  return state;
}
