// @vitest-environment node
/**
 * AC-005 (sequential QueueProcessor) + AC-007 (reconcileQueue) tests.
 *
 * The processor drives a sequence of dequeueNextQueued() reads, calling the
 * (mocked) downloadGalleryToLibrary once per item. We assert:
 *   - synchronous single-flight: a re-entrant processQueue() does not run a
 *     second download concurrently,
 *   - sequential order: items processed lowest-position first,
 *   - advance-on-complete: removeFromQueue + markDownloaded, then next item,
 *   - pause branch: DownloadPausedError leaves the item in the queue,
 *   - cancel branch (queued item): cancel() removes it, no abort.
 *   - reconcileQueue: zombie 'downloading' rows re-enqueued; idempotent; kicks
 *     processor only when unmetered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DownloadPausedError } from '@/lib/utils/download-zip';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const dl = vi.fn();
vi.mock('@/lib/utils/download-zip', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/utils/download-zip')>('@/lib/utils/download-zip');
  return {
    ...actual,
    downloadGalleryToLibrary: (...a: unknown[]) => dl(...a),
  };
});

const queue: { id: number; pageCount: number; paused?: boolean }[] = [];
const removed: number[] = [];
const enqueued: { meta: unknown; opts: unknown }[] = [];

vi.mock('@/lib/db/download-queue', () => ({
  dequeueNextQueued: vi.fn(async () => {
    // Mirror the SQL `WHERE status = 'queued'`: paused items are NOT dequeued.
    const item = queue.find((q) => !q.paused);
    if (!item) return null;
    return {
      galleryId: item.id,
      title: `G${item.id}`,
      thumbnail: '/tn',
      tags: '{}',
      pageCount: item.pageCount,
      status: 'queued',
    };
  }),
  removeFromQueue: vi.fn(async (id: number) => {
    removed.push(id);
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) queue.splice(idx, 1);
  }),
  enqueueDownload: vi.fn(async (meta: unknown, opts: unknown) => {
    enqueued.push({ meta, opts });
    const m = meta as { galleryId: number };
    if (!queue.find((q) => q.id === m.galleryId)) queue.push({ id: m.galleryId, pageCount: 0 });
    return queue.length;
  }),
}));

vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async () => null),
  deserializeTags: vi.fn(() => ({})),
}));

vi.mock('@/lib/api/client', () => ({
  getGgConfig: vi.fn(async () => ({ pathCode: 'x', mDefault: 0, mCases: new Set(), mCaseValue: 1 })),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, msg: string) {
      super(msg);
      this.status = status;
    }
  },
}));

vi.mock('@/features/gallery-detail/hooks/useGalleryDetail', () => ({
  resolveGalleryDetail: vi.fn(async (id: number) => ({
    files: [{ name: `${id}.webp`, hash: 'h', width: 1, height: 1, haswebp: 1, hasavif: 0, hasavifsmalltn: 0 }],
  })),
}));

// reconcile-queue deps
const adapterRows: unknown[] = [];
vi.mock('@/lib/db/adapter', () => ({
  ensureDb: vi.fn(async () => ({ query: vi.fn(async () => adapterRows) })),
}));

const unmetered = vi.fn(async () => true);
vi.mock('@/lib/utils/network', () => ({
  isUnmeteredNetwork: () => unmetered(),
}));

import { processQueue, useDownloadProgressStore } from '../download-progress';
import * as queueOps from '@/lib/db/download-queue';

beforeEach(() => {
  queue.length = 0;
  removed.length = 0;
  enqueued.length = 0;
  adapterRows.length = 0;
  dl.mockReset();
  unmetered.mockReset();
  unmetered.mockResolvedValue(true);
  useDownloadProgressStore.setState({ entries: {}, downloaded: {} });
});

describe('processQueue (AC-005)', () => {
  it('processes queued items sequentially in order and advances on complete', async () => {
    queue.push({ id: 1, pageCount: 0 }, { id: 2, pageCount: 0 }, { id: 3, pageCount: 0 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await processQueue();

    expect(order).toEqual([1, 2, 3]);
    // each completed item is removed + marked downloaded
    expect(removed).toEqual([1, 2, 3]);
    expect(useDownloadProgressStore.getState().downloaded[1]).toBe(true);
    expect(useDownloadProgressStore.getState().downloaded[3]).toBe(true);
  });

  it('single-flight: a concurrent processQueue() does not double-run an item', async () => {
    queue.push({ id: 1, pageCount: 0 });
    let active = 0;
    let maxActive = 0;
    dl.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });

    // Fire two loops "at once".
    const p1 = processQueue();
    const p2 = processQueue();
    await Promise.all([p1, p2]);

    expect(maxActive).toBe(1);
    expect(dl).toHaveBeenCalledTimes(1);
  });

  it('passes resume:true when the item has prior pages', async () => {
    queue.push({ id: 5, pageCount: 4 });
    dl.mockResolvedValue(undefined);
    await processQueue();
    const opts = dl.mock.calls[0][8] as { resume: boolean };
    expect(opts.resume).toBe(true);
  });

  it('pause branch: DownloadPausedError leaves the item in the queue (not removed)', async () => {
    queue.push({ id: 9, pageCount: 2 });
    // download-zip would write status 'paused'; mirror that here so the item is
    // no longer dequeued (otherwise the processor loops on it forever — which is
    // exactly the production behavior the SQL status filter prevents).
    dl.mockImplementation(async (id: number) => {
      const item = queue.find((q) => q.id === id);
      if (item) item.paused = true;
      throw new DownloadPausedError();
    });
    await processQueue();
    // Not removed from the queue (still present, just paused).
    expect(removed).not.toContain(9);
    expect(queue.find((q) => q.id === 9)).toBeTruthy();
  });

  it('genuine failure: removes from queue, surfaces error entry, advances', async () => {
    queue.push({ id: 1, pageCount: 0 }, { id: 2, pageCount: 0 });
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    dl.mockImplementationOnce(async () => {});
    await processQueue();
    expect(removed).toContain(1);
    expect(removed).toContain(2);
    expect(useDownloadProgressStore.getState().entries[1]?.error).toBe('boom');
  });
});

describe('cancel (AC-005)', () => {
  it('cancel of a queued-but-not-started item removes it without aborting', async () => {
    queue.push({ id: 42, pageCount: 0 });
    // No active controller for 42 → cancel goes through removeFromQueue.
    useDownloadProgressStore.getState().cancel(42);
    // removeFromQueue is fire-and-forget; flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(removed).toContain(42);
  });
});

describe('reconcileQueue (AC-007)', () => {
  it('re-enqueues zombie downloading rows then kicks the processor when unmetered', async () => {
    adapterRows.push({ galleryId: 11, title: 'Z', thumbnail: '/tn', tags: '{}', pageCount: 3, status: 'downloading' });
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();
    dl.mockResolvedValue(undefined);

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalledWith(
      expect.objectContaining({ galleryId: 11 }),
    );
  });

  it('is idempotent: a second call does nothing (started guard)', async () => {
    adapterRows.push({ galleryId: 12, title: 'Z', thumbnail: '/tn', tags: '{}', pageCount: 3, status: 'downloading' });
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();
    dl.mockResolvedValue(undefined);

    await reconcileQueue();
    const callsAfterFirst = vi.mocked(queueOps.enqueueDownload).mock.calls.length;
    await reconcileQueue(); // guarded → no-op
    expect(vi.mocked(queueOps.enqueueDownload).mock.calls.length).toBe(callsAfterFirst);
  });

  it('does NOT kick the processor on a metered network', async () => {
    adapterRows.push({ galleryId: 13, title: 'Z', thumbnail: '/tn', tags: '{}', pageCount: 3, status: 'downloading' });
    unmetered.mockResolvedValue(false);
    const { reconcileQueue, __resetReconcileQueueForTests } = await import('../reconcile-queue');
    __resetReconcileQueueForTests();

    await reconcileQueue();
    await new Promise((r) => setTimeout(r, 5));

    // Zombie was requeued, but download was not driven (processor not kicked).
    expect(vi.mocked(queueOps.enqueueDownload)).toHaveBeenCalled();
    expect(dl).not.toHaveBeenCalled();
  });
});
