import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, clearAllTables, teardownTestDb } from './test-db';
import { findOrCreateTag, getTag, updateTagCount } from '../tag';
import { patchNewTagCounts } from '../patch-tag-counts';
import { TagType } from '@/lib/utils/types';

// Mock apiClient.fetchUrl used internally by patchNewTagCounts
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    fetchUrl: vi.fn(),
  },
}));

// Mock url-resolver
vi.mock('@/lib/api/url-resolver', () => ({
  resolveTagIndexUrl: vi.fn((path: string) => `/api/tagindex/${path}`),
}));

// Mock platform (web context, no native)
vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
}));

import { apiClient } from '@/lib/api/client';

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearAllTables();
  vi.mocked(apiClient.fetchUrl).mockReset();
});

describe('patchNewTagCounts', () => {
  it('returns early for empty input without making API calls', async () => {
    await patchNewTagCounts([]);
    expect(vi.mocked(apiClient.fetchUrl)).not.toHaveBeenCalled();
  });

  it('skips tags that already have count > 0', async () => {
    const tagId = await findOrCreateTag(TagType.ARTIST, 'popular-artist');
    await updateTagCount(tagId, 100);

    await patchNewTagCounts([{ type: TagType.ARTIST, name: 'popular-artist' }]);

    expect(vi.mocked(apiClient.fetchUrl)).not.toHaveBeenCalled();
    const tag = await getTag(tagId);
    expect(tag!.count).toBe(100); // unchanged
  });

  it('skips tags not found in DB', async () => {
    // Tag doesn't exist in DB — should not throw, should not call API
    await patchNewTagCounts([{ type: TagType.ARTIST, name: 'nonexistent-tag' }]);
    expect(vi.mocked(apiClient.fetchUrl)).not.toHaveBeenCalled();
  });

  it('fetches count from tagindex API for count=0 tag and updates DB', async () => {
    const tagId = await findOrCreateTag(TagType.ARTIST, 'test-artist');
    // count is 0 by default

    // tagindex JSON response: Array of [tag_name, count, namespace]
    vi.mocked(apiClient.fetchUrl).mockResolvedValue({
      ok: true,
      json: async () => [
        ['test-artist', 42, 'artist'],
        ['test-artist-2', 10, 'artist'],
      ],
    } as Response);

    await patchNewTagCounts([{ type: TagType.ARTIST, name: 'test-artist' }]);

    // Should call tagindex API with correct path for 'test-artist'
    // URL pattern: /api/tagindex/artist/t/e/s/t/-/a/r/t/i/s/t.json
    expect(vi.mocked(apiClient.fetchUrl)).toHaveBeenCalledOnce();
    const calledUrl = vi.mocked(apiClient.fetchUrl).mock.calls[0][0];
    expect(calledUrl).toMatch(/\/api\/tagindex\/artist\//);
    expect(calledUrl).toMatch(/\.json$/);

    const tag = await getTag(tagId);
    expect(tag!.count).toBe(42);
  });

  it('uses correct field name for tag types', async () => {
    const femaleId = await findOrCreateTag(TagType.FEMALE, 'some-female-tag');
    const maleId = await findOrCreateTag(TagType.MALE, 'some-male-tag');

    vi.mocked(apiClient.fetchUrl)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [['some-female-tag', 5, 'female']],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [['some-male-tag', 3, 'male']],
      } as Response);

    await patchNewTagCounts([
      { type: TagType.FEMALE, name: 'some-female-tag' },
      { type: TagType.MALE, name: 'some-male-tag' },
    ]);

    const calls = vi.mocked(apiClient.fetchUrl).mock.calls;
    expect(calls[0][0]).toMatch(/\/api\/tagindex\/female\//);
    expect(calls[1][0]).toMatch(/\/api\/tagindex\/male\//);

    expect((await getTag(femaleId))!.count).toBe(5);
    expect((await getTag(maleId))!.count).toBe(3);
  });

  it('uses "tag" field for TagType.TAG', async () => {
    const tagId = await findOrCreateTag(TagType.TAG, 'some-tag');

    vi.mocked(apiClient.fetchUrl).mockResolvedValue({
      ok: true,
      json: async () => [['some-tag', 99, 'tag']],
    } as Response);

    await patchNewTagCounts([{ type: TagType.TAG, name: 'some-tag' }]);

    const calledUrl = vi.mocked(apiClient.fetchUrl).mock.calls[0][0];
    expect(calledUrl).toMatch(/\/api\/tagindex\/tag\//);
    expect((await getTag(tagId))!.count).toBe(99);
  });

  it('leaves count at 0 if tag not found in API response', async () => {
    const tagId = await findOrCreateTag(TagType.ARTIST, 'obscure-artist');

    vi.mocked(apiClient.fetchUrl).mockResolvedValue({
      ok: true,
      json: async () => [['different-artist', 10, 'artist']],
    } as Response);

    await patchNewTagCounts([{ type: TagType.ARTIST, name: 'obscure-artist' }]);

    const tag = await getTag(tagId);
    expect(tag!.count).toBe(0); // not updated, no match found
  });

  it('handles API fetch failure gracefully without throwing', async () => {
    const tagId = await findOrCreateTag(TagType.ARTIST, 'error-artist');

    vi.mocked(apiClient.fetchUrl).mockRejectedValue(new Error('Network error'));

    // Should not throw
    await expect(
      patchNewTagCounts([{ type: TagType.ARTIST, name: 'error-artist' }])
    ).resolves.toBeUndefined();

    const tag = await getTag(tagId);
    expect(tag!.count).toBe(0); // unchanged
  });

  it('processes multiple count=0 tags and only those', async () => {
    const id1 = await findOrCreateTag(TagType.ARTIST, 'artist-a');
    const id2 = await findOrCreateTag(TagType.ARTIST, 'artist-b');
    const id3 = await findOrCreateTag(TagType.ARTIST, 'artist-c');
    await updateTagCount(id2, 50); // already has count

    vi.mocked(apiClient.fetchUrl)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [['artist-a', 11, 'artist']],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [['artist-c', 33, 'artist']],
      } as Response);

    await patchNewTagCounts([
      { type: TagType.ARTIST, name: 'artist-a' },
      { type: TagType.ARTIST, name: 'artist-b' },
      { type: TagType.ARTIST, name: 'artist-c' },
    ]);

    // Only 2 API calls: artist-a and artist-c (artist-b skipped, count=50)
    expect(vi.mocked(apiClient.fetchUrl)).toHaveBeenCalledTimes(2);

    expect((await getTag(id1))!.count).toBe(11);
    expect((await getTag(id2))!.count).toBe(50); // unchanged
    expect((await getTag(id3))!.count).toBe(33);
  });

  it('encodes special characters in tag names correctly', async () => {
    const tagId = await findOrCreateTag(TagType.TAG, 'a/b');

    vi.mocked(apiClient.fetchUrl).mockResolvedValue({
      ok: true,
      json: async () => [['a/b', 7, 'tag']],
    } as Response);

    await patchNewTagCounts([{ type: TagType.TAG, name: 'a/b' }]);

    const calledUrl = vi.mocked(apiClient.fetchUrl).mock.calls[0][0];
    // '/' should be encoded as 'slash' per the tagindex URL encoding
    expect(calledUrl).toContain('/slash/');
    expect((await getTag(tagId))!.count).toBe(7);
  });
});
