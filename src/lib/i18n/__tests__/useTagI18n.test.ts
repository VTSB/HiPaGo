// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettingsStore } from '@/lib/store/settings';
import { useDbStatusStore } from '@/lib/store/db-status';
import { TagType } from '@/lib/utils/types';

// Mock batchGetTagI18n before importing the hook
vi.mock('@/lib/db/tag', () => ({
  batchGetTagI18n: vi.fn(),
}));

import { batchGetTagI18n } from '@/lib/db/tag';
import { useTagI18n } from '../useTagI18n';

const mockBatchGetTagI18n = vi.mocked(batchGetTagI18n);

const EMPTY_MAP = new Map<string, string>();

describe('useTagI18n', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' });
    useDbStatusStore.setState({ dbReady: false });
    mockBatchGetTagI18n.mockReset();
  });

  describe('returns EMPTY_MAP when prerequisites are not met', () => {
    it('returns empty map when locale is en (not ko)', async () => {
      useSettingsStore.setState({ locale: 'en' });
      useDbStatusStore.setState({ dbReady: true });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        expect(result.current.size).toBe(0);
      });
      expect(mockBatchGetTagI18n).not.toHaveBeenCalled();
    });

    it('returns empty map when dbReady is false', async () => {
      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: false });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        expect(result.current.size).toBe(0);
      });
      expect(mockBatchGetTagI18n).not.toHaveBeenCalled();
    });

    it('returns empty map when tagEntries is empty array', async () => {
      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: true });

      const { result } = renderHook(() => useTagI18n([]));

      await waitFor(() => {
        expect(result.current.size).toBe(0);
      });
      expect(mockBatchGetTagI18n).not.toHaveBeenCalled();
    });
  });

  describe('calls batchGetTagI18n and returns results when all conditions met', () => {
    it('calls batchGetTagI18n with flattened tag list when locale is ko and dbReady is true', async () => {
      const resultMap = new Map([['artist:natsuki-naru', '나츠키 나루']]);
      mockBatchGetTagI18n.mockResolvedValue(resultMap);

      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: true });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['natsuki-naru']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        expect(result.current.size).toBeGreaterThan(0);
      });

      expect(mockBatchGetTagI18n).toHaveBeenCalledWith([
        { type: TagType.ARTIST, name: 'natsuki-naru' },
      ]);
      expect(result.current.get('artist:natsuki-naru')).toBe('나츠키 나루');
    });

    it('flattens multiple tag types and names into a single array for batchGetTagI18n', async () => {
      const resultMap = new Map([
        ['tag:schoolgirl', '여고생'],
        ['female:glasses', '안경'],
      ]);
      mockBatchGetTagI18n.mockResolvedValue(resultMap);

      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: true });

      const tagEntries: [TagType, string[]][] = [
        [TagType.TAG, ['schoolgirl', 'uniform']],
        [TagType.FEMALE, ['glasses']],
      ];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        expect(result.current.size).toBeGreaterThan(0);
      });

      expect(mockBatchGetTagI18n).toHaveBeenCalledWith([
        { type: TagType.TAG, name: 'schoolgirl' },
        { type: TagType.TAG, name: 'uniform' },
        { type: TagType.FEMALE, name: 'glasses' },
      ]);
    });

    it('returns the map resolved by batchGetTagI18n', async () => {
      const resultMap = new Map([
        ['male:yaoi', '야오이'],
        ['tag:full-color', '풀컬러'],
      ]);
      mockBatchGetTagI18n.mockResolvedValue(resultMap);

      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: true });

      const tagEntries: [TagType, string[]][] = [
        [TagType.MALE, ['yaoi']],
        [TagType.TAG, ['full-color']],
      ];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        expect(result.current.size).toBe(2);
      });

      expect(result.current.get('male:yaoi')).toBe('야오이');
      expect(result.current.get('tag:full-color')).toBe('풀컬러');
    });
  });

  describe('returns EMPTY_MAP on batchGetTagI18n error', () => {
    it('returns empty map when batchGetTagI18n rejects', async () => {
      mockBatchGetTagI18n.mockRejectedValue(new Error('DB error'));

      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: true });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['some-artist']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        // After rejection, hook should settle — batchGetTagI18n was called
        expect(mockBatchGetTagI18n).toHaveBeenCalled();
      });

      // Map should be empty after error
      expect(result.current.size).toBe(0);
    });
  });

  describe('reactivity to store changes', () => {
    it('switches to empty map when locale changes from ko to en', async () => {
      const resultMap = new Map([['artist:abc', '에이비씨']]);
      mockBatchGetTagI18n.mockResolvedValue(resultMap);

      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: true });

      const tagEntries: [TagType, string[]][] = [[TagType.ARTIST, ['abc']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      await waitFor(() => {
        expect(result.current.size).toBeGreaterThan(0);
      });

      act(() => {
        useSettingsStore.setState({ locale: 'en' });
      });

      await waitFor(() => {
        expect(result.current.size).toBe(0);
      });
    });

    it('fetches translations when dbReady transitions from false to true with ko locale', async () => {
      const resultMap = new Map([['tag:doujinshi', '동인지']]);
      mockBatchGetTagI18n.mockResolvedValue(resultMap);

      useSettingsStore.setState({ locale: 'ko' });
      useDbStatusStore.setState({ dbReady: false });

      const tagEntries: [TagType, string[]][] = [[TagType.TAG, ['doujinshi']]];
      const { result } = renderHook(() => useTagI18n(tagEntries));

      // Initially empty because dbReady is false
      expect(result.current.size).toBe(0);
      expect(mockBatchGetTagI18n).not.toHaveBeenCalled();

      act(() => {
        useDbStatusStore.setState({ dbReady: true });
      });

      await waitFor(() => {
        expect(result.current.size).toBeGreaterThan(0);
      });

      expect(mockBatchGetTagI18n).toHaveBeenCalledWith([
        { type: TagType.TAG, name: 'doujinshi' },
      ]);
      expect(result.current.get('tag:doujinshi')).toBe('동인지');
    });
  });
});
