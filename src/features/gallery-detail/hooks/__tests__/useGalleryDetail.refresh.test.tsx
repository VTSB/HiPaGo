// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGalleryDetail } from '../useGalleryDetail';
import { GalleryBlockType, type GalleryBlock, type GalleryFile, type GalleryInfo } from '@/lib/utils/types';

vi.mock('@/lib/db/gallery', () => ({
  getGalleryBlock: vi.fn(),
  getGalleryImages: vi.fn(),
  saveGalleryBlock: vi.fn(async () => {}),
  saveGalleryImages: vi.fn(async () => {}),
}));
vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async () => ({ status: 'complete', title: 'Local title', downloadedAt: '2026-01-01', tags: '{}', pageCount: 1, folderName: '42 exact' })),
  deserializeTags: JSON.parse,
}));
vi.mock('@/lib/utils/download-zip', () => ({
  getDownloadedGalleryPages: vi.fn(async () => [{ index: 0, ext: 'webp' }]),
}));
vi.mock('@/lib/api/gallery', () => ({
  fetchGalleryInfo: vi.fn(),
  filesToGalleryImages: (id: number, files: GalleryFile[]) => ({ id, images: files }),
}));
vi.mock('@/lib/api/parser', () => ({
  galleryInfoToBlock: (info: GalleryInfo) => ({ id: info.id, title: info.title, type: 1 }),
  galleryInfoToImages: (info: GalleryInfo) => ({ id: info.id, images: info.files }),
}));

import { fetchGalleryInfo } from '@/lib/api/gallery';
import { getGalleryBlock, getGalleryImages, saveGalleryImages } from '@/lib/db/gallery';

const realFiles: GalleryFile[] = [{ width: 800, height: 1200, name: 'one.webp', hash: 'real-hash', haswebp: 1, hasavif: 0, hasavifsmalltn: 0 }];
const remoteInfo = { id: 42, title: 'Online title', files: realFiles } as GalleryInfo;

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGalleryBlock).mockResolvedValue(null);
  vi.mocked(getGalleryImages).mockResolvedValue(null);
});
afterEach(cleanup);

describe('downloaded detail metadata refresh', () => {
  it('shows local detail while metadata is pending, then enriches it without repeated requests on rerender', async () => {
    let finish!: (info: GalleryInfo) => void;
    vi.mocked(fetchGalleryInfo).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(() => useGalleryDetail(42, { refreshDownloadedMetadata: true }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.block?.title).toBe('Local title'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.files[0].hash).toBe('');
    await waitFor(() => expect(fetchGalleryInfo).toHaveBeenCalledTimes(1));
    rerender();
    expect(fetchGalleryInfo).toHaveBeenCalledTimes(1);

    await act(async () => finish(remoteInfo));
    await waitFor(() => expect(result.current.block?.title).toBe('Online title'));
    expect(result.current.files).toEqual(realFiles);
    expect(saveGalleryImages).toHaveBeenCalledWith(42, realFiles);
    rerender();
    expect(fetchGalleryInfo).toHaveBeenCalledTimes(1);
  });

  it('retains usable local detail after a background metadata error', async () => {
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    const { result, rerender } = renderHook(() => useGalleryDetail(42, { refreshDownloadedMetadata: true }), { wrapper: wrapper() });
    await waitFor(() => expect(fetchGalleryInfo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.block?.title).toBe('Local title'));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    rerender();
    expect(fetchGalleryInfo).toHaveBeenCalledTimes(1);
  });

  it('leaves reader metadata stable and does not replace a rich cached detail', async () => {
    const reader = renderHook(() => useGalleryDetail(42), { wrapper: wrapper() });
    await waitFor(() => expect(reader.result.current.block?.title).toBe('Local title'));
    expect(fetchGalleryInfo).not.toHaveBeenCalled();
    reader.unmount();

    const rich = { id: 42, type: GalleryBlockType.DETAILED, title: 'Cached rich title' } as GalleryBlock;
    vi.mocked(getGalleryBlock).mockResolvedValue(rich);
    vi.mocked(getGalleryImages).mockResolvedValue(realFiles);
    const detail = renderHook(() => useGalleryDetail(42, { refreshDownloadedMetadata: true }), { wrapper: wrapper() });
    await waitFor(() => expect(detail.result.current.block).toBe(rich));
    expect(detail.result.current.files).toEqual(realFiles);
    expect(fetchGalleryInfo).not.toHaveBeenCalled();
  });
});
