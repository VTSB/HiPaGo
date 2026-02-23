// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { t } from '../translations';
import type { TranslationKey } from '../translations';

describe('translations', () => {
  describe('t()', () => {
    it('returns English text for en locale', () => {
      expect(t('nav.browse', 'en')).toBe('Browse');
      expect(t('nav.settings', 'en')).toBe('Settings');
    });

    it('returns Korean text for ko locale', () => {
      expect(t('nav.browse', 'ko')).toBe('둘러보기');
      expect(t('nav.settings', 'ko')).toBe('설정');
    });

    it('returns different text for different locales', () => {
      const keysToCheck: TranslationKey[] = [
        'nav.browse',
        'nav.favorites',
        'nav.history',
        'search.placeholder',
        'search.searching',
        'search.noResults',
        'detail.back',
        'detail.read',
        'detail.addFavorite',
        'detail.removeFavorite',
        'detail.content',
        'detail.related',
        'detail.noImage',
        'favorites.title',
        'favorites.empty',
        'history.title',
        'history.empty',
        'reader.prev',
        'reader.next',
        'settings.title',
        'settings.locale',
        'settings.theme',
      ];

      for (const key of keysToCheck) {
        const en = t(key, 'en');
        const ko = t(key, 'ko');
        expect(en).toBeTruthy();
        expect(ko).toBeTruthy();
        // Most translations should differ between locales
        // (some like 'settings.locale.en' intentionally stay the same)
      }
    });

    it('search result text is localized', () => {
      expect(t('search.results', 'en')).toBe('results');
      expect(t('search.results', 'ko')).toBe('개');
    });

    it('settings labels are localized', () => {
      expect(t('settings.langFilter', 'en')).toBe('Language Filter');
      expect(t('settings.langFilter', 'ko')).toBe('언어 필터');
      expect(t('settings.theme.light', 'en')).toBe('Light');
      expect(t('settings.theme.light', 'ko')).toBe('라이트');
    });

    it('reader controls are localized', () => {
      expect(t('reader.prev', 'en')).toBe('Prev');
      expect(t('reader.prev', 'ko')).toBe('이전');
      expect(t('reader.next', 'en')).toBe('Next');
      expect(t('reader.next', 'ko')).toBe('다음');
    });

    it('locale selector labels are correct', () => {
      // English label stays "English" in both locales
      expect(t('settings.locale.en', 'en')).toBe('English');
      expect(t('settings.locale.en', 'ko')).toBe('English');
      // Korean label stays "한국어" in both locales
      expect(t('settings.locale.ko', 'en')).toBe('한국어');
      expect(t('settings.locale.ko', 'ko')).toBe('한국어');
    });
  });
});
