import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import { getDb } from '../adapter';
import {
  searchLocalTags,
  searchLocalGalleryIdsByTag,
  searchLocalGalleryIdsByTitle,
  searchLocalGalleryIds,
  hasLocalSearchData,
} from '../search-local';
import { TagType, TAG_TYPE_TO_BYTE } from '@/lib/utils/types';

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
});

async function seedTags() {
  const db = getDb();
  const r1 = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'artist_alpha', 100]);
  const r2 = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.ARTIST], 'artist_beta', 50]);
  const r3 = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.SERIES], 'art_series', 200]);
  const r4 = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'action', 500]);
  const r5 = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.FEMALE], 'armor', 30]);
  return {
    artistTag1: r1.lastInsertRowId,
    artistTag2: r2.lastInsertRowId,
    seriesTag: r3.lastInsertRowId,
    tag1: r4.lastInsertRowId,
    femaleTag: r5.lastInsertRowId,
  };
}

async function seedGalleries(tagIds: Record<string, number>) {
  const db = getDb();
  await db.execute(
    "INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [100, 1, 'Art Collection Vol 1', '2024-01-01', '', '', ''],
  );
  await db.execute(
    "INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [200, 1, 'Battle Arena', '2024-02-01', '', '', ''],
  );
  await db.execute(
    "INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [300, 1, 'Comic Series Alpha', '2024-03-01', '', '', ''],
  );
  await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [100, tagIds.artistTag1]);
  await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [100, tagIds.tag1]);
  await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [200, tagIds.artistTag1]);
  await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [200, tagIds.artistTag2]);
  await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [300, tagIds.seriesTag]);
}

describe('searchLocalTags', () => {
  it('prefix match returns matching tags', async () => {
    await seedTags();
    const results = await searchLocalTags('art');
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(names).toContain('artist_beta');
    expect(names).toContain('art_series');
    expect(names).not.toContain('action');
    expect(names).not.toContain('armor');
  });

  it('tagType filter restricts results', async () => {
    await seedTags();
    const results = await searchLocalTags('art', TagType.ARTIST);
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(names).toContain('artist_beta');
    expect(names).not.toContain('art_series');
    results.forEach((r) => expect(r.tagType).toBe(TagType.ARTIST));
  });

  it('results sorted by count descending', async () => {
    await seedTags();
    const results = await searchLocalTags('art');
    expect(results[0].amount).toBeGreaterThanOrEqual(results[1].amount);
    expect(results[1].amount).toBeGreaterThanOrEqual(results[2].amount);
  });

  it('limit parameter works', async () => {
    await seedTags();
    const results = await searchLocalTags('a', undefined, 2);
    expect(results.length).toBe(2);
  });

  it('i18n name match returns suggestions via tag join', async () => {
    const tagIds = await seedTags();
    await getDb().execute('INSERT INTO tag_i18n (tagId, local) VALUES (?, ?)', [tagIds.artistTag1, 'アーティスト']);
    const results = await searchLocalTags('アーティ');
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(results.some((r) => r.tagType === TagType.ARTIST)).toBe(true);
  });

  it('i18n match respects tagType filter', async () => {
    const tagIds = await seedTags();
    await getDb().execute('INSERT INTO tag_i18n (tagId, local) VALUES (?, ?)', [tagIds.artistTag1, 'ローカル名']);
    await getDb().execute('INSERT INTO tag_i18n (tagId, local) VALUES (?, ?)', [tagIds.seriesTag, 'ローカルシリーズ']);

    const results = await searchLocalTags('ローカル', TagType.ARTIST);
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(names).not.toContain('art_series');
    results.forEach((r) => expect(r.tagType).toBe(TagType.ARTIST));
  });
});

describe('searchLocalGalleryIdsByTag', () => {
  it('returns gallery IDs for exact tag match in descending order', async () => {
    const tagIds = await seedTags();
    await seedGalleries(tagIds);
    const ids = await searchLocalGalleryIdsByTag(TagType.ARTIST, 'artist_alpha');
    expect(ids).toEqual([200, 100]);
  });

  it('returns IDs for tag shared across galleries', async () => {
    const tagIds = await seedTags();
    await seedGalleries(tagIds);
    const ids = await searchLocalGalleryIdsByTag(TagType.ARTIST, 'artist_beta');
    expect(ids).toEqual([200]);
  });

  it('returns empty array for non-existent tag', async () => {
    await seedTags();
    const ids = await searchLocalGalleryIdsByTag(TagType.ARTIST, 'nonexistent');
    expect(ids).toEqual([]);
  });
});

describe('searchLocalGalleryIdsByTitle', () => {
  it('partial title match case-insensitive', async () => {
    const tagIds = await seedTags();
    await seedGalleries(tagIds);
    const ids = await searchLocalGalleryIdsByTitle('art');
    expect(ids).toContain(100);
    expect(ids).not.toContain(200);
    expect(ids).not.toContain(300);
  });

  it('no match returns empty', async () => {
    const tagIds = await seedTags();
    await seedGalleries(tagIds);
    const ids = await searchLocalGalleryIdsByTitle('zzzzz');
    expect(ids).toEqual([]);
  });
});

describe('searchLocalGalleryIds', () => {
  it('tagType query returns tag-matched gallery IDs', async () => {
    const tagIds = await seedTags();
    await seedGalleries(tagIds);
    const ids = await searchLocalGalleryIds('artist:artist_alpha');
    expect(ids).toEqual([200, 100]);
  });

  it('general query merges tag + title results with dedup', async () => {
    const tagIds = await seedTags();
    await seedGalleries(tagIds);
    const ids = await searchLocalGalleryIds('art');
    expect(ids).toContain(100);
    expect(ids).toContain(200);
    expect(ids).toContain(300);
    const unique = [...new Set(ids)];
    expect(ids.length).toBe(unique.length);
    for (let i = 0; i < ids.length - 1; i++) {
      expect(ids[i]).toBeGreaterThanOrEqual(ids[i + 1]);
    }
  });

  it('title-only match when no tags match', async () => {
    await getDb().execute(
      "INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [400, 1, 'Unique Title XYZ', '2024-04-01', '', '', ''],
    );
    const ids = await searchLocalGalleryIds('unique title');
    expect(ids).toContain(400);
  });

  it('empty db returns empty array', async () => {
    const ids = await searchLocalGalleryIds('anything');
    expect(ids).toEqual([]);
  });
});

describe('hasLocalSearchData', () => {
  it('returns true when tags exist', async () => {
    await seedTags();
    expect(await hasLocalSearchData()).toBe(true);
  });

  it('returns false on empty db', async () => {
    expect(await hasLocalSearchData()).toBe(false);
  });
});
