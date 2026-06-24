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
import { enqueueDownload } from '@/lib/db/download-queue';
import { listDueAutoRetries } from '@/lib/db/download-retry';
import { deserializeTags } from '@/lib/db/download';
import { isUnmeteredNetwork } from '@/lib/utils/network';
import { isAndroid, isIos } from '@/lib/utils/platform';
import { processQueue, armAutoRetryTimer, finalizeDownloadIfComplete } from './download-progress';

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
 * covering that count can be marked 'complete'.
 *
 * Best-effort: any per-row failure is swallowed so boot never breaks.
 */
async function reconcileNativeBackgroundDownloads(): Promise<void> {
  let db;
  try {
    db = await ensureDb();
  } catch {
    return;
  }
  let rows: DBDownload[] = [];
  try {
    rows = await db.query<DBDownload>(
      `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt
         FROM download
        WHERE status = 'downloading' AND pageCount > 0`,
    );
  } catch {
    return;
  }

  for (const row of rows) {
    try {
      // ONE completion rule, shared with the Android in-app poller: a
      // 'downloading' row whose manifest now covers all pages → 'complete'.
      await finalizeDownloadIfComplete(row.galleryId);
    } catch {
      // Leave the row as-is; the zombie re-enqueue path will resume it.
    }
  }
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
    if (isAndroid() || isIos()) {
      await reconcileNativeBackgroundDownloads();
    }

    // Zombie 'downloading' rows with stored pages → re-enqueue with resume
    // intent (enqueueDownload preserves pageCount/folderName so the processor
    // resumes from where it stopped).
    const zombies = await db.query<DBDownload>(
      `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt
         FROM download
        WHERE status = 'downloading' AND pageCount > 0`,
    );

    for (const z of zombies) {
      await enqueueDownload(
        {
          galleryId: z.galleryId,
          title: z.title,
          thumbnail: z.thumbnail,
          tags: deserializeTags(z.tags),
        },
        { keepRetryState: true, queuePosition: z.queuePosition ?? undefined },
      );
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
      for (const d of due) {
        // KEEP the escalating-backoff counter for an automatic requeue.
        await enqueueDownload(
          {
            galleryId: d.galleryId,
            title: d.title,
            thumbnail: d.thumbnail,
            tags: deserializeTags(d.tags),
          },
          { keepRetryState: true },
        );
      }
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
