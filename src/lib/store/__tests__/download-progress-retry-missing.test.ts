// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DBDownload } from '@/lib/db/schema';

const harness = vi.hoisted(() => ({
  row: null as DBDownload | null,
  getDownload: vi.fn<(id: number) => Promise<DBDownload | null>>(),
  redownload: vi.fn<(expected: DBDownload) => Promise<boolean>>(),
  dequeue: vi.fn(),
  listQueue: vi.fn(),
  removeFromQueue: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  getGgConfig: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

vi.mock('@/lib/utils/download-zip', () => ({
  downloadGalleryToLibrary: vi.fn(),
  getDownloadedGalleryPages: vi.fn(async () => []),
  hasCompleteDownloadedGallery: vi.fn(async () => false),
  DownloadPausedError: class DownloadPausedError extends Error {},
  StaleDownloadRunError: class StaleDownloadRunError extends Error {},
}));

vi.mock('@/lib/storage/download-store', () => ({
  createDownloadStore: vi.fn(),
  DownloadCancelledError: class DownloadCancelledError extends Error {},
}));

vi.mock('@/lib/db/download', () => ({
  getDownload: (id: number) => harness.getDownload(id),
  deserializeTags: vi.fn(() => ({})),
  setDownloadError: vi.fn(),
  completeDownloadIfUnchanged: vi.fn(),
  prepareNativeDownloadRun: vi.fn(),
  adoptNativeRunIfUnchanged: vi.fn(),
  adoptDiscoveredNativeRunIfUnchanged: vi.fn(),
  transitionNativeDownloadRun: vi.fn(),
  clearNativeRunIfMatches: vi.fn(),
  clearNativeRunIfUnchanged: vi.fn(),
  deleteDownloadIfNativeRunMatches: vi.fn(),
}));

vi.mock('@/lib/db/download-queue', () => ({
  enqueueDownload: vi.fn(),
  dequeueNextQueued: (...args: unknown[]) => harness.dequeue(...args),
  removeFromQueue: (id: number) => harness.removeFromQueue(id),
  listQueue: () => harness.listQueue(),
  pauseQueued: vi.fn(),
  resumeQueued: vi.fn(),
  resumePausedNativeRun: vi.fn(),
  reorderQueue: vi.fn(),
  releaseDownloadClaim: vi.fn(async () => false),
}));

vi.mock('@/lib/db/download-retry', () => ({
  AUTO_RETRY_BACKOFF_MS: [30_000, 300_000, 1_800_000],
  AUTO_RETRY_MAX: 3,
  scheduleAutoRetry: vi.fn(),
  listDueAutoRetries: vi.fn(async () => []),
  earliestNextRetryAt: vi.fn(async () => null),
  requeueDueAutoRetry: vi.fn(),
  requeueInterruptedDownload: vi.fn(),
  retryDownloadIfUnchanged: vi.fn(),
  retryDownloadIfAbsent: vi.fn(),
  redownloadCompleteIfUnchanged: (expected: DBDownload) => harness.redownload(expected),
}));

vi.mock('@/lib/utils/network', () => ({ isUnmeteredNetwork: vi.fn(async () => true) }));
vi.mock('@/lib/utils/platform', () => ({
  isAndroid: () => false,
  isIos: () => false,
  isNativePlatform: () => false,
  isTauri: () => false,
  isCapacitor: () => false,
}));
vi.mock('@/lib/utils/work-order', () => ({
  buildWorkOrder: vi.fn(),
  buildIosWorkOrder: vi.fn(),
  createDownloadRunId: vi.fn(() => 'run-test-aaaaaaaaaaaa'),
}));
vi.mock('@/lib/plugins/downloadWorker', () => ({ DownloadWorker: {} }));
vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({
  resolveGalleryDetail: vi.fn(),
}));
vi.mock('@/lib/storage/base-path-resolver', () => ({ galleryFolderName: vi.fn() }));

import { useDownloadProgressStore } from '../download-progress';
import { useZipExportStore } from '@/lib/store/zip-export';

function completeRow(galleryId: number): DBDownload {
  return {
    galleryId,
    title: `Gallery ${galleryId}`,
    thumbnail: '/thumb.webp',
    tags: '{}',
    pageCount: 5,
    totalBytes: 500,
    downloadedAt: '2026-07-31T00:00:00.000Z',
    status: 'complete',
    folderName: `${galleryId} Gallery`,
    migratedAt: null,
    lastError: null,
    queuePosition: null,
    retryCount: 0,
    nextRetryAt: null,
    nativeRunId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.row = null;
  harness.getDownload.mockImplementation(async () => harness.row);
  harness.redownload.mockResolvedValue(false);
  harness.dequeue.mockResolvedValue(null);
  harness.listQueue.mockResolvedValue([]);
  harness.removeFromQueue.mockImplementation(async () => {
    if (harness.row) {
      harness.row = { ...harness.row, status: 'failed', queuePosition: null };
    }
  });
  useZipExportStore.getState().reset();
  useDownloadProgressStore.setState({
    entries: {},
    downloaded: {},
    queue: [],
    globalPaused: false,
  });
});

describe('retryMissing lifecycle barrier', () => {
  it('kicks the committed queue when the post-CAS row read fails transiently', async () => {
    const snapshot = completeRow(5101);
    harness.row = snapshot;
    harness.redownload.mockImplementation(async () => {
      harness.row = { ...snapshot, status: 'queued', queuePosition: 0 };
      return true;
    });
    harness.getDownload.mockRejectedValueOnce(new Error('temporary DB read failure'));

    await expect(useDownloadProgressStore.getState().retryMissing(snapshot)).resolves.toBe(true);

    expect(useDownloadProgressStore.getState().downloaded[5101]).toBe(false);
    expect(useDownloadProgressStore.getState().entries[5101]).toMatchObject({
      queued: true,
      title: snapshot.title,
      thumbnail: snapshot.thumbnail,
    });
    await vi.waitFor(() => expect(harness.dequeue).toHaveBeenCalled());
  });

  it('does not publish or process when the exact complete-row CAS loses', async () => {
    const snapshot = completeRow(5102);
    harness.row = { ...snapshot, title: 'Newer metadata' };
    harness.redownload.mockResolvedValue(false);

    await expect(useDownloadProgressStore.getState().retryMissing(snapshot)).resolves.toBe(false);

    expect(harness.row).toMatchObject({ status: 'complete', title: 'Newer metadata' });
    expect(useDownloadProgressStore.getState().entries[5102]).toBeUndefined();
    expect(harness.dequeue).not.toHaveBeenCalled();
  });

  it('lets a delete claim win an in-flight retry and leaves no resurrected row', async () => {
    const snapshot = completeRow(5103);
    harness.row = snapshot;
    let releaseCas!: () => void;
    const casGate = new Promise<void>((resolve) => {
      releaseCas = resolve;
    });
    harness.redownload.mockImplementation(async () => {
      await casGate;
      harness.row = { ...snapshot, status: 'queued', queuePosition: 0 };
      return true;
    });

    const retry = useDownloadProgressStore.getState().retryMissing(snapshot);
    await vi.waitFor(() => expect(harness.redownload).toHaveBeenCalledWith(snapshot));
    expect(useZipExportStore.getState().claimDelete(snapshot.galleryId)).toBe(true);
    const cancel = useDownloadProgressStore.getState().cancel(snapshot.galleryId);

    releaseCas();
    await expect(retry).resolves.toBe(false);
    await expect(cancel).resolves.toBe(true);
    // Mirrors DownloadsView's physical-delete-then-DB-delete commit after the
    // store cancellation barrier has settled.
    harness.row = null;
    useZipExportStore.getState().releaseDelete(snapshot.galleryId);

    await Promise.resolve();
    expect(harness.row).toBeNull();
    expect(harness.removeFromQueue).toHaveBeenCalledWith(snapshot.galleryId);
    expect(harness.dequeue).not.toHaveBeenCalled();
  });
});
