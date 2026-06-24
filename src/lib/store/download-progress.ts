import { create } from 'zustand';
import { getGgConfig, ApiError } from '@/lib/api/client';
import {
  downloadGalleryToLibrary,
  getDownloadedGalleryPages,
  hasCompleteDownloadedGallery,
  DownloadPausedError,
  type DownloadProgress,
} from '@/lib/utils/download-zip';
import { createDownloadStore, DownloadCancelledError } from '@/lib/storage/download-store';
import {
  getDownload,
  deserializeTags,
  upsertDownload,
  serializeTags,
  setDownloadError,
} from '@/lib/db/download';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';
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
import { isAndroid, isIos } from '@/lib/utils/platform';
import { buildWorkOrder, buildIosWorkOrder } from '@/lib/utils/work-order';
import { DownloadWorker } from '@/lib/plugins/downloadWorker';
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
 * (queued/paused rows) merged with active in-flight items (entries whose
 * `progress` is non-null). Active items are rendered with live progress bars;
 * queued/paused items show their position.
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
   *  Rebuilt from listQueue() (merged with active entries) by refreshQueue(). */
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
let autoRetryArmSeq = 0;
const METERED_AUTO_RETRY_RECHECK_MS = 60_000;

// Internal helper that the store closure binds to so processQueue can push
// store updates. Assigned once when the store is created.
let storeApi: {
  setEntry: (id: number, entry: DownloadEntry | null) => void;
  markDownloaded: (id: number) => void;
  markNotDownloaded: (id: number) => void;
  refreshQueue: () => void;
  armAutoRetryTimer: () => void;
  /** True iff a store entry exists for `id` (the Android poller's stop signal). */
  hasEntry: (id: number) => boolean;
} | null = null;

async function scheduleFailureRetry(
  id: number,
  message: string,
  entry: Pick<DownloadEntry, 'progress'> = { progress: null },
): Promise<void> {
  const failedRow = await getDownload(id).catch(() => null);
  const usedAttempts = failedRow?.retryCount ?? 0;
  if (failedRow && usedAttempts < AUTO_RETRY_MAX) {
    const attempt = usedAttempts + 1;
    const delay = AUTO_RETRY_BACKOFF_MS[usedAttempts];
    const retryAt = new Date(Date.now() + delay).toISOString();
    try {
      await scheduleAutoRetry(id, attempt, retryAt);
      storeApi?.setEntry(id, { ...entry, error: message, retryAt, attempt });
      storeApi?.armAutoRetryTimer();
      return;
    } catch {
      // Fall through to a plain failed entry if retry persistence fails.
    }
  }
  storeApi?.setEntry(id, { ...entry, error: message });
}

/**
 * Re-arm the single auto-retry timer to the earliest pending `nextRetryAt`.
 *
 * Clears any existing timer, reads earliestNextRetryAt(), and (when something
 * is pending) sets one setTimeout that, on fire, runs the due auto-retries IF
 * the network is unmetered (Wi-Fi gate at FIRE time, not schedule time), then
 * re-arms. Best-effort: never throws into the caller.
 */
export function armAutoRetryTimer(): void {
  const seq = ++autoRetryArmSeq;
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
    if (seq !== autoRetryArmSeq) return;
    if (!earliest) return;
    // Clamp to >= 0; an overdue item fires on the next tick.
    const delay = Math.max(0, new Date(earliest).getTime() - Date.now());
    scheduleAutoRetryTimer(delay, seq);
  })();
}

function scheduleAutoRetryTimer(delay: number, seq = ++autoRetryArmSeq): void {
  if (autoRetryTimer !== null) {
    clearTimeout(autoRetryTimer);
    autoRetryTimer = null;
  }
  autoRetryTimer = setTimeout(() => {
    if (seq !== autoRetryArmSeq) return;
    autoRetryTimer = null;
    void fireDueAutoRetries();
  }, delay);
}

async function rearmAutoRetryTimerAfterMeteredHold(): Promise<void> {
  let earliest: string | null;
  try {
    earliest = await earliestNextRetryAt();
  } catch {
    return;
  }
  if (!earliest) return;
  const dueDelay = Math.max(0, new Date(earliest).getTime() - Date.now());
  scheduleAutoRetryTimer(Math.max(dueDelay, METERED_AUTO_RETRY_RECHECK_MS));
}

/**
 * Re-enqueue every currently-due auto-retry row (Wi-Fi-gated) and kick the
 * processor, then re-arm the timer for whatever remains. On a metered network
 * nothing is requeued and an overdue item is checked again after a short hold
 * instead of spinning a 0ms timer.
 */
export async function fireDueAutoRetries(): Promise<void> {
  let unmetered: boolean;
  try {
    unmetered = await isUnmeteredNetwork();
  } catch {
    unmetered = false;
  }

  // Android auto-retries are handed to WorkManager, whose constraint is
  // NetworkType.CONNECTED, so cellular is allowed there. Other platforms keep
  // the Wi-Fi/ethernet gate for in-process downloads.
  if (!unmetered && !isAndroid()) {
    await rearmAutoRetryTimerAfterMeteredHold();
    return;
  }

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
      const holdUntil = new Date(Date.now() + METERED_AUTO_RETRY_RECHECK_MS).toISOString();
      await scheduleAutoRetry(row.galleryId, row.retryCount ?? 0, holdUntil).catch(() => {});
    }
  }
  if (due.length > 0) {
    storeApi?.refreshQueue();
    void processQueue();
  }

  // Any rows that were not due yet still need a timer.
  armAutoRetryTimer();
}

// ── Android in-app live-progress poller (in-app progress bridge) ──────────────
//
// On Android the gallery downloads in the native WorkManager worker, so the TS
// side has no in-process progress callback. The worker publishes live progress
// to a per-gallery file; while the app is foreground we poll DownloadWorker
// .getProgress(galleryId) (~1s) and push it into the store so the active card
// shows advancing current/total · %.
//
// A SINGLE module-level interval ever exists (mirrors the running/controllers/
// autoRetryTimer module-singleton pattern). It tracks every Android gallery row
// that has been handed off and is still visible as active in the store. It stops
// when no Android download is active, or when the document is hidden
// (backgrounded); it resumes on 'visible' if any handoff is still active.
const PROGRESS_POLL_INTERVAL_MS = 1000;
const LIBRARY_CHANGE_THROTTLE_MS = 750;

export const DOWNLOAD_LIBRARY_CHANGED_EVENT = 'hipago:download-library-changed';

let lastLibraryChangeEventAt = 0;

export function notifyDownloadLibraryChanged(force = false): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (!force && now - lastLibraryChangeEventAt < LIBRARY_CHANGE_THROTTLE_MS) return;
  lastLibraryChangeEventAt = now;
  window.dispatchEvent(new CustomEvent(DOWNLOAD_LIBRARY_CHANGED_EVENT));
}

let progressPollTimer: ReturnType<typeof setInterval> | null = null;
// Gallery ids currently driven by the Android progress poller. WorkManager runs
// galleries sequentially, but multiple rows can be handed off quickly; polling
// all active ids avoids locking the in-app % display onto the last handed-off id.
const progressPollGalleryIds = new Set<number>();

/** Clear the single poll interval (does NOT forget which gallery was active). */
function clearProgressPollTimer(): void {
  if (progressPollTimer !== null) {
    clearInterval(progressPollTimer);
    progressPollTimer = null;
  }
}

/**
 * Finalize a native-background download row to 'complete' when the on-disk
 * manifest exactly matches every page. SHARED by the Android live-progress poller
 * (in-app, while the app stays open) and reconcileQueue (on next app open) so the
 * two use ONE completion rule and cannot drift. A 'downloading' row whose
 * manifest lists exactly its recorded `pageCount` pages is marked 'complete'.
 * Returns true iff the row is 'complete' after the call. May throw on DB/store
 * IO — callers decide whether that is fatal (reconcile) or retried next tick
 * (poller).
 */
export async function finalizeDownloadIfComplete(galleryId: number): Promise<boolean> {
  const current = await getDownload(galleryId);
  if (!current) return false;
  if (current.status === 'complete') return true;
  if (current.status !== 'downloading' || (current.pageCount ?? 0) <= 0) return false;
  if (await hasCompleteDownloadedGallery(galleryId, current.pageCount)) {
    const pages = await getDownloadedGalleryPages(galleryId);
    await upsertDownload({
      ...current,
      pageCount: pages.length,
      status: 'complete',
      lastError: null,
    });
    return true;
  }
  return false;
}

/**
 * The Android worker for `id` may have finished (progress reached total, or its
 * progress file vanished). Confirm via the on-disk manifest and, if complete,
 * flip the row to 'complete' IN-APP: clear the live entry, mark it downloaded,
 * refresh the queue, and stop the poll. Without this the row stays 'downloading'
 * until the next app launch reconciles it — the "all files downloaded but still
 * shows downloading" bug. No-op when not actually complete (e.g. the progress
 * file is merely absent because the worker has not started yet).
 */
async function finalizeAndroidDownloadIfComplete(id: number): Promise<void> {
  let done = false;
  try {
    done = await finalizeDownloadIfComplete(id);
  } catch {
    return; // transient IO — re-checked on the next tick
  }
  if (!done) return;
  storeApi?.setEntry(id, null);
  storeApi?.markDownloaded(id);
  storeApi?.refreshQueue();
  notifyDownloadLibraryChanged(true);
  stopAndroidProgressPoll(id);
}

async function failAndroidDownloadIfWorkerStopped(id: number, message: string): Promise<void> {
  await setDownloadError(id, 'failed', message).catch(() => {});
  await scheduleFailureRetry(id, message);
  storeApi?.markNotDownloaded(id);
  storeApi?.refreshQueue();
  notifyDownloadLibraryChanged(true);
  stopAndroidProgressPoll(id);
}

/** One poll tick: read the worker's progress file and push it into the store. */
async function pollAndroidProgressOnce(id: number): Promise<void> {
  // The gallery is done/cancelled when its store entry is gone — stop polling.
  if (storeApi === null || !storeApi.hasEntry(id)) {
    stopAndroidProgressPoll(id);
    return;
  }
  let res: Awaited<ReturnType<typeof DownloadWorker.getProgress>> | null;
  try {
    res = await DownloadWorker.getProgress({ galleryId: String(id) });
  } catch {
    // Plugin unavailable / rejected this tick — leave the last known value.
    return;
  }
  // A still-active poller may have been stopped for this id while we awaited.
  if (!progressPollGalleryIds.has(id)) return;
  if (res && typeof (res as { current: number | null }).current === 'number') {
    const { current, total } = res as { current: number; total: number };
    storeApi?.setEntry(id, { progress: { current, total }, error: null });
    storeApi?.refreshQueue();
    // Worker reported every page done — confirm via the manifest and finalize
    // the row in-app so it leaves "downloading" without waiting for a relaunch.
    if (total > 0 && current >= total) {
      await finalizeAndroidDownloadIfComplete(id);
    }
    return;
  }
  // current === null → no progress file: the worker has not started yet, failed,
  // or completed (it deletes the file when done). Disambiguate via the on-disk
  // manifest first. If the manifest is still incomplete after we had observed
  // native progress, treat it as a stopped/failed worker instead of leaving the
  // row stuck as "downloading" until next app launch.
  await finalizeAndroidDownloadIfComplete(id);
  if (!progressPollGalleryIds.has(id)) return;
  const lastProgress = useDownloadProgressStore.getState().entries[id]?.progress;
  if (lastProgress && lastProgress.current > 0) {
    await failAndroidDownloadIfWorkerStopped(id, 'Background download stopped before completion');
  }
}

/**
 * Start polling the Android worker's live progress for `id`. Idempotent for the
 * same id; retargets (clear + rearm) for a different id. No-op off Android, when
 * the document is hidden, or with no DOM. Called from the Android handoff branch.
 */
export function startAndroidProgressPoll(id: number): void {
  if (!isAndroid()) return;
  progressPollGalleryIds.add(id);
  // Don't poll while backgrounded (the notification carries progress there); the
  // visibilitychange listener resumes it on foreground.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    clearProgressPollTimer();
    return;
  }
  // Immediate first read so the card leaves 0/total without waiting a full tick.
  void pollAndroidProgressOnce(id);
  if (progressPollTimer !== null) return;
  progressPollTimer = setInterval(() => {
    if (progressPollGalleryIds.size === 0) {
      clearProgressPollTimer();
      return;
    }
    for (const galleryId of [...progressPollGalleryIds]) {
      void pollAndroidProgressOnce(galleryId);
    }
  }, PROGRESS_POLL_INTERVAL_MS);
}

/**
 * Stop polling one gallery, or clear the whole poller when no id is supplied
 * (test/reset path). Completion/cancel of one Android row must not silence other
 * active rows.
 */
export function stopAndroidProgressPoll(id?: number): void {
  if (id === undefined) {
    progressPollGalleryIds.clear();
  } else {
    progressPollGalleryIds.delete(id);
  }
  if (progressPollGalleryIds.size === 0) clearProgressPollTimer();
}

// Pause polling while backgrounded; resume on foreground if a gallery is still
// active. Registered once at module load (guarded for non-DOM/test/SSR envs).
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (progressPollGalleryIds.size === 0) return;
    if (document.visibilityState === 'hidden') {
      // Stop ticking but remember the ids so 'visible' can resume them.
      clearProgressPollTimer();
    } else {
      // Foreground again — resume polling still-active galleries if their
      // entries survive (cleared while away → completion reconciled, no poll).
      for (const id of [...progressPollGalleryIds]) {
        if (storeApi?.hasEntry(id)) {
          startAndroidProgressPoll(id);
        } else {
          stopAndroidProgressPoll(id);
        }
      }
      if (progressPollGalleryIds.size > 0 && progressPollTimer === null) {
        for (const id of [...progressPollGalleryIds]) {
          void pollAndroidProgressOnce(id);
        }
        progressPollTimer = setInterval(() => {
          if (progressPollGalleryIds.size === 0) {
            clearProgressPollTimer();
            return;
          }
          for (const galleryId of [...progressPollGalleryIds]) {
            void pollAndroidProgressOnce(galleryId);
          }
        }, PROGRESS_POLL_INTERVAL_MS);
      }
    }
  });
}

/**
 * Android handoff (Task C): hand one gallery off to the native WorkManager
 * worker instead of running the in-process downloader.
 *
 * Resolves the gg config, builds the work-order (per-page url/ext/relPath/
 * headers), writes it to the native handoff dir, and enqueues the unique
 * connected-network worker chain. The worker writes images + the 0000.json
 * manifest into the SAF tree the reader already uses; the row's completion is
 * reconciled on next app open/foreground (reconcileQueue). This is fast (no
 * download is awaited here), so the processor does NOT hold `running` waiting
 * on the worker.
 *
 * Throws on a genuine handoff failure so the caller leaves the item failed.
 */
async function handOffToAndroidWorker(
  id: number,
  title: string,
  files: GalleryFile[],
): Promise<void> {
  const config = await getGgConfig();
  const order = buildWorkOrder(id, title, files, config);
  const galleryId = String(id);
  await DownloadWorker.writeWorkOrder({ galleryId, json: JSON.stringify(order) });
  await DownloadWorker.enqueue({ galleryId });
}

/**
 * iOS best-effort background backstop (Task D).
 *
 * Unlike Android, iOS does NOT replace the in-process foreground downloader —
 * it ADDS a backstop: while the app is open the in-process
 * `downloadGalleryToLibrary` runs as today, AND we persist a work-order +
 * schedule a `BGProcessingTask` so a backgrounding app can resume the SAME
 * gallery for whatever time iOS grants (best-effort, OS-governed, not
 * guaranteed). Foreground JS suspends while backgrounded, so the two paths never
 * truly run concurrently; the native task's per-page resume-skip (a page already
 * on disk is skipped) makes the overlap idempotent.
 *
 * Best-effort: a scheduling failure (e.g. simulator, missing capability) must
 * NOT fail the foreground download, so this never throws — it logs and returns.
 * The iOS work-order targets the numeric `downloads/<id>/NNNN.ext` layout the
 * `CapacitorDownloadStore` reader uses (see {@link buildIosWorkOrder}).
 */
async function scheduleIosBackgroundBackstop(
  id: number,
  title: string,
  files: GalleryFile[],
): Promise<void> {
  try {
    const config = await getGgConfig();
    const order = buildIosWorkOrder(id, title, files, config);
    const galleryId = String(id);
    await DownloadWorker.writeWorkOrder({ galleryId, json: JSON.stringify(order) });
    await DownloadWorker.enqueue({ galleryId });
  } catch (e) {
    // Backstop only — the in-process foreground download is the primary path.
    console.warn('[ios-bg] failed to schedule background backstop', id, e);
  }
}

/**
 * Drive the queue sequentially. Synchronous `running` guard ensures only one
 * active download at a time. After each item completes/fails/pauses, re-checks
 * for the next 'queued' item and continues until the queue is empty.
 */
export async function processQueue(options: { onlyGalleryId?: number } = {}): Promise<void> {
  if (running) return;
  const onlyGalleryId = options.onlyGalleryId;
  running = true;
  try {
    // Honour a global pause before dequeuing the first item, too.
    let next = globalPaused ? null : await dequeueNextQueued();
    for (; next; next = globalPaused ? null : await dequeueNextQueued()) {
      const id = next.galleryId;
      if (onlyGalleryId !== undefined && id !== onlyGalleryId) break;

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
          const message = 'Failed to resolve gallery';
          await setDownloadError(id, 'failed', message).catch(() => {});
          await removeFromQueue(id);
          await scheduleFailureRetry(id, message);
          storeApi?.markNotDownloaded(id);
          notifyDownloadLibraryChanged(true);
          continue;
        }
      }

      if (files.length === 0) {
        await removeFromQueue(id);
        storeApi?.setEntry(id, null);
        continue;
      }

      // ── Android branch (Task C) ───────────────────────────────────────────
      // On Android the native WorkManager worker is the SOLE downloader. Hand
      // the work-order off to it (fast, non-blocking) instead of running the
      // in-process downloader, then drop the item from the TS queue — the worker
      // owns it now and the row is reconciled on next app open. We keep draining
      // the TS queue so every queued gallery is handed off; the native bridge
      // appends a follow-up worker pass if a run is already active.
      if (isAndroid()) {
        try {
          const downloadStore = await createDownloadStore();
          await downloadStore.ensureReady?.();
          await handOffToAndroidWorker(id, next.title, files);
          // Leave a tracked 'downloading' row (NOT in the queue) so the worker's
          // progress survives app kill and reconcileQueue can finalize it on next
          // open. pageCount carries the TARGET total here (the worker is
          // DB-decoupled and writes only the SAF manifest); reconcile marks the
          // row 'complete' once the on-disk manifest covers all pages. The row's
          // queuePosition is cleared so it leaves listQueue() like the in-process
          // active item does.
          await upsertDownload({
            galleryId: id,
            title: next.title,
            thumbnail: next.thumbnail,
            tags: serializeTags(tags),
            pageCount: files.length,
            totalBytes: next.totalBytes ?? 0,
            downloadedAt: next.downloadedAt ?? new Date().toISOString(),
            status: 'downloading',
            folderName: galleryFolderName(id, next.title),
            queuePosition: null,
            lastError: null,
            retryCount: next.retryCount ?? null,
            nextRetryAt: null,
          });
          notifyDownloadLibraryChanged(true);
          // Surface a "downloading (background)" entry with a 0/total placeholder,
          // then start the in-app live-progress poller: while the app is
          // foreground it reads the worker's progress file (~1s) and advances this
          // entry's current/total in step with the notification. The poller stops
          // on completion (entry cleared) / hidden / no active download.
          storeApi?.setEntry(id, { progress: { current: 0, total: files.length }, error: null });
          startAndroidProgressPoll(id);
        } catch (e) {
          if (e instanceof DownloadCancelledError) {
            await DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
            await removeFromQueue(id);
            storeApi?.setEntry(id, null);
            storeApi?.markNotDownloaded(id);
            notifyDownloadLibraryChanged(true);
            continue;
          }
          console.error('Queue: failed to hand off to Android worker', id, e);
          const message =
            e instanceof Error && e.message ? e.message : 'Failed to start background download';
          await DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
          await setDownloadError(id, 'failed', message).catch(() => {});
          await removeFromQueue(id);
          storeApi?.markNotDownloaded(id);
          await scheduleFailureRetry(id, message);
          notifyDownloadLibraryChanged(true);
        } finally {
          fileCache.delete(id);
          storeApi?.refreshQueue();
        }
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

      // ── iOS background backstop (Task D) ──────────────────────────────────
      // iOS keeps the in-process downloader below (web/Tauri unchanged) but ALSO
      // persists a work-order + schedules a BGProcessingTask so a backgrounding
      // app can resume this gallery best-effort. Done BEFORE awaiting the
      // download so the work-order is already on disk if the user backgrounds
      // immediately. Never blocks/fails the foreground path (it swallows errors).
      if (isIos()) {
        await scheduleIosBackgroundBackstop(id, next.title, files);
      }

      try {
        const config = await getGgConfig();
        await downloadGalleryToLibrary(
          id,
          next.title,
          next.thumbnail,
          files,
          config,
          tags,
          (p) => {
            storeApi?.setEntry(id, { progress: p, error: null });
            notifyDownloadLibraryChanged();
          },
          controller.signal,
          { resume, isPauseSignal: () => pausing.has(id) },
        );
        // Success: item left the queue, mark downloaded, clear entry.
        await removeFromQueue(id);
        storeApi?.setEntry(id, null);
        storeApi?.markDownloaded(id);
        notifyDownloadLibraryChanged(true);
        // iOS (Task D): the foreground download finished, so drop the background
        // backstop work-order (and cancel the pending BGProcessingTask when no
        // other galleries remain) — there is nothing left for it to resume.
        if (isIos()) {
          void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
        }
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
          storeApi?.markNotDownloaded(id);
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
          // (manual retry only).
          await scheduleFailureRetry(id, message);
          storeApi?.markNotDownloaded(id);
          notifyDownloadLibraryChanged(true);
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
      if (onlyGalleryId !== undefined && id === onlyGalleryId) break;
    }
  } finally {
    running = false;
  }
  // A re-check guard: if an item was enqueued during the final loop teardown,
  // kick the processor again (running is now false, so this is safe).
  if (onlyGalleryId === undefined) {
    const pending = await dequeueNextQueued().catch(() => null);
    if (pending) void processQueue();
  }
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

  const markNotDownloaded = (id: number) =>
    set((s) => ({ downloaded: { ...s.downloaded, [id]: false } }));

  // Rebuild the reactive `queue`: the queued/paused rows from listQueue() merged
  // with active in-flight items (entries whose progress is non-null). listQueue()
  // is the source of truth for pending order; active items have already flipped
  // to 'downloading', so they are absent from listQueue and are prepended from
  // the live entries.
  const refreshQueue = async () => {
    let rows: Awaited<ReturnType<typeof listQueue>>;
    try {
      rows = await listQueue();
    } catch {
      // DB unavailable — leave the queue untouched rather than blanking the UI.
      return;
    }
    const entries = get().entries;
    const activeIds = Object.keys(entries)
      .map(Number)
      .filter((id) => entries[id]?.progress);

    const pending: QueueItem[] = rows.map((r) => ({
      id: r.galleryId,
      title: r.title,
      thumbnail: r.thumbnail,
      status: r.status === 'paused' ? 'paused' : 'queued',
      position: r.queuePosition ?? null,
      progress: null,
    }));

    const activeItems = await Promise.all(
      activeIds.map(async (id) => {
        const active = entries[id];
        // Active items flipped to 'downloading', so they are no longer in
        // listQueue(); read their rows directly for title/thumbnail metadata.
        const activeRow = await getDownload(id).catch(() => null);
        return {
          id,
          title: activeRow?.title ?? '',
          thumbnail: activeRow?.thumbnail ?? '',
          status: 'downloading' as const,
          position: null,
          progress: active?.progress ?? null,
        };
      }),
    );
    const activeIdSet = new Set(activeIds);
    const queue: QueueItem[] = [...activeItems, ...pending.filter((p) => !activeIdSet.has(p.id))];
    set({ queue });
  };

  // Bind the module-level processor to this store instance.
  storeApi = {
    setEntry,
    markDownloaded,
    markNotDownloaded,
    refreshQueue: () => void refreshQueue(),
    armAutoRetryTimer,
    hasEntry: (id: number) => get().entries[id] !== undefined,
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
        let isComplete = false;
        if (row?.status === 'complete') {
          isComplete =
            (row.pageCount ?? 0) > 0
              ? await hasCompleteDownloadedGallery(id, row.pageCount).catch(() => false)
              : true;
        }
        set((s) => ({ downloaded: { ...s.downloaded, [id]: isComplete } }));
        if (isComplete) {
          setEntry(id, null);
          notifyDownloadLibraryChanged(true);
          return;
        }
        if (
          isAndroid() &&
          row?.status === 'downloading' &&
          (row.pageCount ?? 0) > 0 &&
          !get().entries[id]?.progress
        ) {
          setEntry(id, { progress: { current: 0, total: row.pageCount }, error: null });
          startAndroidProgressPoll(id);
          void refreshQueue();
        }
      } catch {
        // DB unavailable: leave the flag untouched (treated as not-downloaded).
      }
    },
    start: async ({ id, title, thumbnail, files, tags = {} }) => {
      const existing = get().entries[id];
      // Already running/queued for this gallery, or nothing to download.
      if (existing?.progress || existing?.queued || files.length === 0) return;

      // Cache the supplied file list so the processor doesn't re-fetch the
      // detail. Exception: offline detail fallback can synthesize `files` from a
      // short local manifest. If the DB says a completed gallery should have
      // more pages, force a fresh detail resolve so "re-download missing files"
      // cannot turn a partial manifest into a smaller completed gallery.
      const existingRow = await getDownload(id).catch(() => null);
      if (
        !(
          existingRow?.status === 'complete' &&
          (existingRow.pageCount ?? 0) > 0 &&
          files.length < existingRow.pageCount
        )
      ) {
        fileCache.set(id, { files, tags });
      }

      try {
        // Manual tap = userInitiated → jump to the front of the queue (bypasses
        // the Wi-Fi gate, which only governs auto-resume/advance).
        const position = await enqueueDownload(
          { galleryId: id, title, thumbnail, tags },
          { userInitiated: true },
        );
        markNotDownloaded(id);
        setEntry(id, { progress: null, error: null, queued: true, position });
      } catch (e) {
        fileCache.delete(id);
        const message = e instanceof Error && e.message ? e.message : 'Failed to queue download';
        setEntry(id, { progress: null, error: message });
        return;
      }

      void refreshQueue();
      void processQueue({ onlyGalleryId: id });
    },
    cancel: (id) => {
      const controller = controllers.get(id);
      if (controller) {
        // Active run → genuine cancel (NOT a pause).
        controller.abort();
        // iOS (Task D): also drop the background backstop work-order so the
        // BGProcessingTask does not later resume a cancelled gallery (and cancels
        // the pending request when the handoff queue empties).
        if (isIos()) {
          void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
        }
      } else if (isAndroid() && get().entries[id]?.progress != null) {
        // Android: the gallery may have been handed off to the native worker
        // (no controller, not in the TS queue). Drop its work-order so the
        // worker skips it (and stops if the handoff queue empties).
        void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
        void setDownloadError(id, 'failed', 'Cancelled')
          .catch(() => {})
          .finally(() => notifyDownloadLibraryChanged(true));
        void removeFromQueue(id)
          .catch(() => {})
          .finally(() => void refreshQueue());
        fileCache.delete(id);
        markNotDownloaded(id);
        setEntry(id, null);
        // Stop this row's live-progress polling without silencing other active
        // Android handoffs.
        stopAndroidProgressPoll(id);
      } else {
        // Queued/paused but not yet started → drop it from the queue.
        if (isAndroid()) {
          void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
          stopAndroidProgressPoll(id);
        }
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
        // iOS background backstop must not resume a user-paused gallery while
        // the foreground row is intentionally held.
        if (isIos()) {
          void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
        }
      } else if (isAndroid() && get().entries[id]?.progress != null) {
        void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
        stopAndroidProgressPoll(id);
        await setDownloadError(id, 'paused', null).catch(() => {});
        setEntry(id, null);
        notifyDownloadLibraryChanged(true);
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
        if (isIos()) {
          void DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
        }
      }
      if (isAndroid()) {
        const activeIds = Object.entries(get().entries)
          .filter(([, entry]) => entry.progress != null)
          .map(([id]) => Number(id));
        for (const id of activeIds) {
          await DownloadWorker.cancel({ galleryId: String(id) }).catch(() => {});
          stopAndroidProgressPoll(id);
          await setDownloadError(id, 'paused', null).catch(() => {});
          setEntry(id, null);
        }
        if (activeIds.length > 0) notifyDownloadLibraryChanged(true);
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
