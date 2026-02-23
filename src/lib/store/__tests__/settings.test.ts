// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../settings';

describe('settings store', () => {
  beforeEach(() => {
    // Reset store to initial state
    useSettingsStore.setState({
      locale: 'en',
      language: 'all',
      theme: 'system',
      readerMode: 'page',
      imageFormat: 'auto',
    });
  });

  describe('initial state', () => {
    it('has default language "all"', () => {
      expect(useSettingsStore.getState().language).toBe('all');
    });

    it('has default theme "system"', () => {
      expect(useSettingsStore.getState().theme).toBe('system');
    });

    it('has default readerMode "page"', () => {
      expect(useSettingsStore.getState().readerMode).toBe('page');
    });

    it('has default imageFormat "auto"', () => {
      expect(useSettingsStore.getState().imageFormat).toBe('auto');
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

    it('sets system theme', () => {
      useSettingsStore.getState().setTheme('dark');
      useSettingsStore.getState().setTheme('system');
      expect(useSettingsStore.getState().theme).toBe('system');
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

  describe('independence', () => {
    it('changing one setting does not affect others', () => {
      useSettingsStore.getState().setLocale('ko');
      useSettingsStore.getState().setLanguage('japanese');
      useSettingsStore.getState().setTheme('dark');

      const state = useSettingsStore.getState();
      expect(state.locale).toBe('ko');
      expect(state.language).toBe('japanese');
      expect(state.theme).toBe('dark');
      expect(state.readerMode).toBe('page'); // unchanged
      expect(state.imageFormat).toBe('auto'); // unchanged
    });
  });
});
