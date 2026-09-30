import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, queryOne } from './test-db';
import { getDb } from '../adapter';
import {
  addToLibrary,
  removeFromLibrary,
  getLibraryIds,
  getCollections,
  getGalleryCollectionIds,
  createCollection,
  renameCollection,
  deleteCollection,
  addToCollection,
  removeFromCollection,
  getContinueReading,
  removeHistory,
  removeHistoryBatch,
  clearHistory,
} from '../library';
import { getDownload, upsertDownload } from '../download';
import { recordHistory, recordVisit, getReadingProgress } from '../gallery';

beforeAll(setupTestDb);
afterAll(teardownTestDb);
beforeEach(clearAllTables);

async function seedDownloaded(id: number) {
  await upsertDownload({
    galleryId: id,
    title: `Work ${id}`,
    thumbnail: '',
    tags: '{}',
    pageCount: 5,
    totalBytes: 200,
    downloadedAt: '2025-01-01',
    status: 'complete',
  });
}

describe('saved library membership', () => {
  it('deduplicates saves and preserves the original saved date', async () => {
    await getDb().execute('INSERT INTO favorites (galleryId, addedAt) VALUES (?, ?)', [
      1,
      '2020-01-01',
    ]);
    await addToLibrary(1);
    await addToLibrary(1);
    expect(await getLibraryIds()).toEqual([1]);
    expect(await queryOne('SELECT addedAt FROM favorites WHERE galleryId = ?', [1])).toEqual({
      addedAt: '2020-01-01',
    });
  });

  it('keeps download data and history when membership is removed', async () => {
    await addToLibrary(1);
    await seedDownloaded(1);
    await recordHistory(1, 2, 5, 'page');
    const collection = await createCollection('Reading');
    await addToCollection([1], collection);
    await removeFromLibrary(1);
    expect(await getLibraryIds()).toEqual([]);
    expect(await getGalleryCollectionIds(1)).toEqual([]);
    expect((await getDownload(1))?.pageCount).toBe(5);
    expect((await getReadingProgress(1))?.lastPage).toBe(2);
  });
});

describe('optional overlapping collections', () => {
  it('allows a work in several collections and one unique card in the library', async () => {
    const first = await createCollection('Reading');
    const second = await createCollection('Offline');
    await addToCollection([1, 1, 2], first);
    await addToCollection([1], second);
    await addToLibrary(3);
    expect(new Set(await getLibraryIds())).toEqual(new Set([1, 2, 3]));
    expect(await getLibraryIds({ collectionId: first })).toEqual([2, 1]);
    expect(await getLibraryIds({ collectionId: second })).toEqual([1]);
    expect(await getLibraryIds({ unclassified: true })).toEqual([3]);
    expect(await getCollections()).toEqual([
      { id: first, name: 'Reading', count: 2 },
      { id: second, name: 'Offline', count: 1 },
    ]);
    await removeFromCollection([1], first);
    expect(await getGalleryCollectionIds(1)).toEqual([second]);
    expect(await getLibraryIds({ collectionId: first })).toEqual([2]);
    expect(await getLibraryIds()).toContain(1);
  });

  it('renames and deletes a collection while keeping its works and files', async () => {
    const id = await createCollection('  Initial  ');
    await addToCollection([1], id);
    await seedDownloaded(1);
    await renameCollection(id, '  New name  ');
    expect((await getCollections())[0].name).toBe('New name');
    await deleteCollection(id);
    expect(await getCollections()).toEqual([]);
    expect(await getLibraryIds({ unclassified: true })).toEqual([1]);
    expect(await getDownload(1)).not.toBeNull();
  });

  it('rejects empty names and stale collection IDs without partially saving works', async () => {
    await expect(createCollection('   ')).rejects.toThrow();
    const id = await createCollection('Existing');
    await expect(renameCollection(id, '')).rejects.toThrow();
    await expect(addToCollection([1, 2], id + 100)).rejects.toThrow();
    expect(await getLibraryIds()).toEqual([]);
    expect((await getCollections())[0].name).toBe('Existing');
  });

  it('stores SQL punctuation as a literal collection name', async () => {
    const name = "Reader's shelf; DROP TABLE favorites;";
    await createCollection(name);
    await addToLibrary(1);
    expect((await getCollections())[0].name).toBe(name);
    expect(await getLibraryIds()).toEqual([1]);
  });
});

describe('continue reading and history lifetime', () => {
  it('rolls back every selected history deletion if a later record fails', async () => {
    await recordHistory(1, 2, 5, 'page');
    await recordHistory(2, 3, 5, 'scroll');
    await getDb().exec(
      "CREATE TEMP TRIGGER reject_history_delete BEFORE DELETE ON history WHEN OLD.galleryId = 2 BEGIN SELECT RAISE(ABORT, 'history delete failed'); END;",
    );
    try {
      await expect(removeHistoryBatch([1, 2])).rejects.toThrow('history delete failed');
      expect((await getReadingProgress(1))?.lastPage).toBe(2);
      expect((await getReadingProgress(2))?.lastPage).toBe(3);
    } finally {
      await getDb().exec('DROP TRIGGER reject_history_delete');
    }
    await removeHistoryBatch([1, 2]);
    expect(await getReadingProgress(1)).toBeNull();
    expect(await getReadingProgress(2)).toBeNull();
  });
  it('excludes visits, untouched first page and finished works and orders recent unfinished work', async () => {
    await recordVisit(1);
    await recordHistory(2, 0, 10, 'page');
    await recordHistory(3, 9, 10, 'page');
    await recordHistory(4, 5, 10, 'scroll');
    await recordHistory(5, 2, 20, 'page');
    await getDb().execute('UPDATE history SET viewedAt = ? WHERE galleryId = ?', ['2030-01-01', 4]);
    expect(await getContinueReading(1)).toEqual([{ galleryId: 4, lastPage: 5, totalPages: 10 }]);
    expect((await getContinueReading()).map((entry) => entry.galleryId)).toEqual([4, 5]);
    expect(await getContinueReading(0)).toEqual([]);
  });

  it('bounds the continue reading list even for excessive caller limits', async () => {
    for (let id = 1; id <= 25; id++) await recordHistory(id, 1, 10, 'page');
    expect(await getContinueReading(999)).toHaveLength(20);
    expect(await getContinueReading(-1)).toHaveLength(0);
    expect(await getContinueReading(NaN)).toHaveLength(8);
  });

  it('deleting history resets reading position and keeps saved membership/downloads', async () => {
    await addToLibrary(1);
    await seedDownloaded(1);
    await recordHistory(1, 2, 5, 'page');
    await recordHistory(2, 2, 5, 'page');
    await removeHistory(1);
    expect(await getReadingProgress(1)).toBeNull();
    expect(await getReadingProgress(2)).not.toBeNull();
    await clearHistory();
    expect(await getReadingProgress(2)).toBeNull();
    expect(await getLibraryIds()).toEqual([1]);
    expect(await getDownload(1)).not.toBeNull();
  });
});
