import { beforeEach, describe, expect, it } from 'vitest';
import { useZipExportStore } from '@/lib/store/zip-export';

describe('useZipExportStore', () => {
  beforeEach(() => useZipExportStore.getState().reset());

  it('single-flights exports and ignores stale callbacks', () => {
    const token = useZipExportStore.getState().begin(11, 'First');
    expect(token).not.toBeNull();
    expect(useZipExportStore.getState().begin(12, 'Second')).toBeNull();

    useZipExportStore.getState().updateProgress(token! + 1, { current: 9, total: 9 });
    useZipExportStore.getState().finish(token! + 1, 'saved');
    expect(useZipExportStore.getState().active).toEqual({
      token,
      galleryId: 11,
      title: 'First',
      current: 0,
      total: 0,
    });

    useZipExportStore.getState().updateProgress(token!, { current: 3, total: 20 });
    expect(useZipExportStore.getState().active).toEqual(
      expect.objectContaining({ current: 3, total: 20 }),
    );

    useZipExportStore.getState().finish(token!, 'saved');
    expect(useZipExportStore.getState().active).toBeNull();
    expect(useZipExportStore.getState().notice).toEqual({
      kind: 'saved',
      galleryId: 11,
      title: 'First',
    });
  });

  it('distinguishes browser starts, cancellation, and source failures', () => {
    const startedToken = useZipExportStore.getState().begin(21, 'Browser');
    useZipExportStore.getState().finish(startedToken!, 'started');
    expect(useZipExportStore.getState().notice?.kind).toBe('started');

    const cancelledToken = useZipExportStore.getState().begin(22, 'Cancelled');
    useZipExportStore.getState().cancel(cancelledToken!);
    expect(useZipExportStore.getState()).toMatchObject({ active: null, notice: null });

    const failedToken = useZipExportStore.getState().begin(23, 'Broken');
    useZipExportStore.getState().fail(failedToken!, 'source');
    expect(useZipExportStore.getState().notice).toEqual({
      kind: 'error',
      galleryId: 23,
      title: 'Broken',
      reason: 'source',
    });
  });

  it('prevents an export while the same gallery is being deleted', () => {
    expect(useZipExportStore.getState().claimDelete(31)).toBe(true);
    expect(useZipExportStore.getState().claimDelete(31)).toBe(false);
    expect(useZipExportStore.getState().begin(31, 'Deleting')).toBeNull();

    const otherToken = useZipExportStore.getState().begin(32, 'Other Gallery');
    expect(otherToken).not.toBeNull();
    expect(useZipExportStore.getState().claimDelete(32)).toBe(false);

    useZipExportStore.getState().cancel(otherToken!);
    useZipExportStore.getState().releaseDelete(31);
    expect(useZipExportStore.getState().deletingGalleryIds.size).toBe(0);
    expect(useZipExportStore.getState().begin(31, 'Available Again')).not.toBeNull();
  });
});
