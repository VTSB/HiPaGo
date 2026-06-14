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
import { processQueue, armAutoRetryTimer } from './download-progress';

let started = false;

/** Reset the guard — test-only. */
export function __resetReconcileQueueForTests(): void {
  started = false;
}

export async function reconcileQueue(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const db = await ensureDb();

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
