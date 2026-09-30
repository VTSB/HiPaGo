import { ensureDb, persistDb, withTransaction } from './adapter';

export interface LibraryCollection {
  id: number;
  name: string;
  parentId: number | null;
  count: number;
}

export class LibraryCollectionError extends Error {
  constructor(
    readonly code: 'name-empty' | 'missing' | 'cycle' | 'created-unsaved',
    message: string,
    readonly createdCollectionId?: number,
  ) {
    super(message);
    this.name = 'LibraryCollectionError';
  }
}

export interface ContinueReadingEntry {
  galleryId: number;
  lastPage: number;
  totalPages: number;
}

/** The existing favorites table remains the single saved-library authority. */
export async function addToLibrary(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    await db.execute('INSERT OR IGNORE INTO favorites (galleryId, addedAt) VALUES (?, ?)', [
      galleryId,
      new Date().toISOString(),
    ]);
  });
  await persistDb();
}

/** Remove membership and classification. Download files are owned by the caller. */
export async function removeFromLibrary(galleryId: number): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    await db.execute('DELETE FROM library_collection_item WHERE galleryId = ?', [galleryId]);
    await db.execute('DELETE FROM favorites WHERE galleryId = ?', [galleryId]);
  });
  await persistDb();
}

export async function getLibraryIds(
  options: { collectionId?: number; unclassified?: boolean } = {},
): Promise<number[]> {
  const db = await ensureDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.collectionId !== undefined) {
    conditions.push(
      'EXISTS (SELECT 1 FROM library_collection_item i WHERE i.galleryId = f.galleryId AND i.collectionId = ?)',
    );
    params.push(options.collectionId);
  }
  if (options.unclassified) {
    conditions.push(
      'NOT EXISTS (SELECT 1 FROM library_collection_item i WHERE i.galleryId = f.galleryId)',
    );
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.query<{ galleryId: number }>(
    `SELECT f.galleryId FROM favorites f ${where} ORDER BY f.addedAt DESC, f.galleryId DESC`,
    params,
  );
  return rows.map((row) => row.galleryId);
}

export async function getCollections(): Promise<LibraryCollection[]> {
  const db = await ensureDb();
  return db.query<LibraryCollection>(`
    SELECT c.id, c.name, c.parentId, COUNT(f.galleryId) AS count
      FROM library_collection c
      LEFT JOIN library_collection_item i ON i.collectionId = c.id
      LEFT JOIN favorites f ON f.galleryId = i.galleryId
      GROUP BY c.id, c.name, c.parentId ORDER BY c.id ASC
  `);
}

export async function getGalleryCollectionIds(galleryId: number): Promise<number[]> {
  const db = await ensureDb();
  const rows = await db.query<{ collectionId: number }>(
    'SELECT collectionId FROM library_collection_item WHERE galleryId = ? ORDER BY collectionId ASC',
    [galleryId],
  );
  return rows.map((row) => row.collectionId);
}

function collectionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new LibraryCollectionError('name-empty', 'Collection name cannot be empty.');
  return trimmed;
}

export async function createCollection(
  name: string,
  parentId: number | null = null,
): Promise<number> {
  const db = await ensureDb();
  const result = await withTransaction(async () => {
    if (parentId !== null) {
      const rows = await db.query<{ id: number }>(
        'SELECT id FROM library_collection WHERE id = ?',
        [parentId],
      );
      if (!rows.length) throw new LibraryCollectionError('missing', 'Collection no longer exists.');
    }
    return db.execute('INSERT INTO library_collection (name, parentId) VALUES (?, ?)', [
      collectionName(name),
      parentId,
    ]);
  });
  try {
    await persistDb();
  } catch (failure) {
    throw new LibraryCollectionError(
      'created-unsaved',
      failure instanceof Error ? failure.message : String(failure),
      result.lastInsertRowId,
    );
  }
  return result.lastInsertRowId;
}

export async function renameCollection(collectionId: number, name: string): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    const result = await db.execute('UPDATE library_collection SET name = ? WHERE id = ?', [
      collectionName(name),
      collectionId,
    ]);
    if (!result.changes)
      throw new LibraryCollectionError('missing', 'Collection no longer exists.');
  });
  await persistDb();
}

export async function moveCollection(collectionId: number, parentId: number | null): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    const rows = await db.query<{ id: number; parentId: number | null }>(
      'SELECT id, parentId FROM library_collection',
    );
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    if (!parents.has(collectionId) || (parentId !== null && !parents.has(parentId))) {
      throw new LibraryCollectionError('missing', 'Collection no longer exists.');
    }
    const visited = new Set<number>();
    let ancestor = parentId;
    while (ancestor !== null) {
      if (ancestor === collectionId || visited.has(ancestor)) {
        throw new LibraryCollectionError(
          'cycle',
          'Collection cannot be moved into itself or a descendant.',
        );
      }
      visited.add(ancestor);
      const nextParent = parents.get(ancestor);
      if (nextParent === undefined)
        throw new LibraryCollectionError('missing', 'Collection no longer exists.');
      ancestor = nextParent;
    }
    await db.execute('UPDATE library_collection SET parentId = ? WHERE id = ?', [
      parentId,
      collectionId,
    ]);
  });
  await persistDb();
}

/** Deleting a collection never removes its saved works or local files. */
export async function deleteCollection(collectionId: number): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    const rows = await db.query<{ parentId: number | null }>(
      'SELECT parentId FROM library_collection WHERE id = ?',
      [collectionId],
    );
    if (!rows.length) throw new LibraryCollectionError('missing', 'Collection no longer exists.');
    await db.execute('UPDATE library_collection SET parentId = ? WHERE parentId = ?', [
      rows[0].parentId,
      collectionId,
    ]);
    await db.execute('DELETE FROM library_collection_item WHERE collectionId = ?', [collectionId]);
    await db.execute('DELETE FROM library_collection WHERE id = ?', [collectionId]);
  });
  await persistDb();
}

/** Classifying a work also saves it, without replacing its original saved date. */
export async function addToCollection(galleryIds: number[], collectionId: number): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    const rows = await db.query<{ id: number }>('SELECT id FROM library_collection WHERE id = ?', [
      collectionId,
    ]);
    if (!rows.length) throw new Error('Collection no longer exists.');
    const addedAt = new Date().toISOString();
    for (const galleryId of new Set(galleryIds)) {
      await db.execute('INSERT OR IGNORE INTO favorites (galleryId, addedAt) VALUES (?, ?)', [
        galleryId,
        addedAt,
      ]);
      await db.execute(
        'INSERT OR IGNORE INTO library_collection_item (collectionId, galleryId) VALUES (?, ?)',
        [collectionId, galleryId],
      );
    }
  });
  await persistDb();
}

export async function removeFromCollection(
  galleryIds: number[],
  collectionId: number,
): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    for (const galleryId of new Set(galleryIds)) {
      await db.execute(
        'DELETE FROM library_collection_item WHERE collectionId = ? AND galleryId = ?',
        [collectionId, galleryId],
      );
    }
  });
  await persistDb();
}

export async function getContinueReading(limit = 8): Promise<ContinueReadingEntry[]> {
  const db = await ensureDb();
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.min(20, Math.floor(limit))) : 8;
  return db.query<ContinueReadingEntry>(
    `
    SELECT galleryId, lastPage, totalPages FROM history
      WHERE lastPage > 0 AND totalPages > 0 AND lastPage < totalPages - 1
      ORDER BY viewedAt DESC, galleryId DESC LIMIT ?
  `,
    [boundedLimit],
  );
}

/** History also owns the reading position; callers must communicate that reset. */
export async function removeHistory(galleryId: number): Promise<void> {
  await removeHistoryBatch([galleryId]);
}

/** A failed selected deletion leaves every history record and reading position intact. */
export async function removeHistoryBatch(galleryIds: number[]): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    for (const galleryId of new Set(galleryIds)) {
      await db.execute('DELETE FROM history WHERE galleryId = ?', [galleryId]);
    }
  });
  await persistDb();
}

export async function clearHistory(): Promise<void> {
  const db = await ensureDb();
  await withTransaction(async () => {
    await db.execute('DELETE FROM history');
  });
  await persistDb();
}
