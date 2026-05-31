// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// Stage-3 file-backed cache serving at the shared AbortableImage chokepoint:
//  - HIT  → serve a disk file URL (convertFileSrc); no image bytes in the JS heap.
//  - bypass platforms (iOS/Tauri) → always serve from the cache (download on miss).
//  - Android MISS → display the plain <img src> unchanged; warm the cache after load.
vi.mock('@/lib/utils/platform', () => ({
  isTauri: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
}));

const fileUrl = vi.fn();
const ensureCached = vi.fn();
const getMaxBytes = vi.fn(() => 250 * 1024 * 1024);
vi.mock('@/lib/cache/image-cache', () => ({
  getImageCache: vi.fn(async () => ({ fileUrl, ensureCached, getMaxBytes })),
}));

const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
function MockIntersectionObserver(this: IntersectionObserver) {
  (this as unknown as { observe: typeof mockObserve }).observe = mockObserve;
  (this as unknown as { disconnect: typeof mockDisconnect }).disconnect = mockDisconnect;
}

import { AbortableImage, __resetAbortableImageCacheForTests } from '../AbortableImage';
import * as platform from '@/lib/utils/platform';

const CDN = 'https://aa.gold-usergeneratedcontent.net/img/0001.webp';

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  __resetAbortableImageCacheForTests();
  fileUrl.mockReset();
  ensureCached.mockReset();
  getMaxBytes.mockReturnValue(250 * 1024 * 1024);
  (platform.isAndroid as Mock).mockReturnValue(false);
  (platform.isCapacitor as Mock).mockReturnValue(false);
  (platform.isTauri as Mock).mockReturnValue(false);
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AbortableImage file-backed cache serving (AC-04)', () => {
  it('serves a cache HIT as a disk file URL on Android (no bytes in JS)', async () => {
    (platform.isAndroid as Mock).mockReturnValue(true);
    (platform.isCapacitor as Mock).mockReturnValue(true);
    fileUrl.mockResolvedValue('capacitor://localhost/_capacitor_file_/cache/x');

    const { container } = render(<AbortableImage src={CDN} alt="t" loading="eager" />);
    const img = container.querySelector('img') as HTMLImageElement;
    await waitFor(() =>
      expect(img.getAttribute('src')).toBe('capacitor://localhost/_capacitor_file_/cache/x'),
    );
    expect(fileUrl).toHaveBeenCalledWith(CDN);
    expect(ensureCached).not.toHaveBeenCalled(); // hit → no download
  });

  it('on Android keeps the plain <img src> on a miss and warms the cache once after load', async () => {
    (platform.isAndroid as Mock).mockReturnValue(true);
    (platform.isCapacitor as Mock).mockReturnValue(true);
    fileUrl.mockResolvedValue(null); // miss
    ensureCached.mockResolvedValue('capacitor://localhost/_capacitor_file_/cache/x');

    const { container } = render(<AbortableImage src={CDN} alt="t" loading="eager" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(CDN); // interceptor invariant

    await waitFor(() => expect(fileUrl).toHaveBeenCalledWith(CDN));
    await flush();

    await act(async () => { fireEvent.load(img); });
    await waitFor(() => expect(ensureCached).toHaveBeenCalledTimes(1));

    await act(async () => { fireEvent.load(img); });
    expect(ensureCached).toHaveBeenCalledTimes(1); // deduped
    expect(img.getAttribute('src')).toBe(CDN); // never swapped to an objectURL
  });

  it('does NOT warm on Android when caching is off (max = 0)', async () => {
    (platform.isAndroid as Mock).mockReturnValue(true);
    (platform.isCapacitor as Mock).mockReturnValue(true);
    fileUrl.mockResolvedValue(null);
    getMaxBytes.mockReturnValue(0);

    const { container } = render(<AbortableImage src={CDN} alt="t" loading="eager" />);
    const img = container.querySelector('img') as HTMLImageElement;
    await waitFor(() => expect(fileUrl).toHaveBeenCalledWith(CDN));
    await flush();
    await act(async () => { fireEvent.load(img); });
    await flush();
    expect(ensureCached).not.toHaveBeenCalled();
  });

  it('on iOS (bypass platform) serves the cache file URL, downloading on a miss', async () => {
    (platform.isCapacitor as Mock).mockReturnValue(true);
    (platform.isAndroid as Mock).mockReturnValue(false);
    ensureCached.mockResolvedValue('capacitor://localhost/_capacitor_file_/cache/x');

    const { container } = render(<AbortableImage src={CDN} alt="t" loading="eager" />);
    const img = container.querySelector('img') as HTMLImageElement;
    await waitFor(() =>
      expect(img.getAttribute('src')).toBe('capacitor://localhost/_capacitor_file_/cache/x'),
    );
    expect(ensureCached).toHaveBeenCalledWith(CDN, CDN, expect.any(Object));
  });
});
