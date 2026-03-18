// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettingsStore } from '@/lib/store/settings';
import { TagType } from '@/lib/utils/types';

// ---------------------------------------------------------------------------
// Mock useTagI18nStore before importing the hook
// The hook uses: useTagI18nStore.getState() to get { isLoaded, getLocal }
// ---------------------------------------------------------------------------

const mockState = {
  isLoaded: false,
  getLocal: vi.fn<[string, string], string | undefined>(),
};

vi.mock('@/lib/store/tag-i18n', () => ({
  useTagI18nStore: {
    getState: () => mockState,
  },
}));

import { useTagI18n } from '../useTagI18n';

describe('useTagI18n', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' });
    mockState.isLoaded = false;
    mockState.getLocal.mockReset();
    mockState.getLocal.mockReturnValue(undefined);
  });

  describe('returns EMPTY_MAP when prerequisites are not met', () => {
    it('returns empty map when locale is en (not ko)', () => {
      useSettingsStore.setState({ locale: 'en' });
      mockState.isLoaded = true;
      mockState.getLocal.mockReturnValue('나츠키 나루');

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(0);
      expect(mockState.getLocal).not.toHaveBeenCalled();
    });

    it('returns empty map when isLoaded is false', () => {
      useSettingsStore.setState({ locale: 'ko' });
      mockState.isLoaded = false;
      mockState.getLocal.mockReturnValue('나츠키 나루');

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(0);
      expect(mockState.getLocal).not.toHaveBeenCalled();
    });

    it('returns empty map when tagEntries is empty array', () => {
      useSettingsStore.setState({ locale: 'ko' });
      mockState.isLoaded = true;

      const { result } = renderHook(() => useTagI18n([]));

      expect(result.current.size).toBe(0);
      expect(mockState.getLocal).not.toHaveBeenCalled();
    });
  });

  describe('reads from TagI18nStore.getLocal when all conditions met', () => {
    it('calls getLocal and returns translations when locale is ko and isLoaded is true', () => {
      mockState.isLoaded = true;
      mockState.getLocal.mockImplementation((type, name) => {
        if (type === 'artist' && name === 'natsuki-naru') return '나츠키 나루';
        return undefined;
      });
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(1);
      expect(result.current.get('artist:natsuki-naru')).toBe('나츠키 나루');
      expect(mockState.getLocal).toHaveBeenCalledWith('artist', 'natsuki-naru');
    });

    it('flattens multiple tag types and names and builds map from getLocal results', () => {
      mockState.isLoaded = true;
      mockState.getLocal.mockImplementation((type, name) => {
        if (type === 'tag' && name === 'schoolgirl') return '여고생';
        if (type === 'female' && name === 'glasses') return '안경';
        return undefined;
      });
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

    it('omits entries where getLocal returns undefined', () => {
      mockState.isLoaded = true;
      mockState.getLocal.mockImplementation((type, name) => {
        if (type === 'male' && name === 'yaoi') return '야오이';
        return undefined;
      });
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
      mockState.isLoaded = false;
      mockState.getLocal.mockReturnValue('동인지');
      useSettingsStore.setState({ locale: 'ko' });

      const tagEntries: [TagType, string[]][] = [[TagType.TAG, ['doujinshi']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      expect(result.current.size).toBe(0);
    });
  });

  describe('reactivity to store changes', () => {
    it('switches to empty map when locale changes from ko to en', async () => {
      mockState.isLoaded = true;
      mockState.getLocal.mockReturnValue('에이비씨');
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
