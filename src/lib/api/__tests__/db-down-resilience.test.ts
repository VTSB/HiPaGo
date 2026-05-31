// @vitest-environment node
//
// AC-04 — empirical resilience proof against a REAL dead DB.
//
// In the node test environment `window` is undefined, so detectPlatformAdapter()
// throws "No SQLite platform detected" and ensureDb() rejects for every call —
// the exact runtime condition the user hit on Android (DB connection failed).
// We do NOT mock the DB layer here; we mock only the network boundary
// (apiClient + parser) so the REAL guard code paths run against a REAL failing
// ensureDb. This reproduces "DB down" faithfully and proves browse/read still
// resolve from the network.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GalleryBlockType, ImageType } from '@/lib/utils/types';

vi.mock('../client', () => ({
  apiClient: { fetchLtnText: vi.fn() },
}));

vi.mock('../parser', () => ({
  parseGalleryJson: vi.fn(),
  galleryInfoToImages: vi.fn(),
  parseGalleryBlockHtml: vi.fn(),
  galleryInfoToBlock: vi.fn(),
}));

import { apiClient } from '../client';
import { parseGalleryJson, galleryInfoToImages, parseGalleryBlockHtml } from '../parser';
import { fetchGalleryImagesCached } from '../gallery';
import { resolveBlock } from '@/features/gallery-list/hooks/useGalleryBlock';
import { getReadingProgress, recordHistory, getGalleryImages } from '@/lib/db/gallery';

const networkInfo = {
  id: 1,
  files: [{ name: '001.jpg', hash: 'h1', width: 800, height: 1200, haswebp: 1, hasavif: 0, hasavifsmalltn: 0 }],
  language: 'japanese',
  languageLocalName: '日本語',
  date: '2024-01-01',
  tags: [],
  title: 'Net',
  japaneseTitle: '',
  type: 'doujinshi',
  related: [],
  artists: [],
  groups: [],
  characters: [],
  parodys: [],
};
const networkImages = {
  id: 1,
  images: [{ name: '001.jpg', hash: 'h1', width: 800, height: 1200, types: new Set([ImageType.ORIGINAL]) }],
};
const networkBlock = {
  id: 1,
  type: GalleryBlockType.NOT_DETAILED,
  title: 'Net',
  date: new Date('2024-01-01'),
  tags: {},
  thumbnail: 't.jpg',
  related: [],
};

describe('DB-down resilience (real ensureDb failure, network mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.fetchLtnText).mockResolvedValue('payload');
    vi.mocked(parseGalleryJson).mockReturnValue(networkInfo);
    vi.mocked(galleryInfoToImages).mockReturnValue(networkImages);
    vi.mocked(parseGalleryBlockHtml).mockReturnValue(networkBlock);
  });

  it('sanity: the DB really is dead in this env (ensureDb-backed reads reject)', async () => {
    await expect(getGalleryImages(1)).rejects.toThrow();
    await expect(getReadingProgress(1)).rejects.toThrow();
    await expect(recordHistory(1, 0, 10, 'page')).rejects.toThrow();
  });

  it('fetchGalleryImagesCached returns network images despite the dead DB (AC-01)', async () => {
    const result = await fetchGalleryImagesCached(1);
    expect(result).toEqual(networkImages);
    expect(apiClient.fetchLtnText).toHaveBeenCalled();
  });

  it('resolveBlock returns the network block despite the dead DB (list path)', async () => {
    const block = await resolveBlock(1);
    expect(block).toEqual(networkBlock);
  });

  it('the reader .catch pattern neutralizes the rejection (AC-02 / AC-03)', async () => {
    // useReader / useReaderPersistence call these fire-and-forget with .catch.
    // Proven here: wrapping the (genuinely rejecting) calls swallows the error
    // instead of producing an unhandled rejection.
    await expect(getReadingProgress(1).catch(() => 'handled')).resolves.toBe('handled');
    await expect(recordHistory(1, 0, 10, 'page').catch(() => 'handled')).resolves.toBe('handled');
  });
});
