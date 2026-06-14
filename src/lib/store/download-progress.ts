import { create } from 'zustand';
import { getGgConfig, ApiError } from '@/lib/api/client';
import {
  downloadGalleryToLibrary,
  DownloadPausedError,
  type DownloadProgress,
} from '@/lib/utils/download-zip';
import { DownloadCancelledError } from '@/lib/storage/download-store';
import { getDownload, deserializeTags } from '@/lib/db/download';
import {
  enqueueDownload,
  dequeueNextQueued,
  removeFromQueue,
} from '@/lib/db/download-queue';
import { resolveGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import type { GalleryFile } from '@/lib/utils/types';

interface DownloadEntry {
  progress: DownloadProgress | null;
  error: string | null;
  /** True while the gallery is queued but its active run has not started yet. */
  queued?: boolean;
  /** The gallery's position in the queue while queued (null once it starts). */
  position?: number | null;
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
  /** Enqueue a gallery (userInitiated) and kick the processor. */
  start: (params: StartDownloadParams) => Promise<void>;
  /** Cancel: aborts the active run, or drops a queued/paused item from the queue. */
  cancel: (id: number) => void;
  /** Load the persisted download status for a gallery from the DB into the store. */
  refreshDownloaded: (id: number) => Promise<void>;
}

// AbortControllers are kept module-level (not in store state): they are not
// serializable and need no reactivity.
const controllers = new Map<number, AbortController>();

// Galleries whose active controller was aborted as a PAUSE (not a cancel). The
// download-zip catch reads this via opts.isPauseSignal so it writes 'paused'.
const pausing = new Set<number>();

// File lists are not stored on the download row; cache the ones supplied by a
// manual start so the processor can drive that gallery without re-fetching the
// detail. Resume/auto paths fall back to resolveGalleryDetail.
const fileCache = new Map<number, { files: GalleryFile[]; tags: Record<string, string[]> }>();

// Synchronous single-flight guard for the processor loop. Never inferred from an
// async DB read — that would be a read-then-write race (PLAN decision 6).
let running = false;

// Internal helper that the store closure binds to so processQueue can push
// store updates. Assigned once when the store is created.
let storeApi: {
  setEntry: (id: number, entry: DownloadEntry | null) => void;
  markDownloaded: (id: number) => void;
} | null = null;

/**
 * Drive the queue sequentially. Synchronous `running` guard ensures only one
 * active download at a time. After each item completes/fails/pauses, re-checks
 * for the next 'queued' item and continues until the queue is empty.
 */
export async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    let next = await dequeueNextQueued();
    for (; next; next = await dequeueNextQueued()) {
      const id = next.galleryId;

      // Resolve the gallery's file list + tags. Prefer the cached list from a
      // manual start; otherwise re-fetch the detail (resume / auto-advance).
      let files: GalleryFile[];
      let tags: Record<string, string[]>;
      const cached = fileCache.get(id);
      if (cached) {
        files = cached.files;
        tags = cached.tags;
      } else {
        try {
          const detail = await resolveGalleryDetail(id);
          files = detail.files;
          tags = deserializeTags(next.tags);
        } catch (e) {
          // Could not resolve the gallery's files — leave it 'failed', advance.
          console.error('Queue: failed to resolve gallery detail', id, e);
          await removeFromQueue(id);
          storeApi?.setEntry(id, { progress: null, error: 'Failed to resolve gallery' });
          continue;
        }
      }

      if (files.length === 0) {
        await removeFromQueue(id);
        storeApi?.setEntry(id, null);
        continue;
      }

      // Resume when prior pages exist (zombie/paused/failed re-enqueue).
      const resume = (next.pageCount ?? 0) > 0;

      const controller = new AbortController();
      controllers.set(id, controller);
      storeApi?.setEntry(id, { progress: { current: 0, total: files.length }, error: null });

      try {
        const config = await getGgConfig();
        await downloadGalleryToLibrary(
          id,
          next.title,
          next.thumbnail,
          files,
          config,
          tags,
          (p) => storeApi?.setEntry(id, { progress: p, error: null }),
          controller.signal,
          { resume, isPauseSignal: () => pausing.has(id) },
        );
        // Success: item left the queue, mark downloaded, clear entry.
        await removeFromQueue(id);
        storeApi?.setEntry(id, null);
        storeApi?.markDownloaded(id);
      } catch (e) {
        if (e instanceof DownloadPausedError) {
          // Paused: row left 'paused' (resumable) by download-zip; keep it in the
          // queue (position retained), clear the live progress entry.
          storeApi?.setEntry(id, null);
        } else if (
          e instanceof DownloadCancelledError ||
          (e instanceof DOMException && e.name === 'AbortError')
        ) {
          // Genuine cancel: download-zip left the row 'failed' (resumable, no
          // message). Drop it from the queue and clear the entry.
          await removeFromQueue(id);
          storeApi?.setEntry(id, null);
        } else {
          // Genuine failure: download-zip left the row 'failed' WITH lastError.
          // Drop it from the queue (it surfaces in the library as failed) and
          // advance to the next item.
          await removeFromQueue(id);
          const message =
            e instanceof ApiError
              ? `Download failed (HTTP ${e.status})`
              : e instanceof Error && e.message
                ? e.message
                : 'Download failed';
          storeApi?.setEntry(id, { progress: null, error: message });
          console.error('Download failed:', e);
        }
      } finally {
        controllers.delete(id);
        pausing.delete(id);
        fileCache.delete(id);
      }
    }
  } finally {
    running = false;
  }
  // A re-check guard: if an item was enqueued during the final loop teardown,
  // kick the processor again (running is now false, so this is safe).
  const pending = await dequeueNextQueued().catch(() => null);
  if (pending) void processQueue();
}

export const useDownloadProgressStore = create<DownloadProgressState>()((set, get) => {
  const setEntry = (id: number, entry: DownloadEntry | null) =>
    set((s) => {
      const next = { ...s.entries };
      if (entry === null) {
        delete next[id];
      } else {
        next[id] = entry;
      }
      return { entries: next };
    });

  const markDownloaded = (id: number) =>
    set((s) => ({ downloaded: { ...s.downloaded, [id]: true } }));

  // Bind the module-level processor to this store instance.
  storeApi = { setEntry, markDownloaded };

  return {
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
      // Already running/queued for this gallery, or nothing to download.
      if (existing?.progress || existing?.queued || files.length === 0) return;

      // Cache the supplied file list so the processor doesn't re-fetch the detail.
      fileCache.set(id, { files, tags });

      try {
        // Manual tap = userInitiated → jump to the front of the queue (bypasses
        // the Wi-Fi gate, which only governs auto-resume/advance).
        const position = await enqueueDownload(
          { galleryId: id, title, thumbnail, tags },
          { userInitiated: true },
        );
        setEntry(id, { progress: null, error: null, queued: true, position });
      } catch (e) {
        fileCache.delete(id);
        const message = e instanceof Error && e.message ? e.message : 'Failed to queue download';
        setEntry(id, { progress: null, error: message });
        return;
      }

      void processQueue();
    },
    cancel: (id) => {
      const controller = controllers.get(id);
      if (controller) {
        // Active run → genuine cancel (NOT a pause).
        controller.abort();
      } else {
        // Queued/paused but not yet started → drop it from the queue.
        void removeFromQueue(id).catch(() => {});
        fileCache.delete(id);
        setEntry(id, null);
      }
    },
  };
});
