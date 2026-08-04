import { create } from 'zustand';
import { getGgConfig, ApiError } from '@/lib/api/client';
import {
  downloadGalleryToLibrary,
  getDownloadedGalleryPages,
  hasCompleteDownloadedGallery,
  DownloadPausedError,
  StaleDownloadRunError,
  type DownloadProgress,
} from '@/lib/utils/download-zip';
import { createDownloadStore, DownloadCancelledError } from '@/lib/storage/download-store';
import {
  getDownload,
  listDownloads,
  deserializeTags,
  setDownloadError,
  completeDownloadIfUnchanged,
  prepareNativeDownloadRun,
  adoptNativeRunIfUnchanged,
  adoptDiscoveredNativeRunIfUnchanged,
  transitionNativeDownloadRun,
  clearNativeRunIfMatches,
  clearNativeRunIfUnchanged,
  deleteDownloadIfNativeRunMatches,
} from '@/lib/db/download';
import { galleryFolderName } from '@/lib/storage/base-path-resolver';
import {
  enqueueDownload,
  dequeueNextQueued,
  removeFromQueue,
  listQueue,
  pauseQueued,
  resumeQueued,
  resumePausedNativeRun,
  reorderQueue,
  releaseDownloadClaim,
} from '@/lib/db/download-queue';
import {
  AUTO_RETRY_BACKOFF_MS,
  AUTO_RETRY_MAX,
  scheduleAutoRetry,
  listDueAutoRetries,
  earliestNextRetryAt,
  requeueDueAutoRetry,
  requeueInterruptedDownload,
  retryDownloadIfUnchanged,
  retryDownloadIfAbsent,
  redownloadCompleteIfUnchanged,
} from '@/lib/db/download-retry';
import { isUnmeteredNetwork } from '@/lib/utils/network';
import { isAndroid, isIos } from '@/lib/utils/platform';
import { buildWorkOrder, buildIosWorkOrder, createDownloadRunId } from '@/lib/utils/work-order';
import { DownloadWorker, isNativeRunLookupUncertain } from '@/lib/plugins/downloadWorker';
import { useSettingsStore } from '@/lib/store/settings';
import { getDeleteClaimGeneration, useZipExportStore } from '@/lib/store/zip-export';
import { resolveGalleryDetail } from '@/features/gallery-detail/hooks/useGalleryDetail';
import type { GalleryFile } from '@/lib/utils/types';
import type { DBDownload, DownloadStatus } from '@/lib/db/schema';

interface DownloadEntry {
  progress: DownloadProgress | null;
  error: string | null;
  /** Best-effort gallery metadata used while composing the live queue row. */
  title?: string;
  thumbnail?: string;
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
  /** Stop the exact active/native run. False means deletion must fail closed. */
  cancel: (id: number) => Promise<boolean>;
  /** Retry one exact failed snapshot without overwriting a newer lifecycle. */
  retryFailed: (expected: DBDownload) => Promise<boolean>;
  /** Requeue one exact complete-but-incomplete-on-disk snapshot. */
  retryMissing: (expected: DBDownload) => Promise<boolean>;
  /** Load the persisted download status for a gallery from the DB into the store. */
  refreshDownloaded: (id: number) => Promise<void>;
  /** Re-read listQueue() + the active entry and publish the reactive `queue`. */
  refreshQueue: () => Promise<void>;
  /** Pause one item: active → pausing+abort (download-zip writes 'paused');
   *  queued → pauseQueued. Paused items stay in the queue at their position. */
  /** False means a native/background owner could not be proven stopped. */
  pause: (id: number) => Promise<boolean>;
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
const controllerSettled = new Map<number, Promise<void>>();
const settleController = new Map<number, () => void>();
// iOS foreground runs share an identity with their native background backstop.
// Keep that identity synchronously reachable by cancel/pause so user intent can
// claim the exact DB row before aborting a final in-flight completion commit.
const foregroundNativeRunIds = new Map<number, string>();

function trackControllerRun(id: number): void {
  controllerSettled.set(
    id,
    new Promise<void>((resolve) => {
      settleController.set(id, resolve);
    }),
  );
}

function finishControllerRun(id: number): void {
  settleController.get(id)?.();
  settleController.delete(id);
  controllerSettled.delete(id);
}

// Galleries whose active controller was aborted as a PAUSE (not a cancel). The
// download-zip catch reads this via opts.isPauseSignal so it writes 'paused'.
const pausing = new Set<number>();

// Claimed rows have status 'downloading' before a controller/native worker
// exists. These sets let cancel/pause requests made during that preparation
// window stop the processor deterministically, independent of async DB timing.
const cancellingClaimed = new Set<number>();
const pausingClaimed = new Set<number>();
// A cancel/pause can begin while dequeue is still selecting a candidate, before
// `claimedGalleryId` or a controller exists. Keep that user intent alive across
// every await in the action so the processor cannot slip through the preparation
// gap. Tokens make overlapping calls for the same gallery safe: an older action
// cannot clear a newer one's intent in its finally block.
const cancellingActions = new Map<number, number>();
const pausingActions = new Map<number, number>();
let nextQueueActionIntent = 0;

function beginQueueAction(map: Map<number, number>, id: number): number {
  const token = ++nextQueueActionIntent;
  map.set(id, token);
  return token;
}

function finishQueueAction(map: Map<number, number>, id: number, token: number): void {
  if (map.get(id) === token) map.delete(id);
}
// The queue processor is single-flight, so at most one row can be in the gap
// after the DB claim and before a controller/native handoff becomes visible.
// Track that phase explicitly instead of inferring it from `entry.queued`, which
// is also true for ordinary pending rows.
let claimedGalleryId: number | null = null;

// File lists are not stored on the download row; cache the ones supplied by a
// manual start so the processor can drive that gallery without re-fetching the
// detail. Resume/auto paths fall back to resolveGalleryDetail.
const fileCache = new Map<number, { files: GalleryFile[]; tags: Record<string, string[]> }>();
// A delete's cancel barrier waits for an enqueue already in progress. This
// prevents a late enqueue upsert from recreating a row after physical deletion.
const queueMutationSettled = new Map<number, Promise<void>>();

export interface DownloadLifecycleReconciliationReservation {
  isCurrent: () => boolean;
  release: () => void;
}

/**
 * Reserve one gallery's DB/native reconciliation against user queue actions.
 * The check and publication are synchronous, so either an already-published
 * cancel/pause wins, or that action waits for this reservation and then applies
 * its intent to the reconciled row.
 */
export function tryBeginDownloadLifecycleReconciliation(
  id: number,
): DownloadLifecycleReconciliationReservation | null {
  if (isLiveDownloadLifecycle(id)) return null;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  queueMutationSettled.set(id, settled);
  let released = false;
  return {
    isCurrent: () => !released && queueMutationSettled.get(id) === settled,
    release: () => {
      if (released) return;
      released = true;
      if (queueMutationSettled.get(id) === settled) queueMutationSettled.delete(id);
      settle();
    },
  };
}
// Android handoff publishes a native work-order asynchronously. cancel() must
// not accept "no current run" until that publisher has either finished or
// failed, otherwise a late work-order can appear after deletion proceeds.
const nativeHandoffSettled = new Map<number, Promise<void>>();

async function awaitQueueMutationBarrier(id: number): Promise<void> {
  // A reservation can be replaced immediately after it settles (for example,
  // reconcile followed by a queued retry). Wait until the gallery truly has no
  // published mutation owner instead of observing only the first promise.
  for (;;) {
    const pending = queueMutationSettled.get(id);
    if (!pending) return;
    await pending;
  }
}

// Synchronous single-flight guard for the processor loop. Never inferred from an
// async DB read — that would be a read-then-write race (PLAN decision 6).
let running = false;
const pendingManualKicks = new Set<number>();
// A generic kick can arrive while a manual `onlyGalleryId` run owns the
// single-flight guard. Remember it separately so the manual run cannot strand
// unrelated queued work when it exits.
let pendingGeneralKick = false;
let refreshQueueRunSeq = 0;

function isGalleryDeleting(id: number): boolean {
  return useZipExportStore.getState().deletingGalleryIds.has(id);
}

function deletionChanged(id: number, generation: number): boolean {
  return isGalleryDeleting(id) || getDeleteClaimGeneration(id) !== generation;
}

/**
 * True while this renderer owns or is publishing a gallery lifecycle.
 * Launch/focus reconciliation must not mistake these rows for crash zombies.
 */
export function isLiveDownloadLifecycle(id: number): boolean {
  return (
    isGalleryDeleting(id) ||
    cancellingActions.has(id) ||
    pausingActions.has(id) ||
    controllers.has(id) ||
    claimedGalleryId === id ||
    nativeHandoffSettled.has(id) ||
    queueMutationSettled.has(id) ||
    foregroundNativeRunIds.has(id) ||
    Boolean(storeApi?.hasLiveEntry(id))
  );
}

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
  /** Remove only an unchanged retry-pending entry, never newer live progress. */
  clearRetryPendingEntry: (
    id: number,
    expectedRetryAt: string | null | undefined,
    expectedAttempt: number | null | undefined,
  ) => void;
  /** True iff a store entry exists for `id` (the Android poller's stop signal). */
  hasEntry: (id: number) => boolean;
  /** True iff a renderer-owned foreground/native lifecycle is visibly active. */
  hasLiveEntry: (id: number) => boolean;
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
      const scheduled = await scheduleAutoRetry(failedRow, attempt, retryAt);
      if (!scheduled) throw new Error('Download row changed before retry scheduling');
      storeApi?.setEntry(id, {
        ...entry,
        error: message,
        retryAt,
        attempt,
        queued: false,
        position: null,
      });
      storeApi?.refreshQueue();
      storeApi?.armAutoRetryTimer();
      return;
    } catch {
      // Fall through to a plain failed entry if retry persistence fails.
    }
  }
  storeApi?.setEntry(id, { ...entry, error: message, queued: false, position: null });
  storeApi?.refreshQueue();
}

async function failClaimedRun(
  id: number,
  nativeRunId: string | null,
  message: string,
): Promise<boolean> {
  if (nativeRunId) {
    const failed = await transitionNativeDownloadRun(id, nativeRunId, 'failed', message, {
      clearRunId: false,
    }).catch(() => false);
    if (!failed) return false;
  } else {
    await setDownloadError(id, 'failed', message);
  }
  if (!nativeRunId) await removeFromQueue(id).catch(() => {});
  await scheduleFailureRetry(id, message);
  if (nativeRunId) {
    const cleared = await clearNativeRunIfMatches(id, nativeRunId).catch(() => false);
    // earliestNextRetryAt intentionally excludes native-owned rows. Re-arm
    // after the exact stop token has been cleared so this retry is discoverable.
    if (cleared) armAutoRetryTimer();
  }
  return true;
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

export type DueRetryRequeueResult = 'requeued' | 'stale' | 'held';

/**
 * Move one exact due snapshot back to the queue while sharing the same
 * per-gallery mutation/deletion barrier as manual retry and start. Both the
 * timer and launch reconciliation use this function so neither can resurrect a
 * row while its physical deletion is in progress.
 */
export async function requeueDueRetryWithLifecycleBarrier(
  row: DBDownload,
): Promise<DueRetryRequeueResult> {
  const id = row.galleryId;
  const deleteGeneration = getDeleteClaimGeneration(id);
  if (isGalleryDeleting(id)) return 'held';

  const pendingMutation = queueMutationSettled.get(id);
  if (pendingMutation) await pendingMutation;
  if (deletionChanged(id, deleteGeneration) || isLiveDownloadLifecycle(id)) return 'held';

  let settleDueRetry!: () => void;
  const dueRetrySettled = new Promise<void>((resolve) => {
    settleDueRetry = resolve;
  });
  queueMutationSettled.set(id, dueRetrySettled);
  try {
    if (deletionChanged(id, deleteGeneration)) return 'held';
    if (!(await requeueDueAutoRetry(row))) return 'stale';
    if (deletionChanged(id, deleteGeneration)) {
      // The deletion owner waits for this barrier, then removes the queued row.
      return 'held';
    }
    return 'requeued';
  } finally {
    if (queueMutationSettled.get(id) === dueRetrySettled) queueMutationSettled.delete(id);
    settleDueRetry();
  }
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
  if (globalPaused) {
    await rearmAutoRetryTimerAfterMeteredHold();
    return;
  }
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
  let requeued = 0;
  let heldByLifecycle = false;
  for (const row of due) {
    try {
      const result = await requeueDueRetryWithLifecycleBarrier(row);
      if (result === 'held') {
        heldByLifecycle = true;
        continue;
      }
      if (result !== 'requeued') continue;
      requeued++;
      // The row left 'failed' for 'queued'. Clear only the retry annotation that
      // belongs to that lifecycle; an already-claimed run may have published
      // newer live progress while the persistence call was awaiting.
      storeApi?.clearRetryPendingEntry(row.galleryId, row.nextRetryAt, row.retryCount);
    } catch (e) {
      console.warn('[auto-retry] requeue failed:', row.galleryId, e);
      const holdUntil = new Date(Date.now() + METERED_AUTO_RETRY_RECHECK_MS).toISOString();
      await scheduleAutoRetry(row, row.retryCount ?? 0, holdUntil).catch(() => {});
    }
  }
  if (requeued > 0) {
    storeApi?.refreshQueue();
    void processQueue();
  }

  // Any rows that were not due yet still need a timer.
  if (heldByLifecycle) {
    await rearmAutoRetryTimerAfterMeteredHold();
  } else {
    armAutoRetryTimer();
  }
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
  window.dispatchEvent(
    new CustomEvent(DOWNLOAD_LIBRARY_CHANGED_EVENT, {
      detail: { structural: force },
    }),
  );
}

let progressPollTimer: ReturnType<typeof setInterval> | null = null;
// Gallery ids currently driven by the Android progress poller. WorkManager runs
// galleries sequentially, but multiple rows can be handed off quickly; polling
// all active ids avoids locking the in-app % display onto the last handed-off id.
const progressPollGalleryIds = new Set<number>();
// PublicLibrary serializes native IO. Do not let a slow completion check for one
// gallery enqueue another copy of itself on every one-second timer tick. A
// gallery can also be cancelled and restarted while an old bridge call is still
// pending, so ownership is generation-specific rather than keyed by id alone.
const progressPollGenerations = new Map<number, number>();
const progressPollRunIds = new Map<number, string>();
const progressPollInFlightGenerations = new Map<number, number>();
let nextProgressPollGeneration = 0;
const missingProgressAfterStartCount = new Map<number, number>();
// A fresh JS session cannot know whether a persisted Android `downloading` row
// had already made progress before the WebView was recreated. Track those rows
// so, after a grace period, native identity is checked explicitly. A matching
// order is still pending (WorkManager may be waiting for CONNECTED), while only
// confirmed native absence may be treated as a stopped worker.
const rehydratedAndroidPollIds = new Set<number>();
const MISSING_PROGRESS_FAILURE_GRACE_TICKS = 3;
const REHYDRATED_MISSING_PROGRESS_FAILURE_GRACE_TICKS = 15;
const nativeFinalizationRuns = new Map<string, Promise<boolean>>();

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
 * two use ONE completion rule and cannot drift. A native-owned 'downloading' or
 * app-marked genuine-failure row whose manifest lists exactly its recorded
 * `pageCount` pages is marked 'complete'. A native run token is not merely a
 * progress label: it is a live writer lease, so completion first proves that
 * exact worker stopped and only then clears the token in the DB commit.
 * Returns true iff the row is 'complete' after the call. May throw on DB/store
 * IO — callers decide whether that is fatal (reconcile) or retried next tick
 * (poller).
 */
export async function finalizeDownloadIfComplete(
  galleryId: number,
  isCurrent: () => boolean = () => true,
  expected?: { nativeRunId: string | null; snapshot?: DBDownload },
): Promise<boolean> {
  if (!isCurrent()) return false;
  const current = expected?.snapshot ?? (await getDownload(galleryId));
  if (!isCurrent()) return false;
  if (!current) return false;
  if (expected && (current.nativeRunId ?? null) !== expected.nativeRunId) return false;
  if (current.status === 'complete') {
    const completeRunId = current.nativeRunId ?? null;
    if (!completeRunId) return true;
    const cancelled = await DownloadWorker.cancel({
      galleryId: String(galleryId),
      runId: completeRunId,
    }).catch(() => null);
    if (!(await confirmNativeRunStopped(galleryId, completeRunId, cancelled))) return false;
    return clearNativeRunIfUnchanged(current).catch(() => false);
  }
  // Both native and foreground user-cancel paths persist a failed row without
  // a retryable error (historically either null or the literal marker). A late
  // manifest must not resurrect that terminal user intent as complete.
  if (
    current.status === 'failed' &&
    (current.lastError == null || current.lastError === 'Cancelled')
  ) {
    return false;
  }
  if (
    (current.status !== 'downloading' &&
      current.status !== 'failed' &&
      current.status !== 'queued') ||
    (current.pageCount ?? 0) <= 0
  ) {
    return false;
  }
  const lookup = { folderName: current.folderName ?? null };
  if (await hasCompleteDownloadedGallery(galleryId, current.pageCount, lookup)) {
    if (!isCurrent()) return false;
    const pages = await getDownloadedGalleryPages(galleryId, lookup);
    if (!isCurrent()) return false;
    const nativeRunId = current.nativeRunId ?? null;
    if (nativeRunId) {
      const cancelled = await DownloadWorker.cancel({
        galleryId: String(galleryId),
        runId: nativeRunId,
      }).catch(() => null);
      if (!(await confirmNativeRunStopped(galleryId, nativeRunId, cancelled))) return false;
      if (!isCurrent()) return false;
    }
    const committed = await completeDownloadIfUnchanged(
      current,
      pages.length,
      isAndroid() ? new Date().toISOString() : current.migratedAt,
    );
    return committed && isCurrent();
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
async function runNativeFinalization(
  id: number,
  isCurrent: () => boolean,
  expected?: { nativeRunId: string | null; snapshot?: DBDownload },
): Promise<boolean> {
  let done = false;
  try {
    done = await finalizeDownloadIfComplete(id, isCurrent, expected);
  } catch {
    return false; // transient IO — re-checked on the next tick
  }
  if (!done || !isCurrent()) return false;
  storeApi?.setEntry(id, null);
  storeApi?.markDownloaded(id);
  storeApi?.refreshQueue();
  notifyDownloadLibraryChanged(true);
  stopAndroidProgressPoll(id, expected?.nativeRunId ?? undefined);
  return true;
}

export async function finalizeNativeDownloadIfComplete(
  id: number,
  options: { generation?: number; runId?: string; snapshot?: DBDownload } = {},
): Promise<boolean> {
  const generation = options.generation;
  const runId = options.runId;
  const key = `${id}:${generation ?? 'manual'}:${runId ?? 'unscoped'}`;
  const isCurrent =
    generation === undefined || runId === undefined
      ? () => true
      : () => isCurrentProgressPoll(id, generation, runId);
  const existing = nativeFinalizationRuns.get(key);
  if (existing) return existing;

  const run = runNativeFinalization(
    id,
    isCurrent,
    runId === undefined ? undefined : { nativeRunId: runId, snapshot: options.snapshot },
  );
  nativeFinalizationRuns.set(key, run);
  try {
    return await run;
  } finally {
    if (nativeFinalizationRuns.get(key) === run) nativeFinalizationRuns.delete(key);
  }
}

async function finalizeAndroidDownloadIfComplete(
  id: number,
  generation = progressPollGenerations.get(id),
  runId = progressPollRunIds.get(id),
): Promise<boolean> {
  return finalizeNativeDownloadIfComplete(id, { generation, runId });
}

async function failAndroidDownloadIfWorkerStopped(
  id: number,
  message: string,
  generation: number,
  runId: string,
  nativeAlreadyStopped = false,
): Promise<void> {
  const isCurrent = () => isCurrentProgressPoll(id, generation, runId);
  if (!isCurrent()) return;
  const cancelled = await DownloadWorker.cancel({ galleryId: String(id), runId }).catch(() => null);
  if (cancelled?.stale || (cancelled && cancelled.runId !== runId)) return;
  const cancellationConfirmed = exactNativeCancellationConfirmed(cancelled, runId);
  const workerStopped =
    cancellationConfirmed || (await confirmNativeRunStopped(id, runId, cancelled));
  if (!nativeAlreadyStopped && !workerStopped) return;
  // A terminal sentinel can race the worker's final manifest commit/order
  // cleanup. Once absence is proven, prefer the shared completion rule before
  // publishing a failed row and scheduling another attempt.
  if (workerStopped && (await finalizeAndroidDownloadIfComplete(id, generation, runId))) return;
  if (!isCurrent()) return;
  const failed = await transitionNativeDownloadRun(id, runId, 'failed', message, {
    clearRunId: false,
  }).catch(() => false);
  if (!failed) return;
  if (!isCurrent()) return;
  if (workerStopped) {
    await scheduleFailureRetry(id, message);
    const cleared = await clearNativeRunIfMatches(id, runId).catch(() => false);
    if (cleared) armAutoRetryTimer();
  } else {
    const entry = useDownloadProgressStore.getState().entries[id];
    storeApi?.setEntry(id, {
      ...entry,
      progress: entry?.progress ?? null,
      error: message,
      queued: false,
      position: null,
    });
  }
  if (!isCurrent()) return;
  storeApi?.markNotDownloaded(id);
  storeApi?.refreshQueue();
  notifyDownloadLibraryChanged(true);
  stopAndroidProgressPoll(id, runId);
}

async function finalizeSpecificNativeRun(row: DBDownload): Promise<boolean> {
  const runId = row.nativeRunId;
  if (!runId) return false;
  return finalizeNativeDownloadIfComplete(row.galleryId, { runId, snapshot: row });
}

async function pauseAndroidNativeRun(row: DBDownload): Promise<boolean> {
  const runId = row.nativeRunId;
  if (!runId) return false;
  if (await finalizeSpecificNativeRun(row)) return true;
  const result = await cancelAndroidNativeWork(row.galleryId, runId);
  if (!(await confirmNativeRunStopped(row.galleryId, runId, result))) return false;
  if (await finalizeSpecificNativeRun(row)) return true;
  const paused = await transitionNativeDownloadRun(row.galleryId, runId, 'paused', null, {
    clearQueuePosition: false,
    ensureQueuePosition: true,
  });
  if (paused) stopAndroidProgressPoll(row.galleryId, runId);
  return paused;
}

async function claimedRunWasStopped(id: number, nativeRunId: string | null): Promise<boolean> {
  let row: Awaited<ReturnType<typeof getDownload>>;
  try {
    row = await getDownload(id);
  } catch {
    // The claim exists but its verification read failed. Release only a still-
    // preparing claim so a transient DB fault cannot orphan it as downloading.
    const releaseStatus =
      globalPaused || pausingClaimed.has(id) || pausingActions.has(id) ? 'paused' : 'queued';
    await releaseDownloadClaim(id, releaseStatus, nativeRunId).catch(() => {});
    return true;
  }
  return (
    globalPaused ||
    cancellingClaimed.has(id) ||
    pausingClaimed.has(id) ||
    cancellingActions.has(id) ||
    pausingActions.has(id) ||
    row?.status !== 'downloading' ||
    (row.nativeRunId ?? null) !== nativeRunId
  );
}

function clearClaimState(id: number): void {
  if (claimedGalleryId === id) claimedGalleryId = null;
  cancellingClaimed.delete(id);
  pausingClaimed.delete(id);
}

function clearStoppedClaimedRun(id: number): void {
  clearClaimState(id);
  fileCache.delete(id);
  storeApi?.setEntry(id, null);
  storeApi?.refreshQueue();
}

/** Release a pre-handoff DB claim while a physical deletion owns the gallery. */
async function releaseClaimBlockedByDelete(
  id: number,
  nativeRunId: string | null,
): Promise<boolean> {
  if (!isGalleryDeleting(id)) return false;
  await releaseDownloadClaim(id, 'queued', nativeRunId).catch(() => false);
  clearStoppedClaimedRun(id);
  return true;
}

async function cancelAndroidNativeWork(
  id: number,
  runId: string,
): Promise<Awaited<ReturnType<typeof DownloadWorker.cancel>> | null> {
  try {
    return await DownloadWorker.cancel({ galleryId: String(id), runId });
  } catch (e) {
    console.warn('[download] failed to cancel Android native work', id, e);
    return null;
  }
}

function exactNativeCancellationConfirmed(
  result: Awaited<ReturnType<typeof DownloadWorker.cancel>> | null,
  runId: string,
): boolean {
  return Boolean(result?.cancelled && !result.stale && result.runId === runId);
}

export async function confirmNativeRunStopped(
  galleryId: number,
  runId: string,
  result: Awaited<ReturnType<typeof DownloadWorker.cancel>> | null,
): Promise<boolean> {
  if (exactNativeCancellationConfirmed(result, runId)) return true;
  if (result?.stale || (result && result.runId !== runId)) return false;
  try {
    const current = await DownloadWorker.getCurrentRun({ galleryId: String(galleryId) });
    return (
      !isNativeRunLookupUncertain(current) && current.legacy !== true && current.runId === null
    );
  } catch {
    return false;
  }
}

async function resumePausedDownloadRow(row: DBDownload): Promise<boolean> {
  const runId = row.nativeRunId ?? null;
  if (!runId) return resumeQueued(row.galleryId);
  const cancelled = await DownloadWorker.cancel({
    galleryId: String(row.galleryId),
    runId,
  }).catch(() => null);
  if (!(await confirmNativeRunStopped(row.galleryId, runId, cancelled))) return false;
  return resumePausedNativeRun(row.galleryId, runId);
}

/** One poll tick: read the worker's progress file and push it into the store. */
function isCurrentProgressPoll(id: number, generation: number, runId: string): boolean {
  return (
    progressPollGalleryIds.has(id) &&
    progressPollGenerations.get(id) === generation &&
    progressPollRunIds.get(id) === runId
  );
}

async function pollAndroidProgressOnce(
  id: number,
  generation: number,
  runId: string,
): Promise<void> {
  // In-flight dedup is owned by scheduleAndroidProgressPoll; this tick just does
  // the work. (Called directly only by tests.)
  if (!isCurrentProgressPoll(id, generation, runId)) return;
  try {
    // The gallery is done/cancelled when its store entry is gone — stop polling.
    if (storeApi === null || !storeApi.hasEntry(id)) {
      if (isCurrentProgressPoll(id, generation, runId)) stopAndroidProgressPoll(id, runId);
      return;
    }
    let res: Awaited<ReturnType<typeof DownloadWorker.getProgress>> | null;
    try {
      res = await DownloadWorker.getProgress({ galleryId: String(id), runId });
    } catch {
      // The bridge can reject even though native work completed. Reconcile from
      // the authoritative manifest so the last visible progress cannot stick.
      if (isCurrentProgressPoll(id, generation, runId)) {
        await finalizeAndroidDownloadIfComplete(id, generation, runId);
      }
      return;
    }
    // A still-active poller may have been stopped for this id while we awaited.
    if (!isCurrentProgressPoll(id, generation, runId)) return;
    if (!res || res.runId !== runId || res.stale) {
      if (isCurrentProgressPoll(id, generation, runId)) stopAndroidProgressPoll(id, runId);
      return;
    }
    if (res && 'error' in res && res.error) {
      await failAndroidDownloadIfWorkerStopped(id, res.error, generation, runId, true);
      return;
    }
    if (res && typeof (res as { current: number | null }).current === 'number') {
      const { current, total } = res as { current: number; total: number };
      missingProgressAfterStartCount.delete(id);
      rehydratedAndroidPollIds.delete(id);
      storeApi?.setEntry(id, {
        progress: { current, total },
        error: null,
        queued: false,
        position: null,
      });
      storeApi?.refreshQueue();
      // Worker reported every page done — confirm via the manifest and finalize
      // the row in-app so it leaves "downloading" without waiting for a relaunch.
      if (total > 0 && current >= total) {
        await finalizeAndroidDownloadIfComplete(id, generation, runId);
      }
      return;
    }
    // current === null → no progress file: the worker has not started yet, failed,
    // or completed (it deletes the file when done). Disambiguate via the on-disk
    // manifest first. If the manifest is still incomplete after we had observed
    // native progress, treat it as a stopped/failed worker instead of leaving the
    // row stuck as "downloading" until next app launch.
    if (await finalizeAndroidDownloadIfComplete(id, generation, runId)) return;
    if (!isCurrentProgressPoll(id, generation, runId)) return;
    const lastProgress = useDownloadProgressStore.getState().entries[id]?.progress;
    const rehydrated = rehydratedAndroidPollIds.has(id);
    if (lastProgress && (lastProgress.current > 0 || rehydrated)) {
      const missingCount = (missingProgressAfterStartCount.get(id) ?? 0) + 1;
      missingProgressAfterStartCount.set(id, missingCount);
      const graceTicks = rehydrated
        ? REHYDRATED_MISSING_PROGRESS_FAILURE_GRACE_TICKS
        : MISSING_PROGRESS_FAILURE_GRACE_TICKS;
      if (missingCount >= graceTicks) {
        if (rehydrated) {
          let currentNativeRun: Awaited<ReturnType<typeof DownloadWorker.getCurrentRun>>;
          try {
            currentNativeRun = await DownloadWorker.getCurrentRun({ galleryId: String(id) });
          } catch {
            return;
          }
          if (!isCurrentProgressPoll(id, generation, runId)) return;
          if (isNativeRunLookupUncertain(currentNativeRun) || currentNativeRun.legacy === true) {
            // Corrupt/torn native identity is not absence. Keep the DB ownership
            // token and retry discovery later instead of crossing a lifecycle
            // barrier on a guess. A legacy order is validated but belongs to a
            // pre-runId lifecycle, not proof that this token stopped.
            missingProgressAfterStartCount.set(id, 0);
            return;
          }
          if (currentNativeRun.runId === runId) {
            // The exact work order is still pending. WorkManager can remain here
            // indefinitely while its CONNECTED constraint is unmet.
            missingProgressAfterStartCount.set(id, 0);
            return;
          }
          if (currentNativeRun.runId !== null) {
            // A replacement owns native state. The old poll must not cancel or
            // mutate either generation.
            stopAndroidProgressPoll(id, runId);
            return;
          }
        }
        await failAndroidDownloadIfWorkerStopped(
          id,
          'Background download stopped before completion',
          generation,
          runId,
        );
      }
    }
  } finally {
    if (progressPollInFlightGenerations.get(id) === generation) {
      progressPollInFlightGenerations.delete(id);
    }
  }
}

function scheduleAndroidProgressPoll(id: number): void {
  const generation = progressPollGenerations.get(id);
  const runId = progressPollRunIds.get(id);
  if (generation === undefined || runId === undefined || !progressPollGalleryIds.has(id)) return;
  if (progressPollInFlightGenerations.get(id) === generation) return;
  progressPollInFlightGenerations.set(id, generation);
  void pollAndroidProgressOnce(id, generation, runId).finally(() => {
    if (progressPollInFlightGenerations.get(id) === generation) {
      progressPollInFlightGenerations.delete(id);
    }
  });
}

/**
 * Start polling the Android worker's live progress for `id`. Idempotent for the
 * same id; retargets (clear + rearm) for a different id. No-op off Android, when
 * the document is hidden, or with no DOM. Called from the Android handoff branch.
 */
export function startAndroidProgressPoll(
  id: number,
  options: { runId: string; rehydrated?: boolean },
): void {
  if (!isAndroid()) return;
  if (!progressPollGalleryIds.has(id) || progressPollRunIds.get(id) !== options.runId) {
    progressPollGenerations.set(id, ++nextProgressPollGeneration);
    progressPollInFlightGenerations.delete(id);
    missingProgressAfterStartCount.delete(id);
  }
  progressPollRunIds.set(id, options.runId);
  progressPollGalleryIds.add(id);
  if (options.rehydrated) rehydratedAndroidPollIds.add(id);
  // Don't poll while backgrounded (the notification carries progress there); the
  // visibilitychange listener resumes it on foreground.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    clearProgressPollTimer();
    return;
  }
  // Immediate first read so the card leaves 0/total without waiting a full tick.
  scheduleAndroidProgressPoll(id);
  if (progressPollTimer !== null) return;
  progressPollTimer = setInterval(() => {
    if (progressPollGalleryIds.size === 0) {
      clearProgressPollTimer();
      return;
    }
    for (const galleryId of [...progressPollGalleryIds]) {
      scheduleAndroidProgressPoll(galleryId);
    }
  }, PROGRESS_POLL_INTERVAL_MS);
}

/**
 * Stop polling one gallery, or clear the whole poller when no id is supplied
 * (test/reset path). Completion/cancel of one Android row must not silence other
 * active rows.
 */
export function stopAndroidProgressPoll(id?: number, expectedRunId?: string): void {
  if (id === undefined) {
    progressPollGalleryIds.clear();
    progressPollGenerations.clear();
    progressPollRunIds.clear();
    progressPollInFlightGenerations.clear();
    missingProgressAfterStartCount.clear();
    rehydratedAndroidPollIds.clear();
  } else {
    if (expectedRunId !== undefined && progressPollRunIds.get(id) !== expectedRunId) return;
    progressPollGalleryIds.delete(id);
    progressPollGenerations.delete(id);
    progressPollRunIds.delete(id);
    progressPollInFlightGenerations.delete(id);
    missingProgressAfterStartCount.delete(id);
    rehydratedAndroidPollIds.delete(id);
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
          const runId = progressPollRunIds.get(id);
          if (runId) startAndroidProgressPoll(id, { runId });
        } else {
          stopAndroidProgressPoll(id);
        }
      }
      if (progressPollGalleryIds.size > 0 && progressPollTimer === null) {
        for (const id of [...progressPollGalleryIds]) {
          scheduleAndroidProgressPoll(id);
        }
        progressPollTimer = setInterval(() => {
          if (progressPollGalleryIds.size === 0) {
            clearProgressPollTimer();
            return;
          }
          for (const galleryId of [...progressPollGalleryIds]) {
            scheduleAndroidProgressPoll(galleryId);
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
  runId: string,
  queuePosition?: number | null,
): Promise<string> {
  const config = await getGgConfig();
  const order = buildWorkOrder(id, title, files, config, runId);
  order.locale = useSettingsStore.getState().locale;
  order.queuePosition = queuePosition ?? null;
  const galleryId = String(id);
  await DownloadWorker.writeWorkOrder({ galleryId, runId, json: JSON.stringify(order) });
  await DownloadWorker.enqueue({ galleryId, runId });
  return runId;
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
  expectedRow: DBDownload,
  id: number,
  title: string,
  files: GalleryFile[],
  queuePosition?: number | null,
  signal?: AbortSignal,
): Promise<string | null> {
  let runId: string | null = null;
  try {
    if (signal?.aborted) return null;
    const config = await getGgConfig();
    if (signal?.aborted) return null;
    const order = buildIosWorkOrder(id, title, files, config);
    runId = order.runId;
    order.queuePosition = queuePosition ?? null;
    const galleryId = String(id);
    if (!(await adoptNativeRunIfUnchanged(expectedRow, runId))) return null;
    if (
      !(await prepareNativeDownloadRun(id, runId, {
        pageCount: files.length,
        totalBytes: expectedRow.totalBytes ?? 0,
        folderName: String(id),
      }))
    ) {
      await clearNativeRunIfMatches(id, runId).catch(() => {});
      return null;
    }
    await DownloadWorker.writeWorkOrder({ galleryId, runId, json: JSON.stringify(order) });
    if (signal?.aborted) {
      const cancelled = await DownloadWorker.cancel({ galleryId, runId }).catch(() => null);
      if (exactNativeCancellationConfirmed(cancelled, runId)) {
        await clearNativeRunIfMatches(id, runId).catch(() => {});
        return null;
      }
      return runId;
    }
    await DownloadWorker.enqueue({ galleryId, runId });
    if (signal?.aborted) {
      const cancelled = await DownloadWorker.cancel({ galleryId, runId }).catch(() => null);
      if (exactNativeCancellationConfirmed(cancelled, runId)) {
        await clearNativeRunIfMatches(id, runId).catch(() => {});
        return null;
      }
      return runId;
    }
    return runId;
  } catch (e) {
    if (runId) {
      const cancelled = await DownloadWorker.cancel({ galleryId: String(id), runId }).catch(
        () => null,
      );
      if (exactNativeCancellationConfirmed(cancelled, runId)) {
        await clearNativeRunIfMatches(id, runId).catch(() => {});
        runId = null;
      }
    }
    // Backstop only — the in-process foreground download is the primary path.
    console.warn('[ios-bg] failed to schedule background backstop', id, e);
    return runId;
  }
}

/**
 * Drive the queue sequentially. Synchronous `running` guard ensures only one
 * active download at a time. After each item completes/fails/pauses, re-checks
 * for the next 'queued' item and continues until the queue is empty.
 */
export async function processQueue(options: { onlyGalleryId?: number } = {}): Promise<void> {
  const onlyGalleryId = options.onlyGalleryId;
  // Do not turn a delete-owned gallery into a pending kick. DownloadsView
  // explicitly restarts the general processor after releasing the claim.
  if (onlyGalleryId !== undefined && isGalleryDeleting(onlyGalleryId)) return;
  if (running) {
    if (onlyGalleryId !== undefined) pendingManualKicks.add(onlyGalleryId);
    else pendingGeneralKick = true;
    return;
  }
  if (onlyGalleryId === undefined) pendingGeneralKick = false;
  running = true;
  let dequeueFailed = false;
  let blockedByDeletion = false;
  const dequeue = async () => {
    let candidateId: number | null = null;
    const nativeRunId = isAndroid() ? createDownloadRunId() : null;
    try {
      const row = await dequeueNextQueued(
        onlyGalleryId,
        (id) => {
          candidateId = id;
          claimedGalleryId = id;
        },
        nativeRunId,
      );
      if (!row && candidateId !== null) clearClaimState(candidateId);
      return row;
    } catch (error) {
      if (candidateId !== null) clearClaimState(candidateId);
      dequeueFailed = true;
      console.warn('[download] failed to claim queued item', error);
      return null;
    }
  };
  try {
    // Honour a global pause before dequeuing the first item, too.
    let next = globalPaused ? null : await dequeue();
    for (; next; next = globalPaused ? null : await dequeue()) {
      const id = next.galleryId;
      claimedGalleryId = id;
      if (await releaseClaimBlockedByDelete(id, next.nativeRunId ?? null)) {
        blockedByDeletion = true;
        break;
      }
      storeApi?.setEntry(id, {
        progress: null,
        error: null,
        queued: true,
        position: next.queuePosition ?? null,
        title: next.title,
        thumbnail: next.thumbnail,
      });
      storeApi?.refreshQueue();

      // The candidate identity is published before the DB UPDATE awaits. A
      // cancel/pause can therefore finish while dequeue is still persisting the
      // claim; re-read the row before any network/detail work and honour it.
      if (await claimedRunWasStopped(id, next.nativeRunId ?? null)) {
        const claimedRow = await getDownload(id).catch(() => null);
        if (globalPaused && claimedRow?.status === 'downloading') {
          await setDownloadError(id, 'paused', null).catch(() => {});
        }
        clearStoppedClaimedRun(id);
        continue;
      }

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
          if (await claimedRunWasStopped(id, next.nativeRunId ?? null)) {
            clearStoppedClaimedRun(id);
            continue;
          }
          // Could not resolve the gallery's files — leave it 'failed', advance.
          console.error('Queue: failed to resolve gallery detail', id, e);
          const message = 'Failed to resolve gallery';
          await failClaimedRun(id, next.nativeRunId ?? null, message).catch(() => false);
          storeApi?.markNotDownloaded(id);
          notifyDownloadLibraryChanged(true);
          clearClaimState(id);
          continue;
        }
      }

      // Deletion may have claimed the gallery while detail resolution awaited.
      // Release only this still-pre-handoff lifecycle and stop the loop so it
      // cannot immediately reclaim the same queued row.
      if (await releaseClaimBlockedByDelete(id, next.nativeRunId ?? null)) {
        blockedByDeletion = true;
        break;
      }

      let claimedRow: Awaited<ReturnType<typeof getDownload>>;
      try {
        claimedRow = await getDownload(id);
      } catch {
        const releaseStatus =
          globalPaused || pausingClaimed.has(id) || pausingActions.has(id) ? 'paused' : 'queued';
        await releaseDownloadClaim(id, releaseStatus, next.nativeRunId ?? null).catch(() => {});
        clearStoppedClaimedRun(id);
        continue;
      }
      if (await releaseClaimBlockedByDelete(id, next.nativeRunId ?? null)) {
        blockedByDeletion = true;
        break;
      }
      if (
        globalPaused ||
        cancellingClaimed.has(id) ||
        pausingClaimed.has(id) ||
        cancellingActions.has(id) ||
        pausingActions.has(id) ||
        claimedRow?.status !== 'downloading' ||
        (claimedRow.nativeRunId ?? null) !== (next.nativeRunId ?? null)
      ) {
        if (globalPaused && claimedRow?.status === 'downloading') {
          if (next.nativeRunId) {
            await transitionNativeDownloadRun(id, next.nativeRunId, 'paused', null, {
              clearQueuePosition: false,
            }).catch(() => false);
          } else {
            await setDownloadError(id, 'paused', null).catch(() => {});
          }
        }
        clearStoppedClaimedRun(id);
        continue;
      }

      if (files.length === 0) {
        const message = 'Gallery has no downloadable files';
        await failClaimedRun(id, next.nativeRunId ?? null, message).catch(() => false);
        storeApi?.markNotDownloaded(id);
        storeApi?.setEntry(id, null);
        notifyDownloadLibraryChanged(true);
        clearClaimState(id);
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
        const nativeRunId = next.nativeRunId;
        let settleNativeHandoff!: () => void;
        const handoffSettled = new Promise<void>((resolve) => {
          settleNativeHandoff = resolve;
        });
        nativeHandoffSettled.set(id, handoffSettled);
        try {
          if (!nativeRunId) throw new Error('Native download identity is missing');
          const downloadStore = await createDownloadStore();
          await downloadStore.ensureReady?.();
          if (await releaseClaimBlockedByDelete(id, nativeRunId)) {
            blockedByDeletion = true;
            break;
          }
          if (await claimedRunWasStopped(id, nativeRunId)) {
            clearStoppedClaimedRun(id);
            continue;
          }
          // Persist the tracked 'downloading' row BEFORE native enqueue. If the
          // app is killed immediately after WorkManager accepts the work, launch
          // reconcile still has a DB row to match against the manifest.
          if (
            !(await prepareNativeDownloadRun(id, nativeRunId, {
              pageCount: files.length,
              totalBytes: next.totalBytes ?? 0,
              folderName: galleryFolderName(id, next.title),
            }))
          ) {
            // Ownership moved while the prepare CAS awaited. A pause/cancel may
            // already have queued a replacement run, so stale A must not perform
            // any unscoped queue or row cleanup here.
            clearClaimState(id);
            continue;
          }
          if (await releaseClaimBlockedByDelete(id, nativeRunId)) {
            blockedByDeletion = true;
            break;
          }
          if (await claimedRunWasStopped(id, nativeRunId)) {
            clearStoppedClaimedRun(id);
            continue;
          }
          await handOffToAndroidWorker(id, next.title, files, nativeRunId, next.queuePosition);
          // From this point the native order exists. Keep its DB token intact;
          // the delete handler's awaited cancel() owns exact native shutdown.
          if (isGalleryDeleting(id)) {
            clearClaimState(id);
            blockedByDeletion = true;
            break;
          }
          if (await claimedRunWasStopped(id, nativeRunId)) {
            await DownloadWorker.cancel({ galleryId: String(id), runId: nativeRunId }).catch(
              () => {},
            );
            clearStoppedClaimedRun(id);
            continue;
          }
          // The row is NOT in the TS queue anymore, but it is still tracked so
          // worker progress survives app kill and reconcileQueue can finalize it
          // on next open. pageCount carries the TARGET total here (the worker is
          // DB-decoupled and writes only the SAF manifest); reconcile marks the
          // row 'complete' once the on-disk manifest covers all pages.
          notifyDownloadLibraryChanged(true);
          // Surface a "downloading (background)" entry with a 0/total placeholder,
          // then start the in-app live-progress poller: while the app is
          // foreground it reads the worker's progress file (~1s) and advances this
          // entry's current/total in step with the notification. The poller stops
          // on completion (entry cleared) / hidden / no active download.
          storeApi?.setEntry(id, {
            progress: { current: 0, total: files.length },
            error: null,
            queued: false,
            position: null,
            title: next.title,
            thumbnail: next.thumbnail,
          });
          clearClaimState(id);
          startAndroidProgressPoll(id, { runId: nativeRunId });
        } catch (e) {
          console.error('Queue: failed to hand off to Android worker', id, e);
          if (e instanceof DownloadCancelledError && nativeRunId) {
            // Cancelling the SAF picker is deliberate user intent, not a
            // background failure eligible for automatic retry. The order may
            // not have been published yet, so confirm absence as well as an
            // exact cancel response before releasing this claim.
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(id),
              runId: nativeRunId,
            }).catch(() => null);
            if (await confirmNativeRunStopped(id, nativeRunId, cancelled)) {
              if ((next.pageCount ?? 0) > 0) {
                await transitionNativeDownloadRun(id, nativeRunId, 'failed', 'Cancelled').catch(
                  () => false,
                );
              } else {
                await deleteDownloadIfNativeRunMatches(id, nativeRunId).catch(() => false);
              }
              storeApi?.markNotDownloaded(id);
              storeApi?.setEntry(id, null);
              notifyDownloadLibraryChanged(true);
            }
            continue;
          }
          const message =
            e instanceof Error && e.message ? e.message : 'Failed to start background download';
          let mayRetry = true;
          if (nativeRunId) {
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(id),
              runId: nativeRunId,
            }).catch(() => null);
            const failed = await transitionNativeDownloadRun(id, nativeRunId, 'failed', message, {
              clearRunId: false,
            }).catch(() => false);
            if (!failed) continue;
            mayRetry = await confirmNativeRunStopped(id, nativeRunId, cancelled);
          } else {
            await setDownloadError(id, 'failed', message).catch(() => {});
            await removeFromQueue(id);
          }
          storeApi?.markNotDownloaded(id);
          if (mayRetry) {
            await scheduleFailureRetry(id, message);
            if (nativeRunId) {
              const cleared = await clearNativeRunIfMatches(id, nativeRunId).catch(() => false);
              if (cleared) armAutoRetryTimer();
            }
          }
          notifyDownloadLibraryChanged(true);
        } finally {
          if (nativeHandoffSettled.get(id) === handoffSettled) {
            nativeHandoffSettled.delete(id);
          }
          settleNativeHandoff();
          clearClaimState(id);
          fileCache.delete(id);
          storeApi?.refreshQueue();
        }
        continue;
      }

      // Resume when prior pages exist (zombie/paused/failed re-enqueue).
      const resume = (next.pageCount ?? 0) > 0;

      const controller = new AbortController();
      controllers.set(id, controller);
      trackControllerRun(id);
      let iosBackstopRunId: string | null = null;
      try {
        clearClaimState(id);
        storeApi?.setEntry(id, {
          progress: { current: 0, total: files.length },
          error: null,
          queued: false,
          position: null,
          title: next.title,
          thumbnail: next.thumbnail,
        });
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
          // iOS background work is DB-decoupled like Android, so persist the target
          // total before handing off. Foreground progress updates are monotonic and
          // will not shrink this count; completion/reconcile can then trust an
          // exact manifest-length match.
          let settleIosHandoff!: () => void;
          const iosHandoffSettled = new Promise<void>((resolve) => {
            settleIosHandoff = resolve;
          });
          nativeHandoffSettled.set(id, iosHandoffSettled);
          try {
            iosBackstopRunId = await scheduleIosBackgroundBackstop(
              next,
              id,
              next.title,
              files,
              next.queuePosition,
              controller.signal,
            );
            if (iosBackstopRunId) foregroundNativeRunIds.set(id, iosBackstopRunId);
          } finally {
            if (nativeHandoffSettled.get(id) === iosHandoffSettled) {
              nativeHandoffSettled.delete(id);
            }
            settleIosHandoff();
          }
        }

        const config = await getGgConfig();
        await downloadGalleryToLibrary(
          id,
          next.title,
          next.thumbnail,
          files,
          config,
          tags,
          (p) => {
            storeApi?.setEntry(id, { progress: p, error: null, queued: false, position: null });
            notifyDownloadLibraryChanged();
          },
          controller.signal,
          {
            resume,
            isPauseSignal: () => pausing.has(id),
            nativeRunId: iosBackstopRunId ?? undefined,
          },
        );
        // download-zip's terminal DB write already cleared queuePosition. Keep
        // this handoff to the outer success path await-free: cancel/pause intent
        // is published synchronously, so it cannot arrive after this check yet
        // still observe an active controller and be overwritten by markDownloaded.
        if (pausing.has(id) || pausingActions.has(id)) throw new DownloadPausedError();
        if (controller.signal.aborted || cancellingActions.has(id)) {
          throw new DownloadCancelledError();
        }
        storeApi?.setEntry(id, null);
        storeApi?.markDownloaded(id);
        notifyDownloadLibraryChanged(true);
        // iOS (Task D): the foreground download finished, so drop the background
        // backstop work-order (and cancel the pending BGProcessingTask when no
        // other galleries remain) — there is nothing left for it to resume.
        if (isIos() && iosBackstopRunId) {
          const runId = iosBackstopRunId;
          void DownloadWorker.cancel({ galleryId: String(id), runId })
            .then(async (cancelled) => {
              if (await confirmNativeRunStopped(id, runId, cancelled)) {
                await clearNativeRunIfMatches(id, runId).catch(() => false);
              }
            })
            .catch(() => {});
        }
      } catch (e) {
        if (e instanceof StaleDownloadRunError) {
          // A newer run owns this gallery. This attempt must not clean up its
          // queue row, DB status, native work-order, or replacement UI entry.
        } else if (e instanceof DownloadPausedError) {
          // Paused: row left 'paused' (resumable) by download-zip; keep it in the
          // queue (position retained), clear the live progress entry.
          let nativeStopped = true;
          if (isIos() && iosBackstopRunId) {
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(id),
              runId: iosBackstopRunId,
            }).catch(() => null);
            nativeStopped = await confirmNativeRunStopped(id, iosBackstopRunId, cancelled);
            if (nativeStopped) {
              await clearNativeRunIfMatches(id, iosBackstopRunId).catch(() => {});
            } else {
              // The foreground writer stopped, but the iOS backstop is still an
              // active owner. Do not report a successful pause while native IO
              // may continue; restore its exact row to downloading.
              await transitionNativeDownloadRun(id, iosBackstopRunId, 'downloading', null, {
                clearRunId: false,
              }).catch(() => false);
            }
          }
          if (nativeStopped) {
            storeApi?.setEntry(id, null);
          } else {
            const entry = useDownloadProgressStore.getState().entries[id];
            storeApi?.setEntry(id, {
              ...entry,
              progress: entry?.progress ?? null,
              error: 'Unable to pause background download',
              queued: false,
              position: null,
            });
          }
        } else if (
          e instanceof DownloadCancelledError ||
          (e instanceof DOMException && e.name === 'AbortError')
        ) {
          // Genuine cancel: download-zip left the row 'failed' (resumable, no
          // message). Drop it from the queue and clear the entry.
          if (isIos() && iosBackstopRunId) {
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(id),
              runId: iosBackstopRunId,
            }).catch(() => null);
            if (!exactNativeCancellationConfirmed(cancelled, iosBackstopRunId)) continue;
            let storedPages: Awaited<ReturnType<typeof getDownloadedGalleryPages>>;
            try {
              storedPages = await getDownloadedGalleryPages(id);
            } catch {
              const entry = useDownloadProgressStore.getState().entries[id];
              storeApi?.setEntry(id, {
                ...entry,
                progress: entry?.progress ?? null,
                error: 'Unable to verify downloaded pages during cancellation',
                queued: false,
                position: null,
              });
              continue;
            }
            if (storedPages.length === 0) {
              await deleteDownloadIfNativeRunMatches(id, iosBackstopRunId).catch(() => false);
            } else {
              await transitionNativeDownloadRun(id, iosBackstopRunId, 'failed', null).catch(
                () => false,
              );
            }
          } else {
            await removeFromQueue(id);
          }
          storeApi?.markNotDownloaded(id);
          storeApi?.setEntry(id, null);
          notifyDownloadLibraryChanged(true);
        } else {
          // Genuine failure: download-zip left the row 'failed' WITH lastError.
          // Drop it from the queue (it surfaces in the library as failed) and
          // advance to the next item.
          let failureMayRetry = true;
          if (isIos() && iosBackstopRunId) {
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(id),
              runId: iosBackstopRunId,
            }).catch(() => null);
            failureMayRetry = await confirmNativeRunStopped(id, iosBackstopRunId, cancelled);
            if (failureMayRetry) {
              await clearNativeRunIfMatches(id, iosBackstopRunId).catch(() => false);
            }
          } else {
            await removeFromQueue(id);
          }
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
          if (failureMayRetry) {
            await scheduleFailureRetry(id, message);
          } else {
            storeApi?.setEntry(id, {
              progress: useDownloadProgressStore.getState().entries[id]?.progress ?? null,
              error: message,
              queued: false,
              position: null,
            });
          }
          storeApi?.markNotDownloaded(id);
          notifyDownloadLibraryChanged(true);
        }
      } finally {
        clearClaimState(id);
        if (iosBackstopRunId && foregroundNativeRunIds.get(id) === iosBackstopRunId) {
          foregroundNativeRunIds.delete(id);
        }
        controllers.delete(id);
        pausing.delete(id);
        fileCache.delete(id);
        // Transition: this item reached a terminal state (complete/paused/
        // cancelled/failed). Rebuild the reactive queue before advancing so the
        // manager UI reflects the new head/order at every step.
        storeApi?.refreshQueue();
        finishControllerRun(id);
      }
      if (onlyGalleryId !== undefined && id === onlyGalleryId) break;
    }
  } finally {
    if (claimedGalleryId !== null) clearClaimState(claimedGalleryId);
    running = false;
  }
  // A deletion-owned row was deliberately released instead of consumed. Do
  // not service remembered kicks or the final list recheck until the deleting
  // owner releases its claim and explicitly restarts the general processor.
  if (blockedByDeletion) return;
  const nextManualId = pendingManualKicks.values().next().value as number | undefined;
  if (nextManualId !== undefined) {
    pendingManualKicks.delete(nextManualId);
    void processQueue({ onlyGalleryId: nextManualId });
    return;
  }
  if (pendingGeneralKick) {
    pendingGeneralKick = false;
    void processQueue();
    return;
  }
  // A re-check guard: if an item was enqueued during the final loop teardown,
  // kick the processor again (running is now false, so this is safe).
  if (onlyGalleryId === undefined && !dequeueFailed) {
    const pending = await listQueue().catch(() => []);
    if (pending.some((row) => row.status === 'queued' && !isGalleryDeleting(row.galleryId))) {
      void processQueue();
    }
  }
}

export const useDownloadProgressStore = create<DownloadProgressState>()((set, get) => {
  const setEntry = (id: number, entry: DownloadEntry | null) =>
    set((s) => {
      const next = { ...s.entries };
      if (entry === null) {
        delete next[id];
        // Active rows are derived from entries, so remove the matching reactive
        // queue row in the same state update. A subsequent DB refresh can re-add
        // it when this was a pause, but terminal completion/cancel must not leave
        // a stale 100% item behind if listQueue() transiently fails.
        return { entries: next, queue: s.queue.filter((item) => item.id !== id) };
      } else {
        const previous = next[id];
        next[id] = {
          ...(previous?.title !== undefined ? { title: previous.title } : {}),
          ...(previous?.thumbnail !== undefined ? { thumbnail: previous.thumbnail } : {}),
          ...entry,
        };
        if (entry.queued === false) delete next[id].queued;
        if (entry.position === null) delete next[id].position;
      }
      return { entries: next };
    });

  const clearRetryPendingEntry = (
    id: number,
    expectedRetryAt: string | null | undefined,
    expectedAttempt: number | null | undefined,
  ) =>
    set((state) => {
      const entry = state.entries[id];
      if (
        !entry ||
        entry.progress !== null ||
        entry.queued === true ||
        expectedRetryAt == null ||
        expectedAttempt == null ||
        entry.retryAt !== expectedRetryAt ||
        entry.attempt !== expectedAttempt
      ) {
        return state;
      }
      const entries = { ...state.entries };
      delete entries[id];
      return { entries };
    });

  const markDownloaded = (id: number) =>
    set((s) => ({ downloaded: { ...s.downloaded, [id]: true } }));

  const markNotDownloaded = (id: number) =>
    set((s) => ({ downloaded: { ...s.downloaded, [id]: false } }));

  // Rebuild the reactive `queue`: the queued/paused rows from listQueue() merged
  // with active/claimed items from entries. listQueue() is the source of truth
  // for pending order; claimed/active items have already flipped to
  // 'downloading', so they are absent from listQueue and are prepended from the
  // live entries.
  const refreshQueue = async () => {
    const runSeq = ++refreshQueueRunSeq;
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
      .filter((id) => entries[id]?.progress || (entries[id]?.queued && claimedGalleryId === id));

    const pending: QueueItem[] = rows.map((r) => ({
      id: r.galleryId,
      title: r.title,
      thumbnail: r.thumbnail,
      status: r.status === 'paused' ? 'paused' : 'queued',
      position: r.queuePosition ?? null,
      progress: null,
    }));

    const activeRows = await Promise.all(
      activeIds.map(async (id) => {
        const active = entries[id];
        // Active items flipped to 'downloading', so they are no longer in
        // listQueue(); read their rows directly for title/thumbnail metadata.
        const activeRow = await getDownload(id).catch(() => null);
        return { id, active, activeRow };
      }),
    );
    if (runSeq !== refreshQueueRunSeq) return;
    const completedActiveIds = activeRows
      .filter(({ activeRow }) => activeRow?.status === 'complete')
      .map(({ id }) => id);
    const activeItems: QueueItem[] = activeRows
      .filter(({ activeRow }) => activeRow?.status === 'downloading')
      .map(({ id, active, activeRow }) => ({
        id,
        title: activeRow?.title ?? '',
        thumbnail: activeRow?.thumbnail ?? '',
        status: 'downloading',
        position: null,
        progress: active?.progress ?? null,
      }));
    const activeIdSet = new Set(activeItems.map(({ id }) => id));
    const queue: QueueItem[] = [...activeItems, ...pending.filter((p) => !activeIdSet.has(p.id))];
    set((state) => {
      if (completedActiveIds.length === 0) return { queue };
      const nextEntries = { ...state.entries };
      const nextDownloaded = { ...state.downloaded };
      for (const id of completedActiveIds) {
        delete nextEntries[id];
        nextDownloaded[id] = true;
      }
      return { queue, entries: nextEntries, downloaded: nextDownloaded };
    });
  };

  // Bind the module-level processor to this store instance.
  storeApi = {
    setEntry,
    markDownloaded,
    markNotDownloaded,
    refreshQueue: () => void refreshQueue(),
    armAutoRetryTimer,
    clearRetryPendingEntry,
    hasEntry: (id: number) => get().entries[id] !== undefined,
    hasLiveEntry: (id: number) => get().entries[id]?.progress != null,
  };

  return {
    entries: {},
    downloaded: {},
    queue: [],
    globalPaused: false,
    refreshQueue,
    refreshDownloaded: async (id) => {
      const deleteGeneration = getDeleteClaimGeneration(id);
      if (isGalleryDeleting(id) || isLiveDownloadLifecycle(id)) return;
      try {
        const row = await getDownload(id);
        if (deletionChanged(id, deleteGeneration) || isLiveDownloadLifecycle(id)) return;
        let isComplete = false;
        if (row?.status === 'complete') {
          isComplete =
            (row.pageCount ?? 0) > 0
              ? await hasCompleteDownloadedGallery(id, row.pageCount, {
                  folderName: row.folderName ?? null,
                }).catch(() => false)
              : true;
        }
        if (deletionChanged(id, deleteGeneration) || isLiveDownloadLifecycle(id)) return;
        const latestRow = await getDownload(id);
        if (
          deletionChanged(id, deleteGeneration) ||
          isLiveDownloadLifecycle(id) ||
          latestRow?.status !== row?.status ||
          latestRow?.downloadedAt !== row?.downloadedAt ||
          (latestRow?.nativeRunId ?? null) !== (row?.nativeRunId ?? null) ||
          latestRow?.pageCount !== row?.pageCount ||
          (latestRow?.folderName ?? null) !== (row?.folderName ?? null)
        ) {
          return;
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
          const reconciliation = tryBeginDownloadLifecycleReconciliation(id);
          if (!reconciliation) return;
          try {
            let snapshot = row;
            let expectedRunId = row.nativeRunId ?? null;
            let nativeRunId: string | null;
            try {
              const nativeRun = await DownloadWorker.getCurrentRun({ galleryId: String(id) });
              if (isNativeRunLookupUncertain(nativeRun)) return;
              if (nativeRun.legacy === true && row.nativeRunId != null) return;
              if (nativeRun.legacy === true) {
                // A complete manifest must not finalize this tokenless row and
                // strand the pre-runId order outside future reconciliation.
                // Requeue under the lifecycle reservation so processQueue can
                // publish the guarded replacement generation and clean it up.
                if (await requeueInterruptedDownload(row).catch(() => false)) {
                  await refreshQueue();
                  void processQueue({ onlyGalleryId: id });
                }
                return;
              }
              nativeRunId = nativeRun.runId;
            } catch {
              // Native identity is authoritative for restart recovery. A bridge
              // failure is fail-closed: do not guess, requeue, or finalize a row.
              return;
            }

            if (nativeRunId && nativeRunId !== expectedRunId) {
              if (deletionChanged(id, deleteGeneration)) return;
              const adopted = await adoptDiscoveredNativeRunIfUnchanged(row, nativeRunId).catch(
                () => false,
              );
              if (!adopted || deletionChanged(id, deleteGeneration)) return;
              expectedRunId = nativeRunId;
              snapshot = {
                ...row,
                status: 'downloading',
                nativeRunId,
                lastError: null,
                queuePosition: null,
                nextRetryAt: null,
              };
            }

            if (
              await finalizeNativeDownloadIfComplete(id, {
                runId: expectedRunId ?? undefined,
                snapshot,
              })
            ) {
              return;
            }

            if (!nativeRunId) {
              if (await requeueInterruptedDownload(row).catch(() => false)) {
                await refreshQueue();
                void processQueue({ onlyGalleryId: id });
              }
              return;
            }

            const pollRunId = expectedRunId;
            if (!pollRunId || nativeRunId !== pollRunId) return;
            const liveBeforeEnqueue = await getDownload(id);
            if (
              deletionChanged(id, deleteGeneration) ||
              liveBeforeEnqueue?.status !== 'downloading' ||
              liveBeforeEnqueue.nativeRunId !== pollRunId ||
              liveBeforeEnqueue.pageCount !== snapshot.pageCount ||
              liveBeforeEnqueue.downloadedAt !== snapshot.downloadedAt
            ) {
              return;
            }
            // Heal the crash window between writeWorkOrder and the first enqueue.
            await DownloadWorker.enqueue({ galleryId: String(id), runId: pollRunId });
            const liveAfterEnqueue = await getDownload(id);
            if (
              deletionChanged(id, deleteGeneration) ||
              liveAfterEnqueue?.status !== 'downloading' ||
              liveAfterEnqueue.nativeRunId !== pollRunId ||
              liveAfterEnqueue.pageCount !== snapshot.pageCount ||
              liveAfterEnqueue.downloadedAt !== snapshot.downloadedAt
            ) {
              return;
            }
            setEntry(id, {
              progress: { current: 0, total: snapshot.pageCount },
              error: null,
              queued: false,
              position: null,
              title: snapshot.title,
              thumbnail: snapshot.thumbnail,
            });
            startAndroidProgressPoll(id, { runId: pollRunId, rehydrated: true });
            void refreshQueue();
          } finally {
            reconciliation.release();
          }
        }
      } catch {
        // DB unavailable: leave the flag untouched (treated as not-downloaded).
      }
    },
    start: async ({ id, title, thumbnail, files, tags = {} }) => {
      const pendingMutation = queueMutationSettled.get(id);
      if (pendingMutation) await awaitQueueMutationBarrier(id);
      if (queueMutationSettled.has(id)) return;
      if (cancellingActions.has(id) || pausingActions.has(id) || isGalleryDeleting(id)) return;
      let settleStart!: () => void;
      const startSettled = new Promise<void>((resolve) => {
        settleStart = resolve;
      });
      queueMutationSettled.set(id, startSettled);
      try {
        const deleteGeneration = getDeleteClaimGeneration(id);
        if (isGalleryDeleting(id)) return;
        const existing = get().entries[id];
        // Already running/queued for this gallery, or nothing to download.
        if (existing?.progress || existing?.queued || files.length === 0) return;

        // Cache the supplied file list so the processor doesn't re-fetch the
        // detail. Exception: offline detail fallback can synthesize `files` from a
        // short local manifest. If the DB says a completed gallery should have
        // more pages, force a fresh detail resolve so "re-download missing files"
        // cannot turn a partial manifest into a smaller completed gallery.
        let existingRow: DBDownload | null;
        try {
          existingRow = await getDownload(id);
        } catch {
          setEntry(id, { progress: null, error: 'Failed to check download state' });
          return;
        }
        if (deletionChanged(id, deleteGeneration)) return;
        // A missing Zustand entry does not mean a native/foreground lifecycle is
        // idle (notably just after app start). Never let enqueueDownload's upsert
        // erase an active run token or turn it back into an ordinary queue row.
        if (existingRow?.status === 'downloading' || existingRow?.nativeRunId) return;
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
          if (position === null) {
            fileCache.delete(id);
            return;
          }
          if (deletionChanged(id, deleteGeneration)) {
            fileCache.delete(id);
            await removeFromQueue(id).catch(() => {});
            return;
          }
          markNotDownloaded(id);
          setEntry(id, { progress: null, error: null, queued: true, position });
        } catch (e) {
          fileCache.delete(id);
          if (deletionChanged(id, deleteGeneration)) return;
          const message = e instanceof Error && e.message ? e.message : 'Failed to queue download';
          setEntry(id, { progress: null, error: message });
          return;
        }

        void refreshQueue();
        void processQueue({ onlyGalleryId: id });
      } finally {
        if (queueMutationSettled.get(id) === startSettled) queueMutationSettled.delete(id);
        settleStart();
      }
    },
    cancel: async (id) => {
      const intent = beginQueueAction(cancellingActions, id);
      try {
        // A delete/cancel that wins while enqueueDownload is persisting waits
        // until start either publishes the row or removes its deletion-stale
        // upsert, so no queue row can appear after the caller proceeds.
        await awaitQueueMutationBarrier(id);
        await nativeHandoffSettled.get(id);
        const controller = controllers.get(id);
        if (controller) {
          const settled = controllerSettled.get(id);
          let nativeRunId: string | null = null;
          if (isIos()) {
            nativeRunId = foregroundNativeRunIds.get(id) ?? null;
            if (!nativeRunId) {
              let current: DBDownload | null;
              try {
                current = await getDownload(id);
              } catch {
                return false;
              }
              nativeRunId = current?.nativeRunId ?? null;
            }
          }
          let nativeStopped = true;
          if (nativeRunId) {
            const claimed = await transitionNativeDownloadRun(id, nativeRunId, 'failed', null, {
              clearRunId: false,
              clearQueuePosition: false,
            }).catch(() => false);
            if (!claimed) return false;
          }
          // Active run → genuine cancel (NOT a pause).
          controller.abort();
          // iOS (Task D): also drop the background backstop work-order so the
          // BGProcessingTask does not later resume a cancelled gallery (and cancels
          // the pending request when the handoff queue empties).
          if (nativeRunId) {
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(id),
              runId: nativeRunId,
            }).catch(() => null);
            nativeStopped = await confirmNativeRunStopped(id, nativeRunId, cancelled);
          }
          await settled;
          if (!nativeStopped) return false;
          if (nativeRunId) {
            let current: DBDownload | null;
            try {
              current = await getDownload(id);
            } catch {
              return false;
            }
            if (current?.nativeRunId && current.nativeRunId !== nativeRunId) return false;
            if (current?.nativeRunId === nativeRunId) {
              let storedPages: Awaited<ReturnType<typeof getDownloadedGalleryPages>>;
              try {
                storedPages = await getDownloadedGalleryPages(id, {
                  folderName: current.folderName ?? null,
                });
              } catch {
                return false;
              }
              const changed =
                storedPages.length === 0
                  ? await deleteDownloadIfNativeRunMatches(id, nativeRunId).catch(() => false)
                  : await transitionNativeDownloadRun(id, nativeRunId, 'failed', null).catch(
                      () => false,
                    );
              if (!changed) return false;
            }
          }
          fileCache.delete(id);
          markNotDownloaded(id);
          setEntry(id, null);
          notifyDownloadLibraryChanged(true);
          await refreshQueue();
          return true;
        } else if (isAndroid() && get().entries[id]?.progress != null) {
          // Android: the gallery may have been handed off to the native worker
          // (no controller, not in the TS queue). Drop its work-order so the
          // worker skips it (and stops if the handoff queue empties).
          let row: DBDownload | null;
          try {
            row = await getDownload(id);
          } catch {
            return false;
          }
          const runId = row?.nativeRunId ?? null;
          if (!row || !runId) return false;
          if (await finalizeSpecificNativeRun(row)) {
            fileCache.delete(id);
            return true;
          }
          const cancelResult = await cancelAndroidNativeWork(id, runId);
          if (!(await confirmNativeRunStopped(id, runId, cancelResult))) {
            if (await finalizeSpecificNativeRun(row)) {
              fileCache.delete(id);
              return true;
            }
            void refreshQueue();
            return false;
          }
          if (await finalizeSpecificNativeRun(row)) {
            fileCache.delete(id);
            return true;
          }
          let storedPages: Awaited<ReturnType<typeof getDownloadedGalleryPages>>;
          try {
            storedPages = await getDownloadedGalleryPages(id, {
              folderName: row.folderName ?? null,
            });
          } catch {
            return false;
          }
          let changed = false;
          if (storedPages.length === 0) {
            changed = await deleteDownloadIfNativeRunMatches(id, runId).catch(() => false);
          } else {
            changed = await transitionNativeDownloadRun(id, runId, 'failed', 'Cancelled').catch(
              () => false,
            );
          }
          if (!changed) {
            const current = await getDownload(id).catch(() => null);
            if (current?.status !== 'complete' || current.nativeRunId != null) return false;
          }
          fileCache.delete(id);
          markNotDownloaded(id);
          setEntry(id, null);
          // Stop this row's live-progress polling without silencing other active
          // Android handoffs.
          stopAndroidProgressPoll(id, runId);
          notifyDownloadLibraryChanged(true);
          await refreshQueue();
          return true;
        } else {
          // Queued/paused but not yet started → drop it from the queue.
          if (claimedGalleryId === id) cancellingClaimed.add(id);
          let row: DBDownload | null;
          try {
            row = await getDownload(id);
          } catch {
            return false;
          }
          if (row?.nativeRunId) {
            const runId = row.nativeRunId;
            const result = await cancelAndroidNativeWork(id, runId);
            if (!(await confirmNativeRunStopped(id, runId, result))) return false;
            const changed =
              row.status === 'complete'
                ? await clearNativeRunIfUnchanged(row).catch(() => false)
                : (row.pageCount ?? 0) > 0
                  ? await transitionNativeDownloadRun(id, runId, 'failed', 'Cancelled').catch(
                      () => false,
                    )
                  : await deleteDownloadIfNativeRunMatches(id, runId).catch(() => false);
            if (!changed) {
              // A concurrent completion finalizer may have cleared this exact
              // token after native quiescence was proved. Treat that idempotent
              // complete/no-owner state as success so delete does not fail once.
              const current = await getDownload(id).catch(() => null);
              if (current?.status !== 'complete' || current.nativeRunId != null) return false;
            }
            stopAndroidProgressPoll(id, runId);
          } else if (row?.status === 'complete') {
            // cancel() is also the deletion quiescence barrier. An idle complete
            // row has no work to stop, and must remain in the DB until its
            // physical folder deletion succeeds.
          } else if (row) {
            if (row?.status === 'downloading' && (row.pageCount ?? 0) > 0) {
              try {
                await setDownloadError(id, 'failed', 'Cancelled');
              } catch {
                return false;
              }
            }
            try {
              await removeFromQueue(id);
              if (await releaseDownloadClaim(id, 'queued', null)) {
                await removeFromQueue(id);
              }
            } catch {
              return false;
            }
          }
          fileCache.delete(id);
          setEntry(id, null);
          notifyDownloadLibraryChanged(true);
          await refreshQueue();
          return true;
        }
      } finally {
        finishQueueAction(cancellingActions, id, intent);
      }
    },
    retryFailed: async (expected) => {
      const id = expected.galleryId;
      await awaitQueueMutationBarrier(id);
      const deleteGeneration = getDeleteClaimGeneration(id);
      if (expected.status !== 'failed' || isGalleryDeleting(id)) return false;
      let retrySnapshot: DBDownload | null = expected;
      if (expected.nativeRunId) {
        const current = await getDownload(id).catch(() => null);
        if (current?.nativeRunId !== expected.nativeRunId || current.status !== 'failed') {
          return false;
        }
        // Stop/clear the exact native owner before reserving the queue mutation;
        // cancel() itself waits on that reservation for delete-vs-enqueue safety.
        if (!(await get().cancel(id))) return false;
        retrySnapshot = await getDownload(id).catch(() => null);
      }
      if (deletionChanged(id, deleteGeneration) || queueMutationSettled.has(id)) return false;
      const pendingEntry = get().entries[id];
      let settleRetry!: () => void;
      const retrySettled = new Promise<void>((resolve) => {
        settleRetry = resolve;
      });
      queueMutationSettled.set(id, retrySettled);
      try {
        if (!retrySnapshot) {
          const inserted = await retryDownloadIfAbsent(expected).catch(() => false);
          if (!inserted) return false;
          clearRetryPendingEntry(id, pendingEntry?.retryAt, pendingEntry?.attempt);
          void refreshQueue();
          if (!globalPaused) void processQueue({ onlyGalleryId: id });
          return true;
        }
        const queued = await retryDownloadIfUnchanged(retrySnapshot).catch(() => false);
        if (!queued) return false;
        clearRetryPendingEntry(id, pendingEntry?.retryAt, pendingEntry?.attempt);
        void refreshQueue();
        if (!globalPaused) void processQueue({ onlyGalleryId: id });
        return true;
      } finally {
        if (queueMutationSettled.get(id) === retrySettled) queueMutationSettled.delete(id);
        settleRetry();
      }
    },
    retryMissing: async (expected) => {
      const id = expected.galleryId;
      const deleteGeneration = getDeleteClaimGeneration(id);
      if (
        expected.status !== 'complete' ||
        expected.nativeRunId != null ||
        isGalleryDeleting(id) ||
        queueMutationSettled.has(id)
      ) {
        return false;
      }

      let settleRetry!: () => void;
      const retrySettled = new Promise<void>((resolve) => {
        settleRetry = resolve;
      });
      queueMutationSettled.set(id, retrySettled);
      let queued = false;
      try {
        if (deletionChanged(id, deleteGeneration)) return false;
        queued = await redownloadCompleteIfUnchanged(expected).catch(() => false);
        if (!queued || deletionChanged(id, deleteGeneration)) return false;
        // Distinguish a confirmed missing row from a transient read failure.
        // The CAS above has already committed `queued`; treating an I/O error
        // as absence would return before kicking the processor and strand that
        // row until a later app restart/queue refresh. A real null still fails
        // closed, so a concurrent direct delete cannot be resurrected.
        let current: DBDownload | null | undefined;
        try {
          current = await getDownload(id);
        } catch {
          current = undefined;
        }
        if (deletionChanged(id, deleteGeneration) || current === null) return false;

        // The queue processor may claim or even finish this row between the
        // CAS and this best-effort read. Only publish a queued UI entry while
        // the row is still queued (or when the read itself was transiently
        // unavailable); otherwise leave the newer live/terminal UI alone.
        if (current === undefined || (current.status === 'queued' && current.nativeRunId == null)) {
          markNotDownloaded(id);
          setEntry(id, {
            progress: null,
            error: null,
            queued: true,
            position: current?.queuePosition ?? null,
            title: current?.title ?? expected.title,
            thumbnail: current?.thumbnail ?? expected.thumbnail,
          });
        }
      } finally {
        if (queueMutationSettled.get(id) === retrySettled) queueMutationSettled.delete(id);
        settleRetry();
      }
      if (!queued || deletionChanged(id, deleteGeneration)) return false;
      void refreshQueue();
      if (!globalPaused) void processQueue({ onlyGalleryId: id });
      return true;
    },
    pause: async (id) => {
      const intent = beginQueueAction(pausingActions, id);
      try {
        // `start()` and native handoff both publish asynchronously.  A pause
        // intent is synchronous (so the producer will observe it), but it must
        // also wait for those producers to settle before deciding which exact
        // foreground/native owner needs to be stopped.
        await awaitQueueMutationBarrier(id);
        await nativeHandoffSettled.get(id);
        const controller = controllers.get(id);
        if (controller) {
          const settled = controllerSettled.get(id);
          const nativeRunId = isIos()
            ? (foregroundNativeRunIds.get(id) ??
              (await getDownload(id).catch(() => null))?.nativeRunId ??
              null)
            : null;
          // Active run → mark it as a PAUSE before aborting so download-zip reads
          // the pausing signal and writes status 'paused' (not 'failed').
          pausing.add(id);
          if (nativeRunId) {
            const claimed = await transitionNativeDownloadRun(id, nativeRunId, 'paused', null, {
              clearRunId: false,
              clearQueuePosition: false,
            }).catch(() => false);
            if (!claimed) {
              pausing.delete(id);
              return false;
            }
          }
          controller.abort();
          // The controller's DownloadPausedError path owns the exact iOS
          // backstop cancellation and restores the row to downloading when it
          // cannot prove that native writer stopped.
          await settled;
          if (get().entries[id]?.error === 'Unable to pause background download') {
            await refreshQueue();
            return false;
          }
        } else if (isAndroid() && get().entries[id]?.progress != null) {
          const row = await getDownload(id).catch(() => null);
          if (row && (await finalizeSpecificNativeRun(row))) {
            fileCache.delete(id);
            await refreshQueue();
            return true;
          }
          if (row && (await pauseAndroidNativeRun(row))) {
            setEntry(id, null);
            notifyDownloadLibraryChanged(true);
          } else {
            const entry = get().entries[id];
            setEntry(id, {
              ...entry,
              progress: entry?.progress ?? null,
              error: 'Unable to pause background download',
              queued: false,
              position: null,
            });
            await refreshQueue();
            return false;
          }
        } else {
          // Not-yet-started queued item → just hold it.
          const row = await getDownload(id).catch(() => null);
          if (row?.nativeRunId) {
            pausingClaimed.add(id);
            if (await pauseAndroidNativeRun(row)) {
              setEntry(id, null);
            } else {
              const entry = get().entries[id];
              setEntry(id, {
                ...entry,
                progress: entry?.progress ?? null,
                error: 'Unable to pause background download',
                queued: false,
                position: null,
              });
              await refreshQueue();
              return false;
            }
          } else if (row?.status === 'downloading') {
            pausingClaimed.add(id);
            try {
              await setDownloadError(id, 'paused', null);
            } catch {
              return false;
            }
            setEntry(id, null);
          } else {
            try {
              await pauseQueued(id);
            } catch {
              return false;
            }
          }
          if (await releaseDownloadClaim(id, 'paused', null).catch(() => false)) {
            pausingClaimed.add(id);
            setEntry(id, null);
          }
        }
        await refreshQueue();
        return true;
      } finally {
        finishQueueAction(pausingActions, id, intent);
      }
    },
    resume: async (id) => {
      const row = await getDownload(id).catch(() => null);
      const resumed = row?.status === 'paused' ? await resumePausedDownloadRow(row) : false;
      if (resumed && !globalPaused) void processQueue();
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
      const entry = get().entries[id];
      clearRetryPendingEntry(id, entry?.retryAt, entry?.attempt);
      armAutoRetryTimer();
    },
    pauseAll: async () => {
      globalPaused = true;
      set({ globalPaused: true });
      let queuedRows: Awaited<ReturnType<typeof listQueue>> = [];
      let lifecycleRows: DBDownload[] = [];
      let lifecycleEnumerationSucceeded = true;
      try {
        queuedRows = await listQueue();
      } catch {
        queuedRows = [];
      }
      try {
        lifecycleRows = await listDownloads();
      } catch {
        lifecycleRows = [];
        lifecycleEnumerationSucceeded = false;
      }
      // Route every visible/pending owner through the same per-gallery barrier.
      // This covers an Android/iOS work-order publisher that is still in flight
      // as well as the narrow claimed-before-controller window.
      const targetIds = new Set<number>();
      for (const row of queuedRows) {
        if (row.status === 'queued') targetIds.add(row.galleryId);
      }
      for (const row of lifecycleRows) {
        if (row.status === 'downloading' || row.nativeRunId != null) {
          targetIds.add(row.galleryId);
        }
      }
      for (const id of controllers.keys()) targetIds.add(id);
      if (claimedGalleryId !== null) targetIds.add(claimedGalleryId);
      for (const [id, entry] of Object.entries(get().entries)) {
        if (entry.progress != null) targetIds.add(Number(id));
      }

      let allPaused = lifecycleEnumerationSucceeded;
      for (const id of targetIds) {
        if (
          !(await get()
            .pause(id)
            .catch(() => false))
        )
          allPaused = false;
      }
      await refreshQueue();
      if (!allPaused) {
        // Do not claim that the whole queue is paused while a background writer
        // could still be running. Rows that were stopped successfully remain
        // individually paused and can be resumed explicitly.
        globalPaused = false;
        set({ globalPaused: false });
        void processQueue();
      }
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
        if (r.status === 'paused') await resumePausedDownloadRow(r);
      }
      armAutoRetryTimer();
      void processQueue();
      await refreshQueue();
    },
  };
});
