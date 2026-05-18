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

// JSON fixtures for the tag-i18n store (drives Korean → English normalization).
const mockKoJson = vi.hoisted(() => ({
  default: {
    female: { loli: '로리', 'big breasts': '큰 가슴' },
    artist: { yam: '얌' },
  } as Record<string, Record<string, string>>,
}));
vi.mock('@/lib/data/tags-i18n/ko.json', () => mockKoJson);
vi.mock('@/lib/data/tags-i18n/ko.ai.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/ja.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/ja.ai.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hans.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hans.ai.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hant.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hant.ai.json', () => ({ default: {} }));

import { apiClient } from '../client';
import { fetchIndexVersion } from '../gallery';
import { fetchNozomiSearch } from '../nozomi';
import { getGalleryIdsForQuery, getSuggestionsForQuery } from '../search';
import { useTagI18nStore } from '@/lib/store/tag-i18n';

describe('getGalleryIdsForQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('typed queries (tag type specified)', () => {
    it('female tag routes to nozomi with "tag" area and prefixed tag', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([100, 200]);

      const result = await getGalleryIdsForQuery('female:stockings', 'all');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:stockings', 'all', undefined);
      expect(result).toEqual([100, 200]);
    });

    it('male tag routes to nozomi with "tag" area and prefixed tag', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([300]);

      const result = await getGalleryIdsForQuery('male:glasses', 'japanese');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'male:glasses', 'japanese', undefined);
      expect(result).toEqual([300]);
    });

    it('language query routes to nozomi with empty area and "index" tag', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([1, 2, 3]);

      const result = await getGalleryIdsForQuery('language:korean', 'all');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('', 'index', 'korean', undefined);
      expect(result).toEqual([1, 2, 3]);
    });

    it('artist query routes to nozomi with tagType as area', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([500, 600]);

      const result = await getGalleryIdsForQuery('artist:testartist', 'all');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('artist', 'testartist', 'all', undefined);
      expect(result).toEqual([500, 600]);
    });

    it('series query routes to nozomi with tagType as area', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([700]);

      const result = await getGalleryIdsForQuery('series:testseries', 'english');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('series', 'testseries', 'english', undefined);
      expect(result).toEqual([700]);
    });

    it('uses "all" when language is empty string', async () => {
      vi.mocked(fetchNozomiSearch).mockResolvedValue([]);

      await getGalleryIdsForQuery('artist:test', '');

      expect(fetchNozomiSearch).toHaveBeenCalledWith('artist', 'test', 'all', undefined);
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

    it('traverses subnode when root key is less than the search hash (lo = mid+1 path)', async () => {
      vi.mocked(fetchIndexVersion).mockResolvedValue('v1');

      // Hash "subterm" to determine what the subnode key must be
      const targetHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('subterm')),
      ).slice(0, 4);

      // Root node: one key that is LESS than targetHash (all-zeros < any real hash)
      // so compareKeys(targetHash, rootKey) > 0 → lo = mid+1 = 1
      // subIdx = lo = 1, which must be non-zero
      const B = 16;
      const numberOfSubNodes = B + 1;
      const subAddrs = new Array<number>(numberOfSubNodes).fill(0);
      subAddrs[1] = 9999; // subnode address at index 1

      const rootBuffer = buildMultiKeyNode(
        [new Uint8Array([0x00, 0x00, 0x00, 0x01])], // key < targetHash
        [{ offset: 0, length: 4 }],
        subAddrs,
      );

      // Subnode: contains exactly targetHash as key, with data pointing to gallery IDs
      const subnodeBuffer = buildNodeWithKeyAndData(targetHash, { offset: 0, length: 8 });

      vi.mocked(apiClient.fetchLtnBinary)
        .mockResolvedValueOnce(rootBuffer)    // root node
        .mockResolvedValueOnce(subnodeBuffer) // subnode
        .mockResolvedValueOnce(buildGalleryIdBuffer([777, 888])); // data

      const result = await getGalleryIdsForQuery('subterm', 'all');

      expect(result).toEqual([777, 888]);
    });

    it('returns empty array when subnode fetch throws (getNodeAtAddress catch block)', async () => {
      vi.mocked(fetchIndexVersion).mockResolvedValue('v1');

      const targetHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('failterm')),
      ).slice(0, 4);

      const B = 16;
      const numberOfSubNodes = B + 1;
      const subAddrs = new Array<number>(numberOfSubNodes).fill(0);
      subAddrs[1] = 8888; // non-zero so subnode traversal is attempted

      const rootBuffer = buildMultiKeyNode(
        [new Uint8Array([0x00, 0x00, 0x00, 0x01])], // key < targetHash
        [{ offset: 0, length: 4 }],
        subAddrs,
      );

      vi.mocked(apiClient.fetchLtnBinary)
        .mockResolvedValueOnce(rootBuffer)             // root node succeeds
        .mockRejectedValueOnce(new Error('fetch fail')); // subnode fetch throws → catch returns null

      const result = await getGalleryIdsForQuery('failterm', 'all');

      expect(result).toEqual([]);
    });

    it('exercises lo = mid+1 then hi = mid-1 before exiting (two-key node, hash between keys)', async () => {
      vi.mocked(fetchIndexVersion).mockResolvedValue('v1');

      const targetHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('midterm')),
      ).slice(0, 4);

      // Construct two keys that straddle the target hash:
      //   key0 = targetHash with last byte decremented (strictly less)
      //   key1 = targetHash with last byte incremented (strictly greater)
      // so: cmp(target, key0) > 0 → lo = 1
      //     cmp(target, key1) < 0 → hi = 0
      //     loop exits with lo=1 > hi=0; subIdx=1; subNodeAddresses[1]=0 → return null
      const key0 = new Uint8Array(targetHash);
      key0[3] = Math.max(0, key0[3] - 1);
      const key1 = new Uint8Array(targetHash);
      key1[3] = Math.min(255, key1[3] + 1);

      // If decrement/increment collide with targetHash (e.g. targetHash[3] === 0 or 255),
      // adjust byte at index 2 instead to ensure strict ordering
      if (key0[3] === targetHash[3]) { key0[2] = Math.max(0, key0[2] - 1); }
      if (key1[3] === targetHash[3]) { key1[2] = Math.min(255, key1[2] + 1); }

      const rootBuffer = buildMultiKeyNode(
        [key0, key1],
        [{ offset: 0, length: 4 }, { offset: 4, length: 4 }],
        // all sub-node addresses = 0 → traversal returns null after binary search misses
      );

      vi.mocked(apiClient.fetchLtnBinary).mockResolvedValueOnce(rootBuffer);

      const result = await getGalleryIdsForQuery('midterm', 'all');

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

describe('getGalleryIdsForQuery — multi-term intersection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns intersection of two typed terms that share IDs', async () => {
    // female:loli returns [500, 300, 100] (descending)
    // artist:yam returns [400, 300, 200, 100] (descending)
    // intersection: [300, 100]
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([500, 300, 100])
      .mockResolvedValueOnce([400, 300, 200, 100]);

    const result = await getGalleryIdsForQuery('female:loli artist:yam', 'all');

    expect(fetchNozomiSearch).toHaveBeenCalledTimes(2);
    expect(result).toEqual([300, 100]);
  });

  it('returns empty array when two typed terms have no overlapping IDs', async () => {
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([500, 300, 100])
      .mockResolvedValueOnce([400, 200]);

    const result = await getGalleryIdsForQuery('female:loli artist:yam', 'all');

    expect(result).toEqual([]);
  });

  it('returns intersection of three typed terms', async () => {
    // female:loli → [600, 500, 300, 200, 100]
    // artist:yam  → [500, 300, 100, 50]
    // series:test → [700, 500, 100]
    // intersection of all three: [500, 100]
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([600, 500, 300, 200, 100])
      .mockResolvedValueOnce([500, 300, 100, 50])
      .mockResolvedValueOnce([700, 500, 100]);

    const result = await getGalleryIdsForQuery('female:loli artist:yam series:test', 'all');

    expect(fetchNozomiSearch).toHaveBeenCalledTimes(3);
    expect(result).toEqual([500, 100]);
  });

  it('returns empty array early when intermediate intersection is empty', async () => {
    // First two terms produce empty intersection; third term is never consulted
    // but all three are fetched in parallel before intersecting
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([300, 200])   // female:loli
      .mockResolvedValueOnce([100, 50])    // artist:yam — no overlap with above
      .mockResolvedValueOnce([300, 200]);  // series:test (fetched in parallel)

    const result = await getGalleryIdsForQuery('female:loli artist:yam series:test', 'all');

    expect(result).toEqual([]);
  });

  it('returns multiple IDs shared across all terms in descending order', async () => {
    // 999 and 42 appear in all three sets; 500, 200, 100 do not
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([999, 500, 42])
      .mockResolvedValueOnce([999, 200, 42])
      .mockResolvedValueOnce([999, 100, 42]);

    const result = await getGalleryIdsForQuery('female:loli artist:yam character:char', 'all');

    expect(result).toEqual([999, 42]);
  });

  it('passes language to each term fetch', async () => {
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([10])
      .mockResolvedValueOnce([10]);

    await getGalleryIdsForQuery('female:loli artist:yam', 'japanese');

    expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:loli', 'japanese', undefined);
    expect(fetchNozomiSearch).toHaveBeenCalledWith('artist', 'yam', 'japanese', undefined);
  });

  it('includes plain text terms in intersection when mixed with tag terms', async () => {
    // Query: "artist:yam 검색어 female:loli" — all three terms are searched and intersected.
    // Typed terms sort first: artist:yam, female:loli fetched via nozomi.
    // "검색어" fetched via B-tree; non-matching key → returns [].
    // Intersection with [] = [].
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([500, 300, 100])  // artist:yam
      .mockResolvedValueOnce([400, 300, 100]); // female:loli

    // B-tree lookup for "검색어": version + node with non-matching key
    vi.mocked(fetchIndexVersion).mockResolvedValueOnce('v1');
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValueOnce(
      buildNodeWithKeyAndData(new Uint8Array([0xff, 0xff, 0xff, 0xff]), { offset: 0, length: 4 }),
    );

    const result = await getGalleryIdsForQuery('artist:yam 검색어 female:loli', 'all');

    // 2 nozomi fetches (typed terms) + 1 B-tree fetch (plain text term)
    expect(fetchNozomiSearch).toHaveBeenCalledTimes(2);
    // B-tree returned empty for "검색어" → intersection with [] = []
    expect(result).toEqual([]);
  });

  it('intersects tag and text term results when query has both', async () => {
    // Query: "artist:yam hello" — both terms are searched and intersected.
    // Typed term sorts first: artist:yam via nozomi → [500, 300, 100].
    // "hello" via B-tree: non-matching key → [].
    // Intersection = [].
    vi.mocked(fetchNozomiSearch).mockResolvedValueOnce([500, 300, 100]);

    vi.mocked(fetchIndexVersion).mockResolvedValueOnce('v1');
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValueOnce(
      buildNodeWithKeyAndData(new Uint8Array([0xff, 0xff, 0xff, 0xff]), { offset: 0, length: 4 }),
    );

    const result = await getGalleryIdsForQuery('artist:yam hello', 'all');

    expect(fetchNozomiSearch).toHaveBeenCalledTimes(1);
    // B-tree returned empty for "hello" → intersection = []
    expect(result).toEqual([]);
  });

  it('excludes negative term results from positive term results', async () => {
    // Query: "female:loli -male:yaoi"
    // female:loli → [500, 400, 300, 200, 100]
    // male:yaoi (negative, stripped to "male:yaoi") → [400, 200]
    // Result: [500, 300, 100] (400 and 200 excluded)
    vi.mocked(fetchNozomiSearch)
      .mockResolvedValueOnce([500, 400, 300, 200, 100])  // female:loli
      .mockResolvedValueOnce([400, 200]);                 // male:yaoi

    const result = await getGalleryIdsForQuery('female:loli -male:yaoi', 'all');

    expect(fetchNozomiSearch).toHaveBeenCalledTimes(2);
    expect(result).toEqual([500, 300, 100]);
  });

  it('returns empty array for single negative term with no positive terms', async () => {
    const result = await getGalleryIdsForQuery('-female:loli', 'all');

    expect(fetchNozomiSearch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('sorts typed terms first before plain text in positive terms', async () => {
    // Query: "hello female:loli" — typed term "female:loli" should sort before "hello"
    vi.mocked(fetchNozomiSearch).mockResolvedValueOnce([500, 300, 100]);

    vi.mocked(fetchIndexVersion).mockResolvedValueOnce('v1');
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValueOnce(
      buildNodeWithKeyAndData(new Uint8Array([0xff, 0xff, 0xff, 0xff]), { offset: 0, length: 4 }),
    );

    const result = await getGalleryIdsForQuery('hello female:loli', 'all');

    // Both terms searched: nozomi for typed, B-tree for plain
    expect(fetchNozomiSearch).toHaveBeenCalledTimes(1);
    expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:loli', 'all', undefined);
    expect(result).toEqual([]);
  });

  it('intersects multiple plain text terms via B-tree', async () => {
    // Query: "hello world" — both terms searched via B-tree and intersected
    const helloHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello')),
    ).slice(0, 4);
    const worldHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('world')),
    ).slice(0, 4);

    vi.mocked(fetchIndexVersion)
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v1');

    vi.mocked(apiClient.fetchLtnBinary)
      // "hello" B-tree: matching node + gallery data
      .mockResolvedValueOnce(buildNodeWithKeyAndData(helloHash, { offset: 0, length: 12 }))
      .mockResolvedValueOnce(buildGalleryIdBuffer([500, 300, 100]))
      // "world" B-tree: matching node + gallery data
      .mockResolvedValueOnce(buildNodeWithKeyAndData(worldHash, { offset: 0, length: 12 }))
      .mockResolvedValueOnce(buildGalleryIdBuffer([400, 300, 200]));

    const result = await getGalleryIdsForQuery('hello world', 'all');

    // Intersection of [500, 300, 100] and [400, 300, 200] = [300]
    expect(result).toEqual([300]);
  });
});

describe('getSuggestionsForQuery — encodeTagIndexChar special characters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encodes forward slash as "slash" in the URL path', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    await getSuggestionsForQuery('a/b');

    // 'a' → 'a', '/' → 'slash', 'b' → 'b'
    expect(apiClient.fetchUrl).toHaveBeenCalledWith('/api/tagindex/global/a/slash/b.json');
  });

  it('encodes dot as "dot" in the URL path', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    await getSuggestionsForQuery('a.b');

    // 'a' → 'a', '.' → 'dot', 'b' → 'b'
    expect(apiClient.fetchUrl).toHaveBeenCalledWith('/api/tagindex/global/a/dot/b.json');
  });

  it('encodes both slash and dot in the same query', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(apiClient.fetchUrl).mockResolvedValue(mockResponse as any);

    await getSuggestionsForQuery('a/.b');

    // 'a' → 'a', '/' → 'slash', '.' → 'dot', 'b' → 'b'
    expect(apiClient.fetchUrl).toHaveBeenCalledWith('/api/tagindex/global/a/slash/dot/b.json');
  });
});

// ---------------------------------------------------------------------------
// AC-006 — a Korean type-qualified query normalizes to English before nozomi.
// ---------------------------------------------------------------------------
describe('getGalleryIdsForQuery — Korean query normalization', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await useTagI18nStore.getState().loadLocale('ko');
  });

  it('a Korean tag query hits nozomi with the same args as the English query', async () => {
    vi.mocked(fetchNozomiSearch).mockResolvedValue([100, 200]);
    const korean = await getGalleryIdsForQuery('여자:로리', 'all');

    vi.mocked(fetchNozomiSearch).mockClear();
    vi.mocked(fetchNozomiSearch).mockResolvedValue([100, 200]);
    const english = await getGalleryIdsForQuery('female:loli', 'all');

    expect(korean).toEqual(english);
    expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:loli', 'all', undefined);
  });

  it('underscored multi-word Korean tag normalizes correctly', async () => {
    vi.mocked(fetchNozomiSearch).mockResolvedValue([300]);
    await getGalleryIdsForQuery('여자:큰_가슴', 'all');
    expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:big breasts', 'all', undefined);
  });

  it('a Korean artist query normalizes to the English artist nozomi path', async () => {
    vi.mocked(fetchNozomiSearch).mockResolvedValue([500]);
    await getGalleryIdsForQuery('작가:얌', 'all');
    expect(fetchNozomiSearch).toHaveBeenCalledWith('artist', 'yam', 'all', undefined);
  });

  it('an English query is unaffected by the normalization layer', async () => {
    vi.mocked(fetchNozomiSearch).mockResolvedValue([1, 2]);
    await getGalleryIdsForQuery('female:loli', 'all');
    expect(fetchNozomiSearch).toHaveBeenCalledWith('tag', 'female:loli', 'all', undefined);
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

/**
 * Build a node buffer with multiple keys, one data entry per key, and
 * configurable sub-node addresses.
 *
 * keys       — sorted array of 4-byte Uint8Arrays
 * datas      — one {offset, length} per key (same length as keys)
 * subAddrs   — array of (B+1) = 17 sub-node addresses (default all 0)
 */
function buildMultiKeyNode(
  keys: Uint8Array[],
  datas: { offset: number; length: number }[],
  subAddrs?: number[],
): ArrayBuffer {
  const B = 16;
  const numberOfSubNodes = B + 1;
  const resolvedSubAddrs = subAddrs ?? new Array<number>(numberOfSubNodes).fill(0);

  let size = 4; // numberOfKeys
  for (const k of keys) size += 4 + k.length;
  size += 4; // numberOfDatas
  size += datas.length * 12; // each data: 8 (bigint64) + 4 (int32)
  size += numberOfSubNodes * 8;

  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let pos = 0;

  view.setInt32(pos, keys.length, false); pos += 4;
  for (const k of keys) {
    view.setInt32(pos, k.length, false); pos += 4;
    new Uint8Array(buffer, pos, k.length).set(k); pos += k.length;
  }

  view.setInt32(pos, datas.length, false); pos += 4;
  for (const d of datas) {
    view.setBigInt64(pos, BigInt(d.offset), false); pos += 8;
    view.setInt32(pos, d.length, false); pos += 4;
  }

  for (let i = 0; i < numberOfSubNodes; i++) {
    view.setBigInt64(pos, BigInt(resolvedSubAddrs[i] ?? 0), false); pos += 8;
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
