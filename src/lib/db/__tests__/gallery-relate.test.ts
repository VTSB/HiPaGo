import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import {
  saveGalleryRelated,
  getGalleryRelated,
  deleteGalleryRelated,
} from '../gallery-relate';

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
});

describe('saveGalleryRelated + getGalleryRelated', () => {
  it('saves and retrieves related IDs', async () => {
    await saveGalleryRelated(100, [201, 202, 203]);
    const result = await getGalleryRelated(100);
    expect(result).toEqual([201, 202, 203]);
  });

  it('replaces existing relations on re-save', async () => {
    await saveGalleryRelated(100, [201, 202]);
    await saveGalleryRelated(100, [301, 302, 303]);

    const result = await getGalleryRelated(100);
    expect(result).toEqual([301, 302, 303]);
  });

  it('returns empty array for non-existent gallery', async () => {
    const result = await getGalleryRelated(99999);
    expect(result).toEqual([]);
  });

  it('handles empty related array', async () => {
    await saveGalleryRelated(100, []);
    const result = await getGalleryRelated(100);
    expect(result).toEqual([]);
  });

  it('keeps relations for different galleries separate', async () => {
    await saveGalleryRelated(100, [201, 202]);
    await saveGalleryRelated(200, [301, 302]);

    expect(await getGalleryRelated(100)).toEqual([201, 202]);
    expect(await getGalleryRelated(200)).toEqual([301, 302]);
  });
});

describe('deleteGalleryRelated', () => {
  it('removes all entries for a gallery', async () => {
    await saveGalleryRelated(100, [201, 202, 203]);
    await deleteGalleryRelated(100);
    const result = await getGalleryRelated(100);
    expect(result).toEqual([]);
  });

  it('does not affect other galleries', async () => {
    await saveGalleryRelated(100, [201]);
    await saveGalleryRelated(200, [301]);
    await deleteGalleryRelated(100);

    expect(await getGalleryRelated(100)).toEqual([]);
    expect(await getGalleryRelated(200)).toEqual([301]);
  });

  it('handles deleting non-existent gallery gracefully', async () => {
    await expect(deleteGalleryRelated(99999)).resolves.not.toThrow();
  });
});
