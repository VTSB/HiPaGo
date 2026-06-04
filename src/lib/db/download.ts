import { ensureDb, persistDb } from './adapter';
import type { DBDownload, DownloadStatus } from './schema';

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
       (galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
  await persistDb();
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
}

/**
 * Update pageCount and totalBytes for an in-progress download row.
 * A no-op if the galleryId does not exist.
 */
export async function updateDownloadProgress(
  galleryId: number,
  pageCount: number,
  totalBytes: number,
): Promise<void> {
  const db = await ensureDb();
  await db.execute(
    'UPDATE download SET pageCount = ?, totalBytes = ? WHERE galleryId = ?',
    [pageCount, totalBytes, galleryId],
  );
  await persistDb();
}

/**
 * Update the folderName of an existing download row.
 * A no-op if the galleryId does not exist.
 */
export async function setDownloadFolderName(
  galleryId: number,
  folderName: string,
): Promise<void> {
  const db = await ensureDb();
  await db.execute('UPDATE download SET folderName = ? WHERE galleryId = ?', [folderName, galleryId]);
  await persistDb();
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
  await db.execute(
    'UPDATE download SET folderName = ?, migratedAt = ? WHERE galleryId = ?',
    [folderName, migratedAt, galleryId],
  );
  await persistDb();
}

/**
 * Delete a download row by galleryId.
 * A no-op if the row does not exist.
 */
export async function deleteDownload(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await db.execute('DELETE FROM download WHERE galleryId = ?', [galleryId]);
  await persistDb();
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
    'SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError FROM download WHERE galleryId = ?',
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
    'SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError FROM download ORDER BY downloadedAt DESC',
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
  const sql = `SELECT galleryId, title, thumbnail, tags, pageCount, totalBytes, downloadedAt, status, folderName, migratedAt, lastError FROM download ${where} ORDER BY downloadedAt DESC`;

  return db.query<DBDownload>(sql, params);
}
