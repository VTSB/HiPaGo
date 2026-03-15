// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the hook's return shape indirectly via resolveGalleryDetail
// (hooks need jsdom but this is a node environment test file)
// We verify the hook EXPORTS the right shape by checking the module exports.
import { GalleryBlockType } from '@/lib/utils/types';
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

import { resolveGalleryDetail } from '../useGalleryDetail';
import { getGalleryBlock, getGalleryImages } from '@/lib/db/gallery';
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

describe('useGalleryDetail hook shape', () => {
  it('exports useGalleryDetail as a function', async () => {
    const mod = await import('../useGalleryDetail');
    expect(typeof mod.useGalleryDetail).toBe('function');
  });

  it('useGalleryDetail does NOT export info field (uses files instead)', async () => {
    // The hook should return { block, images, files, isLoading, error }
    // We verify this by inspecting what resolveGalleryDetail returns (files, not info)
    vi.mocked(getGalleryBlock).mockResolvedValue(sampleBlock);
    vi.mocked(getGalleryImages).mockResolvedValue(sampleFiles);
    vi.mocked(filesToGalleryImages).mockReturnValue({ id: 12345, images: [] });

    const result = await resolveGalleryDetail(12345);
    expect(result).toHaveProperty('files');
    expect(result).not.toHaveProperty('info');
    expect(Array.isArray(result.files)).toBe(true);
  });
});
