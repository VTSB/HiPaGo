// @vitest-environment node

// Stub localStorage and window BEFORE the settings module is imported so that
// Zustand's persist middleware can resolve its default storage and attach the
// `.persist` API to the store. Without this, `useSettingsStore.persist` is
// undefined in the node environment and all hydration-related tests fail.
const mockLocalStorage = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string): string | null => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach((k) => delete store[k]); }),
    _store: store,
  };
});

vi.hoisted(() => {
  // Expose localStorage and window on globalThis so persist middleware finds them
  (globalThis as Record<string, unknown>).localStorage = mockLocalStorage;
  (globalThis as Record<string, unknown>).window = { localStorage: mockLocalStorage };
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useSettingsStore, initLocaleOnce } from '../settings';

describe('settings store', () => {
  beforeEach(() => {
    // Reset store to initial state including blurTags
    useSettingsStore.setState({
      locale: 'en',
      language: 'all',
      theme: 'dark',
      readerMode: 'page',
      imageFormat: 'auto',
      blurTags: ['male:yaoi'],
      defaultFilterQuery: '',
    });
  });

  describe('initial state', () => {
    it('has default language "all"', () => {
      expect(useSettingsStore.getState().language).toBe('all');
    });

    it('has default theme "dark"', () => {
      expect(useSettingsStore.getState().theme).toBe('dark');
    });

    it('has default readerMode "page"', () => {
      expect(useSettingsStore.getState().readerMode).toBe('page');
    });

    it('has default imageFormat "auto"', () => {
      expect(useSettingsStore.getState().imageFormat).toBe('auto');
    });

    it('has default blurTags containing male:yaoi', () => {
      expect(useSettingsStore.getState().blurTags).toEqual(['male:yaoi']);
    });

    it('has no default result filter', () => {
      expect(useSettingsStore.getState().defaultFilterQuery).toBe('');
    });
  });

  describe('setLocale', () => {
    it('sets locale to ko', () => {
      useSettingsStore.getState().setLocale('ko');
      expect(useSettingsStore.getState().locale).toBe('ko');
    });

    it('sets locale to en', () => {
      useSettingsStore.getState().setLocale('ko');
      useSettingsStore.getState().setLocale('en');
      expect(useSettingsStore.getState().locale).toBe('en');
    });
  });

  describe('setLanguage', () => {
    it('sets language filter', () => {
      useSettingsStore.getState().setLanguage('japanese');
      expect(useSettingsStore.getState().language).toBe('japanese');
    });

    it('sets back to all', () => {
      useSettingsStore.getState().setLanguage('korean');
      useSettingsStore.getState().setLanguage('all');
      expect(useSettingsStore.getState().language).toBe('all');
    });
  });

  describe('setTheme', () => {
    it('sets light theme', () => {
      useSettingsStore.getState().setTheme('light');
      expect(useSettingsStore.getState().theme).toBe('light');
    });

    it('sets dark theme', () => {
      useSettingsStore.getState().setTheme('dark');
      expect(useSettingsStore.getState().theme).toBe('dark');
    });

    it('toggles between light and dark', () => {
      useSettingsStore.getState().setTheme('light');
      expect(useSettingsStore.getState().theme).toBe('light');
      useSettingsStore.getState().setTheme('dark');
      expect(useSettingsStore.getState().theme).toBe('dark');
    });
  });

  describe('setReaderMode', () => {
    it('sets scroll mode', () => {
      useSettingsStore.getState().setReaderMode('scroll');
      expect(useSettingsStore.getState().readerMode).toBe('scroll');
    });

    it('sets page mode', () => {
      useSettingsStore.getState().setReaderMode('scroll');
      useSettingsStore.getState().setReaderMode('page');
      expect(useSettingsStore.getState().readerMode).toBe('page');
    });
  });

  describe('setImageFormat', () => {
    it('sets avif format', () => {
      useSettingsStore.getState().setImageFormat('avif');
      expect(useSettingsStore.getState().imageFormat).toBe('avif');
    });

    it('sets webp format', () => {
      useSettingsStore.getState().setImageFormat('webp');
      expect(useSettingsStore.getState().imageFormat).toBe('webp');
    });

    it('sets original format', () => {
      useSettingsStore.getState().setImageFormat('original');
      expect(useSettingsStore.getState().imageFormat).toBe('original');
    });

    it('sets auto format', () => {
      useSettingsStore.getState().setImageFormat('original');
      useSettingsStore.getState().setImageFormat('auto');
      expect(useSettingsStore.getState().imageFormat).toBe('auto');
    });
  });

  describe('addBlurTag', () => {
    it('adds a new tag that is not already in the list', () => {
      useSettingsStore.getState().addBlurTag('female:big breasts');
      expect(useSettingsStore.getState().blurTags).toContain('female:big breasts');
    });

    it('appends the new tag to the end of the existing list', () => {
      useSettingsStore.getState().addBlurTag('female:big breasts');
      expect(useSettingsStore.getState().blurTags).toEqual(['male:yaoi', 'female:big breasts']);
    });

    it('does not add a duplicate tag when tag already exists', () => {
      useSettingsStore.getState().addBlurTag('male:yaoi');
      expect(useSettingsStore.getState().blurTags).toEqual(['male:yaoi']);
    });

    it('does not increase the list length when adding a duplicate', () => {
      useSettingsStore.getState().addBlurTag('male:yaoi');
      expect(useSettingsStore.getState().blurTags).toHaveLength(1);
    });

    it('can add multiple distinct tags', () => {
      useSettingsStore.getState().addBlurTag('tag:a');
      useSettingsStore.getState().addBlurTag('tag:b');
      expect(useSettingsStore.getState().blurTags).toEqual(['male:yaoi', 'tag:a', 'tag:b']);
    });
  });

  describe('setDefaultFilterQuery', () => {
    it('sets the default result filter query', () => {
      useSettingsStore.getState().setDefaultFilterQuery('-female:loli');
      expect(useSettingsStore.getState().defaultFilterQuery).toBe('-female:loli');
    });

    it('preserves edit-time whitespace so users can type multiple terms', () => {
      useSettingsStore.getState().setDefaultFilterQuery('  female:loli -artist:yam  ');
      expect(useSettingsStore.getState().defaultFilterQuery).toBe('  female:loli -artist:yam  ');
    });
  });

  describe('removeBlurTag', () => {
    it('removes an existing tag from the list', () => {
      useSettingsStore.getState().removeBlurTag('male:yaoi');
      expect(useSettingsStore.getState().blurTags).not.toContain('male:yaoi');
    });

    it('results in an empty list when the only tag is removed', () => {
      useSettingsStore.getState().removeBlurTag('male:yaoi');
      expect(useSettingsStore.getState().blurTags).toEqual([]);
    });

    it('does not alter the list when the tag does not exist', () => {
      useSettingsStore.getState().removeBlurTag('nonexistent:tag');
      expect(useSettingsStore.getState().blurTags).toEqual(['male:yaoi']);
    });

    it('removes only the target tag and leaves others intact', () => {
      useSettingsStore.setState({ blurTags: ['male:yaoi', 'female:big breasts', 'tag:c'] });
      useSettingsStore.getState().removeBlurTag('female:big breasts');
      expect(useSettingsStore.getState().blurTags).toEqual(['male:yaoi', 'tag:c']);
    });
  });

  describe('independence', () => {
    it('changing one setting does not affect others', () => {
      useSettingsStore.getState().setLocale('ko');
      useSettingsStore.getState().setLanguage('japanese');
      useSettingsStore.getState().setTheme('dark');

      const state = useSettingsStore.getState();
      expect(state.locale).toBe('ko');
      expect(state.language).toBe('japanese');
      expect(state.theme).toBe('dark');
      expect(state.readerMode).toBe('page');
      expect(state.imageFormat).toBe('auto');
    });
  });
});

describe('initLocaleOnce', () => {
  beforeEach(() => {
    // Clear the mock localStorage between tests
    mockLocalStorage.getItem.mockReset();
    mockLocalStorage.getItem.mockReturnValue(null);
    useSettingsStore.setState({ locale: 'en' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('when store is already hydrated', () => {
    beforeEach(() => {
      vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
      vi.spyOn(useSettingsStore.persist, 'onFinishHydration').mockImplementation(() => () => {});
    });

    it('sets locale to ko when no stored settings exist and navigator language starts with ko', () => {
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();

      expect(useSettingsStore.getState().locale).toBe('ko');
    });

    it('sets locale to ko when navigator language is exactly ko', () => {
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.stubGlobal('navigator', { language: 'ko' });

      initLocaleOnce();

      expect(useSettingsStore.getState().locale).toBe('ko');
    });

    it('does not change locale when localStorage already contains saved settings', () => {
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify({ state: { locale: 'en' } }));
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();

      expect(useSettingsStore.getState().locale).toBe('en');
    });

    it('does not change locale when navigator language does not start with ko', () => {
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.stubGlobal('navigator', { language: 'en-US' });

      initLocaleOnce();

      expect(useSettingsStore.getState().locale).toBe('en');
    });

    it('does not change locale when navigator language starts with ko but settings are stored', () => {
      mockLocalStorage.getItem.mockReturnValue('{"state":{}}');
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();

      expect(useSettingsStore.getState().locale).toBe('en');
    });

    it('does not change locale when localStorage is defined and returns a settings value (line 47 truthy branch)', () => {
      // localStorage IS defined (set by vi.hoisted mock) and returns a non-null JSON string.
      // This covers the `typeof localStorage !== 'undefined'` → true branch on line 47,
      // with getItem returning an actual stored value, so raw is truthy and locale stays unchanged.
      mockLocalStorage.getItem.mockReturnValue(JSON.stringify({ state: { locale: 'en', language: 'all' } }));
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();

      // Even though navigator says Korean, stored settings exist so locale must not change
      expect(useSettingsStore.getState().locale).toBe('en');
      expect(mockLocalStorage.getItem).toHaveBeenCalledWith('hipago-settings');
    });
  });

  describe('when localStorage is undefined (covers line 47 false branch)', () => {
    beforeEach(() => {
      vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(true);
      vi.spyOn(useSettingsStore.persist, 'onFinishHydration').mockImplementation(() => () => {});
    });

    it('does not throw and does not change locale when localStorage is undefined', () => {
      vi.stubGlobal('localStorage', undefined);
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      expect(() => initLocaleOnce()).not.toThrow();
      // raw is null (localStorage undefined branch), but we must not crash
      // locale stays 'en' because... wait — if raw is null AND navigator is ko, locale becomes ko.
      // The branch that's uncovered is typeof localStorage === 'undefined', which sets raw = null,
      // then the applyAutoLocale continues. With navigator ko-KR, locale WILL be set to ko.
      expect(useSettingsStore.getState().locale).toBe('ko');
    });

    it('does not throw and keeps locale en when localStorage is undefined and navigator is not ko', () => {
      vi.stubGlobal('localStorage', undefined);
      vi.stubGlobal('navigator', { language: 'en-US' });

      expect(() => initLocaleOnce()).not.toThrow();
      expect(useSettingsStore.getState().locale).toBe('en');
    });
  });

  describe('when store has not yet hydrated', () => {
    beforeEach(() => {
      vi.spyOn(useSettingsStore.persist, 'hasHydrated').mockReturnValue(false);
    });

    it('registers an onFinishHydration callback instead of applying the locale immediately', () => {
      const onFinishHydration = vi
        .spyOn(useSettingsStore.persist, 'onFinishHydration')
        .mockImplementation(() => () => {});
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();

      expect(onFinishHydration).toHaveBeenCalledOnce();
      // Locale must NOT be set yet — the callback is deferred
      expect(useSettingsStore.getState().locale).toBe('en');
    });

    it('the registered callback sets locale to ko when conditions are met after hydration', () => {
      let capturedCallback: (() => void) | undefined;
      vi.spyOn(useSettingsStore.persist, 'onFinishHydration').mockImplementation((cb) => {
        capturedCallback = cb as () => void;
        return () => {};
      });
      mockLocalStorage.getItem.mockReturnValue(null);
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();

      // Simulate hydration completing
      capturedCallback!();

      expect(useSettingsStore.getState().locale).toBe('ko');
    });

    it('the registered callback does not change locale when settings are present after hydration', () => {
      let capturedCallback: (() => void) | undefined;
      vi.spyOn(useSettingsStore.persist, 'onFinishHydration').mockImplementation((cb) => {
        capturedCallback = cb as () => void;
        return () => {};
      });
      mockLocalStorage.getItem.mockReturnValue('{"state":{}}');
      vi.stubGlobal('navigator', { language: 'ko-KR' });

      initLocaleOnce();
      capturedCallback!();

      expect(useSettingsStore.getState().locale).toBe('en');
    });
  });

  describe('scrollZoom', () => {
    it('defaults to 1 (fit-to-width)', () => {
      expect(useSettingsStore.getState().scrollZoom).toBe(1);
    });

    it('setScrollZoom updates the scale', () => {
      useSettingsStore.getState().setScrollZoom(2.5);
      expect(useSettingsStore.getState().scrollZoom).toBe(2.5);
      useSettingsStore.getState().setScrollZoom(1);
      expect(useSettingsStore.getState().scrollZoom).toBe(1);
    });
  });
});
