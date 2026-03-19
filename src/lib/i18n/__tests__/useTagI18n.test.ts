// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettingsStore } from '@/lib/store/settings';
import { TagType } from '@/lib/utils/types';

// ---------------------------------------------------------------------------
// Mock useTagI18nStore before importing the hook.
// The hook uses Zustand selector calls: useTagI18nStore((s) => s.isLoaded)
// and useTagI18nStore((s) => s.nameToLocal), so the mock must be callable.
// ---------------------------------------------------------------------------

const { mockStoreState, mockUseTagI18nStore } = vi.hoisted(() => {
  const state = {
    isLoaded: false,
    nameToLocal: new Map<string, string>(),
  };
  const store = Object.assign(
    (selector?: (s: typeof state) => unknown) => selector ? selector(state) : state,
    { getState: () => state },
  );
  return { mockStoreState: state, mockUseTagI18nStore: store };
});

vi.mock('@/lib/store/tag-i18n', () => ({
  useTagI18nStore: mockUseTagI18nStore,
}));

import { useTagI18n } from '../useTagI18n';

describe('useTagI18n', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' });
    mockStoreState.isLoaded = false;
    mockStoreState.nameToLocal = new Map();
  });

  describe('returns EMPTY_MAP when prerequisites are not met', () => {
    it('returns empty map when locale is en (not ko)', () => {
      useSettingsStore.setState({ locale: 'en' });
      mockStoreState.isLoaded = true;
      mockStoreState.nameToLocal = new Map([['artist:natsuki-naru', '나츠키 나루']]);

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(0);
    });

    it('returns empty map when isLoaded is false', () => {
      useSettingsStore.setState({ locale: 'ko' });
      mockStoreState.isLoaded = false;
      mockStoreState.nameToLocal = new Map([['artist:natsuki-naru', '나츠키 나루']]);

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(0);
    });

    it('returns empty map when tagEntries is empty array', () => {
      useSettingsStore.setState({ locale: 'ko' });
      mockStoreState.isLoaded = true;

      const { result } = renderHook(() => useTagI18n([]));

      expect(result.current.size).toBe(0);
    });
  });

  describe('reads from TagI18nStore.nameToLocal when all conditions met', () => {
    it('returns translations when locale is ko and isLoaded is true', () => {
      mockStoreState.isLoaded = true;
      mockStoreState.nameToLocal = new Map([['artist:natsuki-naru', '나츠키 나루']]);
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(1);
      expect(result.current.get('artist:natsuki-naru')).toBe('나츠키 나루');
    });

    it('flattens multiple tag types and names and builds map from nameToLocal', () => {
      mockStoreState.isLoaded = true;
      mockStoreState.nameToLocal = new Map([
        ['tag:schoolgirl', '여고생'],
        ['female:glasses', '안경'],
      ]);
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [
        [TagType.TAG, ['schoolgirl', 'uniform']],
        [TagType.FEMALE, ['glasses']],
      ];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.get('tag:schoolgirl')).toBe('여고생');
      expect(result.current.get('female:glasses')).toBe('안경');
      expect(result.current.has('tag:uniform')).toBe(false);
    });

    it('omits entries where nameToLocal has no mapping', () => {
      mockStoreState.isLoaded = true;
      mockStoreState.nameToLocal = new Map([['male:yaoi', '야오이']]);
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [
        [TagType.MALE, ['yaoi']],
        [TagType.TAG, ['full-color']],
      ];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(1);
      expect(result.current.get('male:yaoi')).toBe('야오이');
      expect(result.current.has('tag:full-color')).toBe(false);
    });
  });

  describe('isLoaded guard behavior', () => {
    it('returns empty map when isLoaded is false even with ko locale', () => {
      mockStoreState.isLoaded = false;
      mockStoreState.nameToLocal = new Map([['tag:doujinshi', '동인지']]);
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [[TagType.TAG, ['doujinshi']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(0);
    });
  });

  describe('reactivity to store changes', () => {
    it('switches to empty map when locale changes from ko to en', async () => {
      mockStoreState.isLoaded = true;
      mockStoreState.nameToLocal = new Map([['artist:abc', '에이비씨']]);
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['abc']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBeGreaterThan(0);

      act(() => {
        useSettingsStore.setState({ locale: 'en' });
      });

      await waitFor(() => {
        expect(result.current.size).toBe(0);
      });
    });
  });
});
