/**
 * Auto-retry helpers for staged auto-restart of failed downloads (Task E).
 *
 * A genuine gallery failure (not a user cancel) is scheduled to retry on an
 * escalating-backoff schedule, up to a fixed attempt cap, then left 'failed'
 * for manual retry only. Auto-retry state lives on the `download` row itself
 * (migration v7): `retryCount` (auto-attempts used) + `nextRetryAt` (ISO, when
 * the next auto attempt is due).
 *
 * Crucially a row awaiting auto-retry stays `status='failed'` — so it still
 * surfaces in the library/manager (now annotated "auto-retry in N"). The
 * scheduler converts it to 'queued' when due; `dequeueNextQueued` (which only
 * picks 'queued') is unchanged.
 */
import { ensureDb, persistDb } from './adapter';
import type { DBDownload } from './schema';

/**
 * Escalating backoff between automatic attempts: 30s, 5min, 30min.
 * Index by the CURRENT retryCount (0-based) to get the delay before the next
 * attempt. Length === AUTO_RETRY_MAX.
 */
export const AUTO_RETRY_BACKOFF_MS = [30_000, 300_000, 1_800_000] as const;

/** Maximum number of automatic restart attempts before giving up (manual only). */
export const AUTO_RETRY_MAX = 3;

/**
 * Atomically turn one exact failed-row snapshot into a user-priority retry.
 * Unlike enqueueDownload's metadata upsert, this cannot overwrite a due retry
 * or native claim that won after the UI rendered its stale failed item.
 * Native-owned failures must first prove that exact run stopped and clear its
 * token; callers should then re-read the row and pass the tokenless snapshot.
 */
export async function retryDownloadIfUnchanged(expected: DBDownload): Promise<boolean> {
  if (expected.status !== 'failed' || expected.nativeRunId != null) return false;
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'queued',
            lastError = NULL,
            queuePosition = COALESCE(
              (SELECT MIN(q.queuePosition) - 1
                 FROM download AS q
                WHERE q.status IN ('queued', 'paused')
                  AND q.queuePosition IS NOT NULL),
              0
            ),
            retryCount = 0,
            nextRetryAt = NULL,
            nativeRunId = NULL
      WHERE galleryId = ?
        AND status = 'failed'
        AND title = ?
        AND thumbnail = ?
        AND tags = ?
        AND pageCount = ?
        AND totalBytes = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS NULL`,
    [
      expected.galleryId,
      expected.title,
      expected.thumbnail,
      expected.tags,
      expected.pageCount,
      expected.totalBytes,
      expected.downloadedAt,
      expected.folderName ?? null,
      expected.lastError ?? null,
      expected.queuePosition ?? null,
      expected.retryCount ?? null,
      expected.nextRetryAt ?? null,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Atomically queue a complete gallery whose physical integrity check found
 * missing pages. Unlike the metadata UPSERT used for a brand-new download,
 * this requires the exact rendered complete row to still exist and therefore
 * cannot recreate it after a concurrent delete.
 */
export async function redownloadCompleteIfUnchanged(expected: DBDownload): Promise<boolean> {
  if (expected.status !== 'complete' || expected.nativeRunId != null) return false;
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'queued',
            lastError = NULL,
            queuePosition = COALESCE(
              (SELECT MIN(q.queuePosition) - 1
                 FROM download AS q
                WHERE q.status IN ('queued', 'paused')
                  AND q.queuePosition IS NOT NULL),
              0
            ),
            retryCount = 0,
            nextRetryAt = NULL,
            nativeRunId = NULL
      WHERE galleryId = ?
        AND status = 'complete'
        AND title = ?
        AND thumbnail = ?
        AND tags = ?
        AND pageCount = ?
        AND totalBytes = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS NULL`,
    [
      expected.galleryId,
      expected.title,
      expected.thumbnail,
      expected.tags,
      expected.pageCount,
      expected.totalBytes,
      expected.downloadedAt,
      expected.folderName ?? null,
      expected.lastError ?? null,
      expected.queuePosition ?? null,
      expected.retryCount ?? null,
      expected.nextRetryAt ?? null,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Recreate a zero-page retry only if exact native cancellation deleted the old
 * row and no replacement has appeared. The INSERT predicate prevents a late UI
 * action from overwriting a concurrently queued/native replacement.
 */
export async function retryDownloadIfAbsent(source: DBDownload): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `INSERT INTO download
       (galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt,
        status, folderName, migratedAt, lastError, queuePosition, retryCount,
        nextRetryAt, nativeRunId)
     SELECT ?, ?, ?, ?, 0, 0, ?, 'queued', ?, ?, NULL,
            COALESCE(
              (SELECT MIN(q.queuePosition) - 1
                 FROM download AS q
                WHERE q.status IN ('queued', 'paused')
                  AND q.queuePosition IS NOT NULL),
              0
            ),
            0, NULL, NULL
      WHERE NOT EXISTS (SELECT 1 FROM download WHERE galleryId = ?)`,
    [
      source.galleryId,
      source.title,
      source.thumbnail,
      source.tags,
      new Date().toISOString(),
      source.folderName ?? null,
      source.migratedAt ?? null,
      source.galleryId,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Schedule the next automatic retry for a failed row.
 *
 * Sets `retryCount = attempt` and `nextRetryAt = dueAtISO` WHERE the row is
 * still 'failed'. Status is intentionally left 'failed' so the row stays in the
 * library/manager; the scheduler flips it to 'queued' when due. A no-op if the
 * row does not exist, is no longer 'failed', or its retry counter no longer
 * matches the caller's snapshot (e.g. a manual/newer retry won the race).
 * Returns true only when the conditional update changed the row.
 */
export async function scheduleAutoRetry(
  expected: DBDownload,
  attempt: number,
  dueAtISO: string,
): Promise<boolean> {
  if (expected.status !== 'failed') return false;
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET retryCount = ?, nextRetryAt = ?
      WHERE galleryId = ?
        AND status = 'failed'
        AND pageCount = ?
        AND totalBytes = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS ?`,
    [
      attempt,
      dueAtISO,
      expected.galleryId,
      expected.pageCount,
      expected.totalBytes,
      expected.downloadedAt,
      expected.folderName ?? null,
      expected.lastError ?? null,
      expected.queuePosition ?? null,
      expected.retryCount ?? null,
      expected.nextRetryAt ?? null,
      expected.nativeRunId ?? null,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Atomically turn one exact due-retry snapshot into a queued row.
 *
 * The due list is only a snapshot: while its caller awaits network/DB work the
 * user may delete the row or manually retry it. Updating the existing failed
 * row with an exact retry-count/time predicate prevents that stale snapshot
 * from recreating or overwriting the user's newer state.
 */
export async function requeueDueAutoRetry(row: DBDownload): Promise<boolean> {
  // A failed row may still be owned by a native worker when launch
  // reconciliation could not confirm an exact stop.  Never turn that row
  // back into a second queued writer; reconciliation must clear the token
  // first after proving the native run is gone.
  if (!row.nextRetryAt || row.nativeRunId != null) return false;
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'queued',
            lastError = NULL,
            nativeRunId = NULL,
            queuePosition = COALESCE(
              queuePosition,
              (SELECT COALESCE(MAX(q.queuePosition), 0) + 1
                 FROM download AS q
                WHERE q.status IN ('queued', 'paused')
                  AND q.queuePosition IS NOT NULL)
            ),
            nextRetryAt = NULL
      WHERE galleryId = ?
        AND status = 'failed'
        AND pageCount = ?
        AND totalBytes = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS NULL`,
    [
      row.galleryId,
      row.pageCount,
      row.totalBytes,
      row.downloadedAt,
      row.folderName ?? null,
      row.lastError ?? null,
      row.queuePosition ?? null,
      row.retryCount ?? null,
      row.nextRetryAt,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * Atomically recover an interrupted active row at launch. Unlike the previous
 * read followed by INSERT OR REPLACE, this can never resurrect a row deleted
 * after the launch snapshot was read.
 */
export async function requeueInterruptedDownload(row: DBDownload): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'queued',
            lastError = NULL,
            nativeRunId = NULL,
            queuePosition = COALESCE(
              queuePosition,
              (SELECT COALESCE(MAX(q.queuePosition), 0) + 1
                 FROM download AS q
                WHERE q.status IN ('queued', 'paused')
                  AND q.queuePosition IS NOT NULL)
            )
      WHERE galleryId = ?
        AND status = 'downloading'
        AND pageCount = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS ?`,
    [
      row.galleryId,
      row.pageCount,
      row.downloadedAt,
      row.folderName ?? null,
      row.queuePosition ?? null,
      row.retryCount ?? null,
      row.nextRetryAt ?? null,
      row.nativeRunId ?? null,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  return true;
}

/**
 * List failed rows whose automatic retry is due (nextRetryAt <= now) and whose
 * scheduled attempt number is within the cap (retryCount <= AUTO_RETRY_MAX).
 * Ordered oldest-due first so the longest-waiting item is retried first.
 */
export async function listDueAutoRetries(nowISO: string): Promise<DBDownload[]> {
  const db = await ensureDb();
  return db.query<DBDownload>(
    `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId
       FROM download
      WHERE status = 'failed'
        AND nativeRunId IS NULL
        AND nextRetryAt IS NOT NULL
        AND nextRetryAt <= ?
        AND COALESCE(retryCount, 0) <= ?
      ORDER BY nextRetryAt ASC`,
    [nowISO, AUTO_RETRY_MAX],
  );
}

/**
 * Clear the auto-retry state of a row (reset the counter). Used by the manual
 * retry path so a manual Retry gives the gallery a fresh set of automatic
 * attempts. Sets `retryCount = 0` and `nextRetryAt = NULL`. A no-op if the row
 * does not exist.
 */
export async function clearAutoRetry(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE download SET retryCount = 0, nextRetryAt = NULL WHERE galleryId = ?', [
    galleryId,
  ]);
  await persistDb();
}

/**
 * The earliest pending `nextRetryAt` across failed rows that still have
 * attempts left — used to arm the single store-level scheduler timer. Returns
 * null when nothing is awaiting auto-retry.
 */
export async function earliestNextRetryAt(): Promise<string | null> {
  const db = await ensureDb();
  const rows = await db.query<{ earliest: string | null }>(
    `SELECT MIN(nextRetryAt) AS earliest
      FROM download
      WHERE status = 'failed'
        AND nativeRunId IS NULL
        AND nextRetryAt IS NOT NULL
        AND COALESCE(retryCount, 0) <= ?`,
    [AUTO_RETRY_MAX],
  );
  return rows[0]?.earliest ?? null;
}
