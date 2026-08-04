/**
 * Launch-time queue reconciliation (AC-007).
 *
 * On app boot, after the existing Data→public migration + library reconcile:
 *  1. Find zombie 'downloading' rows (a download interrupted by app death) that
 *     have partial pages, and flip them back to 'queued' so the processor
 *     resumes them rather than leaving them stuck mid-download forever.
 *  2. If the network is unmetered (Wi-Fi / ethernet), kick the processor so any
 *     'queued' work (the just-requeued zombies + anything left queued from a
 *     prior session) resumes automatically. On a metered network we leave the
 *     queue parked — auto-resume is Wi-Fi-only; a manual tap bypasses the gate.
 *
 * Idempotent + strict-mode safe via a module-level `started` guard, and
 * best-effort (never throws into boot).
 */
import { ensureDb } from '@/lib/db/adapter';
import type { DBDownload } from '@/lib/db/schema';
import { listDueAutoRetries, requeueInterruptedDownload } from '@/lib/db/download-retry';
import { isUnmeteredNetwork } from '@/lib/utils/network';
import { isAndroid, isIos } from '@/lib/utils/platform';
import { DownloadWorker, isNativeRunLookupUncertain } from '@/lib/plugins/downloadWorker';
import {
  adoptDiscoveredNativeRunIfUnchanged,
  clearNativeRunIfUnchanged,
  rebindNativeRunIfUnchanged,
  transitionNativeDownloadRun,
} from '@/lib/db/download';
import {
  processQueue,
  armAutoRetryTimer,
  finalizeDownloadIfComplete,
  confirmNativeRunStopped,
  tryBeginDownloadLifecycleReconciliation,
  requeueDueRetryWithLifecycleBarrier,
  useDownloadProgressStore,
} from './download-progress';

let started = false;

/**
 * Native background-download reconcile (Android Task C AC-006; iOS Task D).
 *
 * Both native background downloaders write images + the 0000.json manifest
 * directly into the platform store but are DB-decoupled (they cannot write the
 * app's SQLite): Android's WorkManager worker into the SAF tree, iOS's
 * BGProcessingTask into `Directory.Data` (the numeric `downloads/<id>/` layout).
 * So on app open we reconcile DB status from the on-disk manifest — read through
 * `getDownloadedGalleryPages` → `createDownloadStore()`, which resolves the right
 * adapter per platform (AndroidPublicDownloadStore / CapacitorDownloadStore), so
 * the SAME storage abstraction covers both folder layouts. Native handoff rows
 * store the target `pageCount` before scheduling background work, so a manifest
 * covering that count can be marked 'complete'. Include 'queued' rows too: an
 * earlier foreground reconcile may have re-queued an incomplete native row, and
 * the native worker can finish later while the GUI still shows it as pending.
 *
 * Best-effort: any per-row failure is swallowed so boot never breaks.
 */
export async function reconcileNativeBackgroundDownloads(): Promise<number> {
  if (!isAndroid() && !isIos()) return 0;
  let db;
  try {
    db = await ensureDb();
  } catch {
    return 0;
  }
  let rows: DBDownload[] = [];
  try {
    rows = await db.query<DBDownload>(
      `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId
         FROM download
        WHERE (status IN ('downloading', 'failed', 'queued') AND pageCount > 0)
           OR (status = 'complete' AND nativeRunId IS NOT NULL)`,
    );
  } catch {
    return 0;
  }

  let completed = 0;
  for (const row of rows) {
    const reconciliation = tryBeginDownloadLifecycleReconciliation(row.galleryId);
    if (!reconciliation) continue;
    try {
      // ONE completion rule, shared with the Android in-app poller: a
      // 'downloading' row whose manifest now covers all pages → 'complete'.
      const nativeRun = await DownloadWorker.getCurrentRun({ galleryId: String(row.galleryId) });
      if (isNativeRunLookupUncertain(nativeRun)) continue;
      const nativeRunId = nativeRun.runId;
      if (!reconciliation.isCurrent()) continue;
      const expectedRunId = row.nativeRunId ?? null;
      if (nativeRun.legacy === true && expectedRunId !== null) {
        // A pre-runId order cannot prove that a tokenized DB lifecycle stopped.
        // Keep both states intact for a later explicit recovery decision.
        continue;
      }
      if (nativeRun.legacy === true) {
        // Do not let an already-complete manifest finalize this tokenless row
        // before the zombie/queued path publishes a fresh runId. The guarded
        // replacement is what makes native cleanup generation-safe.
        continue;
      }
      if (nativeRunId !== null && nativeRunId !== expectedRunId) {
        if (row.status === 'failed' || row.status === 'complete') {
          // Preserve terminal intent while rebinding to the only native writer,
          // then stop that exact run. If stop fails, the failed row retains the
          // real token so delete/retry can try again instead of staying on A.
          const rebound = await rebindNativeRunIfUnchanged(row, nativeRunId).catch(() => false);
          if (!rebound) continue;
          if (!reconciliation.isCurrent()) continue;
          const reboundSnapshot = { ...row, nativeRunId };
          const cancelled = await DownloadWorker.cancel({
            galleryId: String(row.galleryId),
            runId: nativeRunId,
          }).catch(() => null);
          const stopped = await confirmNativeRunStopped(row.galleryId, nativeRunId, cancelled);
          if (!reconciliation.isCurrent()) continue;
          if (stopped) {
            await clearNativeRunIfUnchanged(reboundSnapshot).catch(() => false);
          }
          continue;
        }
        // Native state is the actual writer. Adopt it from the exact launch
        // snapshot; never cancel a run merely because an older DB read
        // disagreed, since a concurrent replacement may already own it.
        await adoptDiscoveredNativeRunIfUnchanged(row, nativeRunId).catch(() => false);
        continue;
      }
      if (
        await finalizeDownloadIfComplete(row.galleryId, reconciliation.isCurrent, {
          nativeRunId: expectedRunId,
          snapshot: row,
        })
      ) {
        completed++;
        continue;
      }

      if (expectedRunId && nativeRunId === expectedRunId && row.status === 'failed') {
        // A failed/cancelled lifecycle is terminal user intent. Try to stop its
        // exact lingering native owner, but never revive or enqueue it.
        const cancelled = await DownloadWorker.cancel({
          galleryId: String(row.galleryId),
          runId: expectedRunId,
        }).catch(() => null);
        const stopped = await confirmNativeRunStopped(row.galleryId, expectedRunId, cancelled);
        if (!reconciliation.isCurrent()) continue;
        if (stopped) {
          await clearNativeRunIfUnchanged(row).catch(() => false);
        }
        continue;
      }

      if (expectedRunId && nativeRunId === expectedRunId && row.status === 'queued') {
        // Native is still the authoritative writer. Remove a stale queue slot
        // and surface the row as active instead of letting processQueue create B.
        await adoptDiscoveredNativeRunIfUnchanged(row, expectedRunId).catch(() => false);
        continue;
      }

      if (expectedRunId && nativeRunId === null && row.status !== 'downloading') {
        // The order is gone and the manifest is incomplete. Release the stale
        // token without changing a queued row's position; failed rows remain
        // visible for a deliberate retry.
        await clearNativeRunIfUnchanged(row).catch(() => false);
      }
    } catch {
      // Leave the row as-is; the zombie re-enqueue path will resume it.
    } finally {
      reconciliation.release();
    }
  }
  return completed;
}

/** Reset the guard — test-only. */
export function __resetReconcileQueueForTests(): void {
  started = false;
}

export async function reconcileQueue(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const db = await ensureDb();

    // Native workers are DB-decoupled; rows carry the target page count before
    // handoff, so completed native work can be finalized from the manifest.
    await reconcileNativeBackgroundDownloads();

    // Zombie 'downloading' rows → re-enqueue. Rows with stored pages resume
    // from disk; rows with pageCount 0 may have been atomically claimed from
    // the queue just before app death and should not stay stuck as active.
    const zombies = await db.query<DBDownload>(
      `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId
         FROM download
        WHERE status = 'downloading'`,
    );

    for (const z of zombies) {
      const reconciliation = tryBeginDownloadLifecycleReconciliation(z.galleryId);
      if (!reconciliation) continue;
      try {
        if (!isAndroid() && !isIos()) {
          await requeueInterruptedDownload(z);
          continue;
        }

        let nativeRunId: string | null;
        try {
          const nativeRun = await DownloadWorker.getCurrentRun({ galleryId: String(z.galleryId) });
          if (isNativeRunLookupUncertain(nativeRun)) continue;
          if (nativeRun.legacy === true && z.nativeRunId != null) continue;
          nativeRunId = nativeRun.runId;
        } catch {
          continue;
        }
        if (!reconciliation.isCurrent()) continue;
        const expectedRunId = z.nativeRunId ?? null;

        if (expectedRunId && nativeRunId === expectedRunId) {
          if (isAndroid()) {
            await DownloadWorker.enqueue({
              galleryId: String(z.galleryId),
              runId: expectedRunId,
            }).catch(() => {});
            reconciliation.release();
            await useDownloadProgressStore.getState().refreshDownloaded(z.galleryId);
          } else {
            const cancelled = await DownloadWorker.cancel({
              galleryId: String(z.galleryId),
              runId: expectedRunId,
            }).catch(() => null);
            const stopped = await confirmNativeRunStopped(z.galleryId, expectedRunId, cancelled);
            if (!reconciliation.isCurrent()) continue;
            if (stopped) {
              await requeueInterruptedDownload(z);
            }
          }
          continue;
        }

        if (nativeRunId && nativeRunId !== expectedRunId) {
          // The launch snapshot may already have been superseded by a live
          // lifecycle. Claim the discovered native writer from the *entire*
          // snapshot before touching it; losing this CAS means B belongs to the
          // replacement lifecycle and must remain untouched.
          const adopted = await adoptDiscoveredNativeRunIfUnchanged(z, nativeRunId).catch(
            () => false,
          );
          if (!adopted) continue;
          if (!reconciliation.isCurrent()) continue;
          const adoptedSnapshot: DBDownload = {
            ...z,
            status: 'downloading',
            nativeRunId,
            lastError: null,
            queuePosition: null,
            nextRetryAt: null,
          };
          const cancelled = await DownloadWorker.cancel({
            galleryId: String(z.galleryId),
            runId: nativeRunId,
          }).catch(() => null);
          const stopped = await confirmNativeRunStopped(z.galleryId, nativeRunId, cancelled);
          if (!reconciliation.isCurrent()) continue;
          if (!stopped) continue;
          if (expectedRunId) {
            await transitionNativeDownloadRun(
              z.galleryId,
              nativeRunId,
              'failed',
              'Background download identity conflict',
            ).catch(() => false);
            continue;
          }
          await requeueInterruptedDownload(adoptedSnapshot);
          continue;
        }

        if (reconciliation.isCurrent()) await requeueInterruptedDownload(z);
      } finally {
        reconciliation.release();
      }
    }

    // Staged auto-restart (Task E): an item that was waiting to auto-retry when
    // the app was killed is re-evaluated at launch. Due/overdue rows (Wi-Fi-
    // gated on non-Android; Android's native worker only needs CONNECTED, so due
    // retries are allowed on cellular there.
    const unmetered = await isUnmeteredNetwork();
    if (unmetered || isAndroid()) {
      let due: DBDownload[] = [];
      try {
        due = await listDueAutoRetries(new Date().toISOString());
      } catch {
        due = [];
      }
      for (const d of due) await requeueDueRetryWithLifecycleBarrier(d);
    }

    // Auto-resume on Android only requires connectivity because the native
    // WorkManager worker uses NetworkType.CONNECTED. Other platforms keep the
    // Wi-Fi/ethernet gate for in-process downloads and auto-retry.
    if (unmetered || isAndroid()) {
      void processQueue();
    }

    // Arm the single auto-retry timer for any rows still awaiting a future
    // attempt (regardless of network — the timer re-checks the gate at fire).
    armAutoRetryTimer();
  } catch (e) {
    started = false;
    console.warn('[queue] reconcileQueue failed:', e);
  }
}
