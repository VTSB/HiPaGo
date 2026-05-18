// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the JSON modules the i18n store dynamically imports so the reverse
// lookup is driven by deterministic fixture data.
const mockKoJson = vi.hoisted(() => ({ default: {} as Record<string, Record<string, string>> }));
const mockKoAiJson = vi.hoisted(() => ({ default: {} as Record<string, Record<string, string>> }));

vi.mock('@/lib/data/tags-i18n/ko.json', () => mockKoJson);
vi.mock('@/lib/data/tags-i18n/ko.ai.json', () => mockKoAiJson);
vi.mock('@/lib/data/tags-i18n/ja.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/ja.ai.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hans.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hans.ai.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hant.json', () => ({ default: {} }));
vi.mock('@/lib/data/tags-i18n/zh-Hant.ai.json', () => ({ default: {} }));

import { useTagI18nStore } from '@/lib/store/tag-i18n';
import { TagType } from '../types';
import {
  KOREAN_TYPE_LABEL,
  KOREAN_LABEL_TO_TYPE,
  isHangul,
  buildKoreanToken,
  normalizeQueryToEnglish,
} from '../tag-query';

const SAMPLE_KO_JSON = {
  female: {
    loli: '로리',
    'big breasts': '큰 가슴',
    glasses: '안경',
  },
  male: {
    glasses: '안경',
    muscle: '근육',
  },
  artist: {
    yam: '얌',
  },
  series: {
    naruto: '나루토',
  },
};

const SEARCHABLE: TagType[] = [
  TagType.GROUP,
  TagType.ARTIST,
  TagType.SERIES,
  TagType.CHARACTER,
  TagType.TAG,
  TagType.MALE,
  TagType.FEMALE,
];

describe('tag-query — AC-001 helpers', () => {
  describe('KOREAN_TYPE_LABEL / KOREAN_LABEL_TO_TYPE', () => {
    it('maps all 7 searchable types and round-trips', () => {
      for (const type of SEARCHABLE) {
        const label = KOREAN_TYPE_LABEL[type];
        expect(label).toBeTruthy();
        expect(KOREAN_LABEL_TO_TYPE[label]).toBe(type);
      }
    });

    it('uses the agreed Korean labels', () => {
      expect(KOREAN_TYPE_LABEL[TagType.FEMALE]).toBe('여자');
      expect(KOREAN_TYPE_LABEL[TagType.MALE]).toBe('남자');
      expect(KOREAN_TYPE_LABEL[TagType.ARTIST]).toBe('작가');
      expect(KOREAN_TYPE_LABEL[TagType.GROUP]).toBe('그룹');
      expect(KOREAN_TYPE_LABEL[TagType.SERIES]).toBe('시리즈');
      expect(KOREAN_TYPE_LABEL[TagType.CHARACTER]).toBe('캐릭터');
      expect(KOREAN_TYPE_LABEL[TagType.TAG]).toBe('태그');
    });

    it('does not assign labels to query-operator types', () => {
      expect(KOREAN_TYPE_LABEL[TagType.BEFORE]).toBe('');
      expect(KOREAN_TYPE_LABEL[TagType.LANGUAGE]).toBe('');
    });
  });

  describe('isHangul', () => {
    it('detects Hangul syllables', () => {
      expect(isHangul('로리')).toBe(true);
      expect(isHangul('큰 가슴')).toBe(true);
    });
    it('detects standalone jamo (초성)', () => {
      expect(isHangul('ㄱㅇ')).toBe(true);
    });
    it('returns false for pure English / digits', () => {
      expect(isHangul('loli')).toBe(false);
      expect(isHangul('big_breasts')).toBe(false);
      expect(isHangul('12345')).toBe(false);
    });
    it('returns true for a mixed string containing Hangul', () => {
      expect(isHangul('female:로리')).toBe(true);
    });
  });

  describe('buildKoreanToken', () => {
    it('builds a single-word Korean token', () => {
      expect(buildKoreanToken(TagType.FEMALE, '로리')).toBe('여자:로리');
    });
    it('underscores spaces in a multi-word Korean name', () => {
      expect(buildKoreanToken(TagType.FEMALE, '큰 가슴')).toBe('여자:큰_가슴');
    });
    it('trims surrounding whitespace', () => {
      expect(buildKoreanToken(TagType.ARTIST, '  얌  ')).toBe('작가:얌');
    });
  });
});

describe('tag-query — AC-002 normalizeQueryToEnglish', () => {
  beforeEach(async () => {
    mockKoJson.default = SAMPLE_KO_JSON;
    mockKoAiJson.default = {};
    await useTagI18nStore.getState().loadLocale('ko');
  });

  it('converts a Korean type-qualified token to canonical English', () => {
    expect(normalizeQueryToEnglish('여자:로리')).toBe('female:loli');
  });

  it('underscores a multi-word Korean tag in the English result', () => {
    expect(normalizeQueryToEnglish('여자:큰_가슴')).toBe('female:big_breasts');
  });

  it('passes English tokens through byte-identical', () => {
    expect(normalizeQueryToEnglish('female:loli')).toBe('female:loli');
    expect(normalizeQueryToEnglish('artist:yam')).toBe('artist:yam');
  });

  it('normalizes a compound mixed Korean + English query per term', () => {
    expect(normalizeQueryToEnglish('여자:로리 artist:yam')).toBe('female:loli artist:yam');
    expect(normalizeQueryToEnglish('female:loli 작가:얌')).toBe('female:loli artist:yam');
  });

  it('type-scopes the reverse lookup so same Korean name resolves per type', () => {
    // '안경' is both female:glasses and male:glasses.
    expect(normalizeQueryToEnglish('여자:안경')).toBe('female:glasses');
    expect(normalizeQueryToEnglish('남자:안경')).toBe('male:glasses');
  });

  it('leaves a Korean term with no translation unchanged', () => {
    expect(normalizeQueryToEnglish('여자:존재하지않음')).toBe('여자:존재하지않음');
  });

  it('treats an unknown type prefix as a plain term, unchanged', () => {
    expect(normalizeQueryToEnglish('unknowntype:foo')).toBe('unknowntype:foo');
  });

  it('preserves a leading negative marker', () => {
    expect(normalizeQueryToEnglish('-여자:로리')).toBe('-female:loli');
  });

  it('returns empty string input unchanged', () => {
    expect(normalizeQueryToEnglish('')).toBe('');
  });
});
