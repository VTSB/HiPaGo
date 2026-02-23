import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, countRows, queryAll, queryOne } from './test-db';
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
} from '../gallery';
import {
  findOrCreateTag,
  getTag,
  getTagsByType,
  setTagI18n,
  getTagI18n,
  setTagTransform,
  getTagTransform,
} from '../tag';
import { saveGalleryRelated, getGalleryRelated, deleteGalleryRelated } from '../gallery-relate';
import { saveGalleryTags, getGalleryTags, deleteGalleryTags, getGalleryIdsByTag } from '../gallery-tag';
import { getSyncStatus, setSyncStatus, deleteSyncStatus } from '../sync-status';
import { GalleryBlockType, TagType, TAG_TYPE_TO_BYTE } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile } from '@/lib/utils/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(id: number, overrides: Partial<GalleryBlock> = {}): GalleryBlock {
  return {
    id,
    type: GalleryBlockType.DETAILED,
    title: `Gallery ${id}`,
    date: new Date('2024-01-15T12:30:00Z'),
    tags: {},
    thumbnail: `/thumb/${id}.avif`,
    related: [],
    ...overrides,
  };
}

const sampleFiles: GalleryFile[] = [
  { width: 1280, height: 1800, haswebp: 1, hasavif: 1, hasavifsmalltn: 1, name: '001.jpg', hash: 'aaa111' },
  { width: 800, height: 600, haswebp: 0, hasavif: 0, hasavifsmalltn: 0, name: '002.png', hash: 'bbb222' },
];

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
});

// ---------------------------------------------------------------------------
// 1. Full round-trip: saveGalleryBlock -> getGalleryBlock
// ---------------------------------------------------------------------------

describe('Full round-trip: saveGalleryBlock -> getGalleryBlock', () => {
  it('saves and retrieves all scalar fields', async () => {
    const block = makeBlock(100, {
      title: 'Round Trip Test',
      thumbnail: '/thumb/round-trip.avif',
    });
    await saveGalleryBlock(block);
    const result = await getGalleryBlock(100);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(100);
    expect(result!.type).toBe(GalleryBlockType.DETAILED);
    expect(result!.title).toBe('Round Trip Test');
    expect(result!.thumbnail).toBe('/thumb/round-trip.avif');
  });

  it('returns date as a Date instance with the correct timestamp', async () => {
    const block = makeBlock(100, { date: new Date('2024-01-15T12:30:00Z') });
    await saveGalleryBlock(block);
    const result = await getGalleryBlock(100);

    expect(result!.date).toBeInstanceOf(Date);
    expect(result!.date.toISOString()).toBe('2024-01-15T12:30:00.000Z');
    expect(result!.date.getTime()).toBe(new Date('2024-01-15T12:30:00Z').getTime());
  });

  it('reconstructs tags with correct TagType keys and values', async () => {
    const block = makeBlock(100, {
      tags: {
        [TagType.ARTIST]: ['artist1', 'artist2'],
        [TagType.TAG]: ['tag1'],
        [TagType.FEMALE]: ['female1'],
      },
    });
    await saveGalleryBlock(block);
    const result = await getGalleryBlock(100);

    expect(result!.tags[TagType.ARTIST]?.sort()).toEqual(['artist1', 'artist2']);
    expect(result!.tags[TagType.TAG]).toEqual(['tag1']);
    expect(result!.tags[TagType.FEMALE]).toEqual(['female1']);
    expect(result!.tags[TagType.MALE]).toBeUndefined();
    expect(result!.tags[TagType.SERIES]).toBeUndefined();
  });

  it('reconstructs related array', async () => {
    const block = makeBlock(100, { related: [200, 300, 400] });
    await saveGalleryBlock(block);
    const result = await getGalleryBlock(100);

    expect(result!.related).toEqual(expect.arrayContaining([200, 300, 400]));
    expect(result!.related).toHaveLength(3);
  });

  it('returns a Partial<Record<TagType, string[]>> — missing types are absent, not null', async () => {
    const block = makeBlock(100, {
      tags: { [TagType.CHARACTER]: ['char1'] },
    });
    await saveGalleryBlock(block);
    const result = await getGalleryBlock(100);

    const keys = Object.keys(result!.tags) as TagType[];
    expect(keys).toEqual([TagType.CHARACTER]);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-table consistency on upsert
// ---------------------------------------------------------------------------

describe('Cross-table consistency on upsert', () => {
  it('replaces tags on re-save — old junction entries are gone', async () => {
    const block = makeBlock(100, {
      tags: { [TagType.ARTIST]: ['old-artist'] },
    });
    await saveGalleryBlock(block);

    const updated = makeBlock(100, {
      tags: { [TagType.TAG]: ['new-tag'] },
    });
    await saveGalleryBlock(updated);

    const result = await getGalleryBlock(100);
    expect(result!.tags[TagType.ARTIST]).toBeUndefined();
    expect(result!.tags[TagType.TAG]).toEqual(['new-tag']);
  });

  it('replaces related array on re-save — old entries are gone', async () => {
    const block = makeBlock(100, { related: [200, 300] });
    await saveGalleryBlock(block);

    const updated = makeBlock(100, { related: [400] });
    await saveGalleryBlock(updated);

    const result = await getGalleryBlock(100);
    expect(result!.related).toEqual([400]);
  });

  it('tag entities remain in tag table after junction is replaced (no orphan removal)', async () => {
    const block = makeBlock(100, {
      tags: { [TagType.ARTIST]: ['will-be-unlinked'] },
    });
    await saveGalleryBlock(block);

    const updated = makeBlock(100, {
      tags: { [TagType.ARTIST]: ['new-artist'] },
    });
    await saveGalleryBlock(updated);

    const allArtists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    const names = allArtists.map((t) => t.name);
    expect(names).toContain('will-be-unlinked');
    expect(names).toContain('new-artist');
  });

  it('gallery table has exactly 1 record after multiple saves of same ID', async () => {
    await saveGalleryBlock(makeBlock(100));
    await saveGalleryBlock(makeBlock(100, { title: 'Second' }));
    await saveGalleryBlock(makeBlock(100, { title: 'Third' }));

    const count = await countRows('gallery');
    expect(count).toBe(1);

    const result = await getGalleryBlock(100);
    expect(result!.title).toBe('Third');
  });

  it('gallery_tag junction has no entries for old tags after re-save', async () => {
    const block = makeBlock(100, {
      tags: { [TagType.TAG]: ['alpha', 'beta'] },
    });
    await saveGalleryBlock(block);

    const updated = makeBlock(100, {
      tags: { [TagType.TAG]: ['gamma'] },
    });
    await saveGalleryBlock(updated);

    const junctionRows = await queryAll('SELECT * FROM gallery_tag WHERE id = ?', [100]);
    expect(junctionRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Tag deduplication across galleries
// ---------------------------------------------------------------------------

describe('Tag deduplication across galleries', () => {
  it('two galleries sharing a tag name+type produce only ONE tag record', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['shared-artist'] },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: { [TagType.ARTIST]: ['shared-artist'] },
    }));

    const allArtists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    const sharedArtists = allArtists.filter((t) => t.name === 'shared-artist');
    expect(sharedArtists).toHaveLength(1);
  });

  it('both galleries getGalleryTags return the shared tag', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['shared-artist'] },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: { [TagType.ARTIST]: ['shared-artist'] },
    }));

    const tags100 = await getGalleryTags(100);
    const tags200 = await getGalleryTags(200);

    expect(tags100[TagType.ARTIST]).toEqual(['shared-artist']);
    expect(tags200[TagType.ARTIST]).toEqual(['shared-artist']);
  });

  it('getGalleryIdsByTag reverse lookup returns both gallery IDs', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['shared-artist'] },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: { [TagType.ARTIST]: ['shared-artist'] },
    }));

    const artists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    const sharedTag = artists.find((t) => t.name === 'shared-artist')!;
    expect(sharedTag).toBeDefined();

    const galleryIds = await getGalleryIdsByTag(sharedTag.tagId!);
    expect(galleryIds.sort()).toEqual([100, 200]);
  });

  it('different name with same type are stored as separate tag records', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['artist-a'] },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: { [TagType.ARTIST]: ['artist-b'] },
    }));

    const artists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    expect(artists).toHaveLength(2);
    expect(artists.map((t) => t.name).sort()).toEqual(['artist-a', 'artist-b']);
  });
});

// ---------------------------------------------------------------------------
// 4. Gallery data cleanup
// ---------------------------------------------------------------------------

describe('Gallery data cleanup', () => {
  it('deleteGalleryTags removes junction entries, gallery core record remains', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.TAG]: ['t1', 't2'] },
    }));

    await deleteGalleryTags(100);

    const tags = await getGalleryTags(100);
    expect(Object.keys(tags)).toHaveLength(0);

    const gallery = await queryOne<{ id: number }>('SELECT id FROM gallery WHERE id = ?', [100]);
    expect(gallery).toBeDefined();
    expect(gallery!.id).toBe(100);
  });

  it('deleteGalleryRelated removes related entries, gallery core record remains', async () => {
    await saveGalleryBlock(makeBlock(100, { related: [200, 300] }));

    await deleteGalleryRelated(100);

    const related = await getGalleryRelated(100);
    expect(related).toHaveLength(0);

    const gallery = await queryOne<{ id: number }>('SELECT id FROM gallery WHERE id = ?', [100]);
    expect(gallery).toBeDefined();
  });

  it('deleteGalleryImages removes images, gallery core record remains', async () => {
    await saveGalleryBlock(makeBlock(100));
    await saveGalleryImages(100, sampleFiles);

    await deleteGalleryImages(100);

    expect(await hasGalleryImages(100)).toBe(false);
    expect(await getGalleryImages(100)).toBeNull();

    const gallery = await queryOne<{ id: number }>('SELECT id FROM gallery WHERE id = ?', [100]);
    expect(gallery).toBeDefined();
  });

  it('deleting all junction/image tables leaves only core gallery record', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['a1'] },
      related: [200],
    }));
    await saveGalleryImages(100, sampleFiles);

    await deleteGalleryTags(100);
    await deleteGalleryRelated(100);
    await deleteGalleryImages(100);

    expect(Object.keys(await getGalleryTags(100))).toHaveLength(0);
    expect(await getGalleryRelated(100)).toHaveLength(0);
    expect(await hasGalleryImages(100)).toBe(false);

    const gallery = await queryOne<{ id: number; title: string }>('SELECT id, title FROM gallery WHERE id = ?', [100]);
    expect(gallery).toBeDefined();
    expect(gallery!.title).toBe('Gallery 100');
  });
});

// ---------------------------------------------------------------------------
// 5. Favorites + History + Gallery coexistence
// ---------------------------------------------------------------------------

describe('Favorites + History + Gallery coexistence', () => {
  it('all three aspects work together after save+favorite+history', async () => {
    await saveGalleryBlock(makeBlock(100));
    await addFavorite(100);
    await recordHistory(100, 5, 20, 'vertical');

    const block = await getGalleryBlock(100);
    expect(block).not.toBeNull();
    expect(block!.id).toBe(100);

    expect(await isFavorite(100)).toBe(true);

    const progress = await getReadingProgress(100);
    expect(progress).not.toBeNull();
    expect(progress!.lastPage).toBe(5);
    expect(progress!.totalPages).toBe(20);
    expect(progress!.readerMode).toBe('vertical');
  });

  it('getFavoriteIds includes the gallery', async () => {
    await saveGalleryBlock(makeBlock(100));
    await addFavorite(100);

    const ids = await getFavoriteIds();
    expect(ids).toContain(100);
  });

  it('getRecentlyViewedIds includes the gallery after history record', async () => {
    await saveGalleryBlock(makeBlock(100));
    await recordHistory(100, 1, 10, 'horizontal');

    const ids = await getRecentlyViewedIds();
    expect(ids).toContain(100);
  });

  it('removeFavorite leaves gallery and history intact', async () => {
    await saveGalleryBlock(makeBlock(100));
    await addFavorite(100);
    await recordHistory(100, 3, 15, 'webtoon');

    await removeFavorite(100);

    expect(await isFavorite(100)).toBe(false);
    expect(await getGalleryBlock(100)).not.toBeNull();
    expect(await getReadingProgress(100)).not.toBeNull();
  });

  it('history update does not affect favorites or gallery', async () => {
    await saveGalleryBlock(makeBlock(100, { title: 'Original' }));
    await addFavorite(100);
    await recordHistory(100, 1, 10, 'vertical');
    await recordHistory(100, 8, 10, 'horizontal');

    const progress = await getReadingProgress(100);
    expect(progress!.lastPage).toBe(8);
    expect(progress!.readerMode).toBe('horizontal');

    expect(await isFavorite(100)).toBe(true);
    expect((await getGalleryBlock(100))!.title).toBe('Original');
  });
});

// ---------------------------------------------------------------------------
// 6. sync_status integration
// ---------------------------------------------------------------------------

describe('sync_status integration', () => {
  it('set and retrieve multiple entries independently', async () => {
    await setSyncStatus('tag-a', '{"page":1}');
    await setSyncStatus('tag-b', '{"page":2}');
    await setSyncStatus('tag-c', '{"page":3}');

    expect(await getSyncStatus('tag-a')).toBe('{"page":1}');
    expect(await getSyncStatus('tag-b')).toBe('{"page":2}');
    expect(await getSyncStatus('tag-c')).toBe('{"page":3}');
  });

  it('updating one entry does not affect others', async () => {
    await setSyncStatus('tag-a', 'original-a');
    await setSyncStatus('tag-b', 'original-b');

    await setSyncStatus('tag-a', 'updated-a');

    expect(await getSyncStatus('tag-a')).toBe('updated-a');
    expect(await getSyncStatus('tag-b')).toBe('original-b');
  });

  it('deleting one entry does not affect others', async () => {
    await setSyncStatus('tag-a', 'value-a');
    await setSyncStatus('tag-b', 'value-b');

    await deleteSyncStatus('tag-a');

    expect(await getSyncStatus('tag-a')).toBeNull();
    expect(await getSyncStatus('tag-b')).toBe('value-b');
  });

  it('returns null for non-existent key', async () => {
    expect(await getSyncStatus('does-not-exist')).toBeNull();
  });

  it('put is idempotent — re-setting same key replaces value', async () => {
    await setSyncStatus('key', 'v1');
    await setSyncStatus('key', 'v2');
    await setSyncStatus('key', 'v3');

    expect(await getSyncStatus('key')).toBe('v3');
    const rows = await queryAll('SELECT * FROM sync_status WHERE tag = ?', ['key']);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Tag i18n + transform with gallery flow
// ---------------------------------------------------------------------------

describe('Tag i18n + transform with gallery flow', () => {
  it('setTagI18n / getTagI18n work after gallery save', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['some-artist'] },
    }));

    const artistTags = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    const artistTag = artistTags.find((t) => t.name === 'some-artist')!;
    expect(artistTag).toBeDefined();

    await setTagI18n(artistTag.tagId!, 'アーティスト');
    expect(await getTagI18n(artistTag.tagId!)).toBe('アーティスト');
  });

  it('setTagTransform / getTagTransform work independently of gallery flow', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.TAG]: ['english-tag'] },
    }));

    await setTagTransform('english-tag', 'transformed-tag');
    expect(await getTagTransform('english-tag')).toBe('transformed-tag');
  });

  it('gallery tags still reconstruct correctly after i18n/transform set', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: {
        [TagType.ARTIST]: ['artist-i18n'],
        [TagType.TAG]: ['tag-transform'],
      },
    }));

    const artists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    const artist = artists.find((t) => t.name === 'artist-i18n')!;
    await setTagI18n(artist.tagId!, 'ローカル名');
    await setTagTransform('tag-transform', 'renamed-tag');

    const block = await getGalleryBlock(100);
    expect(block!.tags[TagType.ARTIST]).toEqual(['artist-i18n']);
    expect(block!.tags[TagType.TAG]).toEqual(['tag-transform']);
  });

  it('i18n is per-tag-id — different tags have independent i18n', async () => {
    const id1 = await findOrCreateTag(TagType.TAG, 'tag-one');
    const id2 = await findOrCreateTag(TagType.TAG, 'tag-two');

    await setTagI18n(id1, 'local-one');
    await setTagI18n(id2, 'local-two');

    expect(await getTagI18n(id1)).toBe('local-one');
    expect(await getTagI18n(id2)).toBe('local-two');
  });

  it('getTag by ID returns correct type byte after gallery save', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.MALE]: ['test-male'] },
    }));

    const maleTags = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.MALE]);
    const maleTag = maleTags.find((t) => t.name === 'test-male')!;
    expect(maleTag).toBeDefined();

    const fetched = await getTag(maleTag.tagId!);
    expect(fetched).not.toBeNull();
    expect(fetched!.type).toBe(TAG_TYPE_TO_BYTE[TagType.MALE]);
    expect(fetched!.name).toBe('test-male');
  });
});

// ---------------------------------------------------------------------------
// 8. Multiple galleries with complex tag relationships
// ---------------------------------------------------------------------------

describe('Multiple galleries with complex tag relationships', () => {
  it('creates exactly 6 unique tags for 3 overlapping galleries', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: {
        [TagType.ARTIST]: ['a1', 'a2'],
        [TagType.TAG]: ['t1'],
      },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: {
        [TagType.ARTIST]: ['a2', 'a3'],
        [TagType.FEMALE]: ['f1'],
      },
    }));
    await saveGalleryBlock(makeBlock(300, {
      tags: {
        [TagType.TAG]: ['t1'],
        [TagType.MALE]: ['m1'],
      },
    }));

    const allTags = await queryAll<{ name: string }>('SELECT name FROM tag');
    expect(allTags).toHaveLength(6);
    const names = allTags.map((t) => t.name).sort();
    expect(names).toEqual(['a1', 'a2', 'a3', 'f1', 'm1', 't1']);
  });

  it('getGalleryIdsByTag for a2 returns galleries A and B', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['a1', 'a2'], [TagType.TAG]: ['t1'] },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: { [TagType.ARTIST]: ['a2', 'a3'], [TagType.FEMALE]: ['f1'] },
    }));
    await saveGalleryBlock(makeBlock(300, {
      tags: { [TagType.TAG]: ['t1'], [TagType.MALE]: ['m1'] },
    }));

    const artists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    const a2Tag = artists.find((t) => t.name === 'a2')!;
    expect(a2Tag).toBeDefined();

    const ids = await getGalleryIdsByTag(a2Tag.tagId!);
    expect(ids.sort()).toEqual([100, 200]);
  });

  it('getGalleryIdsByTag for t1 returns galleries A and C', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ARTIST]: ['a1', 'a2'], [TagType.TAG]: ['t1'] },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: { [TagType.ARTIST]: ['a2', 'a3'], [TagType.FEMALE]: ['f1'] },
    }));
    await saveGalleryBlock(makeBlock(300, {
      tags: { [TagType.TAG]: ['t1'], [TagType.MALE]: ['m1'] },
    }));

    const tagRows = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.TAG]);
    const t1Tag = tagRows.find((t) => t.name === 't1')!;
    expect(t1Tag).toBeDefined();

    const ids = await getGalleryIdsByTag(t1Tag.tagId!);
    expect(ids.sort()).toEqual([100, 300]);
  });

  it('each gallery reconstructs its own distinct tags after shared-tag saves', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: {
        [TagType.ARTIST]: ['a1', 'a2'],
        [TagType.TAG]: ['t1'],
      },
    }));
    await saveGalleryBlock(makeBlock(200, {
      tags: {
        [TagType.ARTIST]: ['a2', 'a3'],
        [TagType.FEMALE]: ['f1'],
      },
    }));
    await saveGalleryBlock(makeBlock(300, {
      tags: {
        [TagType.TAG]: ['t1'],
        [TagType.MALE]: ['m1'],
      },
    }));

    const blockA = await getGalleryBlock(100);
    expect(blockA!.tags[TagType.ARTIST]?.sort()).toEqual(['a1', 'a2']);
    expect(blockA!.tags[TagType.TAG]).toEqual(['t1']);
    expect(blockA!.tags[TagType.FEMALE]).toBeUndefined();

    const blockB = await getGalleryBlock(200);
    expect(blockB!.tags[TagType.ARTIST]?.sort()).toEqual(['a2', 'a3']);
    expect(blockB!.tags[TagType.FEMALE]).toEqual(['f1']);
    expect(blockB!.tags[TagType.TAG]).toBeUndefined();

    const blockC = await getGalleryBlock(300);
    expect(blockC!.tags[TagType.TAG]).toEqual(['t1']);
    expect(blockC!.tags[TagType.MALE]).toEqual(['m1']);
    expect(blockC!.tags[TagType.ARTIST]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('gallery with empty tags {} returns empty tags object', async () => {
    await saveGalleryBlock(makeBlock(100, { tags: {} }));
    const result = await getGalleryBlock(100);
    expect(result).not.toBeNull();
    expect(result!.tags).toEqual({});
  });

  it('gallery with empty related [] returns empty related array', async () => {
    await saveGalleryBlock(makeBlock(100, { related: [] }));
    const result = await getGalleryBlock(100);
    expect(result).not.toBeNull();
    expect(result!.related).toEqual([]);
  });

  it('gallery with all 9 usable TagTypes reconstructs all correctly', async () => {
    const allTags: Partial<Record<TagType, string[]>> = {
      [TagType.TYPE]: ['type1'],
      [TagType.LANGUAGE]: ['lang1'],
      [TagType.GROUP]: ['group1'],
      [TagType.ARTIST]: ['artist1'],
      [TagType.SERIES]: ['series1'],
      [TagType.CHARACTER]: ['char1'],
      [TagType.TAG]: ['tag1'],
      [TagType.MALE]: ['male1'],
      [TagType.FEMALE]: ['female1'],
    };
    await saveGalleryBlock(makeBlock(100, { tags: allTags }));
    const result = await getGalleryBlock(100);

    expect(result!.tags[TagType.TYPE]).toEqual(['type1']);
    expect(result!.tags[TagType.LANGUAGE]).toEqual(['lang1']);
    expect(result!.tags[TagType.GROUP]).toEqual(['group1']);
    expect(result!.tags[TagType.ARTIST]).toEqual(['artist1']);
    expect(result!.tags[TagType.SERIES]).toEqual(['series1']);
    expect(result!.tags[TagType.CHARACTER]).toEqual(['char1']);
    expect(result!.tags[TagType.TAG]).toEqual(['tag1']);
    expect(result!.tags[TagType.MALE]).toEqual(['male1']);
    expect(result!.tags[TagType.FEMALE]).toEqual(['female1']);
  });

  it('getGalleryBlock for non-existent ID returns null', async () => {
    const result = await getGalleryBlock(999999);
    expect(result).toBeNull();
  });

  it('multiple rapid saves of same gallery — only latest data persists', async () => {
    await saveGalleryBlock(makeBlock(100, { title: 'First' }));
    await saveGalleryBlock(makeBlock(100, { title: 'Second' }));
    await saveGalleryBlock(makeBlock(100, { title: 'Third' }));
    await saveGalleryBlock(makeBlock(100, { title: 'Fourth' }));

    const result = await getGalleryBlock(100);
    expect(result!.title).toBe('Fourth');

    const count = await countRows('gallery');
    expect(count).toBe(1);
  });

  it('saving gallery with single tag and single related round-trips correctly', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.CHARACTER]: ['char-single'] },
      related: [999],
    }));
    const result = await getGalleryBlock(100);
    expect(result!.tags[TagType.CHARACTER]).toEqual(['char-single']);
    expect(result!.related).toEqual([999]);
  });

  it('saveGalleryRelated and getGalleryRelated work as standalone operations', async () => {
    await saveGalleryRelated(100, [201, 202, 203]);
    const related = await getGalleryRelated(100);
    expect(related).toHaveLength(3);
    expect(related).toEqual(expect.arrayContaining([201, 202, 203]));
  });

  it('saveGalleryTags and getGalleryTags work as standalone operations', async () => {
    await saveGalleryTags(100, {
      [TagType.SERIES]: ['series-standalone'],
    });
    const tags = await getGalleryTags(100);
    expect(tags[TagType.SERIES]).toEqual(['series-standalone']);
  });

  it('favorites and history are independent of gallery existence', async () => {
    await addFavorite(555);
    await recordHistory(555, 2, 10, 'vertical');

    expect(await isFavorite(555)).toBe(true);
    expect(await getReadingProgress(555)).not.toBeNull();

    await saveGalleryBlock(makeBlock(555));
    expect(await getGalleryBlock(555)).not.toBeNull();
    expect(await isFavorite(555)).toBe(true);
  });

  it('TagType.ID byte-collision: saved as byte 0, reconstructed as TagType.BEFORE', async () => {
    await saveGalleryBlock(makeBlock(100, {
      tags: { [TagType.ID]: ['id-value-123'] },
    }));
    const result = await getGalleryBlock(100);
    expect(result).not.toBeNull();
    expect(result!.tags[TagType.BEFORE]).toEqual(['id-value-123']);
    expect(result!.tags[TagType.ID]).toBeUndefined();
  });

  it('deleteGalleryImages on non-existent gallery is a graceful no-op', async () => {
    await expect(deleteGalleryImages(99999)).resolves.not.toThrow();
    expect(await hasGalleryImages(99999)).toBe(false);
  });
});
