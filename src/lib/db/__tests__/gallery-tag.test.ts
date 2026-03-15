import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb, queryAll } from './test-db';
import { getDb } from '../adapter';
import {
  saveGalleryTags,
  getGalleryTags,
  deleteGalleryTags,
  getGalleryIdsByTag,
} from '../gallery-tag';
import { TagType, TAG_TYPE_TO_BYTE } from '@/lib/utils/types';

// Mock patchNewTagCounts so saveGalleryBlock tests don't hit the real API
vi.mock('../patch-tag-counts', () => ({
  patchNewTagCounts: vi.fn().mockResolvedValue(undefined),
}));

import { saveGalleryBlock } from '../gallery';
import { patchNewTagCounts } from '../patch-tag-counts';
import { GalleryBlockType } from '@/lib/utils/types';
import type { GalleryBlock } from '@/lib/utils/types';

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
  vi.mocked(patchNewTagCounts).mockReset();
  vi.mocked(patchNewTagCounts).mockResolvedValue(undefined);
});

describe('saveGalleryTags + getGalleryTags', () => {
  it('saves and reconstructs tags as Partial<Record<TagType, string[]>>', async () => {
    const tags = {
      [TagType.ARTIST]: ['artist1', 'artist2'],
      [TagType.TAG]: ['tag1'],
      [TagType.FEMALE]: ['char1'],
    };

    await saveGalleryTags(100, tags);
    const result = await getGalleryTags(100);

    expect(result[TagType.ARTIST]?.sort()).toEqual(['artist1', 'artist2']);
    expect(result[TagType.TAG]).toEqual(['tag1']);
    expect(result[TagType.FEMALE]).toEqual(['char1']);
  });

  it('creates tag entities in the tag table', async () => {
    await saveGalleryTags(100, { [TagType.ARTIST]: ['new_artist'] });

    const allTags = await queryAll<{ name: string }>('SELECT name FROM tag');
    expect(allTags.length).toBeGreaterThanOrEqual(1);
    expect(allTags.some((t) => t.name === 'new_artist')).toBe(true);
  });

  it('reuses existing tags instead of creating duplicates', async () => {
    await saveGalleryTags(100, { [TagType.TAG]: ['shared'] });
    await saveGalleryTags(200, { [TagType.TAG]: ['shared'] });

    const allTags = await queryAll<{ name: string }>('SELECT name FROM tag WHERE name = ?', ['shared']);
    expect(allTags).toHaveLength(1);
  });

  it('replaces existing junction entries on re-save', async () => {
    await saveGalleryTags(100, { [TagType.ARTIST]: ['a1', 'a2'] });
    await saveGalleryTags(100, { [TagType.ARTIST]: ['a3'] });

    const result = await getGalleryTags(100);
    expect(result[TagType.ARTIST]).toEqual(['a3']);
  });

  it('returns empty object for gallery with no tags', async () => {
    const result = await getGalleryTags(99999);
    expect(result).toEqual({});
  });

  it('handles empty tags object', async () => {
    await saveGalleryTags(100, {});
    const result = await getGalleryTags(100);
    expect(result).toEqual({});
  });
});

describe('deleteGalleryTags', () => {
  it('removes all junction entries for a gallery', async () => {
    await saveGalleryTags(100, { [TagType.ARTIST]: ['a1'] });
    await deleteGalleryTags(100);
    const result = await getGalleryTags(100);
    expect(result).toEqual({});
  });

  it('does not affect other galleries', async () => {
    await saveGalleryTags(100, { [TagType.TAG]: ['t1'] });
    await saveGalleryTags(200, { [TagType.TAG]: ['t2'] });
    await deleteGalleryTags(100);

    expect(await getGalleryTags(100)).toEqual({});
    const g200 = await getGalleryTags(200);
    expect(g200[TagType.TAG]).toEqual(['t2']);
  });
});

describe('getGalleryIdsByTag', () => {
  it('returns correct gallery IDs for a tag', async () => {
    await saveGalleryTags(100, { [TagType.TAG]: ['shared_tag'] });
    await saveGalleryTags(200, { [TagType.TAG]: ['shared_tag'] });
    await saveGalleryTags(300, { [TagType.TAG]: ['other_tag'] });

    const sharedTag = await getDb().query<{ tagId: number }>(
      'SELECT tagId FROM tag WHERE name = ?',
      ['shared_tag'],
    );
    expect(sharedTag.length).toBeGreaterThan(0);

    const ids = await getGalleryIdsByTag(sharedTag[0].tagId);
    expect(ids.sort()).toEqual([100, 200]);
  });

  it('returns empty array for non-existent tag', async () => {
    const ids = await getGalleryIdsByTag(99999);
    expect(ids).toEqual([]);
  });
});

describe('saveGalleryBlock wires patchNewTagCounts fire-and-forget', () => {
  const sampleBlock: GalleryBlock = {
    id: 55001,
    type: GalleryBlockType.DETAILED,
    title: 'Test Wiring Gallery',
    date: new Date('2024-01-15T12:00:00Z'),
    tags: { [TagType.ARTIST]: ['wire-artist'], [TagType.TAG]: ['wire-tag'] },
    thumbnail: '/api/img/tn/avifsmalltn/a/bc/hash.avif',
    related: [],
  };

  it('calls patchNewTagCounts with all tags from block after transaction', async () => {
    await saveGalleryBlock(sampleBlock);

    // Allow the fire-and-forget promise to settle
    await Promise.resolve();

    expect(vi.mocked(patchNewTagCounts)).toHaveBeenCalledOnce();
    const calledWith = vi.mocked(patchNewTagCounts).mock.calls[0][0];
    const names = calledWith.map((t) => t.name).sort();
    expect(names).toEqual(['wire-artist', 'wire-tag']);
  });

  it('patchNewTagCounts is called fire-and-forget (non-blocking)', async () => {
    // Make patchNewTagCounts take a long time
    let resolveDelay!: () => void;
    vi.mocked(patchNewTagCounts).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelay = resolve;
      }),
    );

    const start = Date.now();
    await saveGalleryBlock(sampleBlock);
    const elapsed = Date.now() - start;

    // saveGalleryBlock should return without waiting for patchNewTagCounts
    expect(elapsed).toBeLessThan(500);

    // Resolve the delayed promise to avoid unhandled rejections
    resolveDelay();
  });

  it('does not call patchNewTagCounts when block has no tags', async () => {
    const emptyTagsBlock: GalleryBlock = {
      ...sampleBlock,
      id: 55002,
      tags: {},
    };

    await saveGalleryBlock(emptyTagsBlock);
    await Promise.resolve();

    expect(vi.mocked(patchNewTagCounts)).not.toHaveBeenCalled();
  });
});
