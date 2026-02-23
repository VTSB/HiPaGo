// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../client', () => ({
  apiClient: {
    fetchLtnBinary: vi.fn(),
    fetchLtnText: vi.fn(),
    fetchUrl: vi.fn(),
  },
}));

vi.mock('../gallery', () => ({
  fetchIndexVersion: vi.fn(),
}));

vi.mock('../nozomi', () => ({
  fetchNozomiSearch: vi.fn(),
}));

import { apiClient } from '../client';
import { fetchIndexVersion } from '../gallery';
import { fetchNozomiSearch } from '../nozomi';
import { getGalleryIdsForQuery, getSuggestionsForQuery } from '../search';

describe('getGalleryIdsForQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('typed queries (tag type specified)', () => {
    it('female tag routes to nozomi with "tag" area and prefixed tag', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([100, 200]);

      const result = await getGalleryIdsForQuery('female:stockings', 'all');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:stockings', 'all');
      expect(result).toEqual([100, 200]);
    });

    it('male tag routes to nozomi with "tag" area and prefixed tag', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([300]);

      const result = await getGalleryIdsForQuery('male:glasses', 'japanese');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'male:glasses', 'japanese');
      expect(result).toEqual([300]);
    });

    it('language query routes to nozomi with empty area and "index" tag', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([1, 2, 3]);

      const result = await getGalleryIdsForQuery('language:korean', 'all');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('', 'index', 'korean');
      expect(result).toEqual([1, 2, 3]);
    });

    it('artist query routes to nozomi with tagType as area', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([500, 600]);

      const result = await getGalleryIdsForQuery('artist:testartist', 'all');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('artist', 'testartist', 'all');
      expect(result).toEqual([500, 600]);
    });

    it('series query routes to nozomi with tagType as area', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([700]);

      const result = await getGalleryIdsForQuery('series:testseries', 'english');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('series', 'testseries', 'english');
      expect(result).toEqual([700]);
    });

    it('uses "all" when language is empty string', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([]);

      await getGalleryIdsForQuery('artist:test', '');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('artist', 'test', 'all');
    });
  });

  describe('untyped queries (B-tree index)', () => {
    it('fetches version, hashes term, searches B-tree, decodes data', async () => {
      // Version
      vi.mocked(fetchIndexVersion).mockResolvedValue('v42');

      // Root node: single key matching the hash of "test"
      const hashData = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test')),
      ).slice(0, 4);

      // Build a root node buffer with one key matching and one data entry
      const nodeBuffer = buildNodeWithKeyAndData(hashData, { offset: 0, length: 12 });
      vi.mocked(apiClient.fetchLtnBinary)
        .mockResolvedValueOnce(nodeBuffer) // root node fetch
        .mockResolvedValueOnce(buildGalleryIdBuffer([111, 222, 333])); // data fetch

      const result = await getGalleryIdsForQuery('test', 'all');

      expect(fetchIndexVersion).toHaveBeenCalledWith('galleriesindex');
      expect(result).toEqual([111, 222, 333]);
    });

    it('returns empty array when B-tree search finds nothing', async () => {
      vi.mocked(fetchIndexVersion).mockResolvedValue('v1');

      // Root node with no matching key
      const nodeBuffer = buildNodeWithKeyAndData(
        new Uint8Array([0xff, 0xff, 0xff, 0xff]),
        { offset: 0, length: 4 },
      );
      vi.mocked(apiClient.fetchLtnBinary).mockResolvedValueOnce(nodeBuffer);

      const result = await getGalleryIdsForQuery('nonexistent', 'all');

      expect(result).toEqual([]);
    });
  });
});

describe('getSuggestionsForQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches suggestions from tagindex API', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([
        ['testtag', 100, 'tag'],
        ['testartist', 50, 'artist'],
      ]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    const result = await getSuggestionsForQuery('te');

    expect(apiClient.fetchUrl).toHaveBeenCalledWith('/api/tagindex/global/t/e.json');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ tag: 'testtag', tagType: 'tag', amount: 100 });
    expect(result[1]).toEqual({ tag: 'testartist', tagType: 'artist', amount: 50 });
  });

  it('encodes special characters in path (space, slash, dot)', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    await getSuggestionsForQuery('a b');

    // space → _, characters individually encoded
    expect(apiClient.fetchUrl).toHaveBeenCalledWith('/api/tagindex/global/a/_/b.json');
  });

  it('uses tagType as field in URL when typed query', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([['testartist', 42, 'artist']]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    const result = await getSuggestionsForQuery('artist:te');

    expect(apiClient.fetchUrl).toHaveBeenCalledWith('/api/tagindex/artist/t/e.json');
    expect(result[0].tagType).toBe('artist');
  });

  it('returns empty array for empty query', async () => {
    const result = await getSuggestionsForQuery('');
    expect(result).toEqual([]);
    expect(apiClient.fetchUrl).not.toHaveBeenCalled();
  });

  it('returns empty array on fetch error', async () => {
    vi.mocked(apiClient.fetchUrl).mockRejectedValue(new Error('Network error'));

    const result = await getSuggestionsForQuery('test');

    expect(result).toEqual([]);
  });

  it('limits results to SEARCH_LIMIT', async () => {
    const bigData = Array.from({ length: 150 }, (_, i) => [`tag${i}`, i, 'tag']);
    const mockResponse = { json: vi.fn().mockResolvedValue(bigData) };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    const result = await getSuggestionsForQuery('t');

    expect(result.length).toBe(100);
  });

  it('resolves unknown namespace to TAG type', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([['sometag', 10, 'unknownns']]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    const result = await getSuggestionsForQuery('so');

    expect(result[0].tagType).toBe('tag');
  });
});

// --- Helpers ---

function buildNodeWithKeyAndData(
  key: Uint8Array,
  data: { offset: number; length: number },
): ArrayBuffer {
  const B = 16;
  const numberOfSubNodes = B + 1;

  let size = 4; // numberOfKeys
  size += 4 + key.length; // keyLength + keyBytes
  size += 4; // numberOfDatas
  size += 12; // one data entry (8+4)
  size += numberOfSubNodes * 8;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let pos = 0;

  view.setInt32(pos, 1, false); pos += 4; // 1 key
  view.setInt32(pos, key.length, false); pos += 4;
  new Uint8Array(buffer, pos, key.length).set(key); pos += key.length;

  view.setInt32(pos, 1, false); pos += 4; // 1 data
  view.setBigInt64(pos, BigInt(data.offset), false); pos += 8;
  view.setInt32(pos, data.length, false); pos += 4;

  for (let i = 0; i < numberOfSubNodes; i++) {
    view.setBigInt64(pos, BigInt(0), false); pos += 8;
  }

  return buffer;
}

function buildGalleryIdBuffer(ids: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + ids.length * 4);
  const view = new DataView(buffer);
  view.setInt32(0, ids.length, false);
  ids.forEach((id, i) => view.setInt32(4 + i * 4, id, false));
  return buffer;
}
