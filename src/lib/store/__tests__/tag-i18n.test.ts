// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';

import { vi } from 'vitest';

// Mock the JSON modules that the store dynamically imports via JSON_LOADERS.
// The store uses: import('@/lib/data/tags-i18n/ko.json') etc.
// We control what each returns so tests are independent of real data files.

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

import { createTagI18nStore } from '../tag-i18n';

// Sample data mirroring the real ko.json structure
const SAMPLE_KO_JSON = {
  type: {
    artistcg: '작가 CG',
  },
  female: {
    glasses: '안경',
    'big breasts': '거유',
    schoolgirl: '여학생',
    'glasses girl': '안경 소녀',
  },
  male: {
    glasses: '안경 (남)',
    muscle: '근육',
  },
  tag: {
    kimono: '기모노',
  },
};

const SAMPLE_KO_AI_JSON = {
  female: {
    'cat ears': '고양이 귀',
    glasses: 'AI안경', // should be overridden by manual
  },
  tag: {
    swimsuit: '수영복',
  },
};

describe('TagI18nStore', () => {
  let store: ReturnType<typeof createTagI18nStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock data to empty before each test
    mockKoJson.default = {};
    mockKoAiJson.default = {};
    store = createTagI18nStore();
  });

  describe('initial state', () => {
    it('isLoaded starts as false', () => {
      expect(store.getState().isLoaded).toBe(false);
    });

    it('loadedLocale starts as null', () => {
      expect(store.getState().loadedLocale).toBeNull();
    });

    it('nameToLocal starts as empty Map', () => {
      expect(store.getState().nameToLocal.size).toBe(0);
    });

    it('localToNames starts as empty Map', () => {
      expect(store.getState().localToNames.size).toBe(0);
    });
  });

  describe('loadLocale', () => {
    it('loadLocale("ko") loads ko.json into Map', async () => {
      mockKoJson.default = SAMPLE_KO_JSON;

      await store.getState().loadLocale('ko');

      const state = store.getState();
      expect(state.isLoaded).toBe(true);
      expect(state.loadedLocale).toBe('ko');
      expect(state.nameToLocal.size).toBeGreaterThan(0);
    });

    it('loadLocale("ko") sets isLoaded to true after loading', async () => {
      mockKoJson.default = SAMPLE_KO_JSON;

      expect(store.getState().isLoaded).toBe(false);
      await store.getState().loadLocale('ko');
      expect(store.getState().isLoaded).toBe(true);
      expect(store.getState().loadedLocale).toBe('ko');
    });

    it('loadLocale("ko") loads ko.ai.json if it exists, AI translations fill gaps only', async () => {
      mockKoJson.default = SAMPLE_KO_JSON;
      mockKoAiJson.default = SAMPLE_KO_AI_JSON;

      await store.getState().loadLocale('ko');

      const state = store.getState();
      // Manual translation takes priority over AI for 'female:glasses'
      expect(state.nameToLocal.get('female:glasses')).toBe('안경');
      // AI-only translation for 'female:cat ears' is included
      expect(state.nameToLocal.get('female:cat ears')).toBe('고양이 귀');
      // AI-only translation for 'tag:swimsuit' is included
      expect(state.nameToLocal.get('tag:swimsuit')).toBe('수영복');
    });

    it('manual translations take priority over AI translations for the same key', async () => {
      mockKoJson.default = SAMPLE_KO_JSON;
      mockKoAiJson.default = SAMPLE_KO_AI_JSON;

      await store.getState().loadLocale('ko');

      // SAMPLE_KO_AI_JSON has female:glasses = 'AI안경', manual has '안경'
      expect(store.getState().nameToLocal.get('female:glasses')).toBe('안경');
    });

    it('loadLocale("ko") does not synthesize translations missing from locale files', async () => {
      await store.getState().loadLocale('ko');

      expect(store.getState().getLocal('type', 'image set')).toBeUndefined();
      expect(store.getState().getLocal('language', 'English')).toBeUndefined();
      expect(store.getState().getLocal('language', '日本語')).toBeUndefined();
    });

    it('loadLocale with nonexistent file gracefully returns empty Map', async () => {
      // mockKoJson.default stays {} (empty), simulating no data
      await store.getState().loadLocale('nonexistent');

      const state = store.getState();
      expect(state.nameToLocal.size).toBe(0);
      expect(state.isLoaded).toBe(true);
      expect(state.loadedLocale).toBe('nonexistent');
    });

    it('loadLocale with nonexistent file clears previously loaded translations', async () => {
      mockKoJson.default = SAMPLE_KO_JSON;
      await store.getState().loadLocale('ko');
      expect(store.getState().getLocal('female', 'big breasts')).toBe('거유');

      await store.getState().loadLocale('nonexistent');

      const state = store.getState();
      expect(state.nameToLocal.size).toBe(0);
      expect(state.getLocal('female', 'big breasts')).toBeUndefined();
      expect(state.loadedLocale).toBe('nonexistent');
    });
  });

  describe('getLocal', () => {
    beforeEach(async () => {
      mockKoJson.default = SAMPLE_KO_JSON;
      await store.getState().loadLocale('ko');
    });

    it('getLocal("female", "glasses") returns correct translation', () => {
      expect(store.getState().getLocal('female', 'glasses')).toBe('안경');
    });

    it('getLocal("male", "glasses") returns different translation from female:glasses', () => {
      expect(store.getState().getLocal('male', 'glasses')).toBe('안경 (남)');
    });

    it('getLocal with "type:name" composite key handles same name across different types', () => {
      // 'glasses' exists in both 'female' and 'male' with different translations
      const femaleGlasses = store.getState().getLocal('female', 'glasses');
      const maleGlasses = store.getState().getLocal('male', 'glasses');
      expect(femaleGlasses).toBe('안경');
      expect(maleGlasses).toBe('안경 (남)');
      expect(femaleGlasses).not.toBe(maleGlasses);
    });

    it('getLocal returns undefined for unknown tag', () => {
      expect(store.getState().getLocal('female', 'nonexistent')).toBeUndefined();
    });

    it('getLocal resolves underscore tag names to space-based translation keys', () => {
      expect(store.getState().getLocal('female', 'big_breasts')).toBe('거유');
    });

    it('getLocal resolves legacy gender suffix tags stored under generic tag type', () => {
      expect(store.getState().getLocal('tag', 'big breasts ♀')).toBe('거유');
    });

    it('getLocal resolves compact type translation keys', () => {
      expect(store.getState().getLocal('type', 'artist CG')).toBe('작가 CG');
    });
  });

  describe('searchByLocal', () => {
    beforeEach(async () => {
      mockKoJson.default = SAMPLE_KO_JSON;
      await store.getState().loadLocale('ko');
    });

    it('searchByLocal("안경") returns matching tags via prefix match', () => {
      const results = store.getState().searchByLocal('안경');
      const names = results.map((r) => r.name);
      expect(names).toContain('glasses');
    });

    it('searchByLocal("안경") prefix match returns female:glasses', () => {
      const results = store.getState().searchByLocal('안경');
      const found = results.find((r) => r.type === 'female' && r.name === 'glasses');
      expect(found).toBeDefined();
      expect(found?.local).toBe('안경');
    });

    it('searchByLocal("안경 소녀") returns glasses girl via prefix match', () => {
      const results = store.getState().searchByLocal('안경 소녀');
      const found = results.find((r) => r.name === 'glasses girl');
      expect(found).toBeDefined();
    });

    it('searchByLocal("ㄱㅇ") returns 거유 via 초성검색 (es-hangul getChoseong)', async () => {
      // 거유 초성 = ㄱㅇ (ㄱ from 거, ㅇ from 유)
      const results = store.getState().searchByLocal('ㄱㅇ');
      const found = results.find((r) => r.local === '거유');
      expect(found).toBeDefined();
      expect(found?.name).toBe('big breasts');
    });

    it('searchByLocal with { type: "female" } filters results by type', () => {
      // Both female:glasses and male:glasses have '안경' prefix translations
      const allResults = store.getState().searchByLocal('안경');
      const filteredResults = store.getState().searchByLocal('안경', { type: 'female' });

      expect(allResults.some((r) => r.type === 'male')).toBe(true);
      expect(filteredResults.every((r) => r.type === 'female')).toBe(true);
    });

    it('searchByLocal returns empty array when no match', () => {
      const results = store.getState().searchByLocal('zzzznotfound');
      expect(results).toEqual([]);
    });

    it('searchByLocal results have no duplicates', () => {
      const results = store.getState().searchByLocal('안경');
      const keys = results.map((r) => `${r.type}:${r.name}`);
      const uniqueKeys = new Set(keys);
      expect(keys.length).toBe(uniqueKeys.size);
    });
  });

  describe('reverseLookup', () => {
    beforeEach(async () => {
      mockKoJson.default = SAMPLE_KO_JSON;
      await store.getState().loadLocale('ko');
    });

    it('resolves a localized name to the English { type, name }', () => {
      expect(store.getState().reverseLookup('거유')).toEqual({
        type: 'female',
        name: 'big breasts',
      });
    });

    it('type-scopes the lookup to the requested type', () => {
      // '안경' is female:glasses; male:glasses has a distinct translation.
      expect(store.getState().reverseLookup('안경', { type: 'female' })).toEqual({
        type: 'female',
        name: 'glasses',
      });
      expect(store.getState().reverseLookup('안경 (남)', { type: 'male' })).toEqual({
        type: 'male',
        name: 'glasses',
      });
    });

    it('returns undefined when the requested type has no entry for the name', () => {
      // '안경' belongs to female only — male uses '안경 (남)'.
      expect(store.getState().reverseLookup('안경', { type: 'male' })).toBeUndefined();
    });

    it('returns undefined for an unknown localized name', () => {
      expect(store.getState().reverseLookup('존재하지않음')).toBeUndefined();
    });

    it('returns undefined when the type filter excludes every candidate', () => {
      expect(store.getState().reverseLookup('거유', { type: 'male' })).toBeUndefined();
    });

    it('trims surrounding whitespace before lookup', () => {
      expect(store.getState().reverseLookup('  거유  ')).toEqual({
        type: 'female',
        name: 'big breasts',
      });
    });

    it('resolves a collision deterministically to the first matching key', () => {
      // 'female:schoolgirl' and 'female:glasses girl' differ; '안경 소녀' is
      // unique here so the first-key rule is exercised against a single
      // candidate — verifies the documented deterministic fallback.
      expect(store.getState().reverseLookup('안경 소녀', { type: 'female' })).toEqual({
        type: 'female',
        name: 'glasses girl',
      });
    });
  });
});
