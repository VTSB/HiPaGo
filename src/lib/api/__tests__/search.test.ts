// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  decodeNode,
  compareKeys,
  parseQuery,
  parseCompoundQuery,
  decodeGalleryIdData,
  decodeSuggestionData,
} from '../search';
import { TagType } from '@/lib/utils/types';
import type { IndexNode, Suggestion } from '@/lib/utils/types';

describe('search.ts', () => {
  describe('compareKeys', () => {
    it('should return 0 for equal Uint8Arrays', () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3, 4]);
      expect(compareKeys(a, b)).toBe(0);
    });

    it('should return negative when first is less', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 4]);
      expect(compareKeys(a, b)).toBeLessThan(0);
    });

    it('should return positive when first is greater', () => {
      const a = new Uint8Array([1, 2, 5]);
      const b = new Uint8Array([1, 2, 4]);
      expect(compareKeys(a, b)).toBeGreaterThan(0);
    });

    it('should handle different lengths (shorter is less)', () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([1, 2, 3]);
      expect(compareKeys(a, b)).toBeLessThan(0);
    });

    it('should handle different lengths (longer is greater)', () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      const b = new Uint8Array([1, 2, 3]);
      expect(compareKeys(a, b)).toBeGreaterThan(0);
    });

    it('should handle empty arrays', () => {
      const a = new Uint8Array([]);
      const b = new Uint8Array([]);
      expect(compareKeys(a, b)).toBe(0);
    });

    it('should handle one empty array', () => {
      const a = new Uint8Array([]);
      const b = new Uint8Array([1]);
      expect(compareKeys(a, b)).toBeLessThan(0);
    });
  });

  describe('parseQuery', () => {
    it('should parse artist tag type', () => {
      const result = parseQuery('artist:testname');
      expect(result).toEqual({
        tagType: 'artist',
        tag: 'testname',
      });
    });

    it('should parse male tag type', () => {
      const result = parseQuery('male:sometag');
      expect(result).toEqual({
        tagType: 'male',
        tag: 'sometag',
      });
    });

    it('should parse female tag type', () => {
      const result = parseQuery('female:sometag');
      expect(result).toEqual({
        tagType: 'female',
        tag: 'sometag',
      });
    });

    it('should parse series tag type', () => {
      const result = parseQuery('series:test');
      expect(result).toEqual({
        tagType: 'series',
        tag: 'test',
      });
    });

    it('should parse language tag type', () => {
      const result = parseQuery('language:japanese');
      expect(result).toEqual({
        tagType: 'language',
        tag: 'japanese',
      });
    });

    it('should parse character tag type', () => {
      const result = parseQuery('character:testchar');
      expect(result).toEqual({
        tagType: 'character',
        tag: 'testchar',
      });
    });

    it('should parse group tag type', () => {
      const result = parseQuery('group:testgroup');
      expect(result).toEqual({
        tagType: 'group',
        tag: 'testgroup',
      });
    });

    it('should parse type tag type', () => {
      const result = parseQuery('type:doujinshi');
      expect(result).toEqual({
        tagType: 'type',
        tag: 'doujinshi',
      });
    });

    it('should handle invalid tag type', () => {
      const result = parseQuery('notavalidtype:something');
      expect(result).toEqual({
        tagType: null,
        tag: 'notavalidtype:something',
      });
    });

    it('should handle simple query without colon', () => {
      const result = parseQuery('simple query');
      expect(result).toEqual({
        tagType: null,
        tag: 'simple query',
      });
    });

    it('should handle query with colon at start', () => {
      const result = parseQuery(':something');
      expect(result).toEqual({
        tagType: null,
        tag: ':something',
      });
    });

    it('should handle empty query', () => {
      const result = parseQuery('');
      expect(result).toEqual({
        tagType: null,
        tag: '',
      });
    });

    it('should trim tag after colon', () => {
      const result = parseQuery('artist:  testname  ');
      expect(result).toEqual({
        tagType: 'artist',
        tag: 'testname',
      });
    });

    it('should handle case-insensitive tag types', () => {
      const result = parseQuery('ARTIST:testname');
      expect(result).toEqual({
        tagType: 'artist',
        tag: 'testname',
      });
    });

    it('should handle mixed case tag types', () => {
      const result = parseQuery('ArTiSt:testname');
      expect(result).toEqual({
        tagType: 'artist',
        tag: 'testname',
      });
    });
  });

  describe('parseCompoundQuery', () => {
    it('should parse single typed term', () => {
      expect(parseCompoundQuery('female:loli')).toEqual(['female:loli']);
    });

    it('should parse multiple typed terms', () => {
      expect(parseCompoundQuery('female:loli artist:yam')).toEqual(['female:loli', 'artist:yam']);
    });

    it('should parse single untyped term', () => {
      expect(parseCompoundQuery('loli')).toEqual(['loli']);
    });

    it('should parse mixed typed and untyped terms', () => {
      expect(parseCompoundQuery('female:loli test')).toEqual(['female:loli', 'test']);
    });

    it('should handle empty string', () => {
      expect(parseCompoundQuery('')).toEqual([]);
    });

    it('should handle whitespace-only string', () => {
      expect(parseCompoundQuery('   ')).toEqual([]);
    });

    it('should handle multiple spaces between terms', () => {
      const result = parseCompoundQuery('female:loli  artist:yam');
      expect(result).toEqual(['female:loli', 'artist:yam']);
    });

    it('should handle three typed terms', () => {
      expect(parseCompoundQuery('female:loli artist:yam language:japanese')).toEqual([
        'female:loli', 'artist:yam', 'language:japanese',
      ]);
    });
  });

  describe('decodeGalleryIdData', () => {
    it('should decode buffer with gallery IDs', () => {
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setInt32(0, 3, false); // count = 3
      view.setInt32(4, 100, false); // id 1
      view.setInt32(8, 200, false); // id 2
      view.setInt32(12, 300, false); // id 3

      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([100, 200, 300]);
    });

    it('should handle empty buffer', () => {
      const buffer = new ArrayBuffer(0);
      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([]);
    });

    it('should handle buffer smaller than 4 bytes', () => {
      const buffer = new ArrayBuffer(2);
      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([]);
    });

    it('should handle count exceeding available data (boundary safety)', () => {
      const buffer = new ArrayBuffer(12);
      const view = new DataView(buffer);
      view.setInt32(0, 5, false); // count = 5, but only space for 2 IDs
      view.setInt32(4, 100, false); // id 1
      view.setInt32(8, 200, false); // id 2

      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([100, 200]); // Only returns 2 IDs
    });

    it('should handle single ID', () => {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      view.setInt32(0, 1, false); // count = 1
      view.setInt32(4, 42, false); // id

      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([42]);
    });

    it('should handle zero count', () => {
      const buffer = new ArrayBuffer(4);
      const view = new DataView(buffer);
      view.setInt32(0, 0, false); // count = 0

      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([]);
    });

    it('should handle negative IDs', () => {
      const buffer = new ArrayBuffer(12);
      const view = new DataView(buffer);
      view.setInt32(0, 2, false); // count = 2
      view.setInt32(4, -100, false); // negative id 1
      view.setInt32(8, -200, false); // negative id 2

      const result = decodeGalleryIdData(buffer);
      expect(result).toEqual([-100, -200]);
    });
  });

  describe('decodeSuggestionData', () => {
    function createSuggestionBuffer(suggestions: Array<{ ns: string; tag: string; count: number }>): ArrayBuffer {
      // Calculate total size
      let totalSize = 4; // count prefix
      for (const sugg of suggestions) {
        const nsBytes = new TextEncoder().encode(sugg.ns);
        const tagBytes = new TextEncoder().encode(sugg.tag);
        totalSize += 4 + nsBytes.length + 4 + tagBytes.length + 4;
      }

      const buffer = new ArrayBuffer(totalSize);
      const view = new DataView(buffer);
      let pos = 0;

      // Write count prefix
      view.setInt32(pos, suggestions.length, false);
      pos += 4;

      for (const sugg of suggestions) {
        const nsBytes = new TextEncoder().encode(sugg.ns);
        const tagBytes = new TextEncoder().encode(sugg.tag);

        // Write namespace length
        view.setInt32(pos, nsBytes.length, false);
        pos += 4;

        // Write namespace bytes
        new Uint8Array(buffer, pos, nsBytes.length).set(nsBytes);
        pos += nsBytes.length;

        // Write tag length
        view.setInt32(pos, tagBytes.length, false);
        pos += 4;

        // Write tag bytes
        new Uint8Array(buffer, pos, tagBytes.length).set(tagBytes);
        pos += tagBytes.length;

        // Write count
        view.setInt32(pos, sugg.count, false);
        pos += 4;
      }

      return buffer;
    }

    it('should decode single suggestion', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'artist', tag: 'testartist', count: 42 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: 'testartist',
          tagType: TagType.ARTIST,
          amount: 42,
        },
      ]);
    });

    it('should decode multiple suggestions', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'artist', tag: 'artist1', count: 10 },
        { ns: 'series', tag: 'series1', count: 20 },
        { ns: 'character', tag: 'char1', count: 30 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        { tag: 'artist1', tagType: TagType.ARTIST, amount: 10 },
        { tag: 'series1', tagType: TagType.SERIES, amount: 20 },
        { tag: 'char1', tagType: TagType.CHARACTER, amount: 30 },
      ]);
    });

    it('should use provided tagType override', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'artist', tag: 'testartist', count: 42 },
      ]);

      const result = decodeSuggestionData(buffer, TagType.SERIES);
      expect(result).toEqual([
        {
          tag: 'testartist',
          tagType: TagType.SERIES, // Override applied
          amount: 42,
        },
      ]);
    });

    it('should fallback to TAG for unknown namespace', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'unknown', tag: 'testtag', count: 5 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: 'testtag',
          tagType: TagType.TAG,
          amount: 5,
        },
      ]);
    });

    it('should handle empty buffer', () => {
      const buffer = new ArrayBuffer(0);
      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([]);
    });

    it('should handle male namespace', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'male', tag: 'maletag', count: 15 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: 'maletag',
          tagType: TagType.MALE,
          amount: 15,
        },
      ]);
    });

    it('should handle female namespace', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'female', tag: 'femaletag', count: 25 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: 'femaletag',
          tagType: TagType.FEMALE,
          amount: 25,
        },
      ]);
    });

    it('should limit results to SEARCH_LIMIT (100)', () => {
      const suggestions = [];
      for (let i = 0; i < 150; i++) {
        suggestions.push({ ns: 'tag', tag: `tag${i}`, count: i });
      }
      const buffer = createSuggestionBuffer(suggestions);

      const result = decodeSuggestionData(buffer, null);
      expect(result.length).toBe(100);
    });

    it('should handle corrupted buffer (truncated namespace)', () => {
      const buffer = new ArrayBuffer(12);
      const view = new DataView(buffer);
      view.setInt32(0, 1, false); // count = 1
      view.setInt32(4, 100, false); // ns length = 100, but buffer is only 12 bytes

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([]);
    });

    it('should handle corrupted buffer (truncated tag)', () => {
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setInt32(0, 1, false); // count = 1
      view.setInt32(4, 4, false); // ns length = 4
      const nsBytes = new TextEncoder().encode('test');
      new Uint8Array(buffer, 8, 4).set(nsBytes);
      view.setInt32(12, 100, false); // tag length = 100, but not enough space

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([]);
    });

    it('should handle empty strings', () => {
      const buffer = createSuggestionBuffer([
        { ns: '', tag: '', count: 1 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: '',
          tagType: TagType.TAG, // Empty namespace falls back to TAG
          amount: 1,
        },
      ]);
    });

    it('should handle language namespace', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'language', tag: 'english', count: 100 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: 'english',
          tagType: TagType.LANGUAGE,
          amount: 100,
        },
      ]);
    });

    it('should handle group namespace', () => {
      const buffer = createSuggestionBuffer([
        { ns: 'group', tag: 'testgroup', count: 50 },
      ]);

      const result = decodeSuggestionData(buffer, null);
      expect(result).toEqual([
        {
          tag: 'testgroup',
          tagType: TagType.GROUP,
          amount: 50,
        },
      ]);
    });
  });

  describe('decodeNode', () => {
    function createNodeBuffer(
      keys: Uint8Array[],
      datas: Array<{ offset: number; length: number }>,
      subNodeAddresses: number[],
    ): ArrayBuffer {
      // B = 16, so we need 17 subnode addresses
      const numberOfSubNodes = 17;

      // Calculate size
      let size = 4; // numberOfKeys
      for (const key of keys) {
        size += 4 + key.length; // keyLength + keyBytes
      }
      size += 4; // numberOfDatas
      size += datas.length * 12; // each data: 8 bytes offset + 4 bytes length
      size += numberOfSubNodes * 8; // 17 subnodes × 8 bytes each

      const buffer = new ArrayBuffer(size);
      const view = new DataView(buffer);
      let pos = 0;

      // Write number of keys
      view.setInt32(pos, keys.length, false);
      pos += 4;

      // Write keys
      for (const key of keys) {
        view.setInt32(pos, key.length, false);
        pos += 4;
        new Uint8Array(buffer, pos, key.length).set(key);
        pos += key.length;
      }

      // Write number of datas
      view.setInt32(pos, datas.length, false);
      pos += 4;

      // Write datas
      for (const data of datas) {
        view.setBigInt64(pos, BigInt(data.offset), false);
        pos += 8;
        view.setInt32(pos, data.length, false);
        pos += 4;
      }

      // Write subnode addresses
      for (let i = 0; i < numberOfSubNodes; i++) {
        const addr = i < subNodeAddresses.length ? subNodeAddresses[i] : 0;
        view.setBigInt64(pos, BigInt(addr), false);
        pos += 8;
      }

      return buffer;
    }

    it('should decode node with keys, datas, and subnodes', () => {
      const keys = [
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8]),
      ];
      const datas = [
        { offset: 1000, length: 100 },
        { offset: 2000, length: 200 },
      ];
      const subNodeAddresses = [100, 200, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

      const buffer = createNodeBuffer(keys, datas, subNodeAddresses);
      const result = decodeNode(buffer);

      expect(result.keys.length).toBe(2);
      expect(Array.from(result.keys[0])).toEqual([1, 2, 3, 4]);
      expect(Array.from(result.keys[1])).toEqual([5, 6, 7, 8]);
      expect(result.datas).toEqual([
        { offset: 1000, length: 100 },
        { offset: 2000, length: 200 },
      ]);
      expect(result.subNodeAddresses).toEqual(subNodeAddresses);
    });

    it('should decode node with zero keys', () => {
      const buffer = createNodeBuffer([], [], []);
      const result = decodeNode(buffer);

      expect(result.keys).toEqual([]);
      expect(result.datas).toEqual([]);
      expect(result.subNodeAddresses.length).toBe(17);
      expect(result.subNodeAddresses.every(addr => addr === 0)).toBe(true);
    });

    it('should skip keys with invalid length (> 32)', () => {
      const buffer = new ArrayBuffer(300);
      const view = new DataView(buffer);
      let pos = 0;

      // Number of keys = 3
      view.setInt32(pos, 3, false);
      pos += 4;

      // First key: length = 4 (valid)
      view.setInt32(pos, 4, false);
      pos += 4;
      new Uint8Array(buffer, pos, 4).set(new Uint8Array([1, 2, 3, 4]));
      pos += 4;

      // Second key: length = 33 (invalid, should be skipped but offset still moves past length field)
      view.setInt32(pos, 33, false);
      pos += 4;

      // Third key: length = 4 (valid) - but this will be read at wrong offset due to skipped bytes
      view.setInt32(pos, 4, false);
      pos += 4;
      new Uint8Array(buffer, pos, 4).set(new Uint8Array([5, 6, 7, 8]));
      pos += 4;

      // Number of datas = 0
      view.setInt32(pos, 0, false);
      pos += 4;

      // 17 subnodes (all zero)
      for (let i = 0; i < 17; i++) {
        view.setBigInt64(pos, BigInt(0), false);
        pos += 8;
      }

      const result = decodeNode(buffer);
      // First and third keys are valid (offset advances by 4 each iteration regardless)
      expect(result.keys.length).toBe(2);
      expect(Array.from(result.keys[0])).toEqual([1, 2, 3, 4]);
      expect(Array.from(result.keys[1])).toEqual([5, 6, 7, 8]);
    });

    it('should skip keys with zero length', () => {
      const buffer = new ArrayBuffer(300);
      const view = new DataView(buffer);
      let pos = 0;

      // Number of keys = 2
      view.setInt32(pos, 2, false);
      pos += 4;

      // First key: length = 0 (invalid)
      view.setInt32(pos, 0, false);
      pos += 4;

      // Second key: length = 4 (valid)
      view.setInt32(pos, 4, false);
      pos += 4;
      new Uint8Array(buffer, pos, 4).set(new Uint8Array([1, 2, 3, 4]));
      pos += 4;

      // Number of datas = 0
      view.setInt32(pos, 0, false);
      pos += 4;

      // 17 subnodes
      for (let i = 0; i < 17; i++) {
        view.setBigInt64(pos, BigInt(0), false);
        pos += 8;
      }

      const result = decodeNode(buffer);
      expect(result.keys.length).toBe(1);
      expect(Array.from(result.keys[0])).toEqual([1, 2, 3, 4]);
    });

    it('should handle buffer too small for all subnodes', () => {
      const buffer = new ArrayBuffer(50); // Small buffer
      const view = new DataView(buffer);

      // Number of keys = 0
      view.setInt32(0, 0, false);

      // Number of datas = 0
      view.setInt32(4, 0, false);

      // Only room for a few subnodes
      view.setBigInt64(8, BigInt(100), false);
      view.setBigInt64(16, BigInt(200), false);

      const result = decodeNode(buffer);
      expect(result.subNodeAddresses.length).toBe(17);
      expect(result.subNodeAddresses[0]).toBe(100);
      expect(result.subNodeAddresses[1]).toBe(200);
      // Rest should be 0 (filled by else branch)
      for (let i = 2; i < 17; i++) {
        expect(result.subNodeAddresses[i]).toBe(0);
      }
    });

    it('should decode multiple datas correctly', () => {
      const datas = [
        { offset: 1000, length: 100 },
        { offset: 2000, length: 200 },
        { offset: 3000, length: 300 },
        { offset: 4000, length: 400 },
      ];

      const buffer = createNodeBuffer([], datas, []);
      const result = decodeNode(buffer);

      expect(result.datas).toEqual(datas);
    });

    it('should handle large offset values (BigInt64)', () => {
      const largeOffset = Number.MAX_SAFE_INTEGER - 1000;
      const datas = [{ offset: largeOffset, length: 50 }];

      const buffer = createNodeBuffer([], datas, []);
      const result = decodeNode(buffer);

      expect(result.datas[0].offset).toBe(largeOffset);
      expect(result.datas[0].length).toBe(50);
    });

    it('should decode node with maximum valid key length (32)', () => {
      const maxKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        maxKey[i] = i;
      }

      const buffer = createNodeBuffer([maxKey], [], []);
      const result = decodeNode(buffer);

      expect(result.keys.length).toBe(1);
      expect(result.keys[0].length).toBe(32);
      expect(Array.from(result.keys[0])).toEqual(Array.from(maxKey));
    });

    it('should handle all 17 subnode addresses', () => {
      const subNodes = Array.from({ length: 17 }, (_, i) => (i + 1) * 1000);
      const buffer = createNodeBuffer([], [], subNodes);
      const result = decodeNode(buffer);

      expect(result.subNodeAddresses).toEqual(subNodes);
    });
  });
});
