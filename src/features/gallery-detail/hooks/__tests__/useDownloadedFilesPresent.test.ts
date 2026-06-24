// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { DBDownload } from '@/lib/db/schema';

const mockGetDownload = vi.fn();
const mockHasCompleteDownloadedGallery = vi.fn();

vi.mock('@/lib/db/download', () => ({
  getDownload: (id: number) => mockGetDownload(id),
}));
vi.mock('@/lib/utils/download-zip', () => ({
  hasCompleteDownloadedGallery: (id: number, expectedPageCount: number) =>
    mockHasCompleteDownloadedGallery(id, expectedPageCount),
}));

// Controllable store: the hook only reads it via primitive selectors.
let storeState: { downloaded: Record<number, boolean>; entries: Record<number, unknown> };
vi.mock('@/lib/store/download-progress', () => ({
  useDownloadProgressStore: <T,>(selector: (s: typeof storeState) => T): T => selector(storeState),
}));

import { useDownloadedFilesPresent } from '../useDownloadedFilesPresent';

function makeRow(status: DBDownload['status'], pageCount = 3): DBDownload {
  return {
    galleryId: 42,
    title: 'T',
    thumbnail: '',
    tags: '{}',
    pageCount,
    totalBytes: 0,
    downloadedAt: new Date().toISOString(),
    status,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  storeState = { downloaded: {}, entries: {} };
  mockHasCompleteDownloadedGallery.mockResolvedValue(true);
});

describe('useDownloadedFilesPresent', () => {
  it('not downloaded → filesMissing false, never reads disk', async () => {
    storeState.downloaded = { 42: false };
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(false);
    expect(mockGetDownload).not.toHaveBeenCalled();
  });

  it('complete + manifest covers all pages → not missing', async () => {
    storeState.downloaded = { 42: true };
    mockGetDownload.mockResolvedValue(makeRow('complete', 3));
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(false);
    expect(mockHasCompleteDownloadedGallery).toHaveBeenCalledWith(42, 3);
  });

  it('complete + empty manifest → missing', async () => {
    storeState.downloaded = { 42: true };
    mockGetDownload.mockResolvedValue(makeRow('complete', 3));
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(true);
  });

  it('complete + manifest short of pageCount → missing', async () => {
    storeState.downloaded = { 42: true };
    mockGetDownload.mockResolvedValue(makeRow('complete', 5));
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(true);
  });

  it('complete + manifest covers pageCount but an image file is missing → missing', async () => {
    storeState.downloaded = { 42: true };
    mockGetDownload.mockResolvedValue(makeRow('complete', 3));
    mockHasCompleteDownloadedGallery.mockResolvedValue(false);
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(true);
  });

  it('transient disk read error → assumed present (not missing)', async () => {
    storeState.downloaded = { 42: true };
    mockGetDownload.mockResolvedValue(makeRow('complete', 3));
    mockHasCompleteDownloadedGallery.mockRejectedValue(new Error('SAF unavailable'));
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(false);
  });

  it('row not complete → not missing (handled by other button states)', async () => {
    storeState.downloaded = { 42: true };
    mockGetDownload.mockResolvedValue(makeRow('failed', 3));
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(false);
  });

  it('active (re)download in flight → not missing, skips disk check', async () => {
    storeState.downloaded = { 42: true };
    storeState.entries = { 42: { progress: { current: 1, total: 3 } } };
    mockGetDownload.mockResolvedValue(makeRow('complete', 3));
    const { result } = renderHook(() => useDownloadedFilesPresent(42));
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.filesMissing).toBe(false);
    expect(mockGetDownload).not.toHaveBeenCalled();
  });
});
