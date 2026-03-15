// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveGalleryDetail } from '../useGalleryDetail';
import { GalleryBlockType, ImageType } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile } from '@/lib/utils/types';

vi.mock('@/lib/db/gallery', () => ({
  getGalleryBlock: vi.fn(),
  saveGalleryBlock: vi.fn().mockResolvedValue(undefined),
  getGalleryImages: vi.fn(),
  saveGalleryImages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/api/gallery', () => ({
  fetchGalleryInfo: vi.fn(),
  filesToGalleryImages: vi.fn(),
}));

vi.mock('@/lib/api/parser', () => ({
  galleryInfoToBlock: vi.fn(),
  galleryInfoToImages: vi.fn(),
}));

import {
  getGalleryBlock,
  saveGalleryBlock,
  getGalleryImages,
  saveGalleryImages,
} from '@/lib/db/gallery';
import { fetchGalleryInfo, filesToGalleryImages } from '@/lib/api/gallery';
import { galleryInfoToBlock, galleryInfoToImages } from '@/lib/api/parser';

const sampleFiles: GalleryFile[] = [
  { width: 1280, height: 1800, haswebp: 1, hasavif: 1, hasavifsmalltn: 1, name: '001.jpg', hash: 'abc' },
];

const sampleBlock: GalleryBlock = {
  id: 12345,
  type: GalleryBlockType.DETAILED,
  title: 'Test',
  date: new Date('2024-01-01'),
  tags: {},
  thumbnail: '',
  related: [],
  language: 'japanese',
  mediaType: 'doujinshi',
};

const sampleImages = {
  id: 12345,
  images: [{ name: '001.jpg', hash: 'abc', width: 1280, height: 1800, types: new Set([ImageType.ORIGINAL]) }],
};

describe('resolveGalleryDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached DETAILED block + images WITHOUT calling fetchGalleryInfo', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(sampleBlock);
    vi.mocked(getGalleryImages).mockResolvedValue(sampleFiles);
    vi.mocked(filesToGalleryImages).mockReturnValue(sampleImages);

    const result = await resolveGalleryDetail(12345);

    expect(fetchGalleryInfo).not.toHaveBeenCalled();
    expect(result.block).toEqual(sampleBlock);
    expect(result.images).toEqual(sampleImages);
    expect(result.files).toEqual(sampleFiles);
  });

  it('fetches from API when no cached block', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);

    const mockInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese' } as any;
    vi.mocked(fetchGalleryInfo).mockResolvedValue(mockInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(sampleBlock);
    vi.mocked(galleryInfoToImages).mockReturnValue(sampleImages);

    const result = await resolveGalleryDetail(12345);

    expect(fetchGalleryInfo).toHaveBeenCalledWith(12345);
    expect(result.block).toEqual(sampleBlock);
    expect(result.images).toEqual(sampleImages);
  });

  it('fetches from API when cached block is NOT_DETAILED', async () => {
    const notDetailedBlock: GalleryBlock = { ...sampleBlock, type: GalleryBlockType.NOT_DETAILED };
    vi.mocked(getGalleryBlock).mockResolvedValue(notDetailedBlock);
    vi.mocked(getGalleryImages).mockResolvedValue(null);

    const mockInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese' } as any;
    vi.mocked(fetchGalleryInfo).mockResolvedValue(mockInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(sampleBlock);
    vi.mocked(galleryInfoToImages).mockReturnValue(sampleImages);

    await resolveGalleryDetail(12345);

    expect(fetchGalleryInfo).toHaveBeenCalledWith(12345);
  });

  it('saves block and images to DB after API fetch for DETAILED blocks', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);

    const mockInfo = { id: 12345, files: sampleFiles } as any;
    vi.mocked(fetchGalleryInfo).mockResolvedValue(mockInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(sampleBlock);
    vi.mocked(galleryInfoToImages).mockReturnValue(sampleImages);

    await resolveGalleryDetail(12345);

    // Allow fire-and-forget saves to settle
    await new Promise(r => setTimeout(r, 10));

    expect(saveGalleryBlock).toHaveBeenCalledWith(sampleBlock);
    expect(saveGalleryImages).toHaveBeenCalledWith(12345, sampleFiles);
  });

  it('returns cached block immediately AND triggers background revalidation when stale (>3 days)', async () => {
    const staleDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
    const staleBlock: GalleryBlock = { ...sampleBlock, updatedAt: staleDate };
    vi.mocked(getGalleryBlock).mockResolvedValue(staleBlock);
    vi.mocked(getGalleryImages).mockResolvedValue(sampleFiles);
    vi.mocked(filesToGalleryImages).mockReturnValue(sampleImages);

    const mockInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese' } as any;
    vi.mocked(fetchGalleryInfo).mockResolvedValue(mockInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(sampleBlock);

    const result = await resolveGalleryDetail(12345);

    // Returns cached data (not fetched from API as primary result)
    expect(result.block).toEqual(staleBlock);
    expect(result.files).toEqual(sampleFiles);

    // Background revalidation triggered
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGalleryInfo).toHaveBeenCalledWith(12345);
  });

  it('does NOT revalidate when DETAILED block is only 2 days old (within threshold)', async () => {
    const freshEnough = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days
    const freshBlock: GalleryBlock = { ...sampleBlock, updatedAt: freshEnough };
    vi.mocked(getGalleryBlock).mockResolvedValue(freshBlock);
    vi.mocked(getGalleryImages).mockResolvedValue(sampleFiles);
    vi.mocked(filesToGalleryImages).mockReturnValue(sampleImages);

    const result = await resolveGalleryDetail(12345);

    expect(result.block).toEqual(freshBlock);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchGalleryInfo).not.toHaveBeenCalled();
  });

  it('does NOT save FAILED block to DB', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('API error'));

    await expect(resolveGalleryDetail(12345)).rejects.toThrow('API error');

    await new Promise(r => setTimeout(r, 10));
    expect(saveGalleryBlock).not.toHaveBeenCalled();
  });
});
