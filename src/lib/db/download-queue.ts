/**
 * Download-queue operations over the single `download` table.
 *
 * The download IS the queue item (premise decision): there is no separate queue
 * table. Queue membership is expressed by `status IN ('queued','paused')` plus a
 * `queuePosition` ordering column (NULL when the row is not queued).
 *
 * The active-run statuses ('downloading'/'complete'/'failed') stay owned by
 * `download-zip.ts::downloadGalleryToLibrary`. This module only owns the
 * 'queued'/'paused' transitions and the ordering.
 */
import { ensureDb, persistDb } from './adapter';
import type { DBDownload } from './schema';
import { getDownload, serializeTags } from './download';
import { notifyDownloadCatalogChanged } from '@/lib/storage/public-backup-events';

const SELECT_COLS =
  'galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId';

/** The metadata needed to create a queue entry for a gallery. */
export interface EnqueueMeta {
  galleryId: number;
  title: string;
  thumbnail: string;
  tags: Record<string, string[]>;
}

/** The lowest queuePosition currently in use (NULL-safe). null when queue empty. */
async function minQueuePosition(): Promise<number | null> {
  const db = await ensureDb();
  const rows = await db.query<{ minPos: number | null }>(
    "SELECT MIN(queuePosition) AS minPos FROM download WHERE status IN ('queued', 'paused') AND queuePosition IS NOT NULL",
  );
  return rows[0]?.minPos ?? null;
}

/** The highest queuePosition currently in use. null when queue empty. */
async function maxQueuePosition(): Promise<number | null> {
  const db = await ensureDb();
  const rows = await db.query<{ maxPos: number | null }>(
    "SELECT MAX(queuePosition) AS maxPos FROM download WHERE status IN ('queued', 'paused') AND queuePosition IS NOT NULL",
  );
  return rows[0]?.maxPos ?? null;
}

/**
 * Enqueue a gallery for download.
 *
 * - Default: append to the back of the queue (next position = max + 1).
 * - `userInitiated: true`: jump to the FRONT of the queue (position = min - 1)
 *   so a manual tap is serviced before earlier auto-queued items.
 * - `queuePosition`: restore a previously persisted position during launch
 *   reconciliation instead of appending the interrupted row to the back.
 *
 * If a row already exists (e.g. a 'failed' row being retried, or a 'paused'
 * row), it is updated in place to status 'queued' with the new position; its
 * partial pages and folderName are preserved by reading the existing row first.
 * Returns the assigned queuePosition.
 *
 * Auto-retry state (retryCount/nextRetryAt) is RESET by default: a manual retry
 * or any plain (re-)queue gives the gallery a fresh set of automatic attempts.
 * The scheduler's auto-requeue path passes `keepRetryState: true` so escalating
 * backoff is preserved across automatic attempts (Task E).
 */
export async function enqueueDownload(
  meta: EnqueueMeta,
  opts: { userInitiated?: boolean; keepRetryState?: boolean; queuePosition?: number } = {},
): Promise<number | null> {
  const position =
    opts.queuePosition !== undefined
      ? opts.queuePosition
      : opts.userInitiated
        ? ((await minQueuePosition()) ?? 1) - 1
        : ((await maxQueuePosition()) ?? 0) + 1;

  const db = await ensureDb();
  // One conditional UPSERT is the ownership boundary. A read-then-replace can
  // erase a native token if processQueue claims the row between those steps.
  // Existing progress/storage metadata is deliberately left untouched.
  const result = await db.execute(
    `INSERT INTO download
       (galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt,
        status, folderName, migratedAt, lastError, queuePosition, retryCount,
        nextRetryAt, nativeRunId)
     VALUES (?, ?, ?, ?, 0, 0, ?, 'queued', NULL, NULL, NULL, ?, 0, NULL, NULL)
     ON CONFLICT(galleryId) DO UPDATE SET
       title = excluded.title,
       thumbnail = excluded.thumbnail,
       tags = excluded.tags,
       status = 'queued',
       lastError = NULL,
       queuePosition = excluded.queuePosition,
       retryCount = CASE WHEN ? THEN download.retryCount ELSE 0 END,
       nextRetryAt = NULL,
       nativeRunId = NULL
     WHERE download.status <> 'downloading'
       AND download.nativeRunId IS NULL`,
    [
      meta.galleryId,
      meta.title,
      meta.thumbnail,
      serializeTags(meta.tags),
      new Date().toISOString(),
      position,
      opts.keepRetryState ? 1 : 0,
    ],
  );
  if (result.changes === 0) return null;
  await persistDb();
  notifyDownloadCatalogChanged();

  return position;
}

/**
 * List the current queue (status 'queued' or 'paused'), ordered by position.
 */
export async function listQueue(): Promise<DBDownload[]> {
  const db = await ensureDb();
  return db.query<DBDownload>(
    `SELECT ${SELECT_COLS}
      FROM download
     WHERE status IN ('queued', 'paused') AND queuePosition IS NOT NULL
      ORDER BY queuePosition IS NULL ASC, queuePosition ASC, downloadedAt ASC, galleryId ASC`,
  );
}

/**
 * Return the next dequeueable item: the lowest-position 'queued' row (NOT
 * 'paused' — paused items are explicitly held). Returns null when none.
 *
 * Claims the row before returning it. The conditional UPDATE is the ownership
 * boundary: if another caller already moved the selected row out of 'queued',
 * this caller observes zero changes and returns null instead of returning the
 * same work item.
 */
export async function dequeueNextQueued(
  galleryId?: number,
  onClaimCandidate?: (galleryId: number) => void,
  nativeRunId: string | null = null,
): Promise<DBDownload | null> {
  const db = await ensureDb();

  const candidates = await db.query<{ galleryId: number }>(
    `SELECT galleryId
       FROM download
      WHERE status = 'queued' AND queuePosition IS NOT NULL
        ${galleryId === undefined ? '' : 'AND galleryId = ?'}
      ORDER BY queuePosition IS NULL ASC, queuePosition ASC, downloadedAt ASC, galleryId ASC
      LIMIT 1`,
    galleryId === undefined ? [] : [galleryId],
  );
  const claimedGalleryId = candidates[0]?.galleryId;
  if (claimedGalleryId === undefined) return null;

  // Publish the candidate synchronously before the conditional UPDATE awaits.
  // The queue processor uses this hook to cover the otherwise invisible window
  // where cancel/pause can race the database claim. The UPDATE below remains the
  // authoritative ownership boundary; a losing claim still returns null.
  onClaimCandidate?.(claimedGalleryId);

  const result = await db.execute(
    `UPDATE download
        SET status = 'downloading', nativeRunId = ?
      WHERE galleryId = ?
        AND status = 'queued'
        AND queuePosition IS NOT NULL
        AND nativeRunId IS NULL`,
    [nativeRunId, claimedGalleryId],
  );
  if (result.changes === 0) return null;

  try {
    await persistDb();

    const rows = await db.query<DBDownload>(
      `SELECT ${SELECT_COLS}
         FROM download
        WHERE galleryId = ?`,
      [claimedGalleryId],
    );
    const claimed = rows[0] ?? null;
    if (claimed?.status === 'downloading' && (claimed.nativeRunId ?? null) === nativeRunId) {
      return claimed;
    }
    return null;
  } catch (error) {
    // The ownership UPDATE succeeded, but its persistence/readback did not. Do
    // not strand an invisible `downloading` row: release only this still-queued
    // claim. A concurrent pause/cancel changes the status or clears the queue
    // position and therefore wins this compensation CAS.
    await releaseDownloadClaim(claimedGalleryId, 'queued', nativeRunId).catch(() => {});
    throw error;
  }
}

/**
 * Release a claimed-before-handoff row without touching a newer lifecycle
 * state. Used for dequeue/read faults and other preparation failures.
 */
export async function releaseDownloadClaim(
  galleryId: number,
  status: 'queued' | 'paused' = 'queued',
  expectedNativeRunId: string | null = null,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = ?, nativeRunId = NULL
      WHERE galleryId = ?
        AND status = 'downloading'
        AND queuePosition IS NOT NULL
        AND nativeRunId IS ?`,
    [status, galleryId, expectedNativeRunId],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Pause a queued item. Keeps its queuePosition so resume restores its place.
 * A no-op if the row does not exist or is not 'queued'.
 */
export async function pauseQueued(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    "UPDATE download SET status = 'paused' WHERE galleryId = ? AND status = 'queued'",
    [galleryId],
  );
  await persistDb();
}

/**
 * Resume a paused item back into the active queue.
 * A no-op if the row does not exist or is not 'paused'.
 */
export async function resumeQueued(galleryId: number): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    "UPDATE download SET status = 'queued' WHERE galleryId = ? AND status = 'paused' AND nativeRunId IS NULL",
    [galleryId],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/** Resume a native-owned paused row only after that exact run was stopped. */
export async function resumePausedNativeRun(galleryId: number, runId: string): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'queued', nativeRunId = NULL
      WHERE galleryId = ?
        AND status = 'paused'
        AND nativeRunId = ?`,
    [galleryId, runId],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Remove an item from the queue by clearing its queuePosition.
 *
 * - If the row has stored pages (pageCount > 0) it is NOT deleted — the
 *   downloaded pages and its eventual library row are kept; only the queue
 *   position is cleared (the active-run lifecycle will set the final status).
 * - If the row is failed it is kept even at pageCount 0 so first-page failures
 *   remain visible in the library and can be retried.
 * - If the row has no pages and is not failed, the row is deleted entirely.
 */
export async function removeFromQueue(galleryId: number): Promise<void> {
  const db = await ensureDb();
  const row = await getDownload(galleryId);
  if (!row) return;
  if (row.pageCount > 0 && (row.status === 'queued' || row.status === 'paused')) {
    await db.execute(
      'UPDATE download SET status = ?, lastError = ?, queuePosition = NULL WHERE galleryId = ?',
      ['failed', null, galleryId],
    );
  } else if (row.pageCount > 0 || row.status === 'failed') {
    await db.execute('UPDATE download SET queuePosition = NULL WHERE galleryId = ?', [galleryId]);
  } else {
    await db.execute('DELETE FROM download WHERE galleryId = ?', [galleryId]);
  }
  await persistDb();
}

/**
 * Reorder a queued/paused item to a new queuePosition.
 * A no-op if the row does not exist. Does not renumber other rows — positions
 * are sparse and only the relative order matters.
 */
export async function reorderQueue(galleryId: number, newPos: number): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    "UPDATE download SET queuePosition = ? WHERE galleryId = ? AND status IN ('queued', 'paused')",
    [newPos, galleryId],
  );
  await persistDb();
}
