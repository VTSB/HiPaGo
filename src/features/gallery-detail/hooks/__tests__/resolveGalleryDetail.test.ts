// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveGalleryDetail } from '../useGalleryDetail';
import { GalleryBlockType, ImageType } from '@/lib/utils/types';
import type { GalleryBlock, GalleryFile, GalleryInfo } from '@/lib/utils/types';

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

// Offline download-row fallback deps (used when the network fetch fails).
vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(),
  deserializeTags: (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  },
}));
vi.mock('@/lib/utils/download-zip', () => ({
  getDownloadedGalleryPages: vi.fn(),
  hasCompleteDownloadedGallery: vi.fn(),
}));

import {
  getGalleryBlock,
  saveGalleryBlock,
  getGalleryImages,
  saveGalleryImages,
} from '@/lib/db/gallery';
import { fetchGalleryInfo, filesToGalleryImages } from '@/lib/api/gallery';
import { galleryInfoToBlock, galleryInfoToImages } from '@/lib/api/parser';
import { getDownload } from '@/lib/db/download';
import { getDownloadedGalleryPages, hasCompleteDownloadedGallery } from '@/lib/utils/download-zip';

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
    // Default: no download row / no on-disk pages so the fallback is inert
    // unless a test opts in.
    vi.mocked(getDownload).mockResolvedValue(null);
    vi.mocked(getDownloadedGalleryPages).mockResolvedValue([]);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(false);
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

    const mockInfo: GalleryInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese', languageLocalName: '日本語', date: '2024-01-01', tags: [], artists: [], groups: [], characters: [], parodys: [], japaneseTitle: '', title: 'Test', related: [] };
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

    const mockInfo: GalleryInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese', languageLocalName: '日本語', date: '2024-01-01', tags: [], artists: [], groups: [], characters: [], parodys: [], japaneseTitle: '', title: 'Test', related: [] };
    vi.mocked(fetchGalleryInfo).mockResolvedValue(mockInfo);
    vi.mocked(galleryInfoToBlock).mockReturnValue(sampleBlock);
    vi.mocked(galleryInfoToImages).mockReturnValue(sampleImages);

    await resolveGalleryDetail(12345);

    expect(fetchGalleryInfo).toHaveBeenCalledWith(12345);
  });

  it('saves block and images to DB after API fetch for DETAILED blocks', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);

    const mockInfo: GalleryInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese', languageLocalName: '日本語', date: '2024-01-01', tags: [], artists: [], groups: [], characters: [], parodys: [], japaneseTitle: '', title: 'Test', related: [] };
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

    const mockInfo: GalleryInfo = { id: 12345, files: sampleFiles, type: 'doujinshi', language: 'japanese', languageLocalName: '日本語', date: '2024-01-01', tags: [], artists: [], groups: [], characters: [], parodys: [], japaneseTitle: '', title: 'Test', related: [] };
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

  // ── Offline download-row fallback (hole 2) ──────────────────────────────────
  it('falls back to the download row + manifest when the network fetch fails for a downloaded gallery', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    // A downloaded row + 3 pages on disk.
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 12345,
      title: 'Downloaded Title',
      thumbnail: '/tn.avif',
      tags: '{"artist":["a"]}',
      pageCount: 3,
      totalBytes: 0,
      downloadedAt: '2024-05-05T00:00:00.000Z',
      status: 'complete',
      folderName: '12345 Downloaded Title',
    } as unknown as Awaited<ReturnType<typeof getDownload>>);
    vi.mocked(getDownloadedGalleryPages).mockResolvedValue([
      { index: 2, ext: 'webp' },
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'avif' },
    ]);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(true);
    const synthImages = { id: 12345, images: [] };
    vi.mocked(filesToGalleryImages).mockReturnValue(synthImages);

    const result = await resolveGalleryDetail(12345);

    expect(result.block.type).toBe(GalleryBlockType.NOT_DETAILED);
    expect(result.block.title).toBe('Downloaded Title');
    expect(result.block.tags).toEqual({ artist: ['a'] });
    expect(result.files).toHaveLength(3);
    // files are index-sorted to [0(webp), 1(avif), 2(webp)] → index 1 is the avif page
    expect(result.files[1].hasavif).toBe(1);
    expect(result.files[0].haswebp).toBe(1);
    expect(result.images).toBe(synthImages);
    expect(hasCompleteDownloadedGallery).toHaveBeenCalledWith(12345, 3, {
      folderName: '12345 Downloaded Title',
    });
    expect(getDownloadedGalleryPages).toHaveBeenCalledWith(12345, {
      folderName: '12345 Downloaded Title',
    });
    // It must NOT pollute the gallery cache with the synthetic block.
    expect(saveGalleryBlock).not.toHaveBeenCalled();
  });

  it('re-throws the network error when there is no download row', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    vi.mocked(getDownload).mockResolvedValue(null);

    await expect(resolveGalleryDetail(12345)).rejects.toThrow('offline');
  });

  it('re-throws the network error when the download row has no pages on disk', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 12345,
      title: 'X',
      thumbnail: '',
      tags: '{}',
      pageCount: 3,
      totalBytes: 0,
      downloadedAt: '2024-05-05T00:00:00.000Z',
      status: 'complete',
    } as unknown as Awaited<ReturnType<typeof getDownload>>);
    vi.mocked(getDownloadedGalleryPages).mockResolvedValue([]);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(false);

    await expect(resolveGalleryDetail(12345)).rejects.toThrow('offline');
    expect(hasCompleteDownloadedGallery).toHaveBeenCalledWith(12345, 3, {
      folderName: null,
    });
    expect(getDownloadedGalleryPages).not.toHaveBeenCalled();
  });

  it('re-throws the network error when the download row is partial', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 12345,
      title: 'Partial',
      thumbnail: '',
      tags: '{}',
      pageCount: 3,
      totalBytes: 0,
      downloadedAt: '2024-05-05T00:00:00.000Z',
      status: 'failed',
    } as unknown as Awaited<ReturnType<typeof getDownload>>);
    vi.mocked(getDownloadedGalleryPages).mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(false);

    await expect(resolveGalleryDetail(12345)).rejects.toThrow('offline');
  });

  it('re-throws the network error when the manifest exists but files are incomplete', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 12345,
      title: 'Stale Complete',
      thumbnail: '',
      tags: '{}',
      pageCount: 3,
      totalBytes: 0,
      downloadedAt: '2024-05-05T00:00:00.000Z',
      status: 'complete',
    } as unknown as Awaited<ReturnType<typeof getDownload>>);
    vi.mocked(getDownloadedGalleryPages).mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
      { index: 2, ext: 'webp' },
    ]);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(false);

    await expect(resolveGalleryDetail(12345)).rejects.toThrow('offline');
    expect(getDownloadedGalleryPages).not.toHaveBeenCalled();
  });

  it('re-throws when completeness passes but the second manifest read is short', async () => {
    vi.mocked(getGalleryBlock).mockResolvedValue(null);
    vi.mocked(getGalleryImages).mockResolvedValue(null);
    vi.mocked(fetchGalleryInfo).mockRejectedValue(new Error('offline'));
    vi.mocked(getDownload).mockResolvedValue({
      galleryId: 12345,
      title: 'Racy Complete',
      thumbnail: '',
      tags: '{}',
      pageCount: 3,
      totalBytes: 0,
      downloadedAt: '2024-05-05T00:00:00.000Z',
      status: 'complete',
    } as unknown as Awaited<ReturnType<typeof getDownload>>);
    vi.mocked(hasCompleteDownloadedGallery).mockResolvedValue(true);
    vi.mocked(getDownloadedGalleryPages).mockResolvedValue([
      { index: 0, ext: 'webp' },
      { index: 1, ext: 'webp' },
    ]);

    await expect(resolveGalleryDetail(12345)).rejects.toThrow('offline');
  });
});
