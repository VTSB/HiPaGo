import { ensureDb, persistDb, withTransaction } from './adapter';
import type { DBDownload, DownloadStatus } from './schema';
import { notifyDownloadCatalogChanged } from '@/lib/storage/public-backup-events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize a tag map (Record<string, string[]>) to the JSON string stored in the DB. */
export function serializeTags(tags: Record<string, string[]>): string {
  return JSON.stringify(tags);
}

/** Deserialize the JSON tag string from the DB back to a tag map. */
export function deserializeTags(raw: string): Record<string, string[]> {
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Insert or replace a download row.
 * Use this to record a new download or fully overwrite an existing one.
 * folderName and migratedAt are stored as NULL when not provided.
 */
export async function upsertDownload(row: DBDownload): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    `INSERT OR REPLACE INTO download
       (galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.galleryId,
      row.title,
      row.thumbnail,
      row.tags,
      row.pageCount,
      row.totalBytes,
      row.downloadedAt,
      row.status,
      row.folderName ?? null,
      row.migratedAt ?? null,
      row.lastError ?? null,
      row.queuePosition ?? null,
      row.retryCount ?? null,
      row.nextRetryAt ?? null,
      row.nativeRunId ?? null,
    ],
  );
  await persistDb();
  notifyDownloadCatalogChanged();
}

/**
 * Restore a catalog row discovered on disk without overwriting a lifecycle that
 * was created or replaced while filesystem scanning was in flight.
 *
 * `expected === null` uses INSERT OR IGNORE, so a concurrent new row wins. An
 * existing inactive row is replaced only when every persisted field still
 * matches the scan's snapshot. This is the restore-specific CAS boundary; it
 * must never be implemented with INSERT OR REPLACE.
 */
export async function restoreDownloadIfUnchanged(
  expected: DBDownload | null,
  restored: DBDownload,
): Promise<boolean> {
  const db = await ensureDb();
  const restoredValues = [
    restored.galleryId,
    restored.title,
    restored.thumbnail,
    restored.tags,
    restored.pageCount,
    restored.totalBytes,
    restored.downloadedAt,
    restored.status,
    restored.folderName ?? null,
    restored.migratedAt ?? null,
    restored.lastError ?? null,
    restored.queuePosition ?? null,
    restored.retryCount ?? null,
    restored.nextRetryAt ?? null,
    restored.nativeRunId ?? null,
  ];
  const result =
    expected === null
      ? await db.execute(
          `INSERT OR IGNORE INTO download
             (galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          restoredValues,
        )
      : await db.execute(
          `UPDATE download
              SET title = ?,
                  thumbnail = ?,
                  tags = ?,
                  pageCount = ?,
                  totalBytes = ?,
                  downloadedAt = ?,
                  status = ?,
                  folderName = ?,
                  migratedAt = ?,
                  lastError = ?,
                  queuePosition = ?,
                  retryCount = ?,
                  nextRetryAt = ?,
                  nativeRunId = ?
            WHERE galleryId = ?
              AND title = ?
              AND thumbnail = ?
              AND tags = ?
              AND pageCount = ?
              AND totalBytes = ?
              AND downloadedAt = ?
              AND status = ?
              AND folderName IS ?
              AND migratedAt IS ?
              AND lastError IS ?
              AND queuePosition IS ?
              AND retryCount IS ?
              AND nextRetryAt IS ?
              AND nativeRunId IS ?`,
          [
            ...restoredValues.slice(1),
            expected.galleryId,
            expected.title,
            expected.thumbnail,
            expected.tags,
            expected.pageCount,
            expected.totalBytes,
            expected.downloadedAt,
            expected.status,
            expected.folderName ?? null,
            expected.migratedAt ?? null,
            expected.lastError ?? null,
            expected.queuePosition ?? null,
            expected.retryCount ?? null,
            expected.nextRetryAt ?? null,
            expected.nativeRunId ?? null,
          ],
        );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Delete a catalog row only while every persisted field still matches the
 * snapshot whose backing files were checked.
 *
 * Filesystem reads can take long enough for a retry, replacement, or native
 * worker to start for the same gallery. Matching the complete row keeps a late
 * missing-manifest result from deleting that newer lifecycle.
 */
export async function deleteDownloadIfUnchanged(expected: DBDownload): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `DELETE FROM download
      WHERE galleryId = ?
        AND title = ?
        AND thumbnail = ?
        AND tags = ?
        AND pageCount = ?
        AND totalBytes = ?
        AND downloadedAt = ?
        AND status = ?
        AND folderName IS ?
        AND migratedAt IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS ?`,
    [
      expected.galleryId,
      expected.title,
      expected.thumbnail,
      expected.tags,
      expected.pageCount,
      expected.totalBytes,
      expected.downloadedAt,
      expected.status,
      expected.folderName ?? null,
      expected.migratedAt ?? null,
      expected.lastError ?? null,
      expected.queuePosition ?? null,
      expected.retryCount ?? null,
      expected.nextRetryAt ?? null,
      expected.nativeRunId ?? null,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Atomically lease an unchanged catalog snapshot while its legacy files are
 * migrated, then commit the public-folder watermark only after storage work
 * succeeds.
 *
 * The full-row UPDATE is intentionally executed before `commitStorage`, but it
 * remains uncommitted while the callback runs. The database operation lane and
 * SQLite write transaction prevent a retry/replacement from taking ownership
 * between the snapshot check, target writes, legacy-source deletion, and the
 * final DB commit. Returning false rolls the watermark back; a thrown storage
 * error also rolls it back and is propagated.
 */
export async function commitDownloadMigrationIfUnchanged(
  expected: DBDownload,
  folderName: string,
  migratedAt: string,
  commitStorage: () => Promise<boolean>,
): Promise<boolean> {
  const abortStorageCommit = {};
  let changed = false;

  try {
    await withTransaction(async (db) => {
      if (db.supportsExplicitTransactions === false) {
        throw new Error('download migration requires explicit database transactions');
      }
      const result = await db.execute(
        `UPDATE download
            SET folderName = ?, migratedAt = ?
          WHERE galleryId = ?
            AND title = ?
            AND thumbnail = ?
            AND tags = ?
            AND pageCount = ?
            AND totalBytes = ?
            AND downloadedAt = ?
            AND status = ?
            AND folderName IS ?
            AND migratedAt IS ?
            AND lastError IS ?
            AND queuePosition IS ?
            AND retryCount IS ?
            AND nextRetryAt IS ?
            AND nativeRunId IS ?`,
        [
          folderName,
          migratedAt,
          expected.galleryId,
          expected.title,
          expected.thumbnail,
          expected.tags,
          expected.pageCount,
          expected.totalBytes,
          expected.downloadedAt,
          expected.status,
          expected.folderName ?? null,
          expected.migratedAt ?? null,
          expected.lastError ?? null,
          expected.queuePosition ?? null,
          expected.retryCount ?? null,
          expected.nextRetryAt ?? null,
          expected.nativeRunId ?? null,
        ],
      );
      if (result.changes === 0) return;
      if (!(await commitStorage())) throw abortStorageCommit;
      changed = true;
    });
  } catch (error) {
    if (error === abortStorageCommit) return false;
    throw error;
  }

  if (!changed) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Mark an existing download complete only when its lifecycle fields still match
 * the snapshot whose files were verified.
 *
 * This deliberately uses UPDATE rather than INSERT OR REPLACE: a delayed
 * manifest check must never recreate a row the user deleted. The snapshot
 * predicates also stop an older check from overwriting a cancel, retry, pause,
 * or replacement run that won while filesystem IO was in flight.
 */
export async function completeDownloadIfUnchanged(
  expected: DBDownload,
  completedPageCount: number,
  migratedAt?: string | null,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET pageCount = ?,
            status = 'complete',
            queuePosition = NULL,
            retryCount = 0,
            nextRetryAt = NULL,
            lastError = NULL,
            nativeRunId = NULL,
            migratedAt = COALESCE(?, migratedAt)
      WHERE galleryId = ?
        AND status = ?
        AND pageCount = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS ?`,
    [
      completedPageCount,
      migratedAt ?? null,
      expected.galleryId,
      expected.status,
      expected.pageCount,
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
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Persist the target metadata for a native-owned attempt without replacing the
 * row. The run token is installed by the queue claim before this call, so a
 * concurrent cancel/retry/replacement wins instead of being resurrected by an
 * `INSERT OR REPLACE`.
 */
export async function prepareNativeDownloadRun(
  galleryId: number,
  runId: string,
  target: { pageCount: number; totalBytes: number; folderName: string },
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET pageCount = ?,
            totalBytes = ?,
            folderName = ?,
            lastError = NULL,
            nextRetryAt = NULL
      WHERE galleryId = ?
        AND status = 'downloading'
        AND nativeRunId = ?`,
    [target.pageCount, target.totalBytes, target.folderName, galleryId, runId],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Reassert the active state for a foreground attempt that shares ownership with
 * a native backstop. The status predicate is intentional: a delayed resume must
 * not revive a run that was paused, failed, or completed while filesystem IO was
 * in flight.
 */
export async function resumeNativeDownloadRun(galleryId: number, runId: string): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'downloading', lastError = NULL
      WHERE galleryId = ?
        AND status = 'downloading'
        AND nativeRunId = ?`,
    [galleryId, runId],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Checkpoint progress only for the concrete active native attempt. Returning
 * false tells the foreground downloader that ownership moved to another run (or
 * reached a terminal state) while its file write was awaiting completion.
 */
export async function updateNativeDownloadProgress(
  galleryId: number,
  runId: string,
  pageCount: number,
  totalBytes: number,
  options: { persist?: boolean } = {},
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET pageCount = MAX(pageCount, ?), totalBytes = ?
      WHERE galleryId = ?
        AND status = 'downloading'
        AND nativeRunId = ?`,
    [pageCount, totalBytes, galleryId, runId],
  );
  if (result.changes === 0) return false;
  if (options.persist ?? true) {
    await persistDb();
    notifyDownloadCatalogChanged();
  }
  return true;
}

/** Adopt a discovered native attempt only while the DB row is still unchanged. */
export async function adoptNativeRunIfUnchanged(
  expected: DBDownload,
  runId: string,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET nativeRunId = ?
      WHERE galleryId = ?
        AND status = ?
        AND pageCount = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS NULL`,
    [
      runId,
      expected.galleryId,
      expected.status,
      expected.pageCount,
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
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Rebind an unchanged launch snapshot to the native run that is actually
 * present on disk. This is used by reconciliation instead of cancelling a
 * discovered run from a stale DB read; a concurrent replacement makes the CAS
 * lose and remains untouched.
 */
export async function adoptDiscoveredNativeRunIfUnchanged(
  expected: DBDownload,
  runId: string,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'downloading',
            nativeRunId = ?,
            lastError = NULL,
            queuePosition = NULL,
            nextRetryAt = NULL
      WHERE galleryId = ?
        AND status = ?
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
      runId,
      expected.galleryId,
      expected.status,
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
  notifyDownloadCatalogChanged();
  return true;
}

/** Rebind native identity while preserving an unchanged terminal/paused state. */
export async function rebindNativeRunIfUnchanged(
  expected: DBDownload,
  runId: string,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET nativeRunId = ?
      WHERE galleryId = ?
        AND status = ?
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
      runId,
      expected.galleryId,
      expected.status,
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
  notifyDownloadCatalogChanged();
  return true;
}

/** Clear native ownership only while the complete launch snapshot is unchanged. */
export async function clearNativeRunIfUnchanged(expected: DBDownload): Promise<boolean> {
  if (!expected.nativeRunId) return false;
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET nativeRunId = NULL
      WHERE galleryId = ?
        AND status = ?
        AND pageCount = ?
        AND totalBytes = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId = ?`,
    [
      expected.galleryId,
      expected.status,
      expected.pageCount,
      expected.totalBytes,
      expected.downloadedAt,
      expected.folderName ?? null,
      expected.lastError ?? null,
      expected.queuePosition ?? null,
      expected.retryCount ?? null,
      expected.nextRetryAt ?? null,
      expected.nativeRunId,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/** Fail a legacy/tokenless native row only while its launch snapshot still matches. */
export async function failDownloadIfUnchanged(
  expected: DBDownload,
  message: string,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = 'failed',
            lastError = ?,
            queuePosition = NULL,
            nativeRunId = NULL
      WHERE galleryId = ?
        AND status = ?
        AND pageCount = ?
        AND downloadedAt = ?
        AND folderName IS ?
        AND lastError IS ?
        AND queuePosition IS ?
        AND retryCount IS ?
        AND nextRetryAt IS ?
        AND nativeRunId IS ?`,
    [
      message,
      expected.galleryId,
      expected.status,
      expected.pageCount,
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
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Change one native-owned row only if it still belongs to `runId`.
 * Terminal callers normally clear both the queue slot and ownership token in
 * the same statement, preventing a late A cleanup from mutating replacement B.
 */
export async function transitionNativeDownloadRun(
  galleryId: number,
  runId: string,
  status: DownloadStatus,
  lastError: string | null,
  options: {
    clearRunId?: boolean;
    clearQueuePosition?: boolean;
    ensureQueuePosition?: boolean;
  } = {},
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET status = ?,
            lastError = ?,
            queuePosition = CASE
              WHEN ? = 1 THEN NULL
              WHEN ? = 1 THEN COALESCE(
                queuePosition,
                (SELECT COALESCE(MAX(d.queuePosition), 0) + 1
                   FROM download AS d
                  WHERE d.status IN ('queued', 'paused')
                    AND d.queuePosition IS NOT NULL)
              )
              ELSE queuePosition
            END,
            nativeRunId = CASE WHEN ? = 1 THEN NULL ELSE nativeRunId END
      WHERE galleryId = ?
        AND nativeRunId = ?`,
    [
      status,
      lastError,
      options.clearQueuePosition === false ? 0 : 1,
      options.ensureQueuePosition ? 1 : 0,
      options.clearRunId === false ? 0 : 1,
      galleryId,
      runId,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Commit a foreground/native-coordinated attempt without overwriting a newer
 * run. Ownership stays attached until the caller confirms the matching native
 * backstop was cancelled; this also lets a cancel/pause arriving during the DB
 * await re-apply its terminal state with the exact token.
 */
export async function completeNativeDownloadRun(row: DBDownload, runId: string): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    `UPDATE download
        SET title = ?,
            thumbnail = ?,
            tags = ?,
            pageCount = ?,
            totalBytes = ?,
            downloadedAt = ?,
            status = 'complete',
            folderName = ?,
            migratedAt = COALESCE(?, migratedAt),
            lastError = NULL,
            queuePosition = NULL,
            retryCount = 0,
            nextRetryAt = NULL
      WHERE galleryId = ?
        AND status = 'downloading'
        AND nativeRunId = ?`,
    [
      row.title,
      row.thumbnail,
      row.tags,
      row.pageCount,
      row.totalBytes,
      row.downloadedAt,
      row.folderName ?? null,
      row.migratedAt ?? null,
      row.galleryId,
      runId,
    ],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/** Clear an attempt token without touching a replacement run. */
export async function clearNativeRunIfMatches(galleryId: number, runId: string): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute(
    'UPDATE download SET nativeRunId = NULL WHERE galleryId = ? AND nativeRunId = ?',
    [galleryId, runId],
  );
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/** Delete an empty cancelled attempt without deleting a replacement row. */
export async function deleteDownloadIfNativeRunMatches(
  galleryId: number,
  runId: string,
): Promise<boolean> {
  const db = await ensureDb();
  const result = await db.execute('DELETE FROM download WHERE galleryId = ? AND nativeRunId = ?', [
    galleryId,
    runId,
  ]);
  if (result.changes === 0) return false;
  await persistDb();
  notifyDownloadCatalogChanged();
  return true;
}

/**
 * Update only the status of an existing download row.
 * A no-op if the galleryId does not exist.
 */
export async function updateDownloadStatus(
  galleryId: number,
  status: DownloadStatus,
): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE download SET status = ? WHERE galleryId = ?', [status, galleryId]);
  await persistDb();
  notifyDownloadCatalogChanged();
}

/**
 * Update the status and failure reason of an existing download row in one write.
 * Pass `lastError` = null to clear the reason (e.g. when a retry succeeds).
 * A no-op if the galleryId does not exist.
 */
export async function setDownloadError(
  galleryId: number,
  status: DownloadStatus,
  lastError: string | null,
): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE download SET status = ?, lastError = ? WHERE galleryId = ?', [
    status,
    lastError,
    galleryId,
  ]);
  await persistDb();
  notifyDownloadCatalogChanged();
}

/**
 * Update pageCount and totalBytes for an in-progress download row. pageCount is
 * monotonic so a native target count written before handoff is not shrunk by
 * foreground progressive updates.
 * A no-op if the galleryId does not exist.
 */
export async function updateDownloadProgress(
  galleryId: number,
  pageCount: number,
  totalBytes: number,
  options: { persist?: boolean } = {},
): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    'UPDATE download SET pageCount = MAX(pageCount, ?), totalBytes = ? WHERE galleryId = ?',
    [pageCount, totalBytes, galleryId],
  );
  if (options.persist ?? true) {
    await persistDb();
    notifyDownloadCatalogChanged();
  }
}

/**
 * Update the folderName of an existing download row.
 * A no-op if the galleryId does not exist.
 */
export async function setDownloadFolderName(galleryId: number, folderName: string): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE download SET folderName = ? WHERE galleryId = ?', [
    folderName,
    galleryId,
  ]);
  await persistDb();
  notifyDownloadCatalogChanged();
}

/**
 * Mark a download as migrated by setting folderName and migratedAt.
 * A no-op if the galleryId does not exist.
 */
export async function markDownloadMigrated(
  galleryId: number,
  folderName: string,
  migratedAt: string,
): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE download SET folderName = ?, migratedAt = ? WHERE galleryId = ?', [
    folderName,
    migratedAt,
    galleryId,
  ]);
  await persistDb();
  notifyDownloadCatalogChanged();
}

/**
 * Delete a download row by galleryId.
 * A no-op if the row does not exist.
 */
export async function deleteDownload(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('DELETE FROM download WHERE galleryId = ?', [galleryId]);
  await persistDb();
  notifyDownloadCatalogChanged();
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Retrieve a single download row by galleryId.
 * Returns null if not found.
 */
export async function getDownload(galleryId: number): Promise<DBDownload | null> {
  const db = await ensureDb();
  const rows = await db.query<DBDownload>(
    'SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId FROM download WHERE galleryId = ?',
    [galleryId],
  );
  return rows[0] ?? null;
}

/**
 * List all download rows, ordered by most recently downloaded first.
 */
export async function listDownloads(): Promise<DBDownload[]> {
  const db = await ensureDb();
  return db.query<DBDownload>(
    'SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId FROM download ORDER BY downloadedAt DESC',
  );
}

/**
 * List the rows that belong in the offline LIBRARY view: completed, actively
 * downloading, or failed downloads — ordered by most recently downloaded first.
 *
 * Queue-only states ('queued'/'paused') are excluded so they never leak into the
 * library list as phantom rows (they surface in the download-manager UI instead).
 * This keeps the library list visually identical to the pre-queue behavior.
 */
export async function listLibraryDownloads(): Promise<DBDownload[]> {
  const db = await ensureDb();
  return db.query<DBDownload>(
    `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId
       FROM download
      WHERE status IN ('complete', 'downloading', 'failed')
      ORDER BY downloadedAt DESC`,
  );
}

/**
 * Search downloaded items by title (case-insensitive substring) and/or tags.
 *
 * - `query` matches against the title field (LIKE).
 * - `tagQuery` matches against the serialized tags JSON (LIKE).
 *
 * Either parameter may be omitted; passing both narrows the results.
 * Results are ordered by most recently downloaded first.
 *
 * AC-006 consumes this function for "search within downloads".
 */
export async function searchDownloads(options: {
  query?: string;
  tagQuery?: string;
}): Promise<DBDownload[]> {
  const db = await ensureDb();

  const { query, tagQuery } = options;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query && query.trim() !== '') {
    conditions.push('title LIKE ?');
    params.push(`%${query.trim()}%`);
  }

  if (tagQuery && tagQuery.trim() !== '') {
    conditions.push('tags LIKE ?');
    params.push(`%${tagQuery.trim()}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError, queuePosition, retryCount, nextRetryAt, nativeRunId FROM download ${where} ORDER BY downloadedAt DESC`;

  return db.query<DBDownload>(sql, params);
}
