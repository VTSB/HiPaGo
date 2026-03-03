// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client', () => ({
  apiClient: {
    fetchLtnBinary: vi.fn(),
    fetchLtnBinaryWithTotal: vi.fn(),
  },
}));

import { apiClient } from '../client';
import { fetchGalleryIds, fetchGalleryIdsByTag, fetchNozomiSearch } from '../nozomi';

function buildNozomiBuffer(ids: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(ids.length * 4);
  const view = new DataView(buffer);
  ids.forEach((id, i) => view.setInt32(i * 4, id, false));
  return buffer;
}

describe('fetchGalleryIds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches nozomi data with correct path and range', async () => {
    const data = buildNozomiBuffer([100, 200, 300]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({
      data,
      total: 400, // 100 IDs total
    });

    const result = await fetchGalleryIds('index', 'all', 0);

    expect(apiClient.fetchLtnBinaryWithTotal).toHaveBeenCalledWith(
      'index-all.nozomi',
      'bytes=0-99',
    );
    expect(result.idList).toEqual([100, 200, 300]);
    expect(result.length).toBe(100); // 400 bytes / 4 bytes per ID
  });

  it('calculates correct page range for second page', async () => {
    const data = buildNozomiBuffer([400, 500]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({
      data,
      total: 200,
    });

    await fetchGalleryIds('index', 'japanese', 1);

    expect(apiClient.fetchLtnBinaryWithTotal).toHaveBeenCalledWith(
      'index-japanese.nozomi',
      'bytes=100-199',
    );
  });

  it('uses idList.length when total is 0', async () => {
    const data = buildNozomiBuffer([1, 2, 3]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({
      data,
      total: 0,
    });

    const result = await fetchGalleryIds('index', 'all', 0);
    expect(result.length).toBe(3);
  });

  it('uses popular path when sort is popular_year', async () => {
    const data = buildNozomiBuffer([10, 20]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({
      data,
      total: 80,
    });

    await fetchGalleryIds('index', 'all', 0, 25, 'popular_year');

    expect(apiClient.fetchLtnBinaryWithTotal).toHaveBeenCalledWith(
      'popular/year-all.nozomi',
      expect.any(String),
    );
  });

  it('uses normal path when sort is date_added', async () => {
    const data = buildNozomiBuffer([10, 20]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({
      data,
      total: 80,
    });

    await fetchGalleryIds('index', 'all', 0, 25, 'date_added');

    expect(apiClient.fetchLtnBinaryWithTotal).toHaveBeenCalledWith(
      'index-all.nozomi',
      expect.any(String),
    );
  });
});

describe('fetchGalleryIdsByTag', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds correct path with encoded tag', async () => {
    const data = buildNozomiBuffer([10, 20]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({
      data,
      total: 80,
    });

    const result = await fetchGalleryIdsByTag('artist', 'test name', 'all', 0);

    expect(apiClient.fetchLtnBinaryWithTotal).toHaveBeenCalledWith(
      'artist/test%20name-all.nozomi',
      'bytes=0-99',
    );
    expect(result.idList).toEqual([10, 20]);
  });

  it('uses idList.length when total is null', async () => {
    const data = buildNozomiBuffer([10, 20]);
    vi.mocked(apiClient.fetchLtnBinaryWithTotal).mockResolvedValue({ data, total: null });
    const result = await fetchGalleryIdsByTag('artist', 'test', 'all', 0);
    expect(result.length).toBe(2); // 2 IDs in buffer = idList.length
  });
});

describe('fetchNozomiSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds path with area prefix under n/ and fetches all results', async () => {
    const data = buildNozomiBuffer([50, 60]);
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValue(data);

    const result = await fetchNozomiSearch('tag', 'female:test', 'all');

    expect(apiClient.fetchLtnBinary).toHaveBeenCalledWith(
      'n/tag/female%3Atest-all.nozomi',
    );
    expect(result).toEqual([50, 60]);
  });

  it('builds path without area when area is empty', async () => {
    const data = buildNozomiBuffer([1, 2, 3]);
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValue(data);

    const result = await fetchNozomiSearch('', 'index', 'korean');

    expect(apiClient.fetchLtnBinary).toHaveBeenCalledWith(
      'n/index-korean.nozomi',
    );
    expect(result).toEqual([1, 2, 3]);
  });

  it('builds popular path with area when sort is provided', async () => {
    const data = buildNozomiBuffer([70, 80]);
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValue(data);

    const result = await fetchNozomiSearch('tag', 'female:test', 'all', 'popular_month');

    expect(apiClient.fetchLtnBinary).toHaveBeenCalledWith(
      'n/tag/popular/month/female%3Atest-all.nozomi',
    );
    expect(result).toEqual([70, 80]);
  });

  it('builds popular path without area for language search with sort', async () => {
    const data = buildNozomiBuffer([11, 22]);
    vi.mocked(apiClient.fetchLtnBinary).mockResolvedValue(data);

    const result = await fetchNozomiSearch('', 'index', 'japanese', 'popular_week');

    expect(apiClient.fetchLtnBinary).toHaveBeenCalledWith(
      'popular/week-japanese.nozomi',
    );
    expect(result).toEqual([11, 22]);
  });
});
