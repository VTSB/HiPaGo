// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageType } from '@/lib/utils/types';
import type { GalleryFile } from '@/lib/utils/types';

vi.mock('../client', () => ({
  apiClient: {
    fetchLtnText: vi.fn(),
  },
}));

vi.mock('../parser', () => ({
  parseGalleryJson: vi.fn(),
  galleryInfoToImages: vi.fn(),
}));

vi.mock('../nozomi', () => ({
  fetchGalleryIds: vi.fn(),
  fetchGalleryIdsByTag: vi.fn(),
}));

vi.mock('@/lib/db/gallery', () => ({
  saveGalleryImages: vi.fn(),
  getGalleryImages: vi.fn(),
}));

import { apiClient } from '../client';
import { parseGalleryJson, galleryInfoToImages } from '../parser';
import { getGalleryImages as getGalleryImagesFromDb, saveGalleryImages } from '@/lib/db/gallery';
import { fetchGalleryImagesCached } from '../gallery';

describe('fetchGalleryImagesCached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // saveGalleryImages is async in production — default the mock to a resolved
    // promise so the best-effort `.catch` has a thenable to attach to.
    vi.mocked(saveGalleryImages).mockResolvedValue(undefined);
  });

  it('returns cached images from DB when available', async () => {
    const cachedFiles: GalleryFile[] = [
      { name: '001.jpg', hash: 'h1', width: 800, height: 1200, haswebp: 1, hasavif: 1, hasavifsmalltn: 1 },
      { name: '002.jpg', hash: 'h2', width: 800, height: 1200, haswebp: 1, hasavif: 0, hasavifsmalltn: 0 },
    ];
    vi.mocked(getGalleryImagesFromDb).mockResolvedValue(cachedFiles);

    const result = await fetchGalleryImagesCached(123);

    expect(getGalleryImagesFromDb).toHaveBeenCalledWith(123);
    expect(apiClient.fetchLtnText).not.toHaveBeenCalled();
    expect(result.id).toBe(123);
    expect(result.images).toHaveLength(2);
    expect(result.images[0].types.has(ImageType.ORIGINAL)).toBe(true);
    expect(result.images[0].types.has(ImageType.WEBP)).toBe(true);
    expect(result.images[0].types.has(ImageType.AVIF)).toBe(true);
    expect(result.images[1].types.has(ImageType.AVIF)).toBe(false);
  });

  it('fetches from API and caches when not in DB', async () => {
    vi.mocked(getGalleryImagesFromDb).mockResolvedValue(null);

    const mockInfo = {
      id: 456,
      files: [{ name: '001.jpg', hash: 'h1', width: 800, height: 1200, haswebp: 1, hasavif: 1, hasavifsmalltn: 1 }],
      language: 'japanese',
      languageLocalName: '日本語',
      date: '2024-01-01',
      tags: [],
      title: 'Test',
      japaneseTitle: '',
      type: 'doujinshi',
      related: [],
      artists: [],
      groups: [],
      characters: [],
      parodys: [],
    };
    const mockImages = {
      id: 456,
      images: [{ name: '001.jpg', hash: 'h1', width: 800, height: 1200, types: new Set([ImageType.ORIGINAL]) }],
    };

    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('var galleryinfo = {}');
    vi.mocked(parseGalleryJson).mockReturnValue(mockInfo);
    vi.mocked(galleryInfoToImages).mockReturnValue(mockImages);

    const result = await fetchGalleryImagesCached(456);

    expect(saveGalleryImages).toHaveBeenCalledWith(456, mockInfo.files);
    expect(result).toEqual(mockImages);
  });

  const networkInfo = {
    id: 999,
    files: [{ name: '001.jpg', hash: 'h1', width: 800, height: 1200, haswebp: 1, hasavif: 1, hasavifsmalltn: 1 }],
    language: 'japanese',
    languageLocalName: '日本語',
    date: '2024-01-01',
    tags: [],
    title: 'Test',
    japaneseTitle: '',
    type: 'doujinshi',
    related: [],
    artists: [],
    groups: [],
    characters: [],
    parodys: [],
  };
  const networkImages = {
    id: 999,
    images: [{ name: '001.jpg', hash: 'h1', width: 800, height: 1200, types: new Set([ImageType.ORIGINAL]) }],
  };

  it('treats a dead DB as a cache miss and falls through to the network', async () => {
    // Simulate an unavailable/uninitialized DB: the cache read throws.
    vi.mocked(getGalleryImagesFromDb).mockRejectedValue(new Error('Database not initialized.'));
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('var galleryinfo = {}');
    vi.mocked(parseGalleryJson).mockReturnValue(networkInfo);
    vi.mocked(galleryInfoToImages).mockReturnValue(networkImages);

    const result = await fetchGalleryImagesCached(999);

    expect(apiClient.fetchLtnText).toHaveBeenCalled();
    expect(result).toEqual(networkImages);
  });

  it('still returns images when the DB cache save fails (best-effort save)', async () => {
    vi.mocked(getGalleryImagesFromDb).mockResolvedValue(null);
    vi.mocked(saveGalleryImages).mockRejectedValue(new Error('Database not initialized.'));
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('var galleryinfo = {}');
    vi.mocked(parseGalleryJson).mockReturnValue(networkInfo);
    vi.mocked(galleryInfoToImages).mockReturnValue(networkImages);

    const result = await fetchGalleryImagesCached(999);

    expect(result).toEqual(networkImages);
  });

  it('includes all image types based on flags', async () => {
    const cachedFiles: GalleryFile[] = [
      { name: '001.jpg', hash: 'h1', width: 800, height: 1200, haswebp: 0, hasavif: 0, hasavifsmalltn: 0 },
    ];
    vi.mocked(getGalleryImagesFromDb).mockResolvedValue(cachedFiles);

    const result = await fetchGalleryImagesCached(789);

    expect(result.images[0].types.has(ImageType.ORIGINAL)).toBe(true);
    expect(result.images[0].types.has(ImageType.WEBP)).toBe(false);
    expect(result.images[0].types.has(ImageType.AVIF)).toBe(false);
  });
});
