import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import { getDb } from '../adapter';
import {
  searchLocalTags,
  searchLocalGalleryIdsByTag,
  searchLocalGalleryIdsByTitle,
  hasLocalSearchData,
} from '../search-local';
import { TagType, TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import { useTagI18nStore } from '@/lib/store/tag-i18n';

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

  it('returns localName from TagI18nStore when i18n is loaded', async () => {
    await seedTags();
    // Populate TagI18nStore with a Korean name for artist_alpha
    useTagI18nStore.setState({
      nameToLocal: new Map([['artist:artist_alpha', '아티스트알파']]),
      localToNames: new Map([['아티스트알파', ['artist:artist_alpha']]]),
      isLoaded: true,
    });

    const results = await searchLocalTags('art');
    const match = results.find((r) => r.tag === 'artist_alpha');
    expect(match).toBeDefined();
    expect(match?.localName).toBe('아티스트알파');

    // Cleanup store
    useTagI18nStore.setState({ nameToLocal: new Map(), localToNames: new Map(), isLoaded: false });
  });

  it('Korean query uses TagI18nStore.searchByLocal', async () => {
    await seedTags();
    // Populate TagI18nStore with Korean names
    useTagI18nStore.setState({
      nameToLocal: new Map([
        ['artist:artist_alpha', '아티스트알파'],
        ['series:art_series', '아트시리즈'],
      ]),
      localToNames: new Map([
        ['아티스트알파', ['artist:artist_alpha']],
        ['아트시리즈', ['series:art_series']],
      ]),
      isLoaded: true,
    });

    const results = await searchLocalTags('아티스트');
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(results.some((r) => r.tagType === TagType.ARTIST)).toBe(true);

    useTagI18nStore.setState({ nameToLocal: new Map(), localToNames: new Map(), isLoaded: false });
  });

  it('Korean query with tagType filter uses TagI18nStore.searchByLocal filtered', async () => {
    await seedTags();
    useTagI18nStore.setState({
      nameToLocal: new Map([
        ['artist:artist_alpha', '로컬이름'],
        ['series:art_series', '로컬시리즈'],
      ]),
      localToNames: new Map([
        ['로컬이름', ['artist:artist_alpha']],
        ['로컬시리즈', ['series:art_series']],
      ]),
      isLoaded: true,
    });

    const results = await searchLocalTags('로컬', TagType.ARTIST);
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(names).not.toContain('art_series');
    results.forEach((r) => expect(r.tagType).toBe(TagType.ARTIST));

    useTagI18nStore.setState({ nameToLocal: new Map(), localToNames: new Map(), isLoaded: false });
  });

  it('초성 query returns matching results via TagI18nStore', async () => {
    await seedTags();
    // '아티스트알파' choseong is 'ㅇㅌㅅㅌㅇㅍ'
    useTagI18nStore.setState({
      nameToLocal: new Map([['artist:artist_alpha', '아티스트알파']]),
      localToNames: new Map([['아티스트알파', ['artist:artist_alpha']]]),
      isLoaded: true,
    });

    // searchByLocal in the store handles 초성 matching with es-hangul getChoseong
    // We test that a 초성 prefix query works end-to-end
    const results = await searchLocalTags('ㅇㅌㅅ');
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');

    useTagI18nStore.setState({ nameToLocal: new Map(), localToNames: new Map(), isLoaded: false });
  });

  it('without i18n loaded still returns English-only results', async () => {
    await seedTags();
    // Ensure store is not loaded
    useTagI18nStore.setState({ nameToLocal: new Map(), localToNames: new Map(), isLoaded: false });

    const results = await searchLocalTags('art');
    const names = results.map((r) => r.tag);
    expect(names).toContain('artist_alpha');
    expect(names).toContain('art_series');
    // localName should be undefined when store not loaded
    results.forEach((r) => expect(r.localName).toBeUndefined());
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


describe('hasLocalSearchData', () => {
  it('returns true when tags exist', async () => {
    await seedTags();
    expect(await hasLocalSearchData()).toBe(true);
  });

  it('returns false on empty db', async () => {
    expect(await hasLocalSearchData()).toBe(false);
  });
});

describe('searchLocalTags search query hybrid ranking (JS sort)', () => {
  it('search results rank count=0 tags by local gallery_tag frequency', async () => {
    const db = getDb();
    // bear: count=50, no gallery_tag links needed
    const rBear = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'bear', 50]);
    // beauty: count=0, 10 gallery_tag links
    const rBeauty = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'beauty', 0]);
    const beautyId = rBeauty.lastInsertRowId;
    // beast: count=0, 3 gallery_tag links
    const rBeast = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'beast', 0]);
    const beastId = rBeast.lastInsertRowId;

    for (let i = 1; i <= 10; i++) {
      await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [7000 + i, 1, `G${i}`, '2024-01-01', '', '', '']);
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [7000 + i, beautyId]);
    }
    for (let i = 1; i <= 3; i++) {
      await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [8000 + i, 1, `G${i}`, '2024-01-01', '', '', '']);
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [8000 + i, beastId]);
    }

    const results = await searchLocalTags('bea');
    const names = results.map((r) => r.tag);
    const idxBear = names.indexOf('bear');
    const idxBeauty = names.indexOf('beauty');
    const idxBeast = names.indexOf('beast');

    expect(idxBear).toBeGreaterThanOrEqual(0);
    expect(idxBeauty).toBeGreaterThanOrEqual(0);
    expect(idxBeast).toBeGreaterThanOrEqual(0);
    // bear (50) before beauty (10 local) before beast (3 local)
    expect(idxBear).toBeLessThan(idxBeauty);
    expect(idxBeauty).toBeLessThan(idxBeast);
  });

  it('count=0 tags without gallery_tag links rank last in search', async () => {
    const db = getDb();
    // abc: count=0, no gallery_tag
    await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'abc', 0]);
    // abd: count=0, 5 gallery_tag links
    const rAbd = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'abd', 0]);
    const abdId = rAbd.lastInsertRowId;

    for (let i = 1; i <= 5; i++) {
      await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [9000 + i, 1, `G${i}`, '2024-01-01', '', '', '']);
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [9000 + i, abdId]);
    }

    const results = await searchLocalTags('ab');
    const names = results.map((r) => r.tag);
    const idxAbc = names.indexOf('abc');
    const idxAbd = names.indexOf('abd');

    expect(idxAbc).toBeGreaterThanOrEqual(0);
    expect(idxAbd).toBeGreaterThanOrEqual(0);
    // abd (5 local refs) before abc (0 refs)
    expect(idxAbd).toBeLessThan(idxAbc);
  });
});

describe('searchLocalTags empty query hybrid ranking', () => {
  it('ranks count>0 tags above count=0 tags', async () => {
    const db = getDb();
    // Tag A: count=100
    const rA = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'tag_a', 100]);
    const tagAId = rA.lastInsertRowId;
    // Tag B: count=0, linked to 5 galleries
    const rB = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'tag_b', 0]);
    const tagBId = rB.lastInsertRowId;
    // Tag C: count=0, linked to 2 galleries
    const rC = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'tag_c', 0]);
    const tagCId = rC.lastInsertRowId;

    // Insert galleries and gallery_tag links for B (5 links)
    for (let i = 1; i <= 5; i++) {
      await db.execute(
        'INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [1000 + i, 1, `Gallery ${i}`, '2024-01-01', '', '', ''],
      );
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [1000 + i, tagBId]);
    }
    // Insert galleries and gallery_tag links for C (2 links)
    for (let i = 1; i <= 2; i++) {
      await db.execute(
        'INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [2000 + i, 1, `Gallery C${i}`, '2024-01-01', '', '', ''],
      );
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [2000 + i, tagCId]);
    }
    // Tag A has no gallery_tag links but count=100

    const results = await searchLocalTags('');
    const names = results.map((r) => r.tag);
    const idxA = names.indexOf('tag_a');
    const idxB = names.indexOf('tag_b');
    const idxC = names.indexOf('tag_c');

    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThanOrEqual(0);
    // A (count=100) should come before B (count=0, 5 refs) and C (count=0, 2 refs)
    expect(idxA).toBeLessThan(idxB);
    expect(idxA).toBeLessThan(idxC);
    // B (5 refs) should come before C (2 refs)
    expect(idxB).toBeLessThan(idxC);
  });

  it('count=0 tags with gallery_tag references rank by local frequency', async () => {
    const db = getDb();
    const rX = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'zero_x', 0]);
    const rY = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'zero_y', 0]);
    const rZ = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'zero_z', 0]);
    const tagXId = rX.lastInsertRowId;
    const tagYId = rY.lastInsertRowId;
    const tagZId = rZ.lastInsertRowId;

    // X: 4 gallery_tag refs, Y: 7 refs, Z: 1 ref
    for (let i = 1; i <= 4; i++) {
      await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [3000 + i, 1, `G${i}`, '2024-01-01', '', '', '']);
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [3000 + i, tagXId]);
    }
    for (let i = 1; i <= 7; i++) {
      await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [4000 + i, 1, `G${i}`, '2024-01-01', '', '', '']);
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [4000 + i, tagYId]);
    }
    await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [5001, 1, 'GZ1', '2024-01-01', '', '', '']);
    await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [5001, tagZId]);

    const results = await searchLocalTags('');
    const names = results.map((r) => r.tag);
    const idxX = names.indexOf('zero_x');
    const idxY = names.indexOf('zero_y');
    const idxZ = names.indexOf('zero_z');

    expect(idxX).toBeGreaterThanOrEqual(0);
    expect(idxY).toBeGreaterThanOrEqual(0);
    expect(idxZ).toBeGreaterThanOrEqual(0);
    // Y (7 refs) > X (4 refs) > Z (1 ref)
    expect(idxY).toBeLessThan(idxX);
    expect(idxX).toBeLessThan(idxZ);
  });

  it('count=0 tags with no gallery_tag references rank after those with references', async () => {
    const db = getDb();
    const rNoRef = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'no_ref', 0]);
    const rWithRef = await db.execute('INSERT INTO tag (type, name, count) VALUES (?, ?, ?)', [TAG_TYPE_TO_BYTE[TagType.TAG], 'with_ref', 0]);
    const tagWithRefId = rWithRef.lastInsertRowId;

    // with_ref linked to 3 galleries
    for (let i = 1; i <= 3; i++) {
      await db.execute('INSERT OR REPLACE INTO gallery (id, type, title, date, thumbnail, url, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)', [6000 + i, 1, `G${i}`, '2024-01-01', '', '', '']);
      await db.execute('INSERT OR IGNORE INTO gallery_tag (id, tagId) VALUES (?, ?)', [6000 + i, tagWithRefId]);
    }
    // no_ref has no gallery_tag links

    const results = await searchLocalTags('');
    const names = results.map((r) => r.tag);
    const idxNoRef = names.indexOf('no_ref');
    const idxWithRef = names.indexOf('with_ref');

    expect(idxNoRef).toBeGreaterThanOrEqual(0);
    expect(idxWithRef).toBeGreaterThanOrEqual(0);
    // with_ref (3 gallery refs) should rank before no_ref (0 refs)
    expect(idxWithRef).toBeLessThan(idxNoRef);
  });
});
