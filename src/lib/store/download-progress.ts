import { create } from 'zustand';
import { getGgConfig, ApiError } from '@/lib/api/client';
import { downloadGalleryToLibrary, type DownloadProgress } from '@/lib/utils/download-zip';
import { DownloadCancelledError } from '@/lib/storage/download-store';
import { getDownload } from '@/lib/db/download';
import type { GalleryFile } from '@/lib/utils/types';

interface DownloadEntry {
  progress: DownloadProgress | null;
  error: string | null;
}

export interface StartDownloadParams {
  id: number;
  title: string;
  thumbnail: string;
  files: GalleryFile[];
  tags?: Record<string, string[]>;
}

interface DownloadProgressState {
  /** Per-gallery download state, keyed by gallery id. Lives outside React so the
   *  progress survives navigating away from and back to the gallery detail. */
  entries: Record<number, DownloadEntry>;
  /** Whether a gallery is already fully downloaded, keyed by gallery id.
   *  Seeded from the DB via refreshDownloaded(), set true after a download completes. */
  downloaded: Record<number, boolean>;
  start: (params: StartDownloadParams) => Promise<void>;
  cancel: (id: number) => void;
  /** Load the persisted download status for a gallery from the DB into the store. */
  refreshDownloaded: (id: number) => Promise<void>;
}

// AbortControllers are kept module-level (not in store state): they are not
// serializable and need no reactivity.
const controllers = new Map<number, AbortController>();

export const useDownloadProgressStore = create<DownloadProgressState>()((set, get) => ({
  entries: {},
  downloaded: {},
  refreshDownloaded: async (id) => {
    try {
      const row = await getDownload(id);
      const isComplete = row?.status === 'complete';
      set((s) => ({ downloaded: { ...s.downloaded, [id]: isComplete } }));
    } catch {
      // DB unavailable: leave the flag untouched (treated as not-downloaded).
    }
  },
  start: async ({ id, title, thumbnail, files, tags = {} }) => {
    const existing = get().entries[id];
    // Already running for this gallery, or nothing to download.
    if (existing?.progress || files.length === 0) return;

    const setEntry = (entry: DownloadEntry | null) =>
      set((s) => {
        const next = { ...s.entries };
        if (entry === null) {
          delete next[id];
        } else {
          next[id] = entry;
        }
        return { entries: next };
      });

    const setProgress = (progress: DownloadProgress | null) =>
      set((s) => ({ entries: { ...s.entries, [id]: { progress, error: null } } }));

    try {
      const config = await getGgConfig();
      const controller = new AbortController();
      controllers.set(id, controller);
      setProgress({ current: 0, total: files.length });
      await downloadGalleryToLibrary(
        id,
        title,
        thumbnail,
        files,
        config,
        tags,
        setProgress,
        controller.signal,
      );
    } catch (e) {
      // User-cancel paths are silent (no error shown): aborting the download, or
      // backing out of the Android SAF folder picker.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (e instanceof DownloadCancelledError) return;
      console.error('Download failed:', e);
      if (e instanceof ApiError) {
        setEntry({ progress: null, error: `Download failed (HTTP ${e.status})` });
      } else if (e instanceof Error && e.message) {
        // Surface the REAL reason (e.g. NO_TREE, mkdir failed, native message)
        // instead of a flat 'Download failed' — on-device failures stay diagnosable.
        setEntry({ progress: null, error: e.message });
      } else {
        setEntry({ progress: null, error: 'Download failed' });
      }
      return;
    } finally {
      controllers.delete(id);
    }
    // Success: clear the progress entry and mark the gallery as downloaded.
    setEntry(null);
    set((s) => ({ downloaded: { ...s.downloaded, [id]: true } }));
  },
  cancel: (id) => {
    controllers.get(id)?.abort();
  },
}));
