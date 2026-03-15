import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, countRows, queryAll } from './test-db';
import { getDb } from '../adapter';
import {
  saveGalleryBlock,
  getGalleryBlock,
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavoriteIds,
  recordHistory,
  getRecentlyViewedIds,
  getReadingProgress,
  saveGalleryImages,
  getGalleryImages,
  hasGalleryImages,
  deleteGalleryImages,
  cleanupStaleCache,
} from '../gallery';
import { GalleryBlockType, TagType } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile } from '@/lib/utils/types';

const sampleBlock: GalleryBlock = {
  id: 12345,
  type: GalleryBlockType.DETAILED,
  title: 'Test Gallery',
  date: new Date('2024-01-15T12:30:00Z'),
  tags: { [TagType.ARTIST]: ['artist1'], [TagType.TAG]: ['tag1', 'tag2'] },
  thumbnail: '/api/img/tn/avifsmalltn/a/bc/hash.avif',
  related: [111, 222, 333],
};

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
});

describe('saveGalleryBlock + getGalleryBlock', () => {
  it('should save a block and retrieve it by ID with all fields matching', async () => {
    await saveGalleryBlock(sampleBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(sampleBlock.id);
    expect(retrieved!.type).toBe(sampleBlock.type);
    expect(retrieved!.title).toBe(sampleBlock.title);
    expect(retrieved!.date.toISOString()).toBe(sampleBlock.date.toISOString());
    expect(retrieved!.thumbnail).toBe(sampleBlock.thumbnail);
  });

  it('should preserve tags when saving and retrieving', async () => {
    await saveGalleryBlock(sampleBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.tags).toEqual(sampleBlock.tags);
    expect(retrieved!.tags[TagType.ARTIST]).toEqual(['artist1']);
    expect(retrieved!.tags[TagType.TAG]).toEqual(['tag1', 'tag2']);
  });

  it('should preserve related array when saving and retrieving', async () => {
    await saveGalleryBlock(sampleBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.related).toEqual([111, 222, 333]);
  });

  it('should preserve date (stored as ISO string, returned as Date)', async () => {
    await saveGalleryBlock(sampleBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.date).toBeInstanceOf(Date);
    expect(retrieved!.date.getTime()).toBe(sampleBlock.date.getTime());
  });

  it('should return null for non-existent ID', async () => {
    const retrieved = await getGalleryBlock(99999);
    expect(retrieved).toBeNull();
  });

  it('should persist language and mediaType when saving and retrieving', async () => {
    const blockWithMeta: GalleryBlock = {
      ...sampleBlock,
      id: 55555,
      language: 'japanese',
      mediaType: 'doujinshi',
    };
    await saveGalleryBlock(blockWithMeta);
    const retrieved = await getGalleryBlock(55555);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.language).toBe('japanese');
    expect(retrieved!.mediaType).toBe('doujinshi');
  });

  it('should return empty strings for language and mediaType when not set', async () => {
    await saveGalleryBlock(sampleBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.language).toBe('');
    expect(retrieved!.mediaType).toBe('');
  });

  it('should update when saving twice with same ID (upsert behavior)', async () => {
    await saveGalleryBlock(sampleBlock);

    const updatedBlock: GalleryBlock = {
      ...sampleBlock,
      title: 'Updated Title',
      tags: { [TagType.ARTIST]: ['artist2'] },
    };

    await saveGalleryBlock(updatedBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Updated Title');
    expect(retrieved!.tags[TagType.ARTIST]).toEqual(['artist2']);

    // Verify only one record exists
    const count = await countRows('gallery');
    expect(count).toBe(1);
  });
});

describe('addFavorite + removeFavorite + isFavorite', () => {
  it('should return true after adding a favorite', async () => {
    const galleryId = 12345;
    await addFavorite(galleryId);
    const result = await isFavorite(galleryId);
    expect(result).toBe(true);
  });

  it('should return false when not favorited', async () => {
    const galleryId = 12345;
    const result = await isFavorite(galleryId);
    expect(result).toBe(false);
  });

  it('should return false after removing a favorite', async () => {
    const galleryId = 12345;
    await addFavorite(galleryId);
    await removeFavorite(galleryId);
    const result = await isFavorite(galleryId);
    expect(result).toBe(false);
  });

  it('should be idempotent when adding same ID twice', async () => {
    const galleryId = 12345;
    await addFavorite(galleryId);
    await addFavorite(galleryId);

    const rows = await queryAll<{ galleryId: number }>(
      'SELECT galleryId FROM favorites WHERE galleryId = ?',
      [galleryId],
    );
    expect(rows.length).toBe(1);
  });

  it('should safely handle removing non-existent favorite', async () => {
    const galleryId = 12345;
    await expect(removeFavorite(galleryId)).resolves.not.toThrow();
    const result = await isFavorite(galleryId);
    expect(result).toBe(false);
  });
});

describe('getFavoriteIds', () => {
  it('should return empty array when no favorites', async () => {
    const ids = await getFavoriteIds();
    expect(ids).toEqual([]);
  });

  it('should return IDs in reverse chronological order (newest first)', async () => {
    await addFavorite(111);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await addFavorite(222);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await addFavorite(333);

    const ids = await getFavoriteIds();
    expect(ids).toEqual([333, 222, 111]);
  });

  it('should return multiple IDs correctly', async () => {
    await addFavorite(100);
    await addFavorite(200);
    await addFavorite(300);

    const ids = await getFavoriteIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain(100);
    expect(ids).toContain(200);
    expect(ids).toContain(300);
  });
});

describe('recordHistory + getRecentlyViewedIds + getReadingProgress', () => {
  it('should create new history entry and retrieve reading progress', async () => {
    const galleryId = 12345;
    await recordHistory(galleryId, 5, 20, 'vertical');

    const progress = await getReadingProgress(galleryId);
    expect(progress).not.toBeNull();
    expect(progress!.lastPage).toBe(5);
    expect(progress!.totalPages).toBe(20);
    expect(progress!.readerMode).toBe('vertical');
  });

  it('should update existing entry when recording history for same galleryId', async () => {
    const galleryId = 12345;
    await recordHistory(galleryId, 5, 20, 'vertical');
    await recordHistory(galleryId, 10, 20, 'horizontal');

    const progress = await getReadingProgress(galleryId);
    expect(progress).not.toBeNull();
    expect(progress!.lastPage).toBe(10);
    expect(progress!.readerMode).toBe('horizontal');

    // Verify only one record exists
    const count = await countRows('history');
    expect(count).toBe(1);
  });

  it('should return IDs in reverse chronological order', async () => {
    await recordHistory(111, 1, 10, 'vertical');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordHistory(222, 2, 15, 'horizontal');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordHistory(333, 3, 20, 'vertical');

    const ids = await getRecentlyViewedIds();
    expect(ids).toEqual([333, 222, 111]);
  });

  it('should respect limit parameter in getRecentlyViewedIds', async () => {
    await recordHistory(111, 1, 10, 'vertical');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordHistory(222, 2, 15, 'horizontal');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordHistory(333, 3, 20, 'vertical');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await recordHistory(444, 4, 25, 'vertical');

    const ids = await getRecentlyViewedIds(2);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual([444, 333]);
  });

  it('should return null for non-existent gallery in getReadingProgress', async () => {
    const progress = await getReadingProgress(99999);
    expect(progress).toBeNull();
  });

  it('should return correct lastPage, totalPages, and readerMode', async () => {
    const galleryId = 12345;
    await recordHistory(galleryId, 15, 30, 'webtoon');

    const progress = await getReadingProgress(galleryId);
    expect(progress).not.toBeNull();
    expect(progress!.lastPage).toBe(15);
    expect(progress!.totalPages).toBe(30);
    expect(progress!.readerMode).toBe('webtoon');
  });
});

describe('FAILED block DB behavior', () => {
  it('getGalleryBlock should return null for FAILED rows in DB', async () => {
    const db = getDb();
    // Insert a FAILED block directly via SQL
    await db.execute(
      `INSERT INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [999, GalleryBlockType.FAILED, 'Failed Block', new Date().toISOString(), '', '', new Date().toISOString()],
    );

    const result = await getGalleryBlock(999);
    expect(result).toBeNull();
  });

  it('cleanupStaleCache should delete FAILED rows', async () => {
    const db = getDb();
    // Insert a FAILED block directly
    await db.execute(
      `INSERT INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [888, GalleryBlockType.FAILED, 'Failed Block', new Date().toISOString(), '', '', new Date().toISOString()],
    );
    // Insert related junction rows
    await db.execute('INSERT INTO gallery_tag (id, tagId) VALUES (?, ?)', [888, 1]);
    await db.execute('INSERT INTO gallery_relate (id, related) VALUES (?, ?)', [888, 1]);

    await cleanupStaleCache();

    // FAILED block should be deleted
    const rows = await queryAll<{ id: number }>('SELECT id FROM gallery WHERE id = ?', [888]);
    expect(rows).toHaveLength(0);

    // Orphaned junction rows should also be deleted
    const tagRows = await queryAll<{ id: number }>('SELECT id FROM gallery_tag WHERE id = ?', [888]);
    expect(tagRows).toHaveLength(0);
    const relateRows = await queryAll<{ id: number }>('SELECT id FROM gallery_relate WHERE id = ?', [888]);
    expect(relateRows).toHaveLength(0);
  });
});

describe('getGalleryBlock updatedAt field', () => {
  it('should return updatedAt as a Date instance', async () => {
    await saveGalleryBlock(sampleBlock);
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.updatedAt).toBeInstanceOf(Date);
  });

  it('should return updatedAt close to now after saving', async () => {
    const before = Date.now();
    await saveGalleryBlock(sampleBlock);
    const after = Date.now();
    const retrieved = await getGalleryBlock(sampleBlock.id);

    expect(retrieved!.updatedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(retrieved!.updatedAt!.getTime()).toBeLessThanOrEqual(after + 100);
  });
});

describe('galleryImages CRUD', () => {
  const sampleFiles: GalleryFile[] = [
    { width: 1280, height: 1800, haswebp: 1, hasavif: 1, hasavifsmalltn: 1, name: '001.jpg', hash: 'abc123' },
    { width: 1280, height: 1800, haswebp: 1, hasavif: 0, hasavifsmalltn: 0, name: '002.png', hash: 'def456' },
    { width: 800, height: 600, haswebp: 0, hasavif: 0, hasavifsmalltn: 0, name: '003.gif', hash: 'ghi789' },
  ];

  it('saves and retrieves gallery images', async () => {
    await saveGalleryImages(12345, sampleFiles);
    const result = await getGalleryImages(12345);
    expect(result).toHaveLength(3);
    expect(result![0].name).toBe('001.jpg');
    expect(result![0].hasavif).toBe(1);
    expect(result![0].haswebp).toBe(1);
    expect(result![2].name).toBe('003.gif');
    expect(result![2].hasavif).toBe(0);
  });

  it('preserves page order', async () => {
    await saveGalleryImages(12345, sampleFiles);
    const result = await getGalleryImages(12345);
    expect(result![0].name).toBe('001.jpg');
    expect(result![1].name).toBe('002.png');
    expect(result![2].name).toBe('003.gif');
  });

  it('returns null for non-existent gallery', async () => {
    const result = await getGalleryImages(99999);
    expect(result).toBeNull();
  });

  it('replaces existing images on re-save', async () => {
    await saveGalleryImages(12345, sampleFiles);
    const newFiles: GalleryFile[] = [
      { width: 100, height: 100, haswebp: 0, hasavif: 0, hasavifsmalltn: 0, name: 'new.jpg', hash: 'new123' },
    ];
    await saveGalleryImages(12345, newFiles);
    const result = await getGalleryImages(12345);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('new.jpg');
  });

  it('hasGalleryImages returns true when images exist', async () => {
    await saveGalleryImages(12345, sampleFiles);
    expect(await hasGalleryImages(12345)).toBe(true);
  });

  it('hasGalleryImages returns false when no images', async () => {
    expect(await hasGalleryImages(99999)).toBe(false);
  });

  it('deleteGalleryImages removes all images for gallery', async () => {
    await saveGalleryImages(12345, sampleFiles);
    await deleteGalleryImages(12345);
    expect(await hasGalleryImages(12345)).toBe(false);
  });

  it('preserves all format flags correctly', async () => {
    await saveGalleryImages(12345, sampleFiles);
    const result = await getGalleryImages(12345);
    expect(result![0].hasavif).toBe(1);
    expect(result![0].haswebp).toBe(1);
    expect(result![0].hasavifsmalltn).toBe(1);
    expect(result![1].hasavif).toBe(0);
    expect(result![1].haswebp).toBe(1);
    expect(result![1].hasavifsmalltn).toBe(0);
    expect(result![2].hasavif).toBe(0);
    expect(result![2].haswebp).toBe(0);
    expect(result![2].hasavifsmalltn).toBe(0);
  });
});
