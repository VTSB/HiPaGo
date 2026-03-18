// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';

// We import the store module fresh for each test suite by re-importing.
// The store uses file-system reads which are mocked via vitest's module mock.
import { vi } from 'vitest';

// Mock the fs/promises module so we can control what JSON files are returned
// without needing real files on disk (except ko.json which does exist).
const mockFsReadFile = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: mockFsReadFile,
}));

import { createTagI18nStore } from '../tag-i18n';

// Sample data mirroring the real ko.json structure
const SAMPLE_KO_JSON = {
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
    store = createTagI18nStore();
  });

  describe('initial state', () => {
    it('isLoaded starts as false', () => {
      expect(store.getState().isLoaded).toBe(false);
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
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (path.includes('ko.json') && !path.includes('ko.ai.json')) {
          return JSON.stringify(SAMPLE_KO_JSON);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await store.getState().loadLocale('ko');

      const state = store.getState();
      expect(state.isLoaded).toBe(true);
      expect(state.nameToLocal.size).toBeGreaterThan(0);
    });

    it('loadLocale("ko") sets isLoaded to true after loading', async () => {
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (path.includes('ko.json') && !path.includes('ko.ai.json')) {
          return JSON.stringify(SAMPLE_KO_JSON);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      expect(store.getState().isLoaded).toBe(false);
      await store.getState().loadLocale('ko');
      expect(store.getState().isLoaded).toBe(true);
    });

    it('loadLocale("ko") loads ko.ai.json if it exists, AI translations fill gaps only', async () => {
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (path.includes('ko.ai.json')) {
          return JSON.stringify(SAMPLE_KO_AI_JSON);
        }
        if (path.includes('ko.json')) {
          return JSON.stringify(SAMPLE_KO_JSON);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

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
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (path.includes('ko.ai.json')) {
          return JSON.stringify(SAMPLE_KO_AI_JSON);
        }
        if (path.includes('ko.json')) {
          return JSON.stringify(SAMPLE_KO_JSON);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await store.getState().loadLocale('ko');

      // SAMPLE_KO_AI_JSON has female:glasses = 'AI안경', manual has '안경'
      expect(store.getState().nameToLocal.get('female:glasses')).toBe('안경');
    });

    it('loadLocale with nonexistent file gracefully returns empty Map', async () => {
      mockFsReadFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await store.getState().loadLocale('nonexistent');

      const state = store.getState();
      expect(state.nameToLocal.size).toBe(0);
      expect(state.isLoaded).toBe(true);
    });
  });

  describe('getLocal', () => {
    beforeEach(async () => {
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (path.includes('ko.json') && !path.includes('ko.ai.json')) {
          return JSON.stringify(SAMPLE_KO_JSON);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
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
  });

  describe('searchByLocal', () => {
    beforeEach(async () => {
      mockFsReadFile.mockImplementation(async (path: string) => {
        if (path.includes('ko.json') && !path.includes('ko.ai.json')) {
          return JSON.stringify(SAMPLE_KO_JSON);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
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
});
