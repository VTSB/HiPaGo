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
import { deserializeTags, getDownload, upsertDownload } from '@/lib/db/download';
import { getDownloadedGalleryPages } from '@/lib/utils/download-zip';
import { isUnmeteredNetwork } from '@/lib/utils/network';
import { isAndroid } from '@/lib/utils/platform';
import { processQueue, armAutoRetryTimer } from './download-progress';

let started = false;

/**
 * Android worker reconcile (Task C, AC-006).
 *
 * The native WorkManager worker writes images + the 0000.json manifest directly
 * into the SAF tree but is DB-decoupled (it cannot write the app's SQLite). So on
 * app open we reconcile DB status from the on-disk manifest: a 'downloading' row
 * whose manifest now lists at least `pageCount` pages (the recorded target) is
 * marked 'complete'. Unfinished rows are left 'downloading' so the generic zombie
 * step re-enqueues them — on Android processQueue hands them back to the worker,
 * which skips already-present pages (resume).
 *
 * Best-effort: any per-row failure is swallowed so boot never breaks.
 */
async function reconcileAndroidWorkerDownloads(): Promise<void> {
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
      const pages = await getDownloadedGalleryPages(row.galleryId);
      // The manifest lists one ext per stored page. When it covers at least the
      // recorded target page count, every page is on disk → the worker finished.
      if (pages.length > 0 && pages.length >= row.pageCount) {
        const current = await getDownload(row.galleryId);
        if (!current || current.status === 'complete') continue;
        await upsertDownload({
          ...current,
          pageCount: pages.length,
          status: 'complete',
          lastError: null,
        });
      }
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

    // Android (Task C): the background worker is DB-decoupled, so first reconcile
    // DB status from the on-disk manifest — galleries the worker finished while
    // the app was gone are marked 'complete' here. Unfinished ones stay
    // 'downloading' and fall through to the zombie re-enqueue below, which on
    // Android hands them back to the worker (resume).
    if (isAndroid()) {
      await reconcileAndroidWorkerDownloads();
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
      await enqueueDownload({
        galleryId: z.galleryId,
        title: z.title,
        thumbnail: z.thumbnail,
        tags: deserializeTags(z.tags),
      });
    }

    // Staged auto-restart (Task E): an item that was waiting to auto-retry when
    // the app was killed is re-evaluated at launch. Due/overdue rows (Wi-Fi-
    // gated) are re-enqueued now; the rest keep waiting on the armed timer.
    const unmetered = await isUnmeteredNetwork();
    if (unmetered) {
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

    // Auto-resume only on an unmetered network (zombies + due auto-retries +
    // anything left queued from a prior session).
    if (unmetered) {
      void processQueue();
    }

    // Arm the single auto-retry timer for any rows still awaiting a future
    // attempt (regardless of network — the timer re-checks the gate at fire).
    armAutoRetryTimer();
  } catch (e) {
    console.warn('[queue] reconcileQueue failed:', e);
  }
}
