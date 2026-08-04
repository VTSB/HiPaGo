// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getGgConfig = vi.fn();
vi.mock('@/lib/api/client', () => ({ getGgConfig: () => getGgConfig() }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (selector: (state: { imageFormat: 'webp' }) => unknown) =>
    selector({ imageFormat: 'webp' }),
}));
vi.mock('@/lib/utils/image-url', () => ({
  galleryImageToFile: (image: { name: string }) => image,
  getBestImageUrl: (image: { name: string }) => `https://cdn.example/${image.name}`,
}));

import { useReaderImageSources } from '../useReaderImageSources';
import { ImageType, type GalleryImage } from '@/lib/utils/types';

const images: GalleryImage[] = [
  { name: '001.webp', hash: 'a', width: 800, height: 1200, types: new Set([ImageType.WEBP]) },
];

beforeEach(() => getGgConfig.mockReset());

describe('useReaderImageSources', () => {
  it('surfaces a gg config failure and succeeds after manual retry', async () => {
    getGgConfig.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ b: 0, m: 0 });
    const { result } = renderHook(() => useReaderImageSources({ images }));

    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.urls).toEqual(['https://cdn.example/001.webp']));
    expect(getGgConfig).toHaveBeenCalledTimes(2);
  });

  it('automatically retries when connectivity returns', async () => {
    getGgConfig.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ b: 0, m: 0 });
    const { result } = renderHook(() => useReaderImageSources({ images }));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(result.current.urls).toHaveLength(1));
    expect(getGgConfig).toHaveBeenCalledTimes(2);
  });

  it('uses offline sources without requesting gg config', () => {
    const { result } = renderHook(() =>
      useReaderImageSources({
        images,
        offlineSources: [{ index: 0, ext: 'webp', url: 'blob:offline' }],
      }),
    );
    expect(result.current.urls).toEqual(['blob:offline']);
    expect(result.current.loading).toBe(false);
    expect(getGgConfig).not.toHaveBeenCalled();
  });
});
