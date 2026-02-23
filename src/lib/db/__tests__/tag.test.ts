import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import {
  findOrCreateTag,
  bulkFindOrCreateTags,
  getTag,
  getTagsByType,
  updateTagCount,
  setTagI18n,
  getTagI18n,
  setTagTransform,
  getTagTransform,
} from '../tag';
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

describe('findOrCreateTag', () => {
  it('creates a new tag and returns its ID', async () => {
    const tagId = await findOrCreateTag(TagType.ARTIST, 'artist1');
    expect(tagId).toBeGreaterThan(0);

    const tag = await getTag(tagId);
    expect(tag).not.toBeNull();
    expect(tag!.type).toBe(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    expect(tag!.name).toBe('artist1');
    expect(tag!.count).toBe(0);
  });

  it('returns existing tag ID for duplicate [type, name]', async () => {
    const id1 = await findOrCreateTag(TagType.TAG, 'mytag');
    const id2 = await findOrCreateTag(TagType.TAG, 'mytag');
    expect(id1).toBe(id2);
  });

  it('creates different tags for same name but different type', async () => {
    const id1 = await findOrCreateTag(TagType.MALE, 'shared_name');
    const id2 = await findOrCreateTag(TagType.FEMALE, 'shared_name');
    expect(id1).not.toBe(id2);
  });
});

describe('bulkFindOrCreateTags', () => {
  it('handles mix of new and existing tags', async () => {
    const existingId = await findOrCreateTag(TagType.ARTIST, 'existing');

    const result = await bulkFindOrCreateTags([
      { type: TagType.ARTIST, name: 'existing' },
      { type: TagType.TAG, name: 'newtag' },
      { type: TagType.SERIES, name: 'newseries' },
    ]);

    expect(result.size).toBe(3);
    expect(result.get(`${TagType.ARTIST}:existing`)).toBe(existingId);
    expect(result.get(`${TagType.TAG}:newtag`)).toBeGreaterThan(0);
    expect(result.get(`${TagType.SERIES}:newseries`)).toBeGreaterThan(0);
  });

  it('returns empty map for empty input', async () => {
    const result = await bulkFindOrCreateTags([]);
    expect(result.size).toBe(0);
  });
});

describe('getTagsByType', () => {
  it('filters tags by type byte', async () => {
    await findOrCreateTag(TagType.ARTIST, 'a1');
    await findOrCreateTag(TagType.ARTIST, 'a2');
    await findOrCreateTag(TagType.TAG, 't1');

    const artists = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.ARTIST]);
    expect(artists).toHaveLength(2);
    expect(artists.map((t) => t.name).sort()).toEqual(['a1', 'a2']);
  });

  it('returns empty array when no tags of that type', async () => {
    const result = await getTagsByType(TAG_TYPE_TO_BYTE[TagType.SERIES]);
    expect(result).toEqual([]);
  });
});

describe('updateTagCount', () => {
  it('updates the count field', async () => {
    const tagId = await findOrCreateTag(TagType.TAG, 'popular');
    await updateTagCount(tagId, 42);

    const tag = await getTag(tagId);
    expect(tag!.count).toBe(42);
  });
});

describe('tag i18n', () => {
  it('round-trips setTagI18n / getTagI18n', async () => {
    const tagId = await findOrCreateTag(TagType.TAG, 'english_name');
    await setTagI18n(tagId, 'localized_name');

    const result = await getTagI18n(tagId);
    expect(result).toBe('localized_name');
  });

  it('returns null for non-existent i18n', async () => {
    const result = await getTagI18n(99999);
    expect(result).toBeNull();
  });

  it('overwrites existing i18n', async () => {
    const tagId = await findOrCreateTag(TagType.TAG, 'test');
    await setTagI18n(tagId, 'first');
    await setTagI18n(tagId, 'second');

    const result = await getTagI18n(tagId);
    expect(result).toBe('second');
  });
});

describe('tag transform', () => {
  it('round-trips setTagTransform / getTagTransform', async () => {
    await setTagTransform('original_name', 'transformed_name');
    const result = await getTagTransform('original_name');
    expect(result).toBe('transformed_name');
  });

  it('returns null for non-existent transform', async () => {
    const result = await getTagTransform('nonexistent');
    expect(result).toBeNull();
  });

  it('overwrites existing transform', async () => {
    await setTagTransform('key', 'value1');
    await setTagTransform('key', 'value2');

    const result = await getTagTransform('key');
    expect(result).toBe('value2');
  });
});
