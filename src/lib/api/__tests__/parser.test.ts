// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  parseGalleryJson,
  galleryInfoToImages,
  categorizeTags,
  galleryInfoToBlock,
  parseDate,
  parseLanguageSupport,
  parseIndexVersion,
} from '../parser';
import { GalleryBlockType, ImageType, TagType } from '@/lib/utils/types';
import type { GalleryInfo, GalleryTagJson } from '@/lib/utils/types';

const SAMPLE_JSON = `var galleryinfo = {
  "language_localname": "日本語",
  "language": "japanese",
  "date": "2024-01-15 12:30",
  "files": [
    {
      "width": 1280,
      "height": 1800,
      "haswebp": 1,
      "hasavifsmalltn": 1,
      "hasavif": 1,
      "name": "001.jpg",
      "hash": "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    },
    {
      "width": 1280,
      "height": 1800,
      "haswebp": 1,
      "hasavifsmalltn": 0,
      "hasavif": 0,
      "name": "002.png",
      "hash": "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    }
  ],
  "tags": [
    { "male": "1", "female": "0", "url": "tag/sample%20male-all.html", "tag": "sample male" },
    { "male": "0", "female": "1", "url": "tag/sample%20female-all.html", "tag": "sample female" },
    { "male": "0", "female": "0", "url": "artist/testartist-all.html", "tag": "testartist" },
    { "male": "0", "female": "0", "url": "series/testseries-all.html", "tag": "testseries" }
  ],
  "japanese_title": "テストタイトル",
  "title": "Test Title",
  "id": "12345",
  "type": "doujinshi"
}`;

describe('parseGalleryJson', () => {
  it('strips var prefix and parses JSON', () => {
    const info = parseGalleryJson(SAMPLE_JSON);
    expect(info.title).toBe('Test Title');
    expect(info.japaneseTitle).toBe('テストタイトル');
    expect(info.id).toBe(12345);
    expect(info.language).toBe('japanese');
    expect(info.languageLocalName).toBe('日本語');
    expect(info.type).toBe('doujinshi');
  });

  it('parses files correctly', () => {
    const info = parseGalleryJson(SAMPLE_JSON);
    expect(info.files).toHaveLength(2);
    expect(info.files[0].name).toBe('001.jpg');
    expect(info.files[0].hash).toBe(
      'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    );
    expect(info.files[0].width).toBe(1280);
    expect(info.files[0].height).toBe(1800);
    expect(info.files[0].haswebp).toBe(1);
    expect(info.files[0].hasavif).toBe(1);
    expect(info.files[0].hasavifsmalltn).toBe(1);
  });

  it('parses tags', () => {
    const info = parseGalleryJson(SAMPLE_JSON);
    expect(info.tags).toHaveLength(4);
    expect(info.tags[0].male).toBe('1');
    expect(info.tags[1].female).toBe('1');
  });

  it('handles string id by converting to number', () => {
    const info = parseGalleryJson(SAMPLE_JSON);
    expect(info.id).toBe(12345);
    expect(typeof info.id).toBe('number');
  });

  it('handles missing fields gracefully', () => {
    const minimal = 'var galleryinfo = {"id": 1}';
    const info = parseGalleryJson(minimal);
    expect(info.id).toBe(1);
    expect(info.title).toBe('');
    expect(info.files).toEqual([]);
    expect(info.tags).toEqual([]);
  });
});

describe('galleryInfoToImages', () => {
  it('converts gallery files to images with type sets', () => {
    const info = parseGalleryJson(SAMPLE_JSON);
    const images = galleryInfoToImages(info);
    expect(images.id).toBe(12345);
    expect(images.images).toHaveLength(2);

    // First file has avif and webp
    expect(images.images[0].types.has(ImageType.ORIGINAL)).toBe(true);
    expect(images.images[0].types.has(ImageType.WEBP)).toBe(true);
    expect(images.images[0].types.has(ImageType.AVIF)).toBe(true);

    // Second file has webp only
    expect(images.images[1].types.has(ImageType.ORIGINAL)).toBe(true);
    expect(images.images[1].types.has(ImageType.WEBP)).toBe(true);
    expect(images.images[1].types.has(ImageType.AVIF)).toBe(false);
  });
});

describe('categorizeTags', () => {
  it('categorizes male/female tags', () => {
    const tags: GalleryTagJson[] = [
      { male: '1', female: '0', url: 'tag/male-all.html', tag: 'maleTag' },
      { male: '0', female: '1', url: 'tag/female-all.html', tag: 'femaleTag' },
    ];
    const result = categorizeTags(tags);
    expect(result[TagType.MALE]).toEqual(['maleTag']);
    expect(result[TagType.FEMALE]).toEqual(['femaleTag']);
  });

  it('categorizes by URL prefix', () => {
    const tags: GalleryTagJson[] = [
      { male: '0', female: '0', url: 'artist/test-all.html', tag: 'artist1' },
      { male: '0', female: '0', url: 'series/test-all.html', tag: 'series1' },
      { male: '0', female: '0', url: 'group/test-all.html', tag: 'group1' },
      { male: '0', female: '0', url: 'character/test-all.html', tag: 'char1' },
    ];
    const result = categorizeTags(tags);
    expect(result[TagType.ARTIST]).toEqual(['artist1']);
    expect(result[TagType.SERIES]).toEqual(['series1']);
    expect(result[TagType.GROUP]).toEqual(['group1']);
    expect(result[TagType.CHARACTER]).toEqual(['char1']);
  });

  it('falls back to TAG for unknown URL prefix', () => {
    const tags: GalleryTagJson[] = [
      { male: '0', female: '0', url: 'unknown/test.html', tag: 'something' },
    ];
    const result = categorizeTags(tags);
    expect(result[TagType.TAG]).toEqual(['something']);
  });
});

describe('galleryInfoToBlock', () => {
  it('converts GalleryInfo to GalleryBlock', () => {
    const info = parseGalleryJson(SAMPLE_JSON);
    const block = galleryInfoToBlock(info);
    expect(block.id).toBe(12345);
    expect(block.type).toBe(GalleryBlockType.DETAILED);
    expect(block.title).toBe('Test Title');
    expect(block.thumbnail).toContain('/api/img/tn/');
    expect(block.related).toEqual([]);
  });

  it('uses japaneseTitle when title is empty', () => {
    const json = 'var galleryinfo = {"id": 1, "japanese_title": "テスト", "files": [], "tags": []}';
    const info = parseGalleryJson(json);
    const block = galleryInfoToBlock(info);
    expect(block.title).toBe('テスト');
  });

  it('sets language and mediaType from GalleryInfo', () => {
    const json = `var galleryinfo = {
      "id": 42,
      "title": "Test",
      "japanese_title": "",
      "language": "japanese",
      "language_localname": "日本語",
      "date": "2024-01-01 00:00",
      "type": "doujinshi",
      "files": [],
      "tags": []
    }`;
    const info = parseGalleryJson(json);
    const block = galleryInfoToBlock(info);
    expect(block.language).toBe('japanese');
    expect(block.mediaType).toBe('doujinshi');
  });
});

describe('parseDate', () => {
  it('parses standard date format', () => {
    const date = parseDate('2024-01-15 12:30');
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(0); // January
    expect(date.getDate()).toBe(15);
  });

  it('strips timezone offset suffix', () => {
    const date = parseDate('2024-01-15 12:30:00-09');
    expect(date.getFullYear()).toBe(2024);
  });

  it('returns current date for empty string', () => {
    const date = parseDate('');
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBeGreaterThan(0);
  });

  it('returns current date for invalid string', () => {
    const date = parseDate('not-a-date');
    expect(date).toBeInstanceOf(Date);
  });
});

describe('parseLanguageSupport', () => {
  it('parses language array from text', () => {
    const text = '["japanese", "english", "chinese"]';
    expect(parseLanguageSupport(text)).toEqual(['japanese', 'english', 'chinese']);
  });

  it('handles single quotes', () => {
    const text = "['japanese', 'english']";
    expect(parseLanguageSupport(text)).toEqual(['japanese', 'english']);
  });

  it('returns empty for no match', () => {
    expect(parseLanguageSupport('no brackets here')).toEqual([]);
  });
});

describe('parseIndexVersion', () => {
  it('trims whitespace', () => {
    expect(parseIndexVersion('  42  \n')).toBe('42');
  });

  it('returns version string as-is', () => {
    expect(parseIndexVersion('123')).toBe('123');
  });
});

describe('parseGalleryJson — top-level artist/group/character/parody arrays', () => {
  const JSON_WITH_ARRAYS = `var galleryinfo = {
    "id": "99999",
    "title": "Array Test",
    "japanese_title": "",
    "language": "english",
    "language_localname": "English",
    "date": "2025-06-01 00:00",
    "type": "manga",
    "files": [],
    "tags": [],
    "artists": [{"artist": "artist-one"}, {"artist": "artist-two"}],
    "groups": [{"group": "group-alpha"}],
    "characters": [{"character": "char-a"}, {"character": "char-b"}],
    "parodys": [{"parody": "series-x"}]
  }`;

  it('parses artists array into string list', () => {
    const info = parseGalleryJson(JSON_WITH_ARRAYS);
    expect(info.artists).toEqual(['artist-one', 'artist-two']);
  });

  it('parses groups array into string list', () => {
    const info = parseGalleryJson(JSON_WITH_ARRAYS);
    expect(info.groups).toEqual(['group-alpha']);
  });

  it('parses characters array into string list', () => {
    const info = parseGalleryJson(JSON_WITH_ARRAYS);
    expect(info.characters).toEqual(['char-a', 'char-b']);
  });

  it('parses parodys array into string list', () => {
    const info = parseGalleryJson(JSON_WITH_ARRAYS);
    expect(info.parodys).toEqual(['series-x']);
  });

  it('returns empty arrays when fields are absent', () => {
    const minimal = 'var galleryinfo = {"id": 1}';
    const info = parseGalleryJson(minimal);
    expect(info.artists).toEqual([]);
    expect(info.groups).toEqual([]);
    expect(info.characters).toEqual([]);
    expect(info.parodys).toEqual([]);
  });

  it('filters out entries with empty artist value', () => {
    const json = `var galleryinfo = {
      "id": 1,
      "artists": [{"artist": "valid"}, {"artist": ""}]
    }`;
    const info = parseGalleryJson(json);
    expect(info.artists).toEqual(['valid']);
  });
});

describe('parseGalleryJson — related array numeric entries', () => {
  it('handles related array with numeric entries (not strings)', () => {
    const json = JSON.stringify({
      id: 1, title: 'test', type: 'doujinshi', language: 'english',
      date: '2024-01-01', files: [], tags: [],
      related: [100, 200, 0, 300],
    });
    const result = parseGalleryJson(json);
    expect(result.related).toEqual([100, 200, 300]); // 0 filtered out
  });

  it('handles related array with mixed string and number entries', () => {
    const json = JSON.stringify({
      id: 1, title: 'test', type: 'doujinshi', language: 'english',
      date: '2024-01-01', files: [], tags: [],
      related: ['100', 200, '0', 0, 300],
    });
    const result = parseGalleryJson(json);
    expect(result.related).toEqual([100, 200, 300]);
  });
});

describe('categorizeTags — URL regex non-match fallback', () => {
  it('falls back to TAG type when url is an empty string', () => {
    const tags: GalleryTagJson[] = [
      { male: '0', female: '0', url: '', tag: 'tagWithNoUrl' },
    ];
    const result = categorizeTags(tags);
    expect(result[TagType.TAG]).toEqual(['tagWithNoUrl']);
  });

  it('falls back to TAG type when url has no slash separator', () => {
    const tags: GalleryTagJson[] = [
      { male: '0', female: '0', url: 'noslashhere', tag: 'weirdTag' },
    ];
    const result = categorizeTags(tags);
    expect(result[TagType.TAG]).toEqual(['weirdTag']);
  });
});
