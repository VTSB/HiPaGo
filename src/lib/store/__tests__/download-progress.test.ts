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

const queue: { id: number; pageCount: number; paused?: boolean; pos?: number }[] = [];
const removed: number[] = [];
const enqueued: { meta: unknown; opts: unknown }[] = [];

vi.mock('@/lib/db/download-queue', () => ({
  dequeueNextQueued: vi.fn(async () => {
    // Mirror the SQL `WHERE status = 'queued' ORDER BY queuePosition`: paused
    // items are NOT dequeued; lowest position runs next.
    const item = queue
      .slice()
      .sort((a, b) => (a.pos ?? a.id) - (b.pos ?? b.id))
      .find((q) => !q.paused);
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
  // Queue surface consumed by the store actions (AC-001). listQueue() returns
  // queued + paused rows in position order, mirroring the production SQL.
  listQueue: vi.fn(async () =>
    queue
      .slice()
      .sort((a, b) => (a.pos ?? a.id) - (b.pos ?? b.id))
      .map((q) => ({
        galleryId: q.id,
        title: `G${q.id}`,
        thumbnail: '/tn',
        tags: '{}',
        pageCount: q.pageCount,
        status: q.paused ? 'paused' : 'queued',
        queuePosition: q.pos ?? q.id,
      })),
  ),
  pauseQueued: vi.fn(async (id: number) => {
    const item = queue.find((q) => q.id === id);
    if (item) item.paused = true;
  }),
  resumeQueued: vi.fn(async (id: number) => {
    const item = queue.find((q) => q.id === id);
    if (item) item.paused = false;
  }),
  reorderQueue: vi.fn(async (id: number, newPos: number) => {
    const item = queue.find((q) => q.id === id);
    if (item) item.pos = newPos;
  }),
}));

// getDownload returns a row whose retryCount we can steer per-test (the genuine-
// failure branch reads it to decide whether to schedule another auto-retry).
const downloadRows = new Map<number, { retryCount: number }>();
vi.mock('@/lib/db/download', () => ({
  getDownload: vi.fn(async (id: number) => ({
    galleryId: id,
    title: `G${id}`,
    thumbnail: '/tn',
    tags: '{}',
    pageCount: 0,
    totalBytes: 0,
    downloadedAt: '',
    status: 'failed',
    retryCount: downloadRows.get(id)?.retryCount ?? 0,
  })),
  deserializeTags: vi.fn(() => ({})),
}));

// Auto-retry helpers (Task E). scheduleAutoRetry records calls; the due-list +
// earliest are steered per-test.
const scheduled: { id: number; attempt: number; dueAt: string }[] = [];
let dueRows: { galleryId: number; title: string; thumbnail: string; tags: string }[] = [];
let earliest: string | null = null;
vi.mock('@/lib/db/download-retry', () => ({
  AUTO_RETRY_BACKOFF_MS: [30_000, 300_000, 1_800_000],
  AUTO_RETRY_MAX: 3,
  scheduleAutoRetry: vi.fn(async (id: number, attempt: number, dueAt: string) => {
    scheduled.push({ id, attempt, dueAt });
  }),
  listDueAutoRetries: vi.fn(async () => dueRows),
  earliestNextRetryAt: vi.fn(async () => earliest),
  clearAutoRetry: vi.fn(async () => {}),
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

beforeEach(async () => {
  queue.length = 0;
  removed.length = 0;
  enqueued.length = 0;
  adapterRows.length = 0;
  scheduled.length = 0;
  dueRows = [];
  earliest = null;
  downloadRows.clear();
  dl.mockReset();
  unmetered.mockReset();
  unmetered.mockResolvedValue(true);
  useDownloadProgressStore.setState({ entries: {}, downloaded: {}, queue: [], globalPaused: false });
  // Clear the module-level globalPaused flag (queue is already empty, so this is
  // a pure reset — it kicks an empty processQueue which is a no-op).
  await useDownloadProgressStore.getState().resumeAll();
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

// ── Auto-restart of failed downloads (Task E) ───────────────────────────────

describe('auto-retry scheduling on genuine failure (AC-003)', () => {
  it('schedules the next auto-retry on a genuine failure when attempts remain', async () => {
    queue.push({ id: 1, pageCount: 0 });
    downloadRows.set(1, { retryCount: 0 }); // fresh: 0 attempts used
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await processQueue();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].id).toBe(1);
    expect(scheduled[0].attempt).toBe(1); // retryCount + 1
    // Store entry surfaces the pending retry (retryAt + attempt).
    const entry = useDownloadProgressStore.getState().entries[1];
    expect(entry?.error).toBe('boom');
    expect(entry?.retryAt).toBe(scheduled[0].dueAt);
    expect(entry?.attempt).toBe(1);
  });

  it('escalates the attempt number from the existing retryCount', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 1 }); // already used 1 auto-attempt
    dl.mockImplementationOnce(async () => {
      throw new Error('boom2');
    });

    await processQueue();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].attempt).toBe(2);
  });

  it('does NOT schedule once the attempt cap (AUTO_RETRY_MAX) is reached', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 3 }); // === AUTO_RETRY_MAX → exhausted
    dl.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await processQueue();

    expect(scheduled).toHaveLength(0);
    // Plain failed entry, no retryAt.
    const entry = useDownloadProgressStore.getState().entries[1];
    expect(entry?.error).toBe('boom');
    expect(entry?.retryAt == null).toBe(true);
  });

  it('does NOT schedule on a user cancel (AbortError)', async () => {
    queue.push({ id: 1, pageCount: 2 });
    downloadRows.set(1, { retryCount: 0 });
    dl.mockImplementationOnce(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });

    await processQueue();

    expect(scheduled).toHaveLength(0);
  });
});

describe('auto-retry scheduler timer (AC-004)', () => {
  it('fires due rows and re-enqueues them (keepRetryState) when unmetered', async () => {
    vi.useFakeTimers();
    try {
      const { armAutoRetryTimer } = await import('../download-progress');
      unmetered.mockResolvedValue(true);
      // One row due ~30s out; the timer should fire it.
      earliest = new Date(Date.now() + 30_000).toISOString();
      dueRows = [{ galleryId: 77, title: 'G77', thumbnail: '/tn', tags: '{}' }];
      dl.mockResolvedValue(undefined);

      armAutoRetryTimer();
      // Let the async earliestNextRetryAt() resolve so the timer is set.
      await vi.advanceTimersByTimeAsync(0);
      // Advance past the due time → handler fires.
      await vi.advanceTimersByTimeAsync(31_000);
      // Flush the fire handler's awaits.
      await vi.advanceTimersByTimeAsync(0);

      const autoRequeue = enqueued.find(
        (e) => (e.meta as { galleryId: number }).galleryId === 77,
      );
      expect(autoRequeue).toBeTruthy();
      expect((autoRequeue!.opts as { keepRetryState?: boolean }).keepRetryState).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds (does NOT re-enqueue) due rows when metered', async () => {
    vi.useFakeTimers();
    try {
      const { armAutoRetryTimer } = await import('../download-progress');
      unmetered.mockResolvedValue(false);
      earliest = new Date(Date.now() + 30_000).toISOString();
      dueRows = [{ galleryId: 88, title: 'G88', thumbnail: '/tn', tags: '{}' }];

      armAutoRetryTimer();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(0);

      const autoRequeue = enqueued.find(
        (e) => (e.meta as { galleryId: number }).galleryId === 88,
      );
      expect(autoRequeue).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('queue actions (AC-001 / Task B)', () => {
  it('pause(active) marks the row paused (not failed) and retains its pages', async () => {
    queue.push({ id: 7, pageCount: 3 });
    let paused = false;
    // download-zip: when the abort is a PAUSE signal, it throws DownloadPausedError
    // (mirroring the live seam: opts.isPauseSignal() true → status 'paused').
    dl.mockImplementation(async (...a: unknown[]) => {
      const opts = a[8] as { isPauseSignal: () => boolean };
      // Simulate the in-flight download: pause is requested mid-run.
      await new Promise((r) => setTimeout(r, 5));
      if (opts.isPauseSignal()) {
        const item = queue.find((q) => q.id === 7);
        if (item) item.paused = true; // row stays in queue at its position
        paused = true;
        throw new DownloadPausedError();
      }
    });

    const run = processQueue();
    // Let the processor start the active run, then pause it.
    await new Promise((r) => setTimeout(r, 1));
    await useDownloadProgressStore.getState().pause(7);
    await run;

    expect(paused).toBe(true);
    // Paused → NOT removed from the queue (pages retained for resume).
    expect(removed).not.toContain(7);
    expect(queue.find((q) => q.id === 7)?.paused).toBe(true);
    expect(queue.find((q) => q.id === 7)?.pageCount).toBe(3);
  });

  it('pause(queued) holds a not-yet-started item via pauseQueued', async () => {
    queue.push({ id: 8, pageCount: 0 });
    await useDownloadProgressStore.getState().pause(8);
    expect(vi.mocked(queueOps.pauseQueued)).toHaveBeenCalledWith(8);
    expect(queue.find((q) => q.id === 8)?.paused).toBe(true);
  });

  it('resume re-drives the processor and continues a paused item', async () => {
    queue.push({ id: 9, pageCount: 2, paused: true });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await useDownloadProgressStore.getState().resume(9);
    // resume() kicks processQueue async; let it drain.
    await new Promise((r) => setTimeout(r, 5));

    expect(vi.mocked(queueOps.resumeQueued)).toHaveBeenCalledWith(9);
    expect(order).toContain(9);
  });

  it('reorder calls reorderQueue for a pending item', async () => {
    queue.push({ id: 10, pageCount: 0, pos: 1 }, { id: 11, pageCount: 0, pos: 2 });
    await useDownloadProgressStore.getState().reorder(11, 0);
    expect(vi.mocked(queueOps.reorderQueue)).toHaveBeenCalledWith(11, 0);
    expect(queue.find((q) => q.id === 11)?.pos).toBe(0);
  });

  it('pauseAll stops auto-advance: a queued item does NOT start under global pause', async () => {
    queue.push({ id: 20, pageCount: 0 }, { id: 21, pageCount: 0 });
    const order: number[] = [];
    dl.mockImplementation(async (id: number) => {
      order.push(id);
    });

    await useDownloadProgressStore.getState().pauseAll();
    expect(useDownloadProgressStore.getState().globalPaused).toBe(true);

    // Kicking the processor while globally paused must not dequeue anything.
    await processQueue();
    expect(order).toEqual([]);
    expect(removed).toEqual([]);

    // resumeAll clears the gate and drives the queue again.
    await useDownloadProgressStore.getState().resumeAll();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([20, 21]);
  });

  it('nav-badge selector is true iff the queue is non-empty', async () => {
    const { selectQueueActive } = await import('../download-progress');
    useDownloadProgressStore.setState({ queue: [] });
    expect(selectQueueActive(useDownloadProgressStore.getState())).toBe(false);

    queue.push({ id: 30, pageCount: 0 });
    await useDownloadProgressStore.getState().refreshQueue();
    expect(selectQueueActive(useDownloadProgressStore.getState())).toBe(true);
    expect(useDownloadProgressStore.getState().queue.map((q) => q.id)).toContain(30);
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
