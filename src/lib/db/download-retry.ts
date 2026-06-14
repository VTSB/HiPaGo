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
 * Schedule the next automatic retry for a failed row.
 *
 * Sets `retryCount = attempt` and `nextRetryAt = dueAtISO` WHERE the row is
 * still 'failed'. Status is intentionally left 'failed' so the row stays in the
 * library/manager; the scheduler flips it to 'queued' when due. A no-op if the
 * row does not exist or is no longer 'failed' (e.g. a manual retry already
 * requeued it).
 */
export async function scheduleAutoRetry(
  galleryId: number,
  attempt: number,
  dueAtISO: string,
): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    "UPDATE download SET retryCount = ?, nextRetryAt = ? WHERE galleryId = ? AND status = 'failed'",
    [attempt, dueAtISO, galleryId],
  );
  await persistDb();
}

/**
 * List failed rows whose automatic retry is due (nextRetryAt <= now) and which
 * still have attempts left (retryCount < AUTO_RETRY_MAX). Ordered oldest-due
 * first so the longest-waiting item is retried first.
 */
export async function listDueAutoRetries(nowISO: string): Promise<DBDownload[]> {
  const db = await ensureDb();
  return db.query<DBDownload>(
    `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt
       FROM download
      WHERE status = 'failed'
        AND nextRetryAt IS NOT NULL
        AND nextRetryAt <= ?
        AND COALESCE(retryCount, 0) < ?
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
  await db.execute(
    'UPDATE download SET retryCount = 0, nextRetryAt = NULL WHERE galleryId = ?',
    [galleryId],
  );
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
        AND nextRetryAt IS NOT NULL
        AND COALESCE(retryCount, 0) < ?`,
    [AUTO_RETRY_MAX],
  );
  return rows[0]?.earliest ?? null;
}
