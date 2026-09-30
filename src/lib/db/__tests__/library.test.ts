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
  moveCollection,
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
      { id: first, name: 'Reading', parentId: null, count: 2 },
      { id: second, name: 'Offline', parentId: null, count: 1 },
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

describe('nested collection folders', () => {
  it('creates roots and nested folders with direct counts and overlapping membership', async () => {
    const root = await createCollection('Root');
    const child = await createCollection('  Child  ', root);
    const leaf = await createCollection('Leaf', child);
    await addToCollection([1], root);
    await addToCollection([1, 2], child);
    await addToCollection([3], leaf);
    expect(await getCollections()).toEqual([
      { id: root, name: 'Root', parentId: null, count: 1 },
      { id: child, name: 'Child', parentId: root, count: 2 },
      { id: leaf, name: 'Leaf', parentId: child, count: 1 },
    ]);
    expect(await getLibraryIds({ collectionId: root })).toEqual([1]);
    expect(await getGalleryCollectionIds(1)).toEqual([root, child]);
    expect(new Set(await getLibraryIds())).toEqual(new Set([1, 2, 3]));
  });

  it('moves a subtree between folders and back to root without changing memberships', async () => {
    const first = await createCollection('First');
    const second = await createCollection('Second', null);
    const child = await createCollection('Child', first);
    const leaf = await createCollection('Leaf', child);
    await addToCollection([1], child);
    await moveCollection(child, second);
    expect((await getCollections()).find((folder) => folder.id === child)?.parentId).toBe(second);
    expect((await getCollections()).find((folder) => folder.id === leaf)?.parentId).toBe(child);
    await moveCollection(child, null);
    expect((await getCollections()).find((folder) => folder.id === child)?.parentId).toBeNull();
    expect(await getGalleryCollectionIds(1)).toEqual([child]);
  });

  it('rejects stale parents, stale sources and self/descendant moves atomically', async () => {
    const root = await createCollection('Root');
    const child = await createCollection('Child', root);
    const leaf = await createCollection('Leaf', child);
    await addToCollection([1], leaf);
    const before = await getCollections();
    await expect(createCollection('Stale parent', leaf + 100)).rejects.toThrow();
    await expect(renameCollection(leaf + 100, 'Stale source')).rejects.toThrow();
    await expect(deleteCollection(leaf + 100)).rejects.toThrow();
    await expect(moveCollection(root + 100, null)).rejects.toThrow();
    await expect(moveCollection(child, leaf + 100)).rejects.toThrow();
    await expect(moveCollection(root, root)).rejects.toThrow();
    await expect(moveCollection(root, leaf)).rejects.toThrow();
    expect(await getCollections()).toEqual(before);
    expect(await getGalleryCollectionIds(1)).toEqual([leaf]);
    await expect(renameCollection(root, 'Root')).resolves.toBeUndefined();
  });

  it('promotes only direct children when deleting nested and root folders, preserving works/files', async () => {
    const root = await createCollection('Root');
    const branch = await createCollection('Branch', root);
    const child = await createCollection('Child', branch);
    const sibling = await createCollection('Sibling', branch);
    const leaf = await createCollection('Leaf', child);
    await addToCollection([1, 2], branch);
    await addToCollection([1], child);
    await seedDownloaded(2);
    await deleteCollection(branch);
    expect(await getCollections()).toEqual([
      { id: root, name: 'Root', parentId: null, count: 0 },
      { id: child, name: 'Child', parentId: root, count: 1 },
      { id: sibling, name: 'Sibling', parentId: root, count: 0 },
      { id: leaf, name: 'Leaf', parentId: child, count: 0 },
    ]);
    expect(await getGalleryCollectionIds(1)).toEqual([child]);
    expect(await getLibraryIds({ unclassified: true })).toEqual([2]);
    expect(await getDownload(2)).not.toBeNull();
    await deleteCollection(root);
    expect(
      (await getCollections())
        .filter((folder) => folder.parentId === null)
        .map((folder) => folder.id),
    ).toEqual([child, sibling]);
    expect((await getCollections()).find((folder) => folder.id === leaf)?.parentId).toBe(child);
  });

  it('rolls back folder promotion and classifications when the folder DELETE fails in SQLite', async () => {
    const root = await createCollection('Root');
    const branch = await createCollection('Branch', root);
    const child = await createCollection('Child', branch);
    await addToCollection([1], branch);
    const before = await getCollections();
    await getDb().exec(
      `CREATE TEMP TRIGGER reject_folder_delete BEFORE DELETE ON library_collection WHEN OLD.id = ${branch} BEGIN SELECT RAISE(ABORT, 'folder delete failed'); END;`,
    );
    try {
      await expect(deleteCollection(branch)).rejects.toThrow('folder delete failed');
      expect(await getCollections()).toEqual(before);
      expect(await getGalleryCollectionIds(1)).toEqual([branch]);
      expect(await getLibraryIds()).toEqual([1]);
    } finally {
      await getDb().exec('DROP TRIGGER reject_folder_delete');
    }
    await deleteCollection(branch);
    expect((await getCollections()).find((folder) => folder.id === child)?.parentId).toBe(root);
    expect(await getGalleryCollectionIds(1)).toEqual([]);
  });

  it('rolls back all direct-child changes if one promotion fails in SQLite', async () => {
    const root = await createCollection('Root');
    const branch = await createCollection('Branch', root);
    await createCollection('First child', branch);
    const second = await createCollection('Second child', branch);
    await addToCollection([1], branch);
    const before = await getCollections();
    await getDb().exec(
      `CREATE TEMP TRIGGER reject_folder_promotion BEFORE UPDATE OF parentId ON library_collection WHEN OLD.id = ${second} BEGIN SELECT RAISE(ABORT, 'promotion failed'); END;`,
    );
    try {
      await expect(deleteCollection(branch)).rejects.toThrow('promotion failed');
      expect(await getCollections()).toEqual(before);
      expect(await getGalleryCollectionIds(1)).toEqual([branch]);
    } finally {
      await getDb().exec('DROP TRIGGER reject_folder_promotion');
    }
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
