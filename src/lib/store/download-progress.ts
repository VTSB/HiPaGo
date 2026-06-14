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
  listQueue,
  pauseQueued,
  resumeQueued,
  reorderQueue,
} from '@/lib/db/download-queue';
import {
  AUTO_RETRY_BACKOFF_MS,
  AUTO_RETRY_MAX,
  scheduleAutoRetry,
  listDueAutoRetries,
  earliestNextRetryAt,
} from '@/lib/db/download-retry';
import { isUnmeteredNetwork } from '@/lib/utils/network';
import { resolveGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import type { GalleryFile } from '@/lib/utils/types';
import type { DownloadStatus } from '@/lib/db/schema';

interface DownloadEntry {
  progress: DownloadProgress | null;
  error: string | null;
  /** True while the gallery is queued but its active run has not started yet. */
  queued?: boolean;
  /** The gallery's position in the queue while queued (null once it starts). */
  position?: number | null;
  /** ISO time when this failed item will auto-retry; set when a genuine failure
   *  is scheduled (retryCount < AUTO_RETRY_MAX). null/absent once exhausted. */
  retryAt?: string | null;
  /** Which automatic attempt (1-based) the pending retryAt represents. */
  attempt?: number | null;
}

/**
 * A reactive row in the download-manager UI. Built from `listQueue()`
 * (queued/paused rows) merged with the single active in-flight item (the entry
 * whose `progress` is non-null). The active item is rendered with a live
 * progress bar; queued/paused items show their position.
 */
export interface QueueItem {
  id: number;
  title: string;
  thumbnail: string;
  /** 'downloading' for the active item, else the DB status ('queued'|'paused'). */
  status: Extract<DownloadStatus, 'downloading' | 'queued' | 'paused'>;
  /** Queue position (from the DB). null for the active item. */
  position: number | null;
  /** Live progress for the active item only; null for queued/paused rows. */
  progress: DownloadProgress | null;
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
  /** The download-manager surface: active item + queued/paused rows in order.
   *  Rebuilt from listQueue() (merged with the active entry) by refreshQueue(). */
  queue: QueueItem[];
  /** When true, the processor stops auto-advancing and the active item is paused. */
  globalPaused: boolean;
  /** Enqueue a gallery (userInitiated) and kick the processor. */
  start: (params: StartDownloadParams) => Promise<void>;
  /** Cancel: aborts the active run, or drops a queued/paused item from the queue. */
  cancel: (id: number) => void;
  /** Load the persisted download status for a gallery from the DB into the store. */
  refreshDownloaded: (id: number) => Promise<void>;
  /** Re-read listQueue() + the active entry and publish the reactive `queue`. */
  refreshQueue: () => Promise<void>;
  /** Pause one item: active → pausing+abort (download-zip writes 'paused');
   *  queued → pauseQueued. Paused items stay in the queue at their position. */
  pause: (id: number) => Promise<void>;
  /** Resume a paused item back to 'queued' and (unless globally paused) re-drive. */
  resume: (id: number) => Promise<void>;
  /** Move a PENDING (queued/paused) item to a new queue position. The active
   *  in-flight item is not reorderable (guarded). */
  reorder: (id: number, newPos: number) => Promise<void>;
  /** Clear a gallery's "auto-retry pending" store entry (manual retry resets it). */
  clearRetryPending: (id: number) => void;
  /** Stop the whole queue: set globalPaused and pause the active item if any. */
  pauseAll: () => Promise<void>;
  /** Resume the whole queue: clear globalPaused, resume every paused row, re-drive. */
  resumeAll: () => Promise<void>;
}

/** True iff the queue is non-empty (active or pending) — drives the nav badge.
 *  A cheap selector so subscribers only re-render on the boolean flip. */
export const selectQueueActive = (s: DownloadProgressState): boolean => s.queue.length > 0;

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

// Module-level global-pause flag. Read synchronously at the top of the processor
// loop so a pauseAll() stops auto-advance immediately (the store's reactive
// `globalPaused` mirrors this for the UI). Kept here, not in store state, so the
// processor can consult it without subscribing to React.
let globalPaused = false;

// Module-level single timer for staged auto-restart (Task E). Only ONE timer
// ever exists; it is cleared + rearmed to the earliest pending nextRetryAt on
// every schedule/fire/queue mutation (mirrors the running/controllers
// module-singleton pattern so the scheduler is independent of React).
let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;

// Internal helper that the store closure binds to so processQueue can push
// store updates. Assigned once when the store is created.
let storeApi: {
  setEntry: (id: number, entry: DownloadEntry | null) => void;
  markDownloaded: (id: number) => void;
  refreshQueue: () => void;
  armAutoRetryTimer: () => void;
} | null = null;

/**
 * Re-arm the single auto-retry timer to the earliest pending `nextRetryAt`.
 *
 * Clears any existing timer, reads earliestNextRetryAt(), and (when something
 * is pending) sets one setTimeout that, on fire, runs the due auto-retries IF
 * the network is unmetered (Wi-Fi gate at FIRE time, not schedule time), then
 * re-arms. Best-effort: never throws into the caller.
 */
export function armAutoRetryTimer(): void {
  if (autoRetryTimer !== null) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }
  void (async () => {
    let earliest: string | null;
    try {
      earliest = await earliestNextRetryAt();
    } catch {
      return;
    }
    if (!earliest) return;
    // Clamp to >= 0; an overdue item fires on the next tick.
    const delay = Math.max(0, new Date(earliest).getTime() - Date.now());
    // A second arm may have run while we awaited; clear before setting.
    if (autoRetryTimer !== null) {
      clearTimeout(autoRetryTimer);
      autoRetryTimer = null;
    }
    autoRetryTimer = setTimeout(() => {
      autoRetryTimer = null;
      void fireDueAutoRetries();
    }, delay);
  })();
}

/**
 * Re-enqueue every currently-due auto-retry row (Wi-Fi-gated) and kick the
 * processor, then re-arm the timer for whatever remains. On a metered network
 * nothing is requeued and the timer is re-armed to try again later.
 */
export async function fireDueAutoRetries(): Promise<void> {
  let unmetered: boolean;
  try {
    unmetered = await isUnmeteredNetwork();
  } catch {
    unmetered = false;
  }

  if (unmetered) {
    let due: Awaited<ReturnType<typeof listDueAutoRetries>> = [];
    try {
      due = await listDueAutoRetries(new Date().toISOString());
    } catch {
      due = [];
    }
    for (const row of due) {
      try {
        // Auto requeue: KEEP the escalating-backoff counter (keepRetryState) so
        // the next failure escalates rather than resetting to attempt 1.
        await enqueueDownload(
          {
            galleryId: row.galleryId,
            title: row.title,
            thumbnail: row.thumbnail,
            tags: deserializeTags(row.tags),
          },
          { keepRetryState: true },
        );
        // The row left 'failed' for 'queued' — drop any stale retry-pending entry.
        storeApi?.setEntry(row.galleryId, null);
      } catch (e) {
        console.warn('[auto-retry] requeue failed:', row.galleryId, e);
      }
    }
    if (due.length > 0) {
      storeApi?.refreshQueue();
      void processQueue();
    }
  }

  // Always re-arm: metered → wait for the next window; unmetered → any rows that
  // were not due yet still need a timer.
  armAutoRetryTimer();
}

/**
 * Drive the queue sequentially. Synchronous `running` guard ensures only one
 * active download at a time. After each item completes/fails/pauses, re-checks
 * for the next 'queued' item and continues until the queue is empty.
 */
export async function processQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Honour a global pause before dequeuing the first item, too.
    let next = globalPaused ? null : await dequeueNextQueued();
    for (; next; next = globalPaused ? null : await dequeueNextQueued()) {
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
      // Transition: this item just became the active in-flight download — the
      // queue row left listQueue() (status flipped to 'downloading'), so rebuild
      // the reactive queue to surface it as the active item.
      storeApi?.refreshQueue();

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
          console.error('Download failed:', e);

          // Staged auto-restart (Task E): if the row still has automatic
          // attempts left, schedule the next one on escalating backoff and
          // surface a "retry pending" entry. Otherwise leave it plain 'failed'
          // (manual retry only). removeFromQueue kept the row 'failed' (it has
          // pages) or deleted it (no pages); read it back to learn the count.
          const failedRow = await getDownload(id).catch(() => null);
          const usedAttempts = failedRow?.retryCount ?? 0;
          if (failedRow && usedAttempts < AUTO_RETRY_MAX) {
            const attempt = usedAttempts + 1;
            const delay = AUTO_RETRY_BACKOFF_MS[usedAttempts];
            const retryAt = new Date(Date.now() + delay).toISOString();
            await scheduleAutoRetry(id, attempt, retryAt).catch(() => {});
            storeApi?.setEntry(id, { progress: null, error: message, retryAt, attempt });
            storeApi?.armAutoRetryTimer();
          } else {
            // Cap exhausted (or row gone): leave it failed, no further auto-retry.
            storeApi?.setEntry(id, { progress: null, error: message });
          }
        }
      } finally {
        controllers.delete(id);
        pausing.delete(id);
        fileCache.delete(id);
        // Transition: this item reached a terminal state (complete/paused/
        // cancelled/failed). Rebuild the reactive queue before advancing so the
        // manager UI reflects the new head/order at every step.
        storeApi?.refreshQueue();
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

  // Rebuild the reactive `queue`: the queued/paused rows from listQueue() merged
  // with the single active in-flight item (the entry whose progress is non-null).
  // listQueue() is the source of truth for order; the active item (already flipped
  // to 'downloading', so absent from listQueue) is prepended from the live entry.
  const refreshQueue = async () => {
    let rows: Awaited<ReturnType<typeof listQueue>>;
    try {
      rows = await listQueue();
    } catch {
      // DB unavailable — leave the queue untouched rather than blanking the UI.
      return;
    }
    const entries = get().entries;
    const activeId = Object.keys(entries)
      .map(Number)
      .find((id) => entries[id]?.progress);

    const pending: QueueItem[] = rows.map((r) => ({
      id: r.galleryId,
      title: r.title,
      thumbnail: r.thumbnail,
      status: r.status === 'paused' ? 'paused' : 'queued',
      position: r.queuePosition ?? null,
      progress: null,
    }));

    let queue: QueueItem[] = pending;
    if (activeId !== undefined) {
      const active = entries[activeId];
      // The active item flipped to 'downloading', so it is no longer in
      // listQueue(); read its row directly for title/thumbnail metadata.
      const activeRow = await getDownload(activeId).catch(() => null);
      const activeItem: QueueItem = {
        id: activeId,
        title: activeRow?.title ?? '',
        thumbnail: activeRow?.thumbnail ?? '',
        status: 'downloading',
        position: null,
        progress: active?.progress ?? null,
      };
      // Active item is always rendered at the top; drop any stale pending dup.
      queue = [activeItem, ...pending.filter((p) => p.id !== activeId)];
    }
    set({ queue });
  };

  // Bind the module-level processor to this store instance.
  storeApi = {
    setEntry,
    markDownloaded,
    refreshQueue: () => void refreshQueue(),
    armAutoRetryTimer,
  };

  return {
    entries: {},
    downloaded: {},
    queue: [],
    globalPaused: false,
    refreshQueue,
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

      void refreshQueue();
      void processQueue();
    },
    cancel: (id) => {
      const controller = controllers.get(id);
      if (controller) {
        // Active run → genuine cancel (NOT a pause).
        controller.abort();
      } else {
        // Queued/paused but not yet started → drop it from the queue.
        void removeFromQueue(id)
          .catch(() => {})
          .finally(() => void refreshQueue());
        fileCache.delete(id);
        setEntry(id, null);
      }
    },
    pause: async (id) => {
      const controller = controllers.get(id);
      if (controller) {
        // Active run → mark it as a PAUSE before aborting so download-zip reads
        // the pausing signal and writes status 'paused' (not 'failed').
        pausing.add(id);
        controller.abort();
      } else {
        // Not-yet-started queued item → just hold it.
        await pauseQueued(id);
      }
      await refreshQueue();
    },
    resume: async (id) => {
      await resumeQueued(id);
      if (!globalPaused) void processQueue();
      await refreshQueue();
    },
    reorder: async (id, newPos) => {
      // The active in-flight item is not reorderable — it keeps downloading.
      if (controllers.has(id)) return;
      await reorderQueue(id, newPos);
      await refreshQueue();
    },
    clearRetryPending: (id) => {
      // Drop the "auto-retry pending" entry and re-arm the timer (one fewer
      // pending row may change the earliest due time).
      setEntry(id, null);
      armAutoRetryTimer();
    },
    pauseAll: async () => {
      globalPaused = true;
      set({ globalPaused: true });
      // Pause the active item too, if one is in flight.
      for (const [id, controller] of controllers) {
        pausing.add(id);
        controller.abort();
      }
      await refreshQueue();
    },
    resumeAll: async () => {
      globalPaused = false;
      set({ globalPaused: false });
      // Flip every paused row back to 'queued', then re-drive the processor.
      let rows: Awaited<ReturnType<typeof listQueue>> = [];
      try {
        rows = await listQueue();
      } catch {
        rows = [];
      }
      for (const r of rows) {
        if (r.status === 'paused') await resumeQueued(r.galleryId);
      }
      void processQueue();
      await refreshQueue();
    },
  };
});
